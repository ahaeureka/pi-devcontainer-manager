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
import { testConfig } from "../fixtures/config.js";

function makeConfig(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
  return testConfig(overrides);
}

/**
 * A scripted run. `stdout`/`stderr` are the fields the process boundary supplies when the caller
 * does not stream (L5-03); this runner used to hand the probe's bytes to an `onData` callback.
 */
const result = (overrides: Partial<ProcessResult> = {}): ProcessResult => ({
  exitCode: 0,
  signal: null,
  durationMs: 1,
  truncated: false,
  stdout: "",
  stderr: "",
  ...overrides,
});

type Handler = (options: ProcessRunnerOptions) => Promise<ProcessResult> | ProcessResult;

/** A runner that answers the install call (`npm`) and the version probe separately. */
function harness(
  install: Handler,
  probe: Handler = () => result(),
  overrides: Partial<EffectiveConfig> = {},
  auditOverride?: (record: AuditRecord) => undefined,
) {
  const calls: { file: string; args: readonly string[]; options: ProcessRunnerOptions }[] = [];
  const runner: ProcessRunner = {
    async exec(file, args, options) {
      calls.push({ file, args, options });
      return file === "npm" ? install(options) : probe(options);
    },
  };
  const records: AuditRecord[] = [];
  const audit = { write: (record: AuditRecord): undefined => { records.push(record); return undefined; }, prune: () => undefined };
  if (auditOverride !== undefined) audit.write = auditOverride;
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
const probeReporting = (version: string): Handler => (_options) => result({ stdout: `devcontainer ${version}\n` });

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
    const { setup, records } = harness(() => result({ exitCode: 1, stderr: "npm ERR! 403 Forbidden\n" }));

    const outcome = await setup();

    expect(outcome.installed).toBe(false);
    expect(outcome.error).toContain("npm ERR! 403 Forbidden");
    expect(records).toHaveLength(1);
    expect(records[0]?.exitCode).toBe(1);
    // The record now says why the attempt failed instead of leaving the reason only in the
    // handler's reply (the audit writer redacts whatever lands here).
    expect(records[0]?.errorSummary).toContain("npm ERR! 403 Forbidden");
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

  it("names the signal when the install is killed instead of reporting 'exited null'", async () => {
    const { setup, records } = harness(() => result({ exitCode: null, signal: "SIGTERM" }));

    const outcome = await setup();

    expect(outcome.installed).toBe(false);
    expect(outcome.error).toContain("SIGTERM");
    expect(outcome.error).not.toContain("null");
    expect(records).toHaveLength(1);
    expect(records[0]?.errorSummary).toContain("SIGTERM");
  });

  it("writes a record that reports a failed verification instead of a success-shaped one", async () => {
    const { setup, records } = harness(() => result(), () => result({ exitCode: 1 }));

    const outcome = await setup();

    expect(outcome.installed).toBe(false);
    expect(records).toHaveLength(1);
    // `exitCode: 0` with no error summary used to be the record for a setup that failed its
    // own verification step, so the trail said success while the operator read [setup-failed].
    expect(records[0]?.errorSummary).toContain("check PATH");
  });

  it("still answers with a structured result when the audit record cannot be written", async () => {
    const { setup } = harness(
      () => result(),
      () => result(),
      {},
      () => {
        throw new Error("EROFS: read-only file system, open '/data/work/pi/audit/x.jsonl'");
      },
    );

    const outcome = await setup();

    expect(outcome.installed).toBe(true);
    expect(outcome.error).toContain("EROFS");
  });

  it("redacts secrets from the failure it hands back to the operator and the model", async () => {
    const { setup } = harness((options) => {
      return result({ exitCode: 1, stderr: "npm ERR! //registry.npmjs.org/:_authToken=supersecret-token-value\n" });
    });

    const outcome = await setup();

    // The audit copy was already redacted; the returned string is shown to the operator AND
    // handed to the model as the command result, so it must be redacted too.
    expect(outcome.error).not.toContain("supersecret-token-value");
    expect(outcome.error).toContain("[REDACTED]");
  });
});
