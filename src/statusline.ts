import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isTerminal, type JobRecord } from "./jobs/store.js";
import { runCommand } from "./pipeline/exec.js";

/** Finished jobs stay visible in the status line for this long. */
export const RECENT_MS = 15 * 60_000;
const BAR_CELLS = 12;

const ansi = (code: string, s: string, color: boolean) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function bar(percent: number, color: boolean): string {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * BAR_CELLS);
  return ansi("32", "█".repeat(filled), color) + ansi("2", "░".repeat(BAR_CELLS - filled), color);
}

const STATE_ICON: Record<string, [string, string]> = {
  passed: ["✓", "32"],
  failed: ["✗", "31"],
  guard_violation: ["⛔", "31"],
  quota: ["⏸", "33"],
  refused: ["–", "33"],
  timeout: ["⌛", "33"],
  cancelled: ["–", "2"],
  error: ["!", "31"],
};

/**
 * One status-line row: the active job with a bar, % (no time estimate), phase, task title,
 * checklist step and elapsed time; or the last job if it finished recently; or "" when idle.
 */
export function renderStatusLine(
  jobs: JobRecord[],
  now: Date,
  o: { color?: boolean } = {},
): string {
  const color = o.color ?? true;
  const label = ansi("1;35", "agy", color);
  const active = jobs
    .filter((j) => !isTerminal(j.state))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  if (active.length > 0) {
    const j = active.find((a) => a.state === "running") ?? active[0];
    const others = active.length - 1;
    if (j.state === "queued") {
      return `${label} ${ansi("2", "queued", color)} · ${ansi("1", `"${truncate(j.title, 48)}"`, color)}`;
    }
    const p = j.progress;
    const parts = [
      `${label} ${bar(p.percent, color)} ${ansi("1", `${p.percent}%`, color)}`,
      ansi("36", p.phase, color),
      ansi("1", `"${truncate(j.title, 48)}"`, color),
    ];
    if (p.checklistTotal > 0) parts.push(`step ${p.checklistDone}/${p.checklistTotal}`);
    parts.push(formatElapsed(now.getTime() - Date.parse(j.createdAt)));
    if (others > 0) parts.push(ansi("2", `+${others} more`, color));
    return parts.join(" · ");
  }

  const last = jobs
    .filter((j) => now.getTime() - Date.parse(j.updatedAt) <= RECENT_MS)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!last) return "";
  const [icon, code] = STATE_ICON[last.state] ?? ["•", "2"];
  const took = formatElapsed(Date.parse(last.updatedAt) - Date.parse(last.createdAt));
  const ago = formatElapsed(now.getTime() - Date.parse(last.updatedAt));
  return `${label} ${ansi(code, `${icon} ${last.state}`, color)} · ${ansi("1", `"${truncate(last.title, 48)}"`, color)} · took ${took} · ${ago} ago`;
}

/** Reads the newest job records (ids start with a time component, so name order ≈ age). */
export async function recentJobs(dir: string, limit = 20): Promise<JobRecord[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  names.sort().reverse();
  const out: JobRecord[] = [];
  for (const n of names.slice(0, limit)) {
    try {
      out.push(JSON.parse(await readFile(path.join(dir, n), "utf8")) as JobRecord);
    } catch {
      // a half-written or foreign file: skip it
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Installing into Claude Code settings

export interface StatusLineSetting {
  type: "command";
  command: string;
  padding?: number;
}

export function claudeSettingsPath(env: NodeJS.ProcessEnv): string {
  if (env.AGYO_CLAUDE_SETTINGS) return env.AGYO_CLAUDE_SETTINGS;
  const home = env.USERPROFILE || env.HOME || os.homedir();
  return path.join(home, ".claude", "settings.json");
}

/** Command Claude Code runs; forward slashes and quotes work in both cmd.exe and bash. */
export function statusLineCommand(entry: string): string {
  return `node "${entry.replace(/\\/g, "/")}" statusline`;
}

export function isOurs(setting: StatusLineSetting | undefined): boolean {
  return (
    !!setting?.command &&
    /agy-orchestrator|statusline$/.test(setting.command) &&
    setting.command.includes("statusline")
  );
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`cannot parse ${file}: ${(e as Error).message}`);
  }
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await rename(tmp, file);
}

export type InstallResult =
  | { state: "installed"; settings: string }
  | { state: "wrapped"; settings: string; previous: string }
  | { state: "already_installed"; settings: string };

/**
 * Sets Claude Code's statusLine to ours. An existing, different status line is kept: its command
 * is saved to `wrapFile` and printed before ours on the same line.
 */
export async function installStatusLine(o: {
  settingsFile: string;
  wrapFile: string;
  entry: string;
}): Promise<InstallResult> {
  const settings = await readJson(o.settingsFile);
  const current = settings.statusLine as StatusLineSetting | undefined;
  if (isOurs(current)) return { state: "already_installed", settings: o.settingsFile };
  const ours: StatusLineSetting = {
    type: "command",
    command: statusLineCommand(o.entry),
    padding: 0,
  };
  if (current?.command) {
    await writeJsonAtomic(o.wrapFile, { previous: current });
    await writeJsonAtomic(o.settingsFile, { ...settings, statusLine: ours });
    return { state: "wrapped", settings: o.settingsFile, previous: current.command };
  }
  await writeJsonAtomic(o.settingsFile, { ...settings, statusLine: ours });
  return { state: "installed", settings: o.settingsFile };
}

/** Restores the previous status line (or removes ours). */
export async function uninstallStatusLine(o: {
  settingsFile: string;
  wrapFile: string;
}): Promise<"restored" | "removed" | "not_installed"> {
  const settings = await readJson(o.settingsFile);
  if (!isOurs(settings.statusLine as StatusLineSetting | undefined)) return "not_installed";
  const wrap = existsSync(o.wrapFile)
    ? ((await readJson(o.wrapFile)).previous as StatusLineSetting | undefined)
    : undefined;
  const { statusLine: _ours, ...rest } = settings;
  await writeJsonAtomic(o.settingsFile, wrap ? { ...rest, statusLine: wrap } : rest);
  return wrap ? "restored" : "removed";
}

/** Runs the wrapped (previous) status line command with the same stdin, if one was saved. */
export async function previousStatusLine(
  wrapFile: string,
  stdin: string,
  cwd: string,
): Promise<string> {
  if (!existsSync(wrapFile)) return "";
  const prev = (await readJson(wrapFile)).previous as StatusLineSetting | undefined;
  if (!prev?.command) return "";
  const shell =
    process.platform === "win32"
      ? ["cmd.exe", "/d", "/s", "/c", prev.command]
      : ["sh", "-c", prev.command];
  const r = await runCommand(shell, {
    cwd,
    timeoutMs: 2000,
    env: { ...process.env, AGYO_STDIN: stdin },
  });
  return r.code === 0 ? (r.stdout.trim().split(/\r?\n/)[0] ?? "") : "";
}
