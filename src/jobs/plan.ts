// Plan files: Superpowers plans (`### Task 3: Title`) and OpenSpec changes (`tasks.md` with
// `## 3. Title` sections of `- [ ] 3.1 ...` items, plus proposal.md, design.md and specs/ beside it).
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface PlanStep {
  step: number;
  title: string;
  text: string;
  files: string[];
  testBlocks: { path: string; content: string }[];
  /** Open checkbox items in the step (OpenSpec `- [ ] 3.1 ...`), used as the progress checklist. */
  items: string[];
}

/** The `# Title`, or the change name for an OpenSpec tasks.md (which has no title). */
export function planTitle(markdown: string, file?: string): string {
  const match = markdown.match(/^#\s+(.*)$/m);
  if (match) return match[1].trim();
  return file ? (openSpecChange(file) ?? "") : "";
}

/** The change name when `file` is `.../openspec/changes/<name>/tasks.md`. */
export function openSpecChange(file: string): string | undefined {
  const parts = path.resolve(file).split(path.sep);
  const n = parts.length;
  return n >= 4 &&
    parts[n - 1] === "tasks.md" &&
    parts[n - 3] === "changes" &&
    parts[n - 4] === "openspec"
    ? parts[n - 2]
    : undefined;
}

const CONTEXT_MAX_CHARS = 24_000;

/**
 * For an OpenSpec tasks.md: the change's proposal, design and spec deltas, inlined because an
 * uncommitted change folder does not exist in the job's worktree. Empty for other plans.
 */
export async function openSpecContext(planPath: string): Promise<string> {
  const name = openSpecChange(planPath);
  if (!name) return "";
  const dir = path.dirname(planPath);
  const files = ["proposal.md", "design.md"];
  try {
    const walk = async (rel: string): Promise<void> => {
      for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
        const r = path.posix.join(rel, e.name);
        if (e.isDirectory()) await walk(r);
        else if (e.name.endsWith(".md")) files.push(r);
      }
    };
    await walk("specs");
  } catch {
    // no specs folder
  }
  let out = "";
  for (const f of files) {
    let body: string;
    try {
      body = await readFile(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    const block = `\n\n### openspec/changes/${name}/${f}\n\n${body.trim()}`;
    if (out.length + block.length > CONTEXT_MAX_CHARS) {
      out += `\n\n(${f} and later files omitted: context limit)`;
      break;
    }
    out += block;
  }
  return out ? `\n\n## Context: OpenSpec change "${name}"${out}` : "";
}

export function parsePlanStep(markdown: string, step: number): PlanStep {
  const lines = markdown.split(/\r?\n/);
  // `### Task 3: Title` or `## 3. Title`; never `## 3.1 Title`.
  const stepRegex = new RegExp(`^(#{2,4})\\s+(?:Task\\s+)?${step}[:.](?:\\s+(.*))?$`);

  let startLineIdx = -1;
  let headingLevel = 0;
  let title = "";

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(stepRegex);
    if (match) {
      headingLevel = match[1].length;
      title = (match[2] ?? "").trim();
      startLineIdx = i;
      break;
    }
  }

  if (startLineIdx === -1) {
    throw new Error(`step ${step} not found`);
  }

  let endLineIdx = lines.length;
  const nextHeadingRegex = new RegExp(`^#{1,${headingLevel}}\\s+`);
  for (let i = startLineIdx + 1; i < lines.length; i++) {
    if (nextHeadingRegex.test(lines[i])) {
      endLineIdx = i;
      break;
    }
  }

  const sectionLines = lines.slice(startLineIdx, endLineIdx);
  const text = sectionLines.join("\n");

  const files: string[] = [];
  const fileLineRegex = /^\s*(?:-\s*(?:Create|Modify|Test):|\*\*Files:\*\*)/;

  for (const line of sectionLines) {
    if (fileLineRegex.test(line)) {
      const backticks = Array.from(line.matchAll(/`([^`]+)`/g)).map((m) => m[1]);
      for (const bt of backticks) {
        const parts = bt.split(",").map((p) => p.trim());
        for (const part of parts) {
          const cleaned = part.replace(/:\d+(?:-\d+)?$/, "").trim();
          if (cleaned && !files.includes(cleaned)) {
            files.push(cleaned);
          }
        }
      }
    }
  }

  const testBlocks: { path: string; content: string }[] = [];
  let inFence = false;
  let fenceContentLines: string[] = [];
  let fenceTestPath: string | null = null;

  for (let i = 0; i < sectionLines.length; i++) {
    const line = sectionLines[i];
    if (!inFence) {
      if (/^```.*$/.test(line)) {
        inFence = true;
        fenceContentLines = [];
        fenceTestPath = null;

        for (let j = i - 1; j >= 0; j--) {
          const prevLine = sectionLines[j].trim();
          if (prevLine.length > 0) {
            const backticks = Array.from(prevLine.matchAll(/`([^`]+)`/g)).map((m) => m[1]);
            for (const bt of backticks) {
              const base = path.basename(bt);
              if (/(\.test\.|\.spec\.|_test\.|^test_)/.test(base)) {
                fenceTestPath = bt;
                break;
              }
            }
            break;
          }
        }
      }
    } else {
      if (/^```\s*$/.test(line)) {
        inFence = false;
        if (fenceTestPath !== null) {
          testBlocks.push({
            path: fenceTestPath,
            content: fenceContentLines.join("\n") + "\n",
          });
        }
      } else {
        fenceContentLines.push(line);
      }
    }
  }

  const items = sectionLines
    .map((l) => /^\s*[-*]\s+\[ \]\s+(.+)$/.exec(l)?.[1].trim())
    .filter((x): x is string => !!x);

  return {
    step,
    title,
    text,
    files,
    testBlocks,
    items,
  };
}
