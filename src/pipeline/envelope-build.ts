// Shared envelope-building helpers, untrusted output fencing, and review log inspection.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Outcome } from "../agy/types.js";
import type { JobState } from "./index.js";

export function fenceUntrusted(text: string, nonce: string): string {
  return `<<<AGY-UNTRUSTED nonce=${nonce}>>>\n${text.slice(0, 8000)}\n<<<END nonce=${nonce}>>>`;
}

export function getDeniedCommands(worktreePath: string): string[] {
  const reviewFile = path.join(worktreePath, ".agents", "foreman-review.jsonl");
  if (!existsSync(reviewFile)) return [];
  try {
    const lines = readFileSync(reviewFile, "utf8").trim().split(/\r?\n/).filter(Boolean);
    const denied: string[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.decision === "deny" && entry.name === "run_command" && entry.arg) {
          denied.push(String(entry.arg));
        }
      } catch {
        // ignore parse error
      }
    }
    return denied;
  } catch {
    return [];
  }
}

export function makeUntrustedReport(outcome: Outcome): string {
  const responseText =
    outcome.type === "success"
      ? outcome.response
      : outcome.type === "timeout"
        ? outcome.partialResponse
        : "";
  const nonce = randomBytes(4).toString("hex");
  return fenceUntrusted(responseText, nonce);
}

export function mapFailureOutcome(
  outcome: Outcome,
  guardEvents: string[],
): {
  jobState: JobState;
  jobReason?: string;
  quotaData?: { resetInSec?: number; resetText?: string };
} | null {
  if (outcome.type === "quota") {
    return {
      jobState: "quota",
      quotaData: { resetInSec: outcome.resetInSec, resetText: outcome.resetText },
      jobReason: outcome.resetText ?? "Quota exceeded",
    };
  }
  if (outcome.type === "timeout") {
    return { jobState: "timeout", jobReason: "Job timed out" };
  }
  if (outcome.type === "cancelled") {
    return { jobState: "cancelled", jobReason: "Job was cancelled" };
  }
  if (outcome.type === "guard_violation") {
    if (!guardEvents.includes(outcome.reason)) {
      guardEvents.push(outcome.reason);
    }
    return { jobState: "guard_violation", jobReason: outcome.reason };
  }
  if (outcome.type === "denied") {
    return { jobState: "error", jobReason: outcome.detail };
  }
  if (outcome.type === "error") {
    return { jobState: "error", jobReason: outcome.message };
  }
  return null;
}
