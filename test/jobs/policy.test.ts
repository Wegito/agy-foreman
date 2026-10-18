import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DelegationPolicy, PlanGrants } from "../../src/jobs/policy.js";
import { FlagStore } from "../../src/jobs/flags.js";
import { FakeApprover } from "../../src/jobs/approver.js";

const NOW = new Date("2026-10-17T12:00:00Z");
const TIERS = { fast: "gemini-3.8-flash" } as const;
const BOTH = { fast: "gemini-3.8-flash", strong: "gemini-4-argon" };
const flags = () =>
  new FlagStore(path.join(mkdtempSync(path.join(os.tmpdir(), "foreman-pol-")), "f.json"));

describe("PlanGrants", () => {
  it("covers the granted steps of the same plan file in the same repo, with the same content", async () => {
    let now = NOW;
    const g = new PlanGrants(flags(), () => now);
    const repoA = path.resolve("/repoA");
    const repoB = path.resolve("/repoB");
    await g.grant(repoA, "docs/plan.md", "v1", [1, 3]);
    expect(await g.covers(repoA, "docs/plan.md", "v1", 1)).toBe(true);
    expect(await g.covers(repoA, path.join(repoA, "docs", "plan.md"), "v1", 3)).toBe(true);
    expect(await g.covers(repoA, "docs/plan.md", "v1", 2)).toBe(false);
    expect(await g.covers(repoB, "docs/plan.md", "v1", 1)).toBe(false);
    expect(await g.covers(repoA, "docs/plan.md", "v2", 1)).toBe(false);
    now = new Date(NOW.getTime() + 25 * 3600_000);
    expect(await g.covers(repoA, "docs/plan.md", "v1", 1)).toBe(false);
  });

  it("treats an empty step list as the whole plan and revokes by relative path", async () => {
    const g = new PlanGrants(flags(), () => NOW);
    const repo = path.resolve("/repoA");
    await g.grant(repo, "docs/plan.md", "v1", []);
    await g.grant(repo, "docs/plan.md", "v1", [2]);
    expect(await g.covers(repo, "docs/plan.md", "v1", 7)).toBe(true);
    expect(await g.revoke(repo, "docs/plan.md")).toBe(2);
    expect(await g.covers(repo, "docs/plan.md", "v1", 7)).toBe(false);
  });
});

describe("DelegationPolicy", () => {
  it("refuses while paused and allows again after resume", async () => {
    const f = flags();
    await f.update((x) => ({ ...x, delegationPaused: true }));
    const p = new DelegationPolicy(f, new FakeApprover(), () => NOW);
    const r = await p.check("/r", TIERS, "fast");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.result).toMatchObject({
      state: "refused",
      reason: expect.stringMatching(/paused/),
    });
    await p.resume();
    expect(await p.check("/r", TIERS, "fast")).toMatchObject({
      ok: true,
      tier: "fast",
      model: "gemini-3.8-flash",
    });
    expect((await p.state()).delegation).toBe("active");
  });

  it("records a cooldown of at least 60 s after a quota stop and applies the choice", async () => {
    const f = flags();
    const p = new DelegationPolicy(f, new FakeApprover({ quota: "wait" }), () => NOW);
    expect(await p.onQuota({ resetInSec: 10, resetText: "10s", pausedJobId: "t-1" })).toBe("wait");
    const s = await p.state();
    expect(s.cooldowns).toEqual([
      {
        pool: "Gemini Models",
        until: new Date(NOW.getTime() + 60_000).toISOString(),
        resetText: "10s",
      },
    ]);
    const r = await p.check("/r", TIERS, "fast");
    expect(!r.ok && r.result).toMatchObject({
      state: "quota",
      options: ["retry", "continue_without", "wait"],
    });
  });

  it("retry clears the cooldown; continue_without pauses delegation", async () => {
    const f = flags();
    await f.update((x) => ({
      ...x,
      cooldowns: {
        "Gemini Models": { until: new Date(NOW.getTime() + 600_000).toISOString(), text: "10m" },
      },
    }));
    expect(
      await new DelegationPolicy(f, new FakeApprover({ quota: "retry" }), () => NOW).check(
        "/r",
        TIERS,
        "fast",
      ),
    ).toMatchObject({ ok: true, tier: "fast" });
    expect(
      (await new DelegationPolicy(f, new FakeApprover(), () => NOW).state()).cooldowns,
    ).toEqual([]);

    await f.update((x) => ({
      ...x,
      cooldowns: { "Gemini Models": { until: new Date(NOW.getTime() + 600_000).toISOString() } },
    }));
    const p = new DelegationPolicy(f, new FakeApprover({ quota: "continue_without" }), () => NOW);
    const r = await p.check("/r", TIERS, "fast");
    expect(!r.ok && r.result).toMatchObject({
      state: "refused",
      reason: "continue without Gemini",
    });
    expect((await p.state()).delegation).toBe("paused");
  });

  it("picks fast, then moves up to strong when Gemini Models is cooling, never down", async () => {
    const p = new DelegationPolicy(flags(), new FakeApprover(), () => NOW);
    expect(await p.pickTier(BOTH, "fast")).toEqual({ tier: "fast", model: "gemini-3.8-flash" });
    await p.markCooling("Gemini Models", 600);
    expect(await p.pickTier(BOTH, "fast")).toEqual({ tier: "strong", model: "gemini-4-argon" });
    await p.markCooling("Gemini 4 Argon", 600);
    expect(await p.pickTier(BOTH, "fast")).toBeUndefined();
  });

  it("does not fall back to fast when strong was requested and Argon is cooling", async () => {
    const p = new DelegationPolicy(flags(), new FakeApprover(), () => NOW);
    await p.markCooling("Gemini 4 Argon", 600);
    expect(await p.pickTier(BOTH, "strong")).toBeUndefined();
  });

  it("check runs on a higher tier with a note, and shows the card only when none is free", async () => {
    const a = new FakeApprover({ quota: "wait" });
    const p = new DelegationPolicy(flags(), a, () => NOW);
    await p.markCooling("Gemini Models", 600);
    const r = await p.check("/r", BOTH, "fast");
    expect(r).toEqual({
      ok: true,
      tier: "strong",
      model: "gemini-4-argon",
      note: "Gemini Models is cooling down; running on strong (gemini-4-argon)",
    });
    expect(a.calls).toHaveLength(0);
    await p.markCooling("Gemini 4 Argon", 600);
    const r2 = await p.check("/r", BOTH, "fast");
    expect(!r2.ok && r2.result).toMatchObject({ state: "quota" });
    const card = a.calls[0].card as { pools?: { pool: string; resetAt: string }[] };
    expect(card.pools?.map((x) => x.pool).sort()).toEqual(["Gemini 4 Argon", "Gemini Models"]);
  });

  it("onQuota marks the given pool, and retry clears every pool", async () => {
    const f = flags();
    const p = new DelegationPolicy(f, new FakeApprover({ quota: "wait" }), () => NOW);
    await p.onQuota({ resetInSec: 600, pool: "Gemini 4 Argon" });
    await p.markCooling("Gemini Models", 600);
    expect((await p.state()).cooldowns.map((c) => c.pool).sort()).toEqual([
      "Gemini 4 Argon",
      "Gemini Models",
    ]);
    await p.choose("retry");
    expect((await p.state()).cooldowns).toEqual([]);
  });

  it("refuses, never substituting fast, when the requested tier is not configured", async () => {
    const p = new DelegationPolicy(flags(), new FakeApprover(), () => NOW);
    const r = await p.check("/r", TIERS, "strong");
    expect(!r.ok && r.result).toEqual({
      state: "refused",
      reason: "no strong tier configured (set models.strong in .agy-foreman.json)",
    });
  });

  it("pickFrom uses the given snapshot and time, not live state", () => {
    const p = new DelegationPolicy(flags(), new FakeApprover(), () => NOW);
    const until = new Date(NOW.getTime() + 600_000).toISOString();
    const snap = { delegationPaused: false, grants: [], cooldowns: { "Gemini Models": { until } } };
    expect(p.pickFrom(snap, BOTH, "fast", NOW.getTime())?.tier).toBe("strong");
    expect(p.pickFrom(snap, BOTH, "fast", NOW.getTime() + 700_000)?.tier).toBe("fast");
  });

  it("does not throw when a cooldown expires between the flags read and the pick", async () => {
    const f = flags();
    const until = new Date(NOW.getTime() + 1000).toISOString();
    await f.update((x) => {
      x.cooldowns = { "Gemini Models": { until } };
    });
    let calls = 0;
    // The clock jumps past the cooldown after the first reading.
    const now = () => new Date(NOW.getTime() + (calls++ > 0 ? 5000 : 0));
    const r = await new DelegationPolicy(f, new FakeApprover({ quota: "wait" }), now).check(
      "/r",
      TIERS,
      "fast",
    );
    expect(!r.ok && r.result).toMatchObject({ state: "quota" });
  });
});
