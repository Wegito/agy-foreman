import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isTerminal, type JobRecord } from "./jobs/store.js";
import { runCommand } from "./pipeline/exec.js";

/** Finished jobs stay visible in the status line for this long. */
export const RECENT_MS = 15 * 60_000;
const BAR_CELLS = 16;

const ansi = (code: string, s: string, color: boolean) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);

/** Plain-text title: drops Markdown emphasis and code ticks from plan headings. */
export function cleanTitle(title: string): string {
  return title
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/^task\s+\d+[:.]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 412 → "412", 31_200 → "31k", 1_250_000 → "1.3M". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

const PHASE_LABEL: Record<string, string> = {
  queued: "queued",
  awaiting_approval: "waiting for approval",
  prepare: "preparing worktree",
  contract: "checking contract tests",
  brief: "writing brief",
  run: "running",
  verify: "verifying",
  report: "committing",
};

interface Segment {
  text: string;
  plain: string;
  /** Lower is dropped first when the row is too wide. */
  keep: number;
  /** Returns a shorter version (at most `max` visible chars) instead of dropping this segment. */
  shrink?: (max: number) => Segment;
}

const seg = (plain: string, text: string, keep: number): Segment => ({ plain, text, keep });

function fit(segments: Segment[], columns: number, sep: string, sepPlain: string): string {
  const parts = [...segments];
  const width = () =>
    parts.reduce((w, s) => w + s.plain.length, 0) + sepPlain.length * (parts.length - 1);
  // Drop optional segments (keep < 80) first, weakest first.
  while (width() > columns) {
    const optional = parts.map((s, i) => [s, i] as const).filter(([s]) => s.keep < 80);
    if (optional.length === 0) break;
    const [, weakest] = optional.reduce((m, x) => (x[0].keep < m[0].keep ? x : m));
    parts.splice(weakest, 1);
  }
  // Then shorten shrinkable segments (the title) before giving up on them.
  for (let i = 0; i < parts.length && width() > columns; i++) {
    const s = parts[i];
    if (!s.shrink) continue;
    const room = s.plain.length - (width() - columns);
    parts[i] = room >= 8 ? s.shrink(room) : s;
    if (room < 8) parts.splice(i--, 1);
  }
  return parts.map((s) => s.text).join(sep);
}

function planTokens(jobs: JobRecord[], j: JobRecord): number | undefined {
  if (!j.plan) return undefined;
  const same = jobs.filter((x) => x.plan?.file === j.plan?.file);
  if (same.length < 2) return undefined;
  return same.reduce(
    (sum, x) => sum + (x.envelope?.usage?.totalTokens ?? x.progress.tokens ?? 0),
    0,
  );
}

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
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}

function bar(percent: number, color: boolean): string {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * BAR_CELLS);
  return (
    ansi("32", "━".repeat(filled), color) + ansi("2;37", "─".repeat(BAR_CELLS - filled), color)
  );
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
 * One status-line row. Running: label, thin bar, %, plan step + title, current checklist task
 * (or phase), elapsed time, tokens for the job and the plan. No time estimate, on purpose.
 * Finished within RECENT_MS: outcome summary. Idle: "". Fits `columns` by dropping the least
 * important segments first.
 */
export function renderStatusLine(
  jobs: JobRecord[],
  now: Date,
  o: { color?: boolean; columns?: number } = {},
): string {
  const color = o.color ?? true;
  const columns = Math.max(40, o.columns ?? 200);
  const dim = (s: string) => ansi("2", s, color);
  const sep = dim("  ·  ");
  const sepPlain = "  ·  ";
  const label = seg("agy", ansi("1;35", "agy", color), 100);
  const titleSeg = (j: JobRecord, max: number): Segment => {
    const num = j.plan ? `#${j.plan.step} ` : "";
    const t = truncate(cleanTitle(j.title), Math.max(1, max - num.length));
    return { ...seg(num + t, dim(num) + ansi("1", t, color), 80), shrink: (m) => titleSeg(j, m) };
  };
  const tokensSeg = (j: JobRecord, used: number) => {
    const plan = planTokens(jobs, j);
    const own = `${formatTokens(used)} tok`;
    return [
      seg(own, dim(own), 40),
      ...(plan !== undefined
        ? [seg(`plan ${formatTokens(plan)}`, dim(`plan ${formatTokens(plan)}`), 20)]
        : []),
    ];
  };

  const active = jobs
    .filter((j) => !isTerminal(j.state))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  if (active.length > 0) {
    const j = active.find((a) => a.state === "running") ?? active[0];
    const others = active.length - 1;
    if (j.state === "queued") {
      return fit(
        [label, seg("queued", ansi("33", "queued", color), 90), titleSeg(j, 48)],
        columns,
        sep,
        sepPlain,
      );
    }
    const p = j.progress;
    const head = `${bar(p.percent, color)} ${ansi("1", `${String(p.percent).padStart(2)}%`, color)}`;
    const headPlain = `${"━".repeat(BAR_CELLS)} ${String(p.percent).padStart(2)}%`;
    const segments: Segment[] = [
      seg(`agy ${headPlain}`, `${label.text} ${head}`, 100),
      titleSeg(j, 44),
    ];
    if (p.phase === "run" && p.checklistTotal > 0) {
      const count = `${Math.min(p.checklistDone + 1, p.checklistTotal)}/${p.checklistTotal}`;
      const task = p.currentStep ? truncate(cleanTitle(p.currentStep), 40) : "";
      segments.push(
        seg(
          `› ${count}${task ? " " + task : ""}`,
          `${dim("›")} ${ansi("36", count, color)}${task ? " " + task : ""}`,
          70,
        ),
      );
    } else {
      const phase = PHASE_LABEL[p.phase] ?? p.phase;
      segments.push(seg(`› ${phase}`, `${dim("›")} ${ansi("36", phase, color)}`, 70));
    }
    const elapsed = formatElapsed(now.getTime() - Date.parse(j.createdAt));
    segments.push(seg(elapsed, elapsed, 60), ...tokensSeg(j, p.tokens));
    if (others > 0) segments.push(seg(`+${others} more`, dim(`+${others} more`), 10));
    return fit(segments, columns, sep, sepPlain);
  }

  const last = jobs
    .filter((j) => now.getTime() - Date.parse(j.updatedAt) <= RECENT_MS)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!last) return "";
  const [icon, code] = STATE_ICON[last.state] ?? ["•", "2"];
  const took = formatElapsed(Date.parse(last.updatedAt) - Date.parse(last.createdAt));
  const ago = formatElapsed(now.getTime() - Date.parse(last.updatedAt));
  const used = last.envelope?.usage?.totalTokens ?? last.progress.tokens;
  return fit(
    [
      seg(
        `agy ${icon} ${last.state}`,
        `${label.text} ${ansi(code, `${icon} ${last.state}`, color)}`,
        100,
      ),
      titleSeg(last, 44),
      seg(`took ${took}`, dim(`took ${took}`), 60),
      ...tokensSeg(last, used),
      seg(`${ago} ago`, dim(`${ago} ago`), 30),
    ],
    columns,
    sep,
    sepPlain,
  );
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
  refreshInterval?: number;
}

/**
 * Seconds between re-runs. Claude Code's event-driven updates go quiet while the orchestrator is
 * idle (exactly when a job runs), so a timer is needed for the bar and elapsed time to move.
 */
export const REFRESH_INTERVAL_SEC = 1;

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
  if (isOurs(current)) {
    if (current?.refreshInterval === REFRESH_INTERVAL_SEC) {
      return { state: "already_installed", settings: o.settingsFile };
    }
    // Upgrade an older install that lacked the refresh timer.
    await writeJsonAtomic(o.settingsFile, {
      ...settings,
      statusLine: { ...current, refreshInterval: REFRESH_INTERVAL_SEC },
    });
    return { state: "installed", settings: o.settingsFile };
  }
  const ours: StatusLineSetting = {
    type: "command",
    command: statusLineCommand(o.entry),
    padding: 0,
    refreshInterval: REFRESH_INTERVAL_SEC,
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
