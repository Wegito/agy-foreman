import type { Estimate } from "./store.js";

export interface PlanCard {
  planFile: string;
  title: string;
  steps: number[];
  estimate?: Estimate;
}

export interface TaskCard {
  title: string;
  kind: "implement" | "explore";
  effort: string;
  skills: string[];
  estimate?: Estimate;
}

export interface QuotaCard {
  resetText?: string;
  resetAt?: string;
  pausedJobId?: string;
}

export type QuotaChoice = "retry" | "continue_without" | "wait";

export interface PromoteCard {
  lessonText: string;
  hits: number;
  targetFile: string;
}

export function promoteCardText(c: PromoteCard): string {
  return `Add a learned rule to the gemini-delegation skill?\n"${c.lessonText}" (seen ${c.hits}×)\n→ ${c.targetFile}`;
}

export interface Approver {
  plan(c: PlanCard): Promise<boolean>;
  task(c: TaskCard): Promise<boolean>;
  quota(c: QuotaCard): Promise<QuotaChoice | "unavailable">;
  promote(c: PromoteCard): Promise<boolean>;
}

export class ApprovalUnavailable extends Error {}

function formatK(tokens: number): string {
  const val = Math.round((tokens / 1000) * 10) / 10;
  return `${val}k`;
}

export function planCardText(c: PlanCard): string {
  const estimatePart = c.estimate
    ? `\nDoing it myself: ~${formatK(c.estimate.directTokens)} tokens · Delegating: ~${formatK(c.estimate.delegateOverheadTokens)} tokens`
    : "";
  return `Delegate plan "${c.title}" to Gemini 3.8 Flash?\n${c.planFile} · steps for Gemini: ${c.steps.join(", ")}${estimatePart}`;
}

export function taskCardText(c: TaskCard): string {
  const skillsPart = c.skills && c.skills.length > 0 ? ` · skills: ${c.skills.join(", ")}` : "";
  const line1 = `Delegate to Gemini 3.8 Flash (${c.effort})? "${c.title}"${skillsPart}`;
  const estimatePart = c.estimate
    ? `\nDoing it myself: ~${formatK(c.estimate.directTokens)} tokens · Delegating: ~${formatK(c.estimate.delegateOverheadTokens)} tokens`
    : "";
  const reasonPart = c.estimate?.reason ? `\nWhy: ${c.estimate.reason}` : "";
  return `${line1}${estimatePart}${reasonPart}`;
}

export function quotaCardText(c: QuotaCard): string {
  let timeStr: string | undefined;
  if (c.resetAt) {
    const d = new Date(c.resetAt);
    if (!isNaN(d.getTime())) {
      const hh = d.getHours().toString().padStart(2, "0");
      const mm = d.getMinutes().toString().padStart(2, "0");
      timeStr = `${hh}:${mm}`;
    }
  }

  let resetPart = "";
  if (c.resetText && timeStr) {
    resetPart = ` Resets in ${c.resetText} (${timeStr}).`;
  } else if (c.resetText) {
    resetPart = ` Resets in ${c.resetText}.`;
  } else if (timeStr) {
    resetPart = ` Resets at ${timeStr}.`;
  }

  const pausePart = c.pausedJobId ? ` Task ${c.pausedJobId} paused, partial work kept.` : "";
  return `Gemini quota reached.${resetPart}${pausePart}`;
}

export class ClientModeApprover implements Approver {
  readonly isClientMode = true;

  async plan(_c: PlanCard): Promise<boolean> {
    return true;
  }

  async task(_c: TaskCard): Promise<boolean> {
    return true;
  }

  async quota(_c: QuotaCard): Promise<QuotaChoice | "unavailable"> {
    return "unavailable";
  }

  async promote(_c: PromoteCard): Promise<boolean> {
    return false;
  }
}

export class FakeApprover implements Approver {
  calls: { kind: "plan" | "task" | "quota" | "promote"; card: unknown }[] = [];

  constructor(
    private answers?: {
      plan?: boolean;
      task?: boolean;
      quota?: QuotaChoice | "unavailable";
      promote?: boolean;
    },
  ) {}

  async plan(c: PlanCard): Promise<boolean> {
    this.calls.push({ kind: "plan", card: c });
    return this.answers?.plan ?? true;
  }

  async task(c: TaskCard): Promise<boolean> {
    this.calls.push({ kind: "task", card: c });
    return this.answers?.task ?? true;
  }

  async quota(c: QuotaCard): Promise<QuotaChoice | "unavailable"> {
    this.calls.push({ kind: "quota", card: c });
    return this.answers?.quota ?? "unavailable";
  }

  async promote(c: PromoteCard): Promise<boolean> {
    this.calls.push({ kind: "promote", card: c });
    return this.answers?.promote ?? false;
  }
}
