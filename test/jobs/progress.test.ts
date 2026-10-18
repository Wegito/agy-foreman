import { describe, it, expect } from "vitest";
import { computeProgress, renderProgressLine, PHASE_WEIGHTS } from "../../src/jobs/progress.js";
import { emptyProgress, type JobRecord } from "../../src/jobs/store.js";

describe("computeProgress", () => {
  it("weights sum to 100", () => {
    expect(Object.values(PHASE_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });
  it("uses the checklist inside the run phase", () => {
    expect(
      computeProgress({
        phase: "run",
        checklist: { done: 2, total: 4 },
        elapsedSec: 100,
        runElapsedSec: 80,
      }).percent,
    ).toBe(10 + 37);
  });
  it("falls back to time vs median, capped at 95% of the run phase", () => {
    expect(
      computeProgress({ phase: "run", elapsedSec: 60, runElapsedSec: 50, medianRunSec: 100 })
        .percent,
    ).toBe(10 + 37);
    expect(
      computeProgress({ phase: "run", elapsedSec: 900, runElapsedSec: 800, medianRunSec: 100 })
        .percent,
    ).toBe(10 + 71);
    expect(computeProgress({ phase: "run", elapsedSec: 60, runElapsedSec: 50 }).percent).toBe(10);
  });
  it("handles the edges and ETA", () => {
    expect(computeProgress({ phase: "queued", elapsedSec: 5, runElapsedSec: 0 })).toEqual({
      percent: 0,
    });
    expect(computeProgress({ phase: "done", elapsedSec: 5, runElapsedSec: 0 })).toEqual({
      percent: 100,
    });
    expect(computeProgress({ phase: "verify", elapsedSec: 85, runElapsedSec: 0 })).toEqual({
      percent: 85,
      etaSec: 15,
    });
    expect(
      computeProgress({
        phase: "report",
        checklist: { done: 9, total: 9 },
        elapsedSec: 10,
        runElapsedSec: 0,
      }).percent,
    ).toBeLessThanOrEqual(99);
  });
  it("is monotonic across phases", () => {
    const phases = ["prepare", "contract", "brief", "run", "verify", "report"] as const;
    const ps = phases.map(
      (phase) => computeProgress({ phase, elapsedSec: 10, runElapsedSec: 0 }).percent,
    );
    expect([...ps].sort((a, b) => a - b)).toEqual(ps);
  });
});

describe("renderProgressLine", () => {
  it("shows id, bar, percent, phase, step, file and timing", () => {
    const rec: JobRecord = {
      id: "t-x",
      kind: "implement",
      tier: "fast",
      model: "gemini-3.8-flash",
      repoRoot: "/r",
      title: "t",
      state: "running",
      createdAt: "",
      updatedAt: "",
      returnedChars: 0,
      progress: {
        ...emptyProgress(),
        percent: 64,
        phase: "run",
        checklistDone: 4,
        checklistTotal: 6,
        currentFile: "src/a.ts",
        elapsedSec: 252,
        etaSec: 150,
      },
    };
    const line = renderProgressLine(rec);
    for (const s of ["t-x", "64%", "run", "step 4/6", "src/a.ts", "4m12s"])
      expect(line).toContain(s);
    expect(line).not.toContain("ETA");
    expect(line).toMatch(/[▓░]{20}/);
  });
});
