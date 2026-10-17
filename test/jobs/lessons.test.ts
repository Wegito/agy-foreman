import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LessonStore, LessonError, similar, tagsFor, MAX_ACTIVE } from "../../src/jobs/lessons.js";

const store = (now = () => new Date("2026-10-17T12:00:00Z")) =>
  new LessonStore(path.join(mkdtempSync(path.join(os.tmpdir(), "agyo-les-")), "sub", "lessons.json"), now);

describe("similar and tagsFor", () => {
  it("treats near-duplicates as similar", () => {
    expect(similar("Run pnpm test:unit; pnpm test starts e2e and times out.", "run pnpm test:unit because pnpm test starts e2e and times out")).toBe(true);
    expect(similar("Models live in src/db/models.", "UI tasks without visual tests fail; keep them local.")).toBe(false);
  });
  it("derives tags from files, kind and category", () => {
    expect(tagsFor({ files: ["src/db/models.ts", "src/api.ts"], kind: "implement", category: "test_tampering" }))
      .toEqual(["dir:src", "file:models.ts", "file:api.ts", "kind:implement", "cat:test_tampering"]);
  });
});

describe("LessonStore", () => {
  it("adds, merges duplicates and counts hits", async () => {
    const s = store();
    const a = await s.add({ text: "Run pnpm test:unit; pnpm test starts e2e and times out.", audience: "implementer", scope: "project", tags: ["cat:timeout_too_short"] });
    expect(a).toMatchObject({ merged: false, lesson: { hits: 1, id: expect.stringMatching(/^l-[0-9a-f]{8}$/) } });
    const b = await s.add({ text: "run pnpm test:unit because pnpm test starts e2e and times out", audience: "implementer", scope: "project", tags: ["dir:test"] });
    expect(b).toMatchObject({ merged: true, lesson: { id: a.lesson.id, hits: 2 } });
    expect(b.lesson.tags.sort()).toEqual(["cat:timeout_too_short", "dir:test"]);
    expect(await s.list()).toHaveLength(1);
  });
  it("keeps audiences apart and validates text", async () => {
    const s = store();
    await s.add({ text: "Keep UI tasks local.", audience: "orchestrator", scope: "global" });
    await s.add({ text: "Keep UI tasks local.", audience: "implementer", scope: "global" });
    expect(await s.list()).toHaveLength(2);
    await expect(s.add({ text: " ", audience: "implementer", scope: "global" })).rejects.toBeInstanceOf(LessonError);
    await expect(s.add({ text: "x".repeat(301), audience: "implementer", scope: "global" })).rejects.toBeInstanceOf(LessonError);
    await expect(s.add({ text: "Use api_key: abc123 for staging", audience: "implementer", scope: "global" })).rejects.toBeInstanceOf(LessonError);
  });
  it("selects by shared tags, then hits", async () => {
    const s = store();
    await s.add({ text: "Models live in src/db/models, not models/.", audience: "implementer", scope: "project", tags: ["dir:src", "file:models.ts"] });
    const often = await s.add({ text: "Always run npm run typecheck before finishing.", audience: "implementer", scope: "project" });
    await s.add({ text: "always run npm run typecheck before you finish", audience: "implementer", scope: "project" });
    await s.add({ text: "Prefer small diffs for orchestrator review.", audience: "orchestrator", scope: "project", tags: ["dir:src"] });
    const sel = await s.select("implementer", ["dir:src", "file:models.ts"], 5);
    expect(sel.map((l) => l.text)).toEqual(["Models live in src/db/models, not models/.", often.lesson.text]);
    expect(await s.select("implementer", [], 1)).toHaveLength(1);
  });
  it("archives the weakest lesson beyond MAX_ACTIVE and persists", async () => {
    let t = 0;
    const s = store(() => new Date(Date.UTC(2026, 9, 17, 12, 0, t++)));
    for (let i = 0; i < MAX_ACTIVE + 1; i++) await s.add({ text: `Unique lesson number ${i} about module m${i}x${i * 7}.`, audience: "implementer", scope: "project" });
    expect(await s.list()).toHaveLength(MAX_ACTIVE);
    expect(await s.list({ includeArchived: true })).toHaveLength(MAX_ACTIVE + 1);
    expect((await s.list()).some((l) => l.text.includes("number 0 "))).toBe(false);
  });
  it("marks promotions and renders markdown", async () => {
    const s = store();
    const { lesson } = await s.add({ text: "Models live in src/db/models.", audience: "implementer", scope: "project" });
    await s.add({ text: "Keep UI tasks local.", audience: "orchestrator", scope: "project" });
    await s.markPromoted(lesson.id, "2026-10-20");
    const md = await s.renderMarkdown();
    expect(md).toContain("# Lessons");
    expect(md).toContain("## For Gemini (implementer)");
    expect(md).toContain("- Models live in src/db/models. _(hits: 1, promoted 2026-10-20)_");
    expect(md).toContain("## For the orchestrator");
  });
});
