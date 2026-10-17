import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export interface ResolvedSkill {
  name: string;
  dir: string;
  description: string;
  claudeOnlyRefs: string[];
}

export class SkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillError";
  }
}

function resolveRoot(root: string, repoRoot: string, home: string): string {
  if (root === "~" || root.startsWith("~/") || root.startsWith("~\\")) {
    return path.resolve(home, root.slice(root === "~" ? 1 : 2));
  }
  return path.resolve(repoRoot, root);
}

function isUnder(parent: string, child: string): boolean {
  const p =
    process.platform === "win32" ? path.resolve(parent).toLowerCase() : path.resolve(parent);
  const c = process.platform === "win32" ? path.resolve(child).toLowerCase() : path.resolve(child);
  return c === p || c.startsWith(p + (p.endsWith(path.sep) ? "" : path.sep));
}

function getDirSize(dir: string): number {
  let total = 0;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += getDirSize(full);
    } else if (entry.isFile()) {
      total += statSync(full).size;
    }
  }
  return total;
}

export async function resolveSkills(
  names: string[],
  roots: string[],
  o: { repoRoot: string; home: string },
): Promise<ResolvedSkill[]> {
  const resolvedRoots = roots.map((r) => resolveRoot(r, o.repoRoot, o.home));
  const results: ResolvedSkill[] = [];

  for (const name of names) {
    let skillDir: string;
    let skillName: string;

    if (name.includes("/") || name.includes("\\")) {
      skillDir = resolveRoot(name, o.repoRoot, o.home);
      if (!resolvedRoots.some((r) => isUnder(r, skillDir))) {
        throw new SkillError("skill path escapes skill roots");
      }
      skillName = path.basename(skillDir);
    } else {
      let foundDir: string | null = null;
      for (const root of resolvedRoots) {
        const candidate = path.join(root, name);
        if (existsSync(path.join(candidate, "SKILL.md"))) {
          foundDir = candidate;
          break;
        }
      }
      if (!foundDir) {
        throw new SkillError(`skill not found: ${name}`);
      }
      skillDir = foundDir;
      skillName = name;
    }

    const skillFile = path.join(skillDir, "SKILL.md");
    if (!existsSync(skillFile)) {
      throw new SkillError(`skill not found: ${name}`);
    }

    const size = getDirSize(skillDir);
    if (size > 2 * 1024 * 1024) {
      throw new SkillError("skill too large");
    }

    const content = readFileSync(skillFile, "utf8");
    let description = "";
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch) {
      const descMatch = fmMatch[1].match(/^description:\s*(.*)$/m);
      if (descMatch) {
        description = descMatch[1].trim().replace(/^["']|["']$/g, "");
      }
    }

    const matches =
      content.match(
        /\b(the (?:Edit|Write|Read|Bash|Grep|Glob|Agent|Task) tool|TodoWrite|ToolSearch)\b/g,
      ) ?? [];
    const claudeOnlyRefs = Array.from(new Set(matches));

    results.push({
      name: skillName,
      dir: skillDir,
      description,
      claudeOnlyRefs,
    });
  }

  return results;
}

export async function installSkills(worktree: string, skills: ResolvedSkill[]): Promise<void> {
  for (const s of skills) {
    const dest = path.join(worktree, ".agents", "skills", s.name);
    mkdirSync(dest, { recursive: true });
    cpSync(s.dir, dest, { recursive: true });
  }
}
