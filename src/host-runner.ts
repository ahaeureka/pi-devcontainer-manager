/**
 * The audited host escape hatch shared by `devcontainer_host_exec` and `/devcontainer host-exec`.
 *
 * Host execution is granted by default and withheld by configuration, so everything that makes it
 * *governed* is the part that matters: the policy decision happens before any spawn, a refusal is
 * both typed and audited, an argv that targets a container-only path is refused before it can run on
 * the host, and every attempt — denial, failure, success — leaves a record under the same capture
 * policy as every other operation.
 *
 * This lives outside `extensions/index.ts` on purpose (the same move as `setup-cli.ts`): the facade
 * cannot be unit-tested, and these are exactly the properties a review has to be able to verify.
 */
import type { AuditRecord } from "./types.js";
import type { EffectiveConfig } from "./types.js";
import { evaluatePolicy } from "./policy.js";
import { commandIdentity } from "./policy.js";
import { RuntimeError } from "./errors.js";
import { findContainerPath, type PathMapping } from "./path-mapper.js";
import type { ProcessRunner } from "./runtime/process-runner.js";

export interface AuditedHostRunResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export interface AuditedHostRunnerDeps {
  readonly runner: ProcessRunner;
  readonly config: EffectiveConfig;
  readonly audit: { write(record: AuditRecord): void };
  /** Host working directory for the spawned command. */
  readonly sessionWorkspace: string;
  /** Environment for the spawned process (composed by the caller, never the raw Pi env). */
  readonly env: Readonly<Record<string, string>>;
  /**
   * The selected workspace's host<->container mapping, or `undefined` when there is none.
   *
   * Injected because resolving it means reading a configuration off disk through the registry; the
   * runner only needs the answer. `undefined` means the container-path guard cannot run — the caller
   * is responsible for saying so, which it does through the discovery diagnostics.
   */
  readonly guardMappingFor: (workspaceKey: string) => Promise<PathMapping | undefined>;
  /** The workspace key of the CURRENT selection, or `undefined` when nothing is selected. */
  readonly targetStoreWorkspaceKey: () => string | undefined;
  /** Injectable clock for deterministic audit timestamps. */
  readonly clock?: () => string;
  /**
   * Session-scoped visibility for host runs (command-routing assessment section 4.1).
   *
   * The audit trail stays authoritative; this makes drift visible while it happens: every attempt is
   * counted, and the FIRST one of the session is reported through the operator UI.
   */
  readonly ledger?: {
    /** Counts the attempt and reports whether it is the session's first. */
    noteFirstRun(argv: readonly string[]): boolean;
  };
  /**
   * Called once per session with the REDACTED rendering of the first host attempt.
   *
   * Redaction happens here, not in the callback: the audit trail and the ledger both redact, and a
   * notice is the third rendering of the same argv — the boundary that already knows the rules is the
   * only place that can guarantee none of the three leaks (adversarial review of the routing
   * hardening found the notice emitting a bearer token verbatim).
   */
  readonly onFirstHostRun?: (rendered: string) => void;
}

/** The program an argv names, for operator-facing text (never the command line itself). */
export function programName(argv: readonly string[]): string {
  const first = argv[0];
  if (first === undefined) return "(no command)";
  return first.split("/").pop() ?? first;
}

/** The shape `CommandServices.hostRunner` expects. */
export interface AuditedHostRunner {
  run(
    argv: readonly string[],
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<AuditedHostRunResult>;
}

export function createAuditedHostRunner(deps: AuditedHostRunnerDeps): AuditedHostRunner {
  const now = deps.clock ?? (() => new Date().toISOString());
  const { config } = deps;

  /** Every record this surface writes shares this identity, so the trail stays queryable. */
  const record = (
    argv: readonly string[],
    fields: Omit<AuditRecord, "version" | "at" | "operation" | "initiator" | "commandCapture">,
  ): AuditRecord => ({
    version: 1,
    at: now(),
    operation: "host-exec",
    initiator: "host-escape",
    commandCapture: config.audit.commandCapture,
    ...commandIdentity(argv, config.audit.commandCapture),
    ...fields,
  });

  return {
    run: async (argv, options) => {
      if (argv.length === 0) {
        throw new RuntimeError({
          kind: "no-candidate",
          message: "Host execution requires at least one argv element.",
          remedy: "Pass the command to run, for example `hostname`.",
        });
      }

      const note = (): void => {
        if (deps.ledger === undefined) return;
        if (deps.ledger.noteFirstRun(argv)) {
          // The program, not the command line: see the ledger's note (no rendered argv anywhere in the
          // visibility, so there is no redaction to get wrong).
          deps.onFirstHostRun?.(programName(argv));
        }
      };

      const snapshot = evaluatePolicy(config, { operation: "host-exec", initiator: "host-escape" });
      if (!snapshot.authorized) {
        // A refusal is an attempt: it is recorded before it is reported, so an operator asking "why
        // did nothing happen" finds the answer in the same place as every other host run.
        deps.audit.write(
          record(argv, {
            policyAuthorized: false,
            ...(snapshot.denialReason !== undefined ? { policyDenialReason: snapshot.denialReason } : {}),
            outputTruncated: false,
          }),
        );
        note();
        throw new RuntimeError({
          kind: "policy-denied",
          message: "Host execution is disabled by policy.",
          remedy:
            "This installation withholds host execution by configuration. Remove `hostExecution.allow: false` from the project file (`.pi/pi-devcontainer-manager.json`, which must be a trusted project) or from the global file, then run `/reload`.",
        });
      }

      // Layer-3 guard: refuse a host run of an argv that targets a container-only path. Reliable
      // because literal argv carries no shell syntax — this is the mis-route a classifier over shell
      // text could never catch safely. It covers BOTH host surfaces and, since the escape hatch is
      // now granted by default, it is the only thing standing between a container path and the host.
      const selection = deps.targetStoreWorkspaceKey();
      if (selection !== undefined) {
        const mapping = await deps.guardMappingFor(selection);
        const violation = mapping !== undefined ? findContainerPath(argv, mapping.containerPath) : undefined;
        if (violation !== undefined) {
          deps.audit.write(
            record(argv, {
              policyAuthorized: false,
              policyDenialReason: "container-path-on-host",
              outputTruncated: false,
            }),
          );
          note();
          throw new RuntimeError({
            kind: "policy-denied",
            message: `Host command references container-only path ${violation}.`,
            remedy:
              "Use devcontainer_exec or the bash tool for container paths; devcontainer_host_exec is for host paths.",
          });
        }
      }

      const startedAt = process.hrtime.bigint();
      // Host execution is bounded by the same configured ceiling as the container path: an omitted
      // or zero timeout defaults to `maxTimeoutSeconds` and a requested one is clamped to it, so an
      // allowed host command can never run unbounded or exceed the operator's maximum.
      const ceilingMs = config.maxTimeoutSeconds * 1000;
      const requestedMs =
        options?.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
          ? options.timeoutMs
          : ceilingMs;
      const timeoutMs = Math.max(1, Math.min(requestedMs, ceilingMs));

      let result: Awaited<ReturnType<ProcessRunner["exec"]>>;
      try {
        result = await deps.runner.exec(argv[0]!, [...argv.slice(1)], {
          cwd: deps.sessionWorkspace,
          env: { ...deps.env },
          maxOutputBytes: config.maxOutputBytes,
          timeoutMs,
          ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        });
      } catch (error) {
        // A failed or timed-out host run is auditable too: the promise rejects before the success
        // record below, so the failure would otherwise leave no trace.
        deps.audit.write(
          record(argv, {
            policyAuthorized: true,
            durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
            outputTruncated: false,
            errorSummary: error instanceof Error ? error.message : String(error),
          }),
        );
        note();
        throw error;
      }

      deps.audit.write(
        record(argv, {
          policyAuthorized: true,
          durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
          ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
          outputTruncated: result.truncated,
        }),
      );
      note();

      return {
        exitCode: result.exitCode,
        signal: result.signal,
        // The boundary captured both streams because no callbacks were supplied (L5-03).
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        truncated: result.truncated,
      };
    },
  };
}
