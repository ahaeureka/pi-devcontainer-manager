---
source_path: docs/README.md
ingested: 2026-09-15T02:21:06.380Z
sha256: 00b910bc388fae6ecf14ce71c28b0f3e5fa089243fc66b1d032e62f8c3afea6c
---
# Documentation

`pi-devcontainer-manager` is a host-side Pi extension that discovers DevContainer
projects, lets you select one as the session's execution target, and routes
command execution into it under policy, audit, and confirmation.

Start with the [README](../README.md) if you just want to install and use it.

## Which page do I need?

| Page | Read it when |
|---|---|
| [Installation](installation.md) | Installing, loading, or uninstalling the extension; setting up the Dev Containers CLI |
| [Configuration](configuration.md) | Every configuration key, its default, and the global/project merge rules |
| [Security](security.md) | Understanding the threat model, the policy gates, the audit trail, or `/devcontainer setup` |
| [Compatibility](compatibility.md) | Checking the v1 support matrix, failure modes, and discovery/path behavior |
| [Troubleshooting](troubleshooting.md) | A typed error appeared (`target-stopped`, `no-candidate`, `policy-denied`, …) |
| [Contributing](../CONTRIBUTING.md) | Building, testing, and sending a change |
| [Security policy](../SECURITY.md) | Reporting a vulnerability |
| [Changelog](../CHANGELOG.md) | Seeing what changed in each release |

## Mental model in one screen

```text
HOST                                        container
┌──────────────────────────────────┐        ┌──────────────────────────┐
│  Pi session, extensions, config  │        │  project toolchain       │
│  model credentials, API keys     │        │  container-only mounts   │
│                                  │        │                          │
│  file tools (host filesystem) ───┼──────┐ │                          │
│                                  │      │ │                          │
│  devcontainer_exec ──────────────┼──────┼─▶ devcontainer exec        │
│  routed bash / ! / !! ───────────┼──────┼─▶ (selected target)        │
└──────────────────────────────────┘      │ │                          │
        ▲  same files via bind mount ◀────┘ └──────────────────────────┘
```

- **Pi stays on the host.** Nothing about Pi — session, extensions, config,
  credentials — is installed, copied, mounted, or persisted in a container.
- **File tools always act on the host filesystem.** A DevContainer's workspace is
  a bind mount, so host paths and container paths are the same files.
- **Execution is the environment-sensitive half, so it routes into the container**
  through one governed service: `devcontainer_exec`, the routed `bash` tool, and
  `!`/`!!` all share target validation, policy, environment filtering, audit,
  output accounting, cancellation, and timeout.
- **Host execution needs its own explicit surface** — the policy-gated,
  audited `devcontainer_host_exec` tool and `/devcontainer host-exec` command.
  There is no silent host fallback: a `container-required` route returns a typed
  error instead.

## Reference material that is not documentation

`.rpiv/artifacts/` holds the project's own discover → research → design → plan →
validation record. It is development history, not user documentation, and some of
it describes alternatives that were rejected. The superseded pre-design proposal
lives in [`.rpiv/artifacts/proposals/`](../.rpiv/artifacts/proposals/).
