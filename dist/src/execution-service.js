/**
 * Shared execution orchestration for every command pathway.
 *
 * `devcontainer_exec`, routed Pi `bash`, `!`/`!!`, `up`, `build`, `stop`,
 * `remove`, and `logs` all delegate here so target validation, policy,
 * environment filtering, audit, output accounting, cancellation, timeout,
 * and error behavior cannot drift. The service:
 *
 * 1. Freezes an {@link OperationPolicySnapshot} for the requested operation
 *    and workspace before touching any target state.
 * 2. Binds an immutable {@link ExecutionContext} from the serialized
 *    {@link TargetStore} (re-resolves the selected target; a concurrent
 *    selection switch cannot redirect a bound operation).
 * 3. Builds a minimal child environment via `buildChildEnvironment` against
 *    the effective allowlist (never an arbitrary inherited Pi environment).
 * 4. Runs the command through the Dev Containers CLI `exec` or Docker
 *    lifecycle adapter, streaming bounded output.
 * 5. Emits one audit record (fingerprint by default) and returns a
 *    structured result with no environment values.
 *
 * Nonzero target exits are carried in the result, never thrown.
 */
import { commandIdentity as commandIdentityFor, evaluatePolicy, buildChildEnvironment } from "./policy.js";
import { workspaceHasConfig } from "./runtime/host-discovery.js";
import { canonicalWorkspaceKey } from "./workspace-path.js";
import { RuntimeError } from "./errors.js";
import { isWithinWorkspace } from "./workspace-path.js";
export class ExecutionService {
    options;
    clock;
    constructor(options) {
        this.options = options;
        this.clock = options.clock ?? (() => new Date().toISOString());
    }
    async exec(request) {
        const startedAt = Date.now();
        const snapshot = this.authorize({
            operation: request.operation,
            initiator: request.initiator,
            workspace: request.workspace,
            ...(request.environment !== undefined ? { requestedEnvironment: request.environment } : {}),
        });
        // Auto-select a default target when none is selected yet (empty-selection
        // only; an explicit prior /devcontainer use always wins). The hook is a
        // no-op for workspaces that do not exactly match the session cwd, so the
        // fail-closed no-candidate behavior is preserved elsewhere.
        // A refusal that happens BEFORE the audited region below (no target at all, an ambiguous
        // or stopped target, a mid-refresh store, or a failing auto-select) used to leave no
        // trace, while policy denials are recorded precisely so refusals are not "silently
        // absent". Bind inside an audit boundary: the record says policy allowed the operation
        // and the target state refused it, and the typed error is rethrown unchanged.
        let ctx;
        try {
            if (this.options.targetStore.snapshot().status === "none") {
                await this.options.autoSelect?.(request.workspace);
            }
            ctx = this.options.targetStore.bind();
        }
        catch (error) {
            this.audit(snapshot, undefined, { operation: request.operation, initiator: request.initiator, workspace: request.workspace }, { outputTruncated: false, errorSummary: this.asAuditError(error).message });
            throw error;
        }
        // Target/workspace integrity: the Dev Containers CLI would receive
        // `--workspace-folder <request.workspace>` while the container id comes from
        // the bound target. If those disagree, policy was evaluated for one
        // workspace while execution targets another's container. Require the request
        // workspace to be the bound target workspace (or a path below it), and always
        // send the TARGET workspace to the CLI so authorization scope, target, and
        // audit agree.
        const requestKey = canonicalWorkspaceKey(request.workspace);
        const targetKey = canonicalWorkspaceKey(ctx.workspaceKey);
        // Containment is the single owner's question (L5-01): a symlinked spelling of the bound
        // workspace resolves to it, while a sibling whose name merely starts the same does not.
        const withinTarget = isWithinWorkspace(targetKey, requestKey);
        // A request from outside the bound target is allowed ONLY when it comes from a
        // workspace that is not itself a DevContainer project. That is the
        // explicit-selection workflow (stand in a plain repository and drive a selected
        // target); a request from another project's workspace would silently act on the
        // wrong repository, so it stays refused. Either way the CLI receives the TARGET
        // workspace, so authorization scope, execution, and audit cannot disagree (AC-8).
        if (!withinTarget && this.projectProbe(request.workspace)) {
            this.audit(snapshot, undefined, request, {
                exitCode: null,
                outputTruncated: false,
                errorSummary: "request-workspace-mismatch",
            });
            throw new RuntimeError({
                kind: "policy-denied",
                message: `Requested workspace ${request.workspace} is not the selected target workspace ${ctx.workspaceKey}.`,
                remedy: "Run /devcontainer use for the target, or run the command from the target workspace.",
            });
        }
        const environment = buildChildEnvironment(request.environment, snapshot.effectiveConfig.environmentAllowlist);
        const remoteEnv = Object.keys(environment).length > 0 ? environment : undefined;
        let result;
        try {
            result = await this.options.devcontainer.exec(ctx.workspaceKey, ctx.candidateId, request.cmd, request.args, {
                ...(ctx.configPath !== undefined ? { configPath: ctx.configPath } : {}),
                ...(remoteEnv !== undefined ? { remoteEnv } : {}),
                ...(request.signal !== undefined ? { signal: request.signal } : {}),
            });
        }
        catch (error) {
            const failure = this.asAuditError(error);
            this.audit(snapshot, ctx, request, {
                durationMs: Date.now() - startedAt,
                exitCode: null,
                outputTruncated: false,
                errorSummary: failure.message,
            });
            throw error;
        }
        // Present the workspace to the agent in container terms when a mapping
        // exists (host path otherwise). CLI calls above used the host path.
        const presentedWorkspace = this.options.resolveContainerWorkspace !== undefined
            ? (await this.options.resolveContainerWorkspace(ctx.workspaceKey)) ?? ctx.workspaceKey
            : ctx.workspaceKey;
        const outcome = {
            operation: request.operation,
            workspaceKey: presentedWorkspace,
            candidateId: ctx.candidateId,
            candidateName: ctx.candidateName,
            exitCode: result.exitCode,
            signal: result.signal,
            durationMs: result.durationMs,
            truncated: result.truncated,
            policyAuthorized: snapshot.authorized,
            stdout: result.stdout,
            stderr: result.stderr,
        };
        this.audit(snapshot, ctx, request, {
            durationMs: result.durationMs,
            exitCode: result.exitCode,
            outputTruncated: result.truncated,
        });
        return outcome;
    }
    async up(request) {
        const startedAt = Date.now();
        const snapshot = this.authorize({
            operation: "up",
            initiator: request.initiator,
            workspace: request.workspace,
        });
        let result;
        try {
            result = await this.options.devcontainer.up(request.workspace, {
                ...(request.dockerPath !== undefined ? { dockerPath: request.dockerPath } : {}),
                ...(request.configPath !== undefined ? { configPath: request.configPath } : {}),
                ...(request.signal !== undefined ? { signal: request.signal } : {}),
            });
        }
        catch (error) {
            this.audit(snapshot, undefined, request, {
                durationMs: Date.now() - startedAt,
                exitCode: null,
                outputTruncated: false,
                errorSummary: this.asAuditError(error).message,
            });
            throw error;
        }
        this.audit(snapshot, undefined, request, { durationMs: Date.now() - startedAt, exitCode: 0, outputTruncated: false }, result.containerId);
        return {
            operation: "up",
            workspaceKey: canonicalWorkspaceKey(request.workspace),
            candidateId: result.containerId,
            ...(result.remoteUser !== undefined ? { remoteUser: result.remoteUser } : {}),
            ...(result.remoteWorkspaceFolder !== undefined ? { remoteWorkspaceFolder: result.remoteWorkspaceFolder } : {}),
            policyAuthorized: snapshot.authorized,
        };
    }
    async build(request) {
        const startedAt = Date.now();
        const snapshot = this.authorize({
            operation: "build",
            initiator: request.initiator,
            workspace: request.workspace,
        });
        let result;
        try {
            result = await this.options.devcontainer.build(request.workspace, {
                ...(request.dockerPath !== undefined ? { dockerPath: request.dockerPath } : {}),
                ...(request.configPath !== undefined ? { configPath: request.configPath } : {}),
                ...(request.noCache === true ? { noCache: true } : {}),
                ...(request.imageName !== undefined ? { imageName: request.imageName } : {}),
                ...(request.signal !== undefined ? { signal: request.signal } : {}),
            });
        }
        catch (error) {
            this.audit(snapshot, undefined, request, {
                durationMs: Date.now() - startedAt,
                exitCode: null,
                outputTruncated: false,
                errorSummary: this.asAuditError(error).message,
            });
            throw error;
        }
        this.audit(snapshot, undefined, request, { durationMs: Date.now() - startedAt, exitCode: 0, outputTruncated: false });
        return {
            operation: "build",
            workspaceKey: canonicalWorkspaceKey(request.workspace),
            ...(result.imageName !== undefined ? { imageName: result.imageName } : {}),
            policyAuthorized: snapshot.authorized,
        };
    }
    async lifecycle(request) {
        const snapshot = this.authorize({
            operation: request.operation,
            initiator: request.initiator,
            workspace: request.workspace,
        });
        const startedAt = Date.now();
        try {
            this.bindContainer(request.container.id);
        }
        catch (error) {
            this.audit(snapshot, undefined, request, {
                durationMs: Date.now() - startedAt,
                exitCode: null,
                outputTruncated: false,
                errorSummary: this.asAuditError(error).message,
            });
            throw error;
        }
        let result;
        try {
            result = await this.options.dockerLifecycle[request.operation](request.container, request.confirmation);
        }
        catch (error) {
            this.audit(snapshot, undefined, request, {
                durationMs: Date.now() - startedAt,
                exitCode: null,
                outputTruncated: false,
                errorSummary: this.asAuditError(error).message,
            }, request.container.id);
            throw error;
        }
        if (result.status === "done") {
            this.audit(snapshot, undefined, request, { durationMs: Date.now() - startedAt, exitCode: 0, outputTruncated: false }, request.container.id);
        }
        else {
            this.audit(snapshot, undefined, request, {
                durationMs: Date.now() - startedAt,
                exitCode: null,
                outputTruncated: false,
                errorSummary: "confirmation required",
            }, request.container.id);
        }
        return result;
    }
    /**
     * Bounded container logs, routed through the shared service so the read is
     * policy-checked and audited like every other operation (it previously
     * bypassed both).
     */
    async logs(request) {
        const snapshot = this.authorize({
            operation: "logs",
            initiator: request.initiator,
            workspace: request.workspace,
        });
        const startedAt = Date.now();
        try {
            this.bindContainer(request.containerId);
        }
        catch (error) {
            // Refused, and recorded — without ever writing the caller's identity as the target.
            this.audit(snapshot, undefined, { operation: "logs", initiator: request.initiator, workspace: request.workspace }, {
                durationMs: Date.now() - startedAt,
                exitCode: null,
                outputTruncated: false,
                errorSummary: this.asAuditError(error).message,
            });
            throw error;
        }
        let result;
        try {
            result = await this.options.dockerLifecycle.logs(request.containerId, {
                ...(request.tail !== undefined ? { tail: request.tail } : {}),
                ...(request.signal !== undefined ? { signal: request.signal } : {}),
            });
        }
        catch (error) {
            this.audit(snapshot, undefined, { operation: "logs", initiator: request.initiator, workspace: request.workspace }, {
                durationMs: Date.now() - startedAt,
                exitCode: null,
                outputTruncated: false,
                errorSummary: this.asAuditError(error).message,
            }, request.containerId);
            throw error;
        }
        this.audit(snapshot, undefined, { operation: "logs", initiator: request.initiator, workspace: request.workspace }, {
            durationMs: Date.now() - startedAt,
            exitCode: result.exitCode,
            outputTruncated: result.truncated,
        }, request.containerId);
        return result;
    }
    /**
     * The container a `logs` or lifecycle request may act on.
     *
     * `exec` already refuses a request whose workspace differs from the bound target; `logs`, `stop`
     * and `remove` trusted a caller-supplied identity, never bound it, and recorded that value as the
     * audit target — so two surfaces of the same service held different invariants about whether the
     * operated container belonged to the authorized workspace (review finding L3-07). They now bind
     * first and verify: an identity that is not the bound target is refused BEFORE any Docker call, and
     * the audit `targetId` comes from the binding rather than from the caller.
     */
    bindContainer(containerId) {
        const context = this.options.targetStore.bind();
        if (context.candidateId !== containerId) {
            throw new RuntimeError({
                kind: "policy-denied",
                message: `Container ${containerId} is not the bound target (${context.candidateName}); the service only acts on the target this session authorized.`,
                remedy: "Re-select the target with /devcontainer use, then retry.",
            });
        }
        return context;
    }
    /**
     * Frozen policy gate before target resolution or spawn.
     *
     * A DENIED attempt is itself an auditable event: policy probes (workspace,
     * environment, destructive, host-exec) are recorded before the typed error is
     * thrown, so denials are visible in the audit trail instead of silently
     * absent. Denied environment VALUES are never recorded.
     */
    authorize(input) {
        const now = () => new Date(this.clock());
        const snapshot = evaluatePolicy(this.options.config, input, now);
        if (!snapshot.authorized) {
            this.audit(snapshot, undefined, {
                operation: input.operation,
                initiator: input.initiator,
                ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
            }, { outputTruncated: false });
            throw new RuntimeError({
                kind: "policy-denied",
                message: `Operation '${input.operation}' was denied: ${snapshot.denialReason ?? "policy"}.`,
                remedy: "Review workspace-root, environment, destructive, and host-execution policy.",
            });
        }
        return snapshot;
    }
    audit(snapshot, ctx, request, extra, targetIdOverride) {
        const targetId = targetIdOverride ?? ctx?.candidateId;
        const record = {
            version: 1,
            at: this.clock(),
            operation: request.operation,
            initiator: request.initiator,
            ...this.workspaceIdentity(ctx, request),
            ...(targetId !== undefined ? { targetId } : {}),
            policyAuthorized: snapshot.authorized,
            ...(snapshot.denialReason !== undefined ? { policyDenialReason: snapshot.denialReason } : {}),
            ...(extra.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
            ...(extra.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
            outputTruncated: extra.outputTruncated ?? false,
            commandCapture: snapshot.effectiveConfig.audit.commandCapture,
            ...this.commandIdentity(request),
            ...(extra.errorSummary !== undefined ? { errorSummary: extra.errorSummary } : {}),
        };
        this.options.audit.write(record);
    }
    /** Is this workspace itself a DevContainer project? (injectable for tests) */
    projectProbe(workspace) {
        return (this.options.workspaceHasConfig ?? workspaceHasConfig)(workspace);
    }
    /**
     * What the record says about *where* the operation happened: the executed workspace
     * is the bound target, and the request's cwd is recorded alongside it when the caller
     * stood somewhere else. Without a bound context (pre-bind denials) the request's
     * workspace is all there is.
     */
    workspaceIdentity(ctx, request) {
        if (ctx === undefined) {
            return request.workspace !== undefined ? { workspace: request.workspace } : {};
        }
        if (request.workspace === undefined || canonicalWorkspaceKey(request.workspace) === canonicalWorkspaceKey(ctx.workspaceKey)) {
            return { workspace: ctx.workspaceKey };
        }
        return { workspace: ctx.workspaceKey, requestedCwd: request.workspace };
    }
    commandIdentity(request) {
        return commandIdentityFor([request.cmd ?? "", ...(request.args ?? [])], this.options.config.audit.commandCapture);
    }
    asAuditError(error) {
        return error instanceof Error ? error : new Error(String(error));
    }
}
/** Convenience for building the shell form of a routed bash command. */
export function shellForm(cmd) {
    return { cmd: "/bin/sh", args: ["-lc", cmd] };
}
//# sourceMappingURL=execution-service.js.map