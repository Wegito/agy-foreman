import { readFile, rename, rm } from "node:fs/promises";

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * rename() that survives Windows' transient locks: replacing a file fails with EPERM/EBUSY while
 * another process (e.g. the status line, `watch`) has it open for a moment. Retries with a short
 * backoff, then cleans up the temp file and rethrows.
 */
export async function renameWithRetry(from: string, to: string, attempts = 20): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (!RETRYABLE.has(code) || i >= attempts - 1) {
        await rm(from, { force: true }).catch(() => {});
        throw e;
      }
      await new Promise((r) => setTimeout(r, 15 * (i + 1)));
    }
  }
}

/** Runs async writes for the same key one after another (in-process). */
export class KeyedQueue {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.tails.set(key, next);
    void next
      .finally(() => {
        if (this.tails.get(key) === next) this.tails.delete(key);
      })
      .catch(() => {});
    return next;
  }
}

/** readFile() that retries while Windows briefly locks a file that is being replaced. */
export async function readFileWithRetry(file: string, attempts = 20): Promise<string> {
  for (let i = 0; ; i++) {
    try {
      return await readFile(file, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (!RETRYABLE.has(code) || i >= attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 10 * (i + 1)));
    }
  }
}
