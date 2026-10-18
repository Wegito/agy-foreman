import { isTerminal, type JobRecord, type JobStore } from "./store.js";

/** Polls the store until the job is terminal or timeoutMs passes; never writes.
 *  Calls onUpdate with the first read and after every change (updatedAt or state differs).
 *  Resolves with the last record read, or undefined when the job does not exist. */
export async function watchJob(
  store: JobStore,
  jobId: string,
  o?: { intervalMs?: number; timeoutMs?: number; onUpdate?: (r: JobRecord) => void },
): Promise<JobRecord | undefined> {
  const intervalMs = o?.intervalMs ?? 200;
  const timeoutMs = o?.timeoutMs;
  const startMs = Date.now();

  let last = await store.read(jobId);
  if (!last) return undefined;

  o?.onUpdate?.(last);
  if (isTerminal(last.state)) {
    return last;
  }

  while (true) {
    if (timeoutMs !== undefined && Date.now() - startMs >= timeoutMs) {
      return last;
    }

    const remaining = timeoutMs !== undefined ? timeoutMs - (Date.now() - startMs) : Infinity;
    if (remaining <= 0) {
      return last;
    }

    const wait = Math.min(intervalMs, remaining);
    await new Promise((r) => setTimeout(r, wait));

    const rec = await store.read(jobId);
    if (rec) {
      const changed = rec.updatedAt !== last.updatedAt || rec.state !== last.state;
      last = rec;
      if (changed) {
        o?.onUpdate?.(rec);
      }
      if (isTerminal(rec.state)) {
        return rec;
      }
    }
  }
}

/**
 * `agy-foreman wait`: watchJob until `timeoutMs`, then, with `stallMs`, keeps waiting while the
 * job is non-terminal and its record changed within the last `stallMs` (escalation can run two
 * full attempts). Without `stallMs` (an explicit timeout) it stops at the deadline.
 */
export async function waitForJob(
  store: JobStore,
  jobId: string,
  o: { timeoutMs: number; stallMs?: number; intervalMs?: number },
): Promise<JobRecord | undefined> {
  let rec = await watchJob(store, jobId, { timeoutMs: o.timeoutMs, intervalMs: o.intervalMs });
  while (rec && o.stallMs !== undefined && !isTerminal(rec.state)) {
    const quietMs = Date.now() - Date.parse(rec.updatedAt);
    if (!(quietMs < o.stallMs)) break;
    rec = await watchJob(store, jobId, {
      timeoutMs: o.stallMs - quietMs,
      intervalMs: o.intervalMs,
    });
  }
  return rec;
}
