import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KeyedQueue } from "../../src/jobs/fsutil.js";
import { JobStore, emptyProgress, type JobRecord } from "../../src/jobs/store.js";

// Regression (found live on Windows): overlapping writes of one job file failed with EPERM on
// rename, the job runner crashed and the job never finished.
describe("concurrent job writes", () => {
  it("serializes writes per key", async () => {
    const q = new KeyedQueue();
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        q.run("k", async () => {
          await new Promise((r) => setTimeout(r, 30 - n * 10));
          order.push(n);
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3]);
  });

  it("survives many overlapping writes and concurrent readers of the same job", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "agyo-conc-"));
    const s = new JobStore(dir);
    const rec = (n: number): JobRecord => ({
      id: "t-x",
      kind: "implement",
      repoRoot: "/r",
      title: "t",
      state: "running",
      progress: { ...emptyProgress(), percent: n },
      createdAt: "",
      updatedAt: "",
      returnedChars: 0,
    });
    let reading = true;
    const reader = (async () => {
      while (reading) await s.read("t-x");
    })();
    await Promise.all(Array.from({ length: 60 }, (_, i) => s.write(rec(i))));
    reading = false;
    await reader;
    expect((await s.read("t-x"))?.progress.percent).toBe(59);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
