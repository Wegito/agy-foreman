import { z } from "zod";
import type { ActInput, StartInput } from "./jobs/manager.js";

/** zod raw shapes passed to registerTool as inputSchema (same fields and descriptions as today,
 *  plus `timeout_sec: z.number().int().positive().optional()` on agy_start). */
export const startShape = {
  repo: z.string().optional().describe("Repository root path"),
  kind: z.enum(["implement", "explore"]).describe("Task kind"),
  task: z.string().optional().describe("Task description"),
  timeout_sec: z.number().int().positive().optional().describe("Timeout in seconds"),
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
} satisfies z.ZodRawShape;

export const actShape = {
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
} satisfies z.ZodRawShape;

export type StartArgs = z.infer<z.ZodObject<typeof startShape>>;
export type ActArgs = z.infer<z.ZodObject<typeof actShape>>;

export function toStartInput(args: StartArgs, defaultRepoRoot: string): StartInput {
  return {
    repoRoot: args.repo ?? defaultRepoRoot,
    kind: args.kind,
    task: args.task,
    timeoutSec: args.timeout_sec,
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
}

/** Validates the per-action required fields. Error texts stay exactly as today, e.g.
 *  "action 'followup' requires job_id and feedback". */
export function parseActInput(
  args: ActArgs,
): { ok: true; value: ActInput } | { ok: false; error: string } {
  switch (args.action) {
    case "followup":
      if (!args.job_id || typeof args.feedback !== "string") {
        return {
          ok: false,
          error: "action 'followup' requires job_id and feedback",
        };
      }
      return {
        ok: true,
        value: { action: "followup", jobId: args.job_id, feedback: args.feedback },
      };
    case "finalize":
      if (!args.job_id || !args.mode) {
        return {
          ok: false,
          error: "action 'finalize' requires job_id and mode",
        };
      }
      return {
        ok: true,
        value: { action: "finalize", jobId: args.job_id, mode: args.mode },
      };
    case "cancel":
      if (!args.job_id) {
        return {
          ok: false,
          error: "action 'cancel' requires job_id",
        };
      }
      return {
        ok: true,
        value: { action: "cancel", jobId: args.job_id },
      };
    case "quota_choice":
      if (!args.choice) {
        return {
          ok: false,
          error: "action 'quota_choice' requires choice",
        };
      }
      return {
        ok: true,
        value: { action: "quota_choice", choice: args.choice },
      };
    case "resume_delegation":
      return {
        ok: true,
        value: { action: "resume_delegation" },
      };
    case "revoke_plan":
      if (!args.plan_file) {
        return {
          ok: false,
          error: "action 'revoke_plan' requires plan_file",
        };
      }
      return {
        ok: true,
        value: { action: "revoke_plan", planFile: args.plan_file },
      };
    case "lesson":
      if (typeof args.text !== "string" || !args.audience || !args.scope) {
        return {
          ok: false,
          error: "action 'lesson' requires text, audience, and scope",
        };
      }
      return {
        ok: true,
        value: {
          action: "lesson",
          text: args.text,
          audience: args.audience,
          scope: args.scope,
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          ...(args.job_id !== undefined ? { jobId: args.job_id } : {}),
        },
      };
    default:
      return {
        ok: false,
        error: `unknown action: ${(args as { action: string }).action}`,
      };
  }
}
