import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Regression (found live): the status-line entry ran inside the bundled MCP server, ate its stdin
// and exited, so Claude Code timed out connecting. The built server must answer `initialize`.
describe("built MCP server", () => {
  it("answers an MCP initialize request over stdio", async () => {
    // Inside the repo so the bundle's external imports resolve from node_modules.
    const tmp = path.join(root, "test", ".tmp");
    mkdirSync(tmp, { recursive: true });
    const out = mkdtempSync(path.join(tmp, "serve-"));
    execFileSync(
      process.execPath,
      [path.join(root, "node_modules", "tsup", "dist", "cli-default.js"), "--out-dir", out],
      {
        cwd: root,
        stdio: "pipe",
      },
    );
    const child = spawn(process.execPath, [path.join(out, "index.js"), "serve"], {
      cwd: mkdtempSync(path.join(os.tmpdir(), "agyo-serve-cwd-")),
      env: {
        ...process.env,
        AGYO_STATE_DIR: mkdtempSync(path.join(os.tmpdir(), "agyo-serve-state-")),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      }) + "\n",
    );
    const deadline = Date.now() + 15_000;
    while (!stdout.includes('"id":1') && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 100));
    const alive = child.exitCode === null;
    child.kill();
    expect(stdout).toContain('"serverInfo"');
    expect(alive).toBe(true);
  }, 60_000);
});
