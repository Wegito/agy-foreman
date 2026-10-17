# Async Execution: Background Execution & Waiting

`agy-orchestrator` is designed for non-blocking asynchronous execution. The orchestrator delegates work without burning tokens polling in the foreground.

## The Waiting Protocol

1. **Non-Blocking Start**:
   Calling `agy_start(...)` returns immediately with `{ job_id, wait_hint }`. The job is now executing in an isolated background worktree.

2. **Wait via Background Shell Command**:
   Immediately run `agy-orchestrator wait <job_id>` as a background command with `run_in_background: true`:

   ```bash
   agy-orchestrator wait t-7f3a
   ```

   In Claude Code, background commands notify the session when they exit. After launching the command, end your turn immediately or work on independent, unrelated tasks.
   **Never poll in a loop in the foreground** using tool calls. Foreground loops waste orchestrator context and tokens.

3. **Leave Task Scope Files Untouched**:
   While Gemini runs in its external worktree, the orchestrator must not modify files in the task's scope in the primary workspace. Doing so risks merge conflicts at completion.

4. **Waking & Result Retrieval**:
   When `agy-orchestrator wait` completes:
   - Exit code `0`: Job passed verification. Call `agy_get(job_id)` to retrieve the envelope, review changes, and call `agy_act(job_id, "finalize", { mode: "squash" })`.
   - Exit code `1`: Verification failed or merge conflict. Retrieve envelope, review errors, and decide whether to provide feedback via `followup` or discard.
   - Exit code `2`: Quota exhausted during run. The user selects from the quota card: Retry now, Continue without Gemini, or Wait for reset.
   - Exit code `3`: System or execution error.

5. **Client Auto-Backgrounding Safety Net**:
   For clients calling `agy_get(job_id, wait_s=60)` directly, calls lasting longer than 2 minutes are automatically moved to background tasks with progress notifications, ensuring tool timeouts are never hit.
