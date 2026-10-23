# DeepSeek Harness (dsh) support

> **Docs:** [Index](README.md) · [Installation](installation.md) · [Configuration](configuration.md) · [Security](security.md) · [Compatibility](compatibility.md) · [Troubleshooting](troubleshooting.md)

The same DevContainer management runs under **DeepSeek Harness** (`dsh`), because the
capability lives in a harness-free core (`src/`) with two thin entry points:
`extensions/index.ts` for Pi and `extensions/dsh/index.ts` for dsh.

What that buys: dsh's `ctx.shell` capability is *provided* by this package, so the bash
tool — and any other dsh plugin using `ctx.shell` — executes inside the selected
DevContainer instead of on the host. Management verbs are exposed as the `devcontainer`
dsh command.

## What you get

| Surface | Behaviour under dsh |
|---|---|
| `ctx.shell` (bash tool, hook bridges, other plugins) | runs inside the selected container through `devcontainer exec` |
| `devcontainer <verb>` command | `list`, `status`, `use`, `off`, `up`, `rebuild`, `build`, `logs`, `host-exec` |
| Destructive verbs (`stop`, `remove`, `rebuild`, `setup`) | **refuse**: dsh commands have no confirm dialog, so the gate is never bypassed |
| Policy, audit, routing guard, path mapping, timeouts | unchanged — the same `src/` services the Pi extension uses |
| Configuration | the same files the Pi extension reads; the project layer is opt-in (see below) |

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

### 3. Verify before booting

```bash
dsh --profile devc --dump-config | grep -A2 "id: bash-sandbox"    # → disabled: true
dsh --profile devc --dump-config | grep -A1 "id: devcontainer-shell"  # → name: pi-devcontainer-manager/dsh
dsh --profile devc --dump-config | grep -A3 "id: permission"      # → disabled: true
```

Then boot the profile (`dsh --profile devc`, or `dsh devc`) and run `devcontainer list`.

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

The plugin takes its own options from `cordis.yml`/`cordis.patch.yml`:

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
5. **No automatic target adoption.** Unlike the Pi entry, the dsh entry does not adopt the
   session-cwd workspace when nothing is selected: dsh has no `/reload` or session-restore
   equivalent here, so a target exists only after an explicit `devcontainer use`/`up`.

## Related

- [dsh plugin compatibility research](research/dsh-plugin-compatibility.md) — the measured
  study behind this port (which seams map onto which capability, and why the other
  directions were rejected).
- [`docs/security.md`](security.md) — the policy and audit model that still applies.
