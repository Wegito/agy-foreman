import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseUsage, startQuotaRefresher } from "../src/usage-quota.js";

const NOW = new Date("2026-10-17T14:00:00Z");

describe("parseUsage", () => {
  it("reads the Gemini five-hour and weekly rows and ignores other models", () => {
    const text = [
      "Gemini Models\tFive Hour Limit Remaining\t71%\t2026-10-17T17:23:02Z",
      "Gemini Models\tWeekly Limit Remaining\t88%\t2026-10-20T00:00:00Z",
      "Claude Models\tFive Hour Limit Remaining\t5%\t2026-10-17T15:00:00Z",
    ].join("\n");
    expect(parseUsage(text, NOW)).toEqual({
      fetchedAt: NOW.toISOString(),
      fiveHour: { remaining: 71, resetAt: "2026-10-17T17:23:02Z" },
      weekly: { remaining: 88, resetAt: "2026-10-20T00:00:00Z" },
    });
  });
});

// Regression (found live): the status line started `agy -p /usage` every minute even when idle, and
// each agy call boots the user's agy MCP servers, which flashed console windows on Windows.
describe("startQuotaRefresher", () => {
  const setup = (active: boolean) => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "agyo-quota-")), "quota.json");
    let t = NOW.getTime();
    let calls = 0;
    const r = startQuotaRefresher({
      file,
      isActive: async () => active,
      refresh: async () => {
        calls++;
      },
      now: () => new Date(t),
      everyMs: 3_600_000,
    });
    r.stop();
    return {
      file,
      tick: r.tick,
      calls: () => calls,
      advance: (ms: number) => (t += ms),
    };
  };

  it("never starts agy while no job is active", async () => {
    const s = setup(false);
    await s.tick();
    s.advance(120_000);
    await s.tick();
    expect(s.calls()).toBe(0);
  });

  it("refreshes while a job runs, at most once a minute even when the refresh fails", async () => {
    const s = setup(true);
    await s.tick();
    await s.tick();
    expect(s.calls()).toBe(1);
    s.advance(61_000);
    await s.tick();
    expect(s.calls()).toBe(2);
  });

  it("skips the refresh when the cache is still fresh", async () => {
    const s = setup(true);
    writeFileSync(
      s.file,
      JSON.stringify({ fetchedAt: new Date(NOW.getTime() - 5_000).toISOString() }),
    );
    await s.tick();
    expect(s.calls()).toBe(0);
  });
});
