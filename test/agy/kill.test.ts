import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { killTree, treeSpawnOptions, isAlive } from "../../src/agy/kill.js";
import { fixture, waitFor } from "../helpers.js";

describe("killTree (unit)", () => {
  it("uses taskkill /T /F on Windows", async () => {
    const calls: string[][] = [];
    await killTree(42, {
      deps: { platform: "win32", execFile: async (f, a) => void calls.push([f, ...a]) },
    });
    expect(calls).toEqual([["taskkill", "/PID", "42", "/T", "/F"]]);
  });

  it("ignores taskkill failure (process already gone)", async () => {
    await expect(
      killTree(42, { deps: { platform: "win32", execFile: async () => { throw new Error("128"); } } }),
    ).resolves.toBeUndefined();
  });

  it("signals the process group on POSIX, escalating to SIGKILL", async () => {
    const sent: [number, string][] = [];
    await killTree(42, {
      graceMs: 10,
      deps: {
        platform: "linux",
        processKill: (pid, sig) => void sent.push([pid, sig]),
        sleep: async () => {},
      },
    });
    expect(sent).toEqual([[-42, "SIGTERM"], [-42, "SIGKILL"]]);
  });

  it("swallows ESRCH on POSIX", async () => {
    const err = Object.assign(new Error("gone"), { code: "ESRCH" });
    await expect(
      killTree(42, { deps: { platform: "linux", processKill: () => { throw err; }, sleep: async () => {} } }),
    ).resolves.toBeUndefined();
  });
});

describe("treeSpawnOptions", () => {
  it("detaches on POSIX only", () => {
    expect(treeSpawnOptions("linux")).toEqual({ detached: true, windowsHide: true });
    expect(treeSpawnOptions("win32")).toEqual({ detached: false, windowsHide: true });
  });
});

describe("killTree (integration)", () => {
  it("kills a parent and its grandchild", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "agyo-kill-"));
    const pidFile = path.join(dir, "gc.pid");
    const parent = spawn(process.execPath, [fixture("tree-parent.mjs"), pidFile], {
      stdio: "ignore",
      ...treeSpawnOptions(),
    });
    expect(await waitFor(() => existsSync(pidFile), 5000)).toBe(true);
    const gc = Number(readFileSync(pidFile, "utf8"));
    expect(isAlive(gc)).toBe(true);

    await killTree(parent.pid!, { graceMs: 500 });

    expect(await waitFor(() => !isAlive(gc), 5000)).toBe(true);
    expect(await waitFor(() => !isAlive(parent.pid!), 5000)).toBe(true);
  }, 15000);
});
