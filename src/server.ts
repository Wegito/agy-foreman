import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ApprovalUnavailable,
  planCardText,
  taskCardText,
  quotaCardText,
  promoteCardText,
  type Approver,
  type PlanCard,
  type TaskCard,
  type QuotaCard,
  type QuotaChoice,
  type PromoteCard,
} from "./jobs/approver.js";
import type { JobManager } from "./jobs/manager.js";
import { renderProgressLine } from "./jobs/progress.js";
import { actShape, parseActInput, startShape, toStartInput } from "./tool-inputs.js";

export const TOOL_NAMES: readonly ["agy_status", "agy_start", "agy_get", "agy_act"] = [
  "agy_status",
  "agy_start",
  "agy_get",
  "agy_act",
] as const;

/** Answers faster than this can't come from a person reading the card (e.g. client auto mode). */
export const HUMAN_MIN_MS = 700;

export class ElicitationApprover implements Approver {
  /** @param logFile JSONL log of every card: what was asked, the answer, and how fast it came. */
  /** @param server the MCP server, or a getter when the server is created after the approver. */
  constructor(
    private server: McpServer | (() => McpServer),
    private logFile?: string,
  ) {}

  private mcp(): McpServer {
    return typeof this.server === "function" ? this.server() : this.server;
  }

  async promote(c: PromoteCard): Promise<boolean> {
    if (!this.mcp().server.getClientCapabilities()?.elicitation) {
      throw new ApprovalUnavailable(
        "client does not support approval cards; set gate: client in .agy-foreman.json",
      );
    }
    return this.confirm(promoteCardText(c));
  }

  async plan(c: PlanCard): Promise<boolean> {
    if (!this.mcp().server.getClientCapabilities()?.elicitation) {
      throw new ApprovalUnavailable(
        "client does not support approval cards; set gate: client in .agy-foreman.json",
      );
    }
    return this.confirm(planCardText(c));
  }

  /**
   * Accept = approve, Decline/Cancel = deny. The optional checkbox defaults to true, so a plain
   * Accept works even when the client doesn't pre-fill defaults (Claude Code showed
   * "decision not set" for a required enum field).
   */
  private async confirm(message: string): Promise<boolean> {
    const started = Date.now();
    const res = await this.mcp().server.elicitInput({
      mode: "form",
      message: `${message}\n\nAccept to approve, Decline to deny.`,
      requestedSchema: {
        type: "object",
        properties: {
          approve: { type: "boolean", title: "Approve", default: true },
        },
      },
    });
    const approved =
      res.action === "accept" &&
      (res.content as { approve?: boolean } | undefined)?.approve !== false;
    const ms = Date.now() - started;
    if (this.logFile) {
      try {
        mkdirSync(path.dirname(this.logFile), { recursive: true });
        appendFileSync(
          this.logFile,
          JSON.stringify({
            at: new Date(started).toISOString(),
            card: message.split("\n")[0].slice(0, 120),
            action: res.action,
            approved,
            ms,
            autoAnsweredSuspected: ms < HUMAN_MIN_MS,
          }) + "\n",
        );
      } catch {
        // logging must never break approval
      }
    }
    return approved;
  }

  async task(c: TaskCard): Promise<boolean> {
    if (!this.mcp().server.getClientCapabilities()?.elicitation) {
      throw new ApprovalUnavailable(
        "client does not support approval cards; set gate: client in .agy-foreman.json",
      );
    }
    return this.confirm(taskCardText(c));
  }

  async quota(c: QuotaCard): Promise<QuotaChoice | "unavailable"> {
    if (!this.mcp().server.getClientCapabilities()?.elicitation) {
      return "unavailable";
    }
    try {
      const res = await this.mcp().server.elicitInput({
        mode: "form",
        message: quotaCardText(c),
        requestedSchema: {
          type: "object",
          properties: {
            choice: {
              type: "string",
              title: "What next?",
              enum: ["retry", "continue_without", "wait"],
              enumNames: ["Retry now", "Continue without Gemini", "Wait for reset"],
              default: "wait",
            },
          },
        },
      });
      if (
        res.action === "accept" &&
        (res.content as { choice?: QuotaChoice } | undefined)?.choice
      ) {
        return (res.content as { choice: QuotaChoice }).choice;
      }
      return "wait";
    } catch {
      return "wait";
    }
  }
}

export function createServer(
  manager: JobManager,
  o: { defaultRepoRoot: () => string; version: string },
): McpServer {
  const server = new McpServer({
    name: "agy-foreman",
    version: o.version,
  });

  server.registerTool(
    "agy_status",
    {
      description: "Get status of delegation, cooldown, active and queued jobs",
      inputSchema: {
        repo: z.string().optional().describe("Repository root path"),
      },
    },
    async (args) => {
      const res = await manager.status(args.repo ?? o.defaultRepoRoot());
      return {
        content: [{ type: "text", text: JSON.stringify(res) }],
      };
    },
  );

  server.registerTool(
    "agy_start",
    {
      description: "Start an implement or explore delegation job",
      inputSchema: startShape,
    },
    async (args) => {
      const res = await manager.start(toStartInput(args, o.defaultRepoRoot()));
      return {
        content: [{ type: "text", text: JSON.stringify(res) }],
      };
    },
  );

  server.registerTool(
    "agy_get",
    {
      description: "Get job record and diff by job ID",
      inputSchema: {
        job_id: z.string().describe("Job identifier"),
        wait_s: z.number().min(0).max(60).optional().describe("Wait seconds (0-60)"),
        diff_mode: z.enum(["stat", "full", "paths"]).optional().describe("Diff mode"),
        paths: z.array(z.string()).optional().describe("Diff file paths"),
        max_diff_tokens: z.number().optional().describe("Max diff tokens"),
      },
    },
    async (args, extra) => {
      let timer: NodeJS.Timeout | undefined;
      const progressToken = extra._meta?.progressToken;
      if (progressToken !== undefined && args.wait_s && args.wait_s > 0) {
        timer = setInterval(async () => {
          try {
            const current = await manager.peek(args.job_id);
            if (current) {
              await extra.sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress: current.progress.percent,
                  total: 100,
                  message: renderProgressLine(current),
                },
              });
            }
          } catch {
            // ignore notification errors
          }
        }, 5000);
      }

      try {
        const rec = await manager.get(args.job_id, {
          waitSec: args.wait_s,
          diffMode: args.diff_mode,
          paths: args.paths,
          maxDiffTokens: args.max_diff_tokens,
        });
        if (!rec) {
          return {
            isError: true,
            content: [{ type: "text", text: `job not found: ${args.job_id}` }],
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(rec) }],
        };
      } finally {
        if (timer) clearInterval(timer);
      }
    },
  );

  server.registerTool(
    "agy_act",
    {
      description: "Act on a job or delegation state",
      inputSchema: actShape,
    },
    async (args) => {
      const parsed = parseActInput(args);
      if (!parsed.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: parsed.error }],
        };
      }
      const res = await manager.act(parsed.value);
      return {
        content: [{ type: "text", text: JSON.stringify(res) }],
      };
    },
  );

  return server;
}
