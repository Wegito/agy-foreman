import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FlagStore, hashPlan, validGrant, type Flags } from "../../src/jobs/flags.js";

describe("flags", () => {
  it("defaults, updates atomically and serializes concurrent updates", async () => {
    const fs = new FlagStore(
      path.join(mkdtempSync(path.join(os.tmpdir(), "foreman-flags-")), "flags.json"),
    );
    expect(await fs.read()).toEqual({ delegationPaused: false, grants: [], cooldowns: {} });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        fs.update((f) => {
          f.grants.push({
            file: `/p${i}.md`,
            hash: "h",
            steps: [1],
            approvedAt: "",
            expiresAt: "",
          });
        }),
      ),
    );
    expect((await fs.read()).grants).toHaveLength(10);
    await fs.update((f) => ({ ...f, delegationPaused: true }));
    expect((await fs.read()).delegationPaused).toBe(true);
  });

  it("hashes plans and validates grants by file, hash and expiry", () => {
    expect(hashPlan("a")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPlan("a")).not.toBe(hashPlan("b"));
    const file = path.join(os.tmpdir(), "plan.md");
    const f: Flags = {
      delegationPaused: false,
      cooldowns: {},
      grants: [
        {
          file,
          hash: "h1",
          steps: [5],
          approvedAt: "2026-10-17T10:00:00Z",
          expiresAt: "2026-10-18T10:00:00Z",
        },
      ],
    };
    const now = new Date("2026-10-17T12:00:00Z");
    expect(validGrant(f, file, "h1", now)?.steps).toEqual([5]);
    expect(validGrant(f, file, "h2", now)).toBeUndefined();
    expect(validGrant(f, file + "x", "h1", now)).toBeUndefined();
    expect(validGrant(f, file, "h1", new Date("2026-10-19T00:00:00Z"))).toBeUndefined();
  });

  it("reads a legacy single cooldown as the Gemini Models pool and drops it on update", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "foreman-flags-")), "flags.json");
    writeFileSync(
      file,
      JSON.stringify({
        cooldownUntil: "2026-10-17T13:00:00Z",
        cooldownText: "1h",
        delegationPaused: false,
        grants: [],
      }),
    );
    const store = new FlagStore(file);
    const f = await store.read();
    expect(f.cooldowns).toEqual({ "Gemini Models": { until: "2026-10-17T13:00:00Z", text: "1h" } });
    await store.update((x) => {
      x.delegationPaused = true;
    });
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw.cooldownUntil).toBeUndefined();
    expect(raw.cooldownText).toBeUndefined();
    expect(raw.cooldowns["Gemini Models"].until).toBe("2026-10-17T13:00:00Z");
  });
});
