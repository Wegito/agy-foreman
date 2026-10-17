import { describe, it, expect } from "vitest";
import { parseJUnit } from "../../src/pipeline/junit.js";

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="vitest tests" tests="4" failures="1" errors="0">
  <testsuite name="a.test.ts" tests="4">
    <testcase classname="a.test.ts" name="adds" time="0.01"></testcase>
    <testcase classname="a.test.ts" name="subtracts" time="0.01">
      <failure message="expected 1 to be 2" type="AssertionError">stack</failure>
    </testcase>
    <testcase classname="a.test.ts" name="todo later" time="0"><skipped/></testcase>
    <testcase classname="b.test.ts" name="boom"><error message="TypeError">x</error></testcase>
  </testsuite>
</testsuites>`;

describe("parseJUnit", () => {
  it("counts cases, failures, errors and skips", () => {
    expect(parseJUnit(XML)).toEqual({
      tests: 4,
      failures: 1,
      errors: 1,
      skipped: 1,
      failed: ["a.test.ts > subtracts", "b.test.ts > boom"],
    });
  });
  it("handles self-closing testcases and empty input", () => {
    expect(parseJUnit('<testsuite><testcase classname="x" name="y"/></testsuite>')).toMatchObject({
      tests: 1,
      failures: 0,
    });
    expect(parseJUnit("")).toEqual({ tests: 0, failures: 0, errors: 0, skipped: 0, failed: [] });
  });
});
