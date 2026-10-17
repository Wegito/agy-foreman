// Lightweight entry for Claude Code's status line (dist/statusline.js). Claude Code runs it every
// couple of seconds, so it must not load the MCP server: only job files, the quota cache and render.
// It never starts processes (the MCP server keeps the quota cache fresh).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jobsDir, stateDir } from "./paths.js";
import { countPlanSteps } from "./jobs/plan.js";
import type { JobRecord } from "./jobs/store.js";
import { previousStatusLine, recentJobs, renderStatusLine, shownJob } from "./statusline.js";
import { quotaFile, readQuotaCache } from "./usage-quota.js";

/** Steps in the shown job's plan file; undefined without a plan or when the file is unreadable. */
async function planStepCount(j: JobRecord | undefined): Promise<number | undefined> {
  if (!j?.plan) return undefined;
  try {
    const file = path.resolve(j.repoRoot, j.plan.file);
    return countPlanSteps(await readFile(file, "utf8")) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The status line text: an optional wrapped previous status line, our row, and a blank spacer row
 * so the line does not sit directly on top of Claude Code's own footer badges.
 */
export async function statusLineText(o: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdin: string;
  now?: Date;
}): Promise<string> {
  const now = o.now ?? new Date();
  const prev = await previousStatusLine(
    path.join(stateDir({ env: o.env }), "statusline-wrap.json"),
    o.stdin,
    o.cwd,
  );
  const jobs = await recentJobs(jobsDir({ env: o.env }));
  const planSteps = await planStepCount(shownJob(jobs));
  const ours = renderStatusLine(jobs, now, {
    color: o.env.NO_COLOR === undefined,
    quota: readQuotaCache(quotaFile(o.env)),
    ...(Number(o.env.COLUMNS) > 0 ? { columns: Number(o.env.COLUMNS) } : {}),
    ...(planSteps ? { planSteps } : {}),
  });
  const row = [prev, ours].filter(Boolean).join("  │  ");
  return row ? `${row}\n ` : "";
}

async function readStdin(ms = 300): Promise<string> {
  if (process.stdin.isTTY) return "";
  return new Promise((resolve) => {
    let data = "";
    const t = setTimeout(() => resolve(data), ms);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c: string) => (data += c));
    process.stdin.on("end", () => {
      clearTimeout(t);
      resolve(data);
    });
  });
}

async function main(): Promise<void> {
  const text = await statusLineText({
    env: process.env,
    cwd: process.cwd(),
    stdin: await readStdin(),
  });
  if (text) process.stdout.write(text + "\n");
  process.exit(0);
}

// Only the dedicated dist/statusline.js bundle may run main(). This module is also bundled into
// dist/index.js (the MCP server), where import.meta.url is index.js; running main() there consumed
// the server's MCP stdin and exited, so Claude Code timed out connecting.
const self = fileURLToPath(import.meta.url);
const isMain =
  path.basename(self) === "statusline.js" &&
  !!process.argv[1] &&
  path.resolve(process.argv[1]) === self;
if (isMain) void main();
