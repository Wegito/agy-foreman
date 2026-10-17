// Adapted from claude-agy-mcp src/envelope.ts (MIT, Copyright (c) 2026 elkaix).
// Extended with tool names, parameters and outputs, which agy 1.4.0 emits on tool steps.
import { EMPTY_USAGE, type AgyResult, type AgyUsage, type StreamEvent } from "./types.js";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function usageOf(raw: unknown): AgyUsage {
  if (!isObj(raw)) return { ...EMPTY_USAGE };
  return {
    inputTokens: num(raw.input_tokens),
    outputTokens: num(raw.output_tokens),
    thinkingTokens: num(raw.thinking_tokens),
    cacheReadTokens: num(raw.cache_read_tokens),
    totalTokens: num(raw.total_tokens),
  };
}

function resultOf(r: Obj): AgyResult {
  return {
    ...(str(r.conversation_id) ? { conversationId: str(r.conversation_id) } : {}),
    status: str(r.status) ?? "",
    response: str(r.response) ?? "",
    ...(str(r.error) ? { error: str(r.error) } : {}),
    durationSec: num(r.duration_seconds),
    numTurns: num(r.num_turns),
    usage: usageOf(r.usage),
    ...("structured_output" in r ? { structuredOutput: r.structured_output } : {}),
  };
}

export function parseLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let o: unknown;
  try {
    o = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isObj(o)) return null;
  const event = str(o.event);
  if (!event) return null;

  if (event === "init") {
    const init = isObj(o.init) ? o.init : {};
    const conversationId = str(o.conversation_id) ?? str(init.conversation_id);
    return {
      kind: "init",
      ...(conversationId ? { conversationId } : {}),
      ...(str(init.model) ? { model: str(init.model) } : {}),
      ...(str(init.cwd) ? { cwd: str(init.cwd) } : {}),
      tools: Array.isArray(init.tools) ? init.tools.filter((t): t is string => typeof t === "string") : [],
      ...(str(init.permission_mode) ? { permissionMode: str(init.permission_mode) } : {}),
    };
  }

  if (event === "step_update") {
    const s = isObj(o.step_update) ? o.step_update : {};
    const info = isObj(s.tool_info) ? s.tool_info : undefined;
    const toolName = str(s.tool_name) ?? (info ? str(info.name) : undefined);
    return {
      kind: "step",
      stepIndex: num(s.step_index),
      state: str(s.state) ?? "",
      stepType: str(s.step_type) ?? "",
      ...(toolName ? { toolName } : {}),
      ...(info && isObj(info.parameters) ? { toolParams: info.parameters } : {}),
      ...(info && str(info.output) !== undefined ? { toolOutput: str(info.output) } : {}),
      ...(str(s.text_delta) !== undefined ? { textDelta: str(s.text_delta) } : {}),
      ...(s.usage ? { usage: usageOf(s.usage) } : {}),
    };
  }

  if (event === "result") {
    return isObj(o.result) ? { kind: "result", result: resultOf(o.result) } : null;
  }

  return { kind: "other", event };
}

/** Feeds growing stdout and yields whole-line events; never splits a line. */
export class StreamParser {
  private rest = "";

  push(chunk: string): StreamEvent[] {
    const lines = (this.rest + chunk).split("\n");
    this.rest = lines.pop() ?? "";
    return lines.map(parseLine).filter((e): e is StreamEvent => e !== null);
  }

  flush(): StreamEvent[] {
    const last = this.rest;
    this.rest = "";
    const ev = parseLine(last);
    return ev ? [ev] : [];
  }
}
