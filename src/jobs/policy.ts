import path from "node:path";
import type { Approver, QuotaChoice } from "./approver.js";
import { FlagStore, hashPlan } from "./flags.js";
import type { StartResult } from "./manager.js";

export class DelegationPolicy {
  constructor(
    private flags: FlagStore,
    private approver: Approver,
    private now: () => Date,
  ) {}

  /** Before a new job. Paused → refused. Cooling down → shows the quota card:
   *  retry clears the cooldown and returns ok; continue_without pauses and returns refused
   *  ("continue without Gemini"); wait/unavailable returns the "quota" StartResult. */
  async check(repoRoot?: string): Promise<{ ok: true } | { ok: false; result: StartResult }> {
    const flags = await this.flags.read();
    if (flags.delegationPaused) {
      return {
        ok: false,
        result: {
          state: "refused",
          reason: "delegation is paused; call agy_act resume_delegation to unpause",
        },
      };
    }

    if (flags.cooldownUntil && new Date(flags.cooldownUntil).getTime() > this.now().getTime()) {
      let choice: QuotaChoice | "unavailable";
      try {
        choice = await this.approver.quota({
          resetText: flags.cooldownText,
          resetAt: flags.cooldownUntil,
          repoRoot,
        });
      } catch {
        choice = "unavailable";
      }

      if (choice === "retry") {
        await this.choose("retry");
        return { ok: true };
      } else if (choice === "continue_without") {
        await this.choose("continue_without");
        return {
          ok: false,
          result: {
            state: "refused",
            reason: "continue without Gemini",
          },
        };
      } else {
        // "wait" or "unavailable"
        return {
          ok: false,
          result: {
            state: "quota",
            reason: "Gemini quota active",
            quota: {
              resetText: flags.cooldownText,
              resetAt: flags.cooldownUntil,
            },
            options: ["retry", "continue_without", "wait"],
          },
        };
      }
    }

    return { ok: true };
  }

  /** After a run hit the quota: stores a cooldown of max(60 s, resetInSec ?? 900 s), shows the
   *  quota card, applies the choice (same as choose) and returns it. Never throws. */
  async onQuota(o: {
    resetInSec?: number;
    resetText?: string;
    pausedJobId?: string;
    repoRoot?: string;
  }): Promise<QuotaChoice | "unavailable"> {
    try {
      const resetInSec = o.resetInSec ?? 900;
      const cooldownSec = Math.max(60, resetInSec);
      const cooldownUntil = new Date(this.now().getTime() + cooldownSec * 1000).toISOString();
      const cooldownText = o.resetText ?? `${Math.ceil(cooldownSec / 60)}m`;

      await this.flags.update((f) => {
        f.cooldownUntil = cooldownUntil;
        f.cooldownText = cooldownText;
      });

      let choice: QuotaChoice | "unavailable" = "unavailable";
      try {
        choice = await this.approver.quota({
          resetText: cooldownText,
          resetAt: cooldownUntil,
          pausedJobId: o.pausedJobId,
          repoRoot: o.repoRoot,
        });
      } catch {
        choice = "unavailable";
      }

      if (choice === "retry" || choice === "continue_without" || choice === "wait") {
        await this.choose(choice);
      }
      return choice;
    } catch {
      return "unavailable";
    }
  }

  /** retry: clear cooldown. continue_without: pause delegation. wait: nothing. */
  async choose(choice: QuotaChoice): Promise<void> {
    if (choice === "retry") {
      await this.flags.update((f) => {
        delete f.cooldownUntil;
        delete f.cooldownText;
      });
    } else if (choice === "continue_without") {
      await this.flags.update((f) => {
        f.delegationPaused = true;
      });
    }
  }

  async resume(): Promise<void> {
    await this.flags.update((f) => {
      f.delegationPaused = false;
    });
  }

  async state(): Promise<{ delegation: "active" | "paused"; cooldown?: { until: string; resetText?: string } }> {
    const flags = await this.flags.read();
    const delegation = flags.delegationPaused ? "paused" : "active";
    const cooldown =
      flags.cooldownUntil && new Date(flags.cooldownUntil).getTime() > this.now().getTime()
        ? { until: flags.cooldownUntil, resetText: flags.cooldownText }
        : undefined;
    return {
      delegation,
      ...(cooldown ? { cooldown } : {}),
    };
  }
}

export class PlanGrants {
  private ttlMs: number;

  constructor(
    private flags: FlagStore,
    private now: () => Date,
    ttlMs?: number,
  ) {
    this.ttlMs = ttlMs ?? 24 * 60 * 60 * 1000;
  }

  /** True when a live grant exists for this plan file (resolved against repoRoot, compared
   *  case-insensitively on Windows), with the same content hash, covering this step.
   *  A grant with an empty steps list covers every step. */
  async covers(repoRoot: string, file: string, content: string, step: number): Promise<boolean> {
    const normFile = path.resolve(repoRoot, file);
    const compareFile = process.platform === "win32" ? normFile.toLowerCase() : normFile;
    const hash = hashPlan(content);
    const flags = await this.flags.read();

    const grant = flags.grants.find((g) => {
      const gNorm = path.resolve(g.file);
      const gCompare = process.platform === "win32" ? gNorm.toLowerCase() : gNorm;
      if (gCompare !== compareFile) return false;
      if (g.hash !== hash) return false;
      const expiresMs = new Date(g.expiresAt).getTime();
      if (isNaN(expiresMs) || expiresMs <= this.now().getTime()) return false;
      if (g.steps.length === 0 || g.steps.includes(step)) return true;
      return false;
    });

    return !!grant;
  }

  async grant(repoRoot: string, file: string, content: string, steps: number[]): Promise<void> {
    const normFile = path.resolve(repoRoot, file);
    const hash = hashPlan(content);
    const approvedAt = this.now().toISOString();
    const expiresAt = new Date(this.now().getTime() + this.ttlMs).toISOString();

    await this.flags.update((f) => {
      f.grants.push({
        file: normFile,
        hash,
        steps,
        approvedAt,
        expiresAt,
      });
    });
  }

  /** Removes all grants for this plan file in this repo. Returns how many were removed. */
  async revoke(repoRoot: string, file: string): Promise<number> {
    const normFile = path.resolve(repoRoot, file);
    const compareFile = process.platform === "win32" ? normFile.toLowerCase() : normFile;
    let removed = 0;

    await this.flags.update((f) => {
      const before = f.grants.length;
      f.grants = f.grants.filter((g) => {
        const gNorm = path.resolve(g.file);
        const gCompare = process.platform === "win32" ? gNorm.toLowerCase() : gNorm;
        return gCompare !== compareFile;
      });
      removed = before - f.grants.length;
    });

    return removed;
  }
}
