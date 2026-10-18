import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { watchJob } from "../../src/jobs/watch.js";
import { JobManager, type JobManagerDeps } from "../../src/jobs/manager.js";
import { JobStore, emptyProgress, type JobRecord } from "../../src/jobs/store.js";

const rec = (extra: Partial<JobRecord> = {}): JobRecord => ({
  id: "t-1",
  kind: "implement",
  tier: "fast",
  model: "gemini-3.8-flash",
  repoRoot: "/repo",
  title: "t",
  state: "running",
  progress: emptyProgress(),
  createdAt: "2026-10-17T12:00:00.000Z",
  updatedAt: "2026-10-17T12:00:00.000Z",
  returnedChars: 0,
  ...extra,
});
const store = () => new JobStore(mkdtempSync(path.join(os.tmpdir(), "foreman-watch-")));

describe("watchJob", () => {
  it("reports changes and resolves with the terminal record", async () => {
    const s = store();
    await s.write(rec());
    const seen: number[] = [];
    // Each write waits until the watcher has reported the previous state, so slow CI machines
    // cannot skip the 50% step (found in CI on Windows, Node 20).
    const next = [
      rec({ updatedAt: "2026-10-17T12:00:01.000Z", progress: { ...emptyProgress(), percent: 50 } }),
      rec({
        state: "passed",
        updatedAt: "2026-10-17T12:00:02.000Z",
        progress: { ...emptyProgress(), percent: 100 },
      }),
    ];
    const final = await watchJob(s, "t-1", {
      intervalMs: 20,
      timeoutMs: 5000,
      onUpdate: (r) => {
        seen.push(r.progress.percent);
        const n = next.shift();
        if (n) void s.write(n);
      },
    });
    expect(final?.state).toBe("passed");
    expect(seen).toContain(50);
    expect(seen[seen.length - 1]).toBe(100);
  });

  it("gives up after the timeout and returns the last record, and undefined for unknown jobs", async () => {
    const s = store();
    await s.write(rec());
    expect((await watchJob(s, "t-1", { intervalMs: 20, timeoutMs: 120 }))?.state).toBe("running");
    expect(await watchJob(s, "t-missing", { intervalMs: 20, timeoutMs: 120 })).toBeUndefined();
  });
});

describe("JobManager.peek", () => {
  it("reads a job without counting it as returned to the orchestrator", async () => {
    const s = store();
    await s.write(rec());
    const m = new JobManager({ store: s } as unknown as JobManagerDeps);
    expect((await m.peek("t-1"))?.id).toBe("t-1");
    expect((await s.read("t-1"))?.returnedChars).toBe(0);
    await m.get("t-1");
    expect((await s.read("t-1"))?.returnedChars).toBeGreaterThan(0);
  });
});
