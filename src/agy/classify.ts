import { detectQuota } from "./quota.js";
import type { AgyResult, Outcome } from "./types.js";

/** Seen live on agy 1.4.0 when --print-timeout fires: exit 0, status SUCCESS, empty response. */
export const PRINT_TIMEOUT_RE = /print timeout after \S+ with turn in progress/;
/** Provisional: the exact soft-deny wording is unverified (Plan 2 records the real text). */
const DENIED_RE = /\b(permission|denied|not allowed|requires approval)\b/i;

export interface ClassifyInput {
  exitCode: number | null;
  spawnError?: NodeJS.ErrnoException;
  stderr: string;
  log: string;
  result?: AgyResult;
  conversationId?: string;
  watchdogFired: boolean;
  agyCommand: string;
}

export function classify(i: ClassifyInput): Outcome {
  const cid = i.conversationId ?? i.result?.conversationId;
  const withCid = <T extends object>(o: T) => (cid ? { ...o, conversationId: cid } : o);

  if (i.spawnError) {
    const message =
      i.spawnError.code === "ENOENT"
        ? `agy CLI not found at "${i.agyCommand}". Install the Antigravity CLI or set AGY_PATH.`
        : `agy failed to start: ${i.spawnError.message}`;
    return { type: "error", message, exitCode: null };
  }

  const quota = detectQuota(i.log) ?? detectQuota(i.stderr);
  if (quota) {
    return withCid({
      type: "quota" as const,
      ...(quota.resetSeconds !== undefined ? { resetInSec: quota.resetSeconds } : {}),
      ...(quota.resetText ? { resetText: quota.resetText } : {}),
    });
  }

  if (i.watchdogFired || PRINT_TIMEOUT_RE.test(i.stderr)) {
    return withCid({ type: "timeout" as const, partialResponse: i.result?.response ?? "" });
  }

  const r = i.result;
  if (r) {
    if (r.status === "ERROR" || r.status === "INVALID") {
      return withCid({
        type: "error" as const,
        message: r.error || `agy status ${r.status}`,
        exitCode: i.exitCode,
      });
    }
    if (r.status === "CANCELED" || r.status === "INTERRUPTED")
      return withCid({ type: "cancelled" as const });
    if (r.status === "SUCCESS" && r.response.trim()) {
      return withCid({
        type: "success" as const,
        response: r.response,
        usage: r.usage,
        durationSec: r.durationSec,
        ...(r.structuredOutput !== undefined ? { structuredOutput: r.structuredOutput } : {}),
      });
    }
    if (DENIED_RE.test(i.stderr)) {
      return withCid({ type: "denied" as const, detail: i.stderr.trim().slice(0, 2000) });
    }
    if (i.exitCode === 0 || i.exitCode === null) {
      return withCid({
        type: "error" as const,
        message: `agy returned an empty response (status ${r.status || "unknown"}).`,
        exitCode: i.exitCode,
      });
    }
  }

  const stderr = i.stderr.trim();
  return withCid({
    type: "error" as const,
    message: stderr ? stderr.slice(0, 2000) : `agy exited with code ${i.exitCode} and no result.`,
    exitCode: i.exitCode,
  });
}
