#!/usr/bin/env node
/**
 * `prepare` hook: refresh `dist/` when the toolchain is available, otherwise leave the
 * committed `dist/` alone.
 *
 * Pi installs git packages with `npm install --omit=dev` (docs/packages.md), so
 * `typescript` is NOT present in that environment — a plain `tsc` prepare script fails
 * the whole install, which is exactly what happened when this package first tried it:
 *
 *   > prepare -> npm run build -> sh: 1: tsc: not found
 *   Error: npm install --omit=dev failed with code 127
 *
 * `dist/` is therefore committed, so a git install has a working extension entry point
 * without needing a build toolchain; this hook only refreshes it for developers who do
 * have one. CI asserts that the committed output matches a fresh build.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");

if (!existsSync(tsc)) {
  console.log("[prepare] typescript is not installed (npm install --omit=dev?); using the committed dist/");
  process.exit(0);
}

const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
