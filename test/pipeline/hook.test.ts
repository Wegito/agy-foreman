import { describe, it, expect, inject } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installGate, HOOK_COMMAND, type GatePolicy } from "../../src/pipeline/gate.js";

function runHook(agentsDir: string, input: string): unknown {
  return JSON.parse(
    execFileSync(process.execPath, ["agyo-hook.mjs"], {
      cwd: agentsDir,
      input,
      encoding: "utf8",
    }),
  );
}

describe("installGate + bundled hook", () => {
  const wt = mkdtempSync(path.join(os.tmpdir(), "agyo-hookwt-"));
  const policy: GatePolicy = {
    mode: "implement",
    worktree: wt,
    readOnlyDirs: [],
    protectedGlobs: ["tests/**"],
    allowedCommands: ["npm test"],
    unknownCommands: "deny",
    allowedMcp: [],
    web: false,
  };

  it("installs hooks.json with the quote-free command, policy and script", async () => {
    await installGate(wt, policy, inject("hookBundle"));
    const hooks = JSON.parse(readFileSync(path.join(wt, ".agents", "hooks.json"), "utf8"));
    expect(hooks["agyo-gate"].PreToolUse[0].hooks[0].command).toBe(HOOK_COMMAND);
    expect(HOOK_COMMAND).toBe("node agyo-hook.mjs");
    expect(
      JSON.parse(readFileSync(path.join(wt, ".agents", "agyo-policy.json"), "utf8")).worktree,
    ).toBe(wt);
  });

  it("decides real tool calls and logs them", () => {
    const dir = path.join(wt, ".agents");
    const call = (name: string, args: object) =>
      JSON.stringify({ toolCall: { name, args }, stepIdx: 1, conversationId: "c" });
    expect(runHook(dir, call("run_command", { CommandLine: "npm test" }))).toEqual({
      decision: "auto_approve",
    });
    expect(
      runHook(dir, call("write_to_file", { TargetFile: path.join(wt, "tests", "x.ts") })),
    ).toMatchObject({ decision: "deny" });
    const log = readFileSync(path.join(dir, "agyo-review.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(log.map((e: { decision: string }) => e.decision)).toEqual(["auto_approve", "deny"]);
    expect(log[1].arg).toContain("x.ts");
  });

  it("fails closed on garbage input", () => {
    expect(runHook(path.join(wt, ".agents"), "not json")).toMatchObject({
      decision: "deny",
      reason: expect.stringMatching(/agyo gate error/),
    });
  });

  it("merges into an existing hooks.json", async () => {
    const wt2 = mkdtempSync(path.join(os.tmpdir(), "agyo-hookwt2-"));
    mkdirSync(path.join(wt2, ".agents"));
    writeFileSync(
      path.join(wt2, ".agents", "hooks.json"),
      JSON.stringify({ "repo-lint": { PostToolUse: [] } }),
    );
    await installGate(wt2, { ...policy, worktree: wt2 }, inject("hookBundle"));
    const hooks = JSON.parse(readFileSync(path.join(wt2, ".agents", "hooks.json"), "utf8"));
    expect(Object.keys(hooks).sort()).toEqual(["agyo-gate", "repo-lint"]);
  });
});
