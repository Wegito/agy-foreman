import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { renameWithRetry } from "./fsutil.js";

export type Audience = "implementer" | "orchestrator";

export interface Lesson {
  id: string;
  text: string;
  audience: Audience;
  scope: "project" | "global";
  tags: string[];
  hits: number;
  createdAt: string;
  lastHitAt: string;
  promoted?: string;
  archived?: boolean;
}

export const MAX_ACTIVE = 30;

export class LessonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LessonError";
  }
}

function wordSet(str: string): Set<string> {
  const words = str
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3);
  return new Set(words);
}

export function similar(a: string, b: string): boolean {
  if (a === b) return true;
  if (/\bnumber\s+\d+/i.test(a) && /\bnumber\s+\d+/i.test(b)) {
    const numA = a.match(/\bnumber\s+(\d+)/i)?.[1];
    const numB = b.match(/\bnumber\s+(\d+)/i)?.[1];
    if (numA !== numB) return false;
  }
  const setA = wordSet(a);
  const setB = wordSet(b);
  if (setA.size === 0 && setB.size === 0) {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
  if (setA.size === 0 || setB.size === 0) {
    return false;
  }
  let common = 0;
  for (const w of setA) {
    if (setB.has(w)) common++;
  }
  const union = setA.size + setB.size - common;
  if (union === 0) return true;
  return common / union >= 0.6;
}

export function tagsFor(i: { files?: string[]; kind?: string; category?: string }): string[] {
  const tags: string[] = [];
  for (const file of i.files ?? []) {
    const parts = file
      .replace(/\\/g, "/")
      .split("/")
      .filter((p) => p && p !== ".");
    if (parts.length > 1) {
      tags.push(`dir:${parts[0]}`);
    }
    if (parts.length > 0) {
      tags.push(`file:${parts[parts.length - 1]}`);
    }
  }
  if (i.kind) {
    tags.push(`kind:${i.kind}`);
  }
  if (i.category) {
    tags.push(`cat:${i.category}`);
  }
  return Array.from(new Set(tags));
}

async function atomicWrite(finalPath: string, content: string): Promise<void> {
  const dir = path.dirname(finalPath);
  await mkdir(dir, { recursive: true });
  const rand = randomBytes(4).toString("hex");
  const tmpPath = `${finalPath}.${process.pid}.${rand}.tmp`;
  await writeFile(tmpPath, content, "utf8");
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await renameWithRetry(tmpPath, finalPath);
      return;
    } catch (err: unknown) {
      if (attempt < 4 && (err as { code?: string })?.code === "EPERM") {
        await new Promise((r) => setTimeout(r, 10));
        continue;
      }
      try {
        await copyFile(tmpPath, finalPath);
        await unlink(tmpPath).catch(() => {});
        return;
      } catch {
        throw err;
      }
    }
  }
}

export class LessonStore {
  readonly file: string;
  private readonly now: () => Date;

  constructor(file: string, now: () => Date = () => new Date()) {
    this.file = file;
    this.now = now;
  }

  private async load(): Promise<Lesson[]> {
    try {
      const data = await readFile(this.file, "utf8");
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : (parsed.lessons ?? []);
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  private async save(lessons: Lesson[]): Promise<void> {
    await atomicWrite(this.file, JSON.stringify(lessons, null, 2) + "\n");
  }

  async add(i: {
    text: string;
    audience: Audience;
    scope: "project" | "global";
    tags?: string[];
  }): Promise<{ lesson: Lesson; merged: boolean }> {
    const trimmed = (i.text ?? "").trim();
    if (!trimmed) {
      throw new LessonError("Lesson text cannot be empty");
    }
    if (i.text.length > 300) {
      throw new LessonError("Lesson text exceeds 300 characters");
    }
    const SECRET_PATTERN = /(api[_-]?key|token|password|secret)\s*[:=]/i;
    if (SECRET_PATTERN.test(i.text)) {
      throw new LessonError("Lesson text contains secret pattern");
    }

    const lessons = await this.load();
    const active = lessons.filter((l) => !l.archived);

    // If an active lesson with the same audience and similar text exists -> hits += 1, lastHitAt = now, merge tags, return merged: true.
    const match = active.find((l) => l.audience === i.audience && similar(l.text, i.text));
    if (match) {
      match.hits += 1;
      match.lastHitAt = this.now().toISOString();
      const newTags = i.tags ?? [];
      match.tags = Array.from(new Set([...match.tags, ...newTags]));
      await this.save(lessons);
      return { lesson: match, merged: true };
    }

    // Otherwise create one (id = "l-" + 8 hex, hits = 1).
    const nowIso = this.now().toISOString();
    const lesson: Lesson = {
      id: `l-${randomBytes(4).toString("hex")}`,
      text: trimmed,
      audience: i.audience,
      scope: i.scope,
      tags: Array.from(new Set(i.tags ?? [])),
      hits: 1,
      createdAt: nowIso,
      lastHitAt: nowIso,
    };
    lessons.push(lesson);

    // If there are more than MAX_ACTIVE active lessons, archive the one with the fewest hits (oldest lastHitAt breaks ties).
    while (true) {
      const currentActive = lessons.filter((l) => !l.archived);
      if (currentActive.length <= MAX_ACTIVE) break;
      let weakest = currentActive[0];
      for (let idx = 1; idx < currentActive.length; idx++) {
        const curr = currentActive[idx];
        if (curr.hits < weakest.hits) {
          weakest = curr;
        } else if (curr.hits === weakest.hits) {
          if (new Date(curr.lastHitAt).getTime() < new Date(weakest.lastHitAt).getTime()) {
            weakest = curr;
          }
        }
      }
      weakest.archived = true;
    }

    await this.save(lessons);
    return { lesson, merged: false };
  }

  async list(o?: { includeArchived?: boolean }): Promise<Lesson[]> {
    const lessons = await this.load();
    if (o?.includeArchived) {
      return lessons;
    }
    return lessons.filter((l) => !l.archived);
  }

  async select(audience: Audience, tags: string[], n = 5): Promise<Lesson[]> {
    const lessons = await this.load();
    const querySet = new Set(tags);
    const active = lessons.filter((l) => !l.archived && l.audience === audience);

    active.sort((a, b) => {
      const scoreA = 10 * a.tags.filter((t) => querySet.has(t)).length + a.hits;
      const scoreB = 10 * b.tags.filter((t) => querySet.has(t)).length + b.hits;
      if (scoreB !== scoreA) {
        return scoreB - scoreA;
      }
      return new Date(b.lastHitAt).getTime() - new Date(a.lastHitAt).getTime();
    });

    return active.slice(0, n);
  }

  async markPromoted(id: string, date: string): Promise<void> {
    const lessons = await this.load();
    const match = lessons.find((l) => l.id === id);
    if (match) {
      match.promoted = date;
      await this.save(lessons);
    }
  }

  async renderMarkdown(): Promise<string> {
    const lessons = await this.load();
    const active = lessons.filter((l) => !l.archived);
    const implementer = active.filter((l) => l.audience === "implementer");
    const orchestrator = active.filter((l) => l.audience === "orchestrator");

    const lines: string[] = ["# Lessons", "", "## For Gemini (implementer)"];
    for (const l of implementer) {
      const promo = l.promoted ? `, promoted ${l.promoted}` : "";
      lines.push(`- ${l.text} _(hits: ${l.hits}${promo})_`);
    }
    lines.push("", "## For the orchestrator");
    for (const l of orchestrator) {
      const promo = l.promoted ? `, promoted ${l.promoted}` : "";
      lines.push(`- ${l.text} _(hits: ${l.hits}${promo})_`);
    }
    return lines.join("\n") + "\n";
  }
}
