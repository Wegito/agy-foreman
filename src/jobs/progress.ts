import type { JobPhase, JobRecord } from "./store.js";

export const PHASE_WEIGHTS: Record<
  "prepare" | "contract" | "brief" | "run" | "verify" | "report",
  number
> = {
  prepare: 5,
  contract: 5,
  brief: 0,
  run: 75,
  verify: 12,
  report: 3,
};

const PHASE_ORDER = ["prepare", "contract", "brief", "run", "verify", "report"] as const;

export interface ProgressInput {
  phase: JobPhase;
  checklist?: { done: number; total: number };
  elapsedSec: number;
  runElapsedSec: number;
  medianRunSec?: number;
}

export function computeProgress(i: ProgressInput): { percent: number; etaSec?: number } {
  if (i.phase === "queued" || i.phase === "awaiting_approval") {
    return { percent: 0 };
  }
  if (i.phase === "done") {
    return { percent: 100 };
  }

  const phaseIndex = PHASE_ORDER.indexOf(i.phase as (typeof PHASE_ORDER)[number]);
  let sumBefore = 0;
  for (let idx = 0; idx < phaseIndex; idx++) {
    sumBefore += PHASE_WEIGHTS[PHASE_ORDER[idx]];
  }

  let fraction = 0;
  if (i.phase === "run") {
    if (i.checklist && i.checklist.total > 0) {
      fraction = i.checklist.done / i.checklist.total;
    } else if (i.medianRunSec && i.medianRunSec > 0) {
      fraction = Math.min(0.95, i.runElapsedSec / i.medianRunSec);
    }
  }

  const currentWeight = phaseIndex >= 0 ? PHASE_WEIGHTS[PHASE_ORDER[phaseIndex]] : 0;
  let percent = Math.floor(sumBefore + fraction * currentWeight);
  if (percent > 99) {
    percent = 99;
  }

  let etaSec: number | undefined;
  if (percent > 0 && percent < 100) {
    etaSec = Math.round((i.elapsedSec * (100 - percent)) / percent);
  }

  return etaSec !== undefined ? { percent, etaSec } : { percent };
}

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  let out = "";
  if (h) out += `${h}h`;
  if (m) out += `${m}m`;
  if (sec || !out) out += `${sec}s`;
  return out;
}

export function renderProgressLine(rec: JobRecord): string {
  const filled = Math.min(20, Math.max(0, Math.round((rec.progress.percent / 100) * 20)));
  const bar = "▓".repeat(filled) + "░".repeat(20 - filled);

  const checklistPart =
    rec.progress.checklistTotal > 0
      ? ` · step ${rec.progress.checklistDone}/${rec.progress.checklistTotal}`
      : "";
  const filePart = rec.progress.currentFile ? ` · ${rec.progress.currentFile}` : "";
  const elapsedPart = ` · ${formatDuration(rec.progress.elapsedSec)}`;

  // No time estimate on purpose: the percentage is the honest progress signal.
  return `${rec.id}  ${bar} ${rec.progress.percent}% · ${rec.progress.phase}${checklistPart}${filePart}${elapsedPart}`;
}
