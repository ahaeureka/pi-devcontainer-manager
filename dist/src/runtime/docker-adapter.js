import { DEFAULT_MAX_OUTPUT_BYTES, DISCOVERY_MAX_OUTPUT_BYTES, runBounded, } from "./process-runner.js";
import { dockerSpawnErrorSpec } from "./spawn-error.js";
import { RuntimeError } from "../errors.js";
import { canonicalWorkspaceKey } from "../workspace-path.js";
/**
 * Minimal-field `docker ps` template.
 *
 * Requests ONLY the seven fields discovery consumes (ID, Names, State,
 * Status, Image, CreatedAt, Labels) instead of the whole container object.
 * Docker's `{{json .}}` top-level rendering forces the daemon to compute the
 * `Size` field for every container, which can hang on degraded storage
 * backends; the field-scoped form below never touches Size and renders
 * instantly even on hosts where `{{json .}}` stalls. Each container is
 * emitted as exactly 7 JSON-string lines followed by one blank line, which
 * the parser groups by.
 */
const PS_ALL_FORMAT = '{{json .ID}}\n' +
    '{{json .Names}}\n' +
    '{{json .State}}\n' +
    '{{json .Status}}\n' +
    '{{json .Image}}\n' +
    '{{json .CreatedAt}}\n' +
    '{{json .Labels}}\n';
/** Field order of the minimal template above. */
const PS_FIELDS = ["ID", "Names", "State", "Status", "Image", "CreatedAt", "Labels"];
/**
 * Discovery asks Docker for the DevContainer-labelled containers only.
 *
 * `docker ps --all` on a developer host also returns every unrelated container, and each one used
 * to be reported to the operator as `docker candidate <id> has no devcontainer.local_folder label`
 * — the normal case described as a discovery failure, once per container, on the first
 * `/devcontainer` command of a session. The label IS the container's workspace identity (see
 * `buildWorkspaceRegistry`), so Docker filters it and the noise never reaches the operator. An
 * empty label value still matches a `label=` filter, which is why the value is validated where the
 * identity is derived.
 */
const DISCOVERY_LABEL_FILTER = "label=devcontainer.local_folder";
function parseLabels(labelsValue) {
    const out = {};
    if (!labelsValue)
        return out;
    for (const part of labelsValue.split(",")) {
        const eq = part.indexOf("=");
        if (eq === -1)
            continue;
        const key = part.slice(0, eq);
        const value = part.slice(eq + 1);
        if (key)
            out[key] = value;
    }
    return out;
}
/**
 * The container's workspace identity, or `undefined` when it has none.
 *
 * A label Docker returns must still be USABLE: `canonicalWorkspaceKey("")` resolves to the process
 * cwd, so a container carrying `devcontainer.local_folder=` (present but empty — exactly the shape a
 * `docker run --label devcontainer.local_folder= …` produces) would silently register its workspace
 * as this process's working directory. Absent and empty are the same answer here: no identity, which
 * the registry reports as a diagnostic instead of inventing a workspace.
 */
function workspaceIdentityOf(labels) {
    const localFolder = labels["devcontainer.local_folder"];
    if (localFolder === undefined || localFolder.trim().length === 0)
        return undefined;
    return { localFolder, workspaceKey: canonicalWorkspaceKey(localFolder) };
}
/**
 * Adapter over the host Docker CLI for read-only discovery and inspection.
 * Every invocation uses fixed argv (no shell), the injected runner, and a
 * sanitized environment. No mutation commands exist on this adapter.
 */
export class NodeDockerAdapter {
    runner;
    options;
    constructor(runner, options) {
        this.runner = runner;
        this.options = options;
    }
    async listDevContainers(signal) {
        const maxOutputBytes = this.discoveryOutputLimit();
        const { result, stdout } = await this.safeRun(["ps", "--all", "--no-trunc", "--filter", DISCOVERY_LABEL_FILTER, "--format", PS_ALL_FORMAT], signal, maxOutputBytes);
        return this.parsePsAll(result, stdout, "listDevContainers", maxOutputBytes);
    }
    async inspectContainer(id, signal) {
        if (id.length === 0) {
            throw new RuntimeError({
                kind: "no-candidate",
                message: "Cannot inspect an empty container ID.",
                remedy: "Resolve a container candidate before inspection.",
            });
        }
        const { result, stdout } = await this.safeRun(["inspect", "--format", "{{json .}}", id], signal);
        return this.parseInspect(result, stdout, "inspectContainer");
    }
    /** The byte cap that applies to a call that does not name one. */
    outputLimit() {
        return this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    }
    /**
     * Discovery's own cap.
     *
     * A container listing scales with how many DevContainer-labelled containers the host has (each
     * record carries its full label set), not with the size of a command's output, so the
     * command-sized default cuts a busy host short and silently drops every record past the cut —
     * which is exactly how a labelled container stops being discoverable. See
     * `DISCOVERY_MAX_OUTPUT_BYTES`.
     */
    discoveryOutputLimit() {
        return Math.max(this.outputLimit(), DISCOVERY_MAX_OUTPUT_BYTES);
    }
    async safeRun(args, signal, maxOutputBytes = this.outputLimit()) {
        const result = await runBounded(this.runner, this.options.dockerPath, args, {
            cwd: this.options.cwd,
            env: this.options.env,
            maxOutputBytes,
            timeoutMs: 30_000,
            ...(signal !== undefined ? { signal } : {}),
            spawnError: dockerSpawnErrorSpec(this.options.dockerPath),
        });
        return { result, stdout: Buffer.from(result.stdout ?? "", "utf8") };
    }
    parsePsAll(result, stdout, source, maxOutputBytes) {
        if (result.exitCode !== 0) {
            throw new RuntimeError({
                kind: "daemon-unavailable",
                message: `Docker ps failed with exit ${result.exitCode} (${source}).`,
                exitCode: result.exitCode,
                remedy: "Check Docker daemon reachability.",
            });
        }
        const containers = [];
        const errors = [];
        if (result.truncated) {
            // The byte cap cut the listing. Report that ONCE, first, because it is the whole story: the
            // containers past the cut are missing from the registry, and the half-written record the
            // cut leaves behind is a symptom of it — not a parse bug, which is how it used to read.
            errors.push(`docker ps output truncated at ${maxOutputBytes} bytes; DevContainer containers beyond that point are missing from the registry`);
        }
        const text = stdout.toString("utf8");
        // The minimal template emits exactly PS_FIELDS.length lines per container
        // followed by one blank line; ps itself never emits a bare blank line
        // inside a container record, so blank lines are the container boundary.
        const rawLines = text.split("\n");
        let group = [];
        for (const raw of rawLines) {
            if (raw.trim().length === 0) {
                this.pushPsContainer(group, containers, errors, source, false);
                group = [];
                continue;
            }
            group.push(raw);
        }
        // Trailing record without a terminating blank line — which, in a truncated read, is the record
        // the byte cap cut in half. `partialLast` keeps it from being blamed on a parse error on top of
        // the truncation diagnostic above (a complete final record is still parsed and kept).
        this.pushPsContainer(group, containers, errors, source, result.truncated);
        return { containers, truncated: result.truncated, errors };
    }
    /** Parse one 7-line container record (one JSON string per field). */
    pushPsContainer(group, containers, errors, source, partialLast) {
        if (group.length === 0)
            return;
        if (group.length !== PS_FIELDS.length) {
            // A short FINAL group is the byte cap's cut, not a malformed record; the truncation itself was
            // already reported by the caller.
            if (!partialLast) {
                errors.push(`unparseable ${source} record (${group.length} lines): ${group[0]?.slice(0, 120) ?? ""}`);
            }
            return;
        }
        try {
            const values = {};
            for (let i = 0; i < PS_FIELDS.length; i++) {
                const field = PS_FIELDS[i];
                const parsed = JSON.parse(group[i] ?? "");
                values[field] = typeof parsed === "string" ? parsed : "";
            }
            const labels = parseLabels(values.Labels);
            const identity = workspaceIdentityOf(labels);
            containers.push({
                id: values.ID,
                name: values.Names,
                state: values.State,
                status: values.Status,
                image: values.Image,
                created: values.CreatedAt,
                labels,
                ...(identity ?? {}),
            });
        }
        catch (error) {
            if (!partialLast)
                errors.push(`unparseable ${source} record: ${group[0]?.slice(0, 120) ?? ""}`);
        }
    }
    parseInspect(result, stdout, source) {
        if (result.exitCode !== 0) {
            throw new RuntimeError({
                kind: "daemon-unavailable",
                message: `Docker inspect failed with exit ${result.exitCode} (${source}).`,
                exitCode: result.exitCode,
                remedy: "Verify the container still exists.",
            });
        }
        const text = stdout.toString("utf8").trim();
        if (text.length === 0)
            return { container: undefined, errors: [] };
        try {
            const parsed = JSON.parse(text);
            const labels = parsed.Config?.Labels ?? {};
            const identity = workspaceIdentityOf(labels);
            const state = parsed.State?.Status ?? (parsed.State?.Running ? "running" : "");
            const container = {
                id: parsed.Id ?? "",
                name: (parsed.Name ?? "").replace(/^\//, ""),
                state,
                status: state,
                image: parsed.Config?.Image ?? "",
                created: parsed.Created ?? "",
                labels,
                ...(identity ?? {}),
            };
            return { container, errors: [] };
        }
        catch (error) {
            return {
                container: undefined,
                errors: [`unparseable inspect output: ${text.slice(0, 120)}`],
            };
        }
    }
}
//# sourceMappingURL=docker-adapter.js.map