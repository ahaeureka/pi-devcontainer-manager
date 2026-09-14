import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { needsExplicitConfig } from "../../src/runtime/devcontainer-adapter.js";
import type { DevcontainerConfigKind } from "../../src/types.js";

/**
 * AC-1 contract: every configuration form the extension accepts must actually
 * resolve in the pinned CLI with the argv the extension builds for it.
 *
 * This is the regression test for the defect that motivated the task: discovery
 * accepted a legacy root `devcontainer.json` and did not see named
 * `.devcontainer/<name>/devcontainer.json` forms at all, while the adapter only ever
 * passed `--workspace-folder`. A discovered target could therefore be selected and
 * never started.
 *
 * The leg runs the REAL pinned CLI via `read-configuration`, which resolves
 * configuration only and starts nothing, so it needs no Docker daemon and can stay
 * in the deterministic unit gate. Workspaces are created in a temp directory rather
 * than under `tests/fixtures/` on purpose: the integration/e2e suites scan that
 * directory as an allowed workspace root, and extra fixtures there would change
 * their discovery expectations.
 */

const cliPath = [
  process.env.DEVCONTAINER_CLI_PATH,
  resolve(process.cwd(), "node_modules", "@devcontainers", "cli", "devcontainer.js"),
  resolve(process.cwd(), "node_modules", ".bin", "devcontainer"),
]
  .filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0)
  .find((candidate) => existsSync(candidate));

/** Every form discovery accepts, with the path it lives at inside a workspace. */
const FORMS: ReadonlyArray<{ kind: DevcontainerConfigKind; relative: string }> = [
  { kind: ".devcontainer/devcontainer.json", relative: ".devcontainer/devcontainer.json" },
  { kind: "root/.devcontainer.json", relative: ".devcontainer.json" },
  { kind: "root/devcontainer.json", relative: "devcontainer.json" },
  { kind: ".devcontainer/<name>/devcontainer.json", relative: ".devcontainer/python/devcontainer.json" },
];


describe.skipIf(cliPath === undefined)("CLI contract — configuration forms", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "pi-dc-forms-"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Materialize a workspace holding exactly one configuration form. */
  function workspaceWith(kind: DevcontainerConfigKind): { workspace: string; configPath: string } {
    const relative = FORMS.find((form) => form.kind === kind)?.relative ?? "devcontainer.json";
    const workspace = mkdtempSync(join(root, "ws-"));
    const configPath = join(workspace, relative);
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      `${JSON.stringify({ name: "contract", image: "mcr.microsoft.com/devcontainers/base:ubuntu-24.04" }, null, 2)}\n`,
    );
    return { workspace, configPath };
  }

  function readConfiguration(kind: DevcontainerConfigKind, withConfig: boolean) {
    const { workspace, configPath } = workspaceWith(kind);
    const argv = ["read-configuration", "--workspace-folder", workspace];
    if (withConfig) argv.push("--config", configPath);
    const result = spawnSync(process.execPath, [cliPath as string, ...argv], {
      encoding: "utf8",
      timeout: 120_000,
    });
    return { argv, status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }

  for (const form of FORMS) {
    it(`resolves ${form.kind}`, () => {
      const { argv, status, output } = readConfiguration(form.kind, needsExplicitConfig(form.kind));
      expect(status, `argv: ${argv.join(" ")}\n${output.slice(0, 400)}`).toBe(0);
    });
  }

  it("cannot find the non-default forms without an explicit --config", () => {
    // Pins WHY `--config` is required: without it these two forms are invisible to
    // the CLI's own lookup, which is exactly how the original defect slipped past
    // fixtures that only ever used the default form.
    const needingConfig = FORMS.filter((form) => needsExplicitConfig(form.kind));
    expect(needingConfig.map((form) => form.kind)).toEqual([
      "root/devcontainer.json",
      ".devcontainer/<name>/devcontainer.json",
    ]);
    for (const form of needingConfig) {
      const { status } = readConfiguration(form.kind, false);
      expect(status, `${form.kind} should not resolve without --config`).not.toBe(0);
    }
  });
});
