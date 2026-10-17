import { describe, it, expect } from "vitest";
import { parsePlanStep, planTitle } from "../../src/jobs/plan.js";

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
