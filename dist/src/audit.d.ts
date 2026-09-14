import type { AuditRecord } from "./types.js";
export interface AuditWriter {
    write(record: AuditRecord): void;
    prune(now: Date): void;
}
export declare function defaultAuditDirectory(platform?: NodeJS.Platform, home?: string): string;
export declare class JsonlAuditWriter implements AuditWriter {
    private readonly directory;
    private readonly retentionDays;
    /** When false, records are accepted but never persisted (audit disabled). */
    private readonly enabled;
    constructor(directory: string, retentionDays?: number, 
    /** When false, records are accepted but never persisted (audit disabled). */
    enabled?: boolean);
    write(record: AuditRecord): void;
    prune(now: Date): void;
}
//# sourceMappingURL=audit.d.ts.map