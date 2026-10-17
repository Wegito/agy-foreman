# Plan 5: Deepening the jobs, approval and pipeline modules

Source: architecture review of 2026-10-17 (candidates 1–7). Order: scheduler first (it holds the worst bugs and the other jobs refactors build on it), then approval, policy, pipeline, hook file contract, tool inputs, job watching.

Rules for every task:

- Files under `test/` are protected. Do not edit existing tests. All existing tests must keep passing unchanged, so keep every public interface used by `test/` (constructor arguments, method names, return shapes) compatible.
- Add only the new contract test given in the task.
- Keep code style: TypeScript ESM, `.js` import suffixes, 2-space indent, Prettier (`npx prettier --write` on files you touch).
- No new dependencies.

### Task 1: One job scheduler module owns the job lifecycle

**Files:**

- Create: `src/jobs/scheduler.ts`
- Modify: `src/jobs/manager.ts`, `src/jobs/execute.ts`, `src/jobs/actions.ts`, `src/jobs/helpers.ts`, `src/jobs/store.ts`, `src/runtime.ts`, `src/cli.ts`

Interface of `src/jobs/scheduler.ts`:

```ts
export interface SchedulerDeps {
  store: JobStore;
  loadConfig: (repoRoot: string) => Config;
  now: () => Date;
  /** Runs one job to completion and resolves when it is over (the record is already terminal). */
  run: (record: JobRecord, spec: JobSpec, signal: AbortSignal) => Promise<void>;
}
export class JobScheduler {
  constructor(deps: SchedulerDeps); // no I/O in the constructor
  /** Writes the record as "running" or "queued" and starts it when the repo has a free slot. */
  submit(record: JobRecord, spec: JobSpec): Promise<"running" | "queued">;
  /** Running job: aborts its signal. Queued job: marks it "cancelled" and drops it. Unknown: false. */
  cancel(jobId: string): Promise<boolean>;
  /** Per-job serialized store write (moves JobManager.writeRecord/writeQueues here). */
  write(record: JobRecord): Promise<void>;
  /** Resolves when no submitted job is queued or running. */
  idle(): Promise<void>;
  /** Marks "queued"/"running" records this process does not own as "error" with errorReason
   *  "orphaned: the server restarted before the job finished". Returns their ids. Call once at startup. */
  recoverOrphans(): Promise<string[]>;
}
```

Behavior:

- Concurrency is counted from the scheduler's own in-memory running set per repo (`isSamePath`), never from a stale store snapshot. When a job finishes, start queued jobs (oldest first) one at a time, re-checking the slot count after each start, so a repo never exceeds `max_concurrent`.
- The hourly cap counts jobs of that repo whose `createdAt` is within the last hour and that have actually started (state not "queued"); the job being considered is not counted. A queued job blocked by the hourly cap stays queued.
- The scheduler owns all four former maps (active jobs, queued specs, abort controllers, write queues) and is the only code that sets "queued", "running" (when starting) or "cancelled" (when cancelling a queued job).
- Add `errorReason?: string` to `JobRecord` in `src/jobs/store.ts`.
- `executeJob` in `execute.ts` becomes `executeJob(ctx, record, spec, signal): Promise<void>`: it runs the pipeline and records the result, and no longer touches any maps, drains or checks idle. Its ctx shrinks to `{ deps, write, startFollowup }`.
- `JobManager` composes a `JobScheduler` (run = executeJob) and keeps its public interface and `JobManagerDeps` exactly as they are. `start`, followups (`startFollowup` in actions.ts) and `cancel` use `submit`/`cancel`; `idle()` delegates. Delete the duplicated register-and-schedule code and `canRunJob` if nothing else uses it.
- Add `JobManager.recoverOrphans()` delegating to the scheduler; `cli.ts` `serve` calls it once before connecting the transport.

Contract test `test/jobs/scheduler.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobScheduler } from "../../src/jobs/scheduler.js";
import { JobStore, emptyProgress, type JobRecord } from "../../src/jobs/store.js";
import { parseProjectConfig, loadRuntimeConfig } from "../../src/config.js";
import type { JobSpec } from "../../src/pipeline/index.js";

const NOW = new Date("2026-10-17T12:00:00Z");

function rec(id: string, extra: Partial<JobRecord> = {}): JobRecord {
  return {
    id,
    kind: "implement",
    repoRoot: "/repo",
    title: id,
    state: "queued",
    progress: emptyProgress(),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    returnedChars: 0,
    ...extra,
  };
}
const spec = (id: string) => ({ jobId: id }) as unknown as JobSpec;

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(config: object) {
  const store = new JobStore(mkdtempSync(path.join(os.tmpdir(), "foreman-sched-")));
  let running = 0;
  let maxSeen = 0;
  const started: string[] = [];
  const release = new Map<string, () => void>();
  const signals = new Map<string, AbortSignal>();
  const s = new JobScheduler({
    store,
    loadConfig: () => ({
      project: parseProjectConfig({ test_command: ["x"], ...config }),
      runtime: loadRuntimeConfig({}),
    }),
    now: () => NOW,
    run: (r, _spec, signal) => {
      started.push(r.id);
      signals.set(r.id, signal);
      running++;
      maxSeen = Math.max(maxSeen, running);
      return new Promise<void>((resolve) =>
        release.set(r.id, () => {
          running--;
          resolve();
        }),
      );
    },
  });
  const finish = (id: string) => release.get(id)!();
  return { s, store, started, signals, finish, maxSeen: () => maxSeen };
}

describe("JobScheduler", () => {
  it("never exceeds max_concurrent and starts one queued job per freed slot", async () => {
    const t = setup({ max_concurrent: 1 });
    expect(await t.s.submit(rec("a"), spec("a"))).toBe("running");
    expect(await t.s.submit(rec("b"), spec("b"))).toBe("queued");
    expect(await t.s.submit(rec("c"), spec("c"))).toBe("queued");
    expect(t.started).toEqual(["a"]);
    t.finish("a");
    await until(() => t.started.length === 2);
    await pause(100);
    expect(t.started).toEqual(["a", "b"]);
    expect((await t.store.read("b"))?.state).toBe("running");
    expect((await t.store.read("c"))?.state).toBe("queued");
    t.finish("b");
    await until(() => t.started.length === 3);
    t.finish("c");
    await t.s.idle();
    expect(t.maxSeen()).toBe(1);
  });

  it("fills two slots without over-starting when both free up at once", async () => {
    const t = setup({ max_concurrent: 2 });
    for (const id of ["a", "b", "c", "d", "e"]) await t.s.submit(rec(id), spec(id));
    expect(t.started).toEqual(["a", "b"]);
    t.finish("a");
    t.finish("b");
    await until(() => t.started.length === 4);
    await pause(100);
    expect(t.started.length).toBe(4);
    t.finish("c");
    t.finish("d");
    await until(() => t.started.length === 5);
    t.finish("e");
    await t.s.idle();
    expect(t.maxSeen()).toBe(2);
  });

  it("counts started jobs, not the job being considered, against the hourly cap", async () => {
    const t = setup({ max_concurrent: 5, max_runs_per_hour: 1 });
    expect(await t.s.submit(rec("a"), spec("a"))).toBe("running");
    expect(await t.s.submit(rec("b"), spec("b"))).toBe("queued");
    t.finish("a");
    await pause(150);
    expect(t.started).toEqual(["a"]);
    expect((await t.store.read("b"))?.state).toBe("queued");
  });

  it("marks queued and running records it does not own as orphaned errors", async () => {
    const t = setup({});
    await t.store.write(rec("x", { state: "running" }));
    await t.store.write(rec("y", { state: "queued" }));
    await t.store.write(rec("z", { state: "passed" }));
    expect((await t.s.recoverOrphans()).sort()).toEqual(["x", "y"]);
    const x = await t.store.read("x");
    expect(x?.state).toBe("error");
    expect(x?.errorReason).toMatch(/restarted/);
    expect((await t.store.read("y"))?.state).toBe("error");
    expect((await t.store.read("z"))?.state).toBe("passed");
  });

  it("cancels a queued job without running it and aborts a running one", async () => {
    const t = setup({ max_concurrent: 1 });
    await t.s.submit(rec("a"), spec("a"));
    await t.s.submit(rec("b"), spec("b"));
    expect(await t.s.cancel("b")).toBe(true);
    expect((await t.store.read("b"))?.state).toBe("cancelled");
    expect(await t.s.cancel("a")).toBe(true);
    expect(t.signals.get("a")?.aborted).toBe(true);
    t.finish("a");
    await t.s.idle();
    expect(t.started).toEqual(["a"]);
    expect(await t.s.cancel("nope")).toBe(false);
  });

  it("idle resolves only after every submitted job is over", async () => {
    const t = setup({});
    await t.s.submit(rec("a"), spec("a"));
    let done = false;
    void t.s.idle().then(() => (done = true));
    await pause(50);
    expect(done).toBe(false);
    t.finish("a");
    await until(() => done);
  });
});
```

### Task 2: The approval gate follows the job's repo

**Files:**

- Modify: `src/jobs/approver.ts`, `src/runtime.ts`, `src/cli.ts`, `src/jobs/start.ts`, `src/jobs/actions.ts`, `src/jobs/execute.ts`

Interface added to `src/jobs/approver.ts`:

```ts
// Every card type (PlanCard, TaskCard, QuotaCard, PromoteCard) gains `repoRoot?: string`.
// The Approver interface gains an optional `isClientMode?(repoRoot: string): boolean`.
export class RepoApprover implements Approver {
  constructor(o: {
    gateFor: (repoRoot: string) => "elicitation" | "client"; // called on every card (config may change)
    elicitation: Approver;
    client: Approver;
    defaultRepoRoot: string; // used when a card has no repoRoot
  });
  plan(c: PlanCard): Promise<boolean>;
  task(c: TaskCard): Promise<boolean>;
  quota(c: QuotaCard): Promise<QuotaChoice | "unavailable">;
  promote(c: PromoteCard): Promise<boolean>;
  isClientMode(repoRoot: string): boolean;
}
```

Behavior:

- `runtime.ts`: replace the four copied lambdas with one `RepoApprover`, `gateFor = (r) => loadConfig({ repoRoot: r, env }).project.gate`, `defaultRepoRoot = cwd`. Keep `createRuntime`'s signature; `approverFor(gate)` is called at most once per gate (cache the two adapters), so `ElicitationApprover` is no longer created on every card.
- Every place that shows a card passes the job's `repoRoot` (start.ts plan/task/quota cards, actions.ts followup task card and promote card, execute.ts quota card).
- `actions.ts`: replace the `instanceof ClientModeApprover || (approver as any).isClientMode || …` check with `approver.isClientMode?.(repoRoot) ?? loadConfig(repoRoot).project.gate === "client"`.

Contract test `test/jobs/repo-approver.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { FakeApprover, RepoApprover } from "../../src/jobs/approver.js";

describe("RepoApprover", () => {
  const make = () => {
    const elicitation = new FakeApprover({ plan: false, task: false, quota: "wait" });
    const client = new FakeApprover({ plan: true, task: true, quota: "unavailable" });
    const gates: Record<string, "elicitation" | "client"> = { "/a": "elicitation", "/b": "client" };
    const a = new RepoApprover({
      gateFor: (r) => gates[r] ?? "elicitation",
      elicitation,
      client,
      defaultRepoRoot: "/a",
    });
    return { a, elicitation, client, gates };
  };

  it("routes each card by the gate of the card's repo", async () => {
    const { a, elicitation, client } = make();
    expect(await a.plan({ planFile: "p.md", title: "t", steps: [1], repoRoot: "/b" })).toBe(true);
    expect(
      await a.task({ title: "t", kind: "implement", effort: "high", skills: [], repoRoot: "/a" }),
    ).toBe(false);
    expect(client.calls.map((c) => c.kind)).toEqual(["plan"]);
    expect(elicitation.calls.map((c) => c.kind)).toEqual(["task"]);
  });

  it("uses the default repo when a card has none, and re-reads the gate on every card", async () => {
    const { a, elicitation, client, gates } = make();
    expect(await a.quota({ resetText: "5m" })).toBe("wait");
    gates["/a"] = "client";
    expect(await a.quota({ resetText: "5m" })).toBe("unavailable");
    expect(elicitation.calls.length).toBe(1);
    expect(client.calls.length).toBe(1);
  });

  it("answers isClientMode per repo", () => {
    const { a } = make();
    expect(a.isClientMode("/b")).toBe(true);
    expect(a.isClientMode("/a")).toBe(false);
  });
});
```

### Task 3: Delegation policy and plan grants become deep modules

**Files:**

- Create: `src/jobs/policy.ts`
- Modify: `src/jobs/start.ts`, `src/jobs/execute.ts`, `src/jobs/actions.ts`, `src/jobs/manager.ts`, `src/jobs/flags.ts`, `src/jobs/approver.ts`, `src/jobs/lessons.ts`

Interface of `src/jobs/policy.ts`:

```ts
export class DelegationPolicy {
  constructor(flags: FlagStore, approver: Approver, now: () => Date);
  /** Before a new job. Paused → refused. Cooling down → shows the quota card:
   *  retry clears the cooldown and returns ok; continue_without pauses and returns refused
   *  ("continue without Gemini"); wait/unavailable returns the "quota" StartResult. */
  check(repoRoot?: string): Promise<{ ok: true } | { ok: false; result: StartResult }>;
  /** After a run hit the quota: stores a cooldown of max(60 s, resetInSec ?? 900 s), shows the
   *  quota card, applies the choice (same as choose) and returns it. Never throws. */
  onQuota(o: {
    resetInSec?: number;
    resetText?: string;
    pausedJobId?: string;
    repoRoot?: string;
  }): Promise<QuotaChoice | "unavailable">;
  /** retry: clear cooldown. continue_without: pause delegation. wait: nothing. */
  choose(choice: QuotaChoice): Promise<void>;
  resume(): Promise<void>;
  state(): Promise<{ delegation: "active" | "paused"; cooldown?: { until: string; resetText?: string } }>;
}

export class PlanGrants {
  constructor(flags: FlagStore, now: () => Date, ttlMs?: number); // default 24 h
  /** True when a live grant exists for this plan file (resolved against repoRoot, compared
   *  case-insensitively on Windows), with the same content hash, covering this step.
   *  A grant with an empty steps list covers every step. */
  covers(repoRoot: string, file: string, content: string, step: number): Promise<boolean>;
  grant(repoRoot: string, file: string, content: string, steps: number[]): Promise<void>;
  /** Removes all grants for this plan file in this repo. Returns how many were removed. */
  revoke(repoRoot: string, file: string): Promise<number>;
}
```

Behavior:

- Grants store the absolute resolved path in `PlanGrant.file`. `validGrant` in flags.ts is replaced by `PlanGrants.covers` (delete it if unused).
- start.ts: steps 1–2 become `policy.check(repoRoot)`; plan approval uses `grants.covers` / `grants.grant`, granting `delegateSteps` when given and `[]` (all steps) when not. `planCardText` shows "all steps" for an empty list.
- execute.ts quota handling becomes `policy.onQuota(...)` and, on "retry", the existing followup start.
- actions.ts: followup plan check uses `grants.covers` (relative plan file resolved against the parent's `repoRoot`); `quota_choice` → `policy.choose`; `resume_delegation` → `policy.resume`; `revoke_plan` → `grants.revoke(repoRoot, file)` where repoRoot is the server's default repo (`process.cwd()` as today).
- manager.ts `status()` uses `policy.state()`.
- Add `selectLessons(stores: { project: LessonStore; global: LessonStore }, audience: Audience, tags: string[], n = 5): Promise<string[]>` to lessons.ts (project first, deduplicated by text) and use it in both start.ts and manager.ts instead of the two copied loops.
- JobManager builds `DelegationPolicy` and `PlanGrants` from `deps.flags`, `deps.approver`, `deps.now`; `JobManagerDeps` stays unchanged.

Contract test `test/jobs/policy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DelegationPolicy, PlanGrants } from "../../src/jobs/policy.js";
import { FlagStore } from "../../src/jobs/flags.js";
import { FakeApprover } from "../../src/jobs/approver.js";

const NOW = new Date("2026-10-17T12:00:00Z");
const flags = () => new FlagStore(path.join(mkdtempSync(path.join(os.tmpdir(), "foreman-pol-")), "f.json"));

describe("PlanGrants", () => {
  it("covers the granted steps of the same plan file in the same repo, with the same content", async () => {
    let now = NOW;
    const g = new PlanGrants(flags(), () => now);
    const repoA = path.resolve("/repoA");
    const repoB = path.resolve("/repoB");
    await g.grant(repoA, "docs/plan.md", "v1", [1, 3]);
    expect(await g.covers(repoA, "docs/plan.md", "v1", 1)).toBe(true);
    expect(await g.covers(repoA, path.join(repoA, "docs", "plan.md"), "v1", 3)).toBe(true);
    expect(await g.covers(repoA, "docs/plan.md", "v1", 2)).toBe(false);
    expect(await g.covers(repoB, "docs/plan.md", "v1", 1)).toBe(false);
    expect(await g.covers(repoA, "docs/plan.md", "v2", 1)).toBe(false);
    now = new Date(NOW.getTime() + 25 * 3600_000);
    expect(await g.covers(repoA, "docs/plan.md", "v1", 1)).toBe(false);
  });

  it("treats an empty step list as the whole plan and revokes by relative path", async () => {
    const g = new PlanGrants(flags(), () => NOW);
    const repo = path.resolve("/repoA");
    await g.grant(repo, "docs/plan.md", "v1", []);
    await g.grant(repo, "docs/plan.md", "v1", [2]);
    expect(await g.covers(repo, "docs/plan.md", "v1", 7)).toBe(true);
    expect(await g.revoke(repo, "docs/plan.md")).toBe(2);
    expect(await g.covers(repo, "docs/plan.md", "v1", 7)).toBe(false);
  });
});

describe("DelegationPolicy", () => {
  it("refuses while paused and allows again after resume", async () => {
    const f = flags();
    await f.update((x) => ({ ...x, delegationPaused: true }));
    const p = new DelegationPolicy(f, new FakeApprover(), () => NOW);
    const r = await p.check("/r");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.result).toMatchObject({ state: "refused", reason: expect.stringMatching(/paused/) });
    await p.resume();
    expect(await p.check("/r")).toEqual({ ok: true });
    expect((await p.state()).delegation).toBe("active");
  });

  it("records a cooldown of at least 60 s after a quota stop and applies the choice", async () => {
    const f = flags();
    const p = new DelegationPolicy(f, new FakeApprover({ quota: "wait" }), () => NOW);
    expect(await p.onQuota({ resetInSec: 10, resetText: "10s", pausedJobId: "t-1" })).toBe("wait");
    const s = await p.state();
    expect(s.cooldown).toEqual({ until: new Date(NOW.getTime() + 60_000).toISOString(), resetText: "10s" });
    const r = await p.check("/r");
    expect(!r.ok && r.result).toMatchObject({ state: "quota", options: ["retry", "continue_without", "wait"] });
  });

  it("retry clears the cooldown; continue_without pauses delegation", async () => {
    const f = flags();
    await f.update((x) => ({ ...x, cooldownUntil: new Date(NOW.getTime() + 600_000).toISOString(), cooldownText: "10m" }));
    expect(await new DelegationPolicy(f, new FakeApprover({ quota: "retry" }), () => NOW).check("/r")).toEqual({ ok: true });
    expect((await new DelegationPolicy(f, new FakeApprover(), () => NOW).state()).cooldown).toBeUndefined();

    await f.update((x) => ({ ...x, cooldownUntil: new Date(NOW.getTime() + 600_000).toISOString() }));
    const p = new DelegationPolicy(f, new FakeApprover({ quota: "continue_without" }), () => NOW);
    const r = await p.check("/r");
    expect(!r.ok && r.result).toMatchObject({ state: "refused", reason: "continue without Gemini" });
    expect((await p.state()).delegation).toBe("paused");
  });
});
```

### Task 4: One run skeleton and one envelope builder for implement and explore

**Files:**

- Create: `src/pipeline/gated-run.ts`
- Modify: `src/pipeline/implement.ts`, `src/pipeline/explore.ts`, `src/pipeline/envelope-build.ts`

Behavior:

- Move the steps both job kinds share into `src/pipeline/gated-run.ts`: create the worktree and exclude `.agents/`/`.agy-task/`, resolve and install skills, write `.agy-task/brief.md`, build the `GatePolicy` and `installGate`, wrap the guard so it collects guard events, and call `deps.agyRun`. The module takes the job-kind-specific pieces (prompt, mode, brief text, extra policy settings) as parameters and returns the outcome plus what it collected (worktree, guard events, skills used, nonce). Keep implement's contract/verify steps and explore's citation check in their own files.
- One function in `envelope-build.ts` builds every envelope, including all early returns, from `spec`, `deps`, start time and the exit-specific fields. Every envelope carries `conversationId: spec.conversationId`, `model`, `skillsUsed`, `deniedCommands`, `guardEvents` and a fenced `untrustedReport`.
- An implement job removes its worktree when anything after worktree creation throws, then rethrows (explore already does this; the shared module should do it for both).
- `runJob`'s interface stays the same.

Contract test `test/pipeline/gated-run.test.ts`:

```ts
import { describe, it, expect, inject } from "vitest";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runJob, type JobSpec, type PipelineDeps } from "../../src/pipeline/index.js";
import { repoHash } from "../../src/pipeline/worktree.js";
import { parseProjectConfig, loadRuntimeConfig } from "../../src/config.js";
import { makeRepo, tmpRoot } from "./repo.js";

function setup(config: object) {
  const repo = makeRepo({ "src/a.mjs": "export const a = 1;\n", "README.md": "# demo\n" });
  const spec: JobSpec = {
    jobId: "j-" + Math.random().toString(16).slice(2, 8),
    kind: "implement",
    repoRoot: repo,
    task: "Do the thing.",
    contractTests: [{ path: "tests/a.test.mjs", content: "throw new Error('red');\n" }],
    conversationId: "c-1",
    timeoutSec: 30,
    config: parseProjectConfig(config),
    runtime: loadRuntimeConfig({}),
  };
  const deps: PipelineDeps = {
    agyRun: (async () => {
      throw new Error("agy crashed");
    }) as never,
    agyCommand: { command: "agy" },
    hookBundlePath: inject("hookBundle"),
    worktreeRoot: tmpRoot(),
    home: os.homedir(),
    now: () => new Date(),
  };
  return { repo, spec, deps };
}

describe("gated run", () => {
  it("removes an implement job's worktree when the run throws", async () => {
    const { repo, spec, deps } = setup({ test_command: ["node", "-e", "process.exit(1)"] });
    await expect(runJob(spec, deps)).rejects.toThrow("agy crashed");
    expect(existsSync(path.join(deps.worktreeRoot, repoHash(repo), spec.jobId))).toBe(false);
  }, 60_000);

  it("builds early-return envelopes with the same shared fields", async () => {
    const refused = setup({});
    const noTests = await runJob(refused.spec, refused.deps);
    const failed = setup({
      test_command: ["node", "-e", "process.exit(1)"],
      setup_command: ["node", "-e", "process.exit(7)"],
    });
    const setupFailed = await runJob(failed.spec, failed.deps);
    for (const env of [noTests, setupFailed]) {
      expect(env).toMatchObject({
        conversationId: "c-1",
        model: "gemini-3.8-flash-high",
        skillsUsed: [],
        deniedCommands: [],
        guardEvents: [],
      });
      expect(env.untrustedReport).toMatch(/^<<<AGY-UNTRUSTED nonce=[0-9a-f]{8}>>>/);
    }
    expect(noTests.state).toBe("refused");
    expect(setupFailed.state).toBe("error");
  }, 60_000);
});
```

### Task 5: A tool-call record module owns the hook file contract

**Files:**

- Create: `src/pipeline/toolcall-record.ts`
- Modify: `src/pipeline/gate.ts`, `src/pipeline/hook-entry.ts`, `src/pipeline/guard.ts`, `src/pipeline/envelope-build.ts`, `src/jobs/execute.ts`

Interface of `src/pipeline/toolcall-record.ts`:

```ts
export const POLICY_FILE = "foreman-policy.json";
export const REVIEW_FILE = "foreman-review.jsonl";
export interface ReviewEntry {
  t: string;
  name: string;
  decision: "auto_approve" | "deny" | "ask_user";
  reason?: string;
  arg: string;
}
export function writePolicy(agentsDir: string, policy: GatePolicy): void;
export function readPolicy(agentsDir: string): GatePolicy;
export function appendReview(agentsDir: string, entry: ReviewEntry): void;
/** All parseable entries in order; [] when the file is missing; malformed lines are skipped. */
export function readReview(agentsDir: string): ReviewEntry[];
/** What a tool call acts on: the first present of TargetFile, CommandLine, AbsolutePath,
 *  DirectoryPath, SearchDirectory, SearchPath, Url, ServerName, then the first value;
 *  stringified and cut to 200 chars. undefined for no params or an empty object. */
export function toolSubject(params: Record<string, unknown> | undefined): string | undefined;
```

Behavior:

- gate.ts `installGate` uses `writePolicy`; hook-entry.ts uses `readPolicy`, `appendReview` and `toolSubject` (the hook resolves its own directory from `import.meta.url`); guard.ts uses `toolSubject`; `getDeniedCommands` uses `readReview`; execute.ts uses `toolSubject` for the current file (keep its worktree-relative path logic).
- Use the decision type that `decide()` already returns if it differs from the union above.
- The hook bundle must stay self-contained (`tsup` with `splitting: false` already inlines it).

Contract test `test/pipeline/toolcall-record.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { appendFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  POLICY_FILE,
  REVIEW_FILE,
  appendReview,
  readPolicy,
  readReview,
  toolSubject,
  writePolicy,
} from "../../src/pipeline/toolcall-record.js";
import type { GatePolicy } from "../../src/pipeline/gate.js";

const dir = () => mkdtempSync(path.join(os.tmpdir(), "foreman-rec-"));

describe("tool-call record", () => {
  it("keeps the file names the hook and the server agree on", () => {
    expect(POLICY_FILE).toBe("foreman-policy.json");
    expect(REVIEW_FILE).toBe("foreman-review.jsonl");
  });

  it("round-trips the policy", () => {
    const d = dir();
    const policy = { worktree: "/w", allowedCommands: ["npm test"] } as unknown as GatePolicy;
    writePolicy(d, policy);
    expect(readPolicy(d)).toEqual(policy);
  });

  it("appends review entries and reads them back in order, skipping broken lines", () => {
    const d = dir();
    expect(readReview(d)).toEqual([]);
    appendReview(d, { t: "1", name: "run_command", decision: "deny", reason: "x", arg: "git push" });
    appendFileSync(path.join(d, REVIEW_FILE), "{broken\n");
    appendReview(d, { t: "2", name: "view_file", decision: "auto_approve", arg: "src/a.ts" });
    expect(readReview(d).map((e) => e.t)).toEqual(["1", "2"]);
    expect(readReview(d)[0]).toMatchObject({ decision: "deny", arg: "git push" });
  });

  it("names what a tool call acts on with one rule", () => {
    expect(toolSubject({ CommandLine: "npm test", TargetFile: "a.ts" })).toBe("a.ts");
    expect(toolSubject({ CommandLine: "npm test" })).toBe("npm test");
    expect(toolSubject({ DirectoryPath: "src" })).toBe("src");
    expect(toolSubject({ Url: "https://x" })).toBe("https://x");
    expect(toolSubject({ Other: 5 })).toBe("5");
    expect(toolSubject({ CommandLine: "x".repeat(300) })).toHaveLength(200);
    expect(toolSubject({})).toBeUndefined();
    expect(toolSubject(undefined)).toBeUndefined();
  });
});
```

### Task 6: MCP tool inputs defined once

**Files:**

- Create: `src/tool-inputs.ts`
- Modify: `src/server.ts`

Interface of `src/tool-inputs.ts`:

```ts
/** zod raw shapes passed to registerTool as inputSchema (same fields and descriptions as today,
 *  plus `timeout_sec: z.number().int().positive().optional()` on agy_start). */
export const startShape: z.ZodRawShape;
export const actShape: z.ZodRawShape;
export type StartArgs = z.infer<z.ZodObject<typeof startShape>>;
export type ActArgs = z.infer<z.ZodObject<typeof actShape>>;
export function toStartInput(args: StartArgs, defaultRepoRoot: string): StartInput;
/** Validates the per-action required fields. Error texts stay exactly as today, e.g.
 *  "action 'followup' requires job_id and feedback". */
export function parseActInput(args: ActArgs): { ok: true; value: ActInput } | { ok: false; error: string };
```

Behavior:

- server.ts `agy_start` and `agy_act` use these (an `ok: false` result becomes `isError: true` with the error text). The 80 lines of hand validation and the field mapping move out of server.ts.
- Keep tool names, field names and descriptions unchanged.

Contract test `test/tool-inputs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { actShape, parseActInput, startShape, toStartInput } from "../src/tool-inputs.js";

describe("tool inputs", () => {
  it("maps agy_start arguments, including timeout_sec, to the domain input", () => {
    const args = z.object(startShape).parse({
      kind: "implement",
      task: "x",
      timeout_sec: 120,
      plan: { file: "p.md", step: 2, delegate_steps: [2, 3] },
      contract_tests: [{ path: "a.test.ts", content: "c" }],
      skills: ["s"],
      estimate: { direct_tokens: 1, delegate_overhead_tokens: 2, reason: "r" },
      effort: "low",
      dry_run: true,
      base_ref: "main",
    });
    expect(toStartInput(args, "/def")).toEqual({
      repoRoot: "/def",
      kind: "implement",
      task: "x",
      timeoutSec: 120,
      plan: { file: "p.md", step: 2, delegateSteps: [2, 3] },
      contractTests: [{ path: "a.test.ts", content: "c" }],
      skills: ["s"],
      estimate: { directTokens: 1, delegateOverheadTokens: 2, reason: "r" },
      effort: "low",
      dryRun: true,
      baseRef: "main",
    });
    expect(toStartInput(z.object(startShape).parse({ kind: "explore", task: "y", repo: "/r" }), "/def").repoRoot).toBe("/r");
  });

  it("validates agy_act per action with the existing error texts", () => {
    const parse = (a: object) => parseActInput(z.object(actShape).parse(a));
    expect(parse({ action: "followup", job_id: "t" })).toEqual({
      ok: false,
      error: "action 'followup' requires job_id and feedback",
    });
    expect(parse({ action: "revoke_plan" })).toEqual({
      ok: false,
      error: "action 'revoke_plan' requires plan_file",
    });
    expect(parse({ action: "lesson", text: "x", audience: "implementer" })).toEqual({
      ok: false,
      error: "action 'lesson' requires text, audience, and scope",
    });
    expect(parse({ action: "finalize", job_id: "t", mode: "squash" })).toEqual({
      ok: true,
      value: { action: "finalize", jobId: "t", mode: "squash" },
    });
    expect(
      parse({ action: "lesson", text: "x", audience: "implementer", scope: "project", tags: ["a"], job_id: "t" }),
    ).toEqual({
      ok: true,
      value: { action: "lesson", text: "x", audience: "implementer", scope: "project", tags: ["a"], jobId: "t" },
    });
    expect(parse({ action: "resume_delegation" })).toEqual({ ok: true, value: { action: "resume_delegation" } });
  });
});
```

### Task 7: One read-only job watch for wait, watch and agy_get

**Files:**

- Create: `src/jobs/watch.ts`
- Modify: `src/jobs/manager.ts`, `src/server.ts`, `src/cli.ts`, `src/statusline-main.ts`

Interface of `src/jobs/watch.ts`:

```ts
/** Polls the store until the job is terminal or timeoutMs passes; never writes.
 *  Calls onUpdate with the first read and after every change (updatedAt or state differs).
 *  Resolves with the last record read, or undefined when the job does not exist. */
export function watchJob(
  store: JobStore,
  jobId: string,
  o?: { intervalMs?: number; timeoutMs?: number; onUpdate?: (r: JobRecord) => void },
): Promise<JobRecord | undefined>;
```

Behavior:

- `JobManager.get` uses `watchJob` for `waitSec`. Add `JobManager.peek(jobId): Promise<JobRecord | undefined>` that returns `compactRecord` of the stored record without counting returned chars or writing.
- server.ts: the `agy_get` progress timer uses `manager.peek`, so background progress notifications no longer inflate `returnedChars`.
- cli.ts `wait` and `watch` use `watchJob` (keep their output and exit codes exactly).
- Move the duplicated `readStdin` into one exported function in `src/statusline-main.ts` and use it from cli.ts; remove the unused imports in cli.ts (`previousStatusLine`, `renderStatusLine`, and anything else no longer used).

Contract test `test/jobs/watch.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { watchJob } from "../../src/jobs/watch.js";
import { JobManager, type JobManagerDeps } from "../../src/jobs/manager.js";
import { JobStore, emptyProgress, type JobRecord } from "../../src/jobs/store.js";

const rec = (extra: Partial<JobRecord> = {}): JobRecord => ({
  id: "t-1",
  kind: "implement",
  repoRoot: "/repo",
  title: "t",
  state: "running",
  progress: emptyProgress(),
  createdAt: "2026-10-17T12:00:00.000Z",
  updatedAt: "2026-10-17T12:00:00.000Z",
  returnedChars: 0,
  ...extra,
});
const store = () => new JobStore(mkdtempSync(path.join(os.tmpdir(), "foreman-watch-")));

describe("watchJob", () => {
  it("reports changes and resolves with the terminal record", async () => {
    const s = store();
    await s.write(rec());
    const seen: number[] = [];
    setTimeout(() => void s.write(rec({ updatedAt: "2026-10-17T12:00:01.000Z", progress: { ...emptyProgress(), percent: 50 } })), 60);
    setTimeout(() => void s.write(rec({ state: "passed", updatedAt: "2026-10-17T12:00:02.000Z", progress: { ...emptyProgress(), percent: 100 } })), 160);
    const final = await watchJob(s, "t-1", { intervalMs: 20, timeoutMs: 3000, onUpdate: (r) => seen.push(r.progress.percent) });
    expect(final?.state).toBe("passed");
    expect(seen).toContain(50);
    expect(seen[seen.length - 1]).toBe(100);
  });

  it("gives up after the timeout and returns the last record, and undefined for unknown jobs", async () => {
    const s = store();
    await s.write(rec());
    expect((await watchJob(s, "t-1", { intervalMs: 20, timeoutMs: 120 }))?.state).toBe("running");
    expect(await watchJob(s, "t-missing", { intervalMs: 20, timeoutMs: 120 })).toBeUndefined();
  });
});

describe("JobManager.peek", () => {
  it("reads a job without counting it as returned to the orchestrator", async () => {
    const s = store();
    await s.write(rec());
    const m = new JobManager({ store: s } as unknown as JobManagerDeps);
    expect((await m.peek("t-1"))?.id).toBe("t-1");
    expect((await s.read("t-1"))?.returnedChars).toBe(0);
    await m.get("t-1");
    expect((await s.read("t-1"))?.returnedChars).toBeGreaterThan(0);
  });
});
```
