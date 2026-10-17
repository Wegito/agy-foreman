// Small pure helpers for job records, checklist extraction, and path comparisons.
import path from "node:path";
import type { Config } from "../config.js";
import type { JobRecord } from "./store.js";

export function isSamePath(p1: string, p2: string): boolean {
  const norm1 = path.resolve(p1);
  const norm2 = path.resolve(p2);
  return process.platform === "win32"
    ? norm1.toLowerCase() === norm2.toLowerCase()
    : norm1 === norm2;
}

/** Text of the first unticked "- [ ] item" in a progress checklist, if any. */
export function firstOpenItem(markdown: string): string | undefined {
  const m = /^\s*[-*]\s+\[ \]\s+(.+)$/m.exec(markdown);
  return m ? m[1].trim() : undefined;
}

/**
 * What agy_get returns: the record without bulky fields the orchestrator rarely needs. A passed
 * job drops the test-output tail; a failed one keeps its last 1500 chars. The untrusted report is
 * capped. (Found live: a passed job returned ~6k tokens, mostly test output.)
 */
export function compactRecord(rec: JobRecord): JobRecord {
  const e = rec.envelope;
  if (!e) return rec;
  const verify = e.verify
    ? e.state === "passed"
      ? (({ outputTail: _tail, ...v }) => v)(e.verify)
      : { ...e.verify, outputTail: e.verify.outputTail.slice(-1500) }
    : undefined;
  const report =
    e.untrustedReport.length > 3000
      ? [
          e.untrustedReport.slice(0, 2600),
          "[… report truncated …]",
          e.untrustedReport.slice(e.untrustedReport.lastIndexOf("<<<END")),
        ].join("\n")
      : e.untrustedReport;
  return {
    ...rec,
    envelope: {
      ...e,
      ...(verify ? { verify: verify as typeof e.verify } : {}),
      untrustedReport: report,
    },
  };
}

export function canRunJob(
  allJobs: JobRecord[],
  repoRoot: string,
  config: Config,
  now: Date,
): boolean {
  const repoJobs = allJobs.filter((j) => isSamePath(j.repoRoot, repoRoot));
  const runningJobs = repoJobs.filter((j) => j.state === "running");
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const startedLastHour = repoJobs.filter((j) => j.createdAt >= oneHourAgo);

  return (
    runningJobs.length < config.project.maxConcurrent &&
    startedLastHour.length < config.project.maxRunsPerHour
  );
}
