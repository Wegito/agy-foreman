# agy-orchestrator Plan 4: Learning Loop and Skill, Implementation Plan

> **For agentic workers:** this plan is executed **through agy-orchestrator itself** (`agy_start` with `plan: {file, step}`). Each task's test files are the contract tests: the pipeline commits them first, checks they fail, and verifies they pass after the run. Implementers write `src/` and docs only. Test files are protected.

**Goal:** Failures become lessons that improve future runs (capture → reflect → store → apply → promote, spec §8), and Claude (or any agent) gets the `gemini-delegation` skill that explains when and how to delegate (spec §9), plus an `install-skill` CLI command.

**Architecture:**
- `src/jobs/incidents.ts` (pure classification) and `src/jobs/lessons.ts` (`LessonStore`, JSON-backed with a rendered Markdown view) are new internal parts of the `jobs` module.
- `JobManager` records an incident per non-clean job, accepts `lesson` actions, injects implementer lessons into briefs, shows orchestrator lessons in status, and proposes promotions through a new `Approver.promote` card.
- The skill is plain Markdown under `skills/gemini-delegation/`.

**Tech Stack:** unchanged.

## Global Constraints
- All earlier Global Constraints apply.
- Lessons are 1–2 sentences, at most 300 characters (longer text is rejected with a reason). Lessons never contain secrets: reject text matching `/(api[_-]?key|token|password|secret)\s*[:=]/i`.
- Project lessons live in `<repo>/.agy-orchestrator/lessons.json` (meant to be committable), global ones in `<stateDir>/lessons.json`.
- The skill is never changed without an approved promotion card.
- Skill docs must not contain hard word or length limits for Gemini briefs, must not mention account switching, and must state facts from the spec (Gemini 3.8 Flash only, effort low/medium/high, once-per-plan approval, gate, contract tests).

---

### Task 1: Incidents and the lesson store

**Files:**
- Create: `src/jobs/incidents.ts`, `src/jobs/lessons.ts`
- Test: `test/jobs/incidents.test.ts`, `test/jobs/lessons.test.ts`

**Interfaces:**
```ts
// incidents.ts
import type { Envelope } from "../pipeline/index.js";
export type IncidentCategory =
  | "brief_missing_context" | "wrong_or_missing_gate" | "scope_creep" | "protected_file_attempt" | "test_tampering"
  | "contract_too_weak" | "env_setup" | "timeout_too_short" | "task_too_big" | "skill_mismatch" | "quota" | "agy_error";
export interface Incident { category: IncidentCategory; evidence: string }
export function classifyIncident(e: Envelope, o: { hadParent: boolean }): Incident | null;

// lessons.ts
export type Audience = "implementer" | "orchestrator";
export interface Lesson {
  id: string; text: string; audience: Audience; scope: "project" | "global"; tags: string[];
  hits: number; createdAt: string; lastHitAt: string; promoted?: string; archived?: boolean;
}
export const MAX_ACTIVE: 30;
export class LessonError extends Error {}
export function similar(a: string, b: string): boolean;
export function tagsFor(i: { files?: string[]; kind?: string; category?: string }): string[];
export class LessonStore {
  constructor(file: string, now?: () => Date);
  add(i: { text: string; audience: Audience; scope: "project" | "global"; tags?: string[] }): Promise<{ lesson: Lesson; merged: boolean }>;
  list(o?: { includeArchived?: boolean }): Promise<Lesson[]>;
  select(audience: Audience, tags: string[], n?: number): Promise<Lesson[]>;
  markPromoted(id: string, date: string): Promise<void>;
  renderMarkdown(): Promise<string>;
}
```

**Implementation notes:**
- `classifyIncident` rules, first match wins:
  1. `passed` and not `hadParent` → `null`.
  2. `passed` and `hadParent` → `brief_missing_context` ("passed only after follow-up").
  3. `guard_violation` → `protected_file_attempt` if any guard event mentions `protected`, else `scope_creep`.
  4. `verify.protectedRestored` non-empty → `test_tampering` (evidence lists them).
  5. `verify.auditFlags` contains `skip` or `process-exit` → `test_tampering`.
  6. `quota` → `quota`.
  7. `timeout` → `timeout_too_short`.
  8. `refused`: reason matches `/already pass/` → `contract_too_weak`; `/skill/` → `skill_mismatch`; otherwise `wrong_or_missing_gate`.
  9. `error`: reason matches `/setup_command/` → `env_setup`, otherwise `agy_error`.
  10. `failed` with `deniedCommands` non-empty → `wrong_or_missing_gate` (evidence lists them).
  11. `failed` with `verify.fewerTests` or `verify.newSkips > 0` → `test_tampering`.
  12. `failed` with more than 15 files in `diffStat` (count lines containing `|`) → `task_too_big`.
  13. `failed` → `brief_missing_context` (evidence = the first three `verify.failures`).
  14. Anything else (e.g. `cancelled`) → `null`.

  Evidence is at most 300 chars.
- `similar`: lowercase, split on non-letters/digits, keep words of ≥ 3 chars. Jaccard index of the word sets ≥ 0.6.
- `tagsFor`: for each file, `dir:<first path segment>` and `file:<basename>`; plus `kind:<kind>`; plus `cat:<category>`. Deduplicated, in that order.
- `LessonStore.add`:
  - Validate (non-empty after trim, ≤ 300 chars, no secret pattern) → `LessonError`.
  - If an active lesson with the same audience and `similar` text exists → `hits += 1`, `lastHitAt = now`, merge tags, return `merged: true`.
  - Otherwise create one (`id = "l-" + 8 hex`, `hits = 1`).
  - If there are more than `MAX_ACTIVE` active lessons, archive the one with the fewest hits (oldest `lastHitAt` breaks ties).
  - Persist atomically (temp + rename), creating the directory.
- `select`: active lessons of that audience, ranked by `10 × (number of shared tags) + hits` descending, newest `lastHitAt` breaking ties. Top `n` (default 5).
- `renderMarkdown`: `# Lessons` then one section per audience (`## For Gemini (implementer)`, `## For the orchestrator`) with `- <text> _(hits: N[, promoted DATE])_` lines. Archived lessons are omitted.

- [ ] **Step 1: Contract tests**

`test/jobs/incidents.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { classifyIncident } from "../../src/jobs/incidents.js";
import type { Envelope } from "../../src/pipeline/index.js";

const base: Envelope = {
  jobId: "t-1", kind: "implement", state: "failed", branch: "agy/t-1", worktreePath: "/w", baseSha: "b",
  untrustedReport: "", deniedCommands: [], guardEvents: [], skillsUsed: [], model: "gemini-3.8-flash-high", durationSec: 1,
};
const verify = (o: object) => ({ exitCode: 1, timedOut: false, passed: false, newSkips: 0, fewerTests: false, protectedRestored: [], tamper: [], auditFlags: [], failures: [], outputTail: "", ...o });
const cat = (e: Partial<Envelope>, hadParent = false) => classifyIncident({ ...base, ...e } as Envelope, { hadParent })?.category ?? null;

describe("classifyIncident", () => {
  it("ignores clean first-try passes and cancellations", () => {
    expect(cat({ state: "passed" })).toBeNull();
    expect(cat({ state: "cancelled" })).toBeNull();
  });
  it("flags passes that needed a follow-up", () => {
    expect(cat({ state: "passed" }, true)).toBe("brief_missing_context");
  });
  it("classifies guard violations", () => {
    expect(cat({ state: "guard_violation", guardEvents: ["guard: write_to_file tests/a.ts: protected path"] })).toBe("protected_file_attempt");
    expect(cat({ state: "guard_violation", guardEvents: ["guard: run_command git push: Dangerous command"] })).toBe("scope_creep");
  });
  it("detects tampering signals", () => {
    expect(cat({ verify: verify({ protectedRestored: ["test/a.test.ts"] }) as never })).toBe("test_tampering");
    expect(cat({ verify: verify({ auditFlags: ["skip"] }) as never })).toBe("test_tampering");
    expect(cat({ verify: verify({ newSkips: 1 }) as never })).toBe("test_tampering");
  });
  it("maps quota, timeout, refusals and errors", () => {
    expect(cat({ state: "quota" })).toBe("quota");
    expect(cat({ state: "timeout" })).toBe("timeout_too_short");
    expect(cat({ state: "refused", reason: "contract tests already pass on base" })).toBe("contract_too_weak");
    expect(cat({ state: "refused", reason: "skill not found: tdd" })).toBe("skill_mismatch");
    expect(cat({ state: "refused", reason: "no test_command configured" })).toBe("wrong_or_missing_gate");
    expect(cat({ state: "error", reason: "setup_command failed (exit 1): x" })).toBe("env_setup");
    expect(cat({ state: "error", reason: "agy returned an empty response" })).toBe("agy_error");
  });
  it("classifies failures by evidence", () => {
    expect(cat({ deniedCommands: ["python x.py"], verify: verify({}) as never })).toBe("wrong_or_missing_gate");
    const big = Array.from({ length: 16 }, (_, i) => ` src/f${i}.ts | 1 +`).join("\n") + "\n 16 files changed";
    expect(cat({ diffStat: big, verify: verify({}) as never })).toBe("task_too_big");
    const inc = classifyIncident({ ...base, verify: verify({ failures: ["a > b", "c > d", "e > f", "g > h"] }) as never }, { hadParent: false });
    expect(inc?.category).toBe("brief_missing_context");
    expect(inc?.evidence).toContain("a > b");
    expect(inc?.evidence).not.toContain("g > h");
  });
});
```

`test/jobs/lessons.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LessonStore, LessonError, similar, tagsFor, MAX_ACTIVE } from "../../src/jobs/lessons.js";

const store = (now = () => new Date("2026-10-17T12:00:00Z")) =>
  new LessonStore(path.join(mkdtempSync(path.join(os.tmpdir(), "agyo-les-")), "sub", "lessons.json"), now);

describe("similar and tagsFor", () => {
  it("treats near-duplicates as similar", () => {
    expect(similar("Run pnpm test:unit; pnpm test starts e2e and times out.", "run pnpm test:unit because pnpm test starts e2e and times out")).toBe(true);
    expect(similar("Models live in src/db/models.", "UI tasks without visual tests fail; keep them local.")).toBe(false);
  });
  it("derives tags from files, kind and category", () => {
    expect(tagsFor({ files: ["src/db/models.ts", "src/api.ts"], kind: "implement", category: "test_tampering" }))
      .toEqual(["dir:src", "file:models.ts", "file:api.ts", "kind:implement", "cat:test_tampering"]);
  });
});

describe("LessonStore", () => {
  it("adds, merges duplicates and counts hits", async () => {
    const s = store();
    const a = await s.add({ text: "Run pnpm test:unit; pnpm test starts e2e and times out.", audience: "implementer", scope: "project", tags: ["cat:timeout_too_short"] });
    expect(a).toMatchObject({ merged: false, lesson: { hits: 1, id: expect.stringMatching(/^l-[0-9a-f]{8}$/) } });
    const b = await s.add({ text: "run pnpm test:unit because pnpm test starts e2e and times out", audience: "implementer", scope: "project", tags: ["dir:test"] });
    expect(b).toMatchObject({ merged: true, lesson: { id: a.lesson.id, hits: 2 } });
    expect(b.lesson.tags.sort()).toEqual(["cat:timeout_too_short", "dir:test"]);
    expect(await s.list()).toHaveLength(1);
  });
  it("keeps audiences apart and validates text", async () => {
    const s = store();
    await s.add({ text: "Keep UI tasks local.", audience: "orchestrator", scope: "global" });
    await s.add({ text: "Keep UI tasks local.", audience: "implementer", scope: "global" });
    expect(await s.list()).toHaveLength(2);
    await expect(s.add({ text: " ", audience: "implementer", scope: "global" })).rejects.toBeInstanceOf(LessonError);
    await expect(s.add({ text: "x".repeat(301), audience: "implementer", scope: "global" })).rejects.toBeInstanceOf(LessonError);
    await expect(s.add({ text: "Use api_key: abc123 for staging", audience: "implementer", scope: "global" })).rejects.toBeInstanceOf(LessonError);
  });
  it("selects by shared tags, then hits", async () => {
    const s = store();
    await s.add({ text: "Models live in src/db/models, not models/.", audience: "implementer", scope: "project", tags: ["dir:src", "file:models.ts"] });
    const often = await s.add({ text: "Always run npm run typecheck before finishing.", audience: "implementer", scope: "project" });
    await s.add({ text: "always run npm run typecheck before you finish", audience: "implementer", scope: "project" });
    await s.add({ text: "Prefer small diffs for orchestrator review.", audience: "orchestrator", scope: "project", tags: ["dir:src"] });
    const sel = await s.select("implementer", ["dir:src", "file:models.ts"], 5);
    expect(sel.map((l) => l.text)).toEqual(["Models live in src/db/models, not models/.", often.lesson.text]);
    expect(await s.select("implementer", [], 1)).toHaveLength(1);
  });
  it("archives the weakest lesson beyond MAX_ACTIVE and persists", async () => {
    let t = 0;
    const s = store(() => new Date(Date.UTC(2026, 9, 17, 12, 0, t++)));
    for (let i = 0; i < MAX_ACTIVE + 1; i++) await s.add({ text: `Unique lesson number ${i} about module m${i}x${i * 7}.`, audience: "implementer", scope: "project" });
    expect(await s.list()).toHaveLength(MAX_ACTIVE);
    expect(await s.list({ includeArchived: true })).toHaveLength(MAX_ACTIVE + 1);
    expect((await s.list()).some((l) => l.text.includes("number 0 "))).toBe(false);
  });
  it("marks promotions and renders markdown", async () => {
    const s = store();
    const { lesson } = await s.add({ text: "Models live in src/db/models.", audience: "implementer", scope: "project" });
    await s.add({ text: "Keep UI tasks local.", audience: "orchestrator", scope: "project" });
    await s.markPromoted(lesson.id, "2026-10-20");
    const md = await s.renderMarkdown();
    expect(md).toContain("# Lessons");
    expect(md).toContain("## For Gemini (implementer)");
    expect(md).toContain("- Models live in src/db/models. _(hits: 1, promoted 2026-10-20)_");
    expect(md).toContain("## For the orchestrator");
  });
});
```

- [ ] **Step 2:** implement until the contract passes. Leave work uncommitted.

---

### Task 2: Learning loop in `JobManager` and the MCP `lesson` action

**Files:**
- Modify: `src/jobs/store.ts` (add `incident?: Incident` to `JobRecord`), `src/jobs/approver.ts` (add `promote`), `src/jobs/manager.ts`, `src/server.ts`, `src/runtime.ts`
- Test: `test/jobs/learning.test.ts`, `test/server-lesson.test.ts`

**Interfaces:**
```ts
// approver.ts additions
export interface PromoteCard { lessonText: string; hits: number; targetFile: string }
export function promoteCardText(c: PromoteCard): string;   // `Add a learned rule to the gemini-delegation skill?\n"<text>" (seen <hits>×)\n→ <targetFile>`
// Approver gains: promote(c: PromoteCard): Promise<boolean>;
// ClientModeApprover.promote → false (no card possible; status lists it as a suggestion).
// FakeApprover answers gain `promote?: boolean` (default false). ElicitationApprover.promote uses the same approve/deny form as plan/task.

// manager.ts additions
export interface JobManagerDeps {
  // …existing fields…
  lessons?: (repoRoot: string) => { project: LessonStore; global: LessonStore };
  skillDir?: (repoRoot: string) => string | undefined;   // installed gemini-delegation folder, if any
}
// ActInput gains: { action: "lesson"; text: string; audience: Audience; scope: "project" | "global"; tags?: string[]; jobId?: string }
```

**Behaviour:**
- **On job finish:** `incident = classifyIncident(envelope, { hadParent: !!rec.parentJobId })`, stored on the record and appended to the ledger entry as `incident`.
- **`act({action: "lesson"})`:**
  - Tags = given tags plus, when `jobId` is given, `tagsFor({files: changed files from the job's diffStat, kind, category: incident?.category})`. Add to the project or global store.
  - Return `{state: "ok", lesson, merged, promotion?: "approved" | "declined" | "suggested"}`.
  - `LessonError` → `{state: "refused", reason}`.
- **Promotion:** after a lesson add, when `lesson.hits >= 3`, it isn't promoted yet, and `skillDir(repoRoot)` is defined:
  - Target file = `<skillDir>/references/known-issues.md` for implementer lessons tagged `cat:test_tampering|cat:protected_file_attempt|cat:env_setup|cat:agy_error|cat:timeout_too_short|cat:quota`, `<skillDir>/references/prompting.md` for other implementer lessons, and `<skillDir>/references/routing.md` for orchestrator lessons.
  - Call `approver.promote(...)`. Approved → append `\n- ${text} _(learned ${YYYY-MM-DD})_\n` to the target file, `markPromoted`, and return `"approved"`. Declined with a card → `"declined"`. `ClientModeApprover` → `"suggested"`.
- **Injection on start (implement and explore):**
  - `spec.lessons` = up to 5 implementer lessons: project `select` first, then global, deduplicated by text.
  - Tags come from `tagsFor({files: plan step files or [], kind})`.
  - Also return `lessonsInjected: number` on the `running`/`queued` start result.
- **`status`** adds `lessons: string[]`: the top 5 orchestrator lesson texts (project first, then global, selected with no tags).
- **Server:**
  - `agy_act` accepts `action: "lesson"` with `text`, `audience`, `scope`, `tags?`, `job_id?`, mapped to the manager.
  - The tool-schema budget (< 1,500 tokens) must still hold.
- **Runtime:**
  - `lessons` uses `<repo>/.agy-orchestrator/lessons.json` and `<stateDir>/lessons.json`.
  - `skillDir` returns the first existing `<repo>/.claude/skills/gemini-delegation` or `<home>/.claude/skills/gemini-delegation`.

- [ ] **Step 1: Contract tests**

`test/jobs/learning.test.ts`:
```ts
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
    for (const f of ["known-issues.md", "prompting.md", "routing.md"]) writeFileSync(path.join(skillDir, "references", f), `# ${f}\n`);
  }
  const deps: JobManagerDeps = {
    store: new JobStore(path.join(dir, "jobs")), ledger: new Ledger(path.join(dir, "ledger.jsonl")), flags: new FlagStore(path.join(dir, "flags.json")), approver,
    runJob: async (spec: JobSpec, _pd: PipelineDeps) => {
      specs.push(spec);
      return { jobId: spec.jobId, kind: spec.kind, state: o.state ?? "failed", branch: `agy/${spec.jobId}`, worktreePath: "/w", baseSha: "b",
        untrustedReport: "", deniedCommands: ["python x.py"], guardEvents: [], skillsUsed: [], model: "gemini-3.8-flash-high", durationSec: 1,
        diffStat: " src/db/models.ts | 2 +-\n 1 file changed" } as Envelope;
    },
    pipelineDeps: { agyRun: (async () => { throw new Error("unused"); }) as never, agyCommand: { command: "agy" }, hookBundlePath: "", worktreeRoot: tmpRoot(), home: os.homedir(), now: () => new Date() },
    loadConfig: () => ({ project: parseProjectConfig({ test_command: ["node", "-e", "1"] }), runtime: loadRuntimeConfig({}) }),
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
    const res = await m.act({ action: "lesson", text: "Add python to allowed_commands for data scripts.", audience: "orchestrator", scope: "project", jobId: (r as { jobId: string }).jobId });
    expect(res).toMatchObject({ state: "ok", merged: false });
    const [l] = await project.list();
    expect(l.tags).toEqual(expect.arrayContaining(["dir:src", "file:models.ts", "kind:implement", "cat:wrong_or_missing_gate"]));
    expect(await m.act({ action: "lesson", text: "token: abc", audience: "implementer", scope: "project" })).toMatchObject({ state: "refused" });
  });

  it("injects implementer lessons into the next brief and shows orchestrator lessons in status", async () => {
    const { m, repo, specs, project, global } = setup({ state: "passed" });
    await project.add({ text: "Models live in src/db/models.", audience: "implementer", scope: "project" });
    await global.add({ text: "Never edit generated files in dist/.", audience: "implementer", scope: "global" });
    await project.add({ text: "Keep UI tasks local.", audience: "orchestrator", scope: "project" });
    const r = await m.start({ repoRoot: repo, kind: "implement", task: "do", estimate: EST });
    expect(r).toMatchObject({ lessonsInjected: 2 });
    await m.idle();
    expect(specs[0].lessons).toEqual(["Models live in src/db/models.", "Never edit generated files in dist/."]);
    expect((await m.status()).lessons).toEqual(["Keep UI tasks local."]);
  });

  it("proposes a promotion at 3 hits and writes it to the skill when approved", async () => {
    const { m, project, skillDir, approver } = setup({ skill: true, approver: new FakeApprover({ promote: true }) });
    const text = "Run the unit test script only; the full script starts e2e and times out.";
    await project.add({ text, audience: "implementer", scope: "project", tags: ["cat:timeout_too_short"] });
    await project.add({ text, audience: "implementer", scope: "project" });
    const res = await m.act({ action: "lesson", text, audience: "implementer", scope: "project" });
    expect(res).toMatchObject({ state: "ok", merged: true, promotion: "approved" });
    expect(approver.calls.filter((c) => c.kind === "promote")).toHaveLength(1);
    expect(readFileSync(path.join(skillDir, "references", "known-issues.md"), "utf8")).toContain(`- ${text} _(learned 2026-10-17)_`);
    expect((await project.list())[0].promoted).toBe("2026-10-17");
  });

  it("never edits the skill without approval", async () => {
    const { m, project, skillDir } = setup({ skill: true, approver: new FakeApprover({ promote: false }) });
    const text = "Prefer splitting UI work into smaller verifiable steps.";
    await project.add({ text, audience: "orchestrator", scope: "project" });
    await project.add({ text, audience: "orchestrator", scope: "project" });
    expect(await m.act({ action: "lesson", text, audience: "orchestrator", scope: "project" })).toMatchObject({ promotion: "declined" });
    expect(readFileSync(path.join(skillDir, "references", "routing.md"), "utf8")).toBe("# routing.md\n");
  });
});
```

`test/server-lesson.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { JobManager } from "../src/jobs/manager.js";
import { promoteCardText } from "../src/jobs/approver.js";

describe("agy_act lesson", () => {
  it("maps the lesson action and keeps the schema budget", async () => {
    const log: unknown[] = [];
    const manager = { act: async (i: unknown) => { log.push(i); return { state: "ok" }; }, start: async () => ({}), get: async () => undefined, status: async () => ({}), idle: async () => {} } as unknown as JobManager;
    const server = createServer(manager, { defaultRepoRoot: () => "/repo", version: "0.0.1" });
    const client = new Client({ name: "t", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    await client.callTool({ name: "agy_act", arguments: { action: "lesson", text: "Keep UI local.", audience: "orchestrator", scope: "global", tags: ["kind:implement"], job_id: "t-1" } });
    expect(log[0]).toEqual({ action: "lesson", text: "Keep UI local.", audience: "orchestrator", scope: "global", tags: ["kind:implement"], jobId: "t-1" });
    const { tools } = await client.listTools();
    expect(JSON.stringify(tools).length / 4).toBeLessThan(1500);
  });
  it("renders the promotion card", () => {
    expect(promoteCardText({ lessonText: "Keep UI local.", hits: 3, targetFile: "references/routing.md" }))
      .toBe('Add a learned rule to the gemini-delegation skill?\n"Keep UI local." (seen 3×)\n→ references/routing.md');
  });
});
```

- [ ] **Step 2:** implement until the contract passes **and** all existing tests still pass. Leave work uncommitted.

---

### Task 3: The `gemini-delegation` skill and `install-skill`

**Files:**
- Create: `skills/gemini-delegation/SKILL.md`, `skills/gemini-delegation/references/models.md`, `routing.md`, `prompting.md`, `known-issues.md`, `review.md`, `async.md`, `lessons.md`, and `AGENTS.md` (repo root)
- Modify: `src/cli.ts` (new command), `README.md` (one "Skill" section)
- Test: `test/skill.test.ts`, `test/cli-skill.test.ts`

**Content sources:** spec `docs/superpowers/specs/2026-10-17-agy-orchestrator-v2-design.md` §6.1 (async rules), §7 (approval, token gate, quota card), §8.2 (writing lessons) and §9 (models, routing, prompting, known issues, review). Write for an AI orchestrator reader: short imperative rules, the 4 tool names with when to call them, and a worked example of one plan run (start with plan → card → wait in background → get → review → finalize, or follow-up). Copy the known-issues table **with its sources**.

**`SKILL.md` frontmatter:**
```
---
name: gemini-delegation
description: Delegate well-specified, test-verifiable coding work to Gemini 3.8 Flash through the agy-orchestrator MCP tools (agy_start, agy_get, agy_act, agy_status), and review the verified result. Use when executing implementation plans, bulk mechanical changes or large-codebase exploration where a machine check exists. Do not use for design decisions, small edits or tasks without tests.
---
```

**`install-skill` command:** `agy-orchestrator install-skill [--project]` copies the packaged `skills/gemini-delegation` folder (resolved relative to the built `dist/` as `../skills/gemini-delegation`, falling back to `<cwd>/skills/gemini-delegation` in dev) to `<cwd>/.claude/skills/gemini-delegation` with `--project`, else `<home>/.claude/skills/gemini-delegation`, where home is `io.env.USERPROFILE || io.env.HOME`. It refuses with exit 1 if the target exists (prints `already installed: <path>`), and otherwise prints `installed: <path>`. For tests, the source can be overridden with `io.env.AGYO_SKILL_SRC`.

- [ ] **Step 1: Contract tests**

`test/skill.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skill = path.join(root, "skills", "gemini-delegation");
const read = (rel: string) => readFileSync(path.join(skill, rel), "utf8");
const REFS = ["models", "routing", "prompting", "known-issues", "review", "async", "lessons"];
const all = () => [read("SKILL.md"), ...REFS.map((r) => read(`references/${r}.md`))].join("\n");

describe("gemini-delegation skill", () => {
  it("has valid frontmatter", () => {
    const md = read("SKILL.md");
    expect(md.startsWith("---\nname: gemini-delegation\ndescription: ")).toBe(true);
    expect(md).toMatch(/description: .*Gemini 3\.8 Flash.*agy_start/);
  });
  it("ships every reference file and links them from SKILL.md", () => {
    for (const r of REFS) {
      expect(existsSync(path.join(skill, "references", `${r}.md`)), r).toBe(true);
      expect(read(`references/${r}.md`).trim().length, r).toBeGreaterThan(200);
      expect(read("SKILL.md")).toContain(`references/${r}.md`);
    }
  });
  it("states the key rules", () => {
    const text = all();
    for (const s of [
      "agy_start", "agy_get", "agy_act", "agy_status", "gemini-3.8-flash-high", "low", "medium", "high",
      "contract test", "estimate", "once per plan", "agy-orchestrator wait", "Continue without Gemini",
      "two strikes", "grep", "untrusted", "finalize", "follow",
    ]) expect(text.toLowerCase(), s).toContain(s.toLowerCase());
  });
  it("carries the live-verified known issues with sources", () => {
    const k = read("references/known-issues.md");
    for (const s of ["print timeout", "SUCCESS", "always-proceed", "word", "stdin", "taskkill"]) expect(k, s).toContain(s);
    expect(k).toMatch(/Source|source/);
  });
  it("never sets word limits for briefs and never mentions account switching", () => {
    const p = read("references/prompting.md");
    expect(p).toMatch(/never set hard word or length limits/i);
    expect(all()).not.toMatch(/account (switch|rotation)|switch(ing)? accounts?/i);
  });
  it("has an AGENTS.md pointer for agents without skill support", () => {
    const a = readFileSync(path.join(root, "AGENTS.md"), "utf8");
    expect(a).toContain("skills/gemini-delegation/SKILL.md");
    expect(a).toContain("agy_start");
  });
});
```

`test/cli-skill.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main, type Io } from "../src/cli.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const io = (env: NodeJS.ProcessEnv, cwd: string) => {
  const out: string[] = [];
  const i: Io = { out: (s) => out.push(s), err: (s) => out.push(s), env, cwd };
  return { i, out };
};

describe("install-skill", () => {
  const env = { AGYO_SKILL_SRC: path.join(root, "skills", "gemini-delegation") };
  it("installs into the user's ~/.claude/skills by default and refuses twice", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "agyo-home-"));
    const a = io({ ...env, USERPROFILE: home, HOME: home }, os.tmpdir());
    expect(await main(["install-skill"], a.i)).toBe(0);
    const target = path.join(home, ".claude", "skills", "gemini-delegation");
    expect(existsSync(path.join(target, "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(target, "references", "routing.md"))).toBe(true);
    expect(a.out.join("\n")).toContain(`installed: ${target}`);
    const b = io({ ...env, USERPROFILE: home, HOME: home }, os.tmpdir());
    expect(await main(["install-skill"], b.i)).toBe(1);
    expect(b.out.join("\n")).toContain("already installed");
  });
  it("installs into the project with --project", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "agyo-proj-"));
    expect(await main(["install-skill", "--project"], io(env, cwd).i)).toBe(0);
    expect(existsSync(path.join(cwd, ".claude", "skills", "gemini-delegation", "SKILL.md"))).toBe(true);
  });
});
```

- [ ] **Step 2:** write the skill and implement the command until the contract passes. Leave work uncommitted.

---

## Self-review
- **Spec coverage:** §8.1 capture → T1 (`classifyIncident`) + T2. §8.2 reflect → T2 (`lesson` action), T3 (`lessons.md`). §8.3 store → T1. §8.4 apply → T2 (brief injection, status). §8.5 promote with approval → T2. §8.6 success signals → partially (ledger incidents; routing hints from them are v0.2). §9 skill → T3. `install-skill` → T3.
- **Executed via the tool:** each task's test files are detected as contract tests by `parsePlanStep` (lines like `` `test/...test.ts`: `` before a fence), committed as the base, checked red, and verified green.
