import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSpecContext, parsePlanStep, planTitle } from "../../src/jobs/plan.js";

const PLAN = [
  "# Demo Implementation Plan",
  "",
  "### Task 1: Add the adder",
  "",
  "**Files:**",
  "- Create: `src/add.ts`, `src/util.ts`",
  "- Modify: `src/index.ts:10-20`",
  "- Test: `test/add.test.ts`",
  "",
  "- [ ] **Step 1: Write the failing test**",
  "",
  "`test/add.test.ts`:",
  "```ts",
  'import { add } from "../src/add.js";',
  'test("adds", () => expect(add(2, 3)).toBe(5));',
  "```",
  "",
  "Implementation hint:",
  "```ts",
  "export const add = (a: number, b: number) => a + b;",
  "```",
  "",
  "### Task 2: Docs",
  "",
  "- Modify: `README.md`",
  "",
].join("\n");

describe("planTitle", () => {
  it("returns the first H1", () => {
    expect(planTitle(PLAN)).toBe("Demo Implementation Plan");
    expect(planTitle("no heading")).toBe("");
  });
});

describe("parsePlanStep", () => {
  it("extracts title, files and only the test blocks", () => {
    const s = parsePlanStep(PLAN, 1);
    expect(s.title).toBe("Add the adder");
    expect(s.files).toEqual(["src/add.ts", "src/util.ts", "src/index.ts", "test/add.test.ts"]);
    expect(s.testBlocks).toEqual([
      {
        path: "test/add.test.ts",
        content:
          'import { add } from "../src/add.js";\ntest("adds", () => expect(add(2, 3)).toBe(5));\n',
      },
    ]);
    expect(s.text).toContain("Implementation hint");
    expect(s.text).not.toContain("### Task 2");
  });
  it("parses the last step and throws for a missing one", () => {
    expect(parsePlanStep(PLAN, 2)).toMatchObject({
      title: "Docs",
      files: ["README.md"],
      testBlocks: [],
    });
    expect(() => parsePlanStep(PLAN, 3)).toThrow("step 3 not found");
  });
});

// OpenSpec tasks.md: no title, `## N. Section` headings with `- [ ] N.M` items.
const TASKS = [
  "## 1. Tool support",
  "",
  "- [ ] 1.1 Add Amp to `AI_TOOLS`.",
  "- [x] 1.2 Detect Amp projects.",
  "",
  "## 2. Docs",
  "",
  "- [ ] 2.1 Document it.",
  "",
  "## 10. Later",
  "",
  "- [ ] 10.1 Something else.",
].join("\n");

describe("OpenSpec changes", () => {
  const change = () => {
    const dir = path.join(
      mkdtempSync(path.join(os.tmpdir(), "foreman-os-")),
      "openspec",
      "changes",
      "add-amp",
    );
    mkdirSync(path.join(dir, "specs", "cli"), { recursive: true });
    writeFileSync(path.join(dir, "tasks.md"), TASKS);
    writeFileSync(path.join(dir, "proposal.md"), "Why: support Amp.");
    writeFileSync(path.join(dir, "specs", "cli", "spec.md"), "### Requirement: Amp detection");
    return path.join(dir, "tasks.md");
  };

  it("parses numbered sections and uses open items as the checklist", () => {
    const s = parsePlanStep(TASKS, 1);
    expect(s.title).toBe("Tool support");
    expect(s.items).toEqual(["1.1 Add Amp to `AI_TOOLS`."]);
    expect(s.text).not.toContain("2.1");
    expect(parsePlanStep(TASKS, 10).title).toBe("Later");
    expect(() => parsePlanStep("## 1.1 Not a step", 1)).toThrow("step 1 not found");
  });

  it("names the plan after the change and inlines proposal and specs as context", async () => {
    const file = change();
    expect(planTitle(TASKS, file)).toBe("add-amp");
    expect(planTitle(TASKS, "docs/plan.md")).toBe("");
    const ctx = await openSpecContext(file);
    expect(ctx).toContain('## Context: OpenSpec change "add-amp"');
    expect(ctx).toContain("### openspec/changes/add-amp/proposal.md\n\nWhy: support Amp.");
    expect(ctx).toContain("### openspec/changes/add-amp/specs/cli/spec.md");
    expect(await openSpecContext("docs/plan.md")).toBe("");
  });
});
