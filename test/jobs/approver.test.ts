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
      model: "gemini-3.8-flash",
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
      model: "gemini-3.8-flash",
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
  it("names the chosen model and the escalation target on the cards", () => {
    const base = {
      title: "T",
      kind: "implement" as const,
      effort: "high",
      skills: [],
      model: "gemini-4-argon",
    };
    expect(taskCardText(base)).toMatch(/^Delegate to Gemini 4 Argon \(high\)\? "T"/);
    expect(taskCardText(base)).not.toContain("If tests fail");
    expect(taskCardText({ ...base, escalatesTo: "Gemini 4 Argon (high)" })).toContain(
      "If tests fail: one retry on Gemini 4 Argon (high)",
    );
    const plan = {
      planFile: "p.md",
      title: "P",
      steps: [1],
      model: "gemini-4-argon",
      escalatesTo: "Gemini 4 Argon (high)",
    };
    expect(planCardText(plan)).toContain('Delegate plan "P" to Gemini 4 Argon?');
    expect(planCardText(plan)).toContain("If tests fail: one retry on Gemini 4 Argon (high)");
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
  it("lists the pools when the card has them", () => {
    const now = new Date();
    const soon = new Date(now.getTime() + 60_000);
    const hh = soon.getHours().toString().padStart(2, "0");
    const mm = soon.getMinutes().toString().padStart(2, "0");
    const later = new Date(now.getTime() + 3 * 86_400_000);
    const day = later.toLocaleDateString("en-US", { weekday: "short" });
    const t = quotaCardText({
      pools: [
        { pool: "Gemini Models", resetAt: soon.toISOString() },
        { pool: "Gemini 4 Argon", resetAt: later.toISOString() },
      ],
    });
    expect(t).toMatch(
      new RegExp(
        String.raw`^Quota reached: Gemini Models \(resets ${hh}:${mm}\), Gemini 4 Argon \(resets ${day} \d\d:\d\d\)\.`,
      ),
    );
  });
});

describe("approvers", () => {
  it("client mode approves and cannot show the quota card", async () => {
    const a = new ClientModeApprover();
    expect(await a.plan({ planFile: "p", title: "t", steps: [1], model: "gemini-3.8-flash" })).toBe(
      true,
    );
    expect(
      await a.task({
        title: "t",
        kind: "explore",
        effort: "low",
        skills: [],
        model: "gemini-3.8-flash",
      }),
    ).toBe(true);
    expect(await a.quota({})).toBe("unavailable");
  });
  it("fake approver records calls", async () => {
    const a = new FakeApprover({ plan: false, quota: "retry" });
    expect(await a.plan({ planFile: "p", title: "t", steps: [1], model: "gemini-3.8-flash" })).toBe(
      false,
    );
    expect(
      await a.task({
        title: "t",
        kind: "explore",
        effort: "low",
        skills: [],
        model: "gemini-3.8-flash",
      }),
    ).toBe(true);
    expect(await a.quota({})).toBe("retry");
    expect(a.calls.map((c) => c.kind)).toEqual(["plan", "task", "quota"]);
  });
});
