import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The integration/e2e suites start REAL DevContainers through the pinned
    // CLI; a single container `up` routinely exceeds the 5s default per-test
    // budget, which made those suites flaky. Unit tests are unaffected in
    // practice (they finish in milliseconds).
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
