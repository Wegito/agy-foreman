import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  run,
  buildArgs,
  modelFor,
  MAX_PROMPT_CHARS,
  type RunRequest,
} from "../../src/agy/index.js";
import { isAlive } from "../../src/agy/kill.js";
import type { StreamEvent } from "../../src/agy/types.js";
import { fixture, waitFor } from "../helpers.js";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "foreman-run-"));

function req(
  scenario: string,
  extra: Partial<RunRequest> = {},
  env: Record<string, string> = {},
): RunRequest {
  Object.assign(process.env, { FAKE_AGY_SCENARIO: scenario, ...env });
  return {
    prompt: "Execute the task described in .agy-task/brief.md.",
    cwd: tmp(),
    model: "gemini-3.8-flash-high",
    timeoutSec: 20,
    agy: { command: process.execPath, prefixArgs: [fixture("fake-agy.mjs")] },
    ...extra,
  };
}
const fast = { pollMs: 50, graceSec: 1 };

describe("buildArgs", () => {
  it("always includes stream-json, print-timeout and log-file, and no permission bypass by default", () => {
    const a = buildArgs(
      req("success", { effort: "medium", mode: "accept-edits", conversationId: "c9" }),
      "/tmp/l.log",
    );
    expect(a).toEqual([
      "-p",
      "Execute the task described in .agy-task/brief.md.",
      "--output-format",
      "stream-json",
      "--model",
      "gemini-3.8-flash-medium",
      "--print-timeout",
      "20s",
      "--log-file",
      "/tmp/l.log",
      "--mode",
      "accept-edits",
      "--conversation",
      "c9",
    ]);
    expect(a).not.toContain("--dangerously-skip-permissions");
  });
  // Regression (found live): agy rejects --effort next to a model name that already carries one
  // ("--model gemini-3.8-flash-high conflicts with --effort=low"). Effort picks the model variant.
  it("selects the effort through the model name and never passes --effort", () => {
    expect(modelFor("gemini-3.8-flash-high", "low")).toBe("gemini-3.8-flash-low");
    expect(modelFor("gemini-3.8-flash-low", undefined)).toBe("gemini-3.8-flash-low");
    expect(modelFor("gemini-3.8-flash", "high")).toBe("gemini-3.8-flash-high");
    const a = buildArgs(req("success", { effort: "low" }), "l");
    expect(a).not.toContain("--effort");
    expect(a[a.indexOf("--model") + 1]).toBe("gemini-3.8-flash-low");
  });
  it("adds opt-in flags", () => {
    const a = buildArgs(
      req("success", {
        skipPermissions: true,
        sandbox: true,
        addDirs: ["/x"],
        jsonSchemaPath: "s.json",
      }),
      "l",
    );
    expect(a).toEqual(
      expect.arrayContaining([
        "--dangerously-skip-permissions",
        "--sandbox",
        "--add-dir",
        "/x",
        "--json-schema",
        "s.json",
      ]),
    );
  });
});

describe("run", () => {
  it("returns success with events streamed to onEvent", async () => {
    const events: StreamEvent[] = [];
    const o = await run(req("success"), (e) => events.push(e), fast);
    expect(o).toMatchObject({
      type: "success",
      response: "done",
      conversationId: "fake-0000-conversation",
    });
    expect(events.map((e) => e.kind)).toEqual(["init", "step", "step", "step", "result"]);
  });

  it("closes stdin so agy does not hang", async () => {
    const o = await run(req("needs-closed-stdin", { timeoutSec: 5 }), undefined, fast);
    expect(o).toMatchObject({ type: "success", response: "stdin closed" });
  });

  it("passes the args it built to agy", async () => {
    const argsFile = path.join(tmp(), "args.json");
    await run(req("success", {}, { FAKE_AGY_ARGSFILE: argsFile }), undefined, fast);
    const argv = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    expect(argv).toContain("--print-timeout");
    expect(argv).toContain("stream-json");
    delete process.env.FAKE_AGY_ARGSFILE;
  });

  it("detects quota in the log, kills agy promptly, and returns the reset time", async () => {
    const started = Date.now();
    const o = await run(req("quota-hang", { timeoutSec: 60 }), undefined, fast);
    expect(o).toMatchObject({ type: "quota", resetInSec: 7985, resetText: "2h13m5s" });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it("detects quota when agy exits 0 with an empty response", async () => {
    expect(await run(req("quota-exit"), undefined, fast)).toMatchObject({
      type: "quota",
      resetInSec: 30,
    });
  });

  it("maps the print-timeout notice to timeout", async () => {
    expect(await run(req("print-timeout"), undefined, fast)).toMatchObject({ type: "timeout" });
  });

  it("maps a soft deny to denied", async () => {
    expect(await run(req("soft-deny"), undefined, fast)).toMatchObject({ type: "denied" });
  });

  it("maps status ERROR to error", async () => {
    expect(await run(req("error"), undefined, fast)).toMatchObject({
      type: "error",
      message: "invalid model selection",
    });
  });

  it("fires the watchdog on a hang", async () => {
    const o = await run(req("hang", { timeoutSec: 1 }), undefined, { pollMs: 50, graceSec: 0 });
    expect(o).toMatchObject({ type: "timeout" });
  }, 15_000);

  it("cancels on abort and kills the whole tree", async () => {
    const pidFile = path.join(tmp(), "gc.pid");
    const ac = new AbortController();
    const p = run(
      req("grandchild-hang", { timeoutSec: 60, signal: ac.signal }, { FAKE_AGY_PIDFILE: pidFile }),
      undefined,
      fast,
    );
    expect(await waitFor(() => existsSync(pidFile), 5000)).toBe(true);
    const gc = Number(readFileSync(pidFile, "utf8"));
    ac.abort();
    expect(await p).toMatchObject({ type: "cancelled" });
    expect(await waitFor(() => !isAlive(gc), 8000)).toBe(true);
    delete process.env.FAKE_AGY_PIDFILE;
  }, 20_000);

  it("kills immediately when the guard returns a reason", async () => {
    const guard = (e: StreamEvent) =>
      e.kind === "step" &&
      e.toolName === "write_to_file" &&
      String(e.toolParams?.TargetFile).startsWith("tests/")
        ? "write to protected path tests/a.test.ts"
        : null;
    const o = await run(req("write-event-hang", { timeoutSec: 60, guard }), undefined, fast);
    expect(o).toMatchObject({
      type: "guard_violation",
      reason: "write to protected path tests/a.test.ts",
    });
  }, 20_000);

  it("reports a missing binary", async () => {
    const o = await run(
      { ...req("success"), agy: { command: "definitely-not-agy-xyz" } },
      undefined,
      fast,
    );
    expect(o).toMatchObject({ type: "error", message: expect.stringMatching(/not found/) });
  });

  it("rejects prompts over the limit before spawning", async () => {
    await expect(
      run({ ...req("success"), prompt: "x".repeat(MAX_PROMPT_CHARS + 1) }),
    ).rejects.toThrow(/prompt too long/);
  });

  it("deletes the log file afterwards", async () => {
    const logPath = path.join(tmp(), "agy.log");
    await run(req("success"), undefined, { ...fast, makeLogPath: () => logPath });
    expect(existsSync(logPath)).toBe(false);
  });
});
