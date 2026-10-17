import { describe, it, expect } from "vitest";
import { classify, type ClassifyInput } from "../../src/agy/classify.js";
import { EMPTY_USAGE } from "../../src/agy/types.js";

const base: ClassifyInput = { exitCode: 0, stderr: "", log: "", watchdogFired: false, agyCommand: "agy" };
const ok = (response: string) => ({ status: "SUCCESS", response, durationSec: 3, numTurns: 1, usage: EMPTY_USAGE });
const LOG_429 = "E1017 log.go:398] RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 2h13m5s.";

describe("classify", () => {
  it("reports a missing binary", () => {
    const o = classify({ ...base, exitCode: null, spawnError: Object.assign(new Error("x"), { code: "ENOENT" }) });
    expect(o).toMatchObject({ type: "error" });
    expect((o as { message: string }).message).toMatch(/agy CLI not found at "agy"/);
  });

  it("returns success for a non-empty SUCCESS response", () => {
    expect(classify({ ...base, result: ok("done"), conversationId: "c1" }))
      .toEqual({ type: "success", response: "done", conversationId: "c1", usage: EMPTY_USAGE, durationSec: 3 });
  });

  it("prefers quota from the log over everything else", () => {
    expect(classify({ ...base, log: LOG_429, result: ok("") })).toEqual({ type: "quota", resetInSec: 7985, resetText: "2h13m5s" });
  });

  it("treats the print-timeout notice as timeout even when status is SUCCESS", () => {
    const stderr = "[agy] print timeout after 15m0s with turn in progress; returning partial output";
    expect(classify({ ...base, stderr, result: ok("") })).toEqual({ type: "timeout", partialResponse: "" });
  });

  it("treats a fired watchdog as timeout", () => {
    expect(classify({ ...base, exitCode: null, watchdogFired: true })).toEqual({ type: "timeout", partialResponse: "" });
  });

  it("maps status ERROR to error with agy's message", () => {
    expect(classify({ ...base, exitCode: 1, result: { ...ok(""), status: "ERROR", error: "invalid model" } }))
      .toMatchObject({ type: "error", message: "invalid model", exitCode: 1 });
  });

  it("maps CANCELED and INTERRUPTED to cancelled", () => {
    expect(classify({ ...base, result: { ...ok(""), status: "CANCELED" } })).toEqual({ type: "cancelled" });
    expect(classify({ ...base, result: { ...ok(""), status: "INTERRUPTED" } })).toEqual({ type: "cancelled" });
  });

  it("maps an empty response with a permission notice to denied", () => {
    const o = classify({ ...base, stderr: "tool run_command requires permission; denied in print mode", result: ok("") });
    expect(o).toMatchObject({ type: "denied" });
  });

  it("maps an empty response without other evidence to error", () => {
    expect(classify({ ...base, result: ok("   ") })).toMatchObject({ type: "error", message: expect.stringMatching(/empty response/) });
  });

  it("maps a non-zero exit with no result to error with stderr", () => {
    expect(classify({ ...base, exitCode: 2, stderr: "boom" })).toMatchObject({ type: "error", message: "boom", exitCode: 2 });
  });
});
