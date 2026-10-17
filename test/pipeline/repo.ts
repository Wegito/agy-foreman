import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agyo-repo-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.name", "Test");
  g("config", "user.email", "test@example.com");
  g("config", "core.autocrlf", "false");
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  return dir;
}

export function tmpRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), "agyo-wt-"));
}
