import { describe, it, expect } from "vitest";
import { poolOf, modelLabel } from "../src/pools.js";

describe("poolOf", () => {
  it.each([
    ["gemini-3.8-flash-high", "Gemini Models"],
    ["gemini-4-argon-medium", "Gemini 4 Argon"],
    ["claude-sonnet-5-5-high", "Claude and GPT models"],
    ["gpt-oss-120b-medium", "Claude and GPT models"],
    ["mystery-1-low", "model:mystery-1"],
  ])("%s -> %s", (model, pool) => {
    expect(poolOf(model)).toBe(pool);
  });
});

describe("modelLabel", () => {
  it("names known models, with the effort when given", () => {
    expect(modelLabel("gemini-3.8-flash", "high")).toBe("Gemini 3.8 Flash (high)");
    expect(modelLabel("gemini-4-argon-low")).toBe("Gemini 4 Argon (low)");
    expect(modelLabel("mystery-1")).toBe("mystery-1");
    expect(modelLabel("mystery-1", "low")).toBe("mystery-1 (low)");
  });
});
