import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ledger, type LedgerEntry } from "../../src/jobs/ledger.js";

const e = (o: Partial<LedgerEntry>): LedgerEntry => ({
  jobId: "j",
  kind: "implement",
  state: "passed",
  durationSec: 10,
  returnedTokens: 0,
  at: "2026-10-17T10:00:00Z",
  ...o,
});

describe("Ledger", () => {
  it("appends, reads, and computes medians, calibration and stats", async () => {
    const l = new Ledger(
      path.join(mkdtempSync(path.join(os.tmpdir(), "foreman-led-")), "ledger.jsonl"),
    );
    expect(await l.medianRunSec("implement")).toBeUndefined();
    expect(await l.calibration()).toEqual({ samples: 0 });
    await l.append(
      e({
        runSec: 100,
        estimate: { directTokens: 10000, delegateOverheadTokens: 4000, reason: "" },
        returnedTokens: 6000,
      }),
    );
    await l.append(
      e({
        runSec: 300,
        estimate: { directTokens: 10000, delegateOverheadTokens: 2000, reason: "" },
        returnedTokens: 2000,
        state: "failed",
      }),
    );
    await l.append(
      e({
        runSec: 200,
        kind: "explore",
        returnedTokens: 500,
        usageTotal: 1000,
        at: "2026-10-16T10:00:00Z",
      }),
    );
    expect((await l.entries()).length).toBe(3);
    expect(await l.medianRunSec("implement")).toBe(200);
    expect(await l.medianRunSec("explore")).toBe(200);
    expect(await l.calibration()).toEqual({ samples: 2, ratio: 1.25 });
    expect(await l.stats(new Date("2026-10-17T00:00:00Z"))).toEqual({
      jobs: 2,
      passed: 1,
      tokens: 0,
    });
  });

  it("calibrates per tier only with at least 5 entries of that tier", async () => {
    const mk = () =>
      new Ledger(path.join(mkdtempSync(path.join(os.tmpdir(), "foreman-led-")), "ledger.jsonl"));
    const withEst = (tier: "fast" | "strong", returned: number) =>
      e({
        tier,
        returnedTokens: returned,
        estimate: { directTokens: 1, delegateOverheadTokens: 1000, reason: "" },
      });
    const few = mk();
    for (let n = 0; n < 3; n++) await few.append(withEst("strong", 2000));
    for (let n = 0; n < 10; n++) await few.append(withEst("fast", 1000));
    expect(await few.calibration("strong")).toEqual({ samples: 13, ratio: 1, scope: "all" });

    const enough = mk();
    for (let n = 0; n < 5; n++) await enough.append(withEst("strong", 2000));
    for (let n = 0; n < 10; n++) await enough.append(withEst("fast", 1000));
    expect(await enough.calibration("strong")).toEqual({ samples: 5, ratio: 2, scope: "tier" });
    expect(await enough.calibration()).toMatchObject({ samples: 15 });
    expect(await enough.calibration()).not.toHaveProperty("scope");
  });
});
