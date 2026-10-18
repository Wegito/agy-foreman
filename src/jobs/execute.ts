// Job execution and progress tracking for JobManager (phase/event listeners, attempts with escalation
// and quota fallback, completion, quota handling).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { StreamEvent } from "../agy/types.js";
import { progressFraction } from "../pipeline/brief.js";
import { toolSubject } from "../pipeline/toolcall-record.js";
import { modelFor } from "../agy/run.js";
import { tierAbove, type Tier } from "../config.js";
import { git } from "../pipeline/exec.js";
import type { Attempt, Envelope, JobSpec, PipelineDeps } from "../pipeline/index.js";
import { removeWorktree, repoHash } from "../pipeline/worktree.js";
import { modelLabel, poolOf } from "../pools.js";
import { classifyIncident } from "./incidents.js";
import { computeProgress } from "./progress.js";
import type { JobRecord } from "./store.js";
import { firstOpenItem, isSamePath } from "./helpers.js";
import type { JobManagerDeps } from "./manager.js";
import { DelegationPolicy } from "./policy.js";

export interface ExecuteJobContext {
  deps: JobManagerDeps;
  policy?: DelegationPolicy;
  write: (record: JobRecord) => Promise<void>;
  startFollowup: (
    parent: JobRecord,
    feedback: string,
    bypassApproval: boolean,
  ) => Promise<{ state: "running" | "queued"; jobId: string }>;
}

export async function executeJob(
  ctx: ExecuteJobContext,
  record: JobRecord,
  spec: JobSpec,
  signal: AbortSignal,
): Promise<void> {
  const jobStartTime = ctx.deps.now();
  let runStartTime: Date | undefined;
  let lastWriteTime = 0;
  let worktreePath = path.join(
    ctx.deps.pipelineDeps.worktreeRoot,
    repoHash(spec.repoRoot),
    spec.jobId,
  );

  const updateProgressAndSave = async (force: boolean) => {
    const nowMs = ctx.deps.now().getTime();
    if (!force && nowMs - lastWriteTime < 500) {
      return;
    }
    lastWriteTime = nowMs;
    const median = await ctx.deps.ledger.medianRunSec(record.kind);
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
    record.updatedAt = ctx.deps.now().toISOString();
    await ctx.write(record);
  };

  const onPhase = (phase: "prepare" | "contract" | "brief" | "run" | "verify" | "report") => {
    record.progress.phase = phase;
    if (phase === "run" && !runStartTime) {
      runStartTime = ctx.deps.now();
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
      const target = toolSubject(params);
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
      if (ev.usage?.totalTokens) {
        record.progress.tokens = ev.usage.totalTokens;
        changed = true;
      }
      // Gemini ticks the checklist with write_to_file or (more often) replace_file_content.
      if (ev.toolName && /write_to_file|replace_file_content/.test(ev.toolName)) {
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
            record.progress.currentStep = firstOpenItem(content);
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

  const policy =
    ctx.policy ?? new DelegationPolicy(ctx.deps.flags, ctx.deps.approver, ctx.deps.now);
  const tiers = spec.config.tiers;
  const effort = spec.effort ?? spec.config.effort;
  const pd: PipelineDeps = {
    ...ctx.deps.pipelineDeps,
    onPhase,
    onEvent,
    signal,
  };

  // The first configured, non-cooling tier at or above `from` that this job has not tried yet.
  const tried = new Set<Tier>();
  const pickUntried = async (from: Tier | undefined) => {
    while (from) {
      const picked = await policy.pickTier(tiers, from);
      if (!picked) return undefined;
      if (!tried.has(picked.tier)) return picked;
      from = tierAbove(picked.tier);
    }
    return undefined;
  };

  // Each attempt runs from the job's base commit; the final envelope is the last attempt's.
  const attempts: Attempt[] = [];
  let tier: Tier = record.tier ?? "fast";
  let model = spec.config.model;
  let attemptSpec = spec;
  let envelope: Envelope | undefined;
  let runError: unknown;
  let totalSec = 0;
  let totalTokens: number | undefined;
  let quotaPool: string | undefined;
  for (;;) {
    tried.add(tier);
    worktreePath = path.join(
      ctx.deps.pipelineDeps.worktreeRoot,
      repoHash(spec.repoRoot),
      attemptSpec.jobId,
    );
    const variant = modelFor(model, effort);
    let env: Envelope;
    try {
      env = await ctx.deps.runJob(attemptSpec, pd);
    } catch (err) {
      runError = err;
      attempts.push({ tier, model: variant, state: "error" });
      break;
    }
    attempts.push({
      tier,
      model: variant,
      state: env.state,
      ...(env.reason ? { reason: env.reason } : {}),
    });
    envelope = env;
    totalSec += env.durationSec;
    if (env.usage?.totalTokens !== undefined) {
      totalTokens = (totalTokens ?? 0) + env.usage.totalTokens;
    }

    let next: { tier: Tier; model: string } | undefined;
    let failureNote = "";
    if (env.state === "quota") {
      const pool = poolOf(model);
      await policy.markCooling(pool, env.quota?.resetInSec, env.quota?.resetText);
      next = await pickUntried(tier);
      if (!next) quotaPool = pool;
    } else if (env.state === "failed" && spec.kind === "implement" && spec.config.escalate) {
      next = await pickUntried(tierAbove(tier));
      const failures = env.verify?.failures.join(", ") || "see output";
      failureNote =
        `\n\nA previous attempt on ${modelLabel(variant)} failed verification.\n` +
        `Failing tests: ${failures}\n` +
        `Output tail:\n${(env.verify?.outputTail ?? "").slice(-1500)}`;
    }
    if (!next || signal.aborted) break;

    await discardAttempt(env, spec.repoRoot, attemptSpec.jobId);
    record.progress.tokens = 0;
    record.progress.toolSteps = 0;
    tier = next.tier;
    model = next.model;
    attemptSpec = {
      ...spec,
      jobId: `${record.id}-a${attempts.length + 1}`,
      config: { ...spec.config, model },
      conversationId: undefined,
      task: spec.task + failureNote,
    };
  }
  record.attempts = attempts;
  const last = attempts[attempts.length - 1];

  if (runError !== undefined) {
    const reason = runError instanceof Error ? runError.message : String(runError);
    record.state = "error";
    // Found live: a job ended as "error" with no trace of why.
    record.errorReason = reason;
    record.progress.phase = "done";
    record.progress.percent = 100;
    record.progress.elapsedSec = (ctx.deps.now().getTime() - jobStartTime.getTime()) / 1000;
    delete record.progress.etaSec;
    record.updatedAt = ctx.deps.now().toISOString();
    await ctx.write(record);
    await ctx.deps.ledger.append({
      jobId: record.id,
      kind: record.kind,
      state: "error",
      durationSec: record.progress.elapsedSec,
      estimate: record.estimate,
      returnedTokens: 0,
      at: ctx.deps.now().toISOString(),
      tier: last.tier,
      model: last.model,
      attempts,
    });
  } else if (envelope) {
    envelope = { ...envelope, jobId: record.id, attempts };
    const incident = classifyIncident(envelope, { hadParent: !!record.parentJobId });
    if (incident) {
      record.incident = incident;
    } else {
      delete record.incident;
    }
    record.envelope = envelope;
    record.state = envelope.state;
    record.progress.phase = "done";
    record.progress.percent = 100;
    record.progress.elapsedSec = totalSec;
    delete record.progress.etaSec;
    record.updatedAt = ctx.deps.now().toISOString();
    await ctx.write(record);

    const returnedTokens =
      envelope.usage?.outputTokens ?? Math.round((envelope.untrustedReport?.length ?? 0) / 4);
    await ctx.deps.ledger.append({
      jobId: record.id,
      kind: record.kind,
      state: envelope.state,
      durationSec: totalSec,
      runSec: totalSec,
      estimate: record.estimate,
      returnedTokens,
      usageTotal: totalTokens,
      at: ctx.deps.now().toISOString(),
      ...(incident ? { incident } : {}),
      tier: last.tier,
      model: last.model,
      attempts,
    });

    // Every configured tier is out of quota: today's quota card, on the last attempt's pool.
    if (envelope.state === "quota") {
      const choice = await policy.onQuota({
        resetInSec: envelope.quota?.resetInSec,
        resetText: envelope.quota?.resetText,
        pausedJobId: record.id,
        repoRoot: record.repoRoot,
        pool: quotaPool ?? poolOf(model),
      });
      if (choice === "retry") {
        await ctx.startFollowup(
          record,
          "Continue the task; the previous run stopped at a usage limit.",
          true,
        );
      }
    }
  }
}

/** Removes a superseded attempt's worktree and branch. Best effort: a leftover is harmless. */
async function discardAttempt(env: Envelope, repoRoot: string, jobId: string): Promise<void> {
  try {
    if (existsSync(env.worktreePath)) {
      await removeWorktree(
        { path: env.worktreePath, branch: env.branch, baseSha: env.baseSha, repoRoot, jobId },
        { deleteBranch: true },
      );
    } else if (env.branch) {
      await git(["branch", "-D", env.branch], repoRoot);
    }
  } catch {
    // ignore
  }
}
