import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { run, RunRequest } from "../agy/index.js";
import type { AgyUsage, Outcome, StreamEvent } from "../agy/types.js";
import type { Effort, ProjectConfig, RuntimeConfig } from "../config.js";
import {
  renderBrief,
  renderProgress,
  RUN_PROMPT,
  EXPLORE_SCHEMA,
  type BriefInput,
} from "./brief.js";
import { addContractTests, redCheck, type ContractTest } from "./contract.js";
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
  removeWorktree,
  repoHash,
  snapshotGitState,
  type GitSnapshot,
  type Worktree,
} from "./worktree.js";

export type JobState =
  "passed" | "failed" | "refused" | "quota" | "timeout" | "cancelled" | "error" | "guard_violation";

export interface JobSpec {
  jobId: string;
  kind: "implement" | "explore";
  repoRoot: string;
  task: string;
  contractTests?: ContractTest[];
  skills?: string[];
  lessons?: string[];
  checklist?: string[];
  touch?: string[];
  leaveUntouched?: string[];
  effort?: Effort;
  baseRef?: string;
  timeoutSec: number;
  conversationId?: string;
  config: ProjectConfig;
  runtime: RuntimeConfig;
}

export interface PipelineDeps {
  agyRun: typeof run;
  agyCommand: { command: string; prefixArgs?: string[] };
  hookBundlePath: string;
  worktreeRoot: string;
  home: string;
  now: () => Date;
  onEvent?: (ev: StreamEvent) => void;
  onPhase?: (phase: "prepare" | "contract" | "brief" | "run" | "verify" | "report") => void;
  signal?: AbortSignal;
}

export interface Citation {
  path: string;
  line: number;
  claim: string;
}

export interface Envelope {
  jobId: string;
  kind: "implement" | "explore";
  state: JobState;
  reason?: string;
  branch: string | null;
  worktreePath: string;
  baseSha: string;
  headSha?: string;
  mergeCheck?: { clean: boolean; conflictingFiles: string[] };
  contract?: { redOnBase: boolean; greenAfter: boolean };
  verify?: VerifyReport;
  diffStat?: string;
  untrustedReport: string;
  deniedCommands: string[];
  guardEvents: string[];
  skillsUsed: string[];
  explore?: {
    summary: string;
    citations: Citation[];
    unverifiedCitations: Citation[];
    openQuestions: string[];
  };
  quota?: { resetInSec?: number; resetText?: string };
  model: string;
  conversationId?: string;
  usage?: AgyUsage;
  durationSec: number;
}

export function fenceUntrusted(text: string, nonce: string): string {
  return `<<<AGY-UNTRUSTED nonce=${nonce}>>>\n${text.slice(0, 8000)}\n<<<END nonce=${nonce}>>>`;
}

function getDeniedCommands(worktreePath: string): string[] {
  const reviewFile = path.join(worktreePath, ".agents", "agyo-review.jsonl");
  if (!existsSync(reviewFile)) return [];
  try {
    const lines = readFileSync(reviewFile, "utf8").trim().split(/\r?\n/).filter(Boolean);
    const denied: string[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.decision === "deny" && entry.name === "run_command" && entry.arg) {
          denied.push(String(entry.arg));
        }
      } catch {
        // ignore parse error
      }
    }
    return denied;
  } catch {
    return [];
  }
}

async function runImplementJob(
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

  if (outcome.type === "quota") {
    jobState = "quota";
    quotaData = { resetInSec: outcome.resetInSec, resetText: outcome.resetText };
    jobReason = outcome.resetText ?? "Quota exceeded";
  } else if (outcome.type === "timeout") {
    jobState = "timeout";
    jobReason = "Job timed out";
  } else if (outcome.type === "cancelled") {
    jobState = "cancelled";
    jobReason = "Job was cancelled";
  } else if (outcome.type === "guard_violation") {
    jobState = "guard_violation";
    jobReason = outcome.reason;
    if (!guardEvents.includes(outcome.reason)) {
      guardEvents.push(outcome.reason);
    }
  } else if (outcome.type === "denied") {
    jobState = "error";
    jobReason = outcome.detail;
  } else if (outcome.type === "error") {
    jobState = "error";
    jobReason = outcome.message;
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
  const responseText =
    outcome.type === "success"
      ? outcome.response
      : outcome.type === "timeout"
        ? outcome.partialResponse
        : "";
  const nonce = randomBytes(4).toString("hex");
  const untrustedReport = fenceUntrusted(responseText, nonce);
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

async function runExploreJob(
  spec: JobSpec,
  deps: PipelineDeps,
  startTime: Date,
): Promise<Envelope> {
  // 1. prepare
  deps.onPhase?.("prepare");
  const wt = await createWorktree({
    repoRoot: spec.repoRoot,
    jobId: spec.jobId,
    root: deps.worktreeRoot,
    baseRef: spec.baseRef,
    detached: true,
  });

  await excludeInRepo(spec.repoRoot, [".agents/", ".agy-task/"]);

  // 2. brief
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
      await removeWorktree(wt);
      const durationSec = (deps.now().getTime() - startTime.getTime()) / 1000;
      const nonce = randomBytes(4).toString("hex");
      return {
        jobId: spec.jobId,
        kind: "explore",
        state: "refused",
        reason: err instanceof Error ? err.message : String(err),
        branch: null,
        worktreePath: wt.path,
        baseSha: wt.baseSha,
        untrustedReport: fenceUntrusted("", nonce),
        deniedCommands: [],
        guardEvents: [],
        skillsUsed: [],
        model: spec.config.model,
        conversationId: spec.conversationId,
        durationSec,
      };
    }
  }

  mkdirSync(path.join(wt.path, ".agy-task"), { recursive: true });
  const briefInput: BriefInput = {
    kind: "explore",
    task: spec.task,
    date: deps.now().toISOString().slice(0, 10),
    skills: resolvedSkills.map((s) => ({ name: s.name, description: s.description })),
    lessons: spec.lessons,
  };
  writeFileSync(path.join(wt.path, ".agy-task", "brief.md"), renderBrief(briefInput), "utf8");

  const schemaPath = path.join(wt.path, ".agy-task", "report.schema.json");
  writeFileSync(schemaPath, JSON.stringify(EXPLORE_SCHEMA, null, 2), "utf8");

  const policy: GatePolicy = {
    mode: "explore",
    worktree: wt.path,
    readOnlyDirs: [],
    protectedGlobs: spec.config.protectedPaths,
    allowedCommands: [],
    unknownCommands: spec.config.unknownCommands,
    allowedMcp: spec.config.allowedMcp,
    web: spec.config.web,
  };

  await installGate(wt.path, policy, deps.hookBundlePath);

  // 3. run
  deps.onPhase?.("run");
  const guardEvents: string[] = [];
  const rawGuard = makeGuard(policy);
  const guard = (ev: StreamEvent): string | null => {
    const g = rawGuard(ev);
    if (g) guardEvents.push(g);
    return g;
  };

  let outcome: Outcome;
  try {
    outcome = await deps.agyRun(
      {
        prompt: RUN_PROMPT,
        cwd: wt.path,
        model: spec.config.model,
        effort: spec.effort ?? spec.config.effort,
        mode: "plan",
        jsonSchemaPath: schemaPath,
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
  } catch (err: unknown) {
    try {
      await removeWorktree(wt);
    } catch {
      // ignore
    }
    throw err;
  }

  // 4. report & check citations
  deps.onPhase?.("report");
  const deniedCommands = getDeniedCommands(wt.path);

  let jobState: JobState;
  let jobReason: string | undefined;
  let quotaData: { resetInSec?: number; resetText?: string } | undefined;
  let exploreData:
    | {
        summary: string;
        citations: Citation[];
        unverifiedCitations: Citation[];
        openQuestions: string[];
      }
    | undefined = undefined;

  if (outcome.type === "quota") {
    jobState = "quota";
    quotaData = { resetInSec: outcome.resetInSec, resetText: outcome.resetText };
    jobReason = outcome.resetText ?? "Quota exceeded";
  } else if (outcome.type === "timeout") {
    jobState = "timeout";
    jobReason = "Job timed out";
  } else if (outcome.type === "cancelled") {
    jobState = "cancelled";
    jobReason = "Job was cancelled";
  } else if (outcome.type === "guard_violation") {
    jobState = "guard_violation";
    jobReason = outcome.reason;
    if (!guardEvents.includes(outcome.reason)) {
      guardEvents.push(outcome.reason);
    }
  } else if (outcome.type === "denied") {
    jobState = "error";
    jobReason = outcome.detail;
  } else if (outcome.type === "error") {
    jobState = "error";
    jobReason = outcome.message;
  } else {
    // success: parse structuredOutput or response
    let parsed: any = outcome.structuredOutput;
    if (!parsed && outcome.response) {
      try {
        parsed = JSON.parse(outcome.response);
      } catch {
        const m = outcome.response.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (m) {
          try {
            parsed = JSON.parse(m[1]);
          } catch {
            // ignore
          }
        }
      }
    }

    if (!parsed || typeof parsed !== "object") {
      jobState = "error";
      jobReason = "No parseable JSON in explore response";
    } else {
      jobState = "passed";
      const citations: Citation[] = [];
      const unverifiedCitations: Citation[] = [];

      const rawCitations = Array.isArray(parsed.citations) ? parsed.citations : [];
      for (const raw of rawCitations) {
        const cPath = typeof raw.path === "string" ? raw.path : "";
        const cLine = typeof raw.line === "number" ? raw.line : -1;
        const cClaim = typeof raw.claim === "string" ? raw.claim : "";
        const citation: Citation = { path: cPath, line: cLine, claim: cClaim };

        let valid = false;
        if (cPath && !path.isAbsolute(cPath) && cLine >= 1) {
          const full = path.resolve(wt.path, cPath);
          const rel = path.relative(wt.path, full);
          if (!rel.startsWith("..") && !path.isAbsolute(rel) && existsSync(full)) {
            try {
              const stat = statSync(full);
              if (stat.isFile()) {
                const content = readFileSync(full, "utf8");
                const lineCount = content.split(/\r?\n/).length;
                if (cLine <= lineCount) {
                  valid = true;
                }
              }
            } catch {
              valid = false;
            }
          }
        }

        if (valid) {
          citations.push(citation);
        } else {
          unverifiedCitations.push(citation);
        }
      }

      const openQuestions = Array.isArray(parsed.open_questions)
        ? parsed.open_questions.map(String)
        : Array.isArray(parsed.openQuestions)
          ? parsed.openQuestions.map(String)
          : [];

      exploreData = {
        summary: typeof parsed.summary === "string" ? parsed.summary : "",
        citations,
        unverifiedCitations,
        openQuestions,
      };
    }
  }

  // Always remove the worktree for explore jobs
  try {
    await removeWorktree(wt);
  } catch {
    // ignore
  }

  const responseText =
    outcome.type === "success"
      ? outcome.response
      : outcome.type === "timeout"
        ? outcome.partialResponse
        : "";
  const nonce = randomBytes(4).toString("hex");
  const untrustedReport = fenceUntrusted(responseText, nonce);
  const durationSec = (deps.now().getTime() - startTime.getTime()) / 1000;

  return {
    jobId: spec.jobId,
    kind: "explore",
    state: jobState,
    ...(jobReason ? { reason: jobReason } : {}),
    branch: null,
    worktreePath: wt.path,
    baseSha: wt.baseSha,
    untrustedReport,
    deniedCommands,
    guardEvents,
    skillsUsed,
    ...(exploreData ? { explore: exploreData } : {}),
    ...(quotaData ? { quota: quotaData } : {}),
    model: spec.config.model,
    ...(outcome.conversationId || spec.conversationId
      ? { conversationId: outcome.conversationId ?? spec.conversationId }
      : {}),
    ...(outcome.type === "success" ? { usage: outcome.usage } : {}),
    durationSec,
  };
}

export async function runJob(spec: JobSpec, deps: PipelineDeps): Promise<Envelope> {
  const startTime = deps.now();
  if (spec.kind === "explore") {
    return await runExploreJob(spec, deps, startTime);
  }
  return await runImplementJob(spec, deps, startTime);
}
