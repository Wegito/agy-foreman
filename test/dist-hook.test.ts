import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Regression: tsup code splitting once moved gate code into a shared chunk, so the hook
// copied alone into a worktree could not load and every tool call was denied.
describe("built hook bundle", () => {
  it("is self-contained and decides tool calls when copied alone", () => {
    const out = mkdtempSync(path.join(os.tmpdir(), "agyo-dist-"));
    execFileSync(
      process.execPath,
      [path.join(root, "node_modules", "tsup", "dist", "cli-default.js"), "--out-dir", out],
      {
        cwd: root,
        stdio: "pipe",
      },
    );
    const hook = readFileSync(path.join(out, "agyo-hook.js"), "utf8");
    expect(hook).not.toMatch(/from\s+["']\.\.?\//);

    const agents = path.join(mkdtempSync(path.join(os.tmpdir(), "agyo-iso-")), ".agents");
    execFileSync(process.execPath, [
      "-e",
      `require("node:fs").mkdirSync(${JSON.stringify(agents)})`,
    ]);
    copyFileSync(path.join(out, "agyo-hook.js"), path.join(agents, "agyo-hook.mjs"));
    writeFileSync(
      path.join(agents, "agyo-policy.json"),
      JSON.stringify({
        mode: "implement",
        worktree: path.dirname(agents),
        readOnlyDirs: [],
        protectedGlobs: [],
        allowedCommands: ["npm test"],
        unknownCommands: "deny",
        allowedMcp: [],
        web: false,
      }),
    );
    const decide = (name: string, args: object) =>
      JSON.parse(
        execFileSync(process.execPath, ["agyo-hook.mjs"], {
          cwd: agents,
          input: JSON.stringify({ toolCall: { name, args } }),
          encoding: "utf8",
        }),
      );
    expect(decide("run_command", { CommandLine: "npm test" })).toEqual({
      decision: "auto_approve",
    });
    expect(decide("run_command", { CommandLine: "git push" }).decision).toBe("deny");
  }, 60_000);
});
