import type { Config, Effort } from "../config.js";
import { git } from "../pipeline/exec.js";
import type { Envelope, JobSpec, PipelineDeps } from "../pipeline/index.js";
import type { Approver } from "./approver.js";
import type { FlagStore } from "./flags.js";
import { canRunJob, compactRecord, firstOpenItem, isSamePath } from "./helpers.js";
import { Ledger } from "./ledger.js";
import type { Audience, LessonStore } from "./lessons.js";
import { renderProgressLine } from "./progress.js";
import { isTerminal, type Estimate, type JobRecord, type JobStore } from "./store.js";
import { prepareStartJob } from "./start.js";
import { executeJob } from "./execute.js";
import { handleAct, startFollowup, type ActionsContext } from "./actions.js";
import type { ContractTest } from "../pipeline/contract.js";

export { compactRecord, firstOpenItem };

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
  | { state: "queued" | "running"; jobId: string; waitHint: string; lessonsInjected?: number }
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
  | { action: "revoke_plan"; planFile: string }
  | {
      action: "lesson";
      text: string;
      audience: Audience;
      scope: "project" | "global";
      tags?: string[];
      jobId?: string;
    };

export interface JobManagerDeps {
  store: JobStore;
  ledger: Ledger;
  flags: FlagStore;
  approver: Approver;
  runJob: (spec: JobSpec, deps: PipelineDeps) => Promise<Envelope>;
  pipelineDeps: Omit<PipelineDeps, "onEvent" | "onPhase" | "signal">;
  loadConfig: (repoRoot: string) => Config;
  now: () => Date;
  lessons?: (repoRoot: string) => { project: LessonStore; global: LessonStore };
  skillDir?: (repoRoot: string) => string | undefined;
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

  private getActionsContext(): ActionsContext {
    return {
      deps: this.deps,
      abortControllers: this.abortControllers,
      activeJobs: this.activeJobs,
      queuedSpecs: this.queuedSpecs,
      writeRecord: (r) => this.writeRecord(r),
      executeJob: (r, s) => this.runExecute(r, s),
    };
  }

  private runExecute(record: JobRecord, spec: JobSpec): void {
    executeJob(
      {
        deps: this.deps,
        abortControllers: this.abortControllers,
        activeJobs: this.activeJobs,
        queuedSpecs: this.queuedSpecs,
        writeQueues: this.writeQueues,
        writeRecord: (r) => this.writeRecord(r),
        startFollowup: (parent, feedback, bypassApproval) =>
          startFollowup(this.getActionsContext(), parent, feedback, bypassApproval),
        drainQueue: () => this.drainQueue(),
        checkIdle: () => this.checkIdle(),
      },
      record,
      spec,
    );
  }

  async start(i: StartInput): Promise<StartResult> {
    const prep = await prepareStartJob(this.deps, i);
    if (prep.type === "result") {
      return prep.result;
    }
    const { record, spec, config, lessonsInjected } = prep;
    this.queuedSpecs.set(record.id, spec);
    this.activeJobs.add(record.id);

    const allJobs = await this.deps.store.list();
    const state: "running" | "queued" = canRunJob(allJobs, i.repoRoot, config, this.deps.now())
      ? "running"
      : "queued";

    record.state = state;
    await this.writeRecord(record);

    if (state === "running") {
      this.runExecute(record, spec);
    }

    return {
      state,
      jobId: record.id,
      waitHint: `agy-orchestrator wait ${record.id}`,
      lessonsInjected,
    };
  }

  private async drainQueue(): Promise<void> {
    const allJobs = await this.deps.store.list();
    const queuedJobs = allJobs
      .filter((j) => j.state === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    for (const job of queuedJobs) {
      const config = this.deps.loadConfig(job.repoRoot);
      if (canRunJob(allJobs, job.repoRoot, config, this.deps.now())) {
        job.state = "running";
        job.updatedAt = this.deps.now().toISOString();
        await this.writeRecord(job);
        const spec = this.queuedSpecs.get(job.id);
        if (spec) {
          this.runExecute(job, spec);
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
      ...compactRecord(rec),
      // diffStat already sits in the envelope; only full/paths diffs are added.
      ...(diff !== undefined && o?.diffMode !== "stat" ? { diff } : {}),
    };
    const jsonChars = JSON.stringify(result).length;
    rec.returnedChars = (rec.returnedChars ?? 0) + jsonChars;
    result.returnedChars = rec.returnedChars;
    await this.writeRecord(rec);

    return result;
  }

  async act(i: ActInput): Promise<Record<string, unknown>> {
    return await handleAct(this.getActionsContext(), i);
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

    let lessons: string[] = [];
    if (this.deps.lessons) {
      const rRoot = repoRoot ?? filteredJobs[0]?.repoRoot ?? process.cwd();
      const stores = this.deps.lessons(rRoot);
      const projLessons = await stores.project.select("orchestrator", [], 5);
      const globLessons = await stores.global.select("orchestrator", [], 5);
      const seen = new Set<string>();
      for (const l of projLessons) {
        if (!seen.has(l.text)) {
          seen.add(l.text);
          lessons.push(l.text);
          if (lessons.length === 5) break;
        }
      }
      if (lessons.length < 5) {
        for (const l of globLessons) {
          if (!seen.has(l.text)) {
            seen.add(l.text);
            lessons.push(l.text);
            if (lessons.length === 5) break;
          }
        }
      }
    }

    return {
      delegation,
      ...(cooldown ? { cooldown } : {}),
      running,
      queued,
      today,
      calibration,
      lessons,
    };
  }
}
