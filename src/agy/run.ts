import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Effort } from "../config.js";
import { classify } from "./classify.js";
import { killTree as nodeKillTree, treeSpawnOptions } from "./kill.js";
import { detectQuota } from "./quota.js";
import { StreamParser } from "./stream.js";
import type { AgyResult, Outcome, StreamEvent } from "./types.js";

export const MAX_PROMPT_CHARS = 8000;
const MAX_STDERR = 1024 * 1024;

export interface RunRequest {
  prompt: string;
  cwd: string;
  model: string;
  effort?: Effort;
  mode?: "accept-edits" | "plan";
  timeoutSec: number;
  conversationId?: string;
  jsonSchemaPath?: string;
  addDirs?: string[];
  skipPermissions?: boolean;
  sandbox?: boolean;
  agy: { command: string; prefixArgs?: string[] };
  signal?: AbortSignal;
  guard?: (ev: StreamEvent) => string | null;
}

export interface RunDeps {
  spawn: typeof nodeSpawn;
  killTree: (pid: number) => Promise<void>;
  makeLogPath: () => string;
  readLog: (path: string) => Promise<string>;
  removeLog: (path: string) => Promise<void>;
  pollMs: number;
  graceSec: number;
}

const defaultDeps: RunDeps = {
  spawn: nodeSpawn,
  killTree: (pid) => nodeKillTree(pid),
  // Private per-run temp dir: agy's log contains the account email.
  makeLogPath: () => path.join(mkdtempSync(path.join(os.tmpdir(), "foreman-")), "agy.log"),
  readLog: async (p) => {
    try {
      return await readFile(p, "utf8");
    } catch {
      return "";
    }
  },
  removeLog: async (p) => {
    await rm(path.dirname(p).includes("foreman-") ? path.dirname(p) : p, {
      recursive: true,
      force: true,
    });
  },
  pollMs: 1000,
  graceSec: 15,
};

export function buildArgs(req: RunRequest, logPath: string): string[] {
  const a = [
    "-p",
    req.prompt,
    "--output-format",
    "stream-json",
    "--model",
    req.model,
    "--print-timeout",
    `${req.timeoutSec}s`,
    "--log-file",
    logPath,
  ];
  if (req.effort) a.push("--effort", req.effort);
  if (req.mode) a.push("--mode", req.mode);
  if (req.conversationId) a.push("--conversation", req.conversationId);
  if (req.jsonSchemaPath) a.push("--json-schema", req.jsonSchemaPath);
  for (const d of req.addDirs ?? []) a.push("--add-dir", d);
  if (req.sandbox) a.push("--sandbox");
  if (req.skipPermissions) a.push("--dangerously-skip-permissions");
  return a;
}

export async function run(
  req: RunRequest,
  onEvent?: (ev: StreamEvent) => void,
  overrides: Partial<RunDeps> = {},
): Promise<Outcome> {
  if (req.prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(
      `prompt too long (${req.prompt.length} > ${MAX_PROMPT_CHARS} chars); put the brief in a file`,
    );
  }
  const d: RunDeps = { ...defaultDeps, ...overrides };
  const logPath = d.makeLogPath();
  const args = [...(req.agy.prefixArgs ?? []), ...buildArgs(req, logPath)];

  try {
    return await new Promise<Outcome>((resolve) => {
      const parser = new StreamParser();
      let stderr = "";
      let conversationId: string | undefined;
      let result: AgyResult | undefined;
      let settled = false;
      let watchdogFired = false;
      const timers: NodeJS.Timeout[] = [];

      const child = d.spawn(req.agy.command, args, {
        cwd: req.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        ...treeSpawnOptions(),
      });
      child.stdin?.end();

      const stopTimers = () => timers.forEach((t) => clearTimeout(t));
      const finish = (o: Outcome) => {
        if (settled) return;
        settled = true;
        stopTimers();
        clearInterval(poller);
        req.signal?.removeEventListener("abort", onAbort);
        resolve(o);
      };
      const kill = () => {
        if (child.pid !== undefined) void d.killTree(child.pid).catch(() => {});
      };
      const cidOf = <T extends object>(o: T) => (conversationId ? { ...o, conversationId } : o);

      const handle = (ev: StreamEvent) => {
        if (ev.kind === "init" && ev.conversationId) conversationId = ev.conversationId;
        if (ev.kind === "result") result = ev.result;
        onEvent?.(ev);
        const reason = req.guard?.(ev);
        if (reason && !settled) {
          kill();
          finish(cidOf({ type: "guard_violation" as const, reason, event: ev }));
        }
      };

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => parser.push(chunk).forEach(handle));
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        if (stderr.length < MAX_STDERR) stderr += chunk;
      });

      let polling = false;
      const poller = setInterval(async () => {
        if (polling || settled) return;
        polling = true;
        try {
          const q = detectQuota(await d.readLog(logPath));
          if (q && !settled) {
            kill();
            finish(
              cidOf({
                type: "quota" as const,
                ...(q.resetSeconds !== undefined ? { resetInSec: q.resetSeconds } : {}),
                ...(q.resetText ? { resetText: q.resetText } : {}),
              }),
            );
          }
        } finally {
          polling = false;
        }
      }, d.pollMs);

      timers.push(
        setTimeout(
          () => {
            watchdogFired = true;
            kill();
            finish(cidOf({ type: "timeout" as const, partialResponse: result?.response ?? "" }));
          },
          (req.timeoutSec + d.graceSec) * 1000,
        ),
      );

      const onAbort = () => {
        kill();
        finish(cidOf({ type: "cancelled" as const }));
      };
      if (req.signal?.aborted) onAbort();
      req.signal?.addEventListener("abort", onAbort, { once: true });

      let exitCode: number | null = null;
      const conclude = async (spawnError?: NodeJS.ErrnoException) => {
        if (settled) return;
        parser.flush().forEach(handle);
        if (settled) return;
        finish(
          classify({
            exitCode,
            ...(spawnError ? { spawnError } : {}),
            stderr,
            log: await d.readLog(logPath),
            ...(result ? { result } : {}),
            ...(conversationId ? { conversationId } : {}),
            watchdogFired,
            agyCommand: req.agy.command,
          }),
        );
      };
      child.on("error", (e) => void conclude(e as NodeJS.ErrnoException));
      child.on("exit", (code) => {
        exitCode = code;
        // Grandchildren can hold pipes open; don't wait forever for "close".
        const t = setTimeout(() => void conclude(), 2000);
        t.unref();
        timers.push(t);
      });
      child.on("close", (code) => {
        exitCode = code ?? exitCode;
        void conclude();
      });
    });
  } finally {
    await d.removeLog(logPath).catch(() => {});
  }
}
