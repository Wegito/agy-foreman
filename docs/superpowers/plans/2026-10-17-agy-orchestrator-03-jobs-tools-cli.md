# agy-orchestrator Plan 3: Jobs, MCP Tools and CLI, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agy-orchestrator usable from Claude Code. A `JobManager` (background jobs, persisted state, progress %, ledger, token gate, once-per-plan approval, quota card, follow-ups, finalize) is exposed as **4 MCP tools**, plus a CLI with `serve`, `wait`, `watch`, `doctor` and `init`.

**Architecture:** `src/jobs/` is a deep module (`JobManager.start/get/act/status`) over small internal parts: `store` (atomic JSON per job), `progress`, `ledger` (JSONL), `flags` (cooldown, paused, plan grants), `plan` (plan-file step parser), `tokengate`, `approver` (seam with two real adapters: MCP elicitation and client mode). `src/server.ts` maps the 4 tools onto `JobManager`. `src/cli.ts` holds the commands. `src/runtime.ts` wires the real dependencies.

**Tech Stack:** as before, plus `@modelcontextprotocol/sdk` 1.32.x (`McpServer.registerTool`, `server.server.elicitInput`, `InMemoryTransport` for tests).

**How this plan is written:** interfaces, implementation notes and **complete test files as contracts**. Implementers write `src/` to pass them, never edit, skip or weaken tests, and **never add code paths that exist only to satisfy a specific test**. If a test looks wrong, stop and report it.

## Global Constraints
- All Global Constraints of Plans 1 and 2 apply.
- Job state is persisted under `paths.stateDir()` (overridable with env `AGYO_STATE_DIR` for tests and power users): `jobs/<id>.json`, `ledger.jsonl`, `flags.json`. Writes are atomic (write a temp file in the same dir, then rename).
- Approval is **once per plan** (`approval: "per_plan"`) or per task (`"per_task"`). No approval is ever asked per tool call. `"auto"` doesn't exist.
- Nothing retries automatically after quota. Retry happens only on the user's choice.
- Tool schemas (names, descriptions, input schemas) together stay **under 1,500 tokens** (chars/4).
- Server git operations on the user's repo (finalize) require a clean working tree and the target branch checked out. Otherwise refuse with a clear reason.

## File Structure (new or changed)
```
src/paths.ts                 # + AGYO_STATE_DIR override
src/jobs/store.ts            # JobRecord, JobStore, newJobId, isTerminal
src/jobs/progress.ts         # PHASE_WEIGHTS, computeProgress, renderProgressLine
src/jobs/ledger.ts           # Ledger (JSONL)
src/jobs/flags.ts            # FlagStore, PlanGrant, hashPlan, validGrant
src/jobs/plan.ts             # parsePlanStep, planTitle
src/jobs/tokengate.ts        # tokenGate
src/jobs/approver.ts         # Approver, cards, ClientModeApprover, FakeApprover (for tests)
src/jobs/manager.ts          # JobManager
src/server.ts                # createServer, ElicitationApprover
src/runtime.ts               # createRuntime (real wiring)
src/cli.ts                   # main, waitExitCode, detectTestCommand, doctor
src/index.ts                 # bin → main(process.argv.slice(2))
test/jobs/*.test.ts, test/server.test.ts, test/cli.test.ts
```

---

### Task 1: Persistence and pure helpers (store, progress, ledger, flags, `AGYO_STATE_DIR`)

**Files:** Create `src/jobs/store.ts`, `src/jobs/progress.ts`, `src/jobs/ledger.ts`, `src/jobs/flags.ts` and tests `test/jobs/store.test.ts`, `test/jobs/progress.test.ts`, `test/jobs/ledger.test.ts`, `test/jobs/flags.test.ts`. Modify `src/paths.ts` and `test/paths.test.ts`.

**Interfaces:**
```ts
// paths.ts: stateDir() returns env.AGYO_STATE_DIR when set (any platform), otherwise unchanged.

// store.ts
import type { Envelope, JobState } from "../pipeline/index.js";
export type JobPhase = "queued" | "awaiting_approval" | "prepare" | "contract" | "brief" | "run" | "verify" | "report" | "done";
export type RecordState = JobState | "queued" | "running";
export interface Estimate { directTokens: number; delegateOverheadTokens: number; reason: string }
export interface Progress {
  percent: number; phase: JobPhase; checklistDone: number; checklistTotal: number;
  currentStep?: string; currentFile?: string; toolSteps: number; tokens: number; elapsedSec: number; etaSec?: number;
}
export interface JobRecord {
  id: string; kind: "implement" | "explore"; repoRoot: string; title: string; state: RecordState;
  progress: Progress; createdAt: string; updatedAt: string;
  plan?: { file: string; step: number }; estimate?: Estimate; parentJobId?: string;
  envelope?: Envelope; returnedChars: number;
}
export function isTerminal(state: RecordState): boolean;               // true for every state except queued, running
export function newJobId(now: Date, rand?: () => string): string;      // "t-" + base36(now ms) + "-" + 4 hex; matches /^[a-z0-9][a-z0-9-]{0,39}$/
export function emptyProgress(): Progress;                              // percent 0, phase "queued", counters 0
export class JobStore {
  constructor(dir: string);
  write(rec: JobRecord): Promise<void>;                                 // atomic; creates dir
  read(id: string): Promise<JobRecord | undefined>;
  list(): Promise<JobRecord[]>;                                         // newest createdAt first
}

// progress.ts
export const PHASE_WEIGHTS: Record<"prepare" | "contract" | "brief" | "run" | "verify" | "report", number>;
// { prepare: 5, contract: 5, brief: 0, run: 75, verify: 12, report: 3 }
export interface ProgressInput {
  phase: JobPhase; checklist?: { done: number; total: number }; elapsedSec: number; runElapsedSec: number; medianRunSec?: number;
}
export function computeProgress(i: ProgressInput): { percent: number; etaSec?: number };
export function renderProgressLine(rec: JobRecord): string;

// ledger.ts
export interface LedgerEntry {
  jobId: string; kind: "implement" | "explore"; state: string; durationSec: number; runSec?: number;
  estimate?: Estimate; returnedTokens: number; usageTotal?: number; at: string;
}
export class Ledger {
  constructor(file: string);
  append(e: LedgerEntry): Promise<void>;
  entries(): Promise<LedgerEntry[]>;
  medianRunSec(kind: "implement" | "explore"): Promise<number | undefined>;
  calibration(): Promise<{ samples: number; ratio?: number }>;          // median of returnedTokens / estimate.delegateOverheadTokens
  stats(since: Date): Promise<{ jobs: number; passed: number; tokens: number }>;
}

// flags.ts
export interface PlanGrant { file: string; hash: string; steps: number[]; approvedAt: string; expiresAt: string }
export interface Flags { cooldownUntil?: string; cooldownText?: string; delegationPaused: boolean; grants: PlanGrant[] }
export function hashPlan(content: string): string;                     // sha256 hex
export function validGrant(f: Flags, file: string, hash: string, now: Date): PlanGrant | undefined;
export class FlagStore {
  constructor(file: string);
  read(): Promise<Flags>;                                               // defaults when missing: { delegationPaused: false, grants: [] }
  update(fn: (f: Flags) => Flags | void): Promise<Flags>;               // read-modify-write, atomic, serialized in-process
}
```

**Implementation notes:**
- `computeProgress`:
  - The percent is the sum of the weights of all phases *before* the current one, plus a fraction of the current phase's weight. Only `run` has a fraction: `checklist.done / checklist.total` when `total > 0`, otherwise `min(0.95, runElapsedSec / medianRunSec)` when a median exists, otherwise `0`.
  - `queued` and `awaiting_approval` → 0. `done` → 100. Round down to an integer and cap non-done phases at 99.
  - `etaSec` = `round(elapsedSec * (100 - percent) / percent)` when `0 < percent < 100`, otherwise undefined.
- `renderProgressLine`: `${id}  ${bar} ${percent}% · ${phase}` + (` · step ${done}/${total}` if a checklist exists) + (` · ${currentFile}` if set) + ` · ${elapsed}` + (` · ETA ~${eta}` if set). The bar is 20 cells of `▓`/`░`. Durations are formatted like `4m12s`.
- Atomic write: `writeFile(tmp)` then `rename(tmp, final)`, with `tmp = final + "." + process.pid + "." + random + ".tmp"`.
- `validGrant`: same `file` (compared with `path.resolve`, case-insensitive on win32), same `hash`, `expiresAt > now`.

- [ ] **Step 1: Write the tests**

Add to `test/paths.test.ts`:
```ts
describe("AGYO_STATE_DIR", () => {
  it("overrides the state dir on every platform", () => {
    expect(stateDir({ platform: "win32", env: { AGYO_STATE_DIR: "D:\\agyo" }, home: "C:\\Users\\u" })).toBe("D:\\agyo");
    expect(jobsDir({ platform: "linux", env: { AGYO_STATE_DIR: "/tmp/agyo" }, home: "/home/u" })).toBe("/tmp/agyo/jobs");
  });
});
```

`test/jobs/store.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobStore, newJobId, isTerminal, emptyProgress, type JobRecord } from "../../src/jobs/store.js";

const rec = (id: string, createdAt: string, state: JobRecord["state"] = "running"): JobRecord => ({
  id, kind: "implement", repoRoot: "/r", title: "t", state, progress: emptyProgress(), createdAt, updatedAt: createdAt, returnedChars: 0,
});

describe("newJobId", () => {
  it("is a safe, unique-looking id", () => {
    const id = newJobId(new Date("2026-10-17T12:00:00Z"), () => "ab12");
    expect(id).toMatch(/^t-[0-9a-z]+-ab12$/);
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
    expect(newJobId(new Date())).toMatch(/^t-[0-9a-z]+-[0-9a-f]{4}$/);
  });
});

describe("isTerminal", () => {
  it("treats queued and running as non-terminal", () => {
    expect(isTerminal("queued")).toBe(false);
    expect(isTerminal("running")).toBe(false);
    for (const s of ["passed", "failed", "refused", "quota", "timeout", "cancelled", "error", "guard_violation"] as const) expect(isTerminal(s)).toBe(true);
  });
});

describe("JobStore", () => {
  it("writes atomically, reads back and lists newest first", async () => {
    const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "agyo-store-")), "jobs");
    const s = new JobStore(dir);
    await s.write(rec("t-a", "2026-10-17T10:00:00Z"));
    await s.write(rec("t-b", "2026-10-17T11:00:00Z"));
    await s.write({ ...rec("t-a", "2026-10-17T10:00:00Z"), state: "passed" });
    expect((await s.read("t-a"))?.state).toBe("passed");
    expect(await s.read("t-missing")).toBeUndefined();
    expect((await s.list()).map((r) => r.id)).toEqual(["t-b", "t-a"]);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
```

`test/jobs/progress.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { computeProgress, renderProgressLine, PHASE_WEIGHTS } from "../../src/jobs/progress.js";
import { emptyProgress, type JobRecord } from "../../src/jobs/store.js";

describe("computeProgress", () => {
  it("weights sum to 100", () => {
    expect(Object.values(PHASE_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });
  it("uses the checklist inside the run phase", () => {
    expect(computeProgress({ phase: "run", checklist: { done: 2, total: 4 }, elapsedSec: 100, runElapsedSec: 80 }).percent).toBe(10 + 37);
  });
  it("falls back to time vs median, capped at 95% of the run phase", () => {
    expect(computeProgress({ phase: "run", elapsedSec: 60, runElapsedSec: 50, medianRunSec: 100 }).percent).toBe(10 + 37);
    expect(computeProgress({ phase: "run", elapsedSec: 900, runElapsedSec: 800, medianRunSec: 100 }).percent).toBe(10 + 71);
    expect(computeProgress({ phase: "run", elapsedSec: 60, runElapsedSec: 50 }).percent).toBe(10);
  });
  it("handles the edges and ETA", () => {
    expect(computeProgress({ phase: "queued", elapsedSec: 5, runElapsedSec: 0 })).toEqual({ percent: 0 });
    expect(computeProgress({ phase: "done", elapsedSec: 5, runElapsedSec: 0 })).toEqual({ percent: 100 });
    expect(computeProgress({ phase: "verify", elapsedSec: 85, runElapsedSec: 0 })).toEqual({ percent: 85, etaSec: 15 });
    expect(computeProgress({ phase: "report", checklist: { done: 9, total: 9 }, elapsedSec: 10, runElapsedSec: 0 }).percent).toBeLessThanOrEqual(99);
  });
  it("is monotonic across phases", () => {
    const phases = ["prepare", "contract", "brief", "run", "verify", "report"] as const;
    const ps = phases.map((phase) => computeProgress({ phase, elapsedSec: 10, runElapsedSec: 0 }).percent);
    expect([...ps].sort((a, b) => a - b)).toEqual(ps);
  });
});

describe("renderProgressLine", () => {
  it("shows id, bar, percent, phase, step, file and timing", () => {
    const rec: JobRecord = {
      id: "t-x", kind: "implement", repoRoot: "/r", title: "t", state: "running", createdAt: "", updatedAt: "", returnedChars: 0,
      progress: { ...emptyProgress(), percent: 64, phase: "run", checklistDone: 4, checklistTotal: 6, currentFile: "src/a.ts", elapsedSec: 252, etaSec: 150 },
    };
    const line = renderProgressLine(rec);
    for (const s of ["t-x", "64%", "run", "step 4/6", "src/a.ts", "4m12s", "ETA ~2m30s"]) expect(line).toContain(s);
    expect(line).toMatch(/[▓░]{20}/);
  });
});
```

`test/jobs/ledger.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ledger, type LedgerEntry } from "../../src/jobs/ledger.js";

const e = (o: Partial<LedgerEntry>): LedgerEntry => ({ jobId: "j", kind: "implement", state: "passed", durationSec: 10, returnedTokens: 0, at: "2026-10-17T10:00:00Z", ...o });

describe("Ledger", () => {
  it("appends, reads, and computes medians, calibration and stats", async () => {
    const l = new Ledger(path.join(mkdtempSync(path.join(os.tmpdir(), "agyo-led-")), "ledger.jsonl"));
    expect(await l.medianRunSec("implement")).toBeUndefined();
    expect(await l.calibration()).toEqual({ samples: 0 });
    await l.append(e({ runSec: 100, estimate: { directTokens: 10000, delegateOverheadTokens: 4000, reason: "" }, returnedTokens: 6000 }));
    await l.append(e({ runSec: 300, estimate: { directTokens: 10000, delegateOverheadTokens: 2000, reason: "" }, returnedTokens: 2000, state: "failed" }));
    await l.append(e({ runSec: 200, kind: "explore", returnedTokens: 500, usageTotal: 1000, at: "2026-10-16T10:00:00Z" }));
    expect((await l.entries()).length).toBe(3);
    expect(await l.medianRunSec("implement")).toBe(200);
    expect(await l.medianRunSec("explore")).toBe(200);
    expect(await l.calibration()).toEqual({ samples: 2, ratio: 1.25 });
    expect(await l.stats(new Date("2026-10-17T00:00:00Z"))).toEqual({ jobs: 2, passed: 1, tokens: 0 });
  });
});
```

`test/jobs/flags.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FlagStore, hashPlan, validGrant, type Flags } from "../../src/jobs/flags.js";

describe("flags", () => {
  it("defaults, updates atomically and serializes concurrent updates", async () => {
    const fs = new FlagStore(path.join(mkdtempSync(path.join(os.tmpdir(), "agyo-flags-")), "flags.json"));
    expect(await fs.read()).toEqual({ delegationPaused: false, grants: [] });
    await Promise.all(Array.from({ length: 10 }, (_, i) => fs.update((f) => {
      f.grants.push({ file: `/p${i}.md`, hash: "h", steps: [1], approvedAt: "", expiresAt: "" });
    })));
    expect((await fs.read()).grants).toHaveLength(10);
    await fs.update((f) => ({ ...f, delegationPaused: true }));
    expect((await fs.read()).delegationPaused).toBe(true);
  });

  it("hashes plans and validates grants by file, hash and expiry", () => {
    expect(hashPlan("a")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPlan("a")).not.toBe(hashPlan("b"));
    const file = path.join(os.tmpdir(), "plan.md");
    const f: Flags = { delegationPaused: false, grants: [{ file, hash: "h1", steps: [5], approvedAt: "2026-10-17T10:00:00Z", expiresAt: "2026-10-18T10:00:00Z" }] };
    const now = new Date("2026-10-17T12:00:00Z");
    expect(validGrant(f, file, "h1", now)?.steps).toEqual([5]);
    expect(validGrant(f, file, "h2", now)).toBeUndefined();
    expect(validGrant(f, file + "x", "h1", now)).toBeUndefined();
    expect(validGrant(f, file, "h1", new Date("2026-10-19T00:00:00Z"))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, verify failure.** **Step 3: Implement.** **Step 4: Run, verify pass.**
- [ ] **Step 5:** Leave the work uncommitted (the orchestrator reviews and commits).

---

### Task 2: Plan-step parser, token gate and approver adapters

**Files:** Create `src/jobs/plan.ts`, `src/jobs/tokengate.ts`, `src/jobs/approver.ts` and tests `test/jobs/plan.test.ts`, `test/jobs/tokengate.test.ts`, `test/jobs/approver.test.ts`.

**Interfaces:**
```ts
// plan.ts
export interface PlanStep { step: number; title: string; text: string; files: string[]; testBlocks: { path: string; content: string }[] }
export function planTitle(markdown: string): string;                    // text of the first "# " heading, or ""
export function parsePlanStep(markdown: string, step: number): PlanStep; // throws Error(`step ${step} not found`)

// tokengate.ts
import type { Estimate } from "./store.js";
export function tokenGate(e: Estimate | undefined, ratio: number): { refuse: boolean; reason?: string };

// approver.ts
import type { Estimate } from "./store.js";
export interface PlanCard { planFile: string; title: string; steps: number[]; estimate?: Estimate }
export interface TaskCard { title: string; kind: "implement" | "explore"; effort: string; skills: string[]; estimate?: Estimate }
export interface QuotaCard { resetText?: string; resetAt?: string; pausedJobId?: string }
export type QuotaChoice = "retry" | "continue_without" | "wait";
export interface Approver {
  plan(c: PlanCard): Promise<boolean>;
  task(c: TaskCard): Promise<boolean>;
  quota(c: QuotaCard): Promise<QuotaChoice | "unavailable">;
}
export class ApprovalUnavailable extends Error {}
export function planCardText(c: PlanCard): string;
export function taskCardText(c: TaskCard): string;
export function quotaCardText(c: QuotaCard): string;
export class ClientModeApprover implements Approver { }                 // plan/task → true (the client's own ask rule gates the tool call); quota → "unavailable"
export class FakeApprover implements Approver {                         // for tests
  constructor(answers?: { plan?: boolean; task?: boolean; quota?: QuotaChoice | "unavailable" });
  calls: { kind: "plan" | "task" | "quota"; card: unknown }[];
}
```

**Implementation notes:**
- `parsePlanStep`:
  - A step is the section starting at a heading line matching `^#{2,4} Task ${step}[:.]\s*(.*)$` and running up to the next heading of the same or higher level, or the end. `title` = the captured text. `text` = the whole section.
  - `files` = every backticked path on lines that start with `- Create:`, `- Modify:`, `- Test:` or `**Files:**` (split on commas; drop `:line-range` suffixes; deduplicate; keep order).
  - `testBlocks` = fenced code blocks whose nearest preceding non-empty line contains a backticked path whose basename matches `/(\.test\.|\.spec\.|_test\.|^test_)/`. `path` = that path, `content` = the block body.
- `tokenGate`: no estimate → `{refuse: true, reason: "estimate required: {direct_tokens, delegate_overhead_tokens, reason}"}`. If `delegateOverheadTokens * ratio > directTokens` → refuse with a reason containing `cheaper to do directly` and both numbers. Otherwise `{refuse: false}`.
- Card texts are single strings for the elicitation `message`:
  - Plan: `Delegate plan "<title>" to Gemini 3.8 Flash?\n<planFile> · steps for Gemini: <steps joined ", ">` + (estimate ? `\nDoing it myself: ~<k>k tokens · Delegating: ~<k>k tokens` : ""). `k` = tokens/1000 rounded to one decimal.
  - Task: `Delegate to Gemini 3.8 Flash (<effort>)? "<title>"` + (skills ? ` · skills: <list>` : "") + the estimate line + (`\nWhy: <reason>` if a reason is given).
  - Quota: `Gemini quota reached. Resets in <resetText> (<resetAt local HH:MM>).` + (pausedJobId ? ` Task <id> paused, partial work kept.` : "").

- [ ] **Step 1: Write the tests**

`test/jobs/plan.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parsePlanStep, planTitle } from "../../src/jobs/plan.js";

const PLAN = [
  "# Demo Implementation Plan",
  "",
  "### Task 1: Add the adder",
  "",
  "**Files:**",
  "- Create: `src/add.ts`, `src/util.ts`",
  "- Modify: `src/index.ts:10-20`",
  "- Test: `test/add.test.ts`",
  "",
  "- [ ] **Step 1: Write the failing test**",
  "",
  "`test/add.test.ts`:",
  "```ts",
  'import { add } from "../src/add.js";',
  "test(\"adds\", () => expect(add(2, 3)).toBe(5));",
  "```",
  "",
  "Implementation hint:",
  "```ts",
  "export const add = (a: number, b: number) => a + b;",
  "```",
  "",
  "### Task 2: Docs",
  "",
  "- Modify: `README.md`",
  "",
].join("\n");

describe("planTitle", () => {
  it("returns the first H1", () => {
    expect(planTitle(PLAN)).toBe("Demo Implementation Plan");
    expect(planTitle("no heading")).toBe("");
  });
});

describe("parsePlanStep", () => {
  it("extracts title, files and only the test blocks", () => {
    const s = parsePlanStep(PLAN, 1);
    expect(s.title).toBe("Add the adder");
    expect(s.files).toEqual(["src/add.ts", "src/util.ts", "src/index.ts", "test/add.test.ts"]);
    expect(s.testBlocks).toEqual([{ path: "test/add.test.ts", content: 'import { add } from "../src/add.js";\ntest("adds", () => expect(add(2, 3)).toBe(5));\n' }]);
    expect(s.text).toContain("Implementation hint");
    expect(s.text).not.toContain("### Task 2");
  });
  it("parses the last step and throws for a missing one", () => {
    expect(parsePlanStep(PLAN, 2)).toMatchObject({ title: "Docs", files: ["README.md"], testBlocks: [] });
    expect(() => parsePlanStep(PLAN, 3)).toThrow("step 3 not found");
  });
});
```

`test/jobs/tokengate.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { tokenGate } from "../../src/jobs/tokengate.js";

describe("tokenGate", () => {
  it("requires an estimate", () => {
    expect(tokenGate(undefined, 1.5)).toMatchObject({ refuse: true, reason: expect.stringMatching(/estimate required/) });
  });
  it("refuses obvious losers and allows winners", () => {
    const r = tokenGate({ directTokens: 5000, delegateOverheadTokens: 4000, reason: "" }, 1.5);
    expect(r.refuse).toBe(true);
    expect(r.reason).toMatch(/cheaper to do directly/);
    expect(r.reason).toContain("5000");
    expect(tokenGate({ directTokens: 18000, delegateOverheadTokens: 4000, reason: "" }, 1.5)).toEqual({ refuse: false });
    expect(tokenGate({ directTokens: 6000, delegateOverheadTokens: 4000, reason: "" }, 1.5)).toEqual({ refuse: false });
  });
});
```

`test/jobs/approver.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { planCardText, taskCardText, quotaCardText, ClientModeApprover, FakeApprover } from "../../src/jobs/approver.js";

describe("card texts", () => {
  it("renders the plan card", () => {
    const t = planCardText({ planFile: "docs/p.md", title: "Foundation", steps: [5, 6, 8], estimate: { directTokens: 55000, delegateOverheadTokens: 14000, reason: "" } });
    expect(t).toContain('Delegate plan "Foundation" to Gemini 3.8 Flash?');
    expect(t).toContain("docs/p.md · steps for Gemini: 5, 6, 8");
    expect(t).toContain("Doing it myself: ~55k tokens · Delegating: ~14k tokens");
  });
  it("renders the task card", () => {
    const t = taskCardText({ title: "Add rotation", kind: "implement", effort: "high", skills: ["tdd"], estimate: { directTokens: 18000, delegateOverheadTokens: 4200, reason: "9-file change" } });
    expect(t).toContain('Delegate to Gemini 3.8 Flash (high)? "Add rotation" · skills: tdd');
    expect(t).toContain("~18k tokens");
    expect(t).toContain("~4.2k tokens");
    expect(t).toContain("Why: 9-file change");
  });
  it("renders the quota card neutrally", () => {
    const t = quotaCardText({ resetText: "2h13m", resetAt: "2026-10-17T16:40:00", pausedJobId: "t-1" });
    expect(t).toContain("Gemini quota reached. Resets in 2h13m");
    expect(t).toContain("Task t-1 paused, partial work kept.");
    expect(t).not.toMatch(/account/i);
  });
});

describe("approvers", () => {
  it("client mode approves and cannot show the quota card", async () => {
    const a = new ClientModeApprover();
    expect(await a.plan({ planFile: "p", title: "t", steps: [1] })).toBe(true);
    expect(await a.task({ title: "t", kind: "explore", effort: "low", skills: [] })).toBe(true);
    expect(await a.quota({})).toBe("unavailable");
  });
  it("fake approver records calls", async () => {
    const a = new FakeApprover({ plan: false, quota: "retry" });
    expect(await a.plan({ planFile: "p", title: "t", steps: [1] })).toBe(false);
    expect(await a.task({ title: "t", kind: "explore", effort: "low", skills: [] })).toBe(true);
    expect(await a.quota({})).toBe("retry");
    expect(a.calls.map((c) => c.kind)).toEqual(["plan", "task", "quota"]);
  });
});
```

- [ ] **Step 2–4:** fail → implement → pass. **Step 5:** leave uncommitted.

---

### Task 3: `JobManager`

**Files:** Create `src/jobs/manager.ts`, `test/jobs/manager.test.ts`

**Interfaces:**
```ts
import type { Config } from "../config.js";
import type { ContractTest } from "../pipeline/contract.js";
import type { Envelope, JobSpec, PipelineDeps } from "../pipeline/index.js";
import type { Effort } from "../config.js";

export interface StartInput {
  repoRoot: string; kind: "implement" | "explore";
  task?: string; plan?: { file: string; step: number; delegateSteps?: number[] };
  contractTests?: ContractTest[]; skills?: string[]; estimate?: Estimate; effort?: Effort;
  dryRun?: boolean; baseRef?: string; timeoutSec?: number;
}
export type StartResult =
  | { state: "queued" | "running"; jobId: string; waitHint: string }
  | { state: "refused" | "denied"; reason: string }
  | { state: "quota"; reason: string; quota: { resetText?: string; resetAt?: string }; options: ("retry" | "continue_without" | "wait")[] }
  | { state: "dry_run"; brief: string; command: string[]; skills: { name: string; claudeOnlyRefs: string[] }[]; contractTests: string[]; redOnBase?: boolean };
export interface GetOptions { waitSec?: number; diffMode?: "stat" | "full" | "paths"; paths?: string[]; maxDiffTokens?: number }
export type ActInput =
  | { action: "followup"; jobId: string; feedback: string }
  | { action: "finalize"; jobId: string; mode: "squash" | "merge" | "discard" | "keep" }
  | { action: "cancel"; jobId: string }
  | { action: "quota_choice"; choice: "retry" | "continue_without" | "wait" }
  | { action: "resume_delegation" }
  | { action: "revoke_plan"; planFile: string };
export interface JobManagerDeps {
  store: JobStore; ledger: Ledger; flags: FlagStore; approver: Approver;
  runJob: (spec: JobSpec, deps: PipelineDeps) => Promise<Envelope>;
  pipelineDeps: Omit<PipelineDeps, "onEvent" | "onPhase" | "signal">;
  loadConfig: (repoRoot: string) => Config;
  now: () => Date;
}
export class JobManager {
  constructor(deps: JobManagerDeps);
  start(i: StartInput): Promise<StartResult>;
  get(jobId: string, o?: GetOptions): Promise<(JobRecord & { diff?: string }) | undefined>;
  act(i: ActInput): Promise<Record<string, unknown>>;
  status(repoRoot?: string): Promise<Record<string, unknown>>;
  idle(): Promise<void>;                                                // resolves when no job is queued or running (tests)
}
```

**`start` order (each step can return early):**
1. **Delegation paused** (`flags.delegationPaused`) → `refused`, with a reason mentioning `resume_delegation`.
2. **Cooldown active** (`cooldownUntil > now`) → `approver.quota({resetText, resetAt})`:
   - `retry` → clear the cooldown and continue.
   - `continue_without` → set paused, return `refused` ("continue without Gemini").
   - `wait` → return `quota` (with options).
   - `unavailable` → return `quota` with `options: ["retry","continue_without","wait"]`.
3. **Resolve the task:**
   - With `plan`: read the file, `parsePlanStep`. `task` = `step.text`. Use `contractTests ?? step.testBlocks`, unless `kind === "explore"`. `title` = `step.title`.
   - Without a plan: `task` is required (refuse otherwise). `title` = the first line of `task`, up to 80 chars.
4. **Token gate** (implement only, skipped on dry run): `tokenGate(estimate, config.project.refuseRatio)` → `refused`.
5. **Dry run:**
   - Return `dry_run` with `brief` (`renderBrief`), `command = buildArgs(…)` (prompt `RUN_PROMPT`), and the resolved skills with their `claudeOnlyRefs`.
   - Contract test paths go in `contractTests`. If there are contract tests and a test command, also run the red check in a temporary worktree (create, add, check, remove) and report `redOnBase`.
   - No approval is asked, no job is created, no Gemini.
6. **Approval:**
   - `plan` and `config.project.approval === "per_plan"`: look for a valid grant for (file, hashPlan(content)). If there's none → `approver.plan({planFile, title: planTitle, steps: delegateSteps ?? [step], estimate})`. Denied → `denied`. Approved → add a grant (expires now + 24 h).
   - Otherwise → `approver.task(...)`. Denied → `denied`.
   - `ApprovalUnavailable` thrown → `refused` with its message.
7. **Create the record** (`newJobId(now)`, state `queued`). If fewer than `maxConcurrent` jobs are running for this repo and fewer than `maxRunsPerHour` jobs started in the last hour (from the store), start it now (state `running`). Otherwise keep it `queued` and start it when a slot frees. Return `{state, jobId, waitHint: "agy-orchestrator wait " + jobId}`.

**Running a job:**
- Call `deps.runJob(spec, {...pipelineDeps, onPhase, onEvent, signal})`.
- `onPhase` updates `progress.phase`.
- `onEvent` updates `toolSteps` (DONE tool steps), `currentFile` (TargetFile or AbsolutePath, made relative to the worktree if possible), `tokens` (the result or step usage totals), and the checklist (re-read `<worktreePath>/.agy-task/progress.md` on each `write_to_file` event targeting it, using `progressFraction`).
- Progress is recomputed with `computeProgress` (`medianRunSec` from the ledger) and the record is written, throttled to at most once per 500 ms plus once on every phase change.
- **On finish:** store the envelope, set state = `envelope.state` and phase `done` (100%), append a ledger entry, and start queued jobs.
- **On `quota`:** set the cooldown (`now + max(60, resetInSec ?? 900)`, `cooldownText = resetText`), then call `approver.quota({…, pausedJobId})` **once**. `retry` → clear the cooldown and start a follow-up of this job with feedback `"Continue the task; the previous run stopped at a usage limit."` (no new approval). `continue_without` → set paused. Otherwise nothing.
- A rejected `runJob` promise → state `error`, with the reason.

**`get`:**
- Long-poll: re-read every 200 ms until the job is terminal or `waitSec` passes.
- `diffMode: "full"` → `git diff baseSha..headSha` in the worktree, truncated to `maxDiffTokens*4` chars (default 2000 tokens) with a `[truncated]` marker. `"paths"` → the same limited to `paths`.
- Add the length of `JSON.stringify(result)` to `returnedChars` and persist it.

**`act`:**
- **followup:** the parent must be terminal, `implement`, with a branch. Approval: if the parent had a plan and a valid grant exists, no card; otherwise `approver.task`. The new job has `baseRef = parent branch`, `conversationId = parent.envelope.conversationId`, `task = parent.title + "\n\nFeedback:\n" + feedback`, no contract tests, and `parentJobId`. Returns `{state, jobId}`.
- **finalize:** the job must be terminal with a branch. The repo must be clean (`isDirty` false) or it's `refused`.
  - `target` = the current branch of `repoRoot`. `mergeCheck(repoRoot, target, branch)` conflict → `{state:"conflict", conflictingFiles}`.
  - `discard` → `removeWorktree(deleteBranch)`.
  - `keep` → `{state:"kept"}`.
  - `squash` → `git merge --squash <branch>` + `git commit -m "<title>\n\nImplemented-by: <model> via agy-orchestrator\nVerified: <passed>/<tests> tests"`, then remove the worktree and branch.
  - `merge` → `git merge --no-ff -m "<title>" <branch>`, then remove the worktree (keep the branch).
  - Returns `{state:"merged"|"discarded"|"kept", commit?}`.
- **cancel:** abort the job's controller, `{state:"cancelling"}`.
- **quota_choice:** apply the same choice semantics as above to the current cooldown (retry → clear; continue_without → paused; wait → nothing). Returns `{state:"ok", choice}`.
- **resume_delegation:** unpause. **revoke_plan:** remove grants for that file.

**`status`:** `{ delegation: "active"|"paused", cooldown?: {until, resetText}, running: [{id, line}], queued: [ids], today: ledger.stats(start of today), calibration: ledger.calibration() }`.

- [ ] **Step 1: Write the test**

`test/jobs/manager.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobManager, type JobManagerDeps } from "../../src/jobs/manager.js";
import { JobStore } from "../../src/jobs/store.js";
import { Ledger } from "../../src/jobs/ledger.js";
import { FlagStore } from "../../src/jobs/flags.js";
import { FakeApprover } from "../../src/jobs/approver.js";
import { parseProjectConfig, loadRuntimeConfig } from "../../src/config.js";
import type { Envelope, JobSpec, PipelineDeps } from "../../src/pipeline/index.js";
import { makeRepo, tmpRoot } from "../pipeline/repo.js";

const EST = { directTokens: 20000, delegateOverheadTokens: 4000, reason: "multi-file" };

function envelope(spec: JobSpec, state: Envelope["state"], extra: Partial<Envelope> = {}): Envelope {
  return { jobId: spec.jobId, kind: spec.kind, state, branch: `agy/${spec.jobId}`, worktreePath: "/nowhere", baseSha: "b",
    untrustedReport: "", deniedCommands: [], guardEvents: [], skillsUsed: [], model: "gemini-3.8-flash-high", durationSec: 1, ...extra };
}

function setup(o: { approver?: FakeApprover; result?: (spec: JobSpec) => Envelope; config?: object } = {}) {
  const state = mkdtempSync(path.join(os.tmpdir(), "agyo-mgr-"));
  const repo = makeRepo({ "a.txt": "a" });
  const specs: JobSpec[] = [];
  const approver = o.approver ?? new FakeApprover();
  let now = new Date("2026-10-17T12:00:00Z");
  const deps: JobManagerDeps = {
    store: new JobStore(path.join(state, "jobs")), ledger: new Ledger(path.join(state, "ledger.jsonl")),
    flags: new FlagStore(path.join(state, "flags.json")), approver,
    runJob: async (spec: JobSpec, pd: PipelineDeps) => {
      specs.push(spec);
      pd.onPhase?.("run");
      await new Promise((r) => setTimeout(r, 20));
      return (o.result ?? ((s) => envelope(s, "passed")))(spec);
    },
    pipelineDeps: { agyRun: (async () => { throw new Error("unused"); }) as never, agyCommand: { command: "agy" }, hookBundlePath: "", worktreeRoot: tmpRoot(), home: os.homedir(), now: () => now },
    loadConfig: () => ({ project: parseProjectConfig({ test_command: ["node", "-e", "process.exit(1)"], ...o.config }), runtime: loadRuntimeConfig({}) }),
    now: () => now,
  };
  return { m: new JobManager(deps), deps, repo, specs, approver, setNow: (d: Date) => (now = d) };
}

const PLAN = "# Demo Plan\n\n### Task 1: First\n\n- Create: `src/a.ts`\n\n### Task 2: Second\n\n- Create: `src/b.ts`\n";

describe("JobManager.start", () => {
  it("runs an ad-hoc implement task after a task card, and records the result", async () => {
    const { m, repo, approver, specs } = setup();
    const r = await m.start({ repoRoot: repo, kind: "implement", task: "Fix add()\nmore detail", estimate: EST });
    expect(r).toMatchObject({ state: "running", waitHint: expect.stringMatching(/^agy-orchestrator wait t-/) });
    await m.idle();
    const rec = await m.get((r as { jobId: string }).jobId);
    expect(rec?.state).toBe("passed");
    expect(rec?.progress.percent).toBe(100);
    expect(rec?.title).toBe("Fix add()");
    expect(approver.calls.map((c) => c.kind)).toEqual(["task"]);
    expect(specs[0]).toMatchObject({ kind: "implement", task: "Fix add()\nmore detail" });
  });

  it("refuses without an estimate or when delegating is cheaper to skip", async () => {
    const { m, repo } = setup();
    expect(await m.start({ repoRoot: repo, kind: "implement", task: "x" })).toMatchObject({ state: "refused", reason: expect.stringMatching(/estimate required/) });
    expect(await m.start({ repoRoot: repo, kind: "implement", task: "x", estimate: { directTokens: 3000, delegateOverheadTokens: 4000, reason: "" } }))
      .toMatchObject({ state: "refused", reason: expect.stringMatching(/cheaper to do directly/) });
  });

  it("returns denied when the user denies the card", async () => {
    const { m, repo } = setup({ approver: new FakeApprover({ task: false }) });
    expect(await m.start({ repoRoot: repo, kind: "explore", task: "How does x work?" })).toMatchObject({ state: "denied" });
  });

  it("asks once per plan, then runs later steps without a card until the plan changes", async () => {
    const { m, repo, approver } = setup();
    const file = path.join(repo, "plan.md");
    writeFileSync(file, PLAN);
    await m.start({ repoRoot: repo, kind: "implement", plan: { file, step: 1, delegateSteps: [1, 2] }, estimate: EST });
    await m.start({ repoRoot: repo, kind: "implement", plan: { file, step: 2 }, estimate: EST });
    expect(approver.calls.map((c) => c.kind)).toEqual(["plan"]);
    expect((approver.calls[0].card as { steps: number[]; title: string })).toMatchObject({ steps: [1, 2], title: "Demo Plan" });
    writeFileSync(file, PLAN + "\n### Task 3: Third\n");
    await m.start({ repoRoot: repo, kind: "implement", plan: { file, step: 3 }, estimate: EST });
    expect(approver.calls.map((c) => c.kind)).toEqual(["plan", "plan"]);
    await m.idle();
  });

  it("uses per-task cards for plans when approval is per_task", async () => {
    const { m, repo, approver } = setup({ config: { approval: "per_task" } });
    const file = path.join(repo, "plan.md");
    writeFileSync(file, PLAN);
    await m.start({ repoRoot: repo, kind: "implement", plan: { file, step: 1 }, estimate: EST });
    expect(approver.calls.map((c) => c.kind)).toEqual(["task"]);
    await m.idle();
  });

  it("dry run needs no approval and creates no job", async () => {
    const { m, repo, approver, deps } = setup();
    const r = await m.start({ repoRoot: repo, kind: "implement", task: "Do it", dryRun: true });
    expect(r).toMatchObject({ state: "dry_run" });
    if (r.state === "dry_run") {
      expect(r.brief).toContain("<task>");
      expect(r.command).toEqual(expect.arrayContaining(["--output-format", "stream-json", "--print-timeout"]));
    }
    expect(approver.calls).toEqual([]);
    expect(await deps.store.list()).toEqual([]);
  });

  it("queues beyond max_concurrent and runs the queue afterwards", async () => {
    const { m, repo } = setup({ config: { max_concurrent: 1 } });
    const a = await m.start({ repoRoot: repo, kind: "explore", task: "a" });
    const b = await m.start({ repoRoot: repo, kind: "explore", task: "b" });
    expect([a.state, b.state]).toEqual(["running", "queued"]);
    await m.idle();
    expect((await m.get((b as { jobId: string }).jobId))?.state).toBe("passed");
  });
});

describe("quota handling", () => {
  it("sets a cooldown, shows the quota card once, and wait keeps refusing", async () => {
    const approver = new FakeApprover({ quota: "wait" });
    const { m, repo } = setup({ approver, result: (s) => envelope(s, "quota", { quota: { resetInSec: 600, resetText: "10m" } }) });
    await m.start({ repoRoot: repo, kind: "explore", task: "a" });
    await m.idle();
    expect(approver.calls.filter((c) => c.kind === "quota")).toHaveLength(1);
    const r = await m.start({ repoRoot: repo, kind: "explore", task: "b" });
    expect(r).toMatchObject({ state: "quota", options: ["retry", "continue_without", "wait"] });
    expect(approver.calls.filter((c) => c.kind === "task")).toHaveLength(1);
  });

  it("continue_without pauses delegation until resumed", async () => {
    const approver = new FakeApprover({ quota: "continue_without" });
    const { m, repo } = setup({ approver, result: (s) => envelope(s, "quota", { quota: { resetInSec: 600 } }) });
    await m.start({ repoRoot: repo, kind: "explore", task: "a" });
    await m.idle();
    expect(await m.start({ repoRoot: repo, kind: "explore", task: "b" })).toMatchObject({ state: "refused", reason: expect.stringMatching(/resume_delegation/) });
    await m.act({ action: "resume_delegation" });
    expect((await m.status()).delegation).toBe("active");
  });

  it("retry clears the cooldown and continues the paused task as a follow-up", async () => {
    let calls = 0;
    const approver = new FakeApprover({ quota: "retry" });
    const { m, repo, specs } = setup({ approver, result: (s) => (calls++ === 0 ? envelope(s, "quota", { quota: { resetInSec: 600 }, conversationId: "c1" }) : envelope(s, "passed")) });
    await m.start({ repoRoot: repo, kind: "implement", task: "build it", estimate: EST });
    await m.idle();
    expect(specs).toHaveLength(2);
    expect(specs[1]).toMatchObject({ conversationId: "c1", baseRef: `agy/${specs[0].jobId}` });
    expect(specs[1].task).toContain("usage limit");
  });
});

describe("act", () => {
  it("follow-up builds on the parent branch and conversation", async () => {
    const { m, repo, specs } = setup({ result: (s) => envelope(s, "failed", { conversationId: "conv-9" }) });
    const r = await m.start({ repoRoot: repo, kind: "implement", task: "build", estimate: EST });
    await m.idle();
    const f = await m.act({ action: "followup", jobId: (r as { jobId: string }).jobId, feedback: "handle empty input" });
    expect(f.jobId).toMatch(/^t-/);
    await m.idle();
    expect(specs[1]).toMatchObject({ baseRef: `agy/${specs[0].jobId}`, conversationId: "conv-9" });
    expect(specs[1].task).toContain("handle empty input");
    expect(specs[1].contractTests ?? []).toEqual([]);
  });

  it("revoke_plan forces a new plan card", async () => {
    const { m, repo, approver } = setup();
    const file = path.join(repo, "plan.md");
    writeFileSync(file, PLAN);
    await m.start({ repoRoot: repo, kind: "implement", plan: { file, step: 1 }, estimate: EST });
    await m.act({ action: "revoke_plan", planFile: file });
    await m.start({ repoRoot: repo, kind: "implement", plan: { file, step: 2 }, estimate: EST });
    expect(approver.calls.map((c) => c.kind)).toEqual(["plan", "plan"]);
    await m.idle();
  });

  it("quota_choice applies the user's choice in client mode", async () => {
    const approver = new FakeApprover({ quota: "unavailable" });
    const { m, repo } = setup({ approver, result: (s) => envelope(s, "quota", { quota: { resetInSec: 600 } }) });
    await m.start({ repoRoot: repo, kind: "explore", task: "a" });
    await m.idle();
    expect(await m.start({ repoRoot: repo, kind: "explore", task: "b" })).toMatchObject({ state: "quota" });
    expect(await m.act({ action: "quota_choice", choice: "retry" })).toMatchObject({ state: "ok", choice: "retry" });
    expect((await m.start({ repoRoot: repo, kind: "explore", task: "c" })).state).toBe("running");
    await m.idle();
  });
});
```

- [ ] **Step 2–4:** fail → implement → pass. **Step 5:** leave uncommitted.

---

### Task 4: MCP server (4 tools) and the elicitation approver

**Files:** Create `src/server.ts`, `test/server.test.ts`

**Interfaces:**
```ts
export const TOOL_NAMES: readonly ["agy_status", "agy_start", "agy_get", "agy_act"];
export function createServer(manager: JobManager, o: { defaultRepoRoot: () => string; version: string }): McpServer;
export class ElicitationApprover implements Approver {
  constructor(server: McpServer);
  // plan/task: elicit { decision: enum ["approve","deny"] } with the card text as message; approve only on action "accept" with decision "approve".
  // quota: elicit { choice: enum ["retry","continue_without","wait"] }; decline/cancel → "wait".
  // If the client has no elicitation capability → plan/task throw ApprovalUnavailable("client does not support approval cards; set gate: client in .agy-orchestrator.json"); quota → "unavailable".
}
```

**Tools (snake_case input fields, short descriptions; results are one `text` content item holding JSON):**
- `agy_status` `{ repo? }` → `manager.status(repo)`
- `agy_start` `{ repo?, kind, task?, plan?: {file, step, delegate_steps?}, contract_tests?: [{path, content}], skills?, estimate?: {direct_tokens, delegate_overhead_tokens, reason}, effort?, dry_run?, base_ref? }` → `manager.start` (map snake_case to camelCase)
- `agy_get` `{ job_id, wait_s? (0–60), diff_mode?, paths?, max_diff_tokens? }` → `manager.get`. While long-polling, if the request has a progress token, send `notifications/progress` every 5 s with `progress = percent`, `total = 100`, `message = renderProgressLine`.
- `agy_act` `{ action, job_id?, feedback?, mode?, choice?, plan_file? }` → `manager.act`. Invalid combinations → an `isError` result with a reason.

`repo` defaults to `defaultRepoRoot()`. Unknown job → `isError` result `job not found: <id>`.

- [ ] **Step 1: Write the test**

`test/server.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer, ElicitationApprover, TOOL_NAMES } from "../src/server.js";
import type { JobManager } from "../src/jobs/manager.js";
import { ApprovalUnavailable } from "../src/jobs/approver.js";

function fakeManager(log: unknown[]): JobManager {
  return {
    start: async (i: unknown) => { log.push(["start", i]); return { state: "running", jobId: "t-1", waitHint: "agy-orchestrator wait t-1" }; },
    get: async (id: string) => (id === "t-1" ? { id, state: "passed" } : undefined),
    act: async (i: unknown) => { log.push(["act", i]); return { state: "ok" }; },
    status: async () => ({ delegation: "active" }),
    idle: async () => {},
  } as unknown as JobManager;
}

async function connect(manager: JobManager, capabilities: object = {}) {
  const server = createServer(manager, { defaultRepoRoot: () => "/repo", version: "0.0.1" });
  const client = new Client({ name: "test", version: "1" }, { capabilities });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { server, client };
}
const json = (r: { content: unknown }) => JSON.parse((r.content as { text: string }[])[0].text);

describe("MCP server", () => {
  it("exposes exactly the 4 tools within the schema budget", async () => {
    const { client } = await connect(fakeManager([]));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(JSON.stringify(tools).length / 4).toBeLessThan(1500);
  });

  it("maps agy_start snake_case input and defaults the repo", async () => {
    const log: unknown[] = [];
    const { client } = await connect(fakeManager(log));
    const r = await client.callTool({ name: "agy_start", arguments: {
      kind: "implement", task: "x", estimate: { direct_tokens: 20000, delegate_overhead_tokens: 4000, reason: "r" },
      plan: { file: "p.md", step: 2, delegate_steps: [2, 3] }, contract_tests: [{ path: "t.test.ts", content: "c" }], dry_run: false,
    } });
    expect(json(r as { content: unknown })).toMatchObject({ state: "running", jobId: "t-1" });
    expect(log[0]).toEqual(["start", expect.objectContaining({
      repoRoot: "/repo", kind: "implement", task: "x", dryRun: false,
      estimate: { directTokens: 20000, delegateOverheadTokens: 4000, reason: "r" },
      plan: { file: "p.md", step: 2, delegateSteps: [2, 3] }, contractTests: [{ path: "t.test.ts", content: "c" }],
    })]);
  });

  it("returns job records and errors for unknown jobs", async () => {
    const { client } = await connect(fakeManager([]));
    expect(json(await client.callTool({ name: "agy_get", arguments: { job_id: "t-1" } }) as { content: unknown })).toMatchObject({ state: "passed" });
    const missing = await client.callTool({ name: "agy_get", arguments: { job_id: "t-9" } });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain("job not found: t-9");
  });

  it("maps agy_act and agy_status", async () => {
    const log: unknown[] = [];
    const { client } = await connect(fakeManager(log));
    await client.callTool({ name: "agy_act", arguments: { action: "finalize", job_id: "t-1", mode: "squash" } });
    expect(log[0]).toEqual(["act", { action: "finalize", jobId: "t-1", mode: "squash" }]);
    expect(json(await client.callTool({ name: "agy_status", arguments: {} }) as { content: unknown })).toEqual({ delegation: "active" });
  });
});

describe("ElicitationApprover", () => {
  it("approves only on accept + approve, and maps quota choices", async () => {
    const { server, client } = await connect(fakeManager([]), { elicitation: {} });
    const answers = [{ action: "accept", content: { decision: "approve" } }, { action: "accept", content: { decision: "deny" } }, { action: "decline" }, { action: "accept", content: { choice: "continue_without" } }, { action: "cancel" }];
    const messages: string[] = [];
    client.setRequestHandler(ElicitRequestSchema, async (req) => { messages.push(String(req.params.message)); return answers.shift() as never; });
    const a = new ElicitationApprover(server);
    expect(await a.plan({ planFile: "p.md", title: "Demo", steps: [1] })).toBe(true);
    expect(await a.task({ title: "t", kind: "explore", effort: "low", skills: [] })).toBe(false);
    expect(await a.task({ title: "t", kind: "explore", effort: "low", skills: [] })).toBe(false);
    expect(await a.quota({ resetText: "10m" })).toBe("continue_without");
    expect(await a.quota({ resetText: "10m" })).toBe("wait");
    expect(messages[0]).toContain('Delegate plan "Demo"');
  });

  it("is unavailable without the elicitation capability", async () => {
    const { server } = await connect(fakeManager([]));
    const a = new ElicitationApprover(server);
    await expect(a.plan({ planFile: "p", title: "t", steps: [1] })).rejects.toBeInstanceOf(ApprovalUnavailable);
    expect(await a.quota({})).toBe("unavailable");
  });
});
```

- [ ] **Step 2–4:** fail → implement → pass. **Step 5:** leave uncommitted.

---

### Task 5: Runtime wiring and CLI (`serve`, `wait`, `watch`, `doctor`, `init`)

**Files:** Create `src/runtime.ts`, `src/cli.ts`, `test/cli.test.ts`. Modify `src/index.ts` and `README.md` (add a "Quick start" section).

**Interfaces:**
```ts
// runtime.ts
export function hookBundlePath(): string;   // path.join(dirname(fileURLToPath(import.meta.url)), "agyo-hook.js") (dist layout)
export function createRuntime(o: { cwd: string; env: NodeJS.ProcessEnv; approverFor: (gate: "elicitation" | "client") => Approver }): { manager: JobManager; store: JobStore };

// cli.ts
export interface Io { out: (s: string) => void; err: (s: string) => void; env: NodeJS.ProcessEnv; cwd: string }
export function waitExitCode(state: string): number;            // passed→0; failed|conflict|refused|denied|guard_violation→1; quota→2; anything else→3
export function summaryLines(rec: JobRecord): string[];          // [`<id> <state> · <passed>/<tests> tests · <n> files changed`, `next: agy_get <id>`]
export function detectTestCommand(repoRoot: string): { test_command?: string[]; setup_command?: string[]; test_report?: string };
export interface DoctorCheck { name: string; ok: boolean; detail: string }
export function doctor(d: { run: (argv: string[]) => Promise<ExecResult>; model: string; nodeVersion: string }): Promise<DoctorCheck[]>;
export function main(argv: string[], io: Io): Promise<number>;
```

**Implementation notes:**
- All CLI paths use `io.env` (e.g. `jobsDir({ env: io.env })`, `loadRuntimeConfig(io.env)`), never `process.env` directly, so tests can redirect state with `AGYO_STATE_DIR`.
- `main` commands:
  - `serve` (also the default with no args): `createRuntime` with an approver chosen by the repo config `gate` (elicitation → `new ElicitationApprover(server)`, client → `ClientModeApprover`), `createServer`, connect `StdioServerTransport`, and resolve when stdin closes.
  - `wait <id> [--timeout-sec N]` (default 3600): poll `JobStore(jobsDir())` every 500 ms. On a terminal state, print `summaryLines` and return `waitExitCode`. On timeout, print `timeout waiting for <id>` and return 3. Unknown job → `job not found` and 3.
  - `watch [id] [--once]`: print `renderProgressLine` for the given job, or for every non-terminal job, once per second until all are terminal. `--once` prints a single frame and returns 0.
  - `doctor`: print `✓/✗ name: detail` per check, and return 1 if any check failed.
  - `init`: write `.agy-orchestrator.json` with `detectTestCommand` results (refuse with code 1 if the file exists), then print `Register with Claude Code:\n  claude mcp add agy-orchestrator -- npx -y agy-orchestrator serve`.
- `detectTestCommand`:
  - `package.json` with `scripts.test` → `test_command: ["npm","test"]` and `setup_command: ["npm","ci"]` if a lockfile exists, else `["npm","install"]`.
  - `pyproject.toml` or `pytest.ini` → `["python","-m","pytest","-q","--junitxml=reports/junit.xml"]` plus `test_report: "reports/junit.xml"`.
  - `go.mod` → `["go","test","./..."]`.
  - `Makefile` with a `test:` target → `["make","test"]`.
  - Otherwise `{}`.
- `doctor` checks, in this order:
  - `node` (version ≥ 20)
  - `agy` (`agy --version` exits 0)
  - `agy login` (`agy models` exits 0 and its output contains `model`; on failure, detail says to run `agy` once interactively)
  - `git` (`git --version` ≥ 2.38)
- `src/index.ts`: `#!/usr/bin/env node`, then `process.exitCode = await main(process.argv.slice(2), {out: console.log, err: console.error, env: process.env, cwd: process.cwd()})`. The `serve` path must never print to stdout except MCP traffic.
- README "Quick start": `npx agy-orchestrator init`, then `npx agy-orchestrator doctor`, then the `claude mcp add` line. Also a short "How it works" (plan approval once, gate, verification) and the ToS note already in the README.

- [ ] **Step 1: Write the test**

`test/cli.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main, waitExitCode, summaryLines, detectTestCommand, doctor, type Io } from "../src/cli.js";
import { JobStore, emptyProgress, type JobRecord } from "../src/jobs/store.js";

function io(env: NodeJS.ProcessEnv = {}, cwd = os.tmpdir()) {
  const out: string[] = [];
  const err: string[] = [];
  const i: Io = { out: (s) => out.push(s), err: (s) => err.push(s), env, cwd };
  return { i, out, err };
}
const rec = (id: string, state: JobRecord["state"]): JobRecord => ({
  id, kind: "implement", repoRoot: "/r", title: "t", state, progress: { ...emptyProgress(), percent: state === "running" ? 40 : 100, phase: state === "running" ? "run" : "done" },
  createdAt: "2026-10-17T10:00:00Z", updatedAt: "2026-10-17T10:00:00Z", returnedChars: 0,
  envelope: state === "running" ? undefined : ({ state, diffStat: " a | 1 +\n b | 2 +-\n 2 files changed, 2 insertions(+), 1 deletion(-)", verify: { counts: { tests: 48, failures: 0, errors: 0, skipped: 0, failed: [] }, passed: true } } as never),
});

describe("waitExitCode and summaryLines", () => {
  it("maps states to exit codes", () => {
    expect([waitExitCode("passed"), waitExitCode("failed"), waitExitCode("guard_violation"), waitExitCode("quota"), waitExitCode("timeout")]).toEqual([0, 1, 1, 2, 3]);
  });
  it("summarizes a finished job", () => {
    expect(summaryLines(rec("t-1", "passed"))).toEqual(["t-1 passed · 48/48 tests · 2 files changed", "next: agy_get t-1"]);
  });
});

describe("wait and watch", () => {
  it("waits for a terminal state and returns its exit code", async () => {
    const state = mkdtempSync(path.join(os.tmpdir(), "agyo-cli-"));
    const store = new JobStore(path.join(state, "jobs"));
    await store.write(rec("t-w", "running"));
    setTimeout(() => void store.write(rec("t-w", "quota")), 300);
    const { i, out } = io({ AGYO_STATE_DIR: state });
    expect(await main(["wait", "t-w", "--timeout-sec", "10"], i)).toBe(2);
    expect(out.join("\n")).toContain("t-w quota");
  });
  it("times out and reports unknown jobs", async () => {
    const state = mkdtempSync(path.join(os.tmpdir(), "agyo-cli-"));
    await new JobStore(path.join(state, "jobs")).write(rec("t-s", "running"));
    expect(await main(["wait", "t-s", "--timeout-sec", "1"], io({ AGYO_STATE_DIR: state }).i)).toBe(3);
    const u = io({ AGYO_STATE_DIR: state });
    expect(await main(["wait", "t-none", "--timeout-sec", "1"], u.i)).toBe(3);
    expect(u.out.concat(u.err).join("\n")).toContain("job not found");
  });
  it("watch --once prints one progress frame", async () => {
    const state = mkdtempSync(path.join(os.tmpdir(), "agyo-cli-"));
    await new JobStore(path.join(state, "jobs")).write(rec("t-p", "running"));
    const { i, out } = io({ AGYO_STATE_DIR: state });
    expect(await main(["watch", "--once"], i)).toBe(0);
    expect(out.join("\n")).toMatch(/t-p .*40% · run/);
  });
});

describe("detectTestCommand and init", () => {
  it("detects npm, pytest and go projects", () => {
    const npm = mkdtempSync(path.join(os.tmpdir(), "agyo-det-"));
    writeFileSync(path.join(npm, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    writeFileSync(path.join(npm, "package-lock.json"), "{}");
    expect(detectTestCommand(npm)).toEqual({ test_command: ["npm", "test"], setup_command: ["npm", "ci"] });
    const py = mkdtempSync(path.join(os.tmpdir(), "agyo-det-"));
    writeFileSync(path.join(py, "pyproject.toml"), "[project]\nname='x'\n");
    expect(detectTestCommand(py)).toEqual({ test_command: ["python", "-m", "pytest", "-q", "--junitxml=reports/junit.xml"], test_report: "reports/junit.xml" });
    const go = mkdtempSync(path.join(os.tmpdir(), "agyo-det-"));
    writeFileSync(path.join(go, "go.mod"), "module x\n");
    expect(detectTestCommand(go)).toEqual({ test_command: ["go", "test", "./..."] });
    expect(detectTestCommand(mkdtempSync(path.join(os.tmpdir(), "agyo-det-")))).toEqual({});
  });
  it("init writes the config once and prints the registration command", async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "agyo-init-"));
    writeFileSync(path.join(repo, "go.mod"), "module x\n");
    const a = io({}, repo);
    expect(await main(["init"], a.i)).toBe(0);
    expect(JSON.parse(readFileSync(path.join(repo, ".agy-orchestrator.json"), "utf8"))).toEqual({ test_command: ["go", "test", "./..."] });
    expect(a.out.join("\n")).toContain("claude mcp add agy-orchestrator -- npx -y agy-orchestrator serve");
    expect(await main(["init"], io({}, repo).i)).toBe(1);
    expect(existsSync(path.join(repo, ".agy-orchestrator.json"))).toBe(true);
  });
});

describe("doctor", () => {
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", timedOut: false });
  it("passes when everything is present", async () => {
    const checks = await doctor({ nodeVersion: "v22.1.0", model: "gemini-3.8-flash-high", run: async (argv) =>
      argv[0] === "git" ? ok("git version 2.54.0.windows.1") : argv[1] === "models" ? ok("gemini-3.8-flash-high\tGemini 3.8 Flash (High)") : ok("1.4.0") });
    expect(checks.map((c) => [c.name, c.ok])).toEqual([["node", true], ["agy", true], ["agy login", true], ["git", true]]);
  });
  it("flags old node, missing agy login and old git", async () => {
    const checks = await doctor({ nodeVersion: "v18.0.0", model: "gemini-3.8-flash-high", run: async (argv) =>
      argv[0] === "git" ? ok("git version 2.30.1") : argv[1] === "models" ? { code: 1, stdout: "", stderr: "authentication required", timedOut: false } : ok("1.4.0") });
    expect(checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["node", "agy login", "git"]);
    expect(checks.find((c) => c.name === "agy login")?.detail).toMatch(/run `agy` once/);
  });
});
```

- [ ] **Step 2–4:** fail → implement → pass. Then full suite, typecheck, format and build; `node dist/index.js doctor` should run on the dev machine.
- [ ] **Step 5:** leave uncommitted.

---

## Self-review
- **Spec coverage:** §5 tools → T4. §6.1 async (`wait`, long-poll with progress notifications, MCP auto-background) → T3, T4, T5. §6.2 progress % → T1, T3. §7.1 once-per-plan approval, per-task cards, `revoke_plan`, reserved `auto` → T2, T3. §7.2 token gate and calibration → T1, T2, T3. §7.3 quota card with retry/continue/wait and no auto-retry → T2, T3, T4. Finalize with merge-tree and the provenance trailer → T3. Plan-file input → T2, T3. Dry run → T3. Doctor and init → T5. **Deferred:** `lesson` action and learning loop (Plan 4), MCP Tasks (v0.2), `ask_user` bridge (v0.2).
- **Type consistency:** `Estimate`, `JobRecord`, `Progress` are defined in T1 and used in T2–T5. `Approver` and cards are from T2, used by T3/T4. The `JobManager` API is from T3, used by T4/T5.
- **Commits:** implementers leave work uncommitted, because the gate blocks `git commit`. The orchestrator commits after review.
