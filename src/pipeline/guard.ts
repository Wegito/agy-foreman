import type { StreamEvent } from "../agy/types.js";
import { decide, type GatePolicy } from "./gate.js";
import { toolSubject } from "./toolcall-record.js";

export function makeGuard(policy: GatePolicy): (ev: StreamEvent) => string | null {
  return (ev: StreamEvent): string | null => {
    if (ev.kind !== "step" || ev.stepType !== "tool" || ev.state !== "DONE" || !ev.toolName) {
      return null;
    }
    const toolParams = ev.toolParams ?? {};
    const decision = decide(policy, { name: ev.toolName, args: toolParams });
    if (decision.decision !== "deny") {
      return null;
    }
    const arg = toolSubject(toolParams) ?? "";
    const firstArg = arg ? ` ${arg}` : "";
    return `guard: ${ev.toolName}${firstArg}: ${decision.reason ?? "denied"}`;
  };
}
