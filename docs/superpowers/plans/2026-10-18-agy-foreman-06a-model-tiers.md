# Model tiers on agy (Plan 6a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agy-foreman runs tasks on a `fast` tier (Gemini 3.8 Flash) or a `strong` tier (Gemini 4 Argon). It retries a failed task once on `strong`, keeps quota per agy pool, and continues on another tier when a pool runs out.

**Architecture:**
- Tiers are resolved from config into `ProjectConfig.tiers`.
- A new `src/pools.ts` maps models to agy quota pools and display labels.
- `FlagStore` keeps cooldowns per pool.
- `DelegationPolicy` chooses a tier, moving up only.
- `executeJob` runs one or more **attempts** of the same job, each a full `runJob` call from the base commit with its own worktree id. It writes one envelope, one ledger entry and an `attempts` list.

**Tech Stack:** TypeScript (ESM, Node ≥ 20), zod, vitest, existing agy pipeline.

**Spec:** [docs/superpowers/specs/2026-10-18-multi-model-design.md](../specs/2026-10-18-multi-model-design.md). This plan covers §2 (except connections and backup), §3, §3.1, §4 (except backup), §6, §7 and §8. Runners, `connect` and `backup` are Plan 6b.

## Global Constraints
- With no `models` key in `.agy-foreman.json`, behavior is exactly as today: one tier `fast` = `model`, no `strong`, and `escalate` is false.
- Tier names are exactly `fast` and `strong` (`backup` arrives in Plan 6b). The order is `fast` → `strong`, and fallback never moves down.
- Pool names are exactly as `agy -p /usage` prints them: `Gemini Models`, `Gemini 4 Argon`, `Claude and GPT models`.
- Effort picks the agy model variant through the existing `modelFor(model, effort)`. A tier's value is a base name such as `gemini-4-argon`.
- Escalation applies only to `implement` jobs whose attempt ended in state `failed`, at most once per job, and only from `fast` to `strong`.
- Every attempt starts from the job's base commit with the job's original contract tests. Attempts never reuse `startFollowup` or the parent's `conversationId`.
- Never call real `agy` in unit tests. Use the existing fake `runJob` in `test/jobs/manager.test.ts`.
- Run `npm run test:ci` before each commit. Known unrelated failure on the author's Windows machine: `test/jobs/fsutil.test.ts` "survives many overlapping writes…" (EPERM); it fails without these changes too.

## Review Focus
1. **Old configs with a legacy `cooldownUntil` in `flags.json`** must keep cooling down `Gemini Models` and must not crash. The test goes in Task 3.
2. **`tier: "strong"` requested when no strong tier is configured** must refuse with a clear reason, not run on `fast`. The test goes in Task 4.
3. **Losing attempts must not leak worktrees or branches**, and `finalize` must act on the final attempt's branch. The test goes in Task 5.
4. **A quota hit on the last available tier** must fall back to today's quota card and the retry follow-up, unchanged. The test goes in Task 5.
5. **The status line and usage output** with only the Gemini Models pool present (accounts without Argon) must look exactly as today. The test goes in Task 6.

---

### Task 1: Tiers in config

**Files:**
- Modify: `src/config.ts` (schema around line 58, `ProjectConfig`, `parseProjectConfig`)
- Test: `test/config.test.ts`

**Interfaces:**
- Produces:
  - `export type Tier = "fast" | "strong";`
  - `export const TIERS: readonly Tier[] = ["fast", "strong"];`
  - `ProjectConfig.tiers: { fast: string; strong?: string }`
  - `ProjectConfig.escalate: boolean`
  - `ProjectConfig.model` stays and always equals `tiers.fast`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("model tiers", () => {
  it("defaults to one fast tier from `model`, no strong tier, no escalation", () => {
    const c = parseProjectConfig({});
    expect(c.tiers).toEqual({ fast: "gemini-3.8-flash-high" });
    expect(c.escalate).toBe(false);
    expect(c.model).toBe("gemini-3.8-flash-high");
  });
  it("reads a models block and turns escalation on by default", () => {
    const c = parseProjectConfig({ models: { fast: "gemini-3.8-flash", strong: "gemini-4-argon" } });
    expect(c.tiers).toEqual({ fast: "gemini-3.8-flash", strong: "gemini-4-argon" });
    expect(c.escalate).toBe(true);
    expect(c.model).toBe("gemini-3.8-flash");
  });
  it("lets models.fast fall back to `model` and honours escalate: false", () => {
    const c = parseProjectConfig({ model: "gemini-3.8-flash", models: { strong: "gemini-4-argon" }, escalate: false });
    expect(c.tiers).toEqual({ fast: "gemini-3.8-flash", strong: "gemini-4-argon" });
    expect(c.escalate).toBe(false);
  });
  it("rejects unknown tier names", () => {
    expect(() => parseProjectConfig({ models: { turbo: "x" } })).toThrow(ConfigError);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL (`tiers` undefined).

- [ ] **Step 3: Implement**
  - Add `models: z.object({ fast: z.string().min(1).optional(), strong: z.string().min(1).optional() }).strict().optional()` and `escalate: z.boolean().optional()` to `projectSchema`.
  - In `parseProjectConfig`: `fast = p.models?.fast ?? p.model`, and `escalate = p.escalate ?? p.models !== undefined`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/config.test.ts`, then `npm run test:ci`
Expected: PASS (apart from the known fsutil failure).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: fast/strong model tiers in .agy-foreman.json"
```

### Task 2: Pools and labels; usage keeps every pool

**Files:**
- Create: `src/pools.ts`
- Modify: `src/usage-quota.ts` (`QuotaSnapshot`, `parseUsage`)
- Test: `test/pools.test.ts`, `test/usage-quota.test.ts`

**Interfaces:**
- Produces:
  - `export function poolOf(model: string): string`. Rules:
    - `gemini-4-argon*` → `"Gemini 4 Argon"`
    - any other `gemini-*` → `"Gemini Models"`
    - `claude-*` | `gpt-*` → `"Claude and GPT models"`
    - otherwise `` `model:${base}` ``, where `base` is the name with `-(low|medium|high)` stripped.
  - `export function modelLabel(model: string, effort?: Effort): string`. Examples:
    - `gemini-3.8-flash` + `high` → `"Gemini 3.8 Flash (high)"`
    - `gemini-4-argon-low` → `"Gemini 4 Argon (low)"`
    - an unknown model returns the raw name, plus ` (effort)` when an effort is given.
  - `QuotaSnapshot.pools?: Record<string, { fiveHour?: QuotaWindow; weekly?: QuotaWindow }>`. `fiveHour` / `weekly` stay as the Gemini Models pool.

- [ ] **Step 1: Write the failing tests**
  - In `test/pools.test.ts`:
    - `poolOf` maps each of: `gemini-3.8-flash-high`, `gemini-4-argon-medium`, `claude-sonnet-5-5-high`, `gpt-oss-120b-medium`, `mystery-1-low` → `"model:mystery-1"`.
    - `modelLabel` covers the three examples above.
  - In `test/usage-quota.test.ts`, extend the existing Argon regression test (the real five-row text):

```ts
expect(parseUsage(text, NOW).pools).toEqual({
  "Gemini Models": { weekly: { remaining: 99, resetAt: "2026-10-25T15:13:17Z" }, fiveHour: { remaining: 95, resetAt: "2026-10-18T20:13:17Z" } },
  "Claude and GPT models": { weekly: { remaining: 100, resetAt: "2026-10-25T16:46:09Z" } },
  "Gemini 4 Argon": { weekly: { remaining: 100, resetAt: "2026-10-25T16:45:41Z" } },
});
```

  - Also change the first `parseUsage` test's `toEqual` to include `pools` for its Gemini and Claude rows.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/pools.test.ts test/usage-quota.test.ts`
Expected: FAIL (module missing, `pools` undefined).

- [ ] **Step 3: Implement `src/pools.ts`, and in `parseUsage` file every 4-column row under `pools[cols[0]]` by the `five hour` / `weekly` match**

- [ ] **Step 4: Run the tests and confirm they pass**, then `npm run test:ci`

- [ ] **Step 5: Commit**

```bash
git add src/pools.ts src/usage-quota.ts test/pools.test.ts test/usage-quota.test.ts
git commit -m "feat: map models to agy quota pools; usage cache keeps every pool"
```

### Task 3: Cooldowns per pool and tier choice

**Files:**
- Modify: `src/jobs/flags.ts` (`Flags`, `FlagStore.read`), `src/jobs/policy.ts`
- Test: `test/jobs/flags.test.ts`, `test/jobs/policy.test.ts`

**Interfaces:**
- Consumes: `Tier`, `TIERS`, `ProjectConfig.tiers` (Task 1); `poolOf` (Task 2).
- Produces:
  - `Flags.cooldowns: Record<string, { until: string; text?: string }>`.
  - `FlagStore.read()` converts a legacy `cooldownUntil` / `cooldownText` into `cooldowns["Gemini Models"]` and drops the legacy keys on the next `update`.
  - `DelegationPolicy.markCooling(pool: string, resetInSec?: number, resetText?: string): Promise<void>`: the same duration rule as today's `onQuota`, `max(60, resetInSec ?? 900)`.
  - `DelegationPolicy.pickTier(tiers: ProjectConfig["tiers"], from: Tier): Promise<{ tier: Tier; model: string } | undefined>`: the first configured tier at or above `from` whose `poolOf(model)` isn't cooling down.
  - `DelegationPolicy.check(repoRoot: string | undefined, tiers: ProjectConfig["tiers"], requested: Tier)` returns either `{ ok: true; tier: Tier; model: string; note?: string }` or `{ ok: false; result: StartResult }`.
    - If no tier is available, it shows today's quota card. `QuotaCard` gains `pools?: { pool: string; resetAt: string }[]`.
    - `note` is set when the chosen tier differs from `requested`, for example `"Gemini Models is cooling down; running on strong (gemini-4-argon)"`.
  - `choose("retry")` clears **all** cooldowns.
  - `state()` returns `{ delegation, cooldowns: { pool, until, resetText? }[] }`. `cooldown` is removed, and its callers in `manager.ts` are updated.
  - `onQuota(o)` keeps its signature and its card behavior. It now calls `markCooling("Gemini Models", …)` only when `o.pool` is absent. Add `pool?: string` to its input.

- [ ] **Step 1: Write the failing tests**

```ts
it("reads a legacy single cooldown as the Gemini Models pool", async () => {
  writeFileSync(file, JSON.stringify({ cooldownUntil: "2026-10-17T13:00:00Z", cooldownText: "1h", delegationPaused: false, grants: [] }));
  const f = await new FlagStore(file).read();
  expect(f.cooldowns).toEqual({ "Gemini Models": { until: "2026-10-17T13:00:00Z", text: "1h" } });
});
it("picks fast, then moves up to strong when Gemini Models is cooling, never down", async () => {
  const tiers = { fast: "gemini-3.8-flash", strong: "gemini-4-argon" };
  expect(await policy.pickTier(tiers, "fast")).toEqual({ tier: "fast", model: "gemini-3.8-flash" });
  await policy.markCooling("Gemini Models", 600);
  expect(await policy.pickTier(tiers, "fast")).toEqual({ tier: "strong", model: "gemini-4-argon" });
  await policy.markCooling("Gemini 4 Argon", 600);
  expect(await policy.pickTier(tiers, "fast")).toBeUndefined();
});
it("does not fall back to fast when strong was requested and Argon is cooling", async () => {
  await policy.markCooling("Gemini 4 Argon", 600);
  expect(await policy.pickTier({ fast: "gemini-3.8-flash", strong: "gemini-4-argon" }, "strong")).toBeUndefined();
});
it("check shows the quota card only when no tier is available, listing the pools", async () => { /* FakeApprover records the card; assert card.pools has both pools */ });
```

  Then update the existing policy tests that read `state().cooldown` to `state().cooldowns`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/jobs/flags.test.ts test/jobs/policy.test.ts`

- [ ] **Step 3: Implement as specified in Interfaces.** `quotaCardText` lists the pools when `c.pools` is set: `"Quota reached: Gemini Models (resets 20:13), Gemini 4 Argon (resets Sun 16:45)."`. Without pools, it keeps today's text.

- [ ] **Step 4: Run the tests and confirm they pass**, then `npm run test:ci`

- [ ] **Step 5: Commit**

```bash
git add src/jobs/flags.ts src/jobs/policy.ts src/jobs/approver.ts src/jobs/manager.ts test/jobs/flags.test.ts test/jobs/policy.test.ts test/jobs/approver.test.ts
git commit -m "feat: quota cooldowns per agy pool; tier choice only moves up"
```

### Task 4: `tier` on agy_start; the job records its tier; cards name the model

**Files:**
- Modify: `src/tool-inputs.ts` (`startShape`, `toStartInput`), `src/jobs/manager.ts` (`StartInput`, `StartResult`), `src/jobs/start.ts` (policy check, spec build), `src/jobs/store.ts` (`JobRecord`), `src/jobs/approver.ts` (`PlanCard`, `TaskCard`, card texts)
- Test: `test/jobs/manager.test.ts`, `test/jobs/approver.test.ts`, `test/tool-inputs.test.ts`

**Interfaces:**
- Consumes: `DelegationPolicy.check(...)` (Task 3); `modelLabel` (Task 2).
- Produces:
  - `startShape.tier: z.enum(["fast","strong"]).optional()`, and `StartInput.tier?: Tier`.
  - `JobRecord.tier: Tier` and `JobRecord.model: string`, the base model the first attempt runs on.
  - The running/queued `StartResult` gains `tier: Tier`, `model: string` and `note?: string`.
  - The `JobSpec` given to `runJob` has `config.model` set to the chosen tier's model.
  - `PlanCard.model: string`, `TaskCard.model: string`, and on both `escalatesTo?: string` (a label).
  - Card texts:
    - `Delegate plan "<title>" to <modelLabel(model, effort)>?`
    - `Delegate to <modelLabel(model, effort)>? "<title>"…`
    - When `escalatesTo` is set, an extra line: `If tests fail: one retry on <escalatesTo>`.

- [ ] **Step 1: Write the failing tests**, in `manager.test.ts`, using `setup({ config: { models: { fast: "gemini-3.8-flash", strong: "gemini-4-argon" } } })`:
  - `tier: "strong"` → `specs[0].config.model === "gemini-4-argon"`, the record's `tier === "strong"`, and the result has `tier: "strong"`.
  - No `tier` → `fast`.
  - `tier: "strong"` with the default config (no strong tier) → `{ state: "refused", reason: "no strong tier configured (set models.strong in .agy-foreman.json)" }`.
  - After `deps.flags.update(f => { f.cooldowns = { "Gemini Models": { until: "2026-10-17T13:00:00Z" } } })`, a default start runs on `strong` and the result's `note` mentions `Gemini Models`.
  - `approver.test.ts`: `taskCardText({ title: "T", kind: "implement", effort: "high", skills: [], model: "gemini-4-argon" })` starts with `Delegate to Gemini 4 Argon (high)? "T"`, and with `escalatesTo` it includes `If tests fail: one retry on Gemini 4 Argon (high)`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/jobs/manager.test.ts test/jobs/approver.test.ts test/tool-inputs.test.ts`

- [ ] **Step 3: Implement**
  - `start.ts` calls `policy.check(i.repoRoot, config.project.tiers, i.tier ?? "fast")` where it calls `policy.check(i.repoRoot)` today.
  - It builds the spec with `config: { ...config.project, model: chosen.model }`.
  - The cards get `escalatesTo` when `kind === "implement"`, `config.escalate` is on, the tier is `fast` and `tiers.strong` exists.

- [ ] **Step 4: Run the tests and confirm they pass**, then `npm run test:ci`

- [ ] **Step 5: Commit**

```bash
git add src/tool-inputs.ts src/jobs/manager.ts src/jobs/start.ts src/jobs/store.ts src/jobs/approver.ts test/
git commit -m "feat: agy_start tier; jobs record their tier; approval cards name the model"
```

### Task 5: Attempts: escalation and quota fallback inside one job

**Files:**
- Modify: `src/jobs/execute.ts` (the `runJob` call and the completion block), `src/jobs/actions.ts` (`startFollowup`), `src/jobs/store.ts`, `src/pipeline/index.ts` (`Envelope`), `src/jobs/ledger.ts` (`LedgerEntry`)
- Test: `test/jobs/manager.test.ts` (new `describe("attempts")`)

**Interfaces:**
- Consumes:
  - `JobRecord.tier` and `JobRecord.model` (Task 4)
  - `policy.pickTier` and `policy.markCooling` (Task 3)
  - `poolOf` (Task 2)
  - `removeWorktree(wt, { deleteBranch: true })` from `src/pipeline/worktree.ts`
  - `modelFor` from `src/agy/run.ts`
- Produces:
  - `export interface Attempt { tier: Tier; model: string; state: JobState; reason?: string }`. Here `model` is the full variant, `modelFor(base, effort)`.
  - `Envelope.attempts?: Attempt[]`, `JobRecord.attempts?: Attempt[]`, `LedgerEntry.tier?: Tier`, `LedgerEntry.model?: string` and `LedgerEntry.attempts?: Attempt[]`.
  - The final envelope's `jobId` is always `record.id`.

Behavior, in `executeJob`, looping until it stops:

1. **Run one attempt:** call `runJob` with `spec` for attempt 1, then `{ ...spec, jobId: \`${record.id}-a${n}\`, config: { ...spec.config, model }, conversationId: undefined, task: spec.task + failureNote }` for later attempts. Push an `Attempt` for each.
2. **When the attempt ends in `quota`:**
   - `markCooling(poolOf(model), env.quota?.resetInSec, env.quota?.resetText)`
   - then `next = pickTier(tiers, currentTier)`.
   - If there's a `next`, run another attempt on it.
   - If not, stop and run today's quota block unchanged (`policy.onQuota(...)` with `pool` set, plus the retry follow-up).
3. **When the attempt ends in `failed`:** escalate if all of these hold: `kind === "implement"`, `config.escalate`, the current tier is `fast`, `tiers.strong` exists, and there has been no escalation yet. Then `next = pickTier(tiers, "strong")`. If there's a `next`, run another attempt with this `failureNote`:
   ```
   \n\nA previous attempt on <label> failed verification.
   Failing tests: <verify.failures.join(", ") || "see output">
   Output tail:
   <last 1500 chars of verify.outputTail>
   ```
4. **Before each new attempt:** remove the previous attempt's worktree and branch (`removeWorktree({ path: env.worktreePath, branch: env.branch, ... }, { deleteBranch: true })`), ignoring errors.
5. **Manual follow-ups:** `startFollowup` in `src/jobs/actions.ts` keeps creating a child job, but sets the child's tier and model to the parent's **last** attempt, not its first. The test: after a fast→strong job, `agy_act followup` gives a child spec with `config.model === "gemini-4-argon"`.
6. **After the loop:**
   - Write the final envelope, with `attempts` and `jobId = record.id`, to the record.
   - Append **one** ledger entry, with `tier`, `model` (the final attempt's) and `attempts`.
   - The existing incident classification uses the final envelope.

- [ ] **Step 1: Write the failing tests**, using `setup({ config: { models: { fast: "gemini-3.8-flash", strong: "gemini-4-argon" } }, result })`:

```ts
it("retries a failed fast attempt once on strong, from scratch, and records both attempts", async () => {
  const { m, repo, specs, deps } = setup({ config: TIERS_CFG, result: (s) => envelope(s, s.config.model.startsWith("gemini-4") ? "passed" : "failed", { verify: { ...VERIFY_FAIL, failures: ["adds 2"] } as never }) });
  const r = await m.start({ repoRoot: repo, kind: "implement", task: "x", estimate: EST });
  const rec = await waitTerminal(deps, r);
  expect(specs.map((s) => s.config.model)).toEqual(["gemini-3.8-flash", "gemini-4-argon"]);
  expect(specs[1].jobId).toBe(`${rec.id}-a2`);
  expect(specs[1].conversationId).toBeUndefined();
  expect(specs[1].task).toContain("Failing tests: adds 2");
  expect(rec.state).toBe("passed");
  expect(rec.envelope!.jobId).toBe(rec.id);
  expect(rec.attempts!.map((a) => [a.tier, a.state])).toEqual([["fast", "failed"], ["strong", "passed"]]);
  expect((await deps.ledger.entries()).filter((e) => e.jobId === rec.id)).toHaveLength(1);
});
it("does not escalate explore jobs, guard violations, or when escalate is false", async () => { /* three cases, specs.length === 1 each */ });
it("escalates at most once", async () => { /* both attempts fail → specs.length === 2, state failed */ });
it("moves to strong when fast hits the quota, without showing the quota card", async () => { /* fast → "quota" envelope; approver.cards has no quota card; attempts [fast quota, strong passed]; flags.cooldowns has "Gemini Models" */ });
it("shows today's quota card when the last available tier hits the quota", async () => { /* default config, "quota" → approver quota card shown once, as in the existing quota test */ });
it("removes the losing attempt's worktree and branch", async () => { /* use the makeRepo + real createWorktree path from test/pipeline/repo.ts for attempt 1's envelope; assert the path is gone and `git branch --list agy/<id>` is empty after the job ends */ });
```

  Define `TIERS_CFG`, `VERIFY_FAIL` (a `VerifyReport` with `passed: false`) and a `waitTerminal(deps, r)` helper (poll `deps.store.get(id)` until `isTerminal`) at the top of the new describe.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/jobs/manager.test.ts -t attempts`

- [ ] **Step 3: Implement the loop as described above.** Progress keeps flowing through the same `onPhase` / `onEvent`. Reset `record.progress.tokens` and `toolSteps` at the start of each attempt.

- [ ] **Step 4: Run the tests and confirm they pass**, then `npm run test:ci`

- [ ] **Step 5: Commit**

```bash
git add src/jobs/execute.ts src/jobs/store.ts src/pipeline/index.ts src/jobs/ledger.ts test/jobs/manager.test.ts
git commit -m "feat: escalation and quota fallback as attempts inside one job"
```

### Task 6: Visibility (commit trailer, status line, agy_status, calibration per tier)

**Files:**
- Modify: `src/jobs/actions.ts:156` (commit message), `src/statusline.ts` (`renderStatusLine`), `src/statusline-main.ts`, `src/jobs/manager.ts` (`status`), `src/jobs/ledger.ts` (`calibration`)
- Test: `test/jobs/manager.test.ts`, `test/statusline.test.ts`, `test/jobs/ledger.test.ts`

**Interfaces:**
- Consumes: `Attempt`, `LedgerEntry.tier` (Task 5); `QuotaSnapshot.pools`, `poolOf` and `modelLabel` (Task 2); `state().cooldowns` (Task 3).
- Produces:
  - **Commit message trailer:** `Implemented-by: <final attempt's model> via agy`, plus `Attempts: fast gemini-3.8-flash-high failed → strong gemini-4-argon-high passed` when there was more than one attempt.
  - **`renderStatusLine`:** when the shown job's tier is `strong`, it adds a short segment `argon` (keep 50, so it drops before the title). The quota segment reads the pool of the shown job's model from `pools`, and falls back to today's `fiveHour` / `weekly` when `pools` is missing.
  - **`status()`** returns:
    - `tiers: { tier, model, pool, coolingUntil? }[]` (from config)
    - `cooldowns`
    - `calibration` from `ledger.calibration(tier?)`. Per tier, it uses only entries with that `tier` when there are ≥ 5, otherwise all entries, and adds `scope: "tier" | "all"`.

- [ ] **Step 1: Write the failing tests**
  - Finalize after a two-attempt job: the commit message contains `Implemented-by: gemini-4-argon-high via agy` and the `Attempts:` line.
  - `renderStatusLine` with a strong job adds `argon`. With a snapshot that only has today's `fiveHour` / `weekly` and no `pools`, the output is byte-identical to today's (snapshot the current output first).
  - `ledger.calibration("strong")` with 3 strong entries plus 10 others returns `scope: "all"`, and with 5 strong entries returns `scope: "tier"`.
  - `status()` lists both tiers with their pools.

- [ ] **Step 2: Run the tests and confirm they fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests and confirm they pass**, then `npm run test:ci`

- [ ] **Step 5: Commit**

```bash
git add src/jobs/actions.ts src/statusline.ts src/statusline-main.ts src/jobs/manager.ts src/jobs/ledger.ts test/
git commit -m "feat: show tier and model in commits, status line and agy_status; calibration per tier"
```

### Task 7: `init` and `doctor` know about Argon; docs

**Files:**
- Modify: `src/cli.ts` (`detectTestCommand` caller in `init`, `doctor`), `README.md` (Limitations, Configuration table, How it works diagram label), `skills/gemini-delegation/SKILL.md` (a section on tiers), `AGENTS.md` (the model wording)
- Test: `test/cli.test.ts`, `test/skill.test.ts` (if it asserts SKILL.md content)

**Interfaces:**
- Consumes: the config keys `models` and `escalate` (Task 1).
- Produces:
  - `init`: when `agy models` (via the existing doctor `run` dependency) lists a line starting with `gemini-4-argon`, the written config includes `"models": { "fast": "gemini-3.8-flash", "strong": "gemini-4-argon" }` and `"escalate": true`. Otherwise the config is exactly as today. If `agy models` fails, the config is also as today, with no error.
  - `doctor`: the login check also reports `tiers: fast gemini-3.8-flash · strong gemini-4-argon` (or `fast only`), and fails if a configured tier's model isn't listed by `agy models`.

- [ ] **Step 1: Write the failing tests**
  - `init` with a fake `agy models` output containing `gemini-4-argon-high` → the file has the `models` block.
  - Without it → no `models` key.
  - `doctor` with `models.strong: "gemini-9"` → the login check is not ok and names `gemini-9`.

- [ ] **Step 2: Run the tests and confirm they fail**

- [ ] **Step 3: Implement.** Update the docs:
  - README Limitations: replace "Gemini 3.8 Flash only…" with a short tiers paragraph.
  - README Configuration table: add the `models` and `escalate` rows.
  - Skill: when to request `tier: "strong"`: many files, tricky logic, or a retry after a failed job. Also say that escalation happens on its own, so Claude shouldn't manually re-delegate a job that already escalated.

- [ ] **Step 4: Run the tests and confirm they pass**, then `npm run test:ci`, then `npm run build`

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts README.md skills/gemini-delegation/SKILL.md AGENTS.md test/
git commit -m "feat: init and doctor set up the Argon tier; document tiers"
```

### Task 8: Live check (manual, costs a little quota)

- [ ] **Step 1:** In a throwaway repo with vitest, run `agy-foreman init` and confirm the `models` block was written.
- [ ] **Step 2:** From Claude Code, delegate a small `implement` task with `tier: "strong"`.
  - Expected: the approval card says `Gemini 4 Argon (high)`, the job passes, and the commit trailer names `gemini-4-argon-high via agy`.
- [ ] **Step 3:** Record the outcome in the spec's §8, "Verified so far".
