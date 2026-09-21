import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DISCOVERY_MAX_OUTPUT_BYTES,
  runBounded,
  type ProcessRunner,
  type ProcessResult,
} from "./process-runner.js";
import { dockerSpawnErrorSpec } from "./spawn-error.js";
import { RuntimeError } from "../errors.js";
import { canonicalWorkspaceKey } from "../workspace-path.js";

export interface DockerContainer {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly status: string;
  readonly image: string;
  readonly created: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly localFolder?: string;
  readonly workspaceKey?: string;
}

export interface DockerDiscoveryResult {
  readonly containers: readonly DockerContainer[];
  readonly truncated: boolean;
  readonly errors: readonly string[];
}

export interface DockerInspectResult {
  readonly container: DockerContainer | undefined;
  readonly errors: readonly string[];
}

export interface DockerAdapter {
  /** Read-only all-container discovery, filtering to DevContainer-labelled candidates. */
  listDevContainers(signal?: AbortSignal): Promise<DockerDiscoveryResult>;
  /** Read-only single-container inspection by full or prefix ID. */
  inspectContainer(id: string, signal?: AbortSignal): Promise<DockerInspectResult>;
}

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
const PS_ALL_FORMAT =
  '{{json .ID}}\n' +
  '{{json .Names}}\n' +
  '{{json .State}}\n' +
  '{{json .Status}}\n' +
  '{{json .Image}}\n' +
  '{{json .CreatedAt}}\n' +
  '{{json .Labels}}\n';

/** Field order of the minimal template above. */
const PS_FIELDS = ["ID", "Names", "State", "Status", "Image", "CreatedAt", "Labels"] as const;
type PsField = (typeof PS_FIELDS)[number];

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

function parseLabels(labelsValue: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!labelsValue) return out;
  for (const part of labelsValue.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key) out[key] = value;
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
function workspaceIdentityOf(
  labels: Readonly<Record<string, string>>,
): { localFolder: string; workspaceKey: string } | undefined {
  const localFolder = labels["devcontainer.local_folder"];
  if (localFolder === undefined || localFolder.trim().length === 0) return undefined;
  return { localFolder, workspaceKey: canonicalWorkspaceKey(localFolder) };
}

/**
 * Adapter over the host Docker CLI for read-only discovery and inspection.
 * Every invocation uses fixed argv (no shell), the injected runner, and a
 * sanitized environment. No mutation commands exist on this adapter.
 */
export class NodeDockerAdapter implements DockerAdapter {
  public constructor(
    private readonly runner: ProcessRunner,
    private readonly options: {
      readonly dockerPath: string;
      readonly env: Readonly<Record<string, string>>;
      readonly cwd: string;
      readonly maxOutputBytes?: number;
    },
  ) {}

  public async listDevContainers(signal?: AbortSignal): Promise<DockerDiscoveryResult> {
    const maxOutputBytes = this.discoveryOutputLimit();
    const { result, stdout } = await this.safeRun(
      ["ps", "--all", "--no-trunc", "--filter", DISCOVERY_LABEL_FILTER, "--format", PS_ALL_FORMAT],
      signal,
      maxOutputBytes,
    );
    return this.parsePsAll(result, stdout, "listDevContainers", maxOutputBytes);
  }

  public async inspectContainer(id: string, signal?: AbortSignal): Promise<DockerInspectResult> {
    if (id.length === 0) {
      throw new RuntimeError({
        kind: "no-candidate",
        message: "Cannot inspect an empty container ID.",
        remedy: "Resolve a container candidate before inspection.",
      });
    }
    const { result, stdout } = await this.safeRun(
      ["inspect", "--format", "{{json .}}", id],
      signal,
    );
    return this.parseInspect(result, stdout, "inspectContainer");
  }

  /** The byte cap that applies to a call that does not name one. */
  private outputLimit(): number {
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
  private discoveryOutputLimit(): number {
    return Math.max(this.outputLimit(), DISCOVERY_MAX_OUTPUT_BYTES);
  }

  private async safeRun(
    args: readonly string[],
    signal: AbortSignal | undefined,
    maxOutputBytes = this.outputLimit(),
  ): Promise<{ result: ProcessResult; stdout: Buffer }> {
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

  private parsePsAll(
    result: ProcessResult,
    stdout: Buffer,
    source: string,
    maxOutputBytes: number,
  ): DockerDiscoveryResult {
    if (result.exitCode !== 0) {
      throw new RuntimeError({
        kind: "daemon-unavailable",
        message: `Docker ps failed with exit ${result.exitCode} (${source}).`,
        exitCode: result.exitCode,
        remedy: "Check Docker daemon reachability.",
      });
    }
    const containers: DockerContainer[] = [];
    const errors: string[] = [];
    if (result.truncated) {
      // The byte cap cut the listing. Report that ONCE, first, because it is the whole story: the
      // containers past the cut are missing from the registry, and the half-written record the
      // cut leaves behind is a symptom of it — not a parse bug, which is how it used to read.
      errors.push(
        `docker ps output truncated at ${maxOutputBytes} bytes; DevContainer containers beyond that point are missing from the registry`,
      );
    }
    const text = stdout.toString("utf8");
    // The minimal template emits exactly PS_FIELDS.length lines per container
    // followed by one blank line; ps itself never emits a bare blank line
    // inside a container record, so blank lines are the container boundary.
    const rawLines = text.split("\n");
    let group: string[] = [];
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
  private pushPsContainer(
    group: string[],
    containers: DockerContainer[],
    errors: string[],
    source: string,
    partialLast: boolean,
  ): void {
    if (group.length === 0) return;
    if (group.length !== PS_FIELDS.length) {
      // A short FINAL group is the byte cap's cut, not a malformed record; the truncation itself was
      // already reported by the caller.
      if (!partialLast) {
        errors.push(`unparseable ${source} record (${group.length} lines): ${group[0]?.slice(0, 120) ?? ""}`);
      }
      return;
    }
    try {
      const values: Record<PsField, string> = {} as Record<PsField, string>;
      for (let i = 0; i < PS_FIELDS.length; i++) {
        const field = PS_FIELDS[i] as PsField;
        const parsed = JSON.parse(group[i] ?? "") as unknown;
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
    } catch (error) {
      if (!partialLast) errors.push(`unparseable ${source} record: ${group[0]?.slice(0, 120) ?? ""}`);
    }
  }

  private parseInspect(result: ProcessResult, stdout: Buffer, source: string): DockerInspectResult {
    if (result.exitCode !== 0) {
      throw new RuntimeError({
        kind: "daemon-unavailable",
        message: `Docker inspect failed with exit ${result.exitCode} (${source}).`,
        exitCode: result.exitCode,
        remedy: "Verify the container still exists.",
      });
    }
    const text = stdout.toString("utf8").trim();
    if (text.length === 0) return { container: undefined, errors: [] };
    try {
      const parsed = JSON.parse(text) as {
        Id?: string;
        Name?: string;
        State?: { Status?: string; Running?: boolean };
        Config?: { Image?: string; Labels?: Record<string, string> };
        Created?: string;
      };
      const labels = parsed.Config?.Labels ?? {};
      const identity = workspaceIdentityOf(labels);
      const state = parsed.State?.Status ?? (parsed.State?.Running ? "running" : "");
      const container: DockerContainer = {
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
    } catch (error) {
      return {
        container: undefined,
        errors: [`unparseable inspect output: ${text.slice(0, 120)}`],
      };
    }
  }
}
