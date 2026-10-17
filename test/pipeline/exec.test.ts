import { describe, it, expect } from "vitest";
import os from "node:os";
import { runCommand, quoteWinArg, git, GitError } from "../../src/pipeline/exec.js";
import { makeRepo } from "./repo.js";

describe("quoteWinArg", () => {
  it("leaves safe args alone and quotes the rest", () => {
    expect(quoteWinArg("vitest")).toBe("vitest");
    expect(quoteWinArg("--reporter=junit")).toBe("--reporter=junit");
    expect(quoteWinArg("a b")).toBe('"a b"');
    expect(quoteWinArg('say "hi"')).toBe('"say \\"hi\\""');
  });
});

describe("runCommand", () => {
  it("captures stdout and exit code", async () => {
    const r = await runCommand(
      [process.execPath, "-e", "process.stdout.write('ok'); process.exit(3)"],
      { cwd: os.tmpdir() },
    );
    expect(r).toMatchObject({ code: 3, stdout: "ok", timedOut: false });
  });
  it("runs npm via its shim on every OS", async () => {
    const r = await runCommand(["npm", "--version"], { cwd: os.tmpdir() });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
  it("times out and kills", async () => {
    const r = await runCommand([process.execPath, "-e", "setInterval(()=>{},1000)"], {
      cwd: os.tmpdir(),
      timeoutMs: 500,
    });
    expect(r.timedOut).toBe(true);
  }, 10_000);
});

describe("git", () => {
  it("returns trimmed stdout and throws GitError on failure", async () => {
    const repo = makeRepo({ "a.txt": "a" });
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], repo)).toBe("main");
    await expect(git(["rev-parse", "nope-ref"], repo)).rejects.toBeInstanceOf(GitError);
  });
});
