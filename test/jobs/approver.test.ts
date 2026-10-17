import { describe, it, expect } from "vitest";
import {
  planCardText,
  taskCardText,
  quotaCardText,
  ClientModeApprover,
  FakeApprover,
} from "../../src/jobs/approver.js";

describe("card texts", () => {
  it("renders the plan card", () => {
    const t = planCardText({
      planFile: "docs/p.md",
      title: "Foundation",
      steps: [5, 6, 8],
      estimate: { directTokens: 55000, delegateOverheadTokens: 14000, reason: "" },
    });
    expect(t).toContain('Delegate plan "Foundation" to Gemini 3.8 Flash?');
    expect(t).toContain("docs/p.md · steps for Gemini: 5, 6, 8");
    expect(t).toContain("Doing it myself: ~55k tokens · Delegating: ~14k tokens");
  });
  it("renders the task card", () => {
    const t = taskCardText({
      title: "Add rotation",
      kind: "implement",
      effort: "high",
      skills: ["tdd"],
      estimate: {
        directTokens: 18000,
        delegateOverheadTokens: 4200,
        reason: "9-file change",
      },
    });
    expect(t).toContain('Delegate to Gemini 3.8 Flash (high)? "Add rotation" · skills: tdd');
    expect(t).toContain("~18k tokens");
    expect(t).toContain("~4.2k tokens");
    expect(t).toContain("Why: 9-file change");
  });
  it("renders the quota card neutrally", () => {
    const t = quotaCardText({
      resetText: "2h13m",
      resetAt: "2026-10-17T16:40:00",
      pausedJobId: "t-1",
    });
    expect(t).toContain("Gemini quota reached. Resets in 2h13m");
    expect(t).toContain("Task t-1 paused, partial work kept.");
    expect(t).not.toMatch(/account/i);
  });
});

describe("approvers", () => {
  it("client mode approves and cannot show the quota card", async () => {
    const a = new ClientModeApprover();
    expect(await a.plan({ planFile: "p", title: "t", steps: [1] })).toBe(true);
    expect(await a.task({ title: "t", kind: "explore", effort: "low", skills: [] })).toBe(true);
    expect(await a.quota({})).toBe("unavailable");
  });
  it("fake approver records calls", async () => {
    const a = new FakeApprover({ plan: false, quota: "retry" });
    expect(await a.plan({ planFile: "p", title: "t", steps: [1] })).toBe(false);
    expect(await a.task({ title: "t", kind: "explore", effort: "low", skills: [] })).toBe(true);
    expect(await a.quota({})).toBe("retry");
    expect(a.calls.map((c) => c.kind)).toEqual(["plan", "task", "quota"]);
  });
});
