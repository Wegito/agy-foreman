import { describe, it, expect } from "vitest";
import { stateDir, worktreeRoot, jobsDir, expandHome } from "../src/paths.js";

describe("stateDir", () => {
  it("uses LOCALAPPDATA on Windows", () => {
    expect(stateDir({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, home: "C:\\Users\\u" }))
      .toBe("C:\\Users\\u\\AppData\\Local\\agy-orchestrator");
  });
  it("falls back to home\\AppData\\Local on Windows", () => {
    expect(stateDir({ platform: "win32", env: {}, home: "C:\\Users\\u" }))
      .toBe("C:\\Users\\u\\AppData\\Local\\agy-orchestrator");
  });
  it("uses XDG_STATE_HOME on Linux", () => {
    expect(stateDir({ platform: "linux", env: { XDG_STATE_HOME: "/x/state" }, home: "/home/u" }))
      .toBe("/x/state/agy-orchestrator");
  });
  it("falls back to ~/.local/state on Linux", () => {
    expect(stateDir({ platform: "linux", env: {}, home: "/home/u" })).toBe("/home/u/.local/state/agy-orchestrator");
  });
  it("uses Application Support on macOS", () => {
    expect(stateDir({ platform: "darwin", env: {}, home: "/Users/u" }))
      .toBe("/Users/u/Library/Application Support/agy-orchestrator");
  });
});

describe("derived dirs", () => {
  it("nests wt and jobs under the state dir", () => {
    const p = { platform: "linux" as const, env: {}, home: "/home/u" };
    expect(worktreeRoot(p)).toBe("/home/u/.local/state/agy-orchestrator/wt");
    expect(jobsDir(p)).toBe("/home/u/.local/state/agy-orchestrator/jobs");
  });
});

describe("expandHome", () => {
  it("expands a leading ~", () => {
    expect(expandHome("~/.claude/skills", "/home/u")).toBe("/home/u/.claude/skills");
    expect(expandHome(".claude/skills", "/home/u")).toBe(".claude/skills");
  });
});
