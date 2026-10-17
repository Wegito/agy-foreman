// Start-flow helpers for JobManager (task/plan resolution, dry runs, token gating, approval).
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildArgs } from "../agy/run.js";
import type { Config } from "../config.js";
import { renderBrief, RUN_PROMPT } from "../pipeline/brief.js";
import { addContractTests, redCheck, type ContractTest } from "../pipeline/contract.js";
import type { JobSpec } from "../pipeline/index.js";
import { resolveSkills } from "../pipeline/skills.js";
import { createWorktree, removeWorktree } from "../pipeline/worktree.js";
import { ApprovalUnavailable, type TaskCard } from "./approver.js";
import { hashPlan, validGrant } from "./flags.js";
import { tagsFor } from "./lessons.js";
import { parsePlanStep, planTitle } from "./plan.js";
import { emptyProgress, newJobId, type JobRecord } from "./store.js";
import { tokenGate } from "./tokengate.js";
import type { JobManagerDeps, StartInput, StartResult } from "./manager.js";

export type PreparedStart =
  | { type: "result"; result: StartResult }
  | {
      type: "ready";
      record: JobRecord;
      spec: JobSpec;
      config: Config;
      lessonsInjected: number;
    };

export async function prepareStartJob(deps: JobManagerDeps, i: StartInput): Promise<PreparedStart> {
  // 1. Delegation paused
  const flags = await deps.flags.read();
  if (flags.delegationPaused) {
    return {
      type: "result",
      result: {
        state: "refused",
        reason: "delegation is paused; call agy_act resume_delegation to unpause",
      },
    };
  }

  // 2. Cooldown active
  if (flags.cooldownUntil && new Date(flags.cooldownUntil).getTime() > deps.now().getTime()) {
    const choice = await deps.approver.quota({
      resetText: flags.cooldownText,
      resetAt: flags.cooldownUntil,
    });
    if (choice === "retry") {
      await deps.flags.update((f) => {
        delete f.cooldownUntil;
        delete f.cooldownText;
      });
    } else if (choice === "continue_without") {
      await deps.flags.update((f) => {
        f.delegationPaused = true;
      });
      return {
        type: "result",
        result: {
          state: "refused",
          reason: "continue without Gemini",
        },
      };
    } else {
      // "wait" or "unavailable"
      return {
        type: "result",
        result: {
          state: "quota",
          reason: "Gemini quota active",
          quota: {
            resetText: flags.cooldownText,
            resetAt: flags.cooldownUntil,
          },
          options: ["retry", "continue_without", "wait"],
        },
      };
    }
  }

  // 3. Resolve the task
  let task: string;
  let title: string;
  let contractTests: ContractTest[] | undefined;
  let checklist: string[] | undefined;
  let planContent: string | undefined;

  let planFiles: string[] = [];
  if (i.plan) {
    const planPath = path.isAbsolute(i.plan.file)
      ? i.plan.file
      : path.resolve(i.repoRoot, i.plan.file);
    try {
      planContent = await readFile(planPath, "utf8");
    } catch {
      return {
        type: "result",
        result: {
          state: "refused",
          reason: `plan file not found: ${i.plan.file}`,
        },
      };
    }
    try {
      const step = parsePlanStep(planContent, i.plan.step);
      planFiles = step.files;
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
        type: "result",
        result: {
          state: "refused",
          reason: err instanceof Error ? err.message : String(err),
        },
      };
    }
  } else {
    if (!i.task || i.task.trim().length === 0) {
      return {
        type: "result",
        result: {
          state: "refused",
          reason: "task is required when plan is not specified",
        },
      };
    }
    task = i.task;
    const firstLine = i.task.trim().split(/\r?\n/)[0];
    title = firstLine.slice(0, 80);
    contractTests = i.kind === "explore" ? undefined : i.contractTests;
  }

  const lessonTags = tagsFor({ files: planFiles, kind: i.kind });
  let lessonsInjected: string[] = [];
  if (deps.lessons) {
    const stores = deps.lessons(i.repoRoot);
    const projLessons = await stores.project.select("implementer", lessonTags, 5);
    const globLessons = await stores.global.select("implementer", lessonTags, 5);
    const seenTexts = new Set<string>();
    for (const l of projLessons) {
      if (!seenTexts.has(l.text)) {
        seenTexts.add(l.text);
        lessonsInjected.push(l.text);
        if (lessonsInjected.length === 5) break;
      }
    }
    if (lessonsInjected.length < 5) {
      for (const l of globLessons) {
        if (!seenTexts.has(l.text)) {
          seenTexts.add(l.text);
          lessonsInjected.push(l.text);
          if (lessonsInjected.length === 5) break;
        }
      }
    }
  }

  // 4. Token gate (implement only, skipped on dry run)
  const config = deps.loadConfig(i.repoRoot);
  if (i.kind === "implement" && !i.dryRun) {
    const gateResult = tokenGate(i.estimate, config.project.refuseRatio);
    if (gateResult.refuse) {
      return {
        type: "result",
        result: {
          state: "refused",
          reason: gateResult.reason!,
        },
      };
    }
  }

  // 5. Dry run
  if (i.dryRun) {
    let resolvedSkills: { name: string; claudeOnlyRefs: string[]; description: string }[] = [];
    if (i.skills && i.skills.length > 0) {
      const res = await resolveSkills(i.skills, config.project.skillRoots, {
        repoRoot: i.repoRoot,
        home: deps.pipelineDeps.home,
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
      date: deps.now().toISOString().slice(0, 10),
      testCommand: config.project.testCommand,
      skills: resolvedSkills.map((s) => ({ name: s.name, description: s.description })),
      ...(lessonsInjected.length > 0 ? { lessons: lessonsInjected } : {}),
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
        agy: deps.pipelineDeps.agyCommand,
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
        root: deps.pipelineDeps.worktreeRoot,
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
      type: "result",
      result: {
        state: "dry_run",
        brief,
        command,
        skills: resolvedSkills.map((s) => ({
          name: s.name,
          claudeOnlyRefs: s.claudeOnlyRefs,
        })),
        contractTests: contractTestPaths,
        ...(redOnBase !== undefined ? { redOnBase } : {}),
      },
    };
  }

  // 6. Approval
  try {
    if (i.plan && config.project.approval === "per_plan") {
      const planFile = i.plan.file;
      const hash = hashPlan(planContent!);
      const currentFlags = await deps.flags.read();
      const grant = validGrant(currentFlags, planFile, hash, deps.now());
      if (!grant) {
        const pTitle = planTitle(planContent!);
        const steps = i.plan.delegateSteps ?? [i.plan.step];
        const approved = await deps.approver.plan({
          planFile,
          title: pTitle,
          steps,
          estimate: i.estimate,
        });
        if (!approved) {
          return { type: "result", result: { state: "denied", reason: "plan approval denied" } };
        }
        const expiresAt = new Date(deps.now().getTime() + 24 * 60 * 60 * 1000).toISOString();
        await deps.flags.update((f) => {
          f.grants.push({
            file: planFile,
            hash,
            steps,
            approvedAt: deps.now().toISOString(),
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
      const approved = await deps.approver.task(taskCard);
      if (!approved) {
        return { type: "result", result: { state: "denied", reason: "task approval denied" } };
      }
    }
  } catch (err: unknown) {
    if (
      err instanceof ApprovalUnavailable ||
      (err instanceof Error && err.name === "ApprovalUnavailable")
    ) {
      return { type: "result", result: { state: "refused", reason: (err as Error).message } };
    }
    throw err;
  }

  // 7. Create the record
  const jobId = newJobId(deps.now());
  const record: JobRecord = {
    id: jobId,
    kind: i.kind,
    repoRoot: i.repoRoot,
    title,
    state: "queued",
    // Seed the checklist so the status line shows "1/N <task>" before Gemini's first tick.
    progress: checklist
      ? { ...emptyProgress(), checklistTotal: checklist.length, currentStep: checklist[0] }
      : emptyProgress(),
    createdAt: deps.now().toISOString(),
    updatedAt: deps.now().toISOString(),
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
    ...(lessonsInjected.length > 0 ? { lessons: lessonsInjected } : {}),
    effort: i.effort ?? config.project.effort,
    baseRef: i.baseRef,
    timeoutSec: i.timeoutSec ?? config.runtime.defaultTimeoutSec,
    config: config.project,
    runtime: config.runtime,
  };

  return {
    type: "ready",
    record,
    spec,
    config,
    lessonsInjected: lessonsInjected.length,
  };
}
