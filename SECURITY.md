# Security policy

## Reporting a vulnerability

Please report security issues **privately**, using GitHub's private vulnerability
reporting on this repository:

<https://github.com/ahaeureka/pi-devcontainer-manager/security/advisories/new>

Do not open a public issue for a vulnerability. Include the version (`pi list`, or
`package.json`), your platform, the failing surface (`bash`, `devcontainer_exec`,
`devcontainer_host_exec`, `/devcontainer …`), and a minimal reproduction. Redact
API keys, tokens, and anything private from logs and configuration.

This is a volunteer project, so there is no formal response SLA. Reports that
include a reproduction get triaged fastest.

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x | yes |
| < 1.0.0 | no — pre-release, unpublished |

## What is in scope

The extension's security claims are documented in
[docs/security.md](docs/security.md). A report is in scope when it shows one of
those claims is false. The highest-value classes are:

- **Policy bypass** — an operation running without its required grant
  (`allowedWorkspaceRoots`, `destructive.allowStop`/`allowRemove`,
  `hostExecution.allow`, `environmentAllowlist`), or an *untrusted* project
  configuration expanding a global grant.
- **Host/container mis-route** — a container-targeted argv executing on the host,
  or host administration silently reaching the container.
- **Selection hijack** — an operation whose audit record, bound target, and
  executed container disagree, or a concurrent `/devcontainer use` redirecting an
  in-flight command.
- **Credential or session leakage** — Pi session metadata, `PI_*` names, or
  secret-pattern environment names reaching a container process, or environment
  values appearing in audit records.
- **Audit integrity** — an operation that is not audited, a denial that is not
  recorded, a record claiming authorization that policy did not grant, or
  unredacted secrets in `commandText`/`errorSummary`.
- **Path containment escape** — a workspace outside every allowed root (including
  via symlink) being accepted as a target, or a container-only path passing the
  host-exec guard.
- **Confirmation bypass** — `stop`/`remove`/`setup` proceeding without an
  interactive confirmation, or in a noninteractive session.
- **Process-boundary escape** — a child outliving cancellation/timeout, or
  unbounded output exhausting the extension process.

## What is out of scope

- **Anything the container itself can do.** Isolating untrusted code is the
  DevContainer's job, not this extension's. A command you route into a container
  can read and write whatever the container user can, including host files
  reachable through the bind mount — that is a documented, audited behavior.
- **The risk that installing any Pi package carries.** Pi extensions execute
  arbitrary code with full system access; review source before installing.
  Vulnerabilities that only require the attacker to already control the Pi
  installation are not this package's bugs.
- **Unsupported platforms.** Windows hosts, WSL2, Podman, rootless Docker, and
  non-Docker backends are explicitly unsupported and fail closed; "it does not
  work there" is a bug report, not a vulnerability.
- **Docker daemon compromise, malicious images, or registry poisoning.**
- **Known-limitation items already documented** in
  [docs/security.md](docs/security.md) (for example: redaction is best-effort and
  `redacted-text` capture should be treated as sensitive;
  `audit.retentionDays` is a writer capability that the shipped extension does not
  schedule). Improvements are welcome as normal issues.
- **Denial of service through your own configuration** (for example setting
  `maxOutputBytes` to a huge value).
