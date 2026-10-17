import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { git, runCommand, type ExecResult } from "./exec.js";
import type { Worktree } from "./worktree.js";

export interface ContractTest {
  path: string;
  content: string;
}

export async function addContractTests(wt: Worktree, tests: ContractTest[]): Promise<string> {
  for (const t of tests) {
    if (path.isAbsolute(t.path)) {
      throw new Error("contract test path escapes worktree");
    }
    const fullPath = path.resolve(wt.path, t.path);
    const root = path.resolve(wt.path);
    const rel = path.relative(root, fullPath);
    if (rel.startsWith("..") || path.isAbsolute(rel) || rel === "") {
      throw new Error("contract test path escapes worktree");
    }
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, t.content, "utf8");
  }

  await git(["add", "-A"], wt.path);
  await git(["commit", "-m", "agy: contract tests"], wt.path);
  const newSha = await git(["rev-parse", "HEAD"], wt.path);
  wt.baseSha = newSha;
  return newSha;
}

export async function redCheck(
  wt: Worktree,
  testCommand: string[],
  timeoutMs: number,
): Promise<{ red: boolean; result: ExecResult }> {
  const result = await runCommand(testCommand, { cwd: wt.path, timeoutMs });
  const red = result.timedOut || result.code !== 0;
  return { red, result };
}
