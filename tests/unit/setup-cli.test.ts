/**
 * Unit tests for the extracted `/devcontainer setup` install stage.
 *
 * The setup flow has two stages and the audit contract is "one attempt = exactly one `setup`
 * record". Before the extraction the install stage ran without a try/catch, so a rejected spawn
 * (npm missing, timeout, abort) threw past the audit and reached the command handler as an
 * unnormalized error — the finding this suite pins. The version probe was already wrapped, so
 * these tests keep both stages honest in one place.
 */
import { describe, expect, it } from "vitest";
import { RuntimeError } from "../../src/errors.js";
import { createSetupCli } from "../../src/setup-cli.js";
import type { ProcessResult, ProcessRunner, ProcessRunnerOptions } from "../../src/runtime/process-runner.js";
import type { AuditRecord, EffectiveConfig } from "../../src/types.js";

function makeConfig(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
  return {
    version: 1,
    dockerPath: "docker",
    devcontainerPath: "devcontainer",
    routeMode: "container-required",
    allowedWorkspaceRoots: ["/ws"],
    environmentAllowlist: [],
    maxTimeoutSeconds: 900,
    maxOutputBytes: 50 * 1024,
    discovery: { maxDepth: 3, excludedDirectories: [".git"] },
    audit: { enabled: true, retentionDays: 90, commandCapture: "fingerprint-only" },
    destructive: { allowStop: false, allowRemove: false },
    hostExecution: { allow: false },
    ...overrides,
  };
}

const result = (overrides: Partial<ProcessResult> = {}): ProcessResult => ({
  exitCode: 0,
  signal: null,
  durationMs: 1,
  truncated: false,
  ...overrides,
});

type Handler = (options: ProcessRunnerOptions) => Promise<ProcessResult> | ProcessResult;

/** A runner that answers the install call (`npm`) and the version probe separately. */
function harness(
  install: Handler,
  probe: Handler = () => result(),
  overrides: Partial<EffectiveConfig> = {},
) {
  const calls: { file: string; args: readonly string[]; options: ProcessRunnerOptions }[] = [];
  const runner: ProcessRunner = {
    async exec(file, args, options) {
      calls.push({ file, args, options });
      return file === "npm" ? install(options) : probe(options);
    },
  };
  const records: AuditRecord[] = [];
  const audit = { write: (record: AuditRecord) => void records.push(record), prune: () => undefined };
  const setup = createSetupCli({
    runner,
    audit,
    config: makeConfig(overrides),
    sessionWorkspace: "/ws",
    env: { PATH: "/usr/bin" },
  });
  return { setup, records, calls };
}

/** Probe handler that reports a version the way the real CLI does (stdout). */
const probeReporting = (version: string): Handler => (options) => {
  options.onData?.(Buffer.from(`devcontainer ${version}\n`, "utf8"));
  return result();
};

describe("createSetupCli", () => {
  it("installs through the fixed argv and audits exactly one successful attempt", async () => {
    const { setup, records, calls } = harness(() => result(), probeReporting("0.88.0"));

    const outcome = await setup();

    expect(outcome).toEqual({ installed: true, version: "0.88.0" });
    expect(calls[0]?.file).toBe("npm");
    expect(calls[0]?.args).toEqual(["install", "-g", "@devcontainers/cli"]);
    expect(calls[0]?.options.timeoutMs).toBe(300_000);
    expect(calls[1]?.file).toBe("devcontainer");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      version: 1,
      operation: "setup",
      initiator: "slash-command",
      policyAuthorized: true,
      exitCode: 0,
      outputTruncated: false,
      commandCapture: "fingerprint-only",
    });
    expect(records[0]?.commandFingerprint).toBeDefined();
    expect(records[0]?.errorSummary).toBeUndefined();
  });

  it("returns a structured failure when npm exits nonzero", async () => {
    const { setup, records } = harness((options) => {
      options.onStderr?.(Buffer.from("npm ERR! 403 Forbidden\n", "utf8"));
      return result({ exitCode: 1 });
    });

    const outcome = await setup();

    expect(outcome.installed).toBe(false);
    expect(outcome.error).toContain("npm ERR! 403 Forbidden");
    expect(records).toHaveLength(1);
    expect(records[0]?.exitCode).toBe(1);
    expect(records[0]?.errorSummary).toBeUndefined();
  });

  it("audits a rejected install spawn instead of losing the attempt", async () => {
    const { setup, records } = harness(() => {
      throw new RuntimeError({ kind: "timeout", message: "Process timed out after 300000ms" });
    });

    const outcome = await setup();

    expect(outcome.installed).toBe(false);
    expect(outcome.error).toContain("Process timed out after 300000ms");
    expect(records).toHaveLength(1);
    expect(records[0]?.operation).toBe("setup");
    expect(records[0]?.policyAuthorized).toBe(true);
    expect(records[0]?.exitCode).toBeNull();
    expect(records[0]?.outputTruncated).toBe(false);
    expect(records[0]?.errorSummary).toContain("Process timed out after 300000ms");
  });

  it("normalizes a plain spawn failure too", async () => {
    const { setup, records } = harness(() => {
      throw new Error("spawn npm ENOENT");
    });

    const outcome = await setup();

    expect(outcome).toEqual({ installed: false, version: undefined, error: "spawn npm ENOENT" });
    expect(records).toHaveLength(1);
    expect(records[0]?.errorSummary).toBe("spawn npm ENOENT");
  });

  it("fails closed when the CLI is not resolvable after a successful install", async () => {
    const { setup, records } = harness(() => result(), () => result({ exitCode: 1 }));

    const outcome = await setup();

    expect(outcome.installed).toBe(false);
    expect(outcome.error).toContain("check PATH");
    expect(records).toHaveLength(1);
    expect(records[0]?.exitCode).toBe(0);
  });

  it("normalizes a rejected version probe", async () => {
    const { setup } = harness(
      () => result(),
      () => {
        throw new Error("probe exploded");
      },
    );

    const outcome = await setup();

    expect(outcome.installed).toBe(false);
    expect(outcome.error).toContain("verifying the CLI failed");
    expect(outcome.error).toContain("probe exploded");
  });

  it("omits command identity entirely when capture is disabled", async () => {
    const { setup, records } = harness(() => result(), () => result(), {
      audit: { enabled: true, retentionDays: 90, commandCapture: "none" },
    });

    await setup();

    expect(records[0]?.commandFingerprint).toBeUndefined();
    expect(records[0]?.commandText).toBeUndefined();
    expect(records[0]?.commandCapture).toBe("none");
  });
});
