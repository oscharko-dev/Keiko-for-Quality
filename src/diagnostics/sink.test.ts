import { describe, expect, it } from "vitest";

import { commitSha, sha256, versionTag } from "../core/brands.js";
import { createDiagnostics } from "./sink.js";
import { REASON_CODES, isReasonCode } from "./reason-codes.js";

function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

describe("diagnostics sink", () => {
  it("emits one JSON line per record", () => {
    const sink = collector();
    const diagnostics = createDiagnostics(sink.write);
    diagnostics.record("run.started", { headSha: commitSha("a".repeat(40)) });
    expect(sink.lines).toHaveLength(1);
    expect(JSON.parse(sink.lines[0] ?? "")).toEqual({
      code: "run.started",
      headSha: "a".repeat(40),
    });
  });

  it("carries only the documented field vocabulary", () => {
    const sink = collector();
    createDiagnostics(sink.write).record("engine.acquire.verified", {
      digest: sha256("b".repeat(64)),
      version: versionTag("v1.8.4"),
      counts: { bytes: 42 },
      durationMs: 1234,
    });
    expect(Object.keys(JSON.parse(sink.lines[0] ?? "")).sort()).toEqual([
      "code",
      "counts",
      "digest",
      "durationMs",
      "version",
    ]);
  });

  it("drops a count key that does not look like an identifier", () => {
    // Count keys are the one place a caller could smuggle text into a log line.
    const sink = collector();
    createDiagnostics(sink.write).record("inventory.completed", {
      counts: { total: 3, "leaked /home/runner/secret.txt": 1 },
    });
    expect(JSON.parse(sink.lines[0] ?? "").counts).toEqual({ total: 3 });
  });

  it("drops non-finite counts rather than serializing null", () => {
    const sink = collector();
    createDiagnostics(sink.write).record("inventory.completed", {
      counts: { total: Number.NaN, reviewable: 2 },
    });
    expect(JSON.parse(sink.lines[0] ?? "").counts).toEqual({ reviewable: 2 });
  });

  it("truncates a fractional duration and never emits a negative one", () => {
    const sink = collector();
    const diagnostics = createDiagnostics(sink.write);
    diagnostics.record("run.finished", { durationMs: 12.9 });
    diagnostics.record("run.finished", { durationMs: -5 });
    expect(JSON.parse(sink.lines[0] ?? "").durationMs).toBe(12);
    expect(JSON.parse(sink.lines[1] ?? "").durationMs).toBe(0);
  });

  it("retains every record in order for the run summary", () => {
    const diagnostics = createDiagnostics(() => undefined);
    diagnostics.record("run.started");
    diagnostics.record("run.finished");
    expect(diagnostics.drain().map((r) => r.code)).toEqual(["run.started", "run.finished"]);
  });
});

describe("reason codes", () => {
  it("is a closed vocabulary", () => {
    expect(isReasonCode("settlement.complete")).toBe(true);
    expect(isReasonCode("something.invented")).toBe(false);
  });

  it("contains no duplicates", () => {
    expect(new Set(REASON_CODES).size).toBe(REASON_CODES.length);
  });
});
