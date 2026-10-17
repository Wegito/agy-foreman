import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface PlanGrant {
  file: string;
  hash: string;
  steps: number[];
  approvedAt: string;
  expiresAt: string;
}

export interface Flags {
  cooldownUntil?: string;
  cooldownText?: string;
  delegationPaused: boolean;
  grants: PlanGrant[];
}

export function hashPlan(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function validGrant(f: Flags, file: string, hash: string, now: Date): PlanGrant | undefined {
  const normFile = path.resolve(file);
  const compareFile = process.platform === "win32" ? normFile.toLowerCase() : normFile;

  return f.grants.find((g) => {
    const gNorm = path.resolve(g.file);
    const gCompare = process.platform === "win32" ? gNorm.toLowerCase() : gNorm;
    if (gCompare !== compareFile) return false;
    if (g.hash !== hash) return false;
    const expiresMs = new Date(g.expiresAt).getTime();
    if (isNaN(expiresMs) || expiresMs <= now.getTime()) return false;
    return true;
  });
}

export class FlagStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly file: string) {}

  async read(): Promise<Flags> {
    try {
      const data = await readFile(this.file, "utf8");
      const parsed = JSON.parse(data) as Partial<Flags>;
      return {
        delegationPaused: parsed.delegationPaused ?? false,
        grants: parsed.grants ?? [],
        cooldownUntil: parsed.cooldownUntil,
        cooldownText: parsed.cooldownText,
      };
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        return { delegationPaused: false, grants: [] };
      }
      throw err;
    }
  }

  async update(fn: (f: Flags) => Flags | void): Promise<Flags> {
    const run = async (): Promise<Flags> => {
      const current = await this.read();
      const updated = fn(current) ?? current;
      const dir = path.dirname(this.file);
      await mkdir(dir, { recursive: true });
      const rand = randomBytes(4).toString("hex");
      const tmpPath = `${this.file}.${process.pid}.${rand}.tmp`;
      await writeFile(tmpPath, JSON.stringify(updated, null, 2), "utf8");
      await rename(tmpPath, this.file);
      return updated;
    };

    const next = this.queue.then(run, run);
    this.queue = next;
    return next;
  }
}
