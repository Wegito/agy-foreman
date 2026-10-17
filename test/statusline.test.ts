import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  renderStatusLine,
  formatElapsed,
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
  it("shows bar, percent, phase, task title, step and elapsed time, and no estimate", () => {
    const line = renderStatusLine([job({ id: "t-a" })], NOW, { color: false });
    expect(line).toBe(
      'agy ██████░░░░░░ 47% · run · "Incidents and the lesson store" · step 2/5 · 4m12s',
    );
    expect(line).not.toMatch(/ETA|remaining/i);
  });
  it("mentions other active jobs and shows queued ones", () => {
    const a = job({ id: "t-a" });
    const b = job({ id: "t-b", state: "queued", createdAt: "2026-10-17T14:06:00Z" });
    expect(renderStatusLine([b, a], NOW, { color: false })).toContain("· +1 more");
    expect(renderStatusLine([b], NOW, { color: false })).toBe(
      'agy queued · "Incidents and the lesson store"',
    );
  });
  it("shows a recently finished job, then nothing", () => {
    const done = job({ id: "t-a", state: "passed", updatedAt: "2026-10-17T14:08:00Z" });
    expect(renderStatusLine([done], NOW, { color: false })).toBe(
      'agy ✓ passed · "Incidents and the lesson store" · took 2m12s · 2m00s ago',
    );
    expect(renderStatusLine([done], new Date("2026-10-17T15:00:00Z"), { color: false })).toBe("");
  });
  it("uses ANSI colors by default and truncates long titles", () => {
    expect(renderStatusLine([job({ id: "t-a" })], NOW)).toContain("\x1b[");
    expect(
      renderStatusLine([job({ id: "t-a", title: "x".repeat(80) })], NOW, { color: false }),
    ).toContain("x".repeat(47) + "…");
  });
  it("formats elapsed time compactly", () => {
    expect([formatElapsed(5_000), formatElapsed(252_000), formatElapsed(3_900_000)]).toEqual([
      "5s",
      "4m12s",
      "1h05m",
    ]);
  });
});

describe("recentJobs", () => {
  it("reads the newest records and skips broken files", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "agyo-sl-"));
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
    const d = mkdtempSync(path.join(os.tmpdir(), "agyo-set-"));
    return {
      settingsFile: path.join(d, ".claude", "settings.json"),
      wrapFile: path.join(d, "wrap.json"),
    };
  };
  const entry = "C:\\x\\agy-orchestrator\\dist\\index.js";

  it("installs into empty settings, keeps other keys, and is idempotent", async () => {
    const f = files();
    expect(await installStatusLine({ ...f, entry })).toMatchObject({ state: "installed" });
    const s = JSON.parse(readFileSync(f.settingsFile, "utf8"));
    expect(s.statusLine).toEqual({
      type: "command",
      command: 'node "C:/x/agy-orchestrator/dist/index.js" statusline',
      padding: 0,
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
    const state = mkdtempSync(path.join(os.tmpdir(), "agyo-slcli-"));
    await new JobStore(path.join(state, "jobs")).write(
      job({ id: "t-a", createdAt: new Date(Date.now() - 65_000).toISOString() }),
    );
    const out: string[] = [];
    const io: Io = {
      out: (s) => out.push(s),
      err: (s) => out.push(s),
      env: { AGYO_STATE_DIR: state, NO_COLOR: "1" },
      cwd: os.tmpdir(),
    };
    expect(await main(["statusline"], io)).toBe(0);
    expect(out[0]).toMatch(
      /^agy ██████░░░░░░ 47% · run · "Incidents and the lesson store" · step 2\/5 · 1m0[5-9]s$/,
    );
  });
  it("init does not touch Claude settings when no home is known", async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "agyo-init2-"));
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
    const repo = mkdtempSync(path.join(os.tmpdir(), "agyo-init3-"));
    const settings = path.join(mkdtempSync(path.join(os.tmpdir(), "agyo-set3-")), "settings.json");
    const out: string[] = [];
    const env = {
      AGYO_CLAUDE_SETTINGS: settings,
      AGYO_STATE_DIR: mkdtempSync(path.join(os.tmpdir(), "agyo-st3-")),
    };
    expect(
      await main(["init"], { out: (s) => out.push(s), err: (s) => out.push(s), env, cwd: repo }),
    ).toBe(0);
    expect(out.join("\n")).toContain("status line: installed");
    expect(JSON.parse(readFileSync(settings, "utf8")).statusLine.command).toContain("statusline");
  });
});
