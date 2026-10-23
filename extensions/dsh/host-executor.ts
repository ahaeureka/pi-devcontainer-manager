import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type { ShellExecutor } from "@deepseek-ai/dsh-shell";

/**
 * The host executor used for workspaces this plugin does not manage.
 *
 * `ctx.shell` is a single, process-wide seam, so a plugin that replaces it is replacing the host
 * executor for EVERY workspace in the profile. This plugin's capability is per workspace (that is how
 * the Pi extension activates), so the replacement keeps the real host executor alive and delegates to
 * it whenever the workspace has no devcontainer configuration — same sandbox mode, same environment,
 * same semantics. A managed workspace never reaches it, which is what keeps the container path's
 * fail-closed behaviour intact.
 *
 * The delegate is mounted on an ISOLATED child scope (`ctx.isolate('shell')`): one provider per
 * context is a hard rule, so the host executor must live in its own scope to coexist with ours.
 */
export interface HostExecutorOptions {
  /** Module exporting the executor (default or named `default`), placed in the bundle patch. */
  readonly module: string;
  /** Its constructor config, forwarded verbatim (the base row's own keys, e.g. `timeoutMs`). */
  readonly config?: Record<string, unknown>;
}

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
function realpathOf(path: string | undefined): string | undefined {
  if (typeof path !== "string" || path.length === 0) return undefined;
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

export async function loadExecutorModule(specifier: string): Promise<Record<string, unknown>> {
  const asUrl = (resolved: string) => import(pathToFileURL(resolved).href);
  if (specifier.startsWith(".") || isAbsolute(specifier) || specifier.startsWith("file:")) {
    return (await (specifier.startsWith("file:") ? import(specifier) : asUrl(specifier))) as Record<string, unknown>;
  }
  const attempts: string[] = [];
  try {
    return (await import(specifier)) as Record<string, unknown>;
  } catch (error) {
    attempts.push(error instanceof Error ? error.message : String(error));
  }
  // The running bin is usually a SYMLINK (`…/bin/dsh` → `<pkg>/lib/bin.js`), and Node's resolver
  // does not follow it here — that is why the real bin realpath is tried first: it sits inside the
  // harness package, whose own `node_modules` holds the executors. Verified live: the plain argv
  // path resolved the shim and failed, the realpath resolved the package.
  const bases = [realpathOf(process.argv[1]), process.argv[1], process.execPath, `${process.cwd()}/`].filter(
    (base): base is string => typeof base === "string" && base.length > 0,
  );
  for (const base of bases) {
    try {
      const resolved = createRequire(base).resolve(specifier);
      return await asUrl(resolved);
    } catch (error) {
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
export function mountHostExecutor(ctx: Context, options: HostExecutorOptions): () => ShellExecutor | undefined {
  const scope = ctx.isolate("shell");
  let failure: unknown;

  void (async () => {
    try {
      const moduleRecord = await loadExecutorModule(options.module);
      const plugin = moduleRecord.default ?? Object.values(moduleRecord).find((value) => typeof value === "function");
      if (plugin === undefined) {
        throw new Error(`${options.module} exports no executor to mount`);
      }
      scope.plugin(plugin as never, (options.config ?? {}) as never);
    } catch (error) {
      failure = error;
    }
  })();

  return () => {
    if (failure !== undefined) {
      throw new Error(
        `The host executor (${options.module}) could not be mounted: ${
          failure instanceof Error ? failure.message : String(failure)
        }. DevContainer-managed workspaces still work; unmanaged ones need this dependency installed.`,
      );
    }
    return scope.get("shell") as ShellExecutor | undefined;
  };
}
