/**
 * The model-facing facts about this plugin, contributed to dsh's system prompt.
 *
 * Without this section the agent has no idea a container is involved: it sees a `devcontainer` tool it
 * has no reason to call, and the first thing it learns about the environment is a refusal
 * (`No DevContainer target is selected.`). The Pi entry injects the same facts per turn
 * (`src/execution-context.ts`); this is the dsh equivalent through dsh's own `systemPrompt` seam.
 *
 * The text is DYNAMIC (evaluated at each assembly) so it reports the CURRENT target and mapping rather
 * than a snapshot from plugin load.
 */
export const SECTION_NAME = "devcontainer:execution-context";
/**
 * Where the section sits: after the harness's own tool sections (which end at 3100 for MCP and 5000
 * for the tools SDK) but far before the deliverable/structured-output trailers, so it reads as part of
 * "how this environment works" rather than as an output contract.
 */
export const SECTION_ORDER = 6000;
export function devcontainerPromptText(runtime, options) {
    const snapshot = runtime.targetStore.snapshot();
    const lines = ["## DevContainer execution context", ""];
    if (snapshot.status === "selected-valid" || snapshot.status === "selected-ambiguous") {
        // The snapshot carries the container id, not its name: render exactly what is verified, so the
        // model never quotes an identity the runtime did not read.
        const identity = snapshot.candidateId !== undefined ? `container ${snapshot.candidateId.slice(0, 12)}` : "target";
        lines.push(`Target: ${identity} — ${snapshot.status}`);
    }
    else if (snapshot.status === "none") {
        lines.push(`Target: none selected (workspace \`${options.workspace}\`).`);
    }
    else {
        lines.push(`Target: ${snapshot.status}${snapshot.detail !== undefined ? ` — ${snapshot.detail}` : ""}`);
    }
    lines.push("");
    lines.push("Execution surfaces (choose by WHAT the command operates on, not by its name):");
    lines.push("- shell commands run INSIDE the selected container for a DevContainer-managed workspace;");
    lines.push("  in a workspace without its own devcontainer configuration they run on the host unchanged.");
    lines.push("- `devcontainer` tool / `/devcontainer <verb>` → `list`, `status`, `use`, `off`, `up`, `rebuild`, `build`, `logs`, `stop`, `remove`.");
    lines.push("");
    lines.push("Rules:");
    lines.push("- A command refused with `No DevContainer target is selected.` means the project has no RUNNING container: run `devcontainer up` (adoption never starts one).");
    lines.push("- Two running containers for one workspace is `selected-ambiguous`: pass an explicit id with `devcontainer use <container-id>`.");
    lines.push("- `devcontainer off` suspends automatic adoption for this session; `use`/`up` resume it.");
    lines.push("- Host paths stay valid for host file tools: the workspace is bind-mounted, so the same file has one host path and one container path.");
    lines.push("- Rebuilding (`devcontainer rebuild`) is the way to apply a changed devcontainer.json/Dockerfile; `up` reuses an existing container and does NOT apply configuration changes.");
    return lines.join("\n");
}
/**
 * The prompt section as a dsh plugin (object form).
 *
 * `inject` is required: without a prompt registry there is nothing to contribute to, and dsh keeping
 * the plugin PENDING is the honest outcome. Being a plugin (not a call inside another `apply`) is what
 * gives the section its own fiber, so unloading the plugin retracts the text.
 */
export const promptPlugin = {
    name: "devcontainer-prompt",
    inject: ["devcontainerRuntime", "systemPrompt"],
    apply(ctx) {
        const runtime = ctx.devcontainerRuntime;
        ctx.systemPrompt.section({
            name: SECTION_NAME,
            order: SECTION_ORDER,
            // `interpolate: false` keeps `{{…}}` sequences in the text literal; nothing here needs prompt
            // variables, and a stray brace sequence must not throw during assembly.
            interpolate: false,
            text: () => devcontainerPromptText(runtime, { workspace: runtime.workspace }),
        });
    },
};
/**
 * Register the section through dsh's `systemPrompt` service.
 *
 * Kept for callers that already hold a context and want the section without the plugin wrapper
 * (tests, and the `ctx.inject` path). `ctx.inject` (not a plain `ctx.get`) so a composition that
 * mounts the prompt registry later still gets the section.
 */
export function registerPromptSection(ctx, runtime, options) {
    ctx.inject(["systemPrompt"], (scoped) => {
        const systemPrompt = scoped.systemPrompt;
        systemPrompt.section({
            name: SECTION_NAME,
            order: SECTION_ORDER,
            // `interpolate: false` keeps `{{…}}` sequences in the text literal; nothing here needs prompt
            // variables, and a stray brace sequence must not throw during assembly.
            interpolate: false,
            text: () => devcontainerPromptText(runtime, options),
        });
    });
}
//# sourceMappingURL=prompt.js.map