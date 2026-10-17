import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { killTree, treeSpawnOptions } from "../agy/kill.js";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const WIN_DIRECT = new Set(["git", "node", "python", "py", "go", "cargo", "make", "taskkill"]);

/** True for commands that are .cmd/.bat shims on Windows (npm, npx, pnpm, yarn, …). */
export function needsWindowsShell(cmd: string): boolean {
  const base = cmd.replace(/^.*[\\/]/, "").toLowerCase();
  if (/\.(cmd|bat)$/.test(base)) return true;
  if (/\.exe$/.test(base)) return false;
  return !WIN_DIRECT.has(base) && !path.isAbsolute(cmd);
}

export function quoteWinArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

const MAX_BYTES = 2 * 1024 * 1024;

export function runCommand(
  argv: string[],
  opts: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    // Only .cmd/.bat shims (npm, npx, …) need cmd.exe on Windows. Real executables like git are
    // spawned directly: cmd.exe would cut multi-line arguments (commit messages) at the newline.
    const useShell = process.platform === "win32" && needsWindowsShell(argv[0]);
    const child = useShell
      ? spawn(argv.map(quoteWinArg).join(" "), {
          shell: true,
          cwd: opts.cwd,
          env: opts.env,
          windowsHide: true,
        })
      : spawn(argv[0], argv.slice(1), {
          cwd: opts.cwd,
          env: opts.env,
          ...treeSpawnOptions(),
          windowsHide: true,
        });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;
    let settled = false;

    function finish(code: number | null) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    }

    child.stdin?.end();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes < MAX_BYTES) {
        const take = Math.min(chunk.length, MAX_BYTES - stdoutBytes);
        stdout += chunk.subarray(0, take).toString("utf8");
        stdoutBytes += chunk.length;
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes < MAX_BYTES) {
        const take = Math.min(chunk.length, MAX_BYTES - stderrBytes);
        stderr += chunk.subarray(0, take).toString("utf8");
        stderrBytes += chunk.length;
      }
    });

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(async () => {
        timedOut = true;
        if (child.pid) {
          await killTree(child.pid);
        }
        setTimeout(() => {
          finish(child.exitCode ?? null);
        }, 2000).unref();
      }, opts.timeoutMs);
    }

    child.on("error", (err) => {
      stderr += String(err.message ?? err);
      finish(null);
    });

    child.on("close", (code) => {
      finish(code);
    });
  });
}

export class GitError extends Error {
  readonly code: number | null;
  readonly stderr: string;

  constructor(message: string, code: number | null, stderr: string) {
    super(message);
    this.name = "GitError";
    this.code = code;
    this.stderr = stderr;
  }
}

let emptyHooksDir: string | null = null;

function getEmptyHooksDir(): string {
  if (!emptyHooksDir) {
    emptyHooksDir = mkdtempSync(path.join(os.tmpdir(), "agyo-empty-hooks-"));
  }
  return emptyHooksDir;
}

export async function git(args: string[], cwd: string): Promise<string> {
  const hooksDir = getEmptyHooksDir();
  const res = await runCommand(["git", "-c", `core.hooksPath=${hooksDir}`, ...args], { cwd });
  if (res.code !== 0) {
    throw new GitError(
      `git ${args.join(" ")} failed with exit code ${res.code}: ${res.stderr}`,
      res.code,
      res.stderr,
    );
  }
  return res.stdout.trim();
}
