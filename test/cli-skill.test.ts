import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main, type Io } from "../src/cli.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const io = (env: NodeJS.ProcessEnv, cwd: string) => {
  const out: string[] = [];
  const i: Io = { out: (s) => out.push(s), err: (s) => out.push(s), env, cwd };
  return { i, out };
};

describe("install-skill", () => {
  const env = { AGYO_SKILL_SRC: path.join(root, "skills", "gemini-delegation") };
  it("installs into the user's ~/.claude/skills by default and refuses twice", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "agyo-home-"));
    const a = io({ ...env, USERPROFILE: home, HOME: home }, os.tmpdir());
    expect(await main(["install-skill"], a.i)).toBe(0);
    const target = path.join(home, ".claude", "skills", "gemini-delegation");
    expect(existsSync(path.join(target, "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(target, "references", "routing.md"))).toBe(true);
    expect(a.out.join("\n")).toContain(`installed: ${target}`);
    const b = io({ ...env, USERPROFILE: home, HOME: home }, os.tmpdir());
    expect(await main(["install-skill"], b.i)).toBe(1);
    expect(b.out.join("\n")).toContain("already installed");
  });
  it("installs into the project with --project", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "agyo-proj-"));
    expect(await main(["install-skill", "--project"], io(env, cwd).i)).toBe(0);
    expect(existsSync(path.join(cwd, ".claude", "skills", "gemini-delegation", "SKILL.md"))).toBe(
      true,
    );
  });
});
