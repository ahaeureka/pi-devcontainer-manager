import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
export const DEFAULT_HOST_EXECUTOR_MODULE = "@deepseek-ai/dsh-bash-sandbox";
/**
 * Load the executor module, preferring resolution through the HARNESS.
 *
 * A bare `import()` inside this package resolves from the plugin's own `node_modules`, where the
 * harness's internal packages (`dsh-bash-sandbox`, a peer of `dsh-base`) do not exist — that failure
 * was observed live: the managed path worked, delegation reported "the host-side fallback executor is
 * missing its package". dsh mounts plugin modules with the *installation* as the bare-specifier base,
 * so the same base is used here: the running bin's location, then the executable's, then the cwd.
 */
function realpathOf(path) {
    if (typeof path !== "string" || path.length === 0)
        return undefined;
    try {
        return realpathSync(path);
    }
    catch {
        return undefined;
    }
}
export async function loadExecutorModule(specifier) {
    const asUrl = (resolved) => import(pathToFileURL(resolved).href);
    if (specifier.startsWith(".") || isAbsolute(specifier) || specifier.startsWith("file:")) {
        return (await (specifier.startsWith("file:") ? import(specifier) : asUrl(specifier)));
    }
    const attempts = [];
    try {
        return (await import(specifier));
    }
    catch (error) {
        attempts.push(error instanceof Error ? error.message : String(error));
    }
    // The running bin is usually a SYMLINK (`…/bin/dsh` → `<pkg>/lib/bin.js`), and Node's resolver
    // does not follow it here — that is why the real bin realpath is tried first: it sits inside the
    // harness package, whose own `node_modules` holds the executors. Verified live: the plain argv
    // path resolved the shim and failed, the realpath resolved the package.
    const bases = [realpathOf(process.argv[1]), process.argv[1], process.execPath, `${process.cwd()}/`].filter((base) => typeof base === "string" && base.length > 0);
    for (const base of bases) {
        try {
            const resolved = createRequire(base).resolve(specifier);
            return await asUrl(resolved);
        }
        catch (error) {
            attempts.push(`${base}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    throw new Error(`cannot resolve ${specifier} (tried: ${attempts.join("; ")})`);
}
/**
 * Mount the host executor on an isolated scope and return a lazy accessor.
 *
 * Lazy because mounting is a plugin load (a fiber that activates asynchronously): the DevContainer
 * provider is constructed with the accessor and only reads it when an unmanaged workspace actually
 * asks for a command.
 */
export function mountHostExecutor(ctx, options) {
    const scope = ctx.isolate("shell");
    let failure;
    void (async () => {
        try {
            const moduleRecord = await loadExecutorModule(options.module);
            const plugin = moduleRecord.default ?? Object.values(moduleRecord).find((value) => typeof value === "function");
            if (plugin === undefined) {
                throw new Error(`${options.module} exports no executor to mount`);
            }
            scope.plugin(plugin, (options.config ?? {}));
        }
        catch (error) {
            failure = error;
        }
    })();
    return () => {
        if (failure !== undefined) {
            throw new Error(`The host executor (${options.module}) could not be mounted: ${failure instanceof Error ? failure.message : String(failure)}. DevContainer-managed workspaces still work; unmanaged ones need this dependency installed.`);
        }
        return scope.get("shell");
    };
}
//# sourceMappingURL=host-executor.js.map