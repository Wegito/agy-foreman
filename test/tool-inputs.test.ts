import { describe, it, expect } from "vitest";
import { z } from "zod";
import { actShape, parseActInput, startShape, toStartInput } from "../src/tool-inputs.js";

describe("tool inputs", () => {
  it("maps agy_start arguments, including timeout_sec, to the domain input", () => {
    const args = z.object(startShape).parse({
      kind: "implement",
      task: "x",
      timeout_sec: 120,
      plan: { file: "p.md", step: 2, delegate_steps: [2, 3] },
      contract_tests: [{ path: "a.test.ts", content: "c" }],
      skills: ["s"],
      estimate: { direct_tokens: 1, delegate_overhead_tokens: 2, reason: "r" },
      effort: "low",
      dry_run: true,
      base_ref: "main",
    });
    expect(toStartInput(args, "/def")).toEqual({
      repoRoot: "/def",
      kind: "implement",
      task: "x",
      timeoutSec: 120,
      plan: { file: "p.md", step: 2, delegateSteps: [2, 3] },
      contractTests: [{ path: "a.test.ts", content: "c" }],
      skills: ["s"],
      estimate: { directTokens: 1, delegateOverheadTokens: 2, reason: "r" },
      effort: "low",
      dryRun: true,
      baseRef: "main",
    });
    expect(toStartInput(z.object(startShape).parse({ kind: "explore", task: "y", repo: "/r" }), "/def").repoRoot).toBe("/r");
  });

  it("validates agy_act per action with the existing error texts", () => {
    const parse = (a: object) => parseActInput(z.object(actShape).parse(a));
    expect(parse({ action: "followup", job_id: "t" })).toEqual({
      ok: false,
      error: "action 'followup' requires job_id and feedback",
    });
    expect(parse({ action: "revoke_plan" })).toEqual({
      ok: false,
      error: "action 'revoke_plan' requires plan_file",
    });
    expect(parse({ action: "lesson", text: "x", audience: "implementer" })).toEqual({
      ok: false,
      error: "action 'lesson' requires text, audience, and scope",
    });
    expect(parse({ action: "finalize", job_id: "t", mode: "squash" })).toEqual({
      ok: true,
      value: { action: "finalize", jobId: "t", mode: "squash" },
    });
    expect(
      parse({ action: "lesson", text: "x", audience: "implementer", scope: "project", tags: ["a"], job_id: "t" }),
    ).toEqual({
      ok: true,
      value: { action: "lesson", text: "x", audience: "implementer", scope: "project", tags: ["a"], jobId: "t" },
    });
    expect(parse({ action: "resume_delegation" })).toEqual({ ok: true, value: { action: "resume_delegation" } });
  });
});
