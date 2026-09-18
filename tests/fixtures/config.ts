/**
 * The test suite's one way to build an `EffectiveConfig`.
 *
 * Eleven test files spelled out the same literal, so every field the type gained (or lost) had to be edited eleven
 * times — and widening `tsconfig.json` to the test sources surfaced 42 errors, ten of them the `activation` field
 * that had become required and one an import that had moved. Tests state only the fields they assert; everything
 * else comes from `DEFAULTS`, so a test config cannot silently drift from the shipped one. Note that this also
 * means the six suites that used to declare `hostExecution: { allow: false }` now inherit the SHIPPED posture
 * (`true`): inert for them (none issues a `host-exec`), and stated here so it is not rediscovered as a bug.
 */
import { DEFAULTS } from "../../src/config.js";
import type { EffectiveConfig } from "../../src/types.js";

/** The workspace root the suite fixtures use unless a test states otherwise. */
const SUITE_WORKSPACE_ROOT = "/ws";

export function testConfig(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
  // The suite works on `/ws/...` workspaces, so the standard root is part of the fixture — named, and overridable,
  // rather than repeated in eight literals. A test that asserts allowlist behaviour (a workspace OUTSIDE the roots
  // must be refused) passes its own roots, and would fail loudly if this default were wrong.
  return { ...DEFAULTS, allowedWorkspaceRoots: [SUITE_WORKSPACE_ROOT], ...overrides };
}
