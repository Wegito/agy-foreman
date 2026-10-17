import { describe, it, expect } from "vitest";
import { FakeApprover, RepoApprover } from "../../src/jobs/approver.js";

describe("RepoApprover", () => {
  const make = () => {
    const elicitation = new FakeApprover({ plan: false, task: false, quota: "wait" });
    const client = new FakeApprover({ plan: true, task: true, quota: "unavailable" });
    const gates: Record<string, "elicitation" | "client"> = { "/a": "elicitation", "/b": "client" };
    const a = new RepoApprover({
      gateFor: (r) => gates[r] ?? "elicitation",
      elicitation,
      client,
      defaultRepoRoot: "/a",
    });
    return { a, elicitation, client, gates };
  };

  it("routes each card by the gate of the card's repo", async () => {
    const { a, elicitation, client } = make();
    expect(await a.plan({ planFile: "p.md", title: "t", steps: [1], repoRoot: "/b" })).toBe(true);
    expect(
      await a.task({ title: "t", kind: "implement", effort: "high", skills: [], repoRoot: "/a" }),
    ).toBe(false);
    expect(client.calls.map((c) => c.kind)).toEqual(["plan"]);
    expect(elicitation.calls.map((c) => c.kind)).toEqual(["task"]);
  });

  it("uses the default repo when a card has none, and re-reads the gate on every card", async () => {
    const { a, elicitation, client, gates } = make();
    expect(await a.quota({ resetText: "5m" })).toBe("wait");
    gates["/a"] = "client";
    expect(await a.quota({ resetText: "5m" })).toBe("unavailable");
    expect(elicitation.calls.length).toBe(1);
    expect(client.calls.length).toBe(1);
  });

  it("answers isClientMode per repo", () => {
    const { a } = make();
    expect(a.isClientMode("/b")).toBe(true);
    expect(a.isClientMode("/a")).toBe(false);
  });
});
