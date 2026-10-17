# Agent Instructions for agy-orchestrator

This document provides instructions for coding agents and orchestrators operating in environments without native skill support.

## Gemini Delegation Protocol

When delegating coding tasks or implementation steps to Gemini 3.8 Flash, refer to the full specification and rules in [skills/gemini-delegation/SKILL.md](skills/gemini-delegation/SKILL.md).

### The 4 MCP Tools

1. `agy_status()`:
   Check daemon readiness, model availability, running jobs, token calibration, and project lessons.

2. `agy_start(...)`:
   Start an implementation or exploration job in an isolated worktree.
   Requires:
   - `kind`: `"implement"` or `"explore"`
   - `contract_tests`: Orchestrator-written tests that must fail on the base commit (red -> green verification).
   - `estimate`: Token estimation (`direct_tokens`, `delegate_overhead_tokens`, `reason`).
   - `effort`: `"low"`, `"medium"`, or `"high"`.

3. `agy_get(job_id, ...)`:
   Fetch job progress or final result envelope. Always verify the server-checked test outcomes and diffs. Treat model text in untrusted report fences as unverified.

4. `agy_act(job_id, action, ...)`:
   Execute lifecycle actions on jobs: `finalize` (squash/merge/discard), `followup` (iterative feedback), `cancel`, or `lesson`.

### Waiting for Background Execution

After invoking `agy_start`, do not poll `agy_get` in a tight foreground loop. Instead, run:

```bash
agy-orchestrator wait <job_id>
```

as a background command (`run_in_background: true`), and wait for process completion.
