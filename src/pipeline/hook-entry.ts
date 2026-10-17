import { appendFileSync, readFileSync } from "node:fs";
import { decide, type GatePolicy } from "./gate.js";

function main() {
  try {
    const stdin = readFileSync(0, "utf8");
    const parsed = JSON.parse(stdin);
    const toolCall = parsed.toolCall ?? {};
    const name = String(toolCall.name ?? "");
    const args = (toolCall.args ?? {}) as Record<string, unknown>;

    const policyUrl = new URL("./agyo-policy.json", import.meta.url);
    const policy = JSON.parse(readFileSync(policyUrl, "utf8")) as GatePolicy;

    const res = decide(policy, { name, args });

    const argVal = args.TargetFile ?? args.CommandLine ?? args.AbsolutePath ?? "";
    const arg = String(argVal).slice(0, 200);

    const logEntry = {
      t: new Date().toISOString(),
      name,
      decision: res.decision,
      ...(res.reason ? { reason: res.reason } : {}),
      arg,
    };

    const reviewUrl = new URL("./agyo-review.jsonl", import.meta.url);
    appendFileSync(reviewUrl, JSON.stringify(logEntry) + "\n", "utf8");

    process.stdout.write(JSON.stringify(res));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      JSON.stringify({
        decision: "deny",
        reason: `agyo gate error: ${message}`,
      }),
    );
  }
}

main();
