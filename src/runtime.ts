import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./agy/index.js";
import { loadConfig, loadRuntimeConfig } from "./config.js";
import { type Approver } from "./jobs/approver.js";
import { FlagStore } from "./jobs/flags.js";
import { Ledger } from "./jobs/ledger.js";
import { LessonStore } from "./jobs/lessons.js";
import { JobManager, type JobManagerDeps } from "./jobs/manager.js";
import { JobStore } from "./jobs/store.js";
import { jobsDir, stateDir, worktreeRoot } from "./paths.js";
import { runJob } from "./pipeline/index.js";

export function hookBundlePath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "agyo-hook.js");
}

export function createRuntime(o: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  approverFor: (gate: "elicitation" | "client") => Approver;
}): { manager: JobManager; store: JobStore } {
  const store = new JobStore(jobsDir({ env: o.env }));
  const sDir = stateDir({ env: o.env });
  const ledger = new Ledger(path.join(sDir, "ledger.jsonl"));
  const flags = new FlagStore(path.join(sDir, "flags.json"));

  const approver: Approver = {
    plan: (c) => {
      const gate = loadConfig({ repoRoot: o.cwd, env: o.env }).project.gate;
      return o.approverFor(gate).plan(c);
    },
    task: (c) => {
      const gate = loadConfig({ repoRoot: o.cwd, env: o.env }).project.gate;
      return o.approverFor(gate).task(c);
    },
    quota: (c) => {
      const gate = loadConfig({ repoRoot: o.cwd, env: o.env }).project.gate;
      return o.approverFor(gate).quota(c);
    },
    promote: (c) => {
      const gate = loadConfig({ repoRoot: o.cwd, env: o.env }).project.gate;
      return o.approverFor(gate).promote(c);
    },
  };

  const runtimeCfg = loadRuntimeConfig(o.env);

  const deps: JobManagerDeps = {
    store,
    ledger,
    flags,
    approver,
    runJob,
    pipelineDeps: {
      agyRun: run,
      agyCommand: {
        command: runtimeCfg.agyPath,
      },
      hookBundlePath: hookBundlePath(),
      worktreeRoot: worktreeRoot({ env: o.env }),
      home: os.homedir(),
      now: () => new Date(),
    },
    loadConfig: (repoRoot: string) => loadConfig({ repoRoot, env: o.env }),
    now: () => new Date(),
    lessons: (repoRoot: string) => ({
      project: new LessonStore(path.join(repoRoot, ".agy-orchestrator", "lessons.json")),
      global: new LessonStore(path.join(sDir, "lessons.json")),
    }),
    skillDir: (repoRoot: string) => {
      const candidates = [
        path.join(repoRoot, ".claude", "skills", "gemini-delegation"),
        path.join(os.homedir(), ".claude", "skills", "gemini-delegation"),
      ];
      for (const cand of candidates) {
        if (existsSync(cand)) return cand;
      }
      return undefined;
    },
  };

  const manager = new JobManager(deps);
  return { manager, store };
}
