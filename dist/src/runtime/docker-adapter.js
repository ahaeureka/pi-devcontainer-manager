import { DEFAULT_MAX_OUTPUT_BYTES, runBounded } from "./process-runner.js";
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
        const { result, stdout } = await this.safeRun(["ps", "--all", "--no-trunc", "--format", PS_ALL_FORMAT], signal);
        return this.parsePsAll(result, stdout, "listDevContainers");
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
    async safeRun(args, signal) {
        const chunks = [];
        const result = await runBounded(this.runner, this.options.dockerPath, args, {
            cwd: this.options.cwd,
            env: this.options.env,
            maxOutputBytes: this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
            timeoutMs: 30_000,
            ...(signal !== undefined ? { signal } : {}),
            onData: (chunk) => chunks.push(chunk),
            spawnError: dockerSpawnErrorSpec(this.options.dockerPath),
        });
        return { result, stdout: Buffer.concat(chunks) };
    }
    parsePsAll(result, stdout, source) {
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
        const text = stdout.toString("utf8");
        // The minimal template emits exactly PS_FIELDS.length lines per container
        // followed by one blank line; ps itself never emits a bare blank line
        // inside a container record, so blank lines are the container boundary.
        const rawLines = text.split("\n");
        let group = [];
        for (const raw of rawLines) {
            if (raw.trim().length === 0) {
                this.pushPsContainer(group, containers, errors, source);
                group = [];
                continue;
            }
            group.push(raw);
        }
        // Trailing record without a terminating blank line.
        this.pushPsContainer(group, containers, errors, source);
        return { containers, truncated: result.truncated, errors };
    }
    /** Parse one 7-line container record (one JSON string per field). */
    pushPsContainer(group, containers, errors, source) {
        if (group.length === 0)
            return;
        if (group.length !== PS_FIELDS.length) {
            errors.push(`unparseable ${source} record (${group.length} lines): ${group[0]?.slice(0, 120) ?? ""}`);
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
            const localFolder = labels["devcontainer.local_folder"];
            const workspaceKey = localFolder !== undefined ? canonicalWorkspaceKey(localFolder) : undefined;
            containers.push({
                id: values.ID,
                name: values.Names,
                state: values.State,
                status: values.Status,
                image: values.Image,
                created: values.CreatedAt,
                labels,
                ...(localFolder !== undefined ? { localFolder } : {}),
                ...(workspaceKey !== undefined ? { workspaceKey } : {}),
            });
        }
        catch (error) {
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
            const localFolder = labels["devcontainer.local_folder"];
            const state = parsed.State?.Status ?? (parsed.State?.Running ? "running" : "");
            const workspaceKey = localFolder !== undefined ? canonicalWorkspaceKey(localFolder) : undefined;
            const container = {
                id: parsed.Id ?? "",
                name: (parsed.Name ?? "").replace(/^\//, ""),
                state,
                status: state,
                image: parsed.Config?.Image ?? "",
                created: parsed.Created ?? "",
                labels,
                ...(localFolder !== undefined ? { localFolder } : {}),
                ...(workspaceKey !== undefined ? { workspaceKey } : {}),
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