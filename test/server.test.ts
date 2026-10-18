import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer, ElicitationApprover, TOOL_NAMES } from "../src/server.js";
import type { JobManager } from "../src/jobs/manager.js";
import { ApprovalUnavailable } from "../src/jobs/approver.js";

function fakeManager(log: unknown[]): JobManager {
  return {
    start: async (i: unknown) => {
      log.push(["start", i]);
      return { state: "running", jobId: "t-1", waitHint: "agy-foreman wait t-1" };
    },
    get: async (id: string) => (id === "t-1" ? { id, state: "passed" } : undefined),
    act: async (i: unknown) => {
      log.push(["act", i]);
      return { state: "ok" };
    },
    status: async () => ({ delegation: "active" }),
    idle: async () => {},
  } as unknown as JobManager;
}

async function connect(manager: JobManager, capabilities: object = {}) {
  const server = createServer(manager, { defaultRepoRoot: () => "/repo", version: "0.0.1" });
  const client = new Client({ name: "test", version: "1" }, { capabilities });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { server, client };
}
const json = (r: { content: unknown }) => JSON.parse((r.content as { text: string }[])[0].text);

describe("MCP server", () => {
  it("exposes exactly the 4 tools within the schema budget", async () => {
    const { client } = await connect(fakeManager([]));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(JSON.stringify(tools).length / 4).toBeLessThan(1500);
  });

  it("maps agy_start snake_case input and defaults the repo", async () => {
    const log: unknown[] = [];
    const { client } = await connect(fakeManager(log));
    const r = await client.callTool({
      name: "agy_start",
      arguments: {
        kind: "implement",
        task: "x",
        estimate: { direct_tokens: 20000, delegate_overhead_tokens: 4000, reason: "r" },
        plan: { file: "p.md", step: 2, delegate_steps: [2, 3] },
        contract_tests: [{ path: "t.test.ts", content: "c" }],
        dry_run: false,
      },
    });
    expect(json(r as { content: unknown })).toMatchObject({ state: "running", jobId: "t-1" });
    expect(log[0]).toEqual([
      "start",
      expect.objectContaining({
        repoRoot: "/repo",
        kind: "implement",
        task: "x",
        dryRun: false,
        estimate: { directTokens: 20000, delegateOverheadTokens: 4000, reason: "r" },
        plan: { file: "p.md", step: 2, delegateSteps: [2, 3] },
        contractTests: [{ path: "t.test.ts", content: "c" }],
      }),
    ]);
  });

  it("returns job records and errors for unknown jobs", async () => {
    const { client } = await connect(fakeManager([]));
    expect(
      json(
        (await client.callTool({ name: "agy_get", arguments: { job_id: "t-1" } })) as {
          content: unknown;
        },
      ),
    ).toMatchObject({ state: "passed" });
    const missing = await client.callTool({ name: "agy_get", arguments: { job_id: "t-9" } });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain("job not found: t-9");
  });

  it("maps agy_act and agy_status", async () => {
    const log: unknown[] = [];
    const { client } = await connect(fakeManager(log));
    await client.callTool({
      name: "agy_act",
      arguments: { action: "finalize", job_id: "t-1", mode: "squash" },
    });
    expect(log[0]).toEqual(["act", { action: "finalize", jobId: "t-1", mode: "squash" }]);
    expect(
      json((await client.callTool({ name: "agy_status", arguments: {} })) as { content: unknown }),
    ).toEqual({ delegation: "active" });
  });
});

describe("ElicitationApprover", () => {
  it("approves only on accept + approve, and maps quota choices", async () => {
    const { server, client } = await connect(fakeManager([]), { elicitation: {} });
    const answers = [
      { action: "accept", content: {} },
      { action: "accept", content: { approve: false } },
      { action: "decline" },
      { action: "accept", content: { choice: "continue_without" } },
      { action: "cancel" },
    ];
    const messages: string[] = [];
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      messages.push(String(req.params.message));
      return answers.shift() as never;
    });
    const a = new ElicitationApprover(server);
    expect(
      await a.plan({ planFile: "p.md", title: "Demo", steps: [1], model: "gemini-3.8-flash" }),
    ).toBe(true);
    expect(
      await a.task({
        title: "t",
        kind: "explore",
        effort: "low",
        skills: [],
        model: "gemini-3.8-flash",
      }),
    ).toBe(false);
    expect(
      await a.task({
        title: "t",
        kind: "explore",
        effort: "low",
        skills: [],
        model: "gemini-3.8-flash",
      }),
    ).toBe(false);
    expect(await a.quota({ resetText: "10m" })).toBe("continue_without");
    expect(await a.quota({ resetText: "10m" })).toBe("wait");
    expect(messages[0]).toContain('Delegate plan "Demo"');
  });

  it("is unavailable without the elicitation capability", async () => {
    const { server } = await connect(fakeManager([]));
    const a = new ElicitationApprover(server);
    await expect(
      a.plan({ planFile: "p", title: "t", steps: [1], model: "gemini-3.8-flash" }),
    ).rejects.toBeInstanceOf(ApprovalUnavailable);
    expect(await a.quota({})).toBe("unavailable");
  });
});
