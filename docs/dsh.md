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

The package publishes a dsh **bundle** (`dsh.bundle.patch` → `cordis.patch.yml`). The bundle
patch visits the base rows by id: it **disables** `bash-sandbox` (dsh composes exactly one
`ctx.shell` provider) and **inserts** its own row, then turns off `run_in_background` on
`tool-bash`. A patch row must keep the target row's `name` — dsh refuses a rename and logs
`patch: name mismatch … skipping` — which is why the provider is swapped by
`disabled` + `insert` rather than by renaming a row.

```bash
dsh plugin --profile <name> add /path/to/pi-devcontainer-manager   # or the published tarball
dsh --profile <name> --dump-config          # shows this bundle's layer
dsh --profile <name>
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
