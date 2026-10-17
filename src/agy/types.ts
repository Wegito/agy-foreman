export interface AgyUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

export const EMPTY_USAGE: AgyUsage = {
  inputTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
};

export interface AgyResult {
  conversationId?: string;
  status: string;
  response: string;
  error?: string;
  durationSec: number;
  numTurns: number;
  usage: AgyUsage;
  structuredOutput?: unknown;
}

export type StreamEvent =
  | {
      kind: "init";
      conversationId?: string;
      model?: string;
      cwd?: string;
      tools: string[];
      permissionMode?: string;
    }
  | {
      kind: "step";
      stepIndex: number;
      state: string;
      stepType: string;
      toolName?: string;
      toolParams?: Record<string, unknown>;
      toolOutput?: string;
      textDelta?: string;
      usage?: AgyUsage;
    }
  | { kind: "result"; result: AgyResult }
  | { kind: "other"; event: string };

export type Outcome =
  | {
      type: "success";
      response: string;
      conversationId?: string;
      usage: AgyUsage;
      durationSec: number;
      structuredOutput?: unknown;
    }
  | { type: "quota"; resetInSec?: number; resetText?: string; conversationId?: string }
  | { type: "denied"; detail: string; conversationId?: string }
  | { type: "timeout"; partialResponse: string; conversationId?: string }
  | { type: "guard_violation"; reason: string; event: StreamEvent; conversationId?: string }
  | { type: "cancelled"; conversationId?: string }
  | { type: "error"; message: string; exitCode: number | null; conversationId?: string };
