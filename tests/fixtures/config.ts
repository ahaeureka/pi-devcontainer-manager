/**
 * The test suite's one way to build an `EffectiveConfig`.
 *
 * Seven test files each spelled out the same literal, so every field the type gained (or lost) had to be edited
 * seven times — and after `activation` became required, none of them compiled, which is exactly what widening
 * `tsconfig.json` to the test sources surfaced. Tests state only the fields they assert; everything else comes
 * from `DEFAULTS`, so a test config cannot silently drift from the shipped one.
 */
import { DEFAULTS } from "../../src/config.js";
import type { EffectiveConfig } from "../../src/types.js";

/** The workspace root every suite fixture uses unless a test states otherwise. */
export const SUITE_WORKSPACE_ROOT = "/ws";

export function testConfig(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
  // The suite works on `/ws/...` workspaces, so the standard root is part of the fixture — named, and overridable,
  // rather than repeated in eight literals. A test that asserts allowlist behaviour (a workspace OUTSIDE the roots
  // must be refused) passes its own roots, and would fail loudly if this default were wrong.
  return { ...DEFAULTS, allowedWorkspaceRoots: [SUITE_WORKSPACE_ROOT], ...overrides };
}
