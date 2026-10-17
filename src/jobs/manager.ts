import type { Config, Effort } from "../config.js";
import { git } from "../pipeline/exec.js";
import type { Envelope, JobSpec, PipelineDeps } from "../pipeline/index.js";
import type { Approver } from "./approver.js";
import type { FlagStore } from "./flags.js";
import { compactRecord, firstOpenItem, isSamePath } from "./helpers.js";
import { Ledger } from "./ledger.js";
import type { Audience, LessonStore } from "./lessons.js";
import { renderProgressLine } from "./progress.js";
import { isTerminal, type Estimate, type JobRecord, type JobStore } from "./store.js";
import { prepareStartJob } from "./start.js";
import { executeJob } from "./execute.js";
import { handleAct, startFollowup, type ActionsContext } from "./actions.js";
import { JobScheduler } from "./scheduler.js";
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
  private scheduler: JobScheduler;

  constructor(private deps: JobManagerDeps) {
    this.scheduler = new JobScheduler({
      store: deps.store,
      loadConfig: deps.loadConfig,
      now: deps.now,
      run: (record, spec, signal) =>
        executeJob(
          {
            deps: this.deps,
            write: (r) => this.scheduler.write(r),
            startFollowup: (parent, feedback, bypassApproval) =>
              startFollowup(this.getActionsContext(), parent, feedback, bypassApproval),
          },
          record,
          spec,
          signal,
        ),
    });
  }

  private getActionsContext(): ActionsContext {
    return {
      deps: this.deps,
      scheduler: this.scheduler,
    };
  }

  async start(i: StartInput): Promise<StartResult> {
    const prep = await prepareStartJob(this.deps, i);
    if (prep.type === "result") {
      return prep.result;
    }
    const { record, spec, lessonsInjected } = prep;
    const state = await this.scheduler.submit(record, spec);

    return {
      state,
      jobId: record.id,
      waitHint: `agy-foreman wait ${record.id}`,
      lessonsInjected,
    };
  }

  async idle(): Promise<void> {
    return this.scheduler.idle();
  }

  async recoverOrphans(): Promise<string[]> {
    return this.scheduler.recoverOrphans();
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
    await this.scheduler.write(rec);

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
