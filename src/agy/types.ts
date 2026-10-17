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
  | { kind: "init"; conversationId?: string; model?: string; cwd?: string; tools: string[]; permissionMode?: string }
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
