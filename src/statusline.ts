import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isTerminal, type JobRecord } from "./jobs/store.js";
import { runCommand } from "./pipeline/exec.js";
import { poolOf } from "./pools.js";
import type { QuotaSnapshot, QuotaWindow } from "./usage-quota.js";

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

function activeJobs(jobs: JobRecord[]): JobRecord[] {
  return jobs
    .filter((j) => !isTerminal(j.state))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The job the status line shows: the oldest running one, else the oldest queued one. */
export function shownJob(jobs: JobRecord[]): JobRecord | undefined {
  const active = activeJobs(jobs);
  return active.find((a) => a.state === "running") ?? active[0];
}

export type TaskState = "passed" | "running" | "failed" | "pending";

/** State of each task 1..total of this job's plan: passed beats running beats failed. */
export function planTaskStates(jobs: JobRecord[], j: JobRecord, total: number): TaskState[] {
  const same = jobs.filter((x) => x.plan?.file === j.plan?.file);
  return Array.from({ length: total }, (_, i) => {
    const mine = same.filter((x) => x.plan!.step === i + 1);
    if (mine.some((x) => x.state === "passed")) return "passed";
    if (mine.some((x) => !isTerminal(x.state))) return "running";
    if (mine.length > 0) return "failed";
    return "pending";
  });
}

const SPINNER = ["◐", "◓", "◑", "◒"];

/** One marker per task; running ones spin with each refresh so a live job never looks frozen. */
function taskStrip(states: TaskState[], now: Date, color: boolean): string {
  const spin = SPINNER[Math.floor(now.getTime() / 2000) % SPINNER.length];
  return states
    .map((s) =>
      s === "passed"
        ? ansi("32", "●", color)
        : s === "running"
          ? ansi("36", spin, color)
          : s === "failed"
            ? ansi("31", "✕", color)
            : ansi("2;37", "○", color),
    )
    .join("");
}

/** Start → end of a plan's jobs; ends at the last job's finish, counts only while one runs. */
export function planSpan(jobs: JobRecord[], j: JobRecord, now: Date): number | undefined {
  if (!j.plan) return undefined;
  const same = jobs.filter((x) => x.plan?.file === j.plan?.file);
  const start = Math.min(...same.map((x) => Date.parse(x.createdAt)));
  const running = same.some((x) => !isTerminal(x.state));
  const end = running ? now.getTime() : Math.max(...same.map((x) => Date.parse(x.updatedAt)));
  return end - start;
}

/**
 * One status-line row. Running: label, plan bar (steps passed / plan steps), plan step + title,
 * live activity (phase, tool calls, current file), time + tokens of the whole plan (of the job
 * when it has no plan), Gemini quota. No percentage: Gemini ticks its checklist only at the end,
 * so there is no honest in-run percentage. Nothing running: "" (the line disappears).
 * Fits `columns`, dropping the least important parts.
 */
export function renderStatusLine(
  jobs: JobRecord[],
  now: Date,
  o: {
    color?: boolean;
    columns?: number;
    quota?: QuotaSnapshot;
    /** Number of steps in the shown job's plan file (from countPlanSteps). */
    planSteps?: number;
  } = {},
): string {
  const color = o.color ?? true;
  const columns = Math.max(40, o.columns ?? 200);
  const dim = (s: string) => ansi("2", s, color);
  const sep = dim("  ·  ");
  const sepPlain = "  ·  ";
  const label = seg("agy", ansi("1;35", "agy", color), 100);
  const titleSeg = (j: JobRecord, max: number): Segment => {
    // A followup reworks an earlier step after review; it does not finish a new step.
    const num = j.plan ? `#${j.plan.step}${j.parentJobId ? " fix" : ""} ` : "";
    const t = truncate(cleanTitle(j.title), Math.max(1, max - num.length));
    return { ...seg(num + t, dim(num) + ansi("1", t, color), 80), shrink: (m) => titleSeg(j, m) };
  };
  /** Time and tokens of the whole plan, or of the job when it has no plan. */
  const totalsSeg = (j: JobRecord): Segment => {
    const span = planSpan(jobs, j, now);
    const total = planTokens(jobs, j);
    if (span !== undefined && total !== undefined) {
      const plain = `plan ${formatElapsed(span)} · ${formatTokens(total)} tok`;
      return seg(plain, plain, 60);
    }
    const plain = `${formatElapsed(now.getTime() - Date.parse(j.createdAt))} · ${formatTokens(j.progress.tokens)} tok`;
    return seg(plain, plain, 60);
  };
  const quotaSegs = (j?: JobRecord): Segment[] => {
    const q = o.quota;
    if (!q) return [];
    // The pool of the shown job's model; the flat fields are the Gemini Models pool (and the only
    // data an older cache has).
    const pool = j ? poolOf(j.model) : "Gemini Models";
    const win = q.pools?.[pool] ?? (!q.pools || pool === "Gemini Models" ? q : undefined);
    if (!win || (!win.fiveHour && !win.weekly)) return [];
    const level = (n: number) => (n >= 50 ? "32" : n >= 20 ? "33" : "31");
    const part = (name: string, w?: QuotaWindow) =>
      w
        ? {
            plain: `${name} ${Math.round(w.remaining)}%`,
            text: `${dim(name)} ${ansi(level(w.remaining), `${Math.round(w.remaining)}%`, color)}`,
          }
        : undefined;
    const parts = [part("5h", win.fiveHour), part("7d", win.weekly)].filter(
      (x): x is { plain: string; text: string } => !!x,
    );
    return [seg(parts.map((x) => x.plain).join(" "), parts.map((x) => x.text).join(" "), 50)];
  };

  /** A strong job says so; fast jobs (today's only kind) add nothing. */
  const tierSegs = (j: JobRecord): Segment[] =>
    j.tier === "strong" ? [seg("argon", dim("argon"), 50)] : [];

  const active = activeJobs(jobs);
  const j = shownJob(jobs);

  if (j) {
    const others = active.length - 1;
    if (j.state === "queued") {
      return fit(
        [
          label,
          seg("queued", ansi("33", "queued", color), 90),
          titleSeg(j, 48),
          ...tierSegs(j),
          ...quotaSegs(j),
        ],
        columns,
        sep,
        sepPlain,
      );
    }
    const p = j.progress;
    const steps = j.plan && o.planSteps && o.planSteps > 0 ? o.planSteps : undefined;
    let first = label;
    if (steps !== undefined) {
      const states = planTaskStates(jobs, j, steps);
      const done = states.filter((s) => s === "passed").length;
      const running = states.filter((s) => s === "running").length;
      const count = `${done}/${steps} tasks${running > 1 ? ` · ${running} running` : ""}`;
      first = seg(
        `agy ${"●".repeat(steps)} ${count}`,
        `${label.text} ${taskStrip(states, now, color)} ${ansi("1", count, color)}`,
        100,
      );
    }
    const segments: Segment[] = [first, titleSeg(j, 44)];
    // Live activity: what is known for sure right now, not an estimate.
    const phase = PHASE_LABEL[p.phase] ?? p.phase;
    const activity = [phase];
    if (p.phase === "run") {
      if (p.toolSteps > 0) activity.push(`${p.toolSteps} tool calls`);
      if (p.currentFile) {
        // Files outside the worktree (agy's own state) stay absolute: show just the name.
        const outside = /^([A-Za-z]:)?[\\/]/.test(p.currentFile);
        activity.push(truncate(outside ? path.basename(p.currentFile) : p.currentFile, 36));
      }
    }
    segments.push(
      seg(
        `› ${activity.join(" · ")}`,
        `${dim("›")} ${ansi("36", phase, color)}${activity.length > 1 ? " · " + activity.slice(1).join(" · ") : ""}`,
        70,
      ),
    );
    segments.push(totalsSeg(j), ...tierSegs(j), ...quotaSegs(j));
    if (others > 0) segments.push(seg(`+${others} more`, dim(`+${others} more`), 10));
    return fit(segments, columns, sep, sepPlain);
  }

  // Nothing running: no status line at all (it appears only while agy works).
  return "";
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
export const REFRESH_INTERVAL_SEC = 2;

/** One column of padding lines our first character up with Claude Code's footer badges (⏵⏵). */
export const STATUS_PADDING = 1;

export function claudeSettingsPath(env: NodeJS.ProcessEnv): string {
  if (env.FOREMAN_CLAUDE_SETTINGS) return env.FOREMAN_CLAUDE_SETTINGS;
  const home = env.USERPROFILE || env.HOME || os.homedir();
  return path.join(home, ".claude", "settings.json");
}

/** Command Claude Code runs; forward slashes and quotes work in both cmd.exe and bash. */
export function statusLineCommand(entry: string): string {
  // The slim bundle next to the CLI entry; it skips the MCP server for a fast start.
  const slim = path.join(path.dirname(entry), "statusline.js").replace(/\\/g, "/");
  return `node "${slim}"`;
}

export function isOurs(setting: StatusLineSetting | undefined): boolean {
  // Matches both the old `index.js" statusline` command and the slim `statusline.js` bundle.
  return !!setting?.command && /statusline(\.js")?$/.test(setting.command.trim());
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
    const wanted = statusLineCommand(o.entry);
    if (
      current?.refreshInterval === REFRESH_INTERVAL_SEC &&
      current.command === wanted &&
      current.padding === STATUS_PADDING
    ) {
      return { state: "already_installed", settings: o.settingsFile };
    }
    // Upgrade an older install (no refresh timer, or the heavy index.js command).
    await writeJsonAtomic(o.settingsFile, {
      ...settings,
      statusLine: {
        ...current,
        command: wanted,
        padding: STATUS_PADDING,
        refreshInterval: REFRESH_INTERVAL_SEC,
      },
    });
    return { state: "installed", settings: o.settingsFile };
  }
  const ours: StatusLineSetting = {
    type: "command",
    command: statusLineCommand(o.entry),
    padding: STATUS_PADDING,
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
    env: { ...process.env, FOREMAN_STDIN: stdin },
  });
  return r.code === 0 ? (r.stdout.trim().split(/\r?\n/)[0] ?? "") : "";
}
