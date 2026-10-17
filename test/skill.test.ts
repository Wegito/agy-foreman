import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skill = path.join(root, "skills", "gemini-delegation");
const read = (rel: string) => readFileSync(path.join(skill, rel), "utf8");
const REFS = ["models", "routing", "prompting", "known-issues", "review", "async", "lessons"];
const all = () => [read("SKILL.md"), ...REFS.map((r) => read(`references/${r}.md`))].join("\n");

describe("gemini-delegation skill", () => {
  it("has valid frontmatter", () => {
    const md = read("SKILL.md");
    expect(md.startsWith("---\nname: gemini-delegation\ndescription: ")).toBe(true);
    expect(md).toMatch(/description: .*Gemini 3\.8 Flash.*agy_start/);
  });
  it("ships every reference file and links them from SKILL.md", () => {
    for (const r of REFS) {
      expect(existsSync(path.join(skill, "references", `${r}.md`)), r).toBe(true);
      expect(read(`references/${r}.md`).trim().length, r).toBeGreaterThan(200);
      expect(read("SKILL.md")).toContain(`references/${r}.md`);
    }
  });
  it("states the key rules", () => {
    const text = all();
    for (const s of [
      "agy_start",
      "agy_get",
      "agy_act",
      "agy_status",
      "gemini-3.8-flash-high",
      "low",
      "medium",
      "high",
      "contract test",
      "estimate",
      "once per plan",
      "agy-orchestrator wait",
      "Continue without Gemini",
      "two strikes",
      "grep",
      "untrusted",
      "finalize",
      "follow",
    ])
      expect(text.toLowerCase(), s).toContain(s.toLowerCase());
  });
  it("carries the live-verified known issues with sources", () => {
    const k = read("references/known-issues.md");
    for (const s of ["print timeout", "SUCCESS", "always-proceed", "word", "stdin", "taskkill"])
      expect(k, s).toContain(s);
    expect(k).toMatch(/Source|source/);
  });
  it("never sets word limits for briefs and never mentions account switching", () => {
    const p = read("references/prompting.md");
    expect(p).toMatch(/never set hard word or length limits/i);
    expect(all()).not.toMatch(/account (switch|rotation)|switch(ing)? accounts?/i);
  });
  it("has an AGENTS.md pointer for agents without skill support", () => {
    const a = readFileSync(path.join(root, "AGENTS.md"), "utf8");
    expect(a).toContain("skills/gemini-delegation/SKILL.md");
    expect(a).toContain("agy_start");
  });
});
