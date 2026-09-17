import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The integration/e2e suites start REAL DevContainers through the pinned
    // CLI; a single container `up` routinely exceeds the 5s default per-test
    // budget, which made those suites flaky. Unit tests are unaffected in
    // practice (they finish in milliseconds).
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // The Docker-driving suites (tests/integration, tests/e2e) start and remove containers for the SAME
    // fixture projects. Vitest runs test FILES in parallel, so in a full run they used to `up` and
    // `remove` each other's containers — which is what made them fail intermittently and pass when the
    // file was run alone. `fileParallelism: false` keeps files in one worker, which is what a suite that
    // drives a shared external resource requires; the unit suite is unaffected in practice (milliseconds
    // per file).
    fileParallelism: false,
  },
});
