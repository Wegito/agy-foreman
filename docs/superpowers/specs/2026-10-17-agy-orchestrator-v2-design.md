# agy-orchestrator v2: Design Spec

**Status:** Draft, in review (rev 3) · **Date:** 2026-10-17
**License:** MIT, free and open source · **Primary user:** the author's own work (Windows and Linux)

---

## 1. What this is

An MCP server, a small CLI, and an agent skill. Together they let an orchestrating agent (Claude Code / Opus, Codex, Cursor) hand **well-specified, verifiable** work to **Gemini 3.8 Flash** through the official Antigravity CLI (`agy`) in headless mode, **paid for by the user's own Google AI Pro plan**.

**Differentiator:** the orchestrator never has to trust Gemini's own report. Every task runs like a CI job. The orchestrator defines the tests up front. The server isolates the work in a worktree, restores protected files, runs the tests itself, and returns a compact, verified result. The system also **learns from every failure**.

### Changes from v1
| v1 | v2 |
|---|---|
| agy-switch, multi-account rotation, quota thresholds | **Removed.** No login tokens are touched, ever. |
| Agent calls agy whenever it wants | **Human approval before every Gemini run**, with a token estimate on the card |
| Gemini reports "PASSED" | **Orchestrator-written contract tests (red → green), run by the server** |
| Blocking tool calls | **Background jobs** that wake the orchestrator when done, like Claude Code's own subagents |
| 5 loosely defined tools | **4 tools** over **3 deep modules** |
| Python, everything from scratch | **TypeScript, forked from MIT code** (§12) |
| Gemini 3.1 Pro / Flash tiers | **Gemini 3.8 Flash only** (§9.1) |
| No memory | **Learning loop:** failures become lessons that improve future briefs and the skill (§8) |

### Non-goals
- No API billing and no Enterprise requirement
- No account switching, no token storage, no quota workarounds
- No interactive agy sessions
- No autonomous delegation loops
- Benchmark and portfolio material come **after** the project ships (§16)

---

## 2. ToS position
| Rule | How the design follows it |
|---|---|
| Never touch Antigravity OAuth tokens ([Terms](https://antigravity.google/terms)) | Only the official `agy` binary is started, with the user's existing login. Nothing reads the keyring, redirects HOME, or stores tokens. |
| No automated account rotation ([FAQ](https://antigravity.google/docs/faq)) | One account: whatever `agy` is logged into. Quota exhaustion shows a card. "Retry" only runs on a user click, and the tool doesn't know or ask why quota might be back (§7). |
| Wrapping agy in third-party agents is "not supported" on consumer plans ([FAQ](https://antigravity.google/docs/faq)) | **The remaining gray area.** Mitigations: a human approves every plan (or every ad-hoc task) before Gemini starts, runs happen at human pace with caps, and each run is one CI-style prompt, which is how headless mode is documented (*"direct scripting and CI workflows"*). The README states this plainly and says the project isn't affiliated with Google. |

---

## 3. Headless mode, shaped like CI
```
 approve ─▶ prepare ─▶ contract ─▶ brief ─▶ run (agy -p) ─▶ verify ─▶ report ─▶ learn
   card     worktree   red check   file     stream-json,    server   envelope   lessons
            + lock     (must fail) +skills  live guard      tests    + diff     ledger
```
- One prompt per run, no steering. A follow-up is a new run with `--conversation <id>`.
- Uses `--output-format stream-json`, which gives live events for progress, the live guard and early quota detection. The final `result` event carries the same envelope as `json` mode, so status comes from JSON, never from the exit code.
- Everything except the `agy -p` call is deterministic code.

---

## 4. Architecture: 3 deep modules
```
 Orchestrator ── reads skills/gemini-delegation ── MCP (4 tools) ── CLI (wait / watch / doctor)
                                                       │
                                ┌──────────────────────┴───────────────────────┐
                                │ jobs    start / get / act                    │
                                │   gate · queue · ledger · cooldown ·         │
                                │   progress · lessons · recovery              │
                                ├──────────────────────────────────────────────┤
                                │ pipeline   runJob(spec, deps) → Envelope     │
                                │   worktree · contract · brief · skills ·     │
                                │   verify · tamper · report                   │
                                ├──────────────────────────────────────────────┤
                                │ agy        run(request, onEvent) → Outcome   │
                                │   spawn · stream-json · 429 watch · kill ·   │
                                │   envelope · failure classification          │
                                └──────────────────────────────────────────────┘
```
| Module | Interface | Hidden inside |
|---|---|---|
| **`agy`** | `run(request, onEvent) → Outcome` with `Outcome = success \| quota{resetIn} \| denied \| timeout \| guard_violation \| error` | Spawning with closed stdin, `--log-file` 429 watch, stream-json parsing, Windows `taskkill /T /F` vs POSIX process groups, envelope parsing, failure taxonomy |
| **`pipeline`** | `runJob(spec, deps) → Envelope` | Worktree lifecycle, contract red check, brief + skills + lessons injection, live guard rules, verify, tamper snapshot, merge-tree, commit |
| **`jobs`** | `start(spec) / get(id, opts) / act(id, action)` | Approval gate, token gate, queue and caps, cooldown and quota card, progress model, ledger, lessons store, crash recovery |

`server.ts` only translates MCP calls into `jobs`, and `cli.ts` is a thin shell over the same modules.

**Seams with two or more real adapters** (and only these):
- `AgyRunner`: real `agy` / fake agy fixture
- `Gate`: MCP elicitation / client permission mode
- `TestReportParser`: JUnit XML / pytest JSON / `go test -json`

Git and the filesystem are **not** abstracted, since each has only one adapter.

### File layout
```
agy-orchestrator/
├── LICENSE, NOTICE
├── src/
│   ├── server.ts  cli.ts  config.ts  paths.ts
│   ├── agy/       run.ts  stream.ts  quota.ts  kill.ts  envelope.ts  failure.ts
│   ├── pipeline/  index.ts  worktree.ts  contract.ts  brief.ts  skills.ts
│   │              guard.ts  verify.ts  tamper.ts  report.ts  parsers/
│   └── jobs/      index.ts  gate.ts  ledger.ts  cooldown.ts  progress.ts
│                  lessons.ts  recovery.ts
├── skills/gemini-delegation/
│   ├── SKILL.md
│   └── references/ models.md · routing.md · prompting.md · known-issues.md
│                   review.md · async.md · lessons.md
├── AGENTS.md
└── test/   unit · fake-agy fixtures · anti-cheat suite · CI matrix
```

### Project config: `.agy-orchestrator.json`
Created by `agy-orchestrator init` (or on first use), auto-detected from `package.json` / `pyproject.toml` / `Makefile` / `go.mod`, and editable by hand:
```json
{
  "test_command": ["npm", "test", "--", "--reporter=junit"],
  "setup_command": ["npm", "ci"],
  "protected_paths": ["tests/**", "**/*.spec.*", "vitest.config.*", "package.json#scripts"],
  "model": "gemini-3.8-flash-high",
  "gate": "elicitation",
  "approval": "per_plan",
  "max_concurrent": 2,
  "max_runs_per_hour": 10,
  "refuse_ratio": 1.5,
  "skill_roots": ["~/.claude/skills", ".claude/skills", ".agents/skills"],
  "allowed_commands": ["npm run lint", "npx tsc --noEmit"],
  "unknown_commands": "deny",
  "allowed_mcp": [],
  "web": false
}
```
This keeps the tool interface small: commands and policies live here, not in every call.

---

## 5. MCP tools (4)
The descriptions are kept short on purpose. Target: **under 1.5k tokens for all tool schemas together**, measured in CI, because they sit in the orchestrator's context every turn.

### `agy_status()`: free
agy version and login check, configured model present (yes/no), running jobs with progress, cooldown and reset time, `delegation: active|paused`, ledger (today / 7 days), estimate calibration, and the **top 5 orchestrator lessons** for this project.

### `agy_start(...)`: gated (except `dry_run`), returns immediately
```
kind:            "implement" | "explore"
task?:           string                    # brief text, or…
plan?:           { file, step }            # …read the step straight from a plan file
contract_tests?: [{ path, content }]       # implement: orchestrator-written failing tests
hidden_tests?:   [{ path, content }]       # optional, never shown to Gemini
skills?:         string[]                  # names or paths, resolved against skill_roots
estimate:        { direct_tokens, delegate_overhead_tokens, reason }   # required for implement
effort?:         "low" | "medium" | "high"
dry_run?:        boolean
base_ref?:       string
```
→ `{ job_id, wait_hint }`, or immediately `state: refused | quota | denied`.

- **`plan`:** parses Superpowers / OpenSpec-style plan files. It takes the step's text, files, test commands and any test code blocks, which become contract tests unless `contract_tests` is given. This fits the author's existing workflow (the plan-writing skill, then execute).
- **`explore`:** read-only research in a throwaway detached worktree. `--json-schema` forces `{summary, citations[{path, line, claim}], open_questions}`, and the server checks every citation.
- **`dry_run`:** no Gemini call and no approval. It does run the contract red check locally (no model involved). Returns the rendered brief, the exact agy command, the resolved skill list, the injected lessons, and the red-check result.

### `agy_get(job_id, wait_s?, diff_mode?, paths?)`: free
State plus detailed progress while running (§6.2), or the **result envelope** when done:
```json
{
  "job_id": "t-7f3a", "kind": "implement", "state": "passed",
  "branch": "agy/t-7f3a", "worktree_path": "…", "base_sha": "a1b2c3d", "head_sha": "e4f5a6b",
  "merge_check": "clean", "conflicting_files": [],
  "contract": { "red_on_base": true, "green_after": true },
  "verify": { "ran_by": "server", "collected": 48, "passed": 48, "new_skips": 0,
              "hidden_tests": "passed", "protected_paths_intact": true, "failures": [] },
  "diff_stat": " auth/jwt.py | 64 +++--\n 1 file changed",
  "untrusted_report": "<<<AGY-UNTRUSTED nonce=8f2c>>> … <<<END nonce=8f2c>>>",
  "audit_flags": [], "guard_events": [],
  "skills_used": ["test-driven-development"], "lessons_injected": 3,
  "model": "gemini-3.8-flash-high", "usage": { "input_tokens": 412000, "output_tokens": 9100 },
  "orchestrator_tokens_returned": 610, "duration_s": 312
}
```
`wait_s` long-polls (up to 60 s; see §6 for Claude Code).

### `agy_act(job_id, action, ...)`
- `followup` (gated): `{ feedback }`. Same worktree and conversation, then verify again.
- `finalize`: `{ mode: squash|merge|discard|keep, target_branch? }`. A conflict returns `state: conflict` and the worktree is kept.
- `cancel`: tree-kills agy and keeps the worktree.
- `lesson`: `{ text, audience: orchestrator|implementer, scope: project|global, tags? }` (§8)
- `quota_choice`: `{ choice: retry|continue_without|wait }`. Only used in `gate: "client"` mode (§7).
- `resume_delegation`: turns delegation back on after "continue without Gemini".
- `revoke_plan`: `{ plan_file }`. Ends a plan grant, so the next step shows the plan card again.

---

## 6. Background execution, as smooth as built-in subagents

### 6.1 How the orchestrator waits
**The goal:** `agy_start` returns at once. The orchestrator keeps working on other things, or **goes idle (spending no tokens) and is woken automatically** when Gemini finishes. That's the same experience as Claude Code's own background subagents.

| Client | Mechanism | Verified? |
|---|---|---|
| **Claude Code** (primary) | Right after `agy_start`, the skill runs **`agy-orchestrator wait <job_id>`** as a **background Bash command** (`run_in_background: true`). Claude Code notifies the session when a background command exits, so the orchestrator continues or ends its turn, and is re-invoked on completion. The `wait` output is a 3-line summary; the orchestrator then calls `agy_get` for the envelope. | Background Bash completion notifications are a documented harness feature |
| **Claude Code** (safety net) | If the orchestrator calls `agy_get(wait_s)` instead, any MCP call that runs past **2 minutes is moved to a background task automatically**, and the result arrives as a task notification ([Claude Code MCP docs](https://code.claude.com/docs/en/mcp), v2.1.212+). The server sends **MCP progress notifications** so the call never hits the idle timeout. | ✅ documented |
| Clients with **MCP Tasks** ([extension](https://modelcontextprotocol.io/extensions/tasks/overview)) | `agy_start` can return a task handle, and the client polls `tasks/get` natively | **V8:** check which clients support it |
| Other clients (Codex, Cursor) | `agy_get(job_id, wait_s=60)` in a loop | Works everywhere |

**How `wait` works:** the MCP server writes job state to `<state_dir>/jobs/<id>.json` atomically. `wait` watches that file. There's no socket and no daemon, so it works the same on Windows and Linux. It exits with code 0 for passed, 1 for failed/conflict, 2 for quota, 3 for error.

**Rules in the skill (`references/async.md`):**
- After starting a job, do independent work or end the turn. Never poll in a loop in the foreground.
- **Don't touch files in the task's scope** while it runs. The brief lists them, and `merge_check` catches overlaps anyway.
- When woken, call `agy_get`, review, then `finalize` or `followup`, then continue with the next plan step.
- Server lifetime: jobs belong to the MCP server process. If the client session ends, running jobs are cancelled and recovery marks them on the next start (§11).

### 6.2 Detailed live progress with % estimate
**Sources:**
1. **Phase weights:** prepare 5% · contract 5% · run 75% · verify 12% · report 3%
2. **Checklist inside the run phase:** the brief tells Gemini to keep `.agy-task/progress.md` up to date (`- [ ] step` → `- [x] step`), seeded by the server from the plan step's sub-tasks. Run-phase % = checked ÷ total.
3. **stream-json events:** current tool, current file, step count, tokens so far
4. **ETA:** elapsed ÷ overall fraction, smoothed, and capped by the ledger's median duration for tasks of a similar size

**Shown in `agy_get`, `wait`, and `agy-orchestrator watch`** (a live terminal view for the human):
```
t-7f3a  ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░  64%  · run · step 4/6 "add refresh endpoint"
        editing src/auth/refresh.ts · 37 tool steps · 182k tokens · 4m12s elapsed · ETA ~2m30s
```
The % is labelled as an estimate. If Gemini stops updating the checklist, the run-phase % falls back to a time-based estimate from the ledger.

---

## 7. Approval, token gate and quota card

### 7.1 Approval gate: once per plan
Approval is given **once per plan**, not per task and never per tool call. Claude Code supports MCP elicitation ([docs](https://code.claude.com/docs/en/mcp)).

**Plan runs** (`agy_start` with `plan: {file, step}`): the **first** delegated step of a plan shows a **plan card**:
> **Delegate plan "Foundation and agy module" to Gemini 3.8 Flash?**
> `docs/superpowers/plans/…-01-foundation-agy.md` · Steps proposed for Gemini: 5, 6, 8 (3 of 10)
> Estimated: doing them myself ~55k tokens · delegating ~14k tokens
> **[Approve plan]** · **[Deny]**

Approving creates a **plan grant** keyed by the plan file's path and **content hash**. Every later step of that plan starts **without any card**, as long as the grant is valid. The grant ends when:
- the plan file changes (hash mismatch → new card showing what changed),
- all proposed steps are finished, or the user revokes it (`agy_act(action: "revoke_plan")`),
- delegation is paused (quota card → "Continue without Gemini"), or
- 24 h pass (configurable).

The token gate (§7.2) still checks **each step** silently. An obvious loser is refused without asking, and the orchestrator does that step itself.

**Ad-hoc runs** (no plan file) and **followups outside a plan** show the per-task card instead:
> **Delegate to Gemini 3.8 Flash (high)?** "Add refresh-token rotation" · skills: test-driven-development
> Doing it myself: ~18k tokens · Delegating: ~4k tokens · Why: 9-file change with contract tests
> **[Approve]** · **[Deny]**

Followups *inside* an approved plan (fixing a failed step) are covered by the plan grant.

**Not built, reserved for later: fully automatic mode.** A future `approval: "auto"` setting would skip the plan card entirely. It's deliberately **not implemented in v0.1**: the config rejects it, and the README explains why (ToS gray area, and no human check before delegation). The `approval` setting exists now with `per_plan` (default) and `per_task`, so adding `auto` later needs no redesign.

`gate: "client"` fallback: the server refuses unless that mode is configured. The README then gives the client's "ask" rule, e.g. Claude Code `permissions.ask: ["mcp__agy-orchestrator__agy_start", "mcp__agy-orchestrator__agy_act"]`. Overuse caps: `max_concurrent`, `max_runs_per_hour`.

### 7.2 Token gate
1. The orchestrator must estimate `direct_tokens` (files it would read ≈ chars/4, plus code to write, plus test runs) and `delegate_overhead_tokens` (brief ~1.5k, contract tests, result ~0.6k, plus review ≈ expected diff size). `routing.md` has the heuristics.
2. **The server refuses without prompting** if `delegate_overhead_tokens × refuse_ratio > direct_tokens`.
3. **Calibration:** the server records exactly how much text it returned to the orchestrator per job (`orchestrator_tokens_returned`, including followups and diffs). `agy_status` reports the gap, e.g. *"overhead estimates run 35% low; median real overhead 5.1k"*, and the skill tells the orchestrator to correct for it.

### 7.3 Quota exhaustion
1. During a run: the 429 is seen in agy's log or stream, agy is killed right away, and the job is `state: quota` with `{reset_in_s, reset_at}`. **Partial work is kept.**
2. The **quota card** is shown (an elicitation; in client mode the same options come back as a structured response that the skill relays word for word):
   > **Gemini quota reached.** Resets in 2h 13m (16:40). Task t-7f3a paused, partial work kept.
   > **[Retry now]** · **[Continue without Gemini]** · **[Wait for reset]**
   - **Retry now:** clears the cooldown and reruns (a followup for a paused task). If the quota is still out, the card comes back. Never automatic.
   - **Continue without Gemini:** the orchestrator takes over from the partial work, and delegation stays `paused` until `resume_delegation`.
   - **Wait for reset:** new Gemini calls are refused instantly, with the reset time.
3. While a cooldown is active, new starts go **straight to the quota card**, never to an approval card.
4. The orchestrator never decides on its own, never silently does the work, and never loops. The wording stays neutral.

---

## 8. Learning loop: failures improve future runs
**Goal:** the same mistake shouldn't happen twice, whether it was a bad brief, a wrong test command, Gemini drifting out of scope, or a repo quirk.

### 8.1 Capture (automatic)
After every job that **isn't a clean first-try pass** (failed, conflict, guard violation, audit flags, refused, timeout, or a pass that needed followups), the server writes an **incident** to the ledger:
`{ category, evidence, brief_hash, skills, effort, files, followups, outcome }`

Category taxonomy: `brief_missing_context` · `wrong_or_missing_gate` · `scope_creep` · `protected_file_attempt` · `test_tampering` · `contract_too_weak` · `flaky_tests` · `env_setup` · `timeout_too_short` · `task_too_big` · `skill_mismatch` · `quota` · `agy_error`

The server fills in `category` and `evidence` from what it observed (verify output, guard events, audit flags, failure class).

### 8.2 Reflect (orchestrator, required by the skill)
After an incident, the orchestrator records one short lesson with `agy_act(action: "lesson")`. The rules:
- 1–2 sentences, actionable, no blame. Example: *"In this repo, run `pnpm test:unit`; `pnpm test` starts e2e and times out."*
- `audience: implementer` → lessons Gemini needs ("models live in `src/db/models`, not `models/`")
- `audience: orchestrator` → lessons about routing and briefs ("UI tasks without visual tests fail; keep them local")
- `scope: project` (stored in the repo) or `global` (all projects)

### 8.3 Store
- Project: `<repo>/.agy-orchestrator/lessons.md` (readable, can be committed and shared)
- Global: `<state_dir>/lessons.md`
- Entries have tags (paths, categories) and a hit counter. Duplicates (same category plus a similar text) are merged and counted. At most 30 active lessons per scope; the least-used ones are archived.

### 8.4 Apply (automatic)
- **Implementer lessons** are injected into every brief as a `<lessons>` block: the top ≤5 matching the task's files, tags or kind. Shown in `dry_run`.
- **Orchestrator lessons:** the top 5 appear in `agy_status`, and `SKILL.md` tells the orchestrator to read them before deciding whether to delegate and before writing a brief.

### 8.5 Promote into the skill (user-approved)
When a lesson reaches **3 hits** (or a category repeats 3 times), the server **drafts a patch** to the right skill reference file (`routing.md`, `prompting.md`, `known-issues.md`) and shows it as an approval card with the diff. When approved, it edits the **installed** skill copy and records the change in `lessons.md` ("promoted 2026-10-20"). The skill is never edited without approval.

### 8.6 Success signals
The ledger also tracks the first-try pass rate per category, kind and effort. `agy_status` uses it for routing hints such as *"explore tasks: 92% useful; UI implement tasks: 30% first-try → keep local"*.

---

## 9. The skill: `skills/gemini-delegation`
Works with any agent (SKILL.md plus references, and `AGENTS.md` for agents without skill support).

### 9.1 `models.md`: Gemini 3.8 Flash only
The one Gemini model available on every consumer plan, including trial and partner-promo Pro ([Choose a model](https://antigravity.google/docs/models/), 2026-10-17).

| Setting | Use for |
|---|---|
| `gemini-3.8-flash-high` (default) | Implementation against contract tests, multi-file changes, debugging with a failing test |
| `gemini-3.8-flash-medium` | Bulk mechanical edits, boilerplate, scaffolding, summaries |
| `--effort low` | Narrow read-only `explore` questions |

All Gemini models share one quota pool charged at API prices ([blog](https://antigravity.google/blog/changes-to-antigravity-plans)), and Flash is the cheapest way to use it. Out of scope: Argon (paid Pro and Ultra only), 3.1 Pro / 3.7 / 3.6 Flash (Enterprise only), and the Claude/GPT models inside agy. The model slug lives in config, and `agy_status` warns if it's missing from `agy models`.

### 9.2 `routing.md`: Gemini or the orchestrator?
- **Keep on the orchestrator:** unclear requirements, design or architecture, security-sensitive code, anything that needs conversation context, small changes (under ~60 lines or 1–2 tool calls), **any write task without a machine check**, and final review.
- **Delegate to Flash:** plan steps with contract tests, bulk mechanical changes, writing tests from a spec, large-codebase reading (`explore`), boilerplate.
- **Never delegate** grep, regex or file listing.
- **Two strikes:** if Flash fails the same task twice, take it back or split it.
- **Token rule:** delegate only if `direct > overhead × refuse_ratio` (the server enforces this too). Read the calibration in `agy_status`.
- **Read the orchestrator lessons first.**

### 9.3 `prompting.md`: writing the brief
Based on [Google's prompting strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies) and claude-agy-mcp's `writing-the-brief.md` (MIT, adapted with attribution):
- The brief is everything Gemini knows. There's no chat history.
- XML blocks, one structure: `<task>`, `<context>`, `<scope>` (files to touch / leave untouched), `<constraints>`, `<verification>`, `<skills>`, `<lessons>`, `<progress>`, `<report>`
- Large context first, instructions last, with an anchor phrase
- Name the real gate commands (from config). Never just say "run the tests".
- One bounded task per brief. Do not commit. Give today's date and pin library versions (knowledge cutoff).
- **Forbid test-specific special cases in production code.** Seen live: when a given test was itself wrong, Flash added a hidden workaround to a production helper instead of reporting it, even though the brief said to report. Briefs state: "never add code paths that exist only to make a specific test pass; if a test looks wrong, stop and report". Reviews check the diff of shared helpers.
- **Never set hard word or length limits** (seen live: Flash loops trying to hit them). Ask for a structure, and let the server truncate.
- Gemini 3 is terse by default, so ask for the report shape. The server also enforces it with `--json-schema` for explore.
- Hard debugging: effort high, "resolve fully; don't guess missing repo facts"
- Use few-shot examples when an output format matters, and restate the repo's key rules.

### 9.4 Skill handoff: give Gemini the right skills
The orchestrator names the skills Gemini should use (`skills: ["test-driven-development", "~/.claude/skills/fastapi"]`):
1. **Resolve** each name against `skill_roots` in order: `<repo>/.agents/skills`, `<repo>/.claude/skills`, `~/.claude/skills`, plus any configured roots. Paths must stay inside a root and the folder must contain `SKILL.md`. The total size is capped.
2. **Install into the worktree:** copy the folders to `<worktree>/.agents/skills/<name>/`. That's agy's documented **workspace skill location** ([Agent skills](https://antigravity.google/docs/skills/)), so agy discovers them natively. They're excluded via `info/exclude`, never committed, and removed with the worktree.
3. **Point at them in the brief** with a `<skills>` block: "Use these skills: test-driven-development: …". This helps agy pick them reliably.
4. **Compatibility:** skills are an open standard, but some Claude skills mention Claude-only tools ("use the Edit tool"). `skills.ts` flags known Claude-only references in `dry_run`, and `skill_mismatch` incidents feed the learning loop.
5. The orchestrator's skill tells it which kinds of skills to pass: process skills (TDD, debugging), domain and framework skills, and the project's own skills. It shouldn't pass orchestrator-only skills (planning, brainstorming).

### 9.5 `known-issues.md` (each item sourced)
| Issue | Source | Handling |
|---|---|---|
| When quota runs out, agy retries silently until `--print-timeout`, then exits 0 with empty output | agy-bridge, claude-agy-mcp | 429 detection in log or stream, then kill → `quota` |
| Headless mode soft-denies permissioned tools and still exits 0 | [headless docs](https://antigravity.google/docs/cli/headless/) | Deny notices or empty response = failure; pre-grant permissions (§10.3) |
| `--mode plan` is advisory and can still write | claude-agy-mcp (agy 1.2.1/1.2.2) | Explore runs in a throwaway worktree |
| An open stdin pipe hangs agy | agy-bridge source | Always close stdin |
| Default `--print-timeout` is 5 min | headless docs | Always passed explicitly |
| Prompt argument size limits (Linux 128 KiB; ~24k chars seen on Windows) | claude-agy-mcp, CLI-Subagents | The brief goes in a file and the prompt just points at it |
| Cold start takes several seconds to ~45 s | agy-bridge, claude-agy-mcp | The token and routing rules avoid tiny tasks |
| The self-report can claim green tests | all bridges | Server verification; the report is fenced as untrusted |
| Knowledge cutoff predates new APIs | [Google prompting guide](https://ai.google.dev/gemini-api/docs/prompting-strategies) | Date plus pinned versions in the brief |
| Windows uses the older permission system, and the sandbox is Preview | [permissions](https://antigravity.google/docs/permissions/), [sandbox](https://antigravity.google/docs/sandbox/) | Worktree plus server checks are the safety layer |
| Windows doesn't kill the process tree from a group kill | agy-bridge (`kill(-pid)` is POSIX only) | `taskkill /T /F /PID` |
| **When `--print-timeout` fires, agy returns `status: SUCCESS`, an empty response and exit code 0** (stderr: `[agy] print timeout after … returning partial output`) | Live run, agy 1.4.0, 2026-10-17 | Classified as `timeout` |
| `--print-timeout` **defaults to 0s (no limit)** in agy 1.4.0 | `agy --help` | Always passed explicitly |
| Headless runs **inherit the user's global agy plugins, skills, MCP servers and permission mode** (`always-proceed` overrode `--mode plan`, it loaded superpowers, and it called the socraticode MCP) | Live run | Report `permission_mode` from `init`; the worktree plus server checks stay the safety layer; Plan 2 decides how to isolate runs |
| **Hard word or length limits make Flash loop**: it wrote ~15 scripts to count words in its own draft and ran out the clock | Live run | Don't set hard length limits in briefs; ask for a structure, and let the server truncate |
| agy's `--log-file` contains the account email | Live run | Private temp dir, deleted after the run, never returned |
| **Worktrees contain only committed files**: uncommitted or git-ignored files (e.g. docs excluded by an inherited `.gitignore`) are missing for Gemini, and so are dependencies until `setup_command` runs | Found while dogfooding (2026-10-17) | Commit everything the brief references; `setup_command` runs in every fresh worktree; `dry_run` shows the brief |

### 9.6 `review.md`, `async.md`, `lessons.md`
- **review.md:** read the envelope, not the report. Check `contract`, `verify`, `audit_flags` and `guard_events` first, then `diff_stat`. Pull `full` or specific `paths` only where needed (targeted reads allowed). Use `followup` for small fixes and `discard` plus a re-brief when a premise was wrong.
- **async.md:** the rules in §6.1
- **lessons.md:** when and how to write lessons (§8.2)

---

## 10. Pipeline details

### 10.1 Prepare
One lock per repo for git commands. Refuse (or warn) if the tree is dirty. Pin `base_sha`. Create the worktree **outside the repo** (`paths.ts`, §14) with `git worktree add -b agy/<job> <path> <base_sha>`, then run `setup_command`. Snapshot refs, `.git/hooks` and `.git/config`.

### 10.2 Contract tests (red before green)
- **A: existing tests already cover it.** Use the configured test command; matching files are protected.
- **B: contract tests (the default for implement).** The server writes them, **commits them as the job's base commit** (so they're protected), and **runs them on the base, where they must fail**. If they already pass, the job is `refused: "contract tests already pass on base"`.
- **C: hidden tests (optional).** Added only during verify.
- **When the task is *writing tests*:** a "break-it" check reverts the implementation files in a scratch copy, and the new tests must fail there. Otherwise the job is flagged `tests_assert_nothing`.
- Contract-test cost counts toward `delegate_overhead_tokens`.

### 10.3 Brief, skills, run
Write `.agy-task/brief.md`, `.agy-task/progress.md` (the checklist) and, for explore, `.agy-task/report.schema.json`. Install the skills (§9.4). Exclude everything via `info/exclude`.
```
agy -p "Execute the task described in .agy-task/brief.md." \
    --output-format stream-json --model <slug> [--effort <lvl>] --mode accept-edits \
    --print-timeout <N>s --log-file <tmp> [--conversation <id>] [--json-schema <file>]
```
cwd is the worktree, stdin is closed, and output goes to temp files. A watchdog fires at timeout plus 15 s and does a tree-kill. **`--dangerously-skip-permissions` is never used.** Each tool call is approved or denied by the tool-call gate (§10.3b).

### 10.3b Tool-call gate: a workspace `PreToolUse` hook (verified live)
**Problem:** headless agy can't ask anyone, and the user's **global** settings (e.g. `always-proceed`, global plugins, global MCP servers) otherwise apply to every run.

**Solution:** agy loads **workspace hooks** from `<workspace>/.agents/hooks.json` ([Lifecycle hooks](https://antigravity.google/docs/hooks/)). A `PreToolUse` hook receives every tool call (`toolCall.name`, `toolCall.args`) on stdin and answers `auto_approve` / `deny` / `allow` / `ask`, with an optional `reason` that Gemini sees. The pipeline writes, into each worktree's `.agents/` (git-excluded):
- `hooks.json`: `{"agyo-gate": {"PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": "node agyo-hook.mjs", "timeout": 300}]}]}}`
- `agyo-hook.mjs`: a small self-contained script (no dependencies)
- `agyo-policy.json`: this job's rules (worktree root, protected globs, allowed commands, the job's state dir for asking the user)

**Verified on agy 1.4.0, Windows, with the user's global `always-proceed` active (2026-10-17):**
- The workspace hook loads in headless `-p` mode and sees every tool call with its full arguments.
- `deny` **blocks the call even under `always-proceed`**, and Gemini receives the reason.
- If the hook command fails, agy **blocks the tool call** (fails closed).
- On Windows agy runs hooks through `cmd.exe` **from inside `.agents/`** and passes quote characters literally. So the command must be a quote-free relative path (`node agyo-hook.mjs`) with the script inside `.agents/`. Absolute or quoted paths fail.

**Policy, per tool (decisions logged to the job's `review.jsonl`, which feeds guard events and progress):**
| Tool(s) | Decision |
|---|---|
| `write_to_file`, `replace_file_content`, `multi_replace_file_content` | `auto_approve` if `TargetFile` is inside the worktree and not protected. **`deny`** for protected paths, contract tests, `.git/`, `.agents/`, or anything outside the worktree. |
| `view_file`, `list_dir`, `find_by_name`, `grep_search` | `auto_approve` inside the worktree (plus read-only `add_dirs`). **`deny` outside**, which also stops Gemini reading the user's global skills and plugins and secrets elsewhere on disk. |
| `run_command` | `auto_approve` if it matches the project allowlist (`test_command`, `setup_command`, `allowed_commands` patterns, read-only git: `git status/diff/log/show`). **`deny`** known-dangerous patterns (`git push/commit/reset --hard/checkout <other>`, `rm -rf` outside the worktree, piping downloads to a shell, reading the hidden-test location). **Anything else** follows `unknown_commands`: `deny` (default, with a reason Gemini can act on) / `allow` (trusted repos) / `ask_user` (opt-in). |
| `call_mcp_tool` | **`deny`** unless `ServerName/ToolName` is in `allowed_mcp`. This blocks the user's inherited global MCP servers (a live run called socraticode). |
| `invoke_subagent`, `define_subagent`, `manage_subagents`, `send_message`, `schedule`, `browser_*`, `generate_image` | **`deny`**: no nested agents, timers or browsers inside a delegated task |
| `search_web`, `read_url_content` | `deny` unless the task sets `web: true` (prompt-injection surface) |
| `ask_question`, `ask_permission` | `deny` with reason: *"No human is available in this run. Decide using the brief, or stop and report what you need."* |
| any other tool | `deny` (default-deny for tools added in future agy versions) |

**Fully automatic by default.** The hook is deterministic code. It decides each tool call in milliseconds with **zero orchestrator tokens and no human prompts**, so the orchestrator can stay idle for the whole run. Control comes from *what is allowed*, not from approving each call. Denied commands are returned as `denied_commands` in the result envelope (with counts). After the task the orchestrator may suggest adding a recurring one to `allowed_commands` (one question, after the run, never during it). Repeated denials also become `wrong_or_missing_gate` incidents in the learning loop.

**Optional per-call human approval (`unknown_commands: "ask_user"`, off by default):** the hook writes a request file to the job's state dir and waits (up to its 300 s timeout). The MCP server sees it and shows an **elicitation card**: *"Gemini wants to run `docker compose up -d` in t-7f3a: [Allow once] [Allow for this task] [Deny]"*. The hook returns the answer, and "Allow for this task" is added to the job's allowlist. No answer before the timeout → `deny`. That gives real human approval for unusual commands, while normal edits and test runs flow without interruption.

**Modes:** `implement` runs use `--mode accept-edits`. `explore` runs use `--mode plan` **and** a read-only policy (all writes and non-read-only commands denied), so read-only is now actually enforced, on top of the throwaway worktree.

**What still leaks from global config:** global and plugin hooks also run (they're layered), and global skills are still *listed* to the model (reading them is denied). `--disable-slash-commands` is passed to stop skill expansion in print mode. The skill and known-issues file document this.

### 10.4 Live guard (stream-json), the second layer
The hook (§10.3b) **prevents** bad tool calls. The stream guard is the **backstop**: if a forbidden action still shows up in the stream (a hook bug, or a future agy change), the run is killed. Each `step_update` tool event is checked against the same rules:
- A write to a protected path, a contract test, `.git/`, or anything outside the worktree → **kill right away**, `state: failed`, `guard_events: [...]`, incident `protected_file_attempt`
- Commands like `git push`, `git commit`, `git checkout <other branch>`, or attempts to read the hidden-test location → kill
- Everything is also recorded for the incident evidence. This replaces v1's after-the-fact transcript parsing.

### 10.5 Verify (server-side)
1. Restore protected paths and contract tests from `base_sha`
2. Add hidden tests
3. Run the test command as an argv array and parse the result through `TestReportParser`
4. Compare collected, passed and skipped counts with the baseline. There must be no new skips or xfails.
5. Tamper check: refs, hooks and config must match the snapshot
6. Diff heuristics: new skip/xfail, mock/patch in non-test code, `os._exit`, lint-disable comments, test fixture literals copied into source code

### 10.6 Report
`git add -A && git commit` in the worktree, with a provenance trailer (`Implemented-by: gemini-3.8-flash via agy-orchestrator`, `Verified: 48/48`). Then `diff --stat base..HEAD`, `git merge-tree --write-tree`, and the envelope. Gemini's report is wrapped in **nonce fences as untrusted data**. Then update the ledger and progress, and write the incident (§8.1) if needed.

---

## 11. Recovery
On startup: reconcile the ledger with `git worktree list --porcelain`, run `git worktree prune`, mark orphaned jobs `error`, and garbage-collect worktrees older than a TTL. On Windows, retry removal with backoff because of file locks.

---

## 12. Code reuse plan
**Language: TypeScript / Node ≥ 20**, because the best reusable code is TypeScript.

| Source | License | What we take | Size to review | Effort |
|---|---|---|---|---|
| [sshahzaiib/agy-bridge](https://github.com/sshahzaiib/agy-bridge) | MIT | **Fork as the base:** runner (spawn, closed stdin, log-file 429 watch, watchdog, cancel), `quota.ts`, `config.ts`, MCP scaffolding, tests. Its model-fallback chain is dropped. | ~730 src + ~745 test lines | ~2 h (`runner.ts`/`quota.ts` already reviewed: clean, dependency-injected) |
| [PyModel/claude-agy-mcp](https://github.com/PyModel/claude-agy-mcp) | MIT | **Port selectively:** `envelope.ts`, `failure.ts`, the tree fingerprint, `fake-agy.mjs`, and ideas from its brief guide plus the nonce fencing | ~800 of ~6k lines | ~2 h |
| CLI-Subagents (Apache-2.0), Kio-pon (MIT), agy-delegate (no license) | n/a | **Ideas only.** No code from agy-delegate. | n/a | n/a |

Review budget about half a day. If it goes past ~2,500 lines, write the module ourselves. Changes to the fork: Windows tree-kill, stream-json, `skipPermissions` off by default, everything routed through `jobs`. `NOTICE` keeps both upstream copyright lines.

---

## 13. Doctor and init
`agy-orchestrator doctor` checks:
- Node version, `agy` on PATH, agy version ≥ the pinned minimum, logged in (via `agy models`), configured model available
- git ≥ 2.38 (needed for `merge-tree --write-tree`)
- The client's async support (Claude Code version for auto-backgrounding)
- The skill installed for the client

`agy-orchestrator init` writes `.agy-orchestrator.json` with the detected commands and registers the MCP server with the client.

---

## 14. Platform support
| | Windows | Linux | macOS |
|---|---|---|---|
| Server (Node ≥ 20) | ✅ | ✅ | ✅ |
| Kill the process tree | `taskkill /T /F /PID` | process group | process group |
| State and worktrees | `%LOCALAPPDATA%\agy-orchestrator` | `$XDG_STATE_HOME/agy-orchestrator` | `~/Library/Application Support/agy-orchestrator` |
| agy `--sandbox` | Preview (older system) | ✅ namespaces | ✅ seatbelt |
| CI | `windows-latest` | `ubuntu-latest` | `macos-latest` |

Linux is first-class, and actually the strongest platform. WSL works like Linux.

---

## 15. Testing
- **Unit tests (vitest):** each module through its interface. `agy.run` uses the fake agy, `pipeline.runJob` uses fixture repos plus the fake agy, and `jobs` uses a fake clock and a fake gate.
- **Fake agy behaviours:** success, quota hang plus a 429 log, soft-deny with empty output, editing an assertion, adding a skip, deleting a test, editing `conftest.py`, hard-coding a fixture value, writing outside the worktree, `git push`, hanging forever, never updating the progress checklist.
- **Contract:** refused when the tests already pass on base; fails when they're still red after the run; break-it flags tests that assert nothing.
- **Quota card:** prompt kill, cooldown, retry/continue/wait paths, no prompt while in cooldown, nothing automatic.
- **Token gate:** refusal threshold, calibration math.
- **Learning:** incidents get categorized, lessons are deduplicated and counted, injection picks the relevant top-5, promotion triggers at 3 hits and needs approval.
- **Skills:** name resolution order, path escape rejected, missing `SKILL.md` rejected, installed into `.agents/skills`, removed with the worktree.
- **Async:** `wait` exit codes, atomic state-file writes, progress % monotonic and time fallback.
- **Tool schema budget:** CI fails if the combined schemas go over 1.5k tokens.
- **CI matrix:** Windows, Linux, macOS. Live end-to-end is opt-in, with one tiny real task per release.

---

## 16. Open verification items
| ID | Question | Fallback |
|---|---|---|
| V1 | ~~Can we control permissions per run, independent of the user's global settings?~~ | ✅ Yes: workspace `PreToolUse` hook (§10.3b), verified live |
| V12 | Does `auto_approve` also approve tools that the **default** (`request-review`) global mode would soft-deny in headless mode? (Verified only under `always-proceed` so far.) | Also return `permissionOverrides: ["command(<cmd>)"]` from the hook (documented field). Test on a clean CI machine. |
| V13 | Do agy subagents inherit workspace hooks? | Moot: `invoke_subagent` is denied |
| V3 | Does `agy -p /usage` give parseable output? | Ledger plus 429 reset times only |
| V4 | Does `--json-schema` work for long agentic runs (explore)? | Fenced block plus server-side validation |
| V5 | Does `--conversation <id>` resume from the worktree cwd? | New run with the previous report attached |
| V6 | ~~Does Claude Code support elicitation?~~ | ✅ Yes ([docs](https://code.claude.com/docs/en/mcp)) |
| V7 | Minimum agy version to pin | n/a |
| V8 | Which clients support MCP Tasks? | Background `wait` / long-poll |
| V9 | Does headless agy load workspace skills from `<worktree>/.agents/skills`? | Inline the skill paths in the brief with a read permission |
| V11 | ~~Does agy's stream-json include tool parameters?~~ | ✅ Yes: `TargetFile`, `AbsolutePath`, `CommandLine` (live run) |
| V2 | ~~Does `--log-file` exist?~~ | ✅ Yes (`agy --help`, 1.4.0). The 429 line wording is still from agy-bridge's tests. |

---

## 17. Roadmap
- **v0.1 (core plus must-haves):** `agy` module (fork plus Windows kill plus stream-json), pipeline with contract red→green, verify, tamper, live guard, skill handoff; jobs with the approval gate, token gate, quota card, background `wait`, detailed progress plus `watch`, dry run, learning loop (capture, reflect, store, apply, promote); 4 tools; plan-file input; doctor and init; nonce fencing; the skill; the CI matrix.
- **v0.2:** hidden tests, break-it check, estimate calibration reports, success-signal routing hints, MCP Tasks support.
- **Later (designed, not built):** `approval: "auto"` (fully automatic, no plan card).
- **After release:** benchmark (delegated vs direct), anti-cheat demo GIF, portfolio write-up for mountaserhalak.com.
