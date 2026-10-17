# Lessons: The Continuous Learning Loop

`agy-orchestrator` records every failure, timeout, scope violation, and task requiring follow-up as an incident. To prevent repeating the same mistake, the orchestrator reflects on incidents and records actionable lessons.

## When to Record a Lesson

Whenever a delegated run finishes with an incident (such as test failures, test tampering, timeout, scope drift, or unexpected environment errors), the orchestrator must record a lesson using:

```json
agy_act(job_id, "lesson", {
  "text": "In this repository, run `npm test -- --unit`; full `npm test` runs e2e tests that require Docker.",
  "audience": "implementer",
  "scope": "project",
  "tags": ["testing", "e2e"]
})
```

## Lesson Guidelines

1. **Concise and Actionable**: 1–2 sentences, strictly actionable advice, neutral tone with no blame. Focus on what to do rather than criticizing the model.
2. **Audience**:
   - `implementer`: Information Gemini needs to succeed in future runs (e.g., file paths, module structures, preferred testing flags). These lessons are automatically injected into future `<lessons>` blocks in briefs.
   - `orchestrator`: Guidelines for the orchestrator regarding task routing, brief construction, and avoiding unfeasible delegations. Top orchestrator lessons are displayed in `agy_status()`.
3. **Scope**:
   - `project`: Stored in `<repo>/.agy-orchestrator/lessons.md`. Applicable specifically to the current codebase.
   - `global`: Stored in user state directory. Applicable across all repositories and workspaces.

## Promotion to Skill References

When a lesson is triggered 3 times across runs, the daemon drafts a patch proposing to incorporate the guidance into the appropriate skill reference file (`routing.md`, `prompting.md`, or `known-issues.md`). The user is presented with a diff card to approve the promotion before any skill file is edited.
