/**
 * Package smoke test (Slice 7).
 *
 * Validates the SHIPPED package contract without a real Pi runtime or a
 * model provider. It packs the tarball (`npm pack --dry-run --json`) and
 * asserts:
 *
 *  - the tarball contains the Pi manifest (`pi.extensions` →
 *    `./dist/extensions/index.js`) and the `files` allowlist (dist, docs,
 *    examples, README, CHANGELOG, LICENSE);
 *  - `tests`, `src` (non-dist), `.github`, and `scripts` are NOT packed;
 *  - `@earendil-works/pi-coding-agent` and `typebox` are peer (not bundled)
 *    dependencies; `@devcontainers/cli` is a devDependency only;
 *  - `engines.node` is `>=22.19.0` and `type` is `module`.
 *
 * The real runtime registration smoke (`pi` CLI loading the packed tarball)
 * lives in `scripts/smoke-pi-package.mjs` and the CI `integration` workflow,
 * because it needs a real Pi install and a configured model provider.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface PackEntry {
  path: string;
  size: number;
}

interface PackResult {
  id: string;
  name: string;
  version: string;
  files: PackEntry[];
}

function packDryRun(): PackResult {
  const stdout = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: resolve(process.cwd()),
    encoding: "utf8",
    timeout: 60_000,
  });
  const parsed = JSON.parse(stdout) as PackResult[];
  const result = parsed[0];
  if (result === undefined) throw new Error("npm pack --dry-run produced no result");
  return result;
}

function readManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as Record<string, unknown>;
}

describe("package tarball contract", () => {
  let pack: PackResult;
  let manifest: Record<string, unknown>;

  beforeAll(() => {
    pack = packDryRun();
    manifest = readManifest();
  });

  it("is named pi-devcontainer-manager at version 1.0.0 with type module", () => {
    expect(pack.name).toBe("pi-devcontainer-manager");
    expect(pack.version).toBe("1.0.0");
    expect(manifest.type).toBe("module");
  });

  it("declares the Pi extension manifest pointing at dist/extensions/index.js", () => {
    const pi = manifest.pi as { extensions?: string[] };
    expect(pi.extensions).toEqual(["./dist/extensions/index.js"]);
  });

  it("packs dist, docs, examples, README, CHANGELOG, and LICENSE", () => {
    const paths = pack.files.map((f) => f.path);
    for (const required of [
      "README.md",
      "LICENSE",
      "CHANGELOG.md",
      "docs/installation.md",
      "examples/pi-devcontainer-manager.settings.json",
    ]) {
      expect(paths).toContain(required);
    }
    // `dist/` is built by CI (`npm run build`) before packing; the dry-run
    // here runs pre-build, so assert the manifest `files` allowlist contains
    // it structurally (the artifact existence is verified by verify-package.mjs
    // and the e2e layer after `npm run build`).
    const filesAllowlist = manifest.files as string[];
    expect(filesAllowlist).toContain("dist");
  });

  it("never packs tests, src, .github, or scripts", () => {
    const paths = pack.files.map((f) => f.path);
    const forbidden = paths.filter(
      (p) => p.startsWith("tests/") || p.startsWith("src/") || p.startsWith(".github/") || p.startsWith("scripts/"),
    );
    expect(forbidden).toEqual([]);
  });

  it("keeps Pi and TypeBox as peers and the CLI as a dev-only dependency", () => {
    const peers = manifest.peerDependencies as Record<string, string>;
    expect(peers["@earendil-works/pi-coding-agent"]).toBe("*");
    expect(peers.typebox).toBe("*");
    const deps = manifest.dependencies as Record<string, string> | undefined;
    expect(deps).toBeUndefined();
    const devDeps = manifest.devDependencies as Record<string, string>;
    expect(devDeps["@devcontainers/cli"]).toBe("0.88.0");
  });

  it("declares engines.node >= 22.19.0", () => {
    const engines = manifest.engines as { node?: string };
    expect(engines.node).toBe(">=22.19.0");
  });
});
