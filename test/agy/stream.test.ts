import { describe, it, expect } from "vitest";
import { StreamParser, parseLine, usageOf } from "../../src/agy/stream.js";

const CID = "79e99482-1b43-4003-999d-0137c0dd25cf";
const INIT = JSON.stringify({
  event: "init",
  conversation_id: CID,
  init: {
    model: "gemini-3.8-flash-high",
    cwd: "C:\\work\\repo",
    tools: ["view_file", "write_to_file"],
    permission_mode: "always-proceed",
  },
});
const TOOL_WRITE = JSON.stringify({
  event: "step_update",
  step_update: {
    conversation_id: CID,
    step_index: 72,
    state: "ACTIVE",
    step_type: "tool",
    tool_name: "write_to_file",
    tool_info: { name: "write_to_file", parameters: { TargetFile: "C:\\work\\repo\\src\\a.ts" } },
  },
});
const TOOL_CMD_DONE = JSON.stringify({
  event: "step_update",
  step_update: {
    conversation_id: CID,
    step_index: 12,
    state: "DONE",
    step_type: "tool",
    tool_name: "run_command",
    duration_seconds: 0.65,
    tool_info: {
      name: "run_command",
      parameters: { CommandLine: "git log -n 5 --oneline" },
      output: "abc123 init",
    },
  },
});
const RESPONSE = JSON.stringify({
  event: "step_update",
  step_update: {
    conversation_id: CID,
    step_index: 1,
    state: "DONE",
    step_type: "agent_response",
    text_delta: "hello",
    usage: {
      input_tokens: 16322,
      output_tokens: 312,
      thinking_tokens: 250,
      cache_read_tokens: 0,
      total_tokens: 16634,
    },
  },
});
const RESULT = JSON.stringify({
  event: "result",
  result: {
    conversation_id: CID,
    status: "SUCCESS",
    response: "",
    duration_seconds: 883.87,
    num_turns: 1,
    usage: {
      input_tokens: 346400,
      output_tokens: 115067,
      thinking_tokens: 47803,
      cache_read_tokens: 7868742,
      total_tokens: 461467,
    },
  },
});

describe("parseLine", () => {
  it("parses init", () => {
    expect(parseLine(INIT)).toEqual({
      kind: "init",
      conversationId: CID,
      model: "gemini-3.8-flash-high",
      cwd: "C:\\work\\repo",
      tools: ["view_file", "write_to_file"],
      permissionMode: "always-proceed",
    });
  });
  it("parses tool steps with parameters", () => {
    expect(parseLine(TOOL_WRITE)).toEqual({
      kind: "step",
      stepIndex: 72,
      state: "ACTIVE",
      stepType: "tool",
      toolName: "write_to_file",
      toolParams: { TargetFile: "C:\\work\\repo\\src\\a.ts" },
    });
    expect(parseLine(TOOL_CMD_DONE)).toMatchObject({
      toolName: "run_command",
      toolOutput: "abc123 init",
    });
  });
  it("parses agent responses with usage", () => {
    expect(parseLine(RESPONSE)).toMatchObject({
      stepType: "agent_response",
      textDelta: "hello",
      usage: { inputTokens: 16322, totalTokens: 16634 },
    });
  });
  it("parses the result envelope", () => {
    expect(parseLine(RESULT)).toEqual({
      kind: "result",
      result: {
        conversationId: CID,
        status: "SUCCESS",
        response: "",
        durationSec: 883.87,
        numTurns: 1,
        usage: {
          inputTokens: 346400,
          outputTokens: 115067,
          thinkingTokens: 47803,
          cacheReadTokens: 7868742,
          totalTokens: 461467,
        },
      },
    });
  });
  it("returns null for non-JSON and objects without event", () => {
    expect(parseLine("[agy] something")).toBeNull();
    expect(parseLine("{}")).toBeNull();
  });
  it("keeps unknown events as other", () => {
    expect(parseLine('{"event":"future_thing"}')).toEqual({ kind: "other", event: "future_thing" });
  });
});

describe("StreamParser", () => {
  it("handles lines split across chunks and CRLF", () => {
    const p = new StreamParser();
    const half = Math.floor(INIT.length / 2);
    expect(p.push(INIT.slice(0, half))).toEqual([]);
    const evs = p.push(INIT.slice(half) + "\r\n" + RESULT + "\n");
    expect(evs.map((e) => e.kind)).toEqual(["init", "result"]);
  });
  it("flushes a final line without newline", () => {
    const p = new StreamParser();
    p.push(RESULT);
    expect(p.flush().map((e) => e.kind)).toEqual(["result"]);
  });
});

describe("usageOf", () => {
  it("defaults missing numbers to 0", () => {
    expect(usageOf({ input_tokens: 5 })).toEqual({
      inputTokens: 5,
      outputTokens: 0,
      thinkingTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
    });
    expect(usageOf(undefined).totalTokens).toBe(0);
  });
});
