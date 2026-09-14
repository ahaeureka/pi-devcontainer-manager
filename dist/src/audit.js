import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactText } from "./policy.js";
export function defaultAuditDirectory(platform = process.platform, home = homedir()) {
    if (platform === "darwin")
        return join(home, "Library", "Application Support", "pi-devcontainer-manager", "audit");
    if (platform === "linux")
        return join(process.env.XDG_STATE_HOME ?? join(home, ".local", "state"), "pi-devcontainer-manager", "audit");
    throw new Error(`Unsupported audit platform: ${platform}`);
}
export class JsonlAuditWriter {
    directory;
    retentionDays;
    enabled;
    constructor(directory, retentionDays = 90, 
    /** When false, records are accepted but never persisted (audit disabled). */
    enabled = true) {
        this.directory = directory;
        this.retentionDays = retentionDays;
        this.enabled = enabled;
    }
    write(record) {
        if (!this.enabled)
            return;
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
        }
        catch {
            /* Filesystems without POSIX modes are checked in integration documentation. */
        }
    }
    prune(now) {
        if (!this.enabled)
            return;
        if (!existsSync(this.directory))
            return;
        const cutoff = now.getTime() - this.retentionDays * 24 * 60 * 60 * 1000;
        for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith(".jsonl"))
                continue;
            const file = join(this.directory, entry.name);
            if (statSync(file).mtimeMs < cutoff)
                unlinkSync(file);
        }
    }
}
//# sourceMappingURL=audit.js.map