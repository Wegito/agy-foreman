import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { git, runCommand } from "./exec.js";
import { globToRegExp } from "./gate.js";
import { parseJUnit, type TestCounts } from "./junit.js";
import {
  changedFiles,
  gitStateChanged,
  snapshotGitState,
  type GitSnapshot,
  type Worktree,
} from "./worktree.js";

export interface VerifyInput {
  wt: Worktree;
  protectedGlobs: string[];
  testCommand: string[];
  testReport?: string;
  baseline?: TestCounts;
  snapshot: GitSnapshot;
  ignoreBranch?: string;
  timeoutMs: number;
}

export interface VerifyReport {
  exitCode: number | null;
  timedOut: boolean;
  passed: boolean;
  counts?: TestCounts;
  newSkips: number;
  fewerTests: boolean;
  protectedRestored: string[];
  tamper: string[];
  auditFlags: string[];
  failures: string[];
  outputTail: string;
}

export const AUDIT_PATTERNS: { flag: string; re: RegExp }[] = [
  { flag: "skip", re: /\.(skip|only)\(|\bxit\(|pytest\.mark\.skip/ },
  { flag: "process-exit", re: /process\.exit\(0\)|os\._exit/ },
  { flag: "lint-disable", re: /eslint-disable|@ts-ignore|# noqa|# type: ignore/ },
];

export async function verify(i: VerifyInput): Promise<VerifyReport> {
  // 1. Restore protected files
  const changed = await changedFiles(i.wt);
  const protectedRegexes = i.protectedGlobs.map(globToRegExp);
  const protectedRestored: string[] = [];

  for (const file of changed) {
    const isProtected = protectedRegexes.some((re) => re.test(file));
    if (isProtected) {
      const checkBase = await runCommand(["git", "cat-file", "-e", `${i.wt.baseSha}:${file}`], {
        cwd: i.wt.path,
      });
      if (checkBase.code === 0) {
        await git(["checkout", i.wt.baseSha, "--", file], i.wt.path);
      } else {
        const fullPath = path.resolve(i.wt.path, file);
        if (existsSync(fullPath)) {
          rmSync(fullPath, { force: true, recursive: true });
        }
      }
      protectedRestored.push(file);
    }
  }

  // 2. Run testCommand in the worktree
  const execRes = await runCommand(i.testCommand, {
    cwd: i.wt.path,
    timeoutMs: i.timeoutMs,
  });
  const exitCode = execRes.code;
  const timedOut = execRes.timedOut;

  // 3. If testReport is set and the file exists, counts = parseJUnit(file)
  let counts: TestCounts | undefined = undefined;
  if (i.testReport) {
    const reportPath = path.resolve(i.wt.path, i.testReport);
    if (existsSync(reportPath)) {
      const xml = readFileSync(reportPath, "utf8");
      counts = parseJUnit(xml);
    }
  }

  // 4. newSkips and fewerTests
  let newSkips = 0;
  let fewerTests = false;
  if (counts !== undefined && i.baseline !== undefined) {
    newSkips = Math.max(0, counts.skipped - i.baseline.skipped);
    fewerTests = counts.tests < i.baseline.tests;
  }

  // 5. tamper check
  const currentSnapshot = await snapshotGitState(i.wt.repoRoot, i.ignoreBranch);
  const tamper = gitStateChanged(i.snapshot, currentSnapshot);

  // 6. auditFlags: scan added lines of git diff <baseSha> (incl. untracked files) in non-protected files
  const foundFlags = new Set<string>();

  // Check tracked files via git diff
  const diffOut = await git(["diff", "-U0", i.wt.baseSha], i.wt.path);
  const diffLines = diffOut.split(/\r?\n/);
  let currentFile: string | null = null;
  let isCurrentProtected = false;

  for (const line of diffLines) {
    const diffMatch = line.match(/^diff --git a\/.* b\/(.*)$/);
    if (diffMatch) {
      currentFile = diffMatch[1];
      isCurrentProtected = protectedRegexes.some((re) => re.test(currentFile!));
      continue;
    }
    if (isCurrentProtected) continue;

    if (line.startsWith("+") && !line.startsWith("+++")) {
      const addedContent = line.slice(1);
      for (const pattern of AUDIT_PATTERNS) {
        if (pattern.re.test(addedContent)) {
          foundFlags.add(pattern.flag);
        }
      }
    }
  }

  // Check untracked files
  const untrackedOut = await git(["ls-files", "--others", "--exclude-standard"], i.wt.path);
  const untrackedFiles = untrackedOut
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const file of untrackedFiles) {
    const relPosix = file.replace(/\\/g, "/");
    if (protectedRegexes.some((re) => re.test(relPosix))) {
      continue;
    }
    const fullPath = path.resolve(i.wt.path, file);
    if (existsSync(fullPath)) {
      const content = readFileSync(fullPath, "utf8");
      for (const line of content.split(/\r?\n/)) {
        for (const pattern of AUDIT_PATTERNS) {
          if (pattern.re.test(line)) {
            foundFlags.add(pattern.flag);
          }
        }
      }
    }
  }

  const auditFlags = Array.from(foundFlags).sort();

  // 7. passed
  const passed =
    exitCode === 0 && !timedOut && newSkips === 0 && !fewerTests && tamper.length === 0;

  // 8. failures and outputTail
  const failures = counts ? counts.failed : [];
  const outputTail = (execRes.stdout + execRes.stderr).slice(-4000);

  return {
    exitCode,
    timedOut,
    passed,
    counts,
    newSkips,
    fewerTests,
    protectedRestored,
    tamper,
    auditFlags,
    failures,
    outputTail,
  };
}
