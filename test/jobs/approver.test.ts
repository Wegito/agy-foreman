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
  it("names the chosen model and the strong tier it may also run on", () => {
    const base = {
      title: "T",
      kind: "implement" as const,
      effort: "high",
      skills: [],
      model: "gemini-3.8-flash",
    };
    const LINE =
      "\nMay also run on Gemini 4 Argon (high): if tests fail, for harder steps, or when Gemini quota runs out";
    expect(taskCardText(base)).toMatch(/^Delegate to Gemini 3\.8 Flash \(high\)\? "T"$/);
    const withStrong = {
      ...base,
      alsoRunsOn: { model: "Gemini 4 Argon (high)", ifTestsFail: true },
    };
    expect(taskCardText(withStrong)).toBe(`Delegate to Gemini 3.8 Flash (high)? "T"${LINE}`);
    expect(taskCardText(withStrong)).not.toContain("one retry");
    const plan = {
      planFile: "p.md",
      title: "P",
      steps: [1],
      model: "gemini-3.8-flash",
      alsoRunsOn: { model: "Gemini 4 Argon (high)", ifTestsFail: true },
    };
    expect(planCardText(plan)).toBe(
      `Delegate plan "P" to Gemini 3.8 Flash?\np.md · steps for Gemini: 1${LINE}`,
    );
  });
  it("omits 'if tests fail' when escalation is off", () => {
    const t = taskCardText({
      title: "T",
      kind: "implement",
      effort: "high",
      skills: [],
      model: "gemini-3.8-flash",
      alsoRunsOn: { model: "Gemini 4 Argon (high)", ifTestsFail: false },
    });
    expect(t).toContain(
      "\nMay also run on Gemini 4 Argon (high): for harder steps, or when Gemini quota runs out",
    );
    expect(t).not.toMatch(/if tests fail/i);
  });
  it("has no strong-tier line without a strong tier", () => {
    const plan = planCardText({
      planFile: "p.md",
      title: "P",
      steps: [1],
      model: "gemini-3.8-flash",
    });
    expect(plan).not.toContain("May also run on");
    expect(plan).not.toMatch(/if tests fail/i);
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
    // A pinned clock just before midnight: "now + 60 s" is tomorrow, so it is not "today".
    const now = new Date(2026, 9, 17, 23, 59, 30);
    const soon = new Date(now.getTime() + 20_000);
    const tomorrow = new Date(now.getTime() + 60_000);
    const later = new Date(now.getTime() + 3 * 86_400_000);
    const day = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short" });
    const t = quotaCardText(
      {
        pools: [
          { pool: "Gemini Models", resetAt: soon.toISOString() },
          { pool: "Gemini 4 Argon", resetAt: later.toISOString() },
          { pool: "Claude and GPT models", resetAt: tomorrow.toISOString() },
        ],
      },
      now,
    );
    expect(t).toBe(
      `Quota reached: Gemini Models (resets 23:59), Gemini 4 Argon (resets ${day(later)} 23:59), ` +
        `Claude and GPT models (resets ${day(tomorrow)} 00:00).`,
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
