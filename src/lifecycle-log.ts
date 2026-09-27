import { homedir } from "node:os";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { OperationKind } from "./types.js";

export const DEFAULT_LIFECYCLE_LOG_RETENTION_DAYS = 14;
export const DEFAULT_LIFECYCLE_LOG_MAX_BYTES = 10 * 1024 * 1024;

export type LifecycleLogOperation = Extract<
  OperationKind,
  "up" | "build" | "rebuild" | "setup" | "stop" | "remove"
>;

export interface LifecycleLogMetadata {
  readonly operation: LifecycleLogOperation;
  readonly path: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly outcome?: LifecycleLogOutcome;
  readonly warning?: string;
  /** True when metadata is reconstructed from a prior session's file name. */
  readonly persisted?: true;
}

export interface LifecycleLogOutcome {
  readonly state: "completed" | "failed" | "denied" | "cancelled";
  readonly exitCode?: number | null;
  readonly durationMs?: number;
  readonly error?: string;
  readonly outputTruncated?: boolean;
}

export interface LifecycleLogStart {
  readonly operation: LifecycleLogOperation;
  readonly workspacePath: string;
}

export interface LifecycleLogRun {
  readonly path?: string;
  readonly warning?: string;
  setCommand(argv: readonly string[]): void;
  stdout(chunk: string | Uint8Array): void;
  stderr(chunk: string | Uint8Array): void;
  note(message: string): void;
  finish(outcome: LifecycleLogOutcome): void;
}

export interface LifecycleLogWriterOptions {
  readonly directory?: string;
  readonly retentionDays?: number;
  readonly maxBytes?: number;
  readonly now?: () => Date;
  readonly randomSuffix?: () => string;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * Returns the private, operator-owned directory for raw lifecycle diagnostics.
 * This directory is deliberately separate from the structured audit JSONL.
 */
export function defaultLifecycleLogDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "darwin") {
    return join(homeDirectory, "Library", "Application Support", "pi-devcontainer-manager", "lifecycle-logs");
  }
  if (platform === "win32") {
    return join(environment.LOCALAPPDATA ?? join(homeDirectory, "AppData", "Local"), "pi-devcontainer-manager", "lifecycle-logs");
  }
  return join(
    environment.XDG_STATE_HOME ?? join(homeDirectory, ".local", "state"),
    "pi-devcontainer-manager",
    "lifecycle-logs",
  );
}

/**
 * Writes raw diagnostic transcripts for lifecycle operations. Failures in this
 * best-effort writer never alter the operation it observes.
 */
export class LifecycleLogWriter {
  private latest?: LifecycleLogMetadata;
  private lastWarning?: string;
  private readonly directory: string;
  private readonly retentionDays: number;
  private readonly maxBytes: number;
  private readonly now: () => Date;
  private readonly randomSuffix: () => string;

  constructor(options: LifecycleLogWriterOptions = {}) {
    this.directory = options.directory ?? defaultLifecycleLogDirectory(
      options.environment,
      options.homeDirectory,
      options.platform,
    );
    this.retentionDays = options.retentionDays ?? DEFAULT_LIFECYCLE_LOG_RETENTION_DAYS;
    this.maxBytes = options.maxBytes ?? DEFAULT_LIFECYCLE_LOG_MAX_BYTES;
    this.now = options.now ?? (() => new Date());
    this.randomSuffix = options.randomSuffix ?? (() => Math.random().toString(36).slice(2, 10));
  }

  start(input: LifecycleLogStart): LifecycleLogRun {
    const started = this.now();
    delete this.lastWarning;
    const startedAt = started.toISOString();

    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      chmodSync(this.directory, 0o700);
      this.prune(started);

      const filename = `${safeTimestamp(startedAt)}-${input.operation}-${safeSuffix(this.randomSuffix())}.log`;
      const path = join(this.directory, filename);
      writeFileSync(path, [
        "# DevContainer lifecycle diagnostic log\n",
        `operation: ${input.operation}\n`,
        `started: ${startedAt}\n`,
        `workspace: ${input.workspacePath}\n`,
      ].join(""), { encoding: "utf8", mode: 0o600, flag: "wx" });
      chmodSync(path, 0o600);

      const metadata: LifecycleLogMetadata = { operation: input.operation, path, startedAt };
      this.latest = metadata;
      return new FileLifecycleLogRun(path, this.maxBytes, (outcome, warning) => {
        this.latest = {
          ...metadata,
          completedAt: this.now().toISOString(),
          outcome,
          ...(warning === undefined ? {} : { warning }),
        };
      });
    } catch (error) {
      const warning = `Lifecycle diagnostic log unavailable: ${messageFor(error)}`;
      this.lastWarning = warning;
      return new UnavailableLifecycleLogRun(warning);
    }
  }

  latestRun(): LifecycleLogMetadata | undefined {
    if (this.latest !== undefined) return this.latest;
    try {
      const newest = readdirSync(this.directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
        .map((entry) => ({ name: entry.name, path: join(this.directory, entry.name), mtimeMs: statSync(join(this.directory, entry.name)).mtimeMs }))
        .sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
      if (newest === undefined) return undefined;
      const operation = parseOperation(newest.name);
      return operation === undefined ? undefined : { operation, path: newest.path, startedAt: new Date(newest.mtimeMs).toISOString(), persisted: true };
    } catch {
      return undefined;
    }
  }
  latestWarning(): string | undefined {
    return this.latest?.warning ?? this.lastWarning;
  }


  private prune(now: Date): void {
    const cutoff = now.getTime() - this.retentionDays * 24 * 60 * 60 * 1_000;
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".log")) continue;
      const path = join(this.directory, entry.name);
      if (statSync(path).mtimeMs < cutoff) {
        unlinkSync(path);
      }
    }
  }
}

class FileLifecycleLogRun implements LifecycleLogRun {
  private stdoutStarted = false;
  private stderrStarted = false;
  private outputBytes = 0;
  private capped = false;
  private finished = false;
  private writeWarning?: string;

  constructor(
    readonly path: string,
    private readonly maxBytes: number,
    private readonly onFinish: (outcome: LifecycleLogOutcome, warning?: string) => void,
  ) {}

  setCommand(argv: readonly string[]): void {
    this.writeControl(`command: ${JSON.stringify(argv)}\n`);
  }

  stdout(chunk: string | Uint8Array): void {
    if (!this.stdoutStarted) {
      this.stdoutStarted = true;
      this.writeControl("\n--- stdout ---\n");
    }
    this.writeOutput(chunk);
  }

  stderr(chunk: string | Uint8Array): void {
    if (!this.stderrStarted) {
      this.stderrStarted = true;
      this.writeControl("\n--- stderr ---\n");
    }
    this.writeOutput(chunk);
  }

  note(message: string): void {
    this.writeControl(`note: ${message}\n`);
  }

  finish(outcome: LifecycleLogOutcome): void {
    if (this.finished) return;
    this.finished = true;
    const effectiveOutcome: LifecycleLogOutcome = {
      ...outcome,
      ...(this.capped || outcome.outputTruncated === true ? { outputTruncated: true } : {}),
    };
    this.writeControl([
      "\n--- outcome ---\n",
      `state: ${effectiveOutcome.state}\n`,
      `exitCode: ${effectiveOutcome.exitCode ?? "n/a"}\n`,
      `durationMs: ${effectiveOutcome.durationMs ?? "n/a"}\n`,
      ...(effectiveOutcome.error === undefined ? [] : [`error: ${effectiveOutcome.error}\n`]),
      `outputTruncated: ${effectiveOutcome.outputTruncated === true}\n`,
    ].join(""));
    this.onFinish(effectiveOutcome, this.writeWarning);
  }

  private writeOutput(chunk: string | Uint8Array): void {
    if (this.capped || this.writeWarning !== undefined) return;
    const buffer = Buffer.from(chunk);
    const remaining = this.maxBytes - this.outputBytes;
    if (remaining <= 0) {
      this.cap();
      return;
    }

    const written = buffer.subarray(0, remaining);
    this.write(written);
    this.outputBytes += written.byteLength;
    if (written.byteLength < buffer.byteLength) this.cap();
  }

  private cap(): void {
    if (this.capped) return;
    this.capped = true;
    this.writeControl("\n--- lifecycle log output truncated at configured byte limit ---\n");
  }

  private writeControl(text: string): void {
    if (this.writeWarning !== undefined) return;
    this.write(text);
  }

  private write(content: string | Uint8Array): void {
    try {
      appendFileSync(this.path, content);
    } catch (error) {
      this.writeWarning = `Lifecycle diagnostic log write failed: ${messageFor(error)}`;
    }
  }
}

class UnavailableLifecycleLogRun implements LifecycleLogRun {
  constructor(readonly warning: string) {}

  setCommand(_argv: readonly string[]): void {}
  stdout(_chunk: string | Uint8Array): void {}
  stderr(_chunk: string | Uint8Array): void {}
  note(_message: string): void {}
  finish(_outcome: LifecycleLogOutcome): void {}
}

function safeTimestamp(value: string): string {
  return value.replaceAll(":", "-");
}

function safeSuffix(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_") || "run";
}

function parseOperation(filename: string): LifecycleLogOperation | undefined {
  const match = /-(up|build|rebuild|setup|stop|remove)-[^/]+\.log$/.exec(filename);
  return match?.[1] as LifecycleLogOperation | undefined;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
