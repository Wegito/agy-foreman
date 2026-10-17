import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSkills, installSkills, SkillError } from "../../src/pipeline/skills.js";

function skill(root: string, name: string, body = "Use the Edit tool to change files.") {
  mkdirSync(path.join(root, name), { recursive: true });
  writeFileSync(
    path.join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: Does ${name} things\n---\n\n${body}\n`,
  );
}

describe("skills", () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "agyo-skrepo-"));
  const home = mkdtempSync(path.join(os.tmpdir(), "agyo-skhome-"));
  skill(path.join(repo, ".claude/skills"), "tdd");
  skill(path.join(home, ".claude/skills"), "tdd", "home version");
  skill(path.join(home, ".claude/skills"), "fastapi", "plain");
  const roots = [".agents/skills", ".claude/skills", "~/.claude/skills"];

  it("resolves by name in root order and reads the description", async () => {
    const [tdd, fa] = await resolveSkills(["tdd", "fastapi"], roots, { repoRoot: repo, home });
    expect(tdd.dir).toBe(path.join(repo, ".claude/skills", "tdd"));
    expect(tdd.description).toBe("Does tdd things");
    expect(tdd.claudeOnlyRefs).toEqual(["the Edit tool"]);
    expect(fa.dir).toBe(path.join(home, ".claude/skills", "fastapi"));
    expect(fa.claudeOnlyRefs).toEqual([]);
  });

  it("accepts explicit paths inside a root and rejects escapes and unknown names", async () => {
    const [s] = await resolveSkills(["~/.claude/skills/fastapi"], roots, { repoRoot: repo, home });
    expect(s.name).toBe("fastapi");
    const outside = mkdtempSync(path.join(os.tmpdir(), "agyo-out-"));
    skill(outside, "evil");
    await expect(
      resolveSkills([path.join(outside, "evil")], roots, { repoRoot: repo, home }),
    ).rejects.toThrow(SkillError);
    await expect(resolveSkills(["nope"], roots, { repoRoot: repo, home })).rejects.toThrow(
      /skill not found: nope/,
    );
  });

  it("installs into .agents/skills of the worktree", async () => {
    const wt = mkdtempSync(path.join(os.tmpdir(), "agyo-skwt-"));
    await installSkills(wt, await resolveSkills(["tdd"], roots, { repoRoot: repo, home }));
    expect(existsSync(path.join(wt, ".agents", "skills", "tdd", "SKILL.md"))).toBe(true);
  });
});
