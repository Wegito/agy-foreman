import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { makeGuard } from "../../src/pipeline/guard.js";
import type { GatePolicy } from "../../src/pipeline/gate.js";
import type { StreamEvent } from "../../src/agy/types.js";

const WT = path.join(os.tmpdir(), "agyo-guard-wt");
const policy: GatePolicy = {
  mode: "implement",
  worktree: WT,
  readOnlyDirs: [],
  protectedGlobs: ["tests/**"],
  allowedCommands: ["npm test"],
  unknownCommands: "deny",
  allowedMcp: [],
  web: false,
};
const tool = (
  state: string,
  toolName: string,
  toolParams: Record<string, unknown>,
): StreamEvent => ({ kind: "step", stepIndex: 1, state, stepType: "tool", toolName, toolParams });

describe("makeGuard", () => {
  const g = makeGuard(policy);
  it("ignores allowed steps, non-tool steps and ACTIVE steps", () => {
    expect(g(tool("DONE", "write_to_file", { TargetFile: path.join(WT, "src/a.ts") }))).toBeNull();
    expect(
      g({ kind: "step", stepIndex: 2, state: "DONE", stepType: "agent_response", textDelta: "x" }),
    ).toBeNull();
    expect(
      g(tool("ACTIVE", "write_to_file", { TargetFile: path.join(WT, "tests/a.ts") })),
    ).toBeNull();
    expect(g({ kind: "init", tools: [] })).toBeNull();
  });
  it("flags executed forbidden actions", () => {
    expect(g(tool("DONE", "write_to_file", { TargetFile: path.join(WT, "tests/a.ts") }))).toMatch(
      /^guard: write_to_file .*tests.*protected/,
    );
    expect(g(tool("DONE", "run_command", { CommandLine: "git push" }))).toMatch(
      /^guard: run_command git push/,
    );
  });
});
