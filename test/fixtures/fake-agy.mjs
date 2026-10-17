// Scenario-driven stand-in for `agy -p ... --output-format stream-json`.
// Event shapes copied from a live agy 1.4.0 run. Inspired by claude-agy-mcp's fake-agy (MIT, (c) 2026 elkaix).
import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const scenario = process.env.FAKE_AGY_SCENARIO ?? "success";
const logFile = flag("--log-file");
const model = flag("--model") ?? "gemini-3.8-flash-high";
const cid = flag("--conversation") ?? "fake-0000-conversation";

if (process.env.FAKE_AGY_ARGSFILE)
  writeFileSync(process.env.FAKE_AGY_ARGSFILE, JSON.stringify(args));

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const log = (line) => logFile && appendFileSync(logFile, line + "\n");
const usage = {
  input_tokens: 1200,
  output_tokens: 80,
  thinking_tokens: 20,
  cache_read_tokens: 900,
  total_tokens: 1280,
};
const hang = () => setInterval(() => {}, 1000);

const init = () =>
  out({
    event: "init",
    conversation_id: cid,
    init: {
      model,
      cwd: process.cwd(),
      tools: ["view_file", "write_to_file", "run_command"],
      permission_mode: "request-review",
    },
  });
const step = (i, extra) =>
  out({
    event: "step_update",
    step_update: { conversation_id: cid, step_index: i, state: "DONE", ...extra },
  });
const result = (status, response, extra = {}) =>
  out({
    event: "result",
    result: {
      conversation_id: cid,
      status,
      response,
      duration_seconds: 1.5,
      num_turns: 1,
      usage,
      ...extra,
    },
  });

log("I1017 12:08:01.243347 server.go:1743] Language server version: 1.4.0 (fake)");

function main() {
  switch (scenario) {
    case "success":
      init();
      step(0, { step_type: "user_input" });
      step(1, {
        step_type: "tool",
        tool_name: "view_file",
        tool_info: {
          name: "view_file",
          parameters: { AbsolutePath: "src/a.ts" },
          output: "10 lines",
        },
      });
      step(2, { step_type: "agent_response", text_delta: "done", usage });
      result("SUCCESS", "done");
      return;
    case "quota-hang":
      init();
      log(
        "E1017 12:09:00.000000 log.go:398] agent executor error: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 2h13m5s.",
      );
      hang();
      return;
    case "quota-exit":
      init();
      log(
        "E1017 12:09:00.000000 log.go:398] agent executor error: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 30s.",
      );
      result("SUCCESS", "");
      return;
    case "print-timeout":
      init();
      process.stderr.write(
        "[agy] print timeout after 1s with turn in progress; returning partial output\n",
      );
      result("SUCCESS", "");
      return;
    case "soft-deny":
      init();
      process.stderr.write(
        "tool run_command requires permission; denied in print mode. Add command(npm) to permissions.allow\n",
      );
      result("SUCCESS", "");
      return;
    case "error":
      init();
      result("ERROR", "", { error: "invalid model selection" });
      process.exitCode = 1;
      return;
    case "hang":
      init();
      hang();
      return;
    case "grandchild-hang": {
      init();
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      if (process.env.FAKE_AGY_PIDFILE)
        writeFileSync(process.env.FAKE_AGY_PIDFILE, String(child.pid));
      hang();
      return;
    }
    case "write-event-hang":
      init();
      out({
        event: "step_update",
        step_update: {
          conversation_id: cid,
          step_index: 3,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "write_to_file",
          tool_info: {
            name: "write_to_file",
            parameters: { TargetFile: process.env.FAKE_AGY_WRITE ?? "tests/a.test.ts" },
          },
        },
      });
      hang();
      return;
    default:
      process.stderr.write(`fake-agy: unknown scenario ${scenario}\n`);
      process.exitCode = 3;
  }
}

if (scenario === "needs-closed-stdin") {
  // Real agy reads stdin until EOF even in print mode; an open stdin hangs it.
  process.stdin.resume();
  process.stdin.on("end", () => {
    init();
    result("SUCCESS", "stdin closed");
  });
} else {
  main();
}
