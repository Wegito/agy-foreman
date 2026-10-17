# Models: Gemini 3.8 Flash

`agy-orchestrator` exclusively targets **Gemini 3.8 Flash**. Flash is universally available on consumer plans (including Google AI Pro promotional and trial tiers) and offers the most cost-effective token consumption against shared quota limits.

## Supported Model Configurations

The model slug is configured in `.agy-orchestrator.json` (default `gemini-3.8-flash-high`) and mapped to specific delegation scenarios:

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

Other models (such as Gemini 3.1 Pro, Gemini 3.7 / 3.6 Flash, or Argon) require Enterprise agreements or paid tiers not supported on consumer plans, or consume excessive quota pools. Anthropic and OpenAI models inside the Antigravity CLI are also out of scope; the orchestrator handles reasoning directly.
