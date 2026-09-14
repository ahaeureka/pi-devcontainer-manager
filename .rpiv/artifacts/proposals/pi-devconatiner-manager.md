# Archived proposal (superseded)

`status: archived`
`original-path: docs/pi-devconatiner-manager.md` (note the typo in the original filename)
`last-seen-commit: b266ac3`
`archived: 2026-09 — release-prep documentation review`

## Why this is here

`docs/pi-devconatiner-manager.md` was a pre-design proposal for this extension,
written partly in Chinese and partly as a ChatGPT answer transcript. It was
deliberately does **not** do. Its content was taken out of `docs/` so it stops
being published as project documentation.

Recover the original text with:

```bash
git show b266ac3:docs/pi-devconatiner-manager.md
```

The stale content was removed from `docs/` so it is no longer published as
project documentation. A short tombstone is still there because this record was
authored without shell access; drop it with:

```bash
git rm docs/pi-devconatiner-manager.md

# optionally keep the raw original text beside this record
git show b266ac3:docs/pi-devconatiner-manager.md \
  > .rpiv/artifacts/proposals/pi-devconatiner-manager.original.md
```

## What it proposed that the shipped implementation rejects

| Proposal | Shipped behaviour | Where the decision is recorded |
|---|---|---|
| Rewrite the built-in `bash` tool via a `spawnHook` that interpolates the command into `devcontainer exec --workspace-folder <p> bash -lc "<cmd>"` | `bash` is replaced by registering the same tool name with a routed `BashOperations` instance — fixed argv, `shell: false`, no shell-string interpolation | `.rpiv/artifacts/designs/2026-08-31_09-47-28_pi-devcontainer-manager.md` |
| Container discovery returns the first `docker ps` match for `devcontainer.local_folder` | All candidates are kept; a workspace with 2+ running containers is `ambiguous` and fails closed until an id is chosen | `src/runtime/host-discovery.ts`, `src/target-store.ts` |
| `/containers`, `/container use <name>` commands; `listContainers`/`startContainer`/`rebuildContainer`/`getLogs` tools | `/devcontainer <verb>` with `list`/`status`/`use`/`up`/`build`/`stop`/`remove`/`logs`/`host-exec`/`setup`, plus the `devcontainer_exec`/`devcontainer_status`/`devcontainer_host_exec` tools | `src/commands.ts`, `src/tools.ts` |
| `devcontainer stop` / `devcontainer down` CLI lifecycle | The Dev Containers CLI has no stable top-level stop; stop/remove are Docker-based (`docker stop`, `docker rm -f`) behind policy + per-action confirmation | `src/runtime/docker-lifecycle.ts` |
| Podman support via a `usePodman` prefix | Unsupported in v1 and fails closed | `docs/compatibility.md` |
| VS Code window open/sync (`code --folder-uri`) | Out of scope; discovery reads DevContainer labels, it never drives VS Code | `docs/compatibility.md` |
| Config under a `"pi-devcontainer-manager"` wrapper key in Pi `settings.json` | A standalone JSON file (global + project), no wrapper key, monotonic merge | `docs/configuration.md`, `src/config.ts` |
| Jest + `spawnSync` mocks for testing | Vitest; capability-gated real-Docker integration/e2e plus packed-tarball smoke tests | `vitest.config.ts`, `tests/`, `scripts/` |

## Section outline of the original (for orientation)

1. Host topology: one Pi install on the host, N project DevContainers.
2. Prior-art comparison (`pi-dev-worktrees`) and why a global registry +
   runtime switcher was wanted.
3. Docker label mechanics (`devcontainer.local_folder`) and
   `devcontainer exec --workspace-folder`.
4. Target architecture and the "Pi belongs to the host" argument.
5. Feature table (required / optional / future).
6. CLI command mapping table.
7. Mermaid sequence + graph diagrams.
8. Package manifest, tool registration, tool input/output schemas.
9. Code samples (`index.ts` bootstrap, discovery, exec wrapper, config read).
10. Security and permissions, testing/CI plan, compatibility matrix,
    deliverables and milestones.
