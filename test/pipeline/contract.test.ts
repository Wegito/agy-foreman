import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { addContractTests, redCheck } from "../../src/pipeline/contract.js";
import { createWorktree, removeWorktree } from "../../src/pipeline/worktree.js";
import { git } from "../../src/pipeline/exec.js";
import { makeRepo, tmpRoot } from "./repo.js";

const RUNNER = `import { readdirSync } from "node:fs";
let failed = 0;
for (const f of readdirSync("tests")) {
  try { await import("./tests/" + f); } catch (e) { failed++; console.error(f, e.message); }
}
process.exit(failed ? 1 : 0);
`;

describe("contract tests", () => {
  it("commits them as the new base and passes the red check when they fail", async () => {
    const repo = makeRepo({
      "run.mjs": RUNNER,
      "tests/.keep": "",
      "src/add.mjs": "export const add = () => 0;\n",
    });
    const wt = await createWorktree({ repoRoot: repo, jobId: "c-1", root: tmpRoot() });
    const oldBase = wt.baseSha;
    const sha = await addContractTests(wt, [
      {
        path: "tests/add.test.mjs",
        content:
          'import { add } from "../src/add.mjs";\nif (add(2, 3) !== 5) throw new Error("add broken");\n',
      },
    ]);
    expect(sha).not.toBe(oldBase);
    expect(wt.baseSha).toBe(sha);
    expect(existsSync(path.join(wt.path, "tests/add.test.mjs"))).toBe(true);
    expect(await git(["log", "-1", "--format=%s"], wt.path)).toBe("agy: contract tests");
    const r = await redCheck(wt, ["node", "run.mjs"], 30_000);
    expect(r.red).toBe(true);
    await removeWorktree(wt, { deleteBranch: true });
  }, 30_000);

  it("is not red when the contract already passes", async () => {
    const repo = makeRepo({
      "run.mjs": RUNNER,
      "tests/.keep": "",
      "src/add.mjs": "export const add = (a, b) => a + b;\n",
    });
    const wt = await createWorktree({ repoRoot: repo, jobId: "c-2", root: tmpRoot() });
    await addContractTests(wt, [
      {
        path: "tests/add.test.mjs",
        content:
          'import { add } from "../src/add.mjs";\nif (add(2, 3) !== 5) throw new Error("x");\n',
      },
    ]);
    expect((await redCheck(wt, ["node", "run.mjs"], 30_000)).red).toBe(false);
    await removeWorktree(wt, { deleteBranch: true });
  }, 30_000);

  it("rejects paths that escape the worktree", async () => {
    const repo = makeRepo({ a: "a" });
    const wt = await createWorktree({ repoRoot: repo, jobId: "c-3", root: tmpRoot() });
    await expect(addContractTests(wt, [{ path: "../evil.mjs", content: "" }])).rejects.toThrow(
      /escapes worktree/,
    );
    await removeWorktree(wt, { deleteBranch: true });
  }, 20_000);
});
