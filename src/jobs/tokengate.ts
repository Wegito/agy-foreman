import type { Estimate } from "./store.js";

export function tokenGate(
  e: Estimate | undefined,
  ratio: number,
): { refuse: boolean; reason?: string } {
  if (!e) {
    return {
      refuse: true,
      reason: "estimate required: {direct_tokens, delegate_overhead_tokens, reason}",
    };
  }

  const delegatedEffective = e.delegateOverheadTokens * ratio;
  if (delegatedEffective > e.directTokens) {
    return {
      refuse: true,
      reason: `cheaper to do directly: direct ${e.directTokens} tokens vs delegated ${delegatedEffective} tokens (${e.delegateOverheadTokens} * ${ratio})`,
    };
  }

  return { refuse: false };
}
