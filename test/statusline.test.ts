import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  renderStatusLine,
  formatElapsed,
  formatTokens,
  cleanTitle,
  planSpan,
  recentJobs,
  installStatusLine,
  uninstallStatusLine,
  statusLineCommand,
} from "../src/statusline.js";
import { JobStore, emptyProgress, type JobRecord } from "../src/jobs/store.js";
import { main, type Io } from "../src/cli.js";

const NOW = new Date("2026-10-17T14:10:00Z");
const job = (o: Partial<JobRecord> & { id: string }): JobRecord => ({
  kind: "implement",
  repoRoot: "/r",
  title: "Incidents and the lesson store",
  state: "running",
  progress: { ...emptyProgress(), percent: 47, phase: "run", checklistDone: 2, checklistTotal: 5 },
  createdAt: "2026-10-17T14:05:48Z",
  updatedAt: "2026-10-17T14:09:00Z",
  returnedChars: 0,
  ...o,
});

describe("renderStatusLine", () => {
  const S = "  ·  ";
  it("shows title, phase and the job's time and tokens without a plan, and no percentage", () => {
    const line = renderStatusLine([job({ id: "t-a" })], NOW, { color: false });
    expect(line).toBe(
      ["agy", "Incidents and the lesson store", "› running", "4m12s · 0 tok"].join(S),
    );
    expect(line).not.toMatch(/%|ETA|remaining/i);
  });
  // Regression (found live): the in-run % sat at 10 and jumped to 85, because Gemini ticks its
  // checklist only at the end. The row now shows one marker per plan task instead.
  it("shows a marker per task, live activity, and only the plan's time and tokens", () => {
    const spin = ["◐", "◓", "◑", "◒"][Math.floor(NOW.getTime() / 2000) % 4];
    const running = job({
      id: "t-b",
      title: "Learning loop in `JobManager` and the **MCP** lesson action",
      plan: { file: "p.md", step: 2 },
      progress: {
        ...emptyProgress(),
        percent: 47,
        phase: "run",
        checklistDone: 2,
        checklistTotal: 5,
        tokens: 312_400,
        toolSteps: 12,
        currentFile: "src/jobs/manager.ts",
        currentStep: "Implement src/jobs/manager.ts",
      },
    });
    const earlier = job({
      id: "t-a",
      state: "passed",
      plan: { file: "p.md", step: 1 },
      updatedAt: "2026-10-17T13:00:00Z",
      envelope: { usage: { totalTokens: 331_658 } } as never,
    });
    expect(renderStatusLine([earlier, running], NOW, { color: false, planSteps: 4 })).toBe(
      [
        `agy ●${spin}○○ 1/4 tasks`,
        "#2 Learning loop in JobManager and the MCP…",
        "› running · 12 tool calls · src/jobs/manager.ts",
        "plan 4m12s · 644k tok",
      ].join(S),
    );
  });
  it("names the phase outside the run phase", () => {
    const v = job({ id: "t-a", progress: { ...emptyProgress(), percent: 88, phase: "verify" } });
    expect(renderStatusLine([v], NOW, { color: false })).toContain("› verifying");
  });
  it("fits narrow terminals by dropping the least important parts", () => {
    const line = renderStatusLine([job({ id: "t-a", plan: { file: "p.md", step: 2 } })], NOW, {
      color: false,
      columns: 60,
    });
    expect(line.length).toBeLessThanOrEqual(60);
    expect(line).toContain("#2");
  });
  it("mentions other active jobs and shows queued ones", () => {
    const a = job({ id: "t-a" });
    const b = job({ id: "t-b", state: "queued", createdAt: "2026-10-17T14:06:00Z" });
    expect(renderStatusLine([b, a], NOW, { color: false, columns: 200 })).toContain("+1 more");
    expect(renderStatusLine([b], NOW, { color: false })).toBe(
      ["agy", "queued", "Incidents and the lesson store"].join(S),
    );
  });
  it("disappears as soon as nothing runs", () => {
    const done = job({ id: "t-a", state: "passed", updatedAt: "2026-10-17T14:08:00Z" });
    expect(renderStatusLine([done], NOW, { color: false })).toBe("");
    expect(renderStatusLine([], NOW, { color: false })).toBe("");
  });
  it("uses ANSI colors by default and truncates long titles", () => {
    expect(renderStatusLine([job({ id: "t-a" })], NOW)).toContain("[");
    expect(
      renderStatusLine([job({ id: "t-a", title: "x".repeat(80) })], NOW, { color: false }),
    ).toContain("x".repeat(43) + "…");
  });
  it("formats elapsed time, tokens and titles compactly", () => {
    expect([formatElapsed(5_000), formatElapsed(252_000), formatElapsed(3_900_000)]).toEqual([
      "5s",
      "4m12s",
      "1h05m",
    ]);
    expect([
      formatTokens(412),
      formatTokens(31_200),
      formatTokens(1_250_000),
      formatTokens(2_000_000),
    ]).toEqual(["412", "31k", "1.3M", "2M"]);
    expect(
      cleanTitle("Task 2: Learning loop in `JobManager` and the **MCP** `lesson` action"),
    ).toBe("Learning loop in JobManager and the MCP lesson action");
  });
});

describe("quota and plan timer", () => {
  const S = "  ·  ";
  const quota = {
    fiveHour: { remaining: 71, resetAt: "" },
    weekly: { remaining: 12, resetAt: "" },
    fetchedAt: "",
  };
  it("shows 5h and 7d remaining while a job runs, colored by level, and nothing when idle", () => {
    const running = job({ id: "t-a" });
    expect(
      renderStatusLine([running], NOW, { color: false, quota }).endsWith(`${S}5h 71% 7d 12%`),
    ).toBe(true);
    expect(renderStatusLine([], NOW, { color: false, quota })).toBe("");
    const colored = renderStatusLine([running], NOW, { quota });
    expect(colored).toContain("[32m71%");
    expect(colored).toContain("[31m12%");
  });
  it("stops the plan timer at the last job's end once nothing runs", () => {
    const a = job({
      id: "t-a",
      state: "passed",
      plan: { file: "p.md", step: 1 },
      createdAt: "2026-10-17T13:00:00Z",
      updatedAt: "2026-10-17T13:10:00Z",
    });
    const b = job({
      id: "t-b",
      state: "passed",
      plan: { file: "p.md", step: 2 },
      createdAt: "2026-10-17T13:20:00Z",
      updatedAt: "2026-10-17T14:05:00Z",
    });
    expect(planSpan([a, b], b, NOW)).toBe(65 * 60_000);
    expect(planSpan([a, b], b, new Date("2026-10-17T18:00:00Z"))).toBe(65 * 60_000);
    const running = job({
      id: "t-c",
      plan: { file: "p.md", step: 3 },
      createdAt: "2026-10-17T14:06:00Z",
    });
    expect(planSpan([a, b, running], running, NOW)).toBe(70 * 60_000);
  });
});

describe("recentJobs", () => {
  it("reads the newest records and skips broken files", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "foreman-sl-"));
    const s = new JobStore(dir);
    await s.write(job({ id: "t-aaa" }));
    await s.write(job({ id: "t-bbb" }));
    writeFileSync(path.join(dir, "t-zzz.json"), "{half");
    expect((await recentJobs(dir)).map((j) => j.id)).toEqual(["t-bbb", "t-aaa"]);
    expect(await recentJobs(path.join(dir, "missing"))).toEqual([]);
  });
});

describe("install / uninstall", () => {
  const files = () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "foreman-set-"));
    return {
      settingsFile: path.join(d, ".claude", "settings.json"),
      wrapFile: path.join(d, "wrap.json"),
    };
  };
  // Platform-neutral (found in CI: a Windows-only path broke Linux and macOS).
  const entry = path.join("/x", "agy-foreman", "dist", "index.js");

  it("installs into empty settings, keeps other keys, and is idempotent", async () => {
    const f = files();
    expect(await installStatusLine({ ...f, entry })).toMatchObject({ state: "installed" });
    const s = JSON.parse(readFileSync(f.settingsFile, "utf8"));
    expect(s.statusLine).toEqual({
      type: "command",
      command: 'node "/x/agy-foreman/dist/statusline.js"',
      padding: 1,
      refreshInterval: 2,
    });
    expect(await installStatusLine({ ...f, entry })).toMatchObject({ state: "already_installed" });
    expect(await uninstallStatusLine(f)).toBe("removed");
    expect(JSON.parse(readFileSync(f.settingsFile, "utf8")).statusLine).toBeUndefined();
  });

  // Regression (found live): without a timer the line froze while the orchestrator was idle.
  it("upgrades an older install that had no refresh interval", async () => {
    const f = files();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(path.dirname(f.settingsFile), { recursive: true });
    writeFileSync(
      f.settingsFile,
      JSON.stringify({
        statusLine: { type: "command", command: statusLineCommand(entry), padding: 0 },
      }),
    );
    expect(await installStatusLine({ ...f, entry })).toMatchObject({ state: "installed" });
    expect(JSON.parse(readFileSync(f.settingsFile, "utf8")).statusLine.refreshInterval).toBe(2);
  });

  it("wraps an existing status line and restores it on uninstall", async () => {
    const f = files();
    const mine = { type: "command", command: "my-statusline.sh" };
    await installStatusLine({ ...f, entry: "unused" }).catch(() => {});
    writeFileSync(f.settingsFile, JSON.stringify({ theme: "dark", statusLine: mine }));
    expect(await installStatusLine({ ...f, entry })).toMatchObject({
      state: "wrapped",
      previous: "my-statusline.sh",
    });
    const s = JSON.parse(readFileSync(f.settingsFile, "utf8"));
    expect(s.theme).toBe("dark");
    expect(s.statusLine.command).toBe(statusLineCommand(entry));
    expect(await uninstallStatusLine(f)).toBe("restored");
    expect(JSON.parse(readFileSync(f.settingsFile, "utf8")).statusLine).toEqual(mine);
  });
});

describe("cli statusline", () => {
  it("prints the rendered line from the state dir without colors when NO_COLOR is set", async () => {
    const state = mkdtempSync(path.join(os.tmpdir(), "foreman-slcli-"));
    await new JobStore(path.join(state, "jobs")).write(
      job({ id: "t-a", createdAt: new Date(Date.now() - 65_000).toISOString() }),
    );
    const out: string[] = [];
    const io: Io = {
      out: (s) => out.push(s),
      err: (s) => out.push(s),
      env: { FOREMAN_STATE_DIR: state, NO_COLOR: "1" },
      cwd: os.tmpdir(),
    };
    expect(await main(["statusline"], io)).toBe(0);
    expect(out[0]).toMatch(
      /^agy  ·  Incidents and the lesson store  ·  › running  ·  1m0[5-9]s · 0 tok\n\s$/,
    );
  });
  it("init does not touch Claude settings when no home is known", async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "foreman-init2-"));
    const out: string[] = [];
    expect(
      await main(["init"], {
        out: (s) => out.push(s),
        err: (s) => out.push(s),
        env: {},
        cwd: repo,
      }),
    ).toBe(0);
    expect(out.join("\n")).not.toContain("status line");
  });
  it("init installs the status line by default when settings are known", async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "foreman-init3-"));
    const settings = path.join(
      mkdtempSync(path.join(os.tmpdir(), "foreman-set3-")),
      "settings.json",
    );
    const out: string[] = [];
    const env = {
      FOREMAN_CLAUDE_SETTINGS: settings,
      FOREMAN_STATE_DIR: mkdtempSync(path.join(os.tmpdir(), "foreman-st3-")),
    };
    expect(
      await main(["init"], { out: (s) => out.push(s), err: (s) => out.push(s), env, cwd: repo }),
    ).toBe(0);
    expect(out.join("\n")).toContain("status line: installed");
    expect(JSON.parse(readFileSync(settings, "utf8")).statusLine.command).toContain("statusline");
  });
});

describe("review fixes", () => {
  it("marks a followup as a fix of its step, so the unchanged step count is not mistaken for a hang", () => {
    const fix = job({ id: "t-f", parentJobId: "t-a", plan: { file: "p.md", step: 1 } });
    expect(renderStatusLine([fix], NOW, { color: false, planSteps: 7 })).toContain(
      "#1 fix Incidents",
    );
  });
});

describe("task markers", () => {
  // Regression (found live): a bar of finished tasks sat at 2/7 for many minutes and looked dead.
  it("shows failed and running tasks, and the spinner moves between refreshes", () => {
    const passed = job({ id: "t-1", state: "passed", plan: { file: "p.md", step: 1 } });
    const failed = job({ id: "t-2", state: "failed", plan: { file: "p.md", step: 2 } });
    const a = job({ id: "t-3", plan: { file: "p.md", step: 3 } });
    const b = job({ id: "t-4", plan: { file: "p.md", step: 5 } });
    const at = (ms: number) =>
      renderStatusLine([passed, failed, a, b], new Date(NOW.getTime() + ms), {
        color: false,
        planSteps: 5,
      }).split("  ·  ")[0];
    expect(at(0)).toMatch(/^agy ●✕[◐◓◑◒]○[◐◓◑◒] 1\/5 tasks · 2 running$/);
    expect(at(0)).not.toBe(at(2000));
  });
});
