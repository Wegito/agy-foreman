// Execution pipeline for implement jobs (contract tests, worktree, gate, verification).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { StreamEvent } from "../agy/types.js";
import { renderBrief, renderProgress, RUN_PROMPT, type BriefInput } from "./brief.js";
import { addContractTests, redCheck } from "./contract.js";
import { git, runCommand } from "./exec.js";
import { installGate, type GatePolicy } from "./gate.js";
import { makeGuard } from "./guard.js";
import { parseJUnit, type TestCounts } from "./junit.js";
import { installSkills, resolveSkills, SkillError, type ResolvedSkill } from "./skills.js";
import { verify, type VerifyReport } from "./verify.js";
import {
  commitAll,
  createWorktree,
  diffStat,
  excludeInRepo,
  mergeCheck,
  repoHash,
  snapshotGitState,
} from "./worktree.js";
import type { Envelope, JobSpec, JobState, PipelineDeps } from "./index.js";
import {
  fenceUntrusted,
  getDeniedCommands,
  makeUntrustedReport,
  mapFailureOutcome,
} from "./envelope-build.js";

export async function runImplementJob(
  spec: JobSpec,
  deps: PipelineDeps,
  startTime: Date,
): Promise<Envelope> {
  // 1. prepare
  deps.onPhase?.("prepare");
  if (!spec.config.testCommand || spec.config.testCommand.length === 0) {
    const durationSec = (deps.now().getTime() - startTime.getTime()) / 1000;
    const nonce = randomBytes(4).toString("hex");
    let baseSha = "";
    try {
      baseSha = await git(["rev-parse", `${spec.baseRef ?? "HEAD"}^{commit}`], spec.repoRoot);
    } catch {
      baseSha = "";
    }
    return {
      jobId: spec.jobId,
      kind: "implement",
      state: "refused",
      reason: "config.test_command is required for implement jobs",
      branch: `agy/${spec.jobId}`,
      worktreePath: path.join(deps.worktreeRoot, repoHash(spec.repoRoot), spec.jobId),
      baseSha,
      untrustedReport: fenceUntrusted("", nonce),
      deniedCommands: [],
      guardEvents: [],
      skillsUsed: [],
      model: spec.config.model,
      conversationId: spec.conversationId,
      durationSec,
    };
  }

  const wt = await createWorktree({
    repoRoot: spec.repoRoot,
    jobId: spec.jobId,
    root: deps.worktreeRoot,
    baseRef: spec.baseRef,
  });

  await excludeInRepo(spec.repoRoot, [".agents/", ".agy-task/"]);
  const snapshot = await snapshotGitState(spec.repoRoot, wt.branch ?? undefined);

  // A fresh worktree has no dependencies (node_modules, venv…): install them before any test run.
  if (spec.config.setupCommand) {
    const setup = await runCommand(spec.config.setupCommand, {
      cwd: wt.path,
      timeoutMs: 15 * 60_000,
    });
    if (setup.code !== 0 || setup.timedOut) {
      const tail = (setup.stdout + setup.stderr).slice(-1500).trim();
      return {
        jobId: spec.jobId,
        kind: "implement",
        state: "error",
        reason: `setup_command failed (${setup.timedOut ? "timed out" : `exit ${setup.code}`}): ${tail}`,
        branch: wt.branch,
        worktreePath: wt.path,
        baseSha: wt.baseSha,
        untrustedReport: fenceUntrusted("", randomBytes(4).toString("hex")),
        deniedCommands: [],
        guardEvents: [],
        skillsUsed: [],
        model: spec.config.model,
        durationSec: (deps.now().getTime() - startTime.getTime()) / 1000,
      };
    }
  }

  // 2. contract
  deps.onPhase?.("contract");
  let contractInfo: { redOnBase: boolean; greenAfter: boolean } | undefined = undefined;
  const startSha = wt.baseSha;

  if (spec.contractTests && spec.contractTests.length > 0) {
    await addContractTests(wt, spec.contractTests);
    const { red } = await redCheck(wt, spec.config.testCommand, spec.timeoutSec * 1000);
    if (!red) {
      const durationSec = (deps.now().getTime() - startTime.getTime()) / 1000;
      const nonce = randomBytes(4).toString("hex");
      return {
        jobId: spec.jobId,
        kind: "implement",
        state: "refused",
        reason: "contract tests already pass on base",
        branch: wt.branch,
        worktreePath: wt.path,
        baseSha: wt.baseSha,
        contract: { redOnBase: false, greenAfter: false },
        untrustedReport: fenceUntrusted("", nonce),
        deniedCommands: [],
        guardEvents: [],
        skillsUsed: [],
        model: spec.config.model,
        conversationId: spec.conversationId,
        durationSec,
      };
    }
    contractInfo = { redOnBase: true, greenAfter: false };
  }

  let baseline: TestCounts | undefined = undefined;
  if (spec.config.testReport) {
    const reportPath = path.resolve(wt.path, spec.config.testReport);
    if (!existsSync(reportPath)) {
      await runCommand(spec.config.testCommand, {
        cwd: wt.path,
        timeoutMs: spec.timeoutSec * 1000,
      });
    }
    if (existsSync(reportPath)) {
      try {
        baseline = parseJUnit(readFileSync(reportPath, "utf8"));
      } catch {
        // ignore malformed report
      }
    }
  }

  // 3. brief
  deps.onPhase?.("brief");
  let resolvedSkills: ResolvedSkill[] = [];
  let skillsUsed: string[] = [];
  if (spec.skills && spec.skills.length > 0) {
    try {
      resolvedSkills = await resolveSkills(spec.skills, spec.config.skillRoots, {
        repoRoot: spec.repoRoot,
        home: deps.home,
      });
      await installSkills(wt.path, resolvedSkills);
      skillsUsed = resolvedSkills.map((s) => s.name);
    } catch (err: unknown) {
      if (err instanceof SkillError || (err && (err as Error).name === "SkillError")) {
        const durationSec = (deps.now().getTime() - startTime.getTime()) / 1000;
        const nonce = randomBytes(4).toString("hex");
        return {
          jobId: spec.jobId,
          kind: "implement",
          state: "refused",
          reason: (err as Error).message,
          branch: wt.branch,
          worktreePath: wt.path,
          baseSha: wt.baseSha,
          contract: contractInfo,
          untrustedReport: fenceUntrusted("", nonce),
          deniedCommands: [],
          guardEvents: [],
          skillsUsed: [],
          model: spec.config.model,
          conversationId: spec.conversationId,
          durationSec,
        };
      }
      throw err;
    }
  }

  mkdirSync(path.join(wt.path, ".agy-task"), { recursive: true });
  const briefInput: BriefInput = {
    kind: "implement",
    task: spec.task,
    date: deps.now().toISOString().slice(0, 10),
    touch: spec.touch,
    leaveUntouched: spec.leaveUntouched,
    testCommand: spec.config.testCommand,
    skills: resolvedSkills.map((s) => ({ name: s.name, description: s.description })),
    lessons: spec.lessons,
    checklist: spec.checklist,
  };
  writeFileSync(path.join(wt.path, ".agy-task", "brief.md"), renderBrief(briefInput), "utf8");

  if (spec.checklist && spec.checklist.length > 0) {
    writeFileSync(
      path.join(wt.path, ".agy-task", "progress.md"),
      renderProgress(spec.checklist),
      "utf8",
    );
  }

  const contractPaths = (spec.contractTests ?? []).map((t) => t.path.replace(/\\/g, "/"));
  const allowedCommands: string[] = [];
  if (spec.config.testCommand) {
    allowedCommands.push(spec.config.testCommand.join(" "));
  }
  if (spec.config.setupCommand) {
    allowedCommands.push(spec.config.setupCommand.join(" "));
  }
  for (const c of spec.config.allowedCommands) {
    allowedCommands.push(c);
  }

  const policy: GatePolicy = {
    mode: "implement",
    worktree: wt.path,
    readOnlyDirs: [],
    protectedGlobs: [...spec.config.protectedPaths, ...contractPaths],
    allowedCommands,
    unknownCommands: spec.config.unknownCommands,
    allowedMcp: spec.config.allowedMcp,
    web: spec.config.web,
  };

  await installGate(wt.path, policy, deps.hookBundlePath);

  // 4. run
  deps.onPhase?.("run");
  const guardEvents: string[] = [];
  const rawGuard = makeGuard(policy);
  const guard = (ev: StreamEvent): string | null => {
    const g = rawGuard(ev);
    if (g) guardEvents.push(g);
    return g;
  };

  const outcome = await deps.agyRun(
    {
      prompt: RUN_PROMPT,
      cwd: wt.path,
      model: spec.config.model,
      effort: spec.effort ?? spec.config.effort,
      mode: "accept-edits",
      timeoutSec: spec.timeoutSec,
      conversationId: spec.conversationId,
      agy: deps.agyCommand,
      skipPermissions: false,
      sandbox: spec.runtime.sandbox,
      signal: deps.signal,
      guard,
    },
    (ev) => deps.onEvent?.(ev),
  );

  let jobState: JobState;
  let jobReason: string | undefined;
  let quotaData: { resetInSec?: number; resetText?: string } | undefined;
  let verifyReport: VerifyReport | undefined;

  const failure = mapFailureOutcome(outcome, guardEvents);
  if (failure) {
    jobState = failure.jobState;
    jobReason = failure.jobReason;
    quotaData = failure.quotaData;
  } else {
    // 5. verify (on success only)
    deps.onPhase?.("verify");
    verifyReport = await verify({
      wt,
      protectedGlobs: [...spec.config.protectedPaths, ...contractPaths],
      testCommand: spec.config.testCommand,
      testReport: spec.config.testReport,
      baseline,
      snapshot,
      ignoreBranch: wt.branch ?? undefined,
      timeoutMs: spec.timeoutSec * 1000,
      startSha,
    });
    if (contractInfo) {
      contractInfo.greenAfter = verifyReport.passed;
    }
    jobState = verifyReport.passed ? "passed" : "failed";
  }

  // 6. report
  deps.onPhase?.("report");
  const taskFirstLine = spec.task.trim().split(/\r?\n/)[0] ?? "";
  let headSha: string | undefined = undefined;
  try {
    const commitSha = await commitAll(wt, "agy: " + taskFirstLine);
    headSha = commitSha ?? (await git(["rev-parse", "HEAD"], wt.path));
  } catch {
    try {
      headSha = await git(["rev-parse", "HEAD"], wt.path);
    } catch {
      headSha = undefined;
    }
  }

  let stat: string | undefined = undefined;
  try {
    stat = await diffStat(wt);
  } catch {
    stat = undefined;
  }

  let mergeResult: { clean: boolean; conflictingFiles: string[] } | undefined = undefined;
  if (wt.branch) {
    try {
      const currentBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"], spec.repoRoot);
      mergeResult = await mergeCheck(spec.repoRoot, currentBranch, wt.branch);
    } catch {
      mergeResult = undefined;
    }
  }

  const deniedCommands = getDeniedCommands(wt.path);
  const untrustedReport = makeUntrustedReport(outcome);
  const durationSec = (deps.now().getTime() - startTime.getTime()) / 1000;

  return {
    jobId: spec.jobId,
    kind: "implement",
    state: jobState,
    ...(jobReason ? { reason: jobReason } : {}),
    branch: wt.branch,
    worktreePath: wt.path,
    baseSha: wt.baseSha,
    ...(headSha ? { headSha } : {}),
    ...(mergeResult ? { mergeCheck: mergeResult } : {}),
    ...(contractInfo ? { contract: contractInfo } : {}),
    ...(verifyReport ? { verify: verifyReport } : {}),
    ...(stat !== undefined ? { diffStat: stat } : {}),
    untrustedReport,
    deniedCommands,
    guardEvents,
    skillsUsed,
    ...(quotaData ? { quota: quotaData } : {}),
    model: spec.config.model,
    ...(outcome.conversationId || spec.conversationId
      ? { conversationId: outcome.conversationId ?? spec.conversationId }
      : {}),
    ...(outcome.type === "success" ? { usage: outcome.usage } : {}),
    durationSec,
  };
}
