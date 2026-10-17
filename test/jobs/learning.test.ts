import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobManager, type JobManagerDeps } from "../../src/jobs/manager.js";
import { JobStore } from "../../src/jobs/store.js";
import { Ledger } from "../../src/jobs/ledger.js";
import { FlagStore } from "../../src/jobs/flags.js";
import { FakeApprover } from "../../src/jobs/approver.js";
import { LessonStore } from "../../src/jobs/lessons.js";
import { parseProjectConfig, loadRuntimeConfig } from "../../src/config.js";
import type { Envelope, JobSpec, PipelineDeps } from "../../src/pipeline/index.js";
import { makeRepo, tmpRoot } from "../pipeline/repo.js";

const EST = { directTokens: 20000, delegateOverheadTokens: 4000, reason: "multi-file" };

function setup(o: { approver?: FakeApprover; state?: Envelope["state"]; skill?: boolean } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agyo-learn-"));
  const repo = makeRepo({ "a.txt": "a" });
  const specs: JobSpec[] = [];
  const approver = o.approver ?? new FakeApprover();
  const project = new LessonStore(path.join(dir, "project-lessons.json"));
  const global = new LessonStore(path.join(dir, "global-lessons.json"));
  const skillDir = path.join(dir, "skill");
  if (o.skill) {
    mkdirSync(path.join(skillDir, "references"), { recursive: true });
    for (const f of ["known-issues.md", "prompting.md", "routing.md"])
      writeFileSync(path.join(skillDir, "references", f), `# ${f}\n`);
  }
  const deps: JobManagerDeps = {
    store: new JobStore(path.join(dir, "jobs")),
    ledger: new Ledger(path.join(dir, "ledger.jsonl")),
    flags: new FlagStore(path.join(dir, "flags.json")),
    approver,
    runJob: async (spec: JobSpec, _pd: PipelineDeps) => {
      specs.push(spec);
      return {
        jobId: spec.jobId,
        kind: spec.kind,
        state: o.state ?? "failed",
        branch: `agy/${spec.jobId}`,
        worktreePath: "/w",
        baseSha: "b",
        untrustedReport: "",
        deniedCommands: ["python x.py"],
        guardEvents: [],
        skillsUsed: [],
        model: "gemini-3.8-flash-high",
        durationSec: 1,
        diffStat: " src/db/models.ts | 2 +-\n 1 file changed",
      } as Envelope;
    },
    pipelineDeps: {
      agyRun: (async () => {
        throw new Error("unused");
      }) as never,
      agyCommand: { command: "agy" },
      hookBundlePath: "",
      worktreeRoot: tmpRoot(),
      home: os.homedir(),
      now: () => new Date(),
    },
    loadConfig: () => ({
      project: parseProjectConfig({ test_command: ["node", "-e", "1"] }),
      runtime: loadRuntimeConfig({}),
    }),
    now: () => new Date("2026-10-17T12:00:00Z"),
    lessons: () => ({ project, global }),
    skillDir: () => (o.skill ? skillDir : undefined),
  };
  return { m: new JobManager(deps), repo, specs, approver, project, global, skillDir, deps };
}

describe("learning loop", () => {
  it("records an incident for a non-clean job", async () => {
    const { m, repo } = setup();
    const r = await m.start({ repoRoot: repo, kind: "implement", task: "do", estimate: EST });
    await m.idle();
    const rec = await m.get((r as { jobId: string }).jobId);
    expect(rec?.incident).toMatchObject({ category: "wrong_or_missing_gate" });
    expect(rec?.incident?.evidence).toContain("python x.py");
  });

  it("records no incident for a clean first-try pass", async () => {
    const { m, repo } = setup({ state: "passed" });
    const r = await m.start({ repoRoot: repo, kind: "implement", task: "do", estimate: EST });
    await m.idle();
    expect((await m.get((r as { jobId: string }).jobId))?.incident).toBeUndefined();
  });

  it("stores lessons with job tags and refuses invalid ones", async () => {
    const { m, repo, project } = setup();
    const r = await m.start({ repoRoot: repo, kind: "implement", task: "do", estimate: EST });
    await m.idle();
    const res = await m.act({
      action: "lesson",
      text: "Add python to allowed_commands for data scripts.",
      audience: "orchestrator",
      scope: "project",
      jobId: (r as { jobId: string }).jobId,
    });
    expect(res).toMatchObject({ state: "ok", merged: false });
    const [l] = await project.list();
    expect(l.tags).toEqual(
      expect.arrayContaining([
        "dir:src",
        "file:models.ts",
        "kind:implement",
        "cat:wrong_or_missing_gate",
      ]),
    );
    expect(
      await m.act({
        action: "lesson",
        text: "token: abc",
        audience: "implementer",
        scope: "project",
      }),
    ).toMatchObject({ state: "refused" });
  });

  it("injects implementer lessons into the next brief and shows orchestrator lessons in status", async () => {
    const { m, repo, specs, project, global } = setup({ state: "passed" });
    await project.add({
      text: "Models live in src/db/models.",
      audience: "implementer",
      scope: "project",
    });
    await global.add({
      text: "Never edit generated files in dist/.",
      audience: "implementer",
      scope: "global",
    });
    await project.add({ text: "Keep UI tasks local.", audience: "orchestrator", scope: "project" });
    const r = await m.start({ repoRoot: repo, kind: "implement", task: "do", estimate: EST });
    expect(r).toMatchObject({ lessonsInjected: 2 });
    await m.idle();
    expect(specs[0].lessons).toEqual([
      "Models live in src/db/models.",
      "Never edit generated files in dist/.",
    ]);
    expect((await m.status()).lessons).toEqual(["Keep UI tasks local."]);
  });

  it("proposes a promotion at 3 hits and writes it to the skill when approved", async () => {
    const { m, project, skillDir, approver } = setup({
      skill: true,
      approver: new FakeApprover({ promote: true }),
    });
    const text = "Run the unit test script only; the full script starts e2e and times out.";
    await project.add({
      text,
      audience: "implementer",
      scope: "project",
      tags: ["cat:timeout_too_short"],
    });
    await project.add({ text, audience: "implementer", scope: "project" });
    const res = await m.act({ action: "lesson", text, audience: "implementer", scope: "project" });
    expect(res).toMatchObject({ state: "ok", merged: true, promotion: "approved" });
    expect(approver.calls.filter((c) => c.kind === "promote")).toHaveLength(1);
    expect(readFileSync(path.join(skillDir, "references", "known-issues.md"), "utf8")).toContain(
      `- ${text} _(learned 2026-10-17)_`,
    );
    expect((await project.list())[0].promoted).toBe("2026-10-17");
  });

  it("never edits the skill without approval", async () => {
    const { m, project, skillDir } = setup({
      skill: true,
      approver: new FakeApprover({ promote: false }),
    });
    const text = "Prefer splitting UI work into smaller verifiable steps.";
    await project.add({ text, audience: "orchestrator", scope: "project" });
    await project.add({ text, audience: "orchestrator", scope: "project" });
    expect(
      await m.act({ action: "lesson", text, audience: "orchestrator", scope: "project" }),
    ).toMatchObject({ promotion: "declined" });
    expect(readFileSync(path.join(skillDir, "references", "routing.md"), "utf8")).toBe(
      "# routing.md\n",
    );
  });
});
