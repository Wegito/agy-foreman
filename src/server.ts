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
import type { ActInput, JobManager, StartInput } from "./jobs/manager.js";
import { renderProgressLine } from "./jobs/progress.js";

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
  constructor(
    private server: McpServer,
    private logFile?: string,
  ) {}

  async promote(c: PromoteCard): Promise<boolean> {
    if (!this.server.server.getClientCapabilities()?.elicitation) {
      throw new ApprovalUnavailable(
        "client does not support approval cards; set gate: client in .agy-orchestrator.json",
      );
    }
    return this.confirm(promoteCardText(c));
  }

  async plan(c: PlanCard): Promise<boolean> {
    if (!this.server.server.getClientCapabilities()?.elicitation) {
      throw new ApprovalUnavailable(
        "client does not support approval cards; set gate: client in .agy-orchestrator.json",
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
    const res = await this.server.server.elicitInput({
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
    if (!this.server.server.getClientCapabilities()?.elicitation) {
      throw new ApprovalUnavailable(
        "client does not support approval cards; set gate: client in .agy-orchestrator.json",
      );
    }
    return this.confirm(taskCardText(c));
  }

  async quota(c: QuotaCard): Promise<QuotaChoice | "unavailable"> {
    if (!this.server.server.getClientCapabilities()?.elicitation) {
      return "unavailable";
    }
    try {
      const res = await this.server.server.elicitInput({
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
    name: "agy-orchestrator",
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
      inputSchema: {
        repo: z.string().optional().describe("Repository root path"),
        kind: z.enum(["implement", "explore"]).describe("Task kind"),
        task: z.string().optional().describe("Task description"),
        plan: z
          .object({
            file: z.string().describe("Plan file"),
            step: z.number().describe("Step number"),
            delegate_steps: z.array(z.number()).optional().describe("Steps for Gemini"),
          })
          .optional()
          .describe("Plan step specification"),
        contract_tests: z
          .array(
            z.object({
              path: z.string().describe("Test file path"),
              content: z.string().describe("Test file content"),
            }),
          )
          .optional()
          .describe("Contract tests"),
        skills: z.array(z.string()).optional().describe("Skills to use"),
        estimate: z
          .object({
            direct_tokens: z.number().describe("Direct tokens"),
            delegate_overhead_tokens: z.number().describe("Delegation overhead"),
            reason: z.string().describe("Estimate reason"),
          })
          .optional()
          .describe("Token estimate"),
        effort: z.enum(["low", "medium", "high"]).optional().describe("Effort level"),
        dry_run: z.boolean().optional().describe("Dry run flag"),
        base_ref: z.string().optional().describe("Base git ref"),
      },
    },
    async (args) => {
      const startInput: StartInput = {
        repoRoot: args.repo ?? o.defaultRepoRoot(),
        kind: args.kind,
        task: args.task,
        plan: args.plan
          ? {
              file: args.plan.file,
              step: args.plan.step,
              delegateSteps: args.plan.delegate_steps,
            }
          : undefined,
        contractTests: args.contract_tests?.map((ct) => ({
          path: ct.path,
          content: ct.content,
        })),
        skills: args.skills,
        estimate: args.estimate
          ? {
              directTokens: args.estimate.direct_tokens,
              delegateOverheadTokens: args.estimate.delegate_overhead_tokens,
              reason: args.estimate.reason,
            }
          : undefined,
        effort: args.effort,
        dryRun: args.dry_run,
        baseRef: args.base_ref,
      };
      const res = await manager.start(startInput);
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
            const current = await manager.get(args.job_id);
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
      inputSchema: {
        action: z
          .enum([
            "followup",
            "finalize",
            "cancel",
            "quota_choice",
            "resume_delegation",
            "revoke_plan",
            "lesson",
          ])
          .describe("Action"),
        job_id: z.string().optional().describe("Job ID"),
        feedback: z.string().optional().describe("Feedback"),
        mode: z.enum(["squash", "merge", "discard", "keep"]).optional().describe("Finalize mode"),
        choice: z.enum(["retry", "continue_without", "wait"]).optional().describe("Quota choice"),
        plan_file: z.string().optional().describe("Plan file to revoke"),
        text: z.string().optional().describe("Lesson text"),
        audience: z.enum(["implementer", "orchestrator"]).optional().describe("Audience"),
        scope: z.enum(["project", "global"]).optional().describe("Scope"),
        tags: z.array(z.string()).optional().describe("Tags"),
      },
    },
    async (args) => {
      let actInput: ActInput;
      switch (args.action) {
        case "followup":
          if (!args.job_id || typeof args.feedback !== "string") {
            return {
              isError: true,
              content: [{ type: "text", text: "action 'followup' requires job_id and feedback" }],
            };
          }
          actInput = { action: "followup", jobId: args.job_id, feedback: args.feedback };
          break;
        case "finalize":
          if (!args.job_id || !args.mode) {
            return {
              isError: true,
              content: [{ type: "text", text: "action 'finalize' requires job_id and mode" }],
            };
          }
          actInput = { action: "finalize", jobId: args.job_id, mode: args.mode };
          break;
        case "cancel":
          if (!args.job_id) {
            return {
              isError: true,
              content: [{ type: "text", text: "action 'cancel' requires job_id" }],
            };
          }
          actInput = { action: "cancel", jobId: args.job_id };
          break;
        case "quota_choice":
          if (!args.choice) {
            return {
              isError: true,
              content: [{ type: "text", text: "action 'quota_choice' requires choice" }],
            };
          }
          actInput = { action: "quota_choice", choice: args.choice };
          break;
        case "resume_delegation":
          actInput = { action: "resume_delegation" };
          break;
        case "revoke_plan":
          if (!args.plan_file) {
            return {
              isError: true,
              content: [{ type: "text", text: "action 'revoke_plan' requires plan_file" }],
            };
          }
          actInput = { action: "revoke_plan", planFile: args.plan_file };
          break;
        case "lesson":
          if (typeof args.text !== "string" || !args.audience || !args.scope) {
            return {
              isError: true,
              content: [
                { type: "text", text: "action 'lesson' requires text, audience, and scope" },
              ],
            };
          }
          actInput = {
            action: "lesson",
            text: args.text,
            audience: args.audience,
            scope: args.scope,
            ...(args.tags !== undefined ? { tags: args.tags } : {}),
            ...(args.job_id !== undefined ? { jobId: args.job_id } : {}),
          };
          break;
        default:
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `unknown action: ${(args as { action: string }).action}`,
              },
            ],
          };
      }
      const res = await manager.act(actInput);
      return {
        content: [{ type: "text", text: JSON.stringify(res) }],
      };
    },
  );

  return server;
}
