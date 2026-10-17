import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { JobManager } from "../src/jobs/manager.js";
import { promoteCardText } from "../src/jobs/approver.js";

describe("agy_act lesson", () => {
  it("maps the lesson action and keeps the schema budget", async () => {
    const log: unknown[] = [];
    const manager = { act: async (i: unknown) => { log.push(i); return { state: "ok" }; }, start: async () => ({}), get: async () => undefined, status: async () => ({}), idle: async () => {} } as unknown as JobManager;
    const server = createServer(manager, { defaultRepoRoot: () => "/repo", version: "0.0.1" });
    const client = new Client({ name: "t", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    await client.callTool({ name: "agy_act", arguments: { action: "lesson", text: "Keep UI local.", audience: "orchestrator", scope: "global", tags: ["kind:implement"], job_id: "t-1" } });
    expect(log[0]).toEqual({ action: "lesson", text: "Keep UI local.", audience: "orchestrator", scope: "global", tags: ["kind:implement"], jobId: "t-1" });
    const { tools } = await client.listTools();
    expect(JSON.stringify(tools).length / 4).toBeLessThan(1500);
  });
  it("renders the promotion card", () => {
    expect(promoteCardText({ lessonText: "Keep UI local.", hits: 3, targetFile: "references/routing.md" }))
      .toBe('Add a learned rule to the gemini-delegation skill?\n"Keep UI local." (seen 3×)\n→ references/routing.md');
  });
});
