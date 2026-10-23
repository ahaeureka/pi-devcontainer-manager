# Research note — compatibility with DeepSeek Harness (dsh) plugins

> Status: **decision recorded (§7) and implemented 2026-10-22** — `extensions/dsh/`
> (plugin entry, `ctx.shell` provider, `devcontainer` command), `cordis.patch.yml`,
> `dsh`/or `./dsh` manifest fields, and unit tests. Checked against the **0.2.1-rc.2** line
> (`@deepseek-ai/dsh@0.2.1-rc.2`, `dsh-shell@0.2.1-rc.2`, `dsh-commands@0.2.1-rc.2`,
> `dsh-sandbox@0.2.1-rc.2`, `cordis@4.0.5`). Note: the `0.0.1-rc.*` packages on the `latest`
> dist-tag are an OLDER generation — `ctx.bash` there is `ctx.shell` here, and `ShellExecutor`
> exposes `execute()` instead of `run()`/`start()`.
>
> Docs studied: <https://deepseek-harness.github.io/deepseek-harness/develop/basic/>
> (plugin, tool, config), `develop/framework/{,service,events}`, `develop/practice/`,
> `reference/cookbook/adding-a-tool`.

## The question

`pi-devcontainer-manager` is a Pi extension. DeepSeek Harness (`dsh`) is a second
agent harness with its own plugin system. "Make it compatible with dsh plugins"
can mean three different things, with very different cost:

1. **Host** — run dsh plugins inside Pi (a dsh→Pi adapter).
2. **Guest** — run Pi extensions inside dsh (a Pi→dsh adapter).
3. **Dual-target** — ship *this functionality* as both a Pi package and a dsh
   bundle, sharing one harness-free core.

Everything below exists so that the choice in §7 is made against measured facts
rather than impressions.

## TL;DR

- A dsh plugin is a **Cordis plugin**: a module exporting `apply(ctx, config)`
  (or an object/class), with optional `name`, `inject`, `Config`. All capability
  comes from services on `ctx` (`ctx.tools`, `ctx.llm`, `ctx.agents`, …), and
  every registration is auto-disposed when the plugin's fiber unloads.
- **The tools surface is cheap to bridge in both directions.** A dsh tool is
  `{name, description, parameters(JSON-schema subset), output:{schema, render},
  execute(args, exec)}`; a Pi tool is `{name, label, description,
  parameters(TypeBox), execute → {content, details, structuredContent?, isError?}}`.
  `output.render` ≈ Pi `content`; the canonical value ≈ Pi `structuredContent`.
- **Measured**: the *real* dsh tool registry (not a mock) mounts and executes
  outside dsh in bare Node with **three** npm packages
  (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-system-prompt`).
  See §4 for the reproducible probe.
- The expensive parts are **not** tools: they are the service graph a plugin
  `inject`s, dsh's presentation-card union, Cordis event waterfalls, fiber
  lifecycle vs Pi's `/reload`, and the `cordis.yml`/profile loader (including
  `!!js` config, i.e. arbitrary code evaluation at config load).
- dsh is a **developer preview**: upstream says breaking changes are coming, and
  the packages are `0.0.1-rc.1`/`0.2.1-rc.2`. Any adapter here is a moving
  target, and must be version-pinned and fail closed on unknown versions.

## 1. What a dsh plugin actually is

From the official docs (develop/basic, framework/lifecycle, framework/service):

| Concept | Fact |
|---|---|
| Entry | `export function apply(ctx: Context, config: Config)`; also object form `export default {name, inject, apply}` and class form `class extends Service` |
| Dependencies | `export const inject = ['tools']`; the fiber stays `PENDING` until all injected services exist, and is **disposed** if one disappears (then reloads when it returns) |
| Lifecycle | `PENDING → LOADING → ACTIVE`, `→ FAILED`; `ACTIVE → UNLOADING → DISPOSED`. Disposers run in reverse registration order, async ones concurrently |
| Auto-cleanup | `ctx.on`, `ctx.tools.register`, `ctx.llm.registerAdapter`, `ctx.effect(fn)` are tracked by the owning fiber; no manual `removeListener` |
| Config | exported `Config` must be a **Standard Schema** (Schemastery), validated at load, defaults from the schema; invalid config fails the load loudly; config change triggers HMR replace |
| Composition | `cordis.yml` plugin tree, layered by patches: bundle patches (in profile order) → profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` overlays. Later layer wins per row, and a patch **replaces** a row's whole `config` (no deep merge) |
| Packaging | npm package with `dsh.bundle.patch` (path or ordered list) + `engines.dsh`; installed into a *profile* via `dsh plugin --profile <name> add …`; `dsh.profile.bundles` is the ordered list |
| Services | `tools`, `llm`, `agents`, `shell`, `session`, `scope`, `systemPrompt`, `userApproval`, `codeRuntime`, `jobs`… Service Definition / Provider / Consumer are separate packages when they must evolve independently |

Packages are on npm (through a mirror here) and MIT/BSD-3-Clause licensed, e.g.
`@deepseek-ai/cordis@4.0.5`, `@deepseek-ai/dsh-tools@0.0.1-rc.1` (BSD-3-Clause,
`publishConfig.access: restricted` — it is nevertheless resolvable),
`@deepseek-ai/schemastery@3.18.5`.

## 2. Tool contract, both sides

dsh (`@deepseek-ai/dsh-tools`, `defineTool` → `ToolDefinition`):

```ts
{
  name, description,
  parameters: ParameterSchemaSpec,        // compiled to an open JSON-Schema object
  output: { schema: ValueSchemaSpec,      // canonical, validated, lossless JSON
            render(args, value): ContentBlock[],
            presentationMeta?(args, value): JsonValue },
  execute(args, exec: ToolRunContext): Promise<unknown>,  // returns the canonical value
  finalizeContent?, timeoutMs?, isConcurrencySafe?, presentCall?, presentResult?
}
```

Registry (`ToolRegistry extends Service`, service name `tools`):
`register(def) → disposer`, `get(name)`, `schemas(scope?) → [{name, description, parameters}]`,
`execute({callId, name, arguments, signal, agent?})`, plus `restrict()`, `guard()`,
`presentAs(mode)` and the `tools/pre-execute` → `tools/execute` → `tools/post-execute`
→ `tools/result` waterfalls.

Pi (`registerTool()` in `@earendil-works/pi-coding-agent`):

```ts
{
  name, label, description,
  parameters: TSchema,                    // TypeBox
  outputSchema?: TSchema,
  execute(toolCallId, params, signal, onUpdate, ctx)
    → { content: (Text|Image)[], details, structuredContent?, usage?, isError?, terminate? }
}
```

Consequence: `parameterSchemaSpecToJsonSchema` + `render` (both exported by
dsh-tools) make a dsh→Pi tool wrapper mechanical, and Pi's `structuredContent`
carries dsh's canonical `value` without loss. `Type.Unsafe(jsonSchema)` passes a
raw JSON schema where Pi expects TypeBox.

## 3. Capability mapping

### 3a. dsh plugin → Pi host

| dsh capability | Pi equivalent | Fidelity |
|---|---|---|
| `ctx.tools.register(def)` | `pi.registerTool(...)` wrapping the real dsh registry | **High** — wrapper delegates to `ctx.tools.execute()` so validation, guards and waterfalls stay dsh-owned |
| `output.render` | tool result `content` | High |
| canonical `value` | `structuredContent` (+ `outputSchema`) | High |
| `output.presentationMeta` / `presentCall` / `presentResult` (card union: generic/terminal/diff/read/search/web) | `renderCall`/`renderResult` returning a pi-tui `Component` | **Lossy** — different ontology; only generic text modes map cleanly |
| `inject: ['tools']` | available (real registry mounted) | High |
| `inject: ['systemPrompt']` | provided by `@deepseek-ai/dsh-system-prompt`, or a stub in the host | High (stub is enough to mount the registry) |
| `inject: ['llm','agents','shell','session','userApproval','jobs',…]` | must be implemented over Pi's model/tool/session APIs | **Low–none per service**; each is its own project |
| `ctx.effect / ctx.on / dispose` | no direct analogue; map to plugin-level lifetime (mount once, dispose at `session_shutdown`) | Medium |
| config via `Config` schema | host must supply config; Pi config is JSON, Schemastery-validatable | High |
| fiber unloading on dependency loss | Pi has no such state machine | **None** |
| `tools/pre-execute` allow/deny/ask | `pi.on("tool_call")` can drive the waterfall | Medium — two policy languages |
| `cordis.yml` + profile/bundle layering | new loader in the host (only if L2 is wanted) | Medium cost |

### 3b. Pi extension → dsh host

| Pi capability | dsh equivalent | Fidelity |
|---|---|---|
| `registerTool` | `ctx.tools.register(defineTool(...))` | **High** (TypeBox → JSON schema is direct) |
| `registerProvider` | `ctx.llm.registerAdapter` | Medium — provider descriptor shapes differ |
| `registerCommand` (`/devcontainer …`) | no 1:1 plugin-facing command surface found in the studied pages | **Unknown** — needs verification before committing |
| `pi.on(...)` (agent/tool/session events) | `ctx.on('tools/result' …)`, `session/event`, waterfalls | Medium — different names and multiplicity |
| `ctx.ui` (TUI notify/confirm/overlay) | dsh UI is a Web Client (`apps/web`), cards over wire | **None** |
| session JSONL, compaction, `/reload` | dsh session/agent plugins | **None** without reimplementation |


### 3c. Purpose fit — "manage DevContainers and use the DevContainer environment"

The plugin has three jobs. Each lands on a different dsh seam, and this table — not the
option table in §7 — is what decides feasibility.

| Job (today, in Pi) | dsh seam | Fidelity |
|---|---|---|
| Discovery, config choice, target selection, stale-target repair (`src/registry`, `target-store`, `target-repair`) | no harness involvement; the same `src/` code runs | **Full** (pure logic) |
| "Use the container environment": routed `bash`, `!`/`!!`, `devcontainer_exec` (`src/bash-router`, `execution-service`) | `ShellExecutor` = `ctx.shell`, abstract `resolve/run/start`, "subclass, implement the abstract methods, load the subclass as a plugin" | **High** — same `devcontainer exec` spawn, same timeouts/cancellation |
| Management verbs (`use/up/rebuild/stop/remove/status`) | `ctx.commands.register({name, description, input, handler})` — a slash command with a direct UI handler; the model never sees it | **High** |
| Model-facing tools (`devcontainer_exec`, `devcontainer_host_exec`) | `ctx.tools.register(defineTool(...))` | **High** |
| Policy, audit, confirmations (`src/policy`, `audit`, `host-run-ledger`) | our own code inside the provider and tool wrappers; dsh additionally offers the `tools/pre-execute` waterfall for cross-plugin policy | **High** (keep ours; bridge later if needed) |
| Agent-visible paths (host vs container) | host paths stay valid because the workspace is a bind mount — the same argument as `docs/README.md`; a `FileSystem` (`ctx.fs`) provider is optional | **High / optional** |
| Prompt injection (container-required context) | plugin-contributed prompt section via the `systemPrompt` service — must be verified before relying on it | **Medium** |

The important difference from option A: in dsh we do **not** re-expose dsh tools inside Pi;
we expose *our* capability through dsh's own seams, so every other dsh consumer of
`ctx.shell` follows the selected container without knowing we exist.

## 4. Measured probe (reproducible)

Question: can a foreign host run *real* dsh tool plugins, or must it reimplement
the registry?

```bash
mkdir -p /tmp/dshprobe && cd /tmp/dshprobe && npm init -y && npm pkg set type=module
npm i @deepseek-ai/cordis@4.0.5 @deepseek-ai/dsh-tools@0.0.1-rc.1 @deepseek-ai/dsh-system-prompt@0.0.1-rc.1
node probe.mjs
```

```js
import ToolsPlugin, { defineTool } from '@deepseek-ai/dsh-tools'
import SP from '@deepseek-ai/dsh-system-prompt'
import { Context } from '@deepseek-ai/cordis'

const ctx = new Context()
ctx.plugin(SP); ctx.plugin(ToolsPlugin)           // tools needs systemPrompt
ctx.plugin({
  name: 'greet-tool', inject: ['tools'],
  apply(c) {
    c.tools.register(defineTool({
      name: 'greet', description: 'Greet someone.',
      parameters: { name: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) { return `Hello, ${args.name}!` },
    }))
  },
})
await new Promise((r) => setTimeout(r, 400))
console.log(JSON.stringify(ctx.tools.schemas()))
console.log(JSON.stringify(await ctx.tools.execute({
  callId: 'call-1', name: 'greet', arguments: { name: 'Ada' }, signal: new AbortController().signal,
})))
```

Observed (2026-10-22):

- Mounting `ToolRegistry` alone leaves its fiber `PENDING` (`inject: ['systemPrompt']`
  unresolved, `ctx.tools === undefined`). Adding `dsh-system-prompt` makes both
  fibers `ACTIVE` and `ctx.tools` a live service.
- `ctx.tools.schemas()` →
  `[{"name":"greet","description":"Greet someone.","parameters":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}}]`
- `ctx.tools.execute(...)` →
  `{"isError":false,"content":[{"type":"text","text":"Hello, Ada!"}],"value":"Hello, Ada!"}`
- 17 packages installed in total (transitive deps of the three); no Docker, no
  model, no dsh application required.

What this proves: a Pi-side host can mount the **real** dsh tool pipeline and
inherit argument validation, guards, and the three tool waterfalls for free.
What it does not prove: anything about `llm`/`agents`/`shell`/`session`
services, the Web-client presentation path, or the `cordis.yml` loader.

## 5. Compatibility levels (scoped to the rejected A route, kept as reference)

| Level | Scope | What a user gets | Size |
|---|---|---|---|
| **L0 — tool plugins** | mount real `ToolRegistry` + `systemPrompt`, load a named list of dsh modules, map `register` → `registerTool` | "dsh tool plugins work in Pi" | small: adapter + proxy tools + config key + tests |
| **L1 — service plugins** | additionally implement `llm` (or map to Pi providers), `shell`, `session`, `agents`, approval | arbitrary dsh plugins, still without the dsh app shell | large, open-ended |
| **L2 — profile loader** | parse `cordis.yml`/patches/`dsh.bundle`/profiles, `!!js` config, HMR | "profiles behave like dsh" | large + a security surface (`!!js` = eval at load) |

## 6. Hard constraints and risks

Items 1 and 8 apply to any route. Items 3–7 describe the rejected A route (Pi hosting dsh
plugins) and are kept because they are the evidence behind §7; the constraints that govern
the chosen C route are listed at the end of this section.

1. **Upstream churn.** Developer preview; `0.0.1-rc.*` packages; explicit notice
   that breaking changes are coming. Pin exact versions, assert the registry
   surface at startup, and fail closed rather than half-bridging.
2. **`!!js` in `cordis.yml`** evaluates JavaScript at config load. A loader that
   supports it imports arbitrary code execution from a YAML file into a Pi
   process that holds model credentials. If L2 is ever attempted, this needs an
   explicit, documented opt-in (and probably a refusal, mirroring how this
   project treats workspace roots).
3. **Pi tools cannot be unregistered** (only re-registered as `exposure:
   "hidden"`), while dsh relies on dispose-to-unregister for HMR and
   dependency loss. The bridge must therefore register one *stable* proxy tool
   per dsh tool name and swap an internal definition slot, hiding the proxy when
   the slot empties — never map `register`/dispose 1:1.
4. **Two policy languages.** dsh policy lives in `tools/pre-execute`/`guard`,
   Pi's in `tool_call` handlers and permission extensions. A host must decide
   which one wins; silently honouring neither is the failure mode to avoid.
5. **Presentation fidelity.** dsh's card union does not map onto pi-tui
   components; a bridge should render generic text and say so, not fake cards.
6. **Approval.** `dsh-user-approval` is a peer the bare registry tolerates as
   absent. In a host that cares about gating (this project does), absence must be
   deliberate: either implement it or document that dsh-side approval does not
   run.
7. **Naming symmetry.** dsh tool names are free-form (`read_file`); Pi names
   tools globally and supports namespaces/aliases. Collisions with a project's
   own Pi tools must be reported, not silently won by either side.
8. **Package access.** `@deepseek-ai/dsh-tools` ships
   `publishConfig.access: "restricted"`. It resolves here through
   `registry.npmmirror.com`, but a distribution that depends on it should pin and
   vendor-lock rather than assume access.

Constraints that govern the chosen **C** route:

1. **Host Docker is a hard prerequisite.** `ShellExecutor.run/start` must spawn
   `devcontainer exec` on the host. If dsh ever supplies the provider under a sandboxed or
   remote executor, the capability cannot work: refuse with a typed error instead of
   degrading into commands that silently run on the wrong machine.
2. **`ShellProcess` parity is unproven.** `start()` must satisfy incremental
   `readOutput()`, `kill()`, and quiescence-over-a-resumed-log semantics while backing the
   handle with a host process. Verify against `@deepseek-ai/dsh-shell@0.0.1-rc.5` before
   documenting background support.
3. **Environment must flow through by default.** `ShellExecRequest.env`/`dshEnv` are dsh's
   own contracts; the container-side `environmentAllowlist` stays an opt-in configuration
   value. Hardcoding the `DSH_*` names (or any workspace-specific list) would repeat the
   coupling this project already removed from the host child environment.
4. **Configuration is a Schemastery `Config` export, validated at load.** There is no
   `/reload`: edits arrive through `cordis.patch.yml`/profile and HMR, and an invalid
   config fails the plugin load loudly rather than starting half-configured.
5. **The dsh entry must not import Pi.** `extensions/dsh.ts` imports only `src/`, keeping
   the existing rule that `src/` is free of `@earendil-works/*`. Policy, audit and redaction
   therefore stay shared, which is the whole reason to reuse `src/` instead of forking.
6. **Commands return text, not rich UI.** `CommandResult` is
   `{kind:'success'|'error', text?}`; the `id — state — image` picker used by
   `/devcontainer use` cannot be an interactive prompt in dsh — it must be enumerated in
   the command text and selected by argument (`use <index|id>`).

## 7. Decision: port the capability into dsh (option C)

Requirement, stated by the project owner: this plugin exists to **manage DevContainers and
to use the DevContainer environment**. Compatibility therefore means "the same capability
is available while working in dsh", not "two harnesses load each other's plugins".

Rejected, with reasons:

| Option | Why rejected |
|---|---|
| **A — Pi hosts dsh plugins** | Solves the opposite direction: a dsh tool plugin running inside Pi does nothing for managing DevContainers. It remains a viable *separate* project if general dsh-plugin hosting is ever wanted. |
| **B — dsh hosts Pi extensions** | Would carry Pi's event/UI/session model into dsh at a cost this capability does not need: we register tools, one command, and a shell provider — nothing that requires the Pi extension runtime. |
| **D — manifest conversion** | Converts packaging, not capability. |

Chosen: **C — a dsh bundle that implements the same capability against dsh's seams and
reuses the harness-free `src/`.**

```text
                    dsh process
┌───────────────────────────────────────────────────────────────┐
│  bundle: devcontainer support (our package)                   │
│                                                               │
│  DevcontainerShellExecutor extends ShellExecutor              │
│      resolve(req) → spec  (workdir = host workspace, caps)    │
│      run(spec)    → devcontainer exec --workspace-folder …     │
│      start(spec)  → the same, as a managed process handle      │
│              ▲ provides ctx.shell                             │
│  command: `devcontainer <verb>`  (use/up/rebuild/stop/status)  │
│  tools:   devcontainer_exec, devcontainer_host_exec            │
│              ▼                                                │
│  src/ (unchanged): registry, target-store, target-repair,      │
│                    policy, audit, path-mapper, execution-service│
└───────────────────────────────────────────────────────────────┘
        │ devcontainer CLI (host)            │ host filesystem
        ▼                                   ▼
   container (project toolchain)      bind-mounted workspace
```

Design consequences:

1. **One provider, not per-tool routing.** `resolve()` returns a *host* `workdir` because
   `devcontainer exec` is a host command whose child runs in the container; `run()`/`start()`
   spawn the CLI. `spec.command` stays verbatim inside the container-side `bash -c` — no
   string assembly into the CLI argv beyond the `--workspace-folder`/`--config` mapping
   already owned by `src/runtime`.
2. **Background work.** `start()` must return a `ShellProcess` (incremental
   `readOutput`, `kill`, quiescence). A host-side `devcontainer exec` process can back that
   handle, but the contract must be checked before claiming parity.
3. **Environment.** `ShellExecRequest.env` / `dshEnv` arrive from dsh; container execution
   already has its own filter (`environmentAllowlist` + `buildChildEnvironment`). Passing
   dsh's `env` through unchanged is the recommended default (consistent with the
   inherit-everything host posture in `docs/security.md`); narrowing must be an explicit
   configuration value, never a hardcoded `DSH_*` list.
4. **One command, sub-verbs.** `CommandDefinition` takes a lowercase `name` plus free-form
   `rawInput` and returns `{kind:'success'|'error', text}` — so a single `devcontainer`
   command parsing the existing verb grammar beats one command per verb.
5. **Configuration arrives differently.** A Schemastery `Config` export replaces
   `session_start` composition; changes arrive by editing `cordis.patch.yml`/profile (HMR),
   not by `/reload`. The existing keys can be reused as-is.
6. **Packaging.** `package.json` gains `dsh.bundle.patch` (+ `engines.dsh`) beside the `pi`
   manifest; `dist/` stays the compiled entry. The dsh entry (`extensions/dsh.ts`) must
   import only `src/`, mirroring the existing rule that `src/` stays free of
   `@earendil-works/*` imports.

Cost: moderate and bounded — every piece of harness coupling already lives in
`extensions/index.ts`, so the adapter is one small second entry point plus a patch manifest.

Implementation as shipped:

| Piece | Where | Notes |
|---|---|---|
| Shared host composition (runner, env, three CLI adapters) | `src/runtime-composition.ts` | used by BOTH entries; the Pi entry was refactored onto it, so the adapters cannot drift |
| Shared config-reading helpers | `src/path-mapper.ts#readWorkspaceConfigFacts`, `src/registry-entry.ts#selectedConfigPathFor` | moved out of the Pi entry so the dsh entry reads a workspace identically |
| Harness-declared environment | `src/execution-service.ts#ExecRequest.explicitEnvironment` | dsh's `env`/`dshEnv` bypass the inherited-state allowlist; no tool schema exposes it, so the model cannot reach it |
| `ctx.shell` provider | `extensions/dsh/executor.ts` | `resolve()` applies our deadlines/caps; `execute()` delegates to the shared `ExecutionService` and returns a settled handle |
| `devcontainer` command | `extensions/dsh/command.ts` | reuses `createCommandHandlers`; `hasUI: false` makes destructive verbs refuse; diagnostics are prefixed `[config]` and reported once |
| Runtime composition | `extensions/dsh/runtime.ts` | same audit writer, config loader and execution gate; no automatic target adoption |
| Plugin entry + config schema | `extensions/dsh/index.ts` | Schemastery `Config`; registers the provider on its own fiber; `commands` is optional, never injected |
| Bundle patch | `cordis.patch.yml` | **disables** the `bash-sandbox` row and **inserts** its own (the loader refuses a row rename — see "verified against the real loader" below); sets `tool-bash.enableRunInBackground: false` |

### Verified against the real loader (dsh 0.2.1-rc.2, live)

A fourth fact, which decides how the package must declare its dependencies: **dsh mounts plugin
modules through its own Node loader with `bareModuleBaseUrl` = the dsh installation**
(`mountRootInclude` → `ctx.loader.internal.import(specifier, bareModuleBaseUrl)`). Bare specifiers in
a plugin therefore resolve to the *harness's* copies of `@deepseek-ai/*`, not to whatever sits beside
the plugin. That is why a tarball-installed copy works with `peerDependencies` declared
`optional: true`, and why declaring them as `dependencies` would be a defect (second Cordis instance
→ a `ShellExecutor` from a different module graph than the host's).


Three facts that the documentation does not state, each found by running the bundle in a real
profile (`dsh plugin --profile devc add <checkout>`):

1. **A patch row cannot rename a row.** `- id: bash-sandbox; name: 'pi-devcontainer-manager/dsh'`
   is skipped with `patch: name mismatch for "bash-sandbox" (expected "@deepseek-ai/dsh-bash-sandbox",
   got "pi-devcontainer-manager/dsh"), skipping` and nothing is applied. Swapping a provider is
   therefore `disabled: true` on the base row **plus** an `insert:` of ours. Config-only overrides
   keep working when the name matches.
2. **`dsh-permission-presets` refuses an unconfined executor.**
   `the mounted bash executor does not confine (no sandboxMode) — … composing this plugin over an
   unconfined executor is a misconfiguration`, and the boot degrades to `warning: 1 entry did not
   activate`. This is inherent to the port: commands run inside the container, so a host sandbox
   mode cannot be honoured. The bundle does **not** disable the presets row itself (that would also
   remove host sandboxing for dsh's file tools); a profile using the bundle disables it in its own
   layer, and the trade-off is recorded in §8.
3. **The seam is `ctx.shell`, and it is exclusive.** With the base row disabled and ours inserted,
   the real bash tool reaches our provider: with no target selected it returned
   `Error: No DevContainer target is selected.` (from `src/target-store.ts`) instead of running the
   command on the host — the fail-closed behaviour, observed end to end.

Original work order:

1. `extensions/dsh.ts` — `apply(ctx)` registering the provider, the command, and the tools.
2. `DevcontainerShellExecutor` over the existing execution service.
3. `cordis.patch.yml` + `dsh.bundle` / `engines.dsh`.
4. Tests: adapter unit tests against a fake Cordis context; one integration test that loads
   the bundle through `ctx.plugin` and runs a command inside a real container.

## 8. Open questions — decided 2026-10-22

1. **Package shape** — one package with both manifests. Chosen: both, with `exports["./dsh"]`
   as the plugin row's module and `dsh.bundle.patch` for the layer. `src/` is not forked.
2. **First proof** — provider + `devcontainer` command, as recommended. The two model-facing
   tools (`devcontainer_exec`, `devcontainer_host_exec`) remain Pi-only for now: under dsh the
   shell seam covers the execution half, and adding tools is additive rather than structural.
3. **Environment policy** — pass through unchanged, on the explicit channel
   (`ExecRequest.explicitEnvironment`). The container-side allowlist still governs inherited
   state; nothing names `DSH_*` variables explicitly.
4. **Host-only assumption** — documented as a hard prerequisite with a typed refusal path
   (`docs/dsh.md`, Limitations). Not yet exercised by a test: no sandboxed dsh provider exists
   to exercise it against.
5. **Version pin** — `engines.dsh: ">=0.2.1-rc.2 <0.3.0"`, i.e. the line the implementation was
   written against, not a floating `*`.
6. **Permission presets** — DECIDED (a), by the operator, 2026-10-23: the bundle disables the
   `permission` row itself, so a stock profile boots clean. The trade-off is recorded in the patch
   comment, `docs/dsh.md` and Troubleshooting: the presets also constrained dsh's host FILE tools,
   which keep working but without a sandbox mode (still subject to `fs` policy and to `approval`,
   a separate row). The alternative — leaving each profile to disable it — was rejected because
   `warning: 1 entry did not activate` on every boot reads like a bug.

## 9. Decision log

- **2026-10-22 — research recorded.** dsh plugin model measured; options A–D enumerated
  (see git history of this file for the original option table and the A recommendation).
- **2026-10-22 — requirement clarified by the project owner:** the plugin's purpose is
  *managing DevContainers and using the DevContainer environment*. Decision: **C**, a dsh
  bundle over the existing `src/`, with `ctx.shell` (`ShellExecutor`) as the primary
  integration point, `ctx.commands` for the management verbs and `ctx.tools` for the two
  model-facing tools. A/B/D rejected in §7. Open questions in §8 remain.
- **2026-10-22 — implemented** on the `0.2.1-rc.2` line: shared `src/runtime-composition.ts`
  (Pi entry refactored onto it), `extensions/dsh/{index,executor,command,runtime}.ts`,
  `cordis.patch.yml`, `exports["./dsh"]` + `dsh.bundle` + `engines.dsh`, and 9 + 9 unit tests
  (`tests/unit/dsh-shell-executor.test.ts`, `tests/unit/dsh-command.test.ts`) plus an
  explicit-environment case in `tests/unit/execution-service.test.ts`.
- **Live run 2026-10-22 (dsh 0.2.1-rc.2, profile `devc` from the headless template):** bundle
  installed as a linked checkout, `--dump-config` shows `bash-sandbox` disabled + `devcontainer-shell`
  inserted, and the headless agent's `pwd` through the bash tool returned
  `Error: No DevContainer target is selected.` — our provider, our refusal, nothing executed on the
  host. Two open items from that run: the `permission` presets row must be disabled by the profile
  (decision pending on whether the bundle should do it), and the deployment's global configuration
  must grant `allowedWorkspaceRoots` (the operator's file currently grants none, so every workspace
  is refused by design).
- **2026-10-23 — local install verified both ways:** a linked checkout and a packed tarball, each
  installed into a profile with `dsh plugin --profile <name> add …`; the tarball copy booted and the
  bash tool again reached our provider (typed refusal, nothing on the host). Two operational facts
  recorded in `docs/dsh.md`: `dsh plugin add` on an unknown profile creates a base-only profile with
  no app (create it from a template first), and a linked checkout runs `dist/`, so `npm run build`
  precedes every install/update.
- **2026-10-23 — primary surfaces are web and acp** (operator). Three consequences, each measured:
  (1) in the web app `/devcontainer …` now appears in the composer's command menu — verified by
  reading the composed menu; before that a plain `ctx.get("commands")` during `apply()` could miss a
  registry mounted later and silently lose the surface, so registration moved to
  `ctx.inject(["commands"])`; (2) ACP composes **no** command consumer (`inject` = agents/llm/
  sessions/sessionPersistence), so management must be a **tool** — `extensions/dsh/tools.ts` now
  registers a model-facing `devcontainer` tool, verified end to end against the REAL
  `ToolRegistry` (schema accepted, catalog entry present, `ctx.tools.execute()` returns our text);
  (3) a **tool** runs inside a turn and can call `ctx.approval.request()`, while a **command** cannot
  (the service throws outside an open turn), so destructive verbs are approval-gated through the tool
  and still refuse on the command surface. Web-UI end-to-end dispatch could not be driven by
  automation (the composer does not accept synthetic input), so the last click stays manual.
- **2026-10-23 — per-workspace activation implemented (the fix for "the plugin must not hijack a
  profile")**: replacing `ctx.shell` is process-wide while this capability is per workspace, so the
  provider now mounts the harness's host executor on an ISOLATED `shell` scope (`ctx.isolate('shell')`)
  and delegates whenever the workspace has no devcontainer config — the same activation rule the Pi
  extension uses (`workspaceHasConfig`). Verified live in ONE profile: `pwd` in `/tmp/plainproject`
  returned the host path and stderr carried the sandbox notice (`landlock-run: partial enforcement`),
  i.e. the real sandboxed executor ran; after `devcontainer up` on the fixture workspace the same tool
  returned `/workspaces/…` with `whoami` = `vscode`. Two facts learned the hard way: the module must be
  resolved from the harness (a plain `import()` inside a plugin cannot see `dsh-base`'s private deps),
  and the running bin is a SYMLINK, so `realpathSync(argv[1])` is the base that actually resolves it.
- **2026-10-23 — plugin-page metadata is RESOURCE-based**: the 插件 page showed the package with no
  title/description because dsh resolves display metadata through the package's `exports`
  (`<specifier>/locale/en.json`, `<specifier>/icon`, `<specifier>/package.json`) and ours exported
  neither. Fixed by exporting all three; verified by calling dsh's own `readPluginMeta` against the
  installed profile, which returned `title {en, zh}`, the two descriptions and the SVG icon as a data
  URL. Note this is independent of the module entry: a plugin can load perfectly and still render as a
  bare name.
- **2026-10-23 — presets decision (A):** the bundle disables `permission` (`@deepseek-ai/dsh-permission-presets`)
  rather than leaving it to the profile layer; `cordis.patch.yml`, `docs/dsh.md` and Troubleshooting
  updated to state the cost for host file tools.
- **Correction recorded:** the first pass of this study read the `0.0.1-rc.*` packages from the
  `latest` dist-tag. The target harness (`@deepseek-ai/dsh@0.2.1-rc.2`) uses a renamed seam
  (`ctx.bash` → `ctx.shell`), a different executor contract (`run`/`start` → `execute`), and a
  different bundle row (`bash-sandbox`). Pin versions when reading these packages; `latest` is
  a generation behind.
