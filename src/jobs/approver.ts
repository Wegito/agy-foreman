import type { Effort } from "../config.js";
import { modelLabel } from "../pools.js";
import type { Estimate } from "./store.js";

export interface PlanCard {
  planFile: string;
  title: string;
  steps: number[];
  model: string;
  effort?: string;
  /** Label of the tier a failed implement job retries on. */
  escalatesTo?: string;
  estimate?: Estimate;
  repoRoot?: string;
}

export interface TaskCard {
  title: string;
  kind: "implement" | "explore";
  effort: string;
  skills: string[];
  model: string;
  escalatesTo?: string;
  estimate?: Estimate;
  repoRoot?: string;
}

export interface QuotaCard {
  resetText?: string;
  resetAt?: string;
  pausedJobId?: string;
  repoRoot?: string;
  /** Every pool that is cooling down, when no tier could run the job. */
  pools?: { pool: string; resetAt: string }[];
}

export type QuotaChoice = "retry" | "continue_without" | "wait";

export interface PromoteCard {
  lessonText: string;
  hits: number;
  targetFile: string;
  repoRoot?: string;
}

export function promoteCardText(c: PromoteCard): string {
  return `Add a learned rule to the gemini-delegation skill?\n"${c.lessonText}" (seen ${c.hits}×)\n→ ${c.targetFile}`;
}

export interface Approver {
  plan(c: PlanCard): Promise<boolean>;
  task(c: TaskCard): Promise<boolean>;
  quota(c: QuotaCard): Promise<QuotaChoice | "unavailable">;
  promote(c: PromoteCard): Promise<boolean>;
  isClientMode?(repoRoot: string): boolean;
}

export class ApprovalUnavailable extends Error {}

function formatK(tokens: number): string {
  const val = Math.round((tokens / 1000) * 10) / 10;
  return `${val}k`;
}

function escalatePart(c: { escalatesTo?: string }): string {
  return c.escalatesTo ? `\nIf tests fail: one retry on ${c.escalatesTo}` : "";
}

export function planCardText(c: PlanCard): string {
  const estimatePart = c.estimate
    ? `\nDoing it myself: ~${formatK(c.estimate.directTokens)} tokens · Delegating: ~${formatK(c.estimate.delegateOverheadTokens)} tokens`
    : "";
  const stepsPart = c.steps.length === 0 ? "all steps" : c.steps.join(", ");
  return `Delegate plan "${c.title}" to ${modelLabel(c.model, c.effort as Effort | undefined)}?\n${c.planFile} · steps for Gemini: ${stepsPart}${escalatePart(c)}${estimatePart}`;
}

export function taskCardText(c: TaskCard): string {
  const skillsPart = c.skills && c.skills.length > 0 ? ` · skills: ${c.skills.join(", ")}` : "";
  const line1 = `Delegate to ${modelLabel(c.model, c.effort as Effort)}? "${c.title}"${skillsPart}`;
  const estimatePart = c.estimate
    ? `\nDoing it myself: ~${formatK(c.estimate.directTokens)} tokens · Delegating: ~${formatK(c.estimate.delegateOverheadTokens)} tokens`
    : "";
  const reasonPart = c.estimate?.reason ? `\nWhy: ${c.estimate.reason}` : "";
  return `${line1}${escalatePart(c)}${estimatePart}${reasonPart}`;
}

function poolResetLabel(resetAt: string): string {
  const d = new Date(resetAt);
  if (isNaN(d.getTime())) return "unknown";
  const hhmm = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  return sameDay ? hhmm : `${d.toLocaleDateString("en-US", { weekday: "short" })} ${hhmm}`;
}

export function quotaCardText(c: QuotaCard): string {
  if (c.pools?.length) {
    const list = c.pools.map((p) => `${p.pool} (resets ${poolResetLabel(p.resetAt)})`).join(", ");
    const paused = c.pausedJobId ? ` Task ${c.pausedJobId} paused, partial work kept.` : "";
    return `Quota reached: ${list}.${paused}`;
  }
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
  isClientMode(_repoRoot?: string): boolean {
    return true;
  }

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

export class RepoApprover implements Approver {
  constructor(
    private o: {
      gateFor: (repoRoot: string) => "elicitation" | "client";
      elicitation: Approver;
      client: Approver;
      defaultRepoRoot: string;
    },
  ) {}

  private approverFor(repoRoot?: string): Approver {
    const root = repoRoot ?? this.o.defaultRepoRoot;
    const gate = this.o.gateFor(root);
    return gate === "client" ? this.o.client : this.o.elicitation;
  }

  async plan(c: PlanCard): Promise<boolean> {
    return this.approverFor(c.repoRoot).plan(c);
  }

  async task(c: TaskCard): Promise<boolean> {
    return this.approverFor(c.repoRoot).task(c);
  }

  async quota(c: QuotaCard): Promise<QuotaChoice | "unavailable"> {
    return this.approverFor(c.repoRoot).quota(c);
  }

  async promote(c: PromoteCard): Promise<boolean> {
    return this.approverFor(c.repoRoot).promote(c);
  }

  isClientMode(repoRoot: string): boolean {
    const root = repoRoot ?? this.o.defaultRepoRoot;
    return this.o.gateFor(root) === "client";
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
