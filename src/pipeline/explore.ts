// Execution pipeline for explore jobs (detached worktree, schema-guided plan, citation verification).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Outcome, StreamEvent } from "../agy/types.js";
import { renderBrief, RUN_PROMPT, EXPLORE_SCHEMA, type BriefInput } from "./brief.js";
import { installGate, type GatePolicy } from "./gate.js";
import { makeGuard } from "./guard.js";
import { installSkills, resolveSkills, type ResolvedSkill } from "./skills.js";
import { createWorktree, excludeInRepo, removeWorktree } from "./worktree.js";
import type { Citation, Envelope, JobSpec, JobState, PipelineDeps } from "./index.js";
import {
  fenceUntrusted,
  getDeniedCommands,
  makeUntrustedReport,
  mapFailureOutcome,
} from "./envelope-build.js";

export async function runExploreJob(
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

  let jobState: JobState = "error";
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

  const failure = mapFailureOutcome(outcome, guardEvents);
  if (failure) {
    jobState = failure.jobState;
    jobReason = failure.jobReason;
    quotaData = failure.quotaData;
  } else if (outcome.type === "success") {
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

  const untrustedReport = makeUntrustedReport(outcome);
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
