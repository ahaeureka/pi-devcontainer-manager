---
source_path: .kata/tasks/arch-review-p1-foundation/wiki/error-kind-contract.md
ingested: 2026-09-15T05:37:19.384Z
sha256: 25d5854a76fdabf08356c17a4078725e81fe8158d4e2a4f096f6f856b7c18845
---
# Error-kind contract (pi-devcontainer-manager)

`ErrorKind` lives in `src/errors.ts` and is the operator-facing vocabulary that reaches a user
through `describeError` (`[<kind>] <message>` plus the remedy line). These rules keep it
trustworthy; the Phase 1 task `arch-review-p1-foundation` fixed two violations.

## 1. A kind names what actually failed

Do not borrow a neighbouring kind because the message reads acceptably. Two renames were made
for exactly this reason:

- `target-refreshing` — the transient "a registry re-check is in flight" state used to report
  `target-stopped`, so operators and telemetry could not tell a retry from a dead target. Only
  that state uses it; `selected-stopped`, `selected-missing` and the not-running check keep
  `target-stopped`.
- `docker-cli-failure` — a failed `docker stop` / `docker rm` used to report
  `devcontainer-cli-failure`, attributing a Docker fault to the Dev Containers CLI.

## 2. Documentation is the single enumeration — update it in the same change

`docs/troubleshooting.md` lists every kind (a "one of N values" sentence plus a per-kind table);
`docs/configuration.md` names the kinds the `container-required` route can return. Adding or
renaming a kind without updating both leaves the operator guide wrong. There is no exhaustive
`switch` over `ErrorKind` in the codebase and `errorKindOf` has no production call site, so the
compiler will **not** catch a missed site — grep for the kind name instead.

## 3. Refusals are auditable, through the shared builder

`ExecutionService.authorize()` writes its refusal record with the same private `audit()`
builder as every other record; it must not hand-build an `AuditRecord`. A characterization test
in `tests/unit/execution-service.test.ts` pins the refusal record's exact field set
(version, at, operation, initiator, workspace, `policyAuthorized: false`, `policyDenialReason`,
`outputTruncated`, `commandCapture`) so a later refactor cannot quietly add or drop a field.
Denials thrown from `TargetStore.bind()` (`no-candidate`, `ambiguous-candidate`,
`target-stopped`, `target-refreshing`) are **not** audited — only policy refusals are.

## 4. A refusal is typed, never a bare `Error`

`buildChildEnvironment` throws `RuntimeError({ kind: "policy-denied" })` for a disallowed
environment variable so `errorKindOf` classifies it like every sibling refusal. A bare `Error`
classifies as `unexpected`, which reads as a bug rather than a policy decision.

## 5. Audit redaction covers the common credential forms, not every form

`redactText` (`src/policy.ts`) runs only when `audit.commandCapture` is `redacted-text` (the
default is `fingerprint-only`). It replaces whole `Bearer|Basic|Token` values (including quoted
forms and values containing `,` `;` `:` `/` `=` `+` or non-ASCII characters), `key: value` /
`key=value` assignments, `--secret-flag value`, and URL userinfo. Known residual gaps, both
recorded by the Phase 1 review: a value spanning newlines leaks its tail (pre-existing), and the
widened scheme rule can over-redact ordinary quoted text after `Bearer`/`Basic`/`Token` (safe
direction). It is deliberately best-effort — treat plaintext capture as sensitive.
