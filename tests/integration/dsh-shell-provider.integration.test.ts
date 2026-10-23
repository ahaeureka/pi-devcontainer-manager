/**
 * Real-Docker proof of the dsh port's central claim:
 *
 *   after `devcontainer up`, a shell command issued through dsh's `ctx.shell` capability runs INSIDE
 *   the selected container — not on the host, and not through a second, parallel code path.
 *
 * The test composes the REAL dsh entry pieces: `composeDshRuntime` (config → audit → adapters →
 * TargetStore → ExecutionService), the `devcontainer` command adapter that drives `up`, and the
 * `DevcontainerShellExecutor` that dsh's bash tool would resolve. It is capability-gated exactly like
 * the Pi integration suite, so `npx vitest run tests/unit` stays deterministic without Docker.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { createDevcontainerCommand } from "../../extensions/dsh/command.js";
import { DevcontainerShellExecutor } from "../../extensions/dsh/executor.js";
import { composeDshRuntime } from "../../extensions/dsh/runtime.js";

const FIXTURE_A = resolve(process.cwd(), "tests", "fixtures", "project-a");
const FIXTURES_ROOT = resolve(process.cwd(), "tests", "fixtures");

const dockerOk = (() => {
  try {
    return spawnSync("docker", ["info"], { encoding: "utf8", timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
})();

const cliOk = (() => {
  const candidates = [
    process.env.DEVCONTAINER_CLI_PATH,
    resolve(process.cwd(), "node_modules", "@devcontainers", "cli", "devcontainer.js"),
    resolve(process.cwd(), "node_modules", ".bin", "devcontainer"),
  ].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0);
  return candidates.some((candidate) => existsSync(candidate));
})();

const blocker = !dockerOk ? "docker-unavailable" : !cliOk ? "devcontainer-cli-unavailable" : undefined;

describe.skipIf(blocker !== undefined)(`dsh ctx.shell routes into the container (${blocker ?? "ready"})`, () => {
  it(
    "up via the devcontainer command, then pwd/whoami through the shell provider are container-side",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "dsh-integration-"));
      const configPath = join(dir, "config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          // The fixtures root is the policy scope; nothing else may be operated on.
          allowedWorkspaceRoots: [FIXTURES_ROOT],
          // Keep the real audit trail out of the operator's directory for a test run.
          audit: { enabled: false, retentionDays: 1, commandCapture: "fingerprint-only" },
        }),
      );

      const runtime = composeDshRuntime({
        workspace: FIXTURE_A,
        globalConfigPath: configPath,
        projectConfigPath: join(dir, "absent-project.json"),
        projectTrusted: false,
      });

      // 1. Management half: the shared verb grammar starts (or reuses) the fixture container.
      const command = createDevcontainerCommand(runtime, { workspace: FIXTURE_A });
      const started = await command.handler({ rawInput: `up ${FIXTURE_A}`, signal: new AbortController().signal });
      expect(started.text).toContain("Up:");
      expect(started.kind).toBe("success");
      // `up` reconciles the selection, which is what lets the shell provider route at all.
      expect(runtime.targetStore.snapshot().status).toBe("selected-valid");
      expect(runtime.targetStore.snapshot().candidateId).toBeTypeOf("string");

      // 2. Execution half: the provider dsh's bash tool resolves.
      const ctx = new Context();
      const shell = new DevcontainerShellExecutor(ctx, { execution: runtime.execution, workspace: FIXTURE_A });
      const run = async (command: string) => {
        const spec = shell.resolve({ command, timeoutMs: 120_000 });
        // The spec's workdir is the HOST workspace: `devcontainer exec` is a host command that maps
        // the path itself. The command's OUTPUT is what proves where it ran.
        expect(spec.workdir).toBe(FIXTURE_A);
        const handle = await shell.execute(spec);
        const result = await handle.result();
        return { result, text: result.stdout.text.trim() };
      };

      const pwd = await run("pwd");
      expect(pwd.result.exitCode).toBe(0);
      expect(pwd.text).not.toBe(FIXTURE_A);
      expect(pwd.text.startsWith("/workspaces/")).toBe(true);

      // `remoteUser` comes from the fixture's devcontainer.json: seeing it proves the command ran in
      // the container's configured user, not as the host user.
      const who = await run("whoami");
      expect(who.result.exitCode).toBe(0);
      expect(who.text).toBe("vscode");
    },
    600_000,
  );
});
