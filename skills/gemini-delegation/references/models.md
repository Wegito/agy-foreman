# Models: Gemini 3.8 Flash and Gemini 4 Argon

`agy-foreman` targets two tiers. `fast` is **Gemini 3.8 Flash**, the default. `strong` is **Gemini 4 Argon**, used when `models` sets it, as the target for `tier: "strong"` and for escalation after a failed `fast` implement job. Flash is universally available on consumer plans (including Google AI Pro promotional and trial tiers) and offers the most cost-effective token consumption against shared quota limits.

## Supported Model Configurations

The model slug is configured in `.agy-foreman.json` (default `gemini-3.8-flash-high`) and mapped to specific delegation scenarios:

| Setting                   | Effort           | Recommended Use                                                                                                 |
| ------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `gemini-3.8-flash-high`   | `high` (default) | Complex implementation against contract tests, multi-file feature additions, deep debugging with failing tests. |
| `gemini-3.8-flash-medium` | `medium`         | Bulk mechanical edits, boilerplate creation, scaffolding, refactors with clear patterns, code summaries.        |
| `gemini-3.8-flash-low`    | `low`            | Narrow read-only `explore` questions, codebase searches, schema inspection.                                     |

## Effort Settings

The `effort` parameter (`low`, `medium`, `high`) in `agy_start` adjusts reasoning depth for the run:

- **`high`**: Default for `kind: "implement"`. Instructs Gemini to resolve issues thoroughly, trace execution paths across files, and avoid guessing missing repo facts.
- **`medium`**: Suitable for standard edits, migrations, and straightforward repetitive tasks.
- **`low`**: Fast responses for simple queries and focused read-only exploratory lookups.

## Out of Scope Models

Other models (such as Gemini 3.1 Pro or Gemini 3.7 / 3.6 Flash) require Enterprise agreements or paid tiers not supported on consumer plans, or consume excessive quota pools. Anthropic and OpenAI models inside the Antigravity CLI are also out of scope until the `backup` tier arrives in Plan 6b; the orchestrator handles reasoning directly.
