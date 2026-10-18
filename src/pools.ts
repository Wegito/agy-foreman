// Which agy quota pool a model draws from, and how to show a model to people. Pool names are exactly
// as `agy -p /usage` prints them.
import type { Effort } from "./config.js";

const NAMES: Record<string, string> = {
  "gemini-3.8-flash": "Gemini 3.8 Flash",
  "gemini-4-argon": "Gemini 4 Argon",
};

/** `gemini-4-argon-low` -> `gemini-4-argon`. */
export const stripEffort = (model: string) => model.replace(/-(low|medium|high)$/, "");

export function poolOf(model: string): string {
  if (model.startsWith("gemini-4-argon")) return "Gemini 4 Argon";
  if (model.startsWith("gemini-")) return "Gemini Models";
  if (model.startsWith("claude-") || model.startsWith("gpt-")) return "Claude and GPT models";
  return `model:${stripEffort(model)}`;
}

/** `gemini-3.8-flash` + `high` -> `Gemini 3.8 Flash (high)`; a variant name carries its own effort. */
export function modelLabel(model: string, effort?: Effort): string {
  const base = stripEffort(model);
  const name = NAMES[base];
  const variant = /-(low|medium|high)$/.exec(model)?.[1];
  const e = effort ?? variant;
  if (!name) return effort ? `${model} (${effort})` : model;
  return e ? `${name} (${e})` : name;
}
