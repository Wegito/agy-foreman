// Remaining Gemini quota from `agy -p /usage` (answered by the CLI itself: no model call, no
// tokens), cached on disk and refreshed in the background so the status line never waits on it.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface QuotaWindow {
  remaining: number;
  resetAt: string;
}
export interface QuotaSnapshot {
  fiveHour?: QuotaWindow;
  weekly?: QuotaWindow;
  fetchedAt: string;
}

/** Cache older than this triggers a background refresh (the status line itself only reads the cache). */
export const QUOTA_MAX_AGE_MS = 60_000;
/** A refresh started less than this ago is assumed to still be running. */
const LOCK_MS = 90_000;

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

/** Runs `agy -p /usage` and writes the cache. Used by the detached refresher process. */
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
 * Starts a detached `<entry> --refresh-quota` when the cache is stale and no refresh is in flight.
 * Returns true when a refresh was started.
 */
export function maybeRefreshInBackground(o: {
  file: string;
  lockFile: string;
  entry: string;
  now: Date;
}): boolean {
  if (!existsSync(o.entry)) return false;
  const cache = readQuotaCache(o.file);
  if (cache && o.now.getTime() - Date.parse(cache.fetchedAt) < QUOTA_MAX_AGE_MS) return false;
  if (existsSync(o.lockFile) && o.now.getTime() - statSync(o.lockFile).mtimeMs < LOCK_MS)
    return false;
  mkdirSync(path.dirname(o.lockFile), { recursive: true });
  writeFileSync(o.lockFile, String(process.pid));
  const child = spawn(process.execPath, [o.entry, "--refresh-quota"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return true;
}
