import { homedir } from "node:os";
import { appendFileSync, chmodSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync, } from "node:fs";
import { join } from "node:path";
export const DEFAULT_LIFECYCLE_LOG_RETENTION_DAYS = 14;
export const DEFAULT_LIFECYCLE_LOG_MAX_BYTES = 10 * 1024 * 1024;
/**
 * Returns the private, operator-owned directory for raw lifecycle diagnostics.
 * This directory is deliberately separate from the structured audit JSONL.
 */
export function defaultLifecycleLogDirectory(environment = process.env, homeDirectory = homedir(), platform = process.platform) {
    if (platform === "darwin") {
        return join(homeDirectory, "Library", "Application Support", "pi-devcontainer-manager", "lifecycle-logs");
    }
    if (platform === "win32") {
        return join(environment.LOCALAPPDATA ?? join(homeDirectory, "AppData", "Local"), "pi-devcontainer-manager", "lifecycle-logs");
    }
    return join(environment.XDG_STATE_HOME ?? join(homeDirectory, ".local", "state"), "pi-devcontainer-manager", "lifecycle-logs");
}
/**
 * Writes raw diagnostic transcripts for lifecycle operations. Failures in this
 * best-effort writer never alter the operation it observes.
 */
export class LifecycleLogWriter {
    latest;
    lastWarning;
    directory;
    retentionDays;
    maxBytes;
    now;
    randomSuffix;
    constructor(options = {}) {
        this.directory = options.directory ?? defaultLifecycleLogDirectory(options.environment, options.homeDirectory, options.platform);
        this.retentionDays = options.retentionDays ?? DEFAULT_LIFECYCLE_LOG_RETENTION_DAYS;
        this.maxBytes = options.maxBytes ?? DEFAULT_LIFECYCLE_LOG_MAX_BYTES;
        this.now = options.now ?? (() => new Date());
        this.randomSuffix = options.randomSuffix ?? (() => Math.random().toString(36).slice(2, 10));
    }
    start(input) {
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
            const metadata = { operation: input.operation, path, startedAt };
            this.latest = metadata;
            return new FileLifecycleLogRun(path, this.maxBytes, (outcome, warning) => {
                this.latest = {
                    ...metadata,
                    completedAt: this.now().toISOString(),
                    outcome,
                    ...(warning === undefined ? {} : { warning }),
                };
            });
        }
        catch (error) {
            const warning = `Lifecycle diagnostic log unavailable: ${messageFor(error)}`;
            this.lastWarning = warning;
            return new UnavailableLifecycleLogRun(warning);
        }
    }
    latestRun() {
        if (this.latest !== undefined)
            return this.latest;
        try {
            const newest = readdirSync(this.directory, { withFileTypes: true })
                .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
                .map((entry) => ({ name: entry.name, path: join(this.directory, entry.name), mtimeMs: statSync(join(this.directory, entry.name)).mtimeMs }))
                .sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
            if (newest === undefined)
                return undefined;
            const operation = parseOperation(newest.name);
            return operation === undefined ? undefined : { operation, path: newest.path, startedAt: new Date(newest.mtimeMs).toISOString(), persisted: true };
        }
        catch {
            return undefined;
        }
    }
    latestWarning() {
        return this.latest?.warning ?? this.lastWarning;
    }
    prune(now) {
        const cutoff = now.getTime() - this.retentionDays * 24 * 60 * 60 * 1_000;
        for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith(".log"))
                continue;
            const path = join(this.directory, entry.name);
            if (statSync(path).mtimeMs < cutoff) {
                unlinkSync(path);
            }
        }
    }
}
class FileLifecycleLogRun {
    path;
    maxBytes;
    onFinish;
    stdoutStarted = false;
    stderrStarted = false;
    outputBytes = 0;
    capped = false;
    finished = false;
    writeWarning;
    constructor(path, maxBytes, onFinish) {
        this.path = path;
        this.maxBytes = maxBytes;
        this.onFinish = onFinish;
    }
    setCommand(argv) {
        this.writeControl(`command: ${JSON.stringify(argv)}\n`);
    }
    stdout(chunk) {
        if (!this.stdoutStarted) {
            this.stdoutStarted = true;
            this.writeControl("\n--- stdout ---\n");
        }
        this.writeOutput(chunk);
    }
    stderr(chunk) {
        if (!this.stderrStarted) {
            this.stderrStarted = true;
            this.writeControl("\n--- stderr ---\n");
        }
        this.writeOutput(chunk);
    }
    note(message) {
        this.writeControl(`note: ${message}\n`);
    }
    finish(outcome) {
        if (this.finished)
            return;
        this.finished = true;
        const effectiveOutcome = {
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
    writeOutput(chunk) {
        if (this.capped || this.writeWarning !== undefined)
            return;
        const buffer = Buffer.from(chunk);
        const remaining = this.maxBytes - this.outputBytes;
        if (remaining <= 0) {
            this.cap();
            return;
        }
        const written = buffer.subarray(0, remaining);
        this.write(written);
        this.outputBytes += written.byteLength;
        if (written.byteLength < buffer.byteLength)
            this.cap();
    }
    cap() {
        if (this.capped)
            return;
        this.capped = true;
        this.writeControl("\n--- lifecycle log output truncated at configured byte limit ---\n");
    }
    writeControl(text) {
        if (this.writeWarning !== undefined)
            return;
        this.write(text);
    }
    write(content) {
        try {
            appendFileSync(this.path, content);
        }
        catch (error) {
            this.writeWarning = `Lifecycle diagnostic log write failed: ${messageFor(error)}`;
        }
    }
}
class UnavailableLifecycleLogRun {
    warning;
    constructor(warning) {
        this.warning = warning;
    }
    setCommand(_argv) { }
    stdout(_chunk) { }
    stderr(_chunk) { }
    note(_message) { }
    finish(_outcome) { }
}
function safeTimestamp(value) {
    return value.replaceAll(":", "-");
}
function safeSuffix(value) {
    return value.replace(/[^A-Za-z0-9_-]/g, "_") || "run";
}
function parseOperation(filename) {
    const match = /-(up|build|rebuild|setup|stop|remove)-[^/]+\.log$/.exec(filename);
    return match?.[1];
}
function messageFor(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=lifecycle-log.js.map