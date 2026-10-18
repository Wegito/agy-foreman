import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobScheduler } from "../../src/jobs/scheduler.js";
import { JobStore, emptyProgress, type JobRecord } from "../../src/jobs/store.js";
import { parseProjectConfig, loadRuntimeConfig } from "../../src/config.js";
import type { JobSpec } from "../../src/pipeline/index.js";

const NOW = new Date("2026-10-17T12:00:00Z");

function rec(id: string, extra: Partial<JobRecord> = {}): JobRecord {
  return {
    id,
    kind: "implement",
    tier: "fast",
    model: "gemini-3.8-flash",
    repoRoot: "/repo",
    title: id,
    state: "queued",
    progress: emptyProgress(),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    returnedChars: 0,
    ...extra,
  };
}
const spec = (id: string) => ({ jobId: id }) as unknown as JobSpec;

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(config: object) {
  const store = new JobStore(mkdtempSync(path.join(os.tmpdir(), "foreman-sched-")));
  let running = 0;
  let maxSeen = 0;
  const started: string[] = [];
  const release = new Map<string, () => void>();
  const signals = new Map<string, AbortSignal>();
  const s = new JobScheduler({
    store,
    loadConfig: () => ({
      project: parseProjectConfig({ test_command: ["x"], ...config }),
      runtime: loadRuntimeConfig({}),
    }),
    now: () => NOW,
    run: (r, _spec, signal) => {
      started.push(r.id);
      signals.set(r.id, signal);
      running++;
      maxSeen = Math.max(maxSeen, running);
      return new Promise<void>((resolve) =>
        release.set(r.id, () => {
          running--;
          resolve();
        }),
      );
    },
  });
  const finish = (id: string) => release.get(id)!();
  return { s, store, started, signals, finish, maxSeen: () => maxSeen };
}

describe("JobScheduler", () => {
  it("never exceeds max_concurrent and starts one queued job per freed slot", async () => {
    const t = setup({ max_concurrent: 1 });
    expect(await t.s.submit(rec("a"), spec("a"))).toBe("running");
    expect(await t.s.submit(rec("b"), spec("b"))).toBe("queued");
    expect(await t.s.submit(rec("c"), spec("c"))).toBe("queued");
    expect(t.started).toEqual(["a"]);
    t.finish("a");
    await until(() => t.started.length === 2);
    await pause(100);
    expect(t.started).toEqual(["a", "b"]);
    expect((await t.store.read("b"))?.state).toBe("running");
    expect((await t.store.read("c"))?.state).toBe("queued");
    t.finish("b");
    await until(() => t.started.length === 3);
    t.finish("c");
    await t.s.idle();
    expect(t.maxSeen()).toBe(1);
  });

  it("fills two slots without over-starting when both free up at once", async () => {
    const t = setup({ max_concurrent: 2 });
    for (const id of ["a", "b", "c", "d", "e"]) await t.s.submit(rec(id), spec(id));
    expect(t.started).toEqual(["a", "b"]);
    t.finish("a");
    t.finish("b");
    await until(() => t.started.length === 4);
    await pause(100);
    expect(t.started.length).toBe(4);
    t.finish("c");
    t.finish("d");
    await until(() => t.started.length === 5);
    t.finish("e");
    await t.s.idle();
    expect(t.maxSeen()).toBe(2);
  });

  it("counts started jobs, not the job being considered, against the hourly cap", async () => {
    const t = setup({ max_concurrent: 5, max_runs_per_hour: 1 });
    expect(await t.s.submit(rec("a"), spec("a"))).toBe("running");
    expect(await t.s.submit(rec("b"), spec("b"))).toBe("queued");
    t.finish("a");
    await pause(150);
    expect(t.started).toEqual(["a"]);
    expect((await t.store.read("b"))?.state).toBe("queued");
  });

  it("marks queued and running records it does not own as orphaned errors", async () => {
    const t = setup({});
    await t.store.write(
      rec("x", { state: "running", currentAttempt: { tier: "strong", model: "gemini-4-argon" } }),
    );
    await t.store.write(rec("y", { state: "queued" }));
    await t.store.write(rec("z", { state: "passed" }));
    expect((await t.s.recoverOrphans()).sort()).toEqual(["x", "y"]);
    const x = await t.store.read("x");
    expect(x?.state).toBe("error");
    expect(x?.errorReason).toMatch(/restarted/);
    expect(x).not.toHaveProperty("currentAttempt");
    expect((await t.store.read("y"))?.state).toBe("error");
    expect((await t.store.read("z"))?.state).toBe("passed");
  });

  it("cancels a queued job without running it and aborts a running one", async () => {
    const t = setup({ max_concurrent: 1 });
    await t.s.submit(rec("a"), spec("a"));
    await t.s.submit(rec("b"), spec("b"));
    expect(await t.s.cancel("b")).toBe(true);
    expect((await t.store.read("b"))?.state).toBe("cancelled");
    expect(await t.s.cancel("a")).toBe(true);
    expect(t.signals.get("a")?.aborted).toBe(true);
    t.finish("a");
    await t.s.idle();
    expect(t.started).toEqual(["a"]);
    expect(await t.s.cancel("nope")).toBe(false);
  });

  it("idle resolves only after every submitted job is over", async () => {
    const t = setup({});
    await t.s.submit(rec("a"), spec("a"));
    let done = false;
    void t.s.idle().then(() => (done = true));
    await pause(50);
    expect(done).toBe(false);
    t.finish("a");
    await until(() => done);
  });
});

// Regression (found live): a job queued by the hourly cap while nothing ran was never re-checked.
describe("JobScheduler retry", () => {
  it("starts a capped job once the hour has passed, even with nothing running", async () => {
    const store = new JobStore(mkdtempSync(path.join(os.tmpdir(), "foreman-sched-")));
    let now = NOW;
    const started: string[] = [];
    const s = new JobScheduler({
      store,
      loadConfig: () => ({
        project: parseProjectConfig({ test_command: ["x"], max_runs_per_hour: 1 }),
        runtime: loadRuntimeConfig({}),
      }),
      now: () => now,
      retryMs: 20,
      run: async (r) => {
        started.push(r.id);
      },
    });
    expect(await s.submit(rec("a"), spec("a"))).toBe("running");
    await until(() => started.length === 1);
    expect(await s.submit(rec("b"), spec("b"))).toBe("queued");
    await pause(100);
    expect(started).toEqual(["a"]);
    now = new Date(NOW.getTime() + 61 * 60_000);
    await until(() => started.length === 2);
    expect(started).toEqual(["a", "b"]);
  });
});
