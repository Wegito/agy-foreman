import path from "node:path";
import type { Approver, QuotaChoice } from "./approver.js";
import { FlagStore, hashPlan, type Flags } from "./flags.js";
import type { StartResult } from "./manager.js";
import { TIERS, type ProjectConfig, type Tier } from "../config.js";
import { poolOf } from "../pools.js";

export class DelegationPolicy {
  constructor(
    private flags: FlagStore,
    private approver: Approver,
    private now: () => Date,
  ) {}

  /** Picks the first configured tier at or above `from` whose pool is not cooling down.
   *  Never moves down: a strong request does not fall back to fast. */
  async pickTier(
    tiers: ProjectConfig["tiers"],
    from: Tier,
  ): Promise<{ tier: Tier; model: string } | undefined> {
    return this.pickFrom(await this.flags.read(), tiers, from, this.now().getTime());
  }

  /** pickTier on a fixed flags snapshot and timestamp, so callers can stay consistent. */
  pickFrom(
    flags: Flags,
    tiers: ProjectConfig["tiers"],
    from: Tier,
    nowMs: number,
  ): { tier: Tier; model: string } | undefined {
    for (const tier of TIERS.slice(TIERS.indexOf(from))) {
      const model = tiers[tier];
      if (!model) continue;
      if (!this.isCooling(flags.cooldowns[poolOf(model)], nowMs)) return { tier, model };
    }
    return undefined;
  }

  private isCooling(c: { until: string } | undefined, nowMs: number): boolean {
    return !!c && new Date(c.until).getTime() > nowMs;
  }

  /** Stores a cooldown for one pool of max(60 s, resetInSec ?? 900 s). */
  async markCooling(pool: string, resetInSec?: number, resetText?: string): Promise<void> {
    const cooldownSec = Math.max(60, resetInSec ?? 900);
    const until = new Date(this.now().getTime() + cooldownSec * 1000).toISOString();
    const text = resetText ?? `${Math.ceil(cooldownSec / 60)}m`;
    await this.flags.update((f) => {
      f.cooldowns[pool] = { until, text };
    });
  }

  /** Before a new job. Paused → refused. Otherwise picks a tier at or above `requested`
   *  whose pool is not cooling down (a note says so when it differs from `requested`).
   *  When none is free it shows the quota card: retry clears the cooldowns and returns ok;
   *  continue_without pauses and returns refused ("continue without Gemini"); wait/unavailable
   *  returns the "quota" StartResult. */
  async check(
    repoRoot: string | undefined,
    tiers: ProjectConfig["tiers"],
    requested: Tier,
  ): Promise<
    { ok: true; tier: Tier; model: string; note?: string } | { ok: false; result: StartResult }
  > {
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

    // Never substitute a weaker tier for one the project has not configured.
    if (!tiers[requested]) {
      return {
        ok: false,
        result: {
          state: "refused",
          reason: `no ${requested} tier configured (set models.${requested} in .agy-foreman.json)`,
        },
      };
    }
    const from = requested;
    const nowMs = this.now().getTime();
    const picked = this.pickFrom(flags, tiers, from, nowMs);
    if (picked) return { ok: true, ...this.withNote(picked, tiers, from) };

    const cooling = TIERS.slice(TIERS.indexOf(from))
      .map((t) => tiers[t])
      .filter((m): m is string => !!m)
      .map((m) => poolOf(m))
      .filter((pool, i, all) => all.indexOf(pool) === i)
      .map((pool) => ({ pool, c: flags.cooldowns[pool] }))
      .filter((x) => this.isCooling(x.c, nowMs));
    const pools = cooling.map((x) => ({ pool: x.pool, resetAt: x.c.until }));
    const first = [...cooling].sort((a, b) => a.c.until.localeCompare(b.c.until))[0]?.c;
    if (!first) {
      // Unreachable with a consistent snapshot; run rather than crash if it ever happens.
      return { ok: true, tier: from, model: tiers[from] as string };
    }

    let choice: QuotaChoice | "unavailable";
    try {
      choice = await this.approver.quota({
        resetText: first.text,
        resetAt: first.until,
        repoRoot,
        pools,
      });
    } catch {
      choice = "unavailable";
    }

    if (choice === "retry") {
      await this.choose("retry");
      const again = await this.pickTier(tiers, from);
      if (again) return { ok: true, ...this.withNote(again, tiers, from) };
      return { ok: true, tier: from, model: tiers[from] as string };
    } else if (choice === "continue_without") {
      await this.choose("continue_without");
      return {
        ok: false,
        result: {
          state: "refused",
          reason: "continue without Gemini",
        },
      };
    }
    // "wait" or "unavailable"
    return {
      ok: false,
      result: {
        state: "quota",
        reason: "Gemini quota active",
        quota: {
          resetText: first.text,
          resetAt: first.until,
        },
        options: ["retry", "continue_without", "wait"],
      },
    };
  }

  private withNote(
    picked: { tier: Tier; model: string },
    tiers: ProjectConfig["tiers"],
    from: Tier,
  ): { tier: Tier; model: string; note?: string } {
    if (picked.tier === from) return picked;
    const skipped = poolOf(tiers[from] as string);
    return {
      ...picked,
      note: `${skipped} is cooling down; running on ${picked.tier} (${picked.model})`,
    };
  }

  /** After a run hit the quota: stores a cooldown of max(60 s, resetInSec ?? 900 s) on the
   *  pool (Gemini Models when the caller gives none), shows the quota card, applies the choice
   *  (same as choose) and returns it. With `pools` the card names those pools and their resets.
   *  Never throws. */
  async onQuota(o: {
    resetInSec?: number;
    resetText?: string;
    pausedJobId?: string;
    repoRoot?: string;
    pool?: string;
    pools?: string[];
  }): Promise<QuotaChoice | "unavailable"> {
    try {
      const pool = o.pool ?? "Gemini Models";
      await this.markCooling(pool, o.resetInSec, o.resetText);
      const cooldowns = (await this.flags.read()).cooldowns;
      const cd = cooldowns[pool];
      const pools = o.pools
        ?.filter((p) => cooldowns[p])
        .map((p) => ({ pool: p, resetAt: cooldowns[p].until }));

      let choice: QuotaChoice | "unavailable" = "unavailable";
      try {
        choice = await this.approver.quota({
          resetText: cd.text,
          resetAt: cd.until,
          pausedJobId: o.pausedJobId,
          repoRoot: o.repoRoot,
          ...(pools?.length ? { pools } : {}),
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

  /** retry: clear every pool's cooldown. continue_without: pause delegation. wait: nothing. */
  async choose(choice: QuotaChoice): Promise<void> {
    if (choice === "retry") {
      await this.flags.update((f) => {
        f.cooldowns = {};
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

  async state(): Promise<{
    delegation: "active" | "paused";
    cooldowns: { pool: string; until: string; resetText?: string }[];
  }> {
    const flags = await this.flags.read();
    const nowMs = this.now().getTime();
    return {
      delegation: flags.delegationPaused ? "paused" : "active",
      cooldowns: Object.entries(flags.cooldowns)
        .filter(([, c]) => this.isCooling(c, nowMs))
        .map(([pool, c]) => ({ pool, until: c.until, resetText: c.text })),
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
