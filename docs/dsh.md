# DeepSeek Harness (dsh) support

> **Docs:** [Index](README.md) · [Installation](installation.md) · [Configuration](configuration.md) · [Security](security.md) · [Compatibility](compatibility.md) · [Troubleshooting](troubleshooting.md)

The same DevContainer management runs under **DeepSeek Harness** (`dsh`), because the
capability lives in a harness-free core (`src/`) with two thin entry points:
`extensions/index.ts` for Pi and `extensions/dsh/index.ts` for dsh.

## How it is structured as a dsh plugin

dsh's composition model is "plugins that declare what they need", so the bundle is one row that
composes five plugins, each with its own fiber, `inject` and config — not one `apply()` holding
everything as closures:

| Plugin | Role (dsh terminology) | `inject` | Config |
|---|---|---|---|
| `DshRuntimeService` (`devcontainerRuntime`) | **Service** — the shared runtime (config → audit → adapters → target store → execution gate) | — | `workspace`, `globalConfigPath`, `projectConfigPath`, `projectTrusted` |
| `DevcontainerShellProvider` | **Service Provider** for `ctx.shell` (extends `ShellExecutor`) | `devcontainerRuntime` | `timeoutMs`, `maxTimeoutMs`, `activation`, `hostFallback`, `hostExecutorModule`, `hostExecutorConfig` |
| `devcontainer` **tool** | Consumer of `tools` (the only management surface on ACP) | `devcontainerRuntime`, `tools` | — |
| `devcontainer` **command** | Consumer of `commands` (web / TUI) | `devcontainerRuntime`, `commands` | — |
| `devcontainer:execution-context` | Consumer of `systemPrompt` | `devcontainerRuntime`, `systemPrompt` | — |

Consequences that matter operationally:

- A surface a deployment cannot use simply parks PENDING (no command registry in ACP → only that
  plugin waits) instead of taking the others down with it.
- Each plugin's config is validated by its own `Config` schema, and the provider's defaults live in
  the provider.
- The approval service is deliberately **not** injected: it is optional, read at the use site, and its
  absence means "no confirmation available" (a destructive verb then refuses).
- The runtime is a service (not a closure) because dsh's answer to "two plugins need the same thing" is
  `inject`, and because a service can be unloaded with its provider on HMR.

What that buys: dsh's `ctx.shell` capability is *provided* by this package, so the bash
tool — and any other dsh plugin using `ctx.shell` — executes inside the selected
DevContainer instead of on the host. Management verbs are exposed as the `devcontainer`
dsh command.

## What you get

| Surface | Behaviour under dsh |
|---|---|
| `systemPrompt` section `devcontainer:execution-context` | tells the model the container facts (current target, surfaces, remedies) — re-evaluated on every assembly |
| `ctx.shell` (bash tool, hook bridges, other plugins) | runs inside the selected container through `devcontainer exec` |
| **`devcontainer` tool** (model-facing) | all verbs; the only management surface on **ACP**, and the one that can ask for approval |
| `devcontainer <verb>` command (web/TUI) | `list`, `status`, `use`, `off`, `up`, `rebuild`, `build`, `logs`, `host-exec` — destructive verbs refuse here |
| Destructive verbs (`stop`, `remove`, `rebuild`, `setup`) | through the **tool**: approval is requested first (web dialog / ACP permission request); through the **command**: refused, because a command runs between turns and cannot ask |
| Policy, audit, routing guard, path mapping, timeouts | unchanged — the same `src/` services the Pi extension uses |
| Configuration | the same files the Pi extension reads; the project layer is opt-in (see below) |

### web vs acp vs headless

| App | Human command (`/devcontainer …`) | Tool | Approval dialog |
|---|---|---|---|
| **web** (browser UI) | yes — listed in the composer's `/` menu | yes | yes (approval UI) |
| **acp** (agent-client-protocol) | **no** — the ACP app composes no command consumer | yes | yes (ACP permission request) |
| headless (`dsh … "task"`) | no | yes | policy `never`/`always` |

Because ACP has no command surface, "select a container" there is a tool call, not a keystroke:
ask the agent to use `devcontainer use <workspace>`; the target it binds is what `ctx.shell` routes
to for the rest of the session.

## Install

Three steps: have a **profile** (dsh's unit of composition), install this package into
it, then boot it. `dsh` reads the profile's `package.json` (`dsh.profile.bundles`) plus
its own `cordis.patch.yml` layers — this package contributes one bundle layer and its own
patch (`dsh.bundle.patch` → `cordis.patch.yml`).

### 1. Prepare the package

A **checkout** is linked, not copied, so its `dist/` is what runs — build it first:

```bash
git clone <repo> && cd pi-devcontainer-manager
npm ci && npm run build          # dist/ must exist; the dsh entry is dist/extensions/dsh/index.js
```

To install a **stable copy** instead of a live link, pack it and install the tarball:

```bash
npm pack                          # → pi-devcontainer-manager-1.0.0.tgz
```

### 2. Pick (or create) a profile, then add the plugin

An existing profile (e.g. `web`) works as-is. To make a dedicated one, create it from a
shipped template first — `dsh plugin … add` on an unknown name creates a profile that has
`@deepseek-ai/dsh-base` but **no app**, so nothing boots:

```bash
dsh devc --from-default-profile headless --dump-config   # creates $DSH_HOME/profiles/devc
```

Then install, either from the checkout (live link) or the tarball (copy):

```bash
dsh plugin --profile devc add /abs/path/to/pi-devcontainer-manager
dsh plugin --profile devc add /abs/path/to/pi-devcontainer-manager-1.0.0.tgz
```

Both record `pi-devcontainer-manager` in `dsh.profile.bundles`, so the package's patch is
applied after `dsh-base`.

### 3. Verify before booting (composition only, no model needed)

```bash
dsh --profile devc --dump-config | grep -A2 "id: bash-sandbox"        # → disabled: true
dsh --profile devc --dump-config | grep -A3 "id: devcontainer-shell"  # → name: pi-devcontainer-manager/dsh
dsh --profile devc --dump-config | grep -A14 "id: permission"         # → disabled: true
dsh --profile devc --dump-config | grep -A6 "id: tool-bash"           # → enableRunInBackground: false
```

If those four rows look right, the **bundle layer** is live. Whether the harness then routes
`bash` into a container is a runtime question — see [Verifying it is in effect](#verifying-it-is-in-effect).


### Plugin-page metadata (title, description, icon)

dsh reads a plugin's display metadata from **exported resources**, not from the module: it resolves
`<specifier>/locale/en.json` (+ `zh.json`, discovered in the same directory) and `<specifier>/icon`
through the package's own `exports`. A package whose `exports` map lacks them shows up in the 插件
page as a bare specifier with no description — which is exactly what happened here before these were
added:

| File | Provides |
|---|---|
| `locale/en.json`, `locale/zh.json` | `meta.title`, `meta.description` per language |
| `assets/icon.svg` (manifest `icon`, also exported as `./icon`) | the row icon (SVG/PNG/JPEG/WebP, ≤ 256 KiB) |
| `exports["./package.json"]` | needed for dsh to read the fallback `description` |

Verify without booting:

```bash
node -e "const {readPluginMeta, resolveBundleDir}=require('@deepseek-ai/dsh-app-boot');"  # from the dsh install
```

### Why the `@deepseek-ai/*` packages are optional peers

dsh mounts plugin modules through its **own** module loader, resolving bare specifiers
against the dsh installation, so `@deepseek-ai/cordis`, `-dsh-shell`, `-schemastery` and
`-dsh-commands` resolve to the harness's copies — one instance, so `ShellExecutor` and the
service registry are the same classes dsh uses. Declaring them as `dependencies` would
install a second copy and break exactly that, which is why they stay
`peerDependencies` + `optional: true`.

### Updating

| Install kind | Update |
|---|---|
| Linked checkout | edit/`git pull`, `npm run build`, restart dsh — no reinstall |
| Tarball copy | `npm pack` again, `dsh plugin --profile <name> add <new .tgz>`, restart |
| Configuration-only | the plugin's `config` row or the global configuration file; a restart reapplies it (dsh has no `/reload`) |

### Removing

```bash
dsh plugin --profile devc remove pi-devcontainer-manager
```

### One profile, two kinds of workspace (activation & host delegation)

`ctx.shell` is a single process-wide seam, but DevContainer management is per **workspace**. So the
provider activates the way the Pi extension does — from the workspace's own configuration:

| Workspace | Commands run |
|---|---|
| has `.devcontainer/devcontainer.json` (or `.devcontainer.json`) | inside the container; with no target bound it fails closed (`No DevContainer target is selected.`) |
| anything else | on the host, through the harness's **own** executor — the bundle mounts it on an isolated `shell` scope and delegates, so sandbox mode, environment and semantics are the host ones |

Delegation is not a weakened gate: a managed workspace never reaches the host executor. Two config
keys control it:

| Key | Default | Meaning |
|---|---|---|
| `activation` | `workspace-config` | `always` takes over the whole profile (container-only deployments) |
| `hostFallback` | `delegate` | `refuse` keeps the container path for unmanaged workspaces too |
| `hostExecutorModule` | `@deepseek-ai/dsh-bash-sandbox` | which host executor to delegate to |
| `hostExecutorConfig` | — | that executor's own config, forwarded verbatim |

The delegate is resolved through the harness package that launched dsh (a bin symlink realpath, then
the argv path, the node executable, and the cwd). If the module cannot be found, delegation fails with
a message naming it and the managed path keeps working — install it beside the harness, or point
`hostExecutorModule` at an absolute path.

Verified live in one profile: `pwd` in a plain directory returned the host path **with the sandbox
notice on stderr** (proving the delegate, not a bare spawn), and after `devcontainer up` on a
fixture workspace the same tool returned `/workspaces/…` and `whoami` = `vscode`.

### What the model is told

dsh injects tool SCHEMAS, not the reason to call them, so the plugin contributes a system-prompt
section (`devcontainer:execution-context`, order 6000). It is evaluated on every assembly, so it
reports the target the runtime holds NOW:

```text
## DevContainer execution context

Target: none selected (workspace `/path/to/project`).

Execution surfaces (choose by WHAT the command operates on, not by its name):
- shell commands run INSIDE the selected container for a DevContainer-managed workspace; …
- `devcontainer` tool / `/devcontainer <verb>` → list, status, use, off, up, rebuild, build, logs, stop, remove

Rules:
- A command refused with `No DevContainer target is selected.` … run `devcontainer up` …
- Two running containers … `selected-ambiguous` … `devcontainer use <container-id>`.
- `devcontainer off` suspends automatic adoption …
- Host paths stay valid for host file tools (bind mount) …
- Rebuilding is the way to apply a changed devcontainer.json/Dockerfile; `up` reuses …
```

Verified live: asked a model (no tools) to quote the section's `Target:` line and the rebuild sentence
— it quoted both verbatim, i.e. the section reaches the model.

### Automatic target selection

A command needs no manual `devcontainer use`: before every routed command (and before every
management verb except `off`) the provider asks `autoSelect()` to bind the workspace's own
container, using the same rule as the Pi entry (`src/target-adoption.ts`, one implementation):

| Situation | What happens |
|---|---|
| nothing selected, workspace's container running | bound automatically (`selected-valid`) |
| nothing selected, workspace nested in another discovered project | the DEEPEST project wins (`at-or-under` scope; Pi uses `exact` because a tool call may name any path) |
| two running containers for the workspace | `selected-ambiguous` — never decided by Docker's listing order; the remedy is `devcontainer use <container-id>` |
| selection parked by reality (`stop`/container removed) | re-derived only when a RUNNING candidate now exists, so `stop` stays authoritative |
| nothing selected, no container | nothing is bound; the refusal is `No DevContainer target is selected.` (it never starts a container) |
| after `devcontainer off` | adoption is SUSPENDED until `use`/`up`/`rebuild`, so the verb is not undone by the next command |

### Host permission presets are disabled by the bundle

`@deepseek-ai/dsh-base` mounts `permission` = `@deepseek-ai/dsh-permission-presets`, whose
constructor **refuses an executor that cannot confine**:

```text
permission (@deepseek-ai/dsh-permission-presets): Error: permission: the mounted bash executor
does not confine (no sandboxMode) — presets bundle a sandbox mode, so composing this plugin
over an unconfined executor is a misconfiguration
dsh: warning: 1 entry did not activate
```

That refusal is correct: commands run **inside the container**, so a host sandbox mode is a claim
this provider cannot honour. The bundle therefore disables the row, so a stock profile boots
clean.

What this costs, stated plainly: the presets also constrain dsh's own host **file** tools
(`read-only` / `workspace-write` / `danger-full-access`), which keep working but without a sandbox
mode. They remain subject to the `fs` policy and to the `approval` service
(`@deepseek-ai/dsh-user-approval`), which is a separate row and is untouched. A deployment that
wants the presets back has to remove the `permission` disable from its own layer **and** accept
that the presets describe a boundary the shell no longer has.

## Configuration

The plugin takes its own options from the composed profile tree — its row is
`devcontainer-shell` (inserted by the bundle):

```yaml
- id: devcontainer-shell
  name: 'pi-devcontainer-manager/dsh'
  config:
    workspace: '/path/to/project'
```


| Key | Default | Meaning |
|---|---|---|
| `workspace` | `process.cwd()` | Host workspace this plugin manages |
| `globalConfigPath` | Pi-compatible location of `pi-devcontainer-manager.json` | Override the global configuration file. **The global layer must grant `allowedWorkspaceRoots`** — the shipped default is empty and refuses every workspace, and a project layer cannot widen it |
| `projectConfigPath` | `<workspace>/.pi/pi-devcontainer-manager.json` | Override the project configuration file |
| `projectTrusted` | `false` | Read the project configuration file (it can grant capabilities, so this is opt-in) |
| `timeoutMs` | `120000` | Default per-command deadline |
| `maxTimeoutMs` | `maxTimeoutSeconds` from the configuration file | Hard cap for a caller-supplied deadline |

Every other key (`routeMode`, `allowedWorkspaceRoots`, `environmentAllowlist`, `audit`,
`destructive`, `hostExecution`, …) is the one documented in [Configuration](configuration.md)
and [Security](security.md); there is no second schema.

### Where to put those options (verified caveat)

On dsh 0.2.1-rc.2 the **user patch layers are not always composed**: a row written to
`$DSH_HOME/profiles/<name>/cordis.patch.yml` or `$DSH_HOME/cordis.patch.yml` can be silently
ignored (`--dump-config` shows neither the row nor a diagnostic), while the same file supplied
as an overlay does apply:

```bash
dsh --profile <name> --patch /path/to/overrides.yml <task>     # applies (verified)
```

Bundle layers (`dsh.bundle.patch`, i.e. this package's own `cordis.patch.yml`) do apply — that is
how `bash-sandbox`/`permission` are disabled and `devcontainer-shell` is inserted.

Practical consequence: prefer the **defaults** (they make the plugin work without any patch: the
workspace is the process cwd and the configuration file is the Pi-compatible one), and use
`--patch` when you must override a key. Do not assume a profile-layer edit took effect —
check it with `--dump-config`.

## Verifying it is in effect

Four checks, cheapest first. The first two need no model; the last two are the real proof.

| # | Check | Passes when |
|---|---|---|
| 1 | `dsh --profile <name> --dump-config \| grep -A2 "id: bash-sandbox"` | `disabled: true` — the base provider is out of the way |
| 2 | same, `grep -A3 "id: devcontainer-shell"` | the row exists with `name: pi-devcontainer-manager/dsh` |
| 3 | ask the agent to run `pwd` through bash, **without** calling any devcontainer verb | in a project whose container is running: `/workspaces/…` (auto-adopted, see below). In a project with no container: `Error: No DevContainer target is selected.` — which proves the provider owns `ctx.shell` and refuses to run on the host |
| 4 | ask for `whoami` | the configuration's `remoteUser` (e.g. `vscode`) — the command ran in the container, not as the host user |

Boot-time evidence for the second kind: the process prints **no** `warning: … did not activate`
line. One that remains means a base row could not compose (before this bundle disabled it, that
was the permission presets).

A routed command also leaves the audit record the Pi extension leaves (same writer, same format):
`operation: "routed-bash"`, a `targetId`, and no command text under `fingerprint-only`.

## Limitations (deliberate, and they fail loud)

1. **No background shell.** The provider wraps a batch execution API, so `execute()`
   settles the command before returning. `run_in_background` is therefore disabled in the
   bundle patch rather than pretending a finished process is live. Implementing it needs a
   streaming execution path in `ExecutionService`.
2. **`stdin` is not supported.** No execution path in this project writes a command's
   stdin; accepting bytes and dropping them would corrupt a caller's protocol.
3. **No interactive confirmation.** dsh commands carry no confirm/select dialog. Verbs that
   need one refuse with `[confirmation-required]`; an ambiguous workspace lists container ids
   and expects `devcontainer use <container-id>`.
4. **Host paths only.** `devcontainer exec` is a host command; the CLI maps the workspace
   path itself. A dsh deployment whose shell runs under a sandbox or a remote executor is not
   supported — the refusal is typed, never a silent command on the wrong machine.
5. **Adoption needs a running container.** The provider adopts the workspace's own container
   automatically (see below); it never starts one. With no container running the refusal is
   `No DevContainer target is selected.`, whose remedy is `devcontainer up`.

## Related

- [dsh plugin compatibility research](research/dsh-plugin-compatibility.md) — the measured
  study behind this port (which seams map onto which capability, and why the other
  directions were rejected).
- [`docs/security.md`](security.md) — the policy and audit model that still applies.
