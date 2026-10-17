import { describe, it, expect } from "vitest";
import { tokenGate } from "../../src/jobs/tokengate.js";

describe("tokenGate", () => {
  it("requires an estimate", () => {
    expect(tokenGate(undefined, 1.5)).toMatchObject({
      refuse: true,
      reason: expect.stringMatching(/estimate required/),
    });
  });
  it("refuses obvious losers and allows winners", () => {
    const r = tokenGate({ directTokens: 5000, delegateOverheadTokens: 4000, reason: "" }, 1.5);
    expect(r.refuse).toBe(true);
    expect(r.reason).toMatch(/cheaper to do directly/);
    expect(r.reason).toContain("5000");
    expect(
      tokenGate({ directTokens: 18000, delegateOverheadTokens: 4000, reason: "" }, 1.5),
    ).toEqual({ refuse: false });
    expect(
      tokenGate({ directTokens: 6000, delegateOverheadTokens: 4000, reason: "" }, 1.5),
    ).toEqual({ refuse: false });
  });
});
