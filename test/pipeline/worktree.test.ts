import { describe, it, expect } from "vitest";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  repoHash,
  withRepoLock,
  isDirty,
  createWorktree,
  removeWorktree,
  excludeInRepo,
  commitAll,
  changedFiles,
  diffStat,
  mergeCheck,
  snapshotGitState,
  gitStateChanged,
} from "../../src/pipeline/worktree.js";
import { git } from "../../src/pipeline/exec.js";
import { makeRepo, tmpRoot } from "./repo.js";

describe("repoHash", () => {
  it("is 10 hex chars and stable", () => {
    expect(repoHash("/a/b")).toMatch(/^[0-9a-f]{10}$/);
    expect(repoHash("/a/b")).toBe(repoHash("/a/b/"));
  });
});

describe("withRepoLock", () => {
  it("serializes and survives a rejection", async () => {
    const order: number[] = [];
    const a = withRepoLock("/r", async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push(1);
    });
    const b = withRepoLock("/r", async () => {
      throw new Error("x");
    }).catch(() => order.push(2));
    const c = withRepoLock("/r", async () => {
      order.push(3);
    });
    await Promise.all([a, b, c]);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe("worktree lifecycle", () => {
  it("creates an out-of-repo worktree on agy/<job>, commits, diffs and removes", async () => {
    const repo = makeRepo({ "src/a.txt": "one\n" });
    const root = tmpRoot();
    const wt = await createWorktree({ repoRoot: repo, jobId: "t-1", root });
    expect(wt.path).toBe(path.join(root, repoHash(repo), "t-1"));
    expect(wt.branch).toBe("agy/t-1");
    expect(existsSync(path.join(wt.path, "src/a.txt"))).toBe(true);

    writeFileSync(path.join(wt.path, "src/a.txt"), "two\n");
    writeFileSync(path.join(wt.path, "src/new.txt"), "new\n");
    expect(await changedFiles(wt)).toEqual(["src/a.txt", "src/new.txt"]);
    const head = await commitAll(wt, "work");
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(await commitAll(wt, "nothing")).toBeNull();
    const stat = await diffStat(wt);
    expect(stat).toContain("src/a.txt");
    expect(stat).toContain("src/new.txt");

    await removeWorktree(wt, { deleteBranch: true });
    expect(existsSync(wt.path)).toBe(false);
    expect(await git(["branch", "--list", "agy/t-1"], repo)).toBe("");
  }, 30_000);

  it("rejects unsafe job ids", async () => {
    const repo = makeRepo({ a: "a" });
    await expect(
      createWorktree({ repoRoot: repo, jobId: "../evil", root: tmpRoot() }),
    ).rejects.toThrow(/invalid job id/);
  });

  it("supports detached worktrees", async () => {
    const repo = makeRepo({ a: "a" });
    const wt = await createWorktree({
      repoRoot: repo,
      jobId: "e-1",
      root: tmpRoot(),
      detached: true,
    });
    expect(wt.branch).toBeNull();
    await removeWorktree(wt);
  }, 20_000);
});

describe("isDirty and excludeInRepo", () => {
  it("detects changes and respects excludes", async () => {
    const repo = makeRepo({ "a.txt": "a" });
    expect(await isDirty(repo)).toBe(false);
    writeFileSync(path.join(repo, "scratch.tmp"), "x");
    expect(await isDirty(repo)).toBe(true);
    await excludeInRepo(repo, ["*.tmp"]);
    await excludeInRepo(repo, ["*.tmp"]);
    expect(await isDirty(repo)).toBe(false);
    const common = await git(["rev-parse", "--git-common-dir"], repo);
    const ex = readFileSync(path.resolve(repo, common, "info", "exclude"), "utf8");
    expect(ex.split(/\r?\n/).filter((l) => l === "*.tmp")).toHaveLength(1);
  });
});

describe("mergeCheck", () => {
  it("reports clean merges and conflicting files", async () => {
    const repo = makeRepo({ "f.txt": "base\n", "g.txt": "g\n" });
    const wt = await createWorktree({ repoRoot: repo, jobId: "m-1", root: tmpRoot() });
    writeFileSync(path.join(wt.path, "g.txt"), "changed by job\n");
    await commitAll(wt, "job");
    expect(await mergeCheck(repo, "main", "agy/m-1")).toEqual({
      clean: true,
      conflictingFiles: [],
    });

    writeFileSync(path.join(wt.path, "f.txt"), "job side\n");
    await commitAll(wt, "job2");
    writeFileSync(path.join(repo, "f.txt"), "main side\n");
    await git(["commit", "-qam", "main"], repo);
    expect(await mergeCheck(repo, "main", "agy/m-1")).toEqual({
      clean: false,
      conflictingFiles: ["f.txt"],
    });
    await removeWorktree(wt, { deleteBranch: true });
  }, 30_000);
});

describe("git state snapshots", () => {
  it("detects ref and hook tampering but ignores the job branch", async () => {
    const repo = makeRepo({ a: "a" });
    const wt = await createWorktree({ repoRoot: repo, jobId: "s-1", root: tmpRoot() });
    const before = await snapshotGitState(repo, "agy/s-1");
    writeFileSync(path.join(wt.path, "a"), "b");
    await commitAll(wt, "job work");
    expect(gitStateChanged(before, await snapshotGitState(repo, "agy/s-1"))).toEqual([]);

    await git(["branch", "-f", "main", "HEAD"], wt.path);
    const common = await git(["rev-parse", "--git-common-dir"], repo);
    writeFileSync(path.resolve(repo, common, "hooks", "post-checkout"), "#!/bin/sh\necho pwned\n");
    expect(gitStateChanged(before, await snapshotGitState(repo, "agy/s-1"))).toEqual([
      "refs",
      "hooks",
    ]);
    await removeWorktree(wt, { deleteBranch: true });
  }, 30_000);
});
