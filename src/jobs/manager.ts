import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildArgs } from "../agy/run.js";
import type { StreamEvent } from "../agy/types.js";
import type { Config, Effort } from "../config.js";
import { renderBrief, progressFraction, RUN_PROMPT } from "../pipeline/brief.js";
import { addContractTests, redCheck, type ContractTest } from "../pipeline/contract.js";
import { git } from "../pipeline/exec.js";
import type { Envelope, JobSpec, PipelineDeps } from "../pipeline/index.js";
import { resolveSkills } from "../pipeline/skills.js";
import {
  createWorktree,
  isDirty,
  mergeCheck,
  removeWorktree,
  repoHash,
  type Worktree,
} from "../pipeline/worktree.js";
import {
  ApprovalUnavailable,
  type Approver,
  type TaskCard,
  type PlanCard,
  type QuotaCard,
} from "./approver.js";
import { FlagStore, hashPlan, validGrant } from "./flags.js";
import { Ledger } from "./ledger.js";
import { parsePlanStep, planTitle } from "./plan.js";
import { computeProgress, renderProgressLine } from "./progress.js";
import {
  emptyProgress,
  isTerminal,
  newJobId,
  type Estimate,
  type JobRecord,
  type JobStore,
} from "./store.js";
import { tokenGate } from "./tokengate.js";

export interface StartInput {
  repoRoot: string;
  kind: "implement" | "explore";
  task?: string;
  plan?: { file: string; step: number; delegateSteps?: number[] };
  contractTests?: ContractTest[];
  skills?: string[];
  estimate?: Estimate;
  effort?: Effort;
  dryRun?: boolean;
  baseRef?: string;
  timeoutSec?: number;
}

export type StartResult =
  | { state: "queued" | "running"; jobId: string; waitHint: string }
  | { state: "refused" | "denied"; reason: string }
  | {
      state: "quota";
      reason: string;
      quota: { resetText?: string; resetAt?: string };
      options: ("retry" | "continue_without" | "wait")[];
    }
  | {
      state: "dry_run";
      brief: string;
      command: string[];
      skills: { name: string; claudeOnlyRefs: string[] }[];
      contractTests: string[];
      redOnBase?: boolean;
    };

export interface GetOptions {
  waitSec?: number;
  diffMode?: "stat" | "full" | "paths";
  paths?: string[];
  maxDiffTokens?: number;
}

export type ActInput =
  | { action: "followup"; jobId: string; feedback: string }
  | { action: "finalize"; jobId: string; mode: "squash" | "merge" | "discard" | "keep" }
  | { action: "cancel"; jobId: string }
  | { action: "quota_choice"; choice: "retry" | "continue_without" | "wait" }
  | { action: "resume_delegation" }
  | { action: "revoke_plan"; planFile: string };

export interface JobManagerDeps {
  store: JobStore;
  ledger: Ledger;
  flags: FlagStore;
  approver: Approver;
  runJob: (spec: JobSpec, deps: PipelineDeps) => Promise<Envelope>;
  pipelineDeps: Omit<PipelineDeps, "onEvent" | "onPhase" | "signal">;
  loadConfig: (repoRoot: string) => Config;
  now: () => Date;
}

function isSamePath(p1: string, p2: string): boolean {
  const norm1 = path.resolve(p1);
  const norm2 = path.resolve(p2);
  return process.platform === "win32"
    ? norm1.toLowerCase() === norm2.toLowerCase()
    : norm1 === norm2;
}

export class JobManager {
  private activeJobs = new Set<string>();
  private idleWaiters = new Set<() => void>();
  private abortControllers = new Map<string, AbortController>();
  private queuedSpecs = new Map<string, JobSpec>();
  private writeQueues = new Map<string, Promise<void>>();

  constructor(private deps: JobManagerDeps) {}

  private async writeRecord(record: JobRecord): Promise<void> {
    const prev = this.writeQueues.get(record.id) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        await this.deps.store.write(record);
      });
    this.writeQueues.set(record.id, next);
    return next;
  }

  async start(i: StartInput): Promise<StartResult> {
    // 1. Delegation paused
    const flags = await this.deps.flags.read();
    if (flags.delegationPaused) {
      return {
        state: "refused",
        reason: "delegation is paused; call agy_act resume_delegation to unpause",
      };
    }

    // 2. Cooldown active
    if (
      flags.cooldownUntil &&
      new Date(flags.cooldownUntil).getTime() > this.deps.now().getTime()
    ) {
      const choice = await this.deps.approver.quota({
        resetText: flags.cooldownText,
        resetAt: flags.cooldownUntil,
      });
      if (choice === "retry") {
        await this.deps.flags.update((f) => {
          delete f.cooldownUntil;
          delete f.cooldownText;
        });
      } else if (choice === "continue_without") {
        await this.deps.flags.update((f) => {
          f.delegationPaused = true;
        });
        return {
          state: "refused",
          reason: "continue without Gemini",
        };
      } else {
        // "wait" or "unavailable"
        return {
          state: "quota",
          reason: "Gemini quota active",
          quota: {
            resetText: flags.cooldownText,
            resetAt: flags.cooldownUntil,
          },
          options: ["retry", "continue_without", "wait"],
        };
      }
    }

    // 3. Resolve the task
    let task: string;
    let title: string;
    let contractTests: ContractTest[] | undefined;
    let checklist: string[] | undefined;
    let planContent: string | undefined;

    if (i.plan) {
      const planPath = path.isAbsolute(i.plan.file)
        ? i.plan.file
        : path.resolve(i.repoRoot, i.plan.file);
      try {
        planContent = await readFile(planPath, "utf8");
      } catch {
        return {
          state: "refused",
          reason: `plan file not found: ${i.plan.file}`,
        };
      }
      try {
        const step = parsePlanStep(planContent, i.plan.step);
        task = step.text;
        title = step.title;
        contractTests = i.kind === "explore" ? undefined : (i.contractTests ?? step.testBlocks);
        // One checklist item per non-test file, so the run-phase % moves as Gemini ticks them off.
        const implFiles = step.files.filter(
          (f) => !/(\.test\.|\.spec\.|_test\.|(^|\/)test_)/.test(f),
        );
        checklist =
          i.kind === "explore" || implFiles.length === 0
            ? undefined
            : [
                ...implFiles.map((f) => `Implement ${f}`),
                "Run the verification commands and fix failures",
              ];
      } catch (err) {
        return {
          state: "refused",
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    } else {
      if (!i.task || i.task.trim().length === 0) {
        return {
          state: "refused",
          reason: "task is required when plan is not specified",
        };
      }
      task = i.task;
      const firstLine = i.task.trim().split(/\r?\n/)[0];
      title = firstLine.slice(0, 80);
      contractTests = i.kind === "explore" ? undefined : i.contractTests;
    }

    // 4. Token gate (implement only, skipped on dry run)
    const config = this.deps.loadConfig(i.repoRoot);
    if (i.kind === "implement" && !i.dryRun) {
      const gateResult = tokenGate(i.estimate, config.project.refuseRatio);
      if (gateResult.refuse) {
        return {
          state: "refused",
          reason: gateResult.reason!,
        };
      }
    }

    // 5. Dry run
    if (i.dryRun) {
      let resolvedSkills: { name: string; claudeOnlyRefs: string[]; description: string }[] = [];
      if (i.skills && i.skills.length > 0) {
        const res = await resolveSkills(i.skills, config.project.skillRoots, {
          repoRoot: i.repoRoot,
          home: this.deps.pipelineDeps.home,
        });
        resolvedSkills = res.map((s) => ({
          name: s.name,
          claudeOnlyRefs: s.claudeOnlyRefs,
          description: s.description,
        }));
      }

      const brief = renderBrief({
        kind: i.kind,
        task,
        date: this.deps.now().toISOString().slice(0, 10),
        testCommand: config.project.testCommand,
        skills: resolvedSkills.map((s) => ({ name: s.name, description: s.description })),
      });

      const command = buildArgs(
        {
          prompt: RUN_PROMPT,
          cwd: i.repoRoot,
          model: config.project.model,
          effort: i.effort ?? config.project.effort,
          mode: i.kind === "explore" ? "plan" : "accept-edits",
          timeoutSec: i.timeoutSec ?? config.runtime.defaultTimeoutSec,
          skipPermissions: config.runtime.skipPermissions,
          sandbox: config.runtime.sandbox,
          agy: this.deps.pipelineDeps.agyCommand,
        },
        path.join(os.tmpdir(), "agy.log"),
      );

      const contractTestPaths = (contractTests ?? []).map((t) => t.path);
      let redOnBase: boolean | undefined;

      if (
        contractTests &&
        contractTests.length > 0 &&
        config.project.testCommand &&
        config.project.testCommand.length > 0
      ) {
        const wtJobId = "t-dryrun-" + randomBytes(4).toString("hex");
        const wt = await createWorktree({
          repoRoot: i.repoRoot,
          jobId: wtJobId,
          root: this.deps.pipelineDeps.worktreeRoot,
          baseRef: i.baseRef,
        });
        try {
          await addContractTests(wt, contractTests);
          const { red } = await redCheck(
            wt,
            config.project.testCommand,
            (i.timeoutSec ?? config.runtime.defaultTimeoutSec) * 1000,
          );
          redOnBase = red;
        } finally {
          await removeWorktree(wt, { deleteBranch: true });
        }
      }

      return {
        state: "dry_run",
        brief,
        command,
        skills: resolvedSkills.map((s) => ({
          name: s.name,
          claudeOnlyRefs: s.claudeOnlyRefs,
        })),
        contractTests: contractTestPaths,
        ...(redOnBase !== undefined ? { redOnBase } : {}),
      };
    }

    // 6. Approval
    try {
      if (i.plan && config.project.approval === "per_plan") {
        const planFile = i.plan.file;
        const hash = hashPlan(planContent!);
        const currentFlags = await this.deps.flags.read();
        const grant = validGrant(currentFlags, planFile, hash, this.deps.now());
        if (!grant) {
          const pTitle = planTitle(planContent!);
          const steps = i.plan.delegateSteps ?? [i.plan.step];
          const approved = await this.deps.approver.plan({
            planFile,
            title: pTitle,
            steps,
            estimate: i.estimate,
          });
          if (!approved) {
            return { state: "denied", reason: "plan approval denied" };
          }
          const expiresAt = new Date(this.deps.now().getTime() + 24 * 60 * 60 * 1000).toISOString();
          await this.deps.flags.update((f) => {
            f.grants.push({
              file: planFile,
              hash,
              steps,
              approvedAt: this.deps.now().toISOString(),
              expiresAt,
            });
          });
        }
      } else {
        const taskCard: TaskCard = {
          title,
          kind: i.kind,
          effort: i.effort ?? config.project.effort,
          skills: i.skills ?? [],
          estimate: i.estimate,
        };
        const approved = await this.deps.approver.task(taskCard);
        if (!approved) {
          return { state: "denied", reason: "task approval denied" };
        }
      }
    } catch (err: unknown) {
      if (
        err instanceof ApprovalUnavailable ||
        (err instanceof Error && err.name === "ApprovalUnavailable")
      ) {
        return { state: "refused", reason: (err as Error).message };
      }
      throw err;
    }

    // 7. Create the record
    const jobId = newJobId(this.deps.now());
    const record: JobRecord = {
      id: jobId,
      kind: i.kind,
      repoRoot: i.repoRoot,
      title,
      state: "queued",
      progress: emptyProgress(),
      createdAt: this.deps.now().toISOString(),
      updatedAt: this.deps.now().toISOString(),
      ...(i.plan ? { plan: { file: i.plan.file, step: i.plan.step } } : {}),
      ...(i.estimate ? { estimate: i.estimate } : {}),
      returnedChars: 0,
    };

    const spec: JobSpec = {
      jobId,
      kind: i.kind,
      repoRoot: i.repoRoot,
      task,
      contractTests,
      checklist,
      skills: i.skills,
      effort: i.effort ?? config.project.effort,
      baseRef: i.baseRef,
      timeoutSec: i.timeoutSec ?? config.runtime.defaultTimeoutSec,
      config: config.project,
      runtime: config.runtime,
    };

    this.queuedSpecs.set(jobId, spec);
    this.activeJobs.add(jobId);

    const allJobs = await this.deps.store.list();
    const repoJobs = allJobs.filter((j) => isSamePath(j.repoRoot, i.repoRoot));
    const runningJobs = repoJobs.filter((j) => j.state === "running");
    const oneHourAgo = new Date(this.deps.now().getTime() - 60 * 60 * 1000).toISOString();
    const startedLastHour = repoJobs.filter((j) => j.createdAt >= oneHourAgo);

    let state: "running" | "queued" = "queued";
    if (
      runningJobs.length < config.project.maxConcurrent &&
      startedLastHour.length < config.project.maxRunsPerHour
    ) {
      state = "running";
    }

    record.state = state;
    await this.writeRecord(record);

    if (state === "running") {
      this.executeJob(record, spec);
    }

    return {
      state,
      jobId,
      waitHint: `agy-orchestrator wait ${jobId}`,
    };
  }

  private executeJob(record: JobRecord, spec: JobSpec): void {
    const abortController = new AbortController();
    this.abortControllers.set(record.id, abortController);

    const jobStartTime = this.deps.now();
    let runStartTime: Date | undefined;
    let lastWriteTime = 0;
    const worktreePath = path.join(
      this.deps.pipelineDeps.worktreeRoot,
      repoHash(spec.repoRoot),
      spec.jobId,
    );

    const updateProgressAndSave = async (force: boolean) => {
      const nowMs = this.deps.now().getTime();
      if (!force && nowMs - lastWriteTime < 500) {
        return;
      }
      lastWriteTime = nowMs;
      const median = await this.deps.ledger.medianRunSec(record.kind);
      const elapsedSec = (nowMs - jobStartTime.getTime()) / 1000;
      const runElapsedSec = runStartTime ? (nowMs - runStartTime.getTime()) / 1000 : 0;
      const prog = computeProgress({
        phase: record.progress.phase,
        checklist:
          record.progress.checklistTotal > 0
            ? {
                done: record.progress.checklistDone,
                total: record.progress.checklistTotal,
              }
            : undefined,
        elapsedSec,
        runElapsedSec,
        medianRunSec: median,
      });
      record.progress.percent = prog.percent;
      record.progress.elapsedSec = elapsedSec;
      record.progress.etaSec = prog.etaSec;
      record.updatedAt = this.deps.now().toISOString();
      await this.writeRecord(record);
    };

    const onPhase = (phase: "prepare" | "contract" | "brief" | "run" | "verify" | "report") => {
      record.progress.phase = phase;
      if (phase === "run" && !runStartTime) {
        runStartTime = this.deps.now();
      }
      updateProgressAndSave(true).catch(() => {});
    };

    const onEvent = (ev: StreamEvent) => {
      let changed = false;
      if (ev.kind === "step") {
        if (ev.state === "DONE" || ev.state === "done") {
          record.progress.toolSteps++;
          changed = true;
        }
        const params = ev.toolParams;
        if (params && typeof params === "object") {
          const target =
            params.TargetFile ?? params.targetFile ?? params.AbsolutePath ?? params.absolutePath;
          if (typeof target === "string") {
            let rel = target;
            if (path.isAbsolute(rel)) {
              const r = path.relative(worktreePath, rel);
              if (!r.startsWith("..") && !path.isAbsolute(r)) {
                rel = r;
              }
            }
            record.progress.currentFile = rel.replace(/\\/g, "/");
            changed = true;
          }
        }
        if (ev.usage?.totalTokens) {
          record.progress.tokens = ev.usage.totalTokens;
          changed = true;
        }
        if (ev.toolName && ev.toolName.includes("write_to_file")) {
          const progressFile = path.join(worktreePath, ".agy-task", "progress.md");
          const target = params?.TargetFile ?? params?.targetFile;
          if (
            typeof target === "string" &&
            (target.endsWith("progress.md") || isSamePath(target, progressFile))
          ) {
            try {
              const content = readFileSync(progressFile, "utf8");
              const frac = progressFraction(content);
              record.progress.checklistDone = frac.done;
              record.progress.checklistTotal = frac.total;
              changed = true;
            } catch {
              // ignore
            }
          }
        }
      } else if (ev.kind === "result") {
        if (ev.result?.usage?.totalTokens) {
          record.progress.tokens = ev.result.usage.totalTokens;
          changed = true;
        }
      }
      if (changed) {
        updateProgressAndSave(false).catch(() => {});
      }
    };

    void (async () => {
      let envelope: Envelope | undefined;
      let runError: unknown;
      try {
        const pd: PipelineDeps = {
          ...this.deps.pipelineDeps,
          onPhase,
          onEvent,
          signal: abortController.signal,
        };
        envelope = await this.deps.runJob(spec, pd);
      } catch (err) {
        runError = err;
      }

      if (runError !== undefined) {
        const reason = runError instanceof Error ? runError.message : String(runError);
        record.state = "error";
        record.progress.phase = "done";
        record.progress.percent = 100;
        record.progress.elapsedSec = (this.deps.now().getTime() - jobStartTime.getTime()) / 1000;
        delete record.progress.etaSec;
        record.updatedAt = this.deps.now().toISOString();
        await this.writeRecord(record);
        await this.deps.ledger.append({
          jobId: record.id,
          kind: record.kind,
          state: "error",
          durationSec: record.progress.elapsedSec,
          estimate: record.estimate,
          returnedTokens: 0,
          at: this.deps.now().toISOString(),
        });
      } else if (envelope) {
        record.envelope = envelope;
        record.state = envelope.state;
        record.progress.phase = "done";
        record.progress.percent = 100;
        record.progress.elapsedSec = envelope.durationSec;
        delete record.progress.etaSec;
        record.updatedAt = this.deps.now().toISOString();
        await this.writeRecord(record);

        const returnedTokens =
          envelope.usage?.outputTokens ?? Math.round((envelope.untrustedReport?.length ?? 0) / 4);
        await this.deps.ledger.append({
          jobId: record.id,
          kind: record.kind,
          state: envelope.state,
          durationSec: envelope.durationSec,
          runSec: envelope.durationSec,
          estimate: record.estimate,
          returnedTokens,
          usageTotal: envelope.usage?.totalTokens,
          at: this.deps.now().toISOString(),
        });

        if (envelope.state === "quota") {
          const resetInSec = envelope.quota?.resetInSec ?? 900;
          const cooldownSec = Math.max(60, resetInSec);
          const cooldownUntil = new Date(
            this.deps.now().getTime() + cooldownSec * 1000,
          ).toISOString();
          const cooldownText = envelope.quota?.resetText ?? `${Math.ceil(cooldownSec / 60)}m`;
          await this.deps.flags.update((f) => {
            f.cooldownUntil = cooldownUntil;
            f.cooldownText = cooldownText;
          });

          try {
            const choice = await this.deps.approver.quota({
              resetText: cooldownText,
              resetAt: cooldownUntil,
              pausedJobId: record.id,
            });
            if (choice === "retry") {
              await this.deps.flags.update((f) => {
                delete f.cooldownUntil;
                delete f.cooldownText;
              });
              await this.startFollowup(
                record,
                "Continue the task; the previous run stopped at a usage limit.",
                true,
              );
            } else if (choice === "continue_without") {
              await this.deps.flags.update((f) => {
                f.delegationPaused = true;
              });
            }
          } catch {
            // ignore
          }
        }
      }

      this.abortControllers.delete(record.id);
      this.activeJobs.delete(record.id);
      this.queuedSpecs.delete(record.id);
      this.writeQueues.delete(record.id);
      await this.drainQueue();
      this.checkIdle();
    })();
  }

  private async startFollowup(
    parent: JobRecord,
    feedback: string,
    bypassApproval: boolean,
  ): Promise<{ state: "running" | "queued"; jobId: string }> {
    const config = this.deps.loadConfig(parent.repoRoot);
    if (!bypassApproval) {
      let needApproval = true;
      if (parent.plan) {
        try {
          const planPath = path.isAbsolute(parent.plan.file)
            ? parent.plan.file
            : path.resolve(parent.repoRoot, parent.plan.file);
          const content = await readFile(planPath, "utf8");
          const hash = hashPlan(content);
          const flags = await this.deps.flags.read();
          if (validGrant(flags, parent.plan.file, hash, this.deps.now())) {
            needApproval = false;
          }
        } catch {
          needApproval = true;
        }
      }
      if (needApproval) {
        const approved = await this.deps.approver.task({
          title: parent.title,
          kind: "implement",
          effort: config.project.effort,
          skills: [],
          estimate: parent.estimate,
        });
        if (!approved) {
          throw new Error("task approval denied");
        }
      }
    }

    const newId = newJobId(this.deps.now());
    const newRec: JobRecord = {
      id: newId,
      kind: "implement",
      repoRoot: parent.repoRoot,
      title: parent.title,
      state: "queued",
      progress: emptyProgress(),
      createdAt: this.deps.now().toISOString(),
      updatedAt: this.deps.now().toISOString(),
      parentJobId: parent.id,
      ...(parent.plan ? { plan: parent.plan } : {}),
      ...(parent.estimate ? { estimate: parent.estimate } : {}),
      returnedChars: 0,
    };

    const spec: JobSpec = {
      jobId: newId,
      kind: "implement",
      repoRoot: parent.repoRoot,
      task: `${parent.title}\n\nFeedback:\n${feedback}`,
      contractTests: [],
      baseRef: parent.envelope?.branch ?? `agy/${parent.id}`,
      conversationId: parent.envelope?.conversationId,
      timeoutSec: config.runtime.defaultTimeoutSec,
      config: config.project,
      runtime: config.runtime,
    };

    this.queuedSpecs.set(newId, spec);
    this.activeJobs.add(newId);

    const allJobs = await this.deps.store.list();
    const repoJobs = allJobs.filter((j) => isSamePath(j.repoRoot, parent.repoRoot));
    const runningJobs = repoJobs.filter((j) => j.state === "running");
    const oneHourAgo = new Date(this.deps.now().getTime() - 60 * 60 * 1000).toISOString();
    const startedLastHour = repoJobs.filter((j) => j.createdAt >= oneHourAgo);

    let state: "running" | "queued" = "queued";
    if (
      runningJobs.length < config.project.maxConcurrent &&
      startedLastHour.length < config.project.maxRunsPerHour
    ) {
      state = "running";
    }

    newRec.state = state;
    await this.writeRecord(newRec);

    if (state === "running") {
      this.executeJob(newRec, spec);
    }

    return { state, jobId: newId };
  }

  private async drainQueue(): Promise<void> {
    const allJobs = await this.deps.store.list();
    const queuedJobs = allJobs
      .filter((j) => j.state === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    for (const job of queuedJobs) {
      const config = this.deps.loadConfig(job.repoRoot);
      const repoJobs = allJobs.filter((j) => isSamePath(j.repoRoot, job.repoRoot));
      const runningJobs = repoJobs.filter((j) => j.state === "running");
      const oneHourAgo = new Date(this.deps.now().getTime() - 60 * 60 * 1000).toISOString();
      const startedLastHour = repoJobs.filter((j) => j.createdAt >= oneHourAgo);

      if (
        runningJobs.length < config.project.maxConcurrent &&
        startedLastHour.length < config.project.maxRunsPerHour
      ) {
        job.state = "running";
        job.updatedAt = this.deps.now().toISOString();
        await this.writeRecord(job);
        const spec = this.queuedSpecs.get(job.id);
        if (spec) {
          this.executeJob(job, spec);
        }
      }
    }
  }

  private checkIdle(): void {
    if (this.activeJobs.size === 0) {
      for (const resolve of this.idleWaiters) {
        resolve();
      }
      this.idleWaiters.clear();
    }
  }

  async idle(): Promise<void> {
    if (this.activeJobs.size === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  async get(jobId: string, o?: GetOptions): Promise<(JobRecord & { diff?: string }) | undefined> {
    let rec = await this.deps.store.read(jobId);
    if (!rec) return undefined;

    if (o?.waitSec && o.waitSec > 0) {
      const startMs = Date.now();
      const waitMs = o.waitSec * 1000;
      while (!isTerminal(rec.state) && Date.now() - startMs < waitMs) {
        const remaining = waitMs - (Date.now() - startMs);
        await new Promise((r) => setTimeout(r, Math.min(200, Math.max(0, remaining))));
        const updated = await this.deps.store.read(jobId);
        if (updated) {
          rec = updated;
        }
      }
    }

    let diff: string | undefined;
    if (o?.diffMode === "stat") {
      diff = rec.envelope?.diffStat;
    } else if (o?.diffMode === "full" || o?.diffMode === "paths") {
      if (rec.envelope?.baseSha && rec.envelope?.headSha && rec.envelope.worktreePath) {
        try {
          const diffArgs = ["diff", `${rec.envelope.baseSha}..${rec.envelope.headSha}`];
          if (o.diffMode === "paths" && o.paths && o.paths.length > 0) {
            diffArgs.push("--", ...o.paths);
          }
          let fullDiff = await git(diffArgs, rec.envelope.worktreePath);
          const maxTokens = o.maxDiffTokens ?? 2000;
          const maxChars = maxTokens * 4;
          if (fullDiff.length > maxChars) {
            fullDiff = fullDiff.slice(0, maxChars) + "\n[truncated]";
          }
          diff = fullDiff;
        } catch {
          diff = undefined;
        }
      }
    }

    const result: JobRecord & { diff?: string } = {
      ...rec,
      ...(diff !== undefined ? { diff } : {}),
    };
    const jsonChars = JSON.stringify(result).length;
    rec.returnedChars = (rec.returnedChars ?? 0) + jsonChars;
    result.returnedChars = rec.returnedChars;
    await this.writeRecord(rec);

    return result;
  }

  async act(i: ActInput): Promise<Record<string, unknown>> {
    if (i.action === "followup") {
      const parent = await this.deps.store.read(i.jobId);
      if (!parent) {
        return { state: "error", reason: `job not found: ${i.jobId}` };
      }
      if (!isTerminal(parent.state) || parent.kind !== "implement" || !parent.envelope?.branch) {
        return {
          state: "refused",
          reason: "parent must be terminal implement job with a branch",
        };
      }
      return await this.startFollowup(parent, i.feedback, false);
    }

    if (i.action === "finalize") {
      const rec = await this.deps.store.read(i.jobId);
      if (!rec) {
        return { state: "error", reason: `job not found: ${i.jobId}` };
      }
      if (!isTerminal(rec.state) || !rec.envelope?.branch) {
        return { state: "refused", reason: "job must be terminal with a branch" };
      }
      const dirty = await isDirty(rec.repoRoot);
      if (dirty) {
        return { state: "refused", reason: "working tree is dirty" };
      }

      const target = await git(["rev-parse", "--abbrev-ref", "HEAD"], rec.repoRoot);
      const branch = rec.envelope.branch;
      const wt: Worktree = {
        path: rec.envelope.worktreePath,
        branch,
        baseSha: rec.envelope.baseSha,
        repoRoot: rec.repoRoot,
        jobId: rec.id,
      };

      if (i.mode === "discard") {
        await removeWorktree(wt, { deleteBranch: true });
        return { state: "discarded" };
      }

      if (i.mode === "keep") {
        return { state: "kept" };
      }

      const check = await mergeCheck(rec.repoRoot, target, branch);
      if (!check.clean) {
        return { state: "conflict", conflictingFiles: check.conflictingFiles };
      }

      if (i.mode === "squash") {
        await git(["merge", "--squash", branch], rec.repoRoot);
        const passed =
          rec.envelope.verify?.counts?.tests !== undefined
            ? rec.envelope.verify.counts.tests -
              rec.envelope.verify.counts.failures -
              rec.envelope.verify.counts.errors
            : 0;
        const total = rec.envelope.verify?.counts?.tests ?? 0;
        const commitMsg = `${rec.title}\n\nImplemented-by: ${rec.envelope.model} via agy-orchestrator\nVerified: ${passed}/${total} tests`;
        await git(["commit", "-m", commitMsg], rec.repoRoot);
        const commit = (await git(["rev-parse", "HEAD"], rec.repoRoot)).trim();
        await removeWorktree(wt, { deleteBranch: true });
        return { state: "merged", commit };
      }

      if (i.mode === "merge") {
        await git(["merge", "--no-ff", "-m", rec.title, branch], rec.repoRoot);
        const commit = (await git(["rev-parse", "HEAD"], rec.repoRoot)).trim();
        await removeWorktree(wt, { deleteBranch: false });
        return { state: "merged", commit };
      }

      return { state: "error", reason: `unknown finalize mode: ${(i as any).mode}` };
    }

    if (i.action === "cancel") {
      const controller = this.abortControllers.get(i.jobId);
      if (controller) {
        controller.abort();
      }
      return { state: "cancelling" };
    }

    if (i.action === "quota_choice") {
      if (i.choice === "retry") {
        await this.deps.flags.update((f) => {
          delete f.cooldownUntil;
          delete f.cooldownText;
        });
      } else if (i.choice === "continue_without") {
        await this.deps.flags.update((f) => ({ ...f, delegationPaused: true }));
      }
      return { state: "ok", choice: i.choice };
    }

    if (i.action === "resume_delegation") {
      await this.deps.flags.update((f) => ({ ...f, delegationPaused: false }));
      return { state: "ok" };
    }

    if (i.action === "revoke_plan") {
      const normFile = path.resolve(i.planFile);
      const compareFile = process.platform === "win32" ? normFile.toLowerCase() : normFile;
      await this.deps.flags.update((f) => {
        f.grants = f.grants.filter((g) => {
          const gNorm = path.resolve(g.file);
          const gComp = process.platform === "win32" ? gNorm.toLowerCase() : gNorm;
          return gComp !== compareFile;
        });
      });
      return { state: "ok" };
    }

    return { state: "error", reason: `unknown action: ${(i as any).action}` };
  }

  async status(repoRoot?: string): Promise<Record<string, unknown>> {
    const flags = await this.deps.flags.read();
    const delegation = flags.delegationPaused ? "paused" : "active";
    const isCooldown =
      flags.cooldownUntil && new Date(flags.cooldownUntil).getTime() > this.deps.now().getTime();
    const cooldown = isCooldown
      ? { until: flags.cooldownUntil, resetText: flags.cooldownText }
      : undefined;

    const allJobs = await this.deps.store.list();
    const filteredJobs = repoRoot
      ? allJobs.filter((j) => isSamePath(j.repoRoot, repoRoot))
      : allJobs;

    const running = filteredJobs
      .filter((j) => j.state === "running")
      .map((j) => ({ id: j.id, line: renderProgressLine(j) }));
    const queued = filteredJobs.filter((j) => j.state === "queued").map((j) => j.id);

    const nowDate = this.deps.now();
    const startOfToday = new Date(
      nowDate.getFullYear(),
      nowDate.getMonth(),
      nowDate.getDate(),
      0,
      0,
      0,
      0,
    );
    const today = await this.deps.ledger.stats(startOfToday);
    const calibration = await this.deps.ledger.calibration();

    return {
      delegation,
      ...(cooldown ? { cooldown } : {}),
      running,
      queued,
      today,
      calibration,
    };
  }
}
