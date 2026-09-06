import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AuditRecord } from "./types.js";
import { redactText } from "./policy.js";

export interface AuditWriter {
  write(record: AuditRecord): void;
  prune(now: Date): void;
}

export function defaultAuditDirectory(platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "pi-devcontainer-manager", "audit");
  if (platform === "linux") return join(process.env.XDG_STATE_HOME ?? join(home, ".local", "state"), "pi-devcontainer-manager", "audit");
  throw new Error(`Unsupported audit platform: ${platform}`);
}

export class JsonlAuditWriter implements AuditWriter {
  public constructor(private readonly directory: string, private readonly retentionDays = 90) {}

  write(record: AuditRecord): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = join(this.directory, `${record.at.slice(0, 10)}.jsonl`);
    const safe = {
      ...record,
      ...(record.errorSummary ? { errorSummary: redactText(record.errorSummary) } : {}),
      ...(record.commandText ? { commandText: redactText(record.commandText) } : {}),
    };
    appendFileSync(file, `${JSON.stringify(safe)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      /* Filesystems without POSIX modes are checked in integration documentation. */
    }
  }

  prune(now: Date): void {
    if (!existsSync(this.directory)) return;
    const cutoff = now.getTime() - this.retentionDays * 24 * 60 * 60 * 1000;
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const file = join(this.directory, entry.name);
      if (statSync(file).mtimeMs < cutoff) unlinkSync(file);
    }
  }
}
