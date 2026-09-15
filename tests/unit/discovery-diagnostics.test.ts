/**
 * Unit tests for the discovery diagnostic sink.
 *
 * The contract that matters operationally is the second one: the registry is re-read on every
 * `/devcontainer` command and on the activation probe, so a sink that re-reported the same line
 * would spam the operator with the same warning all session.
 */
import { describe, expect, it } from "vitest";
import { createDiagnosticSink, reportDiscoveryDiagnostics } from "../../src/discovery-diagnostics.js";

describe("createDiagnosticSink", () => {
  it("drains nothing before anything is added", () => {
    expect(createDiagnosticSink().drain()).toEqual([]);
  });

  it("drains in insertion order and clears the queue", () => {
    const sink = createDiagnosticSink();
    sink.add(["first", "second"]);

    expect(sink.drain()).toEqual(["first", "second"]);
    expect(sink.drain()).toEqual([]);
  });

  it("reports each distinct line at most once for the life of the sink", () => {
    const sink = createDiagnosticSink();
    sink.add(["cannot read directory /work/x"]);
    expect(sink.drain()).toEqual(["cannot read directory /work/x"]);

    sink.add(["cannot read directory /work/x", "cannot read directory /work/x"]);
    expect(sink.drain()).toEqual([]);
  });

  it("dedupes within one batch, trims, and ignores blank lines", () => {
    const sink = createDiagnosticSink();
    sink.add(["  spaced  ", " ", "spaced", "", "other"]);

    expect(sink.drain()).toEqual(["spaced", "other"]);
  });

  it("still reports lines that arrive after a drain", () => {
    const sink = createDiagnosticSink();
    sink.add(["a"]);
    expect(sink.drain()).toEqual(["a"]);

    sink.add(["b"]);
    expect(sink.drain()).toEqual(["b"]);
  });
});

describe("reportDiscoveryDiagnostics", () => {
  it("drains queued lines into the notify channel and reports how many it delivered", () => {
    const sink = createDiagnosticSink();
    sink.add(["cannot read directory /work/x", "max depth 3 reached"]);
    const notified: string[] = [];

    const reported = reportDiscoveryDiagnostics(sink, (line) => notified.push(line));

    expect(reported).toBe(2);
    expect(notified).toEqual(["cannot read directory /work/x", "max depth 3 reached"]);
    // The queue is emptied by the drain, so a second pass must not repeat the same warnings —
    // the registry is re-read on every command and on the activation probe.
    expect(reportDiscoveryDiagnostics(sink, (line) => notified.push(line))).toBe(0);
    expect(notified).toHaveLength(2);
  });

  it("notifies nothing when the scan was clean", () => {
    const notified: string[] = [];

    expect(reportDiscoveryDiagnostics(createDiagnosticSink(), (line) => notified.push(line))).toBe(0);
    expect(notified).toEqual([]);
  });
});
