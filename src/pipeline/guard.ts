import type { StreamEvent } from "../agy/types.js";
import { decide, type GatePolicy } from "./gate.js";

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
    const arg =
      toolParams.TargetFile ??
      toolParams.CommandLine ??
      toolParams.AbsolutePath ??
      toolParams.DirectoryPath ??
      toolParams.SearchDirectory ??
      toolParams.SearchPath ??
      toolParams.Url ??
      toolParams.ServerName ??
      Object.values(toolParams)[0] ??
      "";
    const firstArg = arg ? ` ${arg}` : "";
    return `guard: ${ev.toolName}${firstArg}: ${decision.reason ?? "denied"}`;
  };
}
