import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Envelope, JobState } from "../pipeline/index.js";
import type { Incident } from "./incidents.js";

export type JobPhase =
  | "queued"
  | "awaiting_approval"
  | "prepare"
  | "contract"
  | "brief"
  | "run"
  | "verify"
  | "report"
  | "done";

export type RecordState = JobState | "queued" | "running";

export interface Estimate {
  directTokens: number;
  delegateOverheadTokens: number;
  reason: string;
}

export interface Progress {
  percent: number;
  phase: JobPhase;
  checklistDone: number;
  checklistTotal: number;
  currentStep?: string;
  currentFile?: string;
  toolSteps: number;
  tokens: number;
  elapsedSec: number;
  etaSec?: number;
}

export interface JobRecord {
  id: string;
  kind: "implement" | "explore";
  repoRoot: string;
  title: string;
  state: RecordState;
  progress: Progress;
  createdAt: string;
  updatedAt: string;
  plan?: { file: string; step: number };
  estimate?: Estimate;
  parentJobId?: string;
  envelope?: Envelope;
  returnedChars: number;
  incident?: Incident;
}

export function isTerminal(state: RecordState): boolean {
  return state !== "queued" && state !== "running";
}

export function newJobId(now: Date, rand?: () => string): string {
  const ts = now.getTime().toString(36);
  const suffix = rand ? rand() : randomBytes(2).toString("hex");
  return `t-${ts}-${suffix}`;
}

export function emptyProgress(): Progress {
  return {
    percent: 0,
    phase: "queued",
    checklistDone: 0,
    checklistTotal: 0,
    toolSteps: 0,
    tokens: 0,
    elapsedSec: 0,
  };
}

export class JobStore {
  constructor(readonly dir: string) {}

  async write(rec: JobRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const finalPath = path.join(this.dir, `${rec.id}.json`);
    const rand = randomBytes(4).toString("hex");
    const tmpPath = `${finalPath}.${process.pid}.${rand}.tmp`;
    await writeFile(tmpPath, JSON.stringify(rec, null, 2), "utf8");
    await rename(tmpPath, finalPath);
  }

  async read(id: string): Promise<JobRecord | undefined> {
    const filePath = path.join(this.dir, `${id}.json`);
    try {
      const data = await readFile(filePath, "utf8");
      return JSON.parse(data) as JobRecord;
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        return undefined;
      }
      throw err;
    }
  }

  async list(): Promise<JobRecord[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        return [];
      }
      throw err;
    }
    const jsonFiles = files.filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
    const records: JobRecord[] = [];
    for (const f of jsonFiles) {
      try {
        const data = await readFile(path.join(this.dir, f), "utf8");
        records.push(JSON.parse(data) as JobRecord);
      } catch {
        // ignore unreadable/corrupt files
      }
    }
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return records;
  }
}
