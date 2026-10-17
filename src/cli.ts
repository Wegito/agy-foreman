import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { ClientModeApprover } from "./jobs/approver.js";
import { renderProgressLine } from "./jobs/progress.js";
import { isTerminal, JobStore, type JobRecord } from "./jobs/store.js";
import { jobsDir, stateDir } from "./paths.js";
import { runCommand, type ExecResult } from "./pipeline/exec.js";
import { createRuntime } from "./runtime.js";
import { createServer, ElicitationApprover } from "./server.js";
import { statusLineText } from "./statusline-main.js";
import {
  claudeSettingsPath,
  installStatusLine,
  previousStatusLine,
  recentJobs,
  renderStatusLine,
  uninstallStatusLine,
  type InstallResult,
} from "./statusline.js";

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  /** Reads piped stdin (statusline only); omitted in tests. */
  stdin?: () => Promise<string>;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export function waitExitCode(state: string): number {
  if (state === "passed") return 0;
  if (
    state === "failed" ||
    state === "conflict" ||
    state === "refused" ||
    state === "denied" ||
    state === "guard_violation"
  ) {
    return 1;
  }
  if (state === "quota") return 2;
  return 3;
}

export function summaryLines(rec: JobRecord): string[] {
  const parts: string[] = [`${rec.id} ${rec.state}`];
  if (rec.envelope?.verify?.counts) {
    const c = rec.envelope.verify.counts;
    const passed = c.tests - (c.failures ?? 0) - (c.errors ?? 0);
    parts.push(`${passed}/${c.tests} tests`);
  }
  if (rec.envelope?.diffStat) {
    const m = rec.envelope.diffStat.match(/(\d+)\s+file/);
    if (m) {
      const count = parseInt(m[1], 10);
      parts.push(`${count} file${count === 1 ? "" : "s"} changed`);
    }
  }
  return [parts.join(" · "), `next: agy_get ${rec.id}`];
}

export function detectTestCommand(repoRoot: string): {
  test_command?: string[];
  setup_command?: string[];
  test_report?: string;
} {
  const pkgPath = path.join(repoRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg?.scripts?.test) {
        const hasLock =
          existsSync(path.join(repoRoot, "package-lock.json")) ||
          existsSync(path.join(repoRoot, "npm-shrinkwrap.json")) ||
          existsSync(path.join(repoRoot, "yarn.lock")) ||
          existsSync(path.join(repoRoot, "pnpm-lock.yaml")) ||
          existsSync(path.join(repoRoot, "bun.lockb")) ||
          existsSync(path.join(repoRoot, "bun.lock"));
        return {
          test_command: ["npm", "test"],
          setup_command: hasLock ? ["npm", "ci"] : ["npm", "install"],
        };
      }
    } catch {
      // ignore
    }
  }

  const pyproject = path.join(repoRoot, "pyproject.toml");
  const pytestIni = path.join(repoRoot, "pytest.ini");
  if (existsSync(pyproject) || existsSync(pytestIni)) {
    return {
      test_command: ["python", "-m", "pytest", "-q", "--junitxml=reports/junit.xml"],
      test_report: "reports/junit.xml",
    };
  }

  const goMod = path.join(repoRoot, "go.mod");
  if (existsSync(goMod)) {
    return {
      test_command: ["go", "test", "./..."],
    };
  }

  const makefile = path.join(repoRoot, "Makefile");
  if (existsSync(makefile)) {
    try {
      const content = readFileSync(makefile, "utf8");
      if (/^test\s*:/m.test(content)) {
        return {
          test_command: ["make", "test"],
        };
      }
    } catch {
      // ignore
    }
  }

  return {};
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function doctor(d: {
  run: (argv: string[]) => Promise<ExecResult>;
  model: string;
  nodeVersion: string;
}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // 1. node (version >= 20)
  const nodeMatch = d.nodeVersion.match(/^v?(\d+)/);
  const nodeMajor = nodeMatch ? parseInt(nodeMatch[1], 10) : 0;
  const nodeOk = nodeMajor >= 20;
  checks.push({
    name: "node",
    ok: nodeOk,
    detail: nodeOk ? d.nodeVersion : `${d.nodeVersion} (Node.js >= 20 required)`,
  });

  // 2. agy (agy --version exits 0)
  let agyOk = false;
  let agyDetail = "";
  try {
    const res = await d.run(["agy", "--version"]);
    agyOk = res.code === 0;
    agyDetail = agyOk ? res.stdout.trim() : res.stderr.trim() || "agy not found";
  } catch (e) {
    agyDetail = (e as Error).message;
  }
  checks.push({
    name: "agy",
    ok: agyOk,
    detail: agyDetail,
  });

  // 3. agy login (agy models exits 0 and output contains model)
  let loginOk = false;
  let loginDetail = "";
  try {
    const res = await d.run(["agy", "models"]);
    if (res.code === 0 && res.stdout.includes(d.model)) {
      loginOk = true;
      loginDetail = `logged in (model ${d.model} available)`;
    } else {
      loginDetail = `model ${d.model} not available or authentication required; run \`agy\` once interactively to log in`;
    }
  } catch (e) {
    loginDetail = `run \`agy\` once interactively to log in: ${(e as Error).message}`;
  }
  checks.push({
    name: "agy login",
    ok: loginOk,
    detail: loginDetail,
  });

  // 4. git (git --version >= 2.38)
  let gitOk = false;
  let gitDetail = "";
  try {
    const res = await d.run(["git", "--version"]);
    const gitMatch = res.stdout.match(/git version (\d+)\.(\d+)/);
    if (res.code === 0 && gitMatch) {
      const major = parseInt(gitMatch[1], 10);
      const minor = parseInt(gitMatch[2], 10);
      gitOk = major > 2 || (major === 2 && minor >= 38);
      gitDetail = gitOk ? res.stdout.trim() : `${res.stdout.trim()} (git >= 2.38 required)`;
    } else {
      gitDetail = res.stderr.trim() || res.stdout.trim() || "git not found";
    }
  } catch (e) {
    gitDetail = (e as Error).message;
  }
  checks.push({
    name: "git",
    ok: gitOk,
    detail: gitDetail,
  });

  return checks;
}

function cliEntry(): string {
  return fileURLToPath(import.meta.url);
}

function statusLineFiles(env: NodeJS.ProcessEnv): { settingsFile: string; wrapFile: string } {
  return {
    settingsFile: claudeSettingsPath(env),
    wrapFile: path.join(stateDir({ env }), "statusline-wrap.json"),
  };
}

function describeInstall(r: InstallResult): string {
  if (r.state === "already_installed") return `status line: already installed (${r.settings})`;
  if (r.state === "wrapped")
    return `status line: installed in ${r.settings}, shown after your existing one (${r.previous})`;
  return `status line: installed in ${r.settings} (restart Claude Code to see it; remove with: agy-orchestrator statusline --uninstall)`;
}

/** Reads all of stdin, giving up after `ms` (Claude Code closes it; a terminal never would). */
export function readStdin(ms = 300): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let data = "";
    const done = () => {
      process.stdin.removeAllListeners("data");
      resolve(data);
    };
    const t = setTimeout(done, ms);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c: string) => (data += c));
    process.stdin.on("end", () => {
      clearTimeout(t);
      done();
    });
  });
}

export async function main(argv: string[], io: Io): Promise<number> {
  const cmd = argv[0] ?? "serve";

  if (cmd === "serve") {
    let server: McpServer;
    const runtime = createRuntime({
      cwd: io.cwd,
      env: io.env,
      approverFor: (gate) =>
        gate === "client"
          ? new ClientModeApprover()
          : new ElicitationApprover(
              server,
              path.join(stateDir({ env: io.env }), "approvals.jsonl"),
            ),
    });
    server = createServer(runtime.manager, {
      defaultRepoRoot: () => io.cwd,
      version: "0.0.1",
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    await new Promise<void>((resolve) => {
      transport.onclose = () => resolve();
      process.stdin.on("close", () => resolve());
      process.stdin.on("end", () => resolve());
    });
    return 0;
  }

  if (cmd === "wait") {
    const id = argv[1];
    let timeoutSec = 3600;
    const timeoutIdx = argv.indexOf("--timeout-sec");
    if (timeoutIdx !== -1 && argv[timeoutIdx + 1]) {
      timeoutSec = parseInt(argv[timeoutIdx + 1], 10);
    }
    const store = new JobStore(jobsDir({ env: io.env }));
    let rec = await store.read(id);
    if (!rec) {
      io.err(`job not found: ${id}`);
      return 3;
    }
    const startMs = Date.now();
    const maxWaitMs = timeoutSec * 1000;
    while (!isTerminal(rec.state)) {
      if (Date.now() - startMs >= maxWaitMs) {
        io.err(`timeout waiting for ${id}`);
        return 3;
      }
      const remaining = maxWaitMs - (Date.now() - startMs);
      await new Promise((r) => setTimeout(r, Math.min(500, Math.max(0, remaining))));
      const updated = await store.read(id);
      if (!updated) {
        io.err(`job not found: ${id}`);
        return 3;
      }
      rec = updated;
    }
    for (const line of summaryLines(rec)) {
      io.out(line);
    }
    return waitExitCode(rec.state);
  }

  if (cmd === "watch") {
    const once = argv.includes("--once");
    const id = argv.slice(1).find((a) => !a.startsWith("--"));
    const store = new JobStore(jobsDir({ env: io.env }));
    while (true) {
      if (id) {
        const rec = await store.read(id);
        if (rec) {
          io.out(renderProgressLine(rec));
        }
        if (once || !rec || isTerminal(rec.state)) {
          return 0;
        }
      } else {
        const all = await store.list();
        const nonTerminal = all.filter((r) => !isTerminal(r.state));
        for (const rec of nonTerminal) {
          io.out(renderProgressLine(rec));
        }
        if (once || nonTerminal.length === 0) {
          return 0;
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  if (cmd === "statusline") {
    const files = statusLineFiles(io.env);
    if (argv.includes("--install")) {
      io.out(describeInstall(await installStatusLine({ ...files, entry: cliEntry() })));
      return 0;
    }
    if (argv.includes("--uninstall")) {
      io.out(`status line: ${await uninstallStatusLine(files)}`);
      return 0;
    }
    // Same output as the slim dist/statusline.js that Claude Code runs.
    const text = await statusLineText({
      env: io.env,
      cwd: io.cwd,
      stdin: io.stdin ? await io.stdin() : "",
      entry: path.join(path.dirname(cliEntry()), "statusline.js"),
    });
    if (text) io.out(text);
    return 0;
  }

  if (cmd === "init") {
    const targetFile = path.join(io.cwd, ".agy-orchestrator.json");
    if (existsSync(targetFile)) {
      io.err(".agy-orchestrator.json already exists");
      return 1;
    }
    const detected = detectTestCommand(io.cwd);
    writeFileSync(targetFile, JSON.stringify(detected, null, 2) + "\n", "utf8");
    io.out(
      "Register with Claude Code:\n  claude mcp add agy-orchestrator -- npx -y agy-orchestrator serve",
    );
    // The status line is on by default; it only touches Claude Code settings when a home dir is known.
    if (
      !argv.includes("--no-statusline") &&
      (io.env.AGYO_CLAUDE_SETTINGS || io.env.USERPROFILE || io.env.HOME)
    ) {
      io.out(
        describeInstall(await installStatusLine({ ...statusLineFiles(io.env), entry: cliEntry() })),
      );
    }
    return 0;
  }

  if (cmd === "doctor") {
    const cfg = loadConfig({ repoRoot: io.cwd, env: io.env });
    const checks = await doctor({
      nodeVersion: process.version,
      model: cfg.project.model,
      run: (args) => runCommand(args, { cwd: io.cwd, env: io.env }),
    });
    for (const c of checks) {
      const mark = c.ok ? "✓" : "✗";
      io.out(`${mark} ${c.name}: ${c.detail}`);
    }
    return checks.some((c) => !c.ok) ? 1 : 0;
  }

  if (cmd === "install-skill") {
    let srcDir = io.env.AGYO_SKILL_SRC;
    if (!srcDir) {
      const candidate = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../skills/gemini-delegation",
      );
      if (existsSync(candidate)) {
        srcDir = candidate;
      } else {
        srcDir = path.join(io.cwd, "skills", "gemini-delegation");
      }
    }
    if (!existsSync(srcDir)) {
      io.err(`skill source not found: ${srcDir}`);
      return 1;
    }

    const isProject = argv.includes("--project");
    const home = io.env.USERPROFILE || io.env.HOME || "";
    const target = isProject
      ? path.join(io.cwd, ".claude", "skills", "gemini-delegation")
      : path.join(home, ".claude", "skills", "gemini-delegation");

    if (existsSync(target)) {
      io.out(`already installed: ${target}`);
      return 1;
    }

    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(srcDir, target, { recursive: true });
    io.out(`installed: ${target}`);
    return 0;
  }

  io.err(`unknown command: ${cmd}`);
  return 1;
}
