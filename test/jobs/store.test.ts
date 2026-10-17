import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  JobStore,
  newJobId,
  isTerminal,
  emptyProgress,
  type JobRecord,
} from "../../src/jobs/store.js";

const rec = (id: string, createdAt: string, state: JobRecord["state"] = "running"): JobRecord => ({
  id,
  kind: "implement",
  repoRoot: "/r",
  title: "t",
  state,
  progress: emptyProgress(),
  createdAt,
  updatedAt: createdAt,
  returnedChars: 0,
});

describe("newJobId", () => {
  it("is a safe, unique-looking id", () => {
    const id = newJobId(new Date("2026-10-17T12:00:00Z"), () => "ab12");
    expect(id).toMatch(/^t-[0-9a-z]+-ab12$/);
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
    expect(newJobId(new Date())).toMatch(/^t-[0-9a-z]+-[0-9a-f]{4}$/);
  });
});

describe("isTerminal", () => {
  it("treats queued and running as non-terminal", () => {
    expect(isTerminal("queued")).toBe(false);
    expect(isTerminal("running")).toBe(false);
    for (const s of [
      "passed",
      "failed",
      "refused",
      "quota",
      "timeout",
      "cancelled",
      "error",
      "guard_violation",
    ] as const)
      expect(isTerminal(s)).toBe(true);
  });
});

describe("JobStore", () => {
  it("writes atomically, reads back and lists newest first", async () => {
    const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "agyo-store-")), "jobs");
    const s = new JobStore(dir);
    await s.write(rec("t-a", "2026-10-17T10:00:00Z"));
    await s.write(rec("t-b", "2026-10-17T11:00:00Z"));
    await s.write({ ...rec("t-a", "2026-10-17T10:00:00Z"), state: "passed" });
    expect((await s.read("t-a"))?.state).toBe("passed");
    expect(await s.read("t-missing")).toBeUndefined();
    expect((await s.list()).map((r) => r.id)).toEqual(["t-b", "t-a"]);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
