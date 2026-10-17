// Shared pipeline execution skeleton for implement and explore jobs.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Outcome, StreamEvent } from "../agy/types.js";
import { renderBrief, renderProgress, RUN_PROMPT, type BriefInput } from "./brief.js";
import { installGate, type GatePolicy } from "./gate.js";
import { makeGuard } from "./guard.js";
import { installSkills, resolveSkills, SkillError, type ResolvedSkill } from "./skills.js";
import { createWorktree, excludeInRepo, removeWorktree, type Worktree } from "./worktree.js";
import { buildEnvelope } from "./envelope-build.js";
import type { Envelope, JobSpec, PipelineDeps } from "./index.js";

export interface ExtraPolicySettings {
  protectedGlobs?: string[];
  allowedCommands?: string[];
  readOnlyDirs?: string[];
}

export interface GatedRunOptions {
  prompt?: string;
  mode?: "accept-edits" | "plan";
  briefText?: string | ((skills: ResolvedSkill[]) => string);
  extraPolicySettings?: ExtraPolicySettings;
  jsonSchema?: Record<string, unknown>;
  jsonSchemaPath?: string;
  detached?: boolean;
  beforeRun?: (wt: Worktree) => Promise<Envelope | void>;
  getContractInfo?: () => { redOnBase: boolean; greenAfter: boolean } | undefined;
}

export interface GatedRunOutput {
  outcome: Outcome;
  worktree: Worktree;
  wt: Worktree;
  guardEvents: string[];
  skillsUsed: string[];
  nonce: string;
}

export type GatedRunResult = GatedRunOutput | Envelope;

export async function gatedRun(
  specOrOptions: JobSpec | (GatedRunOptions & { spec: JobSpec; deps: PipelineDeps; startTime: Date }),
  depsMaybe?: PipelineDeps,
  startTimeMaybe?: Date,
  optionsMaybe?: GatedRunOptions,
): Promise<GatedRunResult> {
  let spec: JobSpec;
  let deps: PipelineDeps;
  let startTime: Date;
  let options: GatedRunOptions;

  if (depsMaybe && startTimeMaybe) {
    spec = specOrOptions as JobSpec;
    deps = depsMaybe;
    startTime = startTimeMaybe;
    options = optionsMaybe ?? {};
  } else {
    const opts = specOrOptions as GatedRunOptions & {
      spec: JobSpec;
      deps: PipelineDeps;
      startTime: Date;
    };
    spec = opts.spec;
    deps = opts.deps;
    startTime = opts.startTime;
    options = opts;
  }

  const wt = await createWorktree({
    repoRoot: spec.repoRoot,
    jobId: spec.jobId,
    root: deps.worktreeRoot,
    baseRef: spec.baseRef,
    detached: options.detached,
  });

  try {
    await excludeInRepo(spec.repoRoot, [".agents/", ".agy-task/"]);
    mkdirSync(path.join(wt.path, ".agy-task"), { recursive: true });

    if (options.beforeRun) {
      const early = await options.beforeRun(wt);
      if (early) {
        return early;
      }
    }

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
          if (spec.kind === "explore") {
            try {
              await removeWorktree(wt);
            } catch {
              // ignore
            }
          }
          return buildEnvelope(spec, deps, startTime, {
            state: "refused",
            reason: (err as Error).message,
            branch: wt.branch,
            worktreePath: wt.path,
            baseSha: wt.baseSha,
            contract: options.getContractInfo?.(),
          });
        }
        throw err;
      }
    }

    let briefContent: string;
    if (typeof options.briefText === "function") {
      briefContent = options.briefText(resolvedSkills);
    } else if (typeof options.briefText === "string") {
      briefContent = options.briefText;
    } else {
      const briefInput: BriefInput = {
        kind: spec.kind,
        task: spec.task,
        date: deps.now().toISOString().slice(0, 10),
        touch: spec.touch,
        leaveUntouched: spec.leaveUntouched,
        testCommand: spec.config.testCommand,
        skills: resolvedSkills.map((s) => ({ name: s.name, description: s.description })),
        lessons: spec.lessons,
        checklist: spec.checklist,
      };
      briefContent = renderBrief(briefInput);
    }
    writeFileSync(path.join(wt.path, ".agy-task", "brief.md"), briefContent, "utf8");

    if (spec.checklist && spec.checklist.length > 0) {
      writeFileSync(
        path.join(wt.path, ".agy-task", "progress.md"),
        renderProgress(spec.checklist),
        "utf8",
      );
    }

    let jsonSchemaPath = options.jsonSchemaPath;
    if (!jsonSchemaPath && options.jsonSchema) {
      const p = path.join(wt.path, ".agy-task", "report.schema.json");
      writeFileSync(p, JSON.stringify(options.jsonSchema, null, 2), "utf8");
      jsonSchemaPath = p;
    }

    const policy: GatePolicy = {
      mode: options.mode ?? (spec.kind === "explore" ? "explore" : "implement"),
      worktree: wt.path,
      readOnlyDirs: options.extraPolicySettings?.readOnlyDirs ?? [],
      protectedGlobs: [
        ...spec.config.protectedPaths,
        ...(options.extraPolicySettings?.protectedGlobs ?? []),
      ],
      allowedCommands: [
        ...(options.extraPolicySettings?.allowedCommands ?? []),
      ],
      unknownCommands: spec.config.unknownCommands,
      allowedMcp: spec.config.allowedMcp,
      web: spec.config.web,
    };

    await installGate(wt.path, policy, deps.hookBundlePath);

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
        prompt: options.prompt ?? RUN_PROMPT,
        cwd: wt.path,
        model: spec.config.model,
        effort: spec.effort ?? spec.config.effort,
        mode: options.mode ?? (spec.kind === "explore" ? "plan" : "accept-edits"),
        jsonSchemaPath,
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

    const nonce = randomBytes(4).toString("hex");

    return {
      outcome,
      worktree: wt,
      wt,
      guardEvents,
      skillsUsed,
      nonce,
    };
  } catch (err: unknown) {
    try {
      await removeWorktree(wt);
    } catch {
      // ignore
    }
    throw err;
  }
}
