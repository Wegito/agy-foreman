import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DelegationPolicy, PlanGrants } from "../../src/jobs/policy.js";
import { FlagStore } from "../../src/jobs/flags.js";
import { FakeApprover } from "../../src/jobs/approver.js";

const NOW = new Date("2026-10-17T12:00:00Z");
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
    const r = await p.check("/r");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.result).toMatchObject({
      state: "refused",
      reason: expect.stringMatching(/paused/),
    });
    await p.resume();
    expect(await p.check("/r")).toEqual({ ok: true });
    expect((await p.state()).delegation).toBe("active");
  });

  it("records a cooldown of at least 60 s after a quota stop and applies the choice", async () => {
    const f = flags();
    const p = new DelegationPolicy(f, new FakeApprover({ quota: "wait" }), () => NOW);
    expect(await p.onQuota({ resetInSec: 10, resetText: "10s", pausedJobId: "t-1" })).toBe("wait");
    const s = await p.state();
    expect(s.cooldown).toEqual({
      until: new Date(NOW.getTime() + 60_000).toISOString(),
      resetText: "10s",
    });
    const r = await p.check("/r");
    expect(!r.ok && r.result).toMatchObject({
      state: "quota",
      options: ["retry", "continue_without", "wait"],
    });
  });

  it("retry clears the cooldown; continue_without pauses delegation", async () => {
    const f = flags();
    await f.update((x) => ({
      ...x,
      cooldownUntil: new Date(NOW.getTime() + 600_000).toISOString(),
      cooldownText: "10m",
    }));
    expect(
      await new DelegationPolicy(f, new FakeApprover({ quota: "retry" }), () => NOW).check("/r"),
    ).toEqual({ ok: true });
    expect(
      (await new DelegationPolicy(f, new FakeApprover(), () => NOW).state()).cooldown,
    ).toBeUndefined();

    await f.update((x) => ({
      ...x,
      cooldownUntil: new Date(NOW.getTime() + 600_000).toISOString(),
    }));
    const p = new DelegationPolicy(f, new FakeApprover({ quota: "continue_without" }), () => NOW);
    const r = await p.check("/r");
    expect(!r.ok && r.result).toMatchObject({
      state: "refused",
      reason: "continue without Gemini",
    });
    expect((await p.state()).delegation).toBe("paused");
  });
});
