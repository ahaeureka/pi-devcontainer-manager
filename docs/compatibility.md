# Compatibility

> **Docs:** [Index](README.md) · [Installation](installation.md) · [Configuration](configuration.md) · [Security](security.md) · [Compatibility](compatibility.md) · [Troubleshooting](troubleshooting.md)

The v1 support matrix is deliberately narrow: **Linux and macOS with Docker
Engine or Docker Desktop**. Everything else fails closed rather than silently
guessing.

## Supported

| Platform | Docker | Dev Containers CLI | Notes |
|---|---|---|---|
| Linux | Docker Engine / Desktop | `@devcontainers/cli@0.88.0` | Primary target; CI runs here |
| macOS (darwin) | Docker Desktop | `@devcontainers/cli@0.88.0` | Audit path under `~/Library/Application Support/...` |

The CLI can be installed with `/devcontainer setup`, which runs
`npm install -g @devcontainers/cli` on the host after an interactive
confirmation — so `npm` must be resolvable on PATH. Otherwise install the CLI
yourself and point `devcontainerPath` at the executable. See
[Security → `/devcontainer setup`](security.md#devcontainer-setup).

At session start the extension fires an *advisory* capability probe (Docker
and Dev Containers CLI executable presence, daemon reachability, versions).
The probe result is discarded — it is not surfaced and does not gate startup.
Failures surface where they matter: at discovery and on
each operation, as typed errors rather than silent degradation:

- **`daemon-unavailable`** — the Docker executable is missing or `docker ps`
  fails (discovery and container operations).
- **`authorization-denied`** — the Docker or Dev Containers CLI spawn was
  denied by the OS (permissions).
- **`devcontainer-cli-failure`** — the Dev Containers CLI could not be run or
  returned a structured failure for `up`/`build`/`exec`.
- On an unsupported platform, audit-directory construction fails at
  `session_start` (`Unsupported audit platform`), so the extension reports a
  startup error rather than running with guessed semantics.

The capability service additionally exposes typed diagnostic kinds
(`unsupported-platform`, `docker-executable-missing`,
`docker-daemon-unreachable`, `devcontainer-executable-missing`) that pin the
probe behavior in the unit test suite.


## Explicitly unsupported (v1)

| Surface | Reason |
|---|---|
| Windows (host) | No `win32` support; workspace-key canonicalization normalizes separators/case but no Windows/WSL2 execution is promised |
| WSL2 path translation | Not implemented; Linux-in-WSL semantics are not inferred |
| Podman | Not a Docker drop-in for the label/CLI contracts the extension relies on |
| Rootless Docker | Not covered by fixtures |
| Non-Docker backends | Out of scope for v1 |
| `devcontainer stop`/`down` / generic Compose teardown | The Dev Containers CLI has no stable top-level stop; stop/remove is Docker-based (`docker stop`, `docker rm -f`) with policy + confirmation |
| Destroying sidecar containers | Out of scope |

These exclusions are intentional and documented in the design; they will be
revisited only with fixture-backed support.

## Container image compatibility

Workspace `up`/`build`/`exec` use the Dev Containers CLI against the image and
`remoteUser` declared in the workspace's `devcontainer.json`. The bundled
integration fixtures use `mcr.microsoft.com/devcontainers/base:ubuntu-24.04`
with `remoteUser: vscode`; other images work to the extent the pinned CLI
supports them.

## Discovery behavior

- Recognizes `devcontainer.json`, `.devcontainer/devcontainer.json`, and
  `.devcontainer.json`.
- Bounded scan: stops at `discovery.maxDepth` (default `3`) and never traverses
  `node_modules`, `.git`, `.pi`, `dist`, or `build` (default exclusions, all
  configurable).
- Merges host-config entries with Docker label candidates
  (`devcontainer.local_folder`) into one registry keyed by canonical workspace
  path. Config-only (never-started) projects are first-class entries;
  docker-only candidates are retained for diagnostics.
- Stopped containers are discoverable and selectable; execution on a stopped
  target fails closed with `target-stopped` until you run `/devcontainer up`.

## Path identity

Workspace identity is a canonicalized absolute host path (`realpath` where the
path exists; resolved form otherwise, so distinct missing paths never collapse).
Symlinked roots unify with Docker label real paths. Windows path handling is an
explicit capability boundary — normalization only, no translation.
