# Multi-model and runners: design

**Status:** design, agreed in brainstorming on 2026-10-18; not yet planned. It ships first, before the updater and before [Foreman Studio](2026-10-18-foreman-studio-design.md).

## 1. Intent

agy-foreman sends every task to one model, Gemini 3.8 Flash through agy, and treats running out of quota as a stop. The user's Google account actually has three separate quota pools:

| Pool | Models |
|---|---|
| Gemini Models | Gemini 3.8 Flash |
| Gemini 4 Argon | Gemini 4 Argon, with its own weekly limit |
| Claude and GPT models | Claude and GPT through agy |

Many users also have their own Claude Code or Codex (GPT) subscription. This design lets agy-foreman use a stronger model when a task needs one. It also lets agy-foreman keep working when one pool is empty, and use a CLI the user connects as an optional backup. Every result is still verified by the user's tests exactly as today.

### Goals
- Model **tiers** (`fast`, `strong`, optional `backup`), set in `.agy-foreman.json`.
- Claude can pick a tier per task. A task that fails on `fast` is retried once on `strong` automatically.
- **Quota per pool.** An empty pool only pauses its own tier, and the "retry, continue without, or wait" card appears only when every configured tier is out.
- **Runners.** A tier names a runner as well as a model. The runners are `agy` (default), `claude` (Claude Code CLI) and `codex` (OpenAI Codex CLI).
- The user always sees which model and runner did the work.

### Non-goals
- No new verification rules. The red→green contract, protected paths, tamper checks and merge flow stay exactly as they are, whatever the runner.
- No model routing by price or benchmark. Tiers are what the user configures.
- No automatic use of a paid or extra pool: `backup` exists only when the user connects it.

### Anti-goals
- A runner that runs without the tool-call gate. A runner that can't enforce the same gate agy-foreman enforces around agy (§5) is not offered.
- Silent behavior changes for existing users. With no `models` block, agy-foreman behaves exactly as it does today.

## 2. Configuration

```json
"models": {
  "fast":   "gemini-3.8-flash",
  "strong": "gemini-4-argon",
  "backup": { "runner": "claude", "model": "sonnet" }
},
"escalate": true
```

- **Writing a tier:** a plain string is an agy model base name. The object form `{ "runner", "model" }` picks another runner.
- **Effort:** effort still picks the variant (`-low`, `-medium`, `-high`) for agy models, as `modelFor` does today. For other runners, effort maps to that CLI's own effort or thinking setting if it has one, and is otherwise ignored.
- **Old configs:** the existing `model` key still works and means `fast`. Without a `models` block, `fast` is the configured `model`, there is no `strong`, there is no `backup` and escalation is off. That's today's behavior exactly.
- **Defaults `init` writes for new configs:** `fast: gemini-3.8-flash`, plus `strong: gemini-4-argon` **only if** `agy models` lists an Argon model, and `escalate: true`. It never adds `backup` on its own.
- **Connecting a CLI:** `init` and `doctor` detect installed CLIs (`claude`, `codex`) and their login state. `agy-foreman connect claude|codex` adds a `backup` tier after a successful dry run (§5). Connecting is always the user's explicit action.
- **More than one CLI:** connections are stored as a **list**: `"connections": [{ "runner": "claude", "model": "sonnet", "auto": true }, …]`. `backup` means the first connection whose pool is available, then the next. This version only uses the list for fallback order, but the format allows parallel workers later (§9) without a config migration.

## 3. Choosing and escalating

- **Picking a tier:** `agy_start` takes an optional `tier`, which defaults to `fast`. The `gemini-delegation` skill tells Claude when to ask for `strong`: work spanning many files, tricky logic, or a retry after a failure.
- **The ladder:** if an `implement` job's attempt ends **failed verification** (tests red or contract not green, not a gate violation, cancel or setup error), and `escalate` is on, the server runs the job again on the **next tier up** that's available: `fast` → `strong` → `backup`. Each new attempt gets the failure summary in its brief. Only when the top tier has failed, or no higher tier is available, does it report to Claude.
- **Limits:** each tier is tried at most once per job. The `backup` rung is used only when the user allowed automatic use at connect time (`auto: true`, §4.1). Otherwise the ladder stops at `strong`. Claude can still ask for `tier: "backup"` explicitly.
- **The result envelope** gains `attempts: [{ tier, runner, model, state }]`, so Claude and the user see the whole ladder.

### 3.1 Attempts, not child jobs (my call)
Escalation (§3) and quota fallback (§4) add **attempts inside one job**:
- **One job:** one job id, one final envelope, one exit code from `agy-foreman wait`, one ledger entry that lists every attempt.
- **Fresh start every time:** each attempt starts again from the job's **base commit** in a fresh worktree. It does **not** build on the failed attempt's commit. The new attempt's brief gets a short summary of why the previous attempt failed: failing test names and the verify output tail.
- **Same contract every time:** the original contract tests apply to every attempt. Their paths stay protected, and the final envelope must show them green. The red check on the base commit doesn't need re-running, because the base hasn't changed.
- **Not `startFollowup`:** the existing child-job mechanism skips the contract (`contractTests: []`) and continues from the parent's branch. Attempts must not reuse it.
- **No reused conversation:** agy's `conversationId` is not carried into a new attempt.
- **A manual `agy_act followup`** stays as today, a child job, and runs on the tier the parent job **ended** on.

## 4. Quota per pool

- **Reading usage:** `parseUsage` keeps every pool from `agy -p /usage`: Gemini Models, Gemini 4 Argon, Claude and GPT. The cache stores them by pool name. The existing `fiveHour` / `weekly` fields keep meaning the Gemini Models pool for the status line, as fixed by the Argon regression test.
- **Mapping models to pools:** each agy model maps to a pool by name:
  - `gemini-3.8-*` → Gemini Models
  - `gemini-4-argon-*` → Gemini 4 Argon
  - `claude-*` / `gpt-*` → Claude and GPT
  - An unknown model has no known pool. Treat it as its own pool.
  - Runners other than agy report quota through their own errors, and their pool is the runner itself.
- **Cooldowns per pool:** the cooldown in `flags` becomes per pool (`cooldowns: { [pool]: until }`).
- **When a run hits a usage limit:** cool down that pool, then continue the job on the next tier, in the order `fast` → `strong` → `backup`, whose pool isn't cooling down.
- **The quota card** (retry / continue without / wait) only appears when every configured tier's pool is cooling down. Its text names the pools and their reset times.
- **Starting new jobs:** `agy_start` doesn't start a job on a tier whose pool is cooling down. It uses the next available tier, and the response says so.
- **Never silently weaker (my call):** fallback only moves **up** the order `fast` → `strong` → `backup`, never down.
  - If Claude asks for `strong` while Argon is cooling down, the job goes to `backup` if one is connected and allowed (§4.1). Otherwise the quota card appears.
  - If Claude asks for `backup` and it's unavailable, the quota card appears.
  - Each tier switch is named in the `agy_start` response and in `attempts`.

### 4.1 Consent for backup (my call)
- **Asked once, at connect time:** `agy-foreman connect` asks whether this CLI may be used **automatically** when the Gemini pools run out. The answer is stored as `"backup_auto": true|false`.
  - With `false`, `backup` is used only when Claude asks for it explicitly with `tier: "backup"`.
  - With `true`, automatic fallback to it needs no new card.
- **Cards mention the backup:** when automatic backup is on, approval cards say so in one line, for example *"may continue on Claude Sonnet via claude if Gemini runs out"*. That way approving a plan covers it knowingly.
- **Escalating to `strong` needs no extra card:** it's the same Google account, and the user agreed to escalation by default.

## 5. Runners

A runner turns one job into one headless CLI run. Every runner must provide all of the following, or it isn't offered:

1. a non-interactive run in the job's worktree, with the brief as the prompt and a timeout
2. streamed events the pipeline can map to its existing progress model (steps, tool calls, files, tokens) and a final result with token usage
3. **the tool-call gate:** every tool call goes through agy-foreman's policy (allowed commands, protected paths, no redirection, policy outside the worktree, the run stops if the hook files change), and the user's global settings can't widen it
4. quota and limit errors it can recognize (for §4)
5. clean cancel, killing the whole process tree as today.

**Which jobs can use which runners (my call):**
- `explore` jobs use agy tiers only (`fast`, `strong`), because they depend on agy's `--mode plan`, `--json-schema` and structured output.
- If every agy pool is cooling down, an explore job shows the quota card. It never moves to another runner.
- The `claude` and `codex` runners are for `implement` jobs only, for now.
- **Gate translation:** `src/pipeline/gate.ts` (`decide()`) and `hook-entry.ts` understand only agy's tool names and its hook stdin/stdout format. Each non-agy runner needs an adapter that maps its CLI's tool calls, for example Claude Code's `Bash` / `Write` / `Edit`, onto the same `decide()` policy, and maps the answer back into that CLI's hook protocol.

Per runner:
- **`agy`:** today's code, unchanged.
- **`claude` (Claude Code CLI):**
  - The run is `claude -p` with `--output-format stream-json`, plus a `--settings` file in the policy folder that registers a `PreToolUse` hook calling agy-foreman's gate.
  - Claude Code 2.1.302 is installed on the author's machine, with `-p`, `stream-json` and `--settings`.
  - *To verify before building:*
    - that a `PreToolUse` hook from `--settings` can't be overridden by the user's global or project settings (or how to isolate them)
    - that a denial blocks the call
    - the exact stream-json event shapes
    - how a usage-limit error looks.
  - Note: this uses the same Anthropic subscription as the orchestrating Claude session. It adds a fresh, isolated worker, not extra quota.
- **`codex` (OpenAI Codex CLI):**
  - Not installed on the author's machine.
  - *To verify:* headless mode (`codex exec --json`), its event format, and above all whether it has a per-tool-call hook.
  - If it has no gate equivalent, the `codex` runner is not shipped. Its sandbox modes alone don't meet requirement 3. This is the anti-goal in §1.
  - The plan builds `agy` and `claude` first and adds `codex` only once it is verified.

Runner code lives behind one interface next to `src/agy/`, for example `src/runners/{agy,claude,codex}.ts`. The pipeline calls the interface instead of `agy.run` directly. The gate script itself stays shared. Each runner only adapts how its CLI calls it.

## 6. Visibility
- **Approval cards** name the model and runner, for example *Delegate to Gemini 4 Argon (high) via agy?*. The hard-coded "Gemini 3.8 Flash" wording in `approver.ts` goes away.
- **Commit trailer:** `Implemented-by: <model> via <runner>` (today: `via agy-foreman`).
- **The status line** shows the running job's tier or model, and that pool's remaining quota.
- **`agy_status`** lists tiers, their pools and their cooldowns.
- **README and skill:** "Gemini 3.8 Flash only" in Limitations is replaced by the tier model. The `gemini-delegation` skill gets a short section on tiers and escalation.

## 7. Calibration
Token calibration and the delegate-vs-direct refusal (`refuse_ratio`) currently assume one model. Ledger entries record tier, runner and model. Calibration is computed per tier, and falls back to the overall numbers while a tier has fewer than about 5 runs. (That threshold is my call.)

## 8. Verified so far (2026-10-18, author's machine)
- `agy models` lists `gemini-4-argon-low|medium|high`, `claude-opus-5-5-*`, `claude-sonnet-5-5-*` and `gpt-oss-120b-medium`, next to `gemini-3.8-flash-*`.
- `agy -p /usage` reports separate pools:
  - `Gemini Models` (five-hour + weekly)
  - `Claude and GPT models` (five-hour + weekly)
  - `Gemini 4 Argon` (weekly only).
- A headless Argon run (`--model gemini-4-argon-low --output-format stream-json`) returns the same `init` / `step_update` / `result` events, with `usage`, that the pipeline already parses.
- Bug fixed on branch `feat/multi-model` (in the working tree, not yet committed): the Argon weekly row overwrote the Gemini Models weekly value in `parseUsage` (regression test in `test/usage-quota.test.ts`).
- Pre-existing, unrelated: `test/jobs/fsutil.test.ts` "survives many overlapping writes…" fails on the author's Windows machine with `EPERM` on rename, with and without these changes.

## 9. Later: parallel workers across connected CLIs (not in this version)
The user's direction for after this ships: when plan tasks are **independent**, run them at the same time on different connected runners, for example Flash on task 3, Argon on task 4 and Claude Code on task 5. Each task runs in its own worktree and is verified as usual. What that needs, so this version doesn't block it:
- **Telling tasks are independent:** use the plan's file lists (Superpowers `Create:` / `Modify:`, OpenSpec items). Tasks touching different files, with no stated ordering, count as independent. Anything unclear runs in order.
- **A scheduler over worker slots:** per-runner concurrency limits (`max_concurrent` per connection, not just one global value), assigning tasks to free runners by tier rules and pool quota.
- **Merging in plan order:** results are merged in plan order. The existing `merge-tree` check catches overlaps that the file lists missed, and a conflicting task re-runs on top of the merged result.
- **Studio:** several running tasks at once. The Studio spec already handles two running tasks (its §4.2). Its rules generalize to N.
This version only keeps the door open: runners behind one interface (§5), connections stored as a list (§2), and attempts tracked per job (§3.1).
