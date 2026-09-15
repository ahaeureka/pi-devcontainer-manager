# Installation

> **Docs:** [Index](README.md) · [Installation](installation.md) · [Configuration](configuration.md) · [Security](security.md) · [Compatibility](compatibility.md) · [Troubleshooting](troubleshooting.md)

This page covers installing and loading `pi-devcontainer-manager`, the host-side
prerequisites, and the optional host state that uninstall leaves behind.

## Prerequisites

| Requirement | Minimum | Notes |
|---|---|---|
| Node.js | `>= 22.19.0` | Enforced by the package `engines` field |
| Pi | a Pi CLI install | Extension tools/commands register at Pi startup |
| Docker | Docker Engine or Docker Desktop | Linux or macOS only (see [compatibility.md](compatibility.md)) |
| Dev Containers CLI | `@devcontainers/cli@0.88.0` | Exact pin; see below |

### The Dev Containers CLI

`up`, `build`, and `exec` are performed by the Dev Containers CLI
(`devcontainer`). The adapter invokes the executable configured by
`devcontainerPath` (default `"devcontainer"`, resolved through `PATH`).

For reproducible behavior the project pins `@devcontainers/cli@0.88.0` as an
exact devDependency. `npm ci` installs it into `node_modules`, and the CI
integration workflow sets `DEVCONTAINER_CLI_PATH` to
`node_modules/@devcontainers/cli/devcontainer.js` so the test harness and the
extension use the exact pinned CLI. To use a specific CLI yourself:

- set `devcontainerPath` in the global configuration to an absolute path,
- ensure a matching `devcontainer` executable is on `PATH`, or
- run `/devcontainer setup` inside Pi: it asks for confirmation, then runs
  `npm install -g @devcontainers/cli` on the host and verifies the resulting
  `devcontainer --version` (see [Security → `/devcontainer setup`](security.md#devcontainer-setup)).

> The Docker *client* used for discovery/inspection/logs/stop/remove is resolved
> from `dockerPath` (default `"docker"`). Only Docker Engine/Desktop on
> Linux/macOS is supported.

## Install the extension package

A Pi extension has to be **registered with Pi** to load. Installing the npm
package globally (`npm install -g …`) puts files on disk but never registers the
extension, so Pi will not load it — install it as a Pi package with `pi install`.

### From npm (recommended)

```bash
pi install npm:pi-devcontainer-manager
```

### From the git repository

```bash
pi install git:github.com/ahaeureka/pi-devcontainer-manager
```

Pi clones the repository under
`${PI_CODING_AGENT_DIR:-~/.pi/agent}/git/github.com/ahaeureka/pi-devcontainer-manager`,
runs `npm install` there, and the package's `prepare` script builds `dist/` — the
checkout has no compiled output of its own, since `dist/` is not committed. Pin a ref with
`@v1.0.0` to freeze what you install; `pi update --extensions` reconciles the clone
without moving a pinned ref.

`pi install` records the package in Pi's user settings
(`~/.pi/agent/settings.json`); add `-l` to record it in a project-local
`.pi/settings.json` instead. Manage it afterwards with `pi list`,
`pi update npm:pi-devcontainer-manager`, and `pi remove npm:pi-devcontainer-manager`.

### From a local checkout (in place)

For using a checkout that lives on this machine: no publishing, no network, and the
shortest iteration loop.

```bash
pi install /absolute/path/to/pi-devcontainer-manager
# or a path relative to the settings file:
#   pi install ../ahaeureka/pi-devcontainer-manager
```

`scripts/install-local.mjs` performs that whole flow in one step — it checks the manifest
entry point and `engines.node`, rebuilds `dist/`, warns when the committed `dist/` no longer
matches the fresh build, registers the checkout with `pi install`, and asserts `pi list`
resolves it:

```bash
npm run install:local                      # build + register + assert
npm run install:local -- --check           # verify only: nothing changed
npm run install:local -- --dry-run         # print the commands it would run
npm run install:local -- --verify-runtime  # also boot a real pi (runs tests/e2e)
```

It never edits `settings.json` itself (it lets `pi install` do that) and exits nonzero with
a named reason when the checkout would not load.

Pi documents local paths as **added to settings without copying**, so the checkout you
edit *is* the package Pi loads. Iterate by rebuilding and reloading:

```bash
cd /absolute/path/to/pi-devcontainer-manager
npm run build          # dist/extensions/index.js is what the manifest points at
# in Pi: /reload
```

Two things worth knowing:

- `dist/` is **committed to this repository**, so a fresh checkout already has a
  loadable entry point; you only need `npm run build` after changing `src/` or
  `extensions/`, and CI fails if the committed output is stale.
- The path is recorded in `settings.json` (with `-l`: in `.pi/settings.json`), so the
  extension loads in every project Pi starts, like an npm or git install. Remove it
  with `pi remove <the same path you installed>`.

### From a local tarball

The release workflow produces a tarball such as
`pi-devcontainer-manager-1.0.0.tgz`:

```bash
pi install ./pi-devcontainer-manager-1.0.0.tgz
```

`pi install <tarball>` adds the package to Pi's extension settings. The package
declares its Pi entry point in the manifest:

```json
{
  "pi": { "extensions": ["./dist/extensions/index.js"] }
}
```

Peer requirements `@earendil-works/pi-coding-agent` and `typebox` are satisfied
by the Pi installation that loads the extension.

### Local development install (auto-discovery symlink)

For developing the extension against a local checkout, symlink the package
directory into Pi's auto-discovery extensions folder. Pi discovers any
directory there whose `package.json` declares a `pi.extensions` entry — no
manual `packages` entry in `settings.json` is needed.

If you would rather have the install recorded in `settings.json` than rely on
discovery, install the checkout as a local path instead — see
[From a local checkout](#from-a-local-checkout-in-place).

Find Pi's extension directory first (it follows `PI_CODING_AGENT_DIR` when set):

```bash
# Default: ~/.pi/agent/extensions/
# When PI_CODING_AGENT_DIR is set (e.g. /data/work/pi):  $PI_CODING_AGENT_DIR/extensions/
echo "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions"

# Symlink the local checkout into it
ln -sfn /absolute/path/to/pi-devcontainer-manager \
  "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/pi-devcontainer-manager"
```

Then build the compiled entrypoint (`dist/extensions/index.js`, which the
manifest points at) and reload:

```bash
cd /absolute/path/to/pi-devcontainer-manager
npm run build
# in Pi: /reload
```

The extension is now available in **every** project Pi starts — no per-project
or global `settings.json` edit. Iterate by editing `src/`, running `npm run
build`, and `/reload`.

To stop using it, remove the symlink:

```bash
rm "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/pi-devcontainer-manager"
```

## Load the extension in Pi

Start Pi inside a workspace you want to manage:

```bash
pi
```

On `session_start` the extension composes its runtime: it loads configuration
and fires an advisory capability probe whose result is discarded (see
[compatibility.md](compatibility.md)). The workspace registry is discovered lazily — on
the first `/devcontainer` command or tool call. You can verify it loaded with:

```
/devcontainer status
```

If the runtime is not initialized you will see an error such as
`DevContainer runtime not initialized; run /reload or restart pi.` Run
`/reload` or restart Pi.

## Verify your environment

The status block shows the effective route, timeout, and output caps:

```
**DevContainer target:** none
**Registry (0):**
route: `container-required` · maxTimeout: 900s · maxOutput: 50KiB
```

If Docker or the Dev Containers CLI is missing, discovery surfaces a typed
`daemon-unavailable` / `authorization-denied` / `devcontainer-cli-failure`
error (see [compatibility.md](compatibility.md)).

## Uninstall

Removing the extension **never touches your containers or your workspaces**.
Two host-local artifacts are created by normal operation and are *not* removed
by uninstall:

- **Audit directory** (host-local JSONL audit records)
  - Linux: `$XDG_STATE_HOME/pi-devcontainer-manager/audit` (defaults to
    `~/.local/state/pi-devcontainer-manager/audit`)
  - macOS: `~/Library/Application Support/pi-devcontainer-manager/audit`
- **Global configuration** (if you created one):
  `${PI_CODING_AGENT_DIR:-~/.pi/agent}/extensions/pi-devcontainer-manager.json`

Delete these deliberately if you want to remove all host state. Containers you
started with `up` remain running and are managed by Docker as usual.
