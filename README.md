# pi-devcontainer-manager

A host-side Pi extension for **governed multi-DevContainer discovery and execution**.

Pi stays on the host. DevContainers are explicitly selected, policy-checked
command-execution targets — never a place where Pi sessions, extensions,
configuration, model credentials, or API keys are installed, copied, mounted,
or persisted.

## What it does

- **Discovers** DevContainer projects beneath your configured workspace roots —
  `devcontainer.json`, `.devcontainer/devcontainer.json`, and `.devcontainer.json`
  — and merges them with Docker label candidates into one workspace registry.
  Config-only projects (never started) are first-class entries.
- **Selects** one target at a time (`/devcontainer list`, `use`, `status`),
  persists the choice in the session, and restores it after `/reload`. When nothing
  is selected yet, the workspace you started Pi in is auto-selected as the default
  if it has a DevContainer configuration (an explicit `/devcontainer use` always
  wins over this empty-selection default).
- **Executes** through a shared, governed service — the `devcontainer_exec` tool,
  routed Pi `bash`, and `!`/`!!` all hit the same target validation, policy,
  environment filtering, audit, output accounting, cancellation, and timeout.
- **Manages** lifecycle: `up`, `build`, `stop`, `remove` (stop/remove need a
  policy grant **plus** a fresh per-action confirmation), and bounded `logs`.
- **Audits** every operation to a host-local JSONL file (fingerprint capture by
  default, 90-day retention).
- **Never falls back silently** to the host: a `container-required` route returns
  a typed `no-candidate` / `ambiguous-candidate` / `target-stopped` /
  `policy-denied` error instead. The only host escape hatch is the visibly named,
  separately policy-gated, audited `devcontainer_host_exec` tool and
  `/devcontainer host-exec` command.

## Requirements

- **Node.js >= 22.19.0** (the package `engines` field)
- **Pi** (the host coding agent) — this package registers tools, commands, and a
  replacement `bash` tool inside Pi
- **Docker Engine or Docker Desktop** on **Linux or macOS**
- The **Dev Containers CLI** (`devcontainer`) — installed as the pinned
  development dependency `@devcontainers/cli@0.88.0`, or resolvable on `PATH`

Windows, WSL2, Podman, and rootless Docker are **not** supported in v1; see
[docs/compatibility.md](docs/compatibility.md).

## Quick start

```bash
# 1. Install the extension package (the npm tarball or the published package).
npm install -g pi-devcontainer-manager   # or: pi install ./pi-devcontainer-manager-1.0.0.tgz
# (a real Pi CLI install is required for the extension to load)

# 2. Optional: global configuration at
#    ~/.pi/agent/extensions/pi-devcontainer-manager.json
#    See docs/configuration.md for every option and its default.

# 3. Start Pi in a workspace, then:
/devcontainer list     # discover + show the registry
/devcontainer use      # pick a target (or name it: /devcontainer use ~/code/project-b)
/devcontainer up       # start a config-only target
devcontainer_exec { "argv": ["npm", "test"] }   # run in the selected container
```


> **Developing this extension locally?** Symlink this checkout into Pi's
> auto-discovery extensions folder (`${PI_CODING_AGENT_DIR:-~/.pi/agent}/extensions`)
> and `npm run build` — no `settings.json` edit needed, and the extension loads
> in every project. See
> [docs/installation.md](docs/installation.md#local-development-install-auto-discovery-symlink).
See [docs/installation.md](docs/installation.md),
[docs/configuration.md](docs/configuration.md),
[docs/security.md](docs/security.md), and
[docs/compatibility.md](docs/compatibility.md).

## Surface summary

| Kind | Name | Notes |
|---|---|---|
| Slash command | `/devcontainer` | Interactive verb picker (or usage when no UI) |
| Slash command | `/devcontainer list` | Discover + render registry |
| Slash command | `/devcontainer status` | Same status block |
| Slash command | `/devcontainer use [path]` | Select; persists into session |
| Slash command | `/devcontainer up [path]` | `devcontainer up --workspace-folder` |
| Slash command | `/devcontainer build [path]` | `devcontainer build` |
| Slash command | `/devcontainer stop` | Docker stop, policy + confirmation |
| Slash command | `/devcontainer remove` | Docker `rm -f`, policy + confirmation |
| Slash command | `/devcontainer logs [--tail N]` | Bounded `docker logs` (default 100) |
| Slash command | `/devcontainer host-exec <argv...>` | Audited host escape hatch (policy-gated) |
| Tool | `devcontainer_exec` | Structured argv exec in the selected target |
| Tool | `devcontainer_status` | Read-only summary of the current selection |
| Tool | `devcontainer_host_exec` | Explicit host escape (policy-gated, audited) |
| Bash | `bash` (replaced), `!`/`!!` | Routed into the selected target |

## Example settings file

A complete example settings file (with every default shown) lives at
[examples/pi-devcontainer-manager.settings.json](examples/pi-devcontainer-manager.settings.json).

## License

MIT — see [LICENSE](LICENSE). Changes are recorded in
[CHANGELOG.md](CHANGELOG.md).
