// Remaining Gemini quota from `agy -p /usage` (answered by the CLI itself: no model call, no
// tokens), cached on disk. The MCP server refreshes it while a job runs; the status line only reads it.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { stateDir } from "./paths.js";

export interface QuotaWindow {
  remaining: number;
  resetAt: string;
}
export interface QuotaSnapshot {
  fiveHour?: QuotaWindow;
  weekly?: QuotaWindow;
  fetchedAt: string;
}

/** Cache older than this is refreshed while a job runs. */
export const QUOTA_MAX_AGE_MS = 60_000;

export function quotaFile(env: NodeJS.ProcessEnv): string {
  return path.join(stateDir({ env }), "quota.json");
}

/**
 * Parses the tab-separated `agy -p /usage` report, e.g.
 * `Gemini Models\tFive Hour Limit Remaining\t71%\t2026-10-17T17:23:02Z`.
 * Only the Gemini rows matter (Claude/GPT models have a separate pool).
 */
export function parseUsage(text: string, now: Date): QuotaSnapshot {
  const snap: QuotaSnapshot = { fetchedAt: now.toISOString() };
  for (const line of text.split(/\r?\n/)) {
    const cols = line.split("\t").map((c) => c.trim());
    if (cols.length < 4 || !/^gemini/i.test(cols[0])) continue;
    const remaining = Number.parseFloat(cols[2]);
    if (!Number.isFinite(remaining)) continue;
    const w: QuotaWindow = { remaining, resetAt: cols[3] };
    if (/five hour/i.test(cols[1])) snap.fiveHour = w;
    else if (/weekly/i.test(cols[1])) snap.weekly = w;
  }
  return snap;
}

export function readQuotaCache(file: string): QuotaSnapshot | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as QuotaSnapshot;
  } catch {
    return undefined;
  }
}

/** Runs `agy -p /usage` and writes the cache. */
export async function refreshQuota(o: {
  agyPath: string;
  file: string;
  now?: () => Date;
}): Promise<QuotaSnapshot | undefined> {
  const out = await new Promise<string>((resolve) => {
    let buf = "";
    // Spawned directly (no shell), so "/usage" is passed literally on every platform.
    const child = spawn(o.agyPath, ["-p", "/usage"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (buf += c));
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(buf));
    setTimeout(() => {
      child.kill();
      resolve(buf);
    }, 60_000).unref();
  });
  const snap = parseUsage(out, (o.now ?? (() => new Date()))());
  if (!snap.fiveHour && !snap.weekly) return undefined;
  mkdirSync(path.dirname(o.file), { recursive: true });
  writeFileSync(o.file, JSON.stringify(snap));
  return snap;
}

/**
 * Keeps the quota cache fresh, but only while a job is active. It runs inside the MCP server so the
 * status line never starts processes: every `agy -p` also boots each MCP server in the user's agy
 * config, and on Windows those console programs flashed a window about once a minute, even when idle.
 */
export function startQuotaRefresher(o: {
  file: string;
  isActive: () => Promise<boolean>;
  refresh: () => Promise<unknown>;
  now?: () => Date;
  everyMs?: number;
}): { tick: () => Promise<void>; stop: () => void } {
  const now = o.now ?? (() => new Date());
  let busy = false;
  let lastAttempt = -Infinity;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const t = now().getTime();
      const cache = readQuotaCache(o.file);
      const fresh = cache && t - Date.parse(cache.fetchedAt) < QUOTA_MAX_AGE_MS;
      // lastAttempt also throttles failed refreshes, which leave the cache stale.
      if (fresh || t - lastAttempt < QUOTA_MAX_AGE_MS || !(await o.isActive())) return;
      lastAttempt = t;
      await o.refresh();
    } catch {
      // the quota display is best effort
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), o.everyMs ?? 10_000);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
