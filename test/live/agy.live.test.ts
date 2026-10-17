import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../../src/agy/index.js";
import type { StreamEvent } from "../../src/agy/types.js";
import { loadRuntimeConfig } from "../../src/config.js";

describe("live agy", () => {
  it("answers a trivial prompt with gemini-3.8-flash-low", async () => {
    const rt = loadRuntimeConfig();
    const events: StreamEvent[] = [];
    const o = await run(
      {
        prompt: "Reply with exactly the word: pong. Do not use any tools.",
        cwd: mkdtempSync(path.join(os.tmpdir(), "agyo-live-")),
        model: "gemini-3.8-flash-low",
        mode: "plan",
        timeoutSec: 120,
        agy: { command: rt.agyPath },
      },
      (e) => events.push(e),
    );
    const init = events.find((e) => e.kind === "init");
    console.log(
      "permission_mode:",
      init?.kind === "init" ? init.permissionMode : "n/a",
      "outcome:",
      o.type,
    );
    expect(o.type).toBe("success");
    if (o.type === "success") {
      expect(o.response.toLowerCase()).toContain("pong");
      expect(o.usage.totalTokens).toBeGreaterThan(0);
    }
  });
});
