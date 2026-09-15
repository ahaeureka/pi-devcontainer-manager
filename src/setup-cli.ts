/**
 * `/devcontainer setup`: install (or upgrade) the Dev Containers CLI on the HOST.
 *
 * This is the extension's only host-side install capability. It is deliberately narrow: a
 * FIXED argv (`npm install -g @devcontainers/cli`), a bounded timeout, its own audit operation
 * (`setup`, independent of the host-execution policy that gates arbitrary host commands), and an
 * interactive confirmation owned by the command handler.
 *
 * It used to live as a closure inside `extensions/index.ts`, which made the failure path this
 * module exists for unreachable from a unit test: the install stage ran without a `try`/`catch`,
 * so a rejected spawn (npm missing, timeout, abort) escaped before the audit record was written
 * and reached the handler as an unnormalized error — while the version probe right below it was
 * already normalized. Both stages now share one contract: **one attempt = exactly one `setup`
 * audit record, and a structured result whatever fails.**
 */
import { commandIdentity } from "./policy.js";
import type { AuditWriter } from "./audit.js";
import type { ProcessRunner, ProcessResult } from "./runtime/process-runner.js";
import type { AuditRecord, EffectiveConfig } from "./types.js";

export interface SetupCliDeps {
  readonly runner: ProcessRunner;
  readonly audit: AuditWriter;
  readonly config: EffectiveConfig;
  /** Host workspace the install runs from (the policy-scoped session workspace). */
  readonly sessionWorkspace: string;
  /** Minimal child environment; never the inherited Pi environment. */
  readonly env: Readonly<Record<string, string>>;
  /** ISO-8601 clock for audit timestamps. */
  readonly clock?: () => string;
}

export interface SetupCliResult {
  readonly installed: boolean;
  readonly version: string | undefined;
  readonly error?: string;
}

export type SetupCli = (options?: { signal?: AbortSignal }) => Promise<SetupCliResult>;

/**
 * Fixed argv: this capability installs exactly one named package and never runs a
 * caller-supplied command, so it cannot be turned into a general host escape hatch.
 */
const SETUP_ARGV = ["npm", "install", "-g", "@devcontainers/cli"] as const;
const INSTALL_TIMEOUT_MS = 300_000;
const PROBE_TIMEOUT_MS = 30_000;
const PROBE_MAX_OUTPUT_BYTES = 16 * 1024;

export function createSetupCli(deps: SetupCliDeps): SetupCli {
  const now = deps.clock ?? (() => new Date().toISOString());
  const identity = (argv: readonly string[]) => commandIdentity(argv, deps.config.audit.commandCapture);

  const writeRecord = (
    argv: readonly string[],
    durationMs: number,
    exitCode: number | null,
    outputTruncated: boolean,
    errorSummary?: string,
  ): void => {
    const record: AuditRecord = {
      version: 1,
      at: now(),
      operation: "setup",
      initiator: "slash-command",
      policyAuthorized: true,
      durationMs,
      exitCode,
      outputTruncated,
      commandCapture: deps.config.audit.commandCapture,
      ...identity(argv),
      ...(errorSummary !== undefined ? { errorSummary } : {}),
    };
    deps.audit.write(record);
  };

  return async (options) => {
    const startedAt = process.hrtime.bigint();
    const elapsedMs = (): number => Number(process.hrtime.bigint() - startedAt) / 1e6;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const argv = [...SETUP_ARGV];

    let runResult: ProcessResult;
    try {
      runResult = await deps.runner.exec(argv[0]!, argv.slice(1), {
        cwd: deps.sessionWorkspace,
        env: { ...deps.env },
        maxOutputBytes: deps.config.maxOutputBytes,
        timeoutMs: INSTALL_TIMEOUT_MS,
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        onData: (chunk) => stdoutChunks.push(chunk),
        onStderr: (chunk) => stderrChunks.push(chunk),
      });
    } catch (error) {
      // A refused spawn is an attempt too. Record it (so the trail shows the failure) and answer
      // with the same structured shape a nonzero exit produces, instead of letting the error
      // escape past the audit and reach the handler unnormalized.
      const failure = error instanceof Error ? error.message : String(error);
      writeRecord(argv, elapsedMs(), null, false, failure);
      return { installed: false, version: undefined, error: failure };
    }

    writeRecord(argv, elapsedMs(), runResult.exitCode, runResult.truncated);

    if (runResult.exitCode !== 0) {
      const err = Buffer.concat(stderrChunks).toString("utf8").trim();
      return { installed: false, version: undefined, error: err || `npm install exited ${runResult.exitCode}` };
    }

    // Verify the freshly installed CLI is resolvable on PATH.
    const versionChunks: Buffer[] = [];
    try {
      const probe = await deps.runner.exec(deps.config.devcontainerPath, ["--version"], {
        cwd: deps.sessionWorkspace,
        env: { ...deps.env },
        maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
        timeoutMs: PROBE_TIMEOUT_MS,
        onData: (chunk) => versionChunks.push(chunk),
      });
      if (probe.exitCode === 0) {
        const version = Buffer.concat(versionChunks).toString("utf8").trim().split(/\s+/).pop();
        return { installed: true, version: version || undefined };
      }
      return {
        installed: false,
        version: undefined,
        error: `npm install succeeded but \`${deps.config.devcontainerPath} --version\` failed; check PATH.`,
      };
    } catch (error) {
      return {
        installed: false,
        version: undefined,
        error: `npm install succeeded but verifying the CLI failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}
