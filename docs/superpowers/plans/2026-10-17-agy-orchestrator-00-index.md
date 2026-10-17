# agy-orchestrator v0.1: Plan Index

**Spec:** [2026-10-17-agy-orchestrator-v2-design.md](../specs/2026-10-17-agy-orchestrator-v2-design.md)

The spec covers four subsystems. Each plan below produces working, tested software on its own, and they're written and executed in order. Later plans consume the interfaces that earlier plans produce.

| # | Plan | Delivers | Depends on |
|---|---|---|---|
| 1 | [Foundation and `agy` module](2026-10-17-agy-orchestrator-01-foundation-agy.md) | Forked repo, toolchain, CI matrix (Windows/Linux/macOS), `config`, `paths`, fake-agy fixture, `agy.run()` with stream-json, 429 detection, cross-platform tree-kill, envelope and failure classification | none |
| 2 | [Pipeline](2026-10-17-agy-orchestrator-02-pipeline.md) | `pipeline.runJob()`: worktree lifecycle, contract red→green, brief and skill install, live guard, verify, tamper check, merge-tree, report | 1 |
| 3 | [Jobs, MCP tools and CLI](2026-10-17-agy-orchestrator-03-jobs-tools-cli.md) | `jobs` (gate, token gate, queue, cooldown and quota card, progress, ledger, recovery), the 4 MCP tools, CLI `wait` / `watch` / `doctor` / `init`, dry run, plan-file input | 1, 2 |
| 4 | [Learning loop and skill](2026-10-17-agy-orchestrator-04-learning-skill.md) | Incidents, lessons store, injection, promotion; `skills/gemini-delegation` with references, and `AGENTS.md` | 2, 3 |

Plans 2–4 are written after Plan 1 is executed, so they build on the real code instead of guesses.

## Verified facts used across plans (agy 1.4.0 on the author's machine, 2026-10-17)
- `agy --help`: `--print-timeout` **defaults to 0s (no limit)**, so we always pass it. `--effort` accepts `low|medium|high|xhigh|max` in general, but **Gemini 3.8 Flash supports only `low|medium|high`** (matching the three slugs from `agy models`). The project allows only those three and rejects anything else in config validation. `--mode accept-edits|auto|plan`. `--log-file`, `--output-format text|json|stream-json`, `--json-schema`, `--conversation`, `--add-dir`, `--sandbox`, `--disable-slash-commands` and `--dangerously-skip-permissions` all exist.
- `agy models` lists `gemini-3.8-flash-high`, `gemini-3.8-flash-medium`, `gemini-3.8-flash-low` (plus Claude 4.6 and GPT-OSS models, which are out of scope).
- git 2.54 (≥ 2.38 needed for `merge-tree --write-tree`), Node 25 locally. The project targets Node ≥ 20.
- **Tool-call gate verified live:** a workspace `.agents/hooks.json` `PreToolUse` hook loads in headless mode, sees every tool call with its arguments, and its `deny` blocks calls **even under the user's global `always-proceed`**. A failing hook blocks the call (fails closed). On Windows the hook command must be quote-free and relative (`node agyo-hook.mjs`, script inside `.agents/`), because agy runs it via `cmd.exe` from `.agents/` and passes quotes literally. Plan 2 builds the gate (spec §10.3b). Plan 1 already never passes `--dangerously-skip-permissions` by default.
