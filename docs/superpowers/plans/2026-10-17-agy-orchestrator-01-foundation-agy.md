# agy-orchestrator Plan 1: Foundation and `agy` Module, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A forked, cross-platform TypeScript repo whose `agy` module runs the Antigravity CLI headlessly and always returns a typed `Outcome` (success, quota, denied, timeout, guard violation, cancelled, error), tested against a fake agy on Windows, Linux and macOS.

**Architecture:** Fork `sshahzaiib/agy-bridge` (MIT), keep its toolchain and quota detection, and delete its tool/server/model-fallback layer. Build `src/agy/` as one deep module, `run(request, onEvent) → Outcome`, with internal parts for stream parsing (adapted from `PyModel/claude-agy-mcp`, MIT), quota detection, outcome classification and cross-platform process-tree kill. A Node-based fake agy reproduces the behaviour seen in a live agy 1.4.0 run.

**Tech Stack:** TypeScript 5 (strict, ESM, NodeNext), Node ≥ 20, vitest 3, tsup 8, zod 3, prettier 3, GitHub Actions.

## Global Constraints
- Node ≥ 20 (`engines.node: ">=20"`). Must pass on `windows-latest`, `ubuntu-latest` and `macos-latest`.
- Runtime dependencies are limited to `@modelcontextprotocol/sdk` and `zod`.
- Model is a config string, default `gemini-3.8-flash-high`. Effort is limited to `low | medium | high`; reject anything else.
- `--dangerously-skip-permissions` is **off by default**.
- Never read, store or forward agy login tokens, and never switch accounts.
- Always pass `--print-timeout` (agy 1.4.0 defaults to `0s`, meaning no limit).
- Always close agy's stdin (an open stdin hangs agy).
- The prompt passed to `-p` must be under 8,000 characters (Windows command-line limit); real briefs go in files (Plan 2).
- agy's `--log-file` contains the user's email (seen in a live run). It must live in a private temp dir, be deleted after the run, and never be returned to callers.
- MIT license. Keep the upstream copyright lines `Copyright (c) 2026 Shahzaib` (agy-bridge) and `Copyright (c) 2026 elkaix` (claude-agy-mcp).
- Use `process.execPath` + script path to run Node fixtures, never a shebang (Windows).

## Facts from a live agy 1.4.0 run (2026-10-17), used by these tasks
- stream-json events: `init` (`conversation_id`, `init.{model,cwd,tools,permission_mode}`), `step_update` (`step_index`, `state` `ACTIVE|DONE`, `step_type` `user_input|agent_response|tool`, `tool_name`, `tool_info.{name,parameters,output}`, `usage`, `text_delta`), and `result` (`status`, `response`, `duration_seconds`, `num_turns`, `usage`).
- Tool parameter keys: `view_file → AbsolutePath`, `write_to_file → TargetFile`, `run_command → CommandLine`, `call_mcp_tool → ServerName/ToolName/Arguments`.
- When `--print-timeout` hits, stderr says `[agy] print timeout after 15m0s with turn in progress; returning partial output`, and the result is `status: "SUCCESS"` with `response: ""` and exit code 0. **That must be classified as `timeout`, not success.**
- The 429 log line (from agy-bridge tests): `... RESOURCE_EXHAUSTED (code 429): Individual quota reached. ... Resets in 96h53m25s.`
- Headless runs inherit the user's global agy plugins, skills and MCP servers, and the global permission mode (`always-proceed` overrode `--mode plan`). Plan 2 deals with this. Plan 1 only reports `permission_mode` from `init`.

## File Structure (after this plan)
```
agy-orchestrator/
├── LICENSE                     # MIT, upstream + our copyright lines
├── NOTICE                      # attribution for adapted files
├── README.md                   # short; full README in Plan 3
├── package.json  tsconfig.json  tsup.config.ts  vitest.config.ts  vitest.live.config.ts
├── .github/workflows/ci.yml
├── docs/                       # spec, plans, research (copied from the design folder)
├── src/
│   ├── index.ts                # placeholder bin (prints version); MCP server comes in Plan 3
│   ├── config.ts               # project + runtime config (zod)
│   ├── paths.ts                # per-OS state/worktree/jobs dirs
│   └── agy/
│       ├── index.ts            # public interface: run, buildArgs, types
│       ├── types.ts            # RunRequest, Outcome, StreamEvent, AgyResult, AgyUsage
│       ├── stream.ts           # NDJSON stream-json parser (adapted from claude-agy-mcp)
│       ├── quota.ts            # 429 detection + cooldown (forked from agy-bridge)
│       ├── classify.ts         # end-of-run facts → Outcome
│       ├── kill.ts             # cross-platform process-tree kill
│       └── run.ts              # spawn + supervise agy
└── test/
    ├── fixtures/fake-agy.mjs   # scenario-driven fake agy
    ├── fixtures/tree-parent.mjs
    ├── helpers.ts
    ├── config.test.ts  paths.test.ts
    ├── agy/stream.test.ts  quota.test.ts  classify.test.ts  kill.test.ts  run.test.ts
    └── live/agy.live.test.ts   # opt-in, real agy
```

---

### Task 1: Fork and bootstrap the repo

**Files:**
- Create: `agy-orchestrator/` (git clone of agy-bridge), `NOTICE`, `README.md`, `docs/` (copied)
- Modify: `package.json`, `LICENSE`, `tsup.config.ts`, `src/index.ts`
- Delete: `src/server.ts`, `src/tools.ts`, `src/models.ts`, `src/runner.ts`, `test/server.test.ts`, `test/tools.test.ts`, `test/models.test.ts`, `test/runner.test.ts`, `test/e2e-quota.live.test.ts`, `CLAUDE.md`, `SKILL.md`, `Dockerfile`, `.dockerignore`, `glama.json`, `server.json`, `assets/`, `.husky/`, `.commitlintrc.json`

**Interfaces:**
- Consumes: nothing
- Produces: a building repo with `npm run typecheck`, `npm test`, `npm run build` and `npm run format:check`. Upstream history stays reachable as remote `upstream` (for reference: `git show upstream/main:src/runner.ts`).

- [ ] **Step 1: Clone and rename the remote**

Run (Git Bash or Linux shell,):
```bash
git clone https://github.com/sshahzaiib/agy-bridge.git agy-orchestrator
cd agy-orchestrator
git remote rename origin upstream
git checkout -B main
```
Expected: `git remote -v` shows only `upstream`.

- [ ] **Step 2: Delete the layers we replace or don't need**

```bash
git rm -q src/server.ts src/tools.ts src/models.ts src/runner.ts \
  test/server.test.ts test/tools.test.ts test/models.test.ts test/runner.test.ts test/e2e-quota.live.test.ts \
  CLAUDE.md SKILL.md Dockerfile .dockerignore glama.json server.json .commitlintrc.json
git rm -rq assets .husky
mkdir -p src/agy test/agy test/fixtures test/live
git mv src/quota.ts src/agy/quota.ts
git mv test/quota.test.ts test/agy/quota.test.ts
```

- [ ] **Step 3: Replace `package.json`**

```json
{
  "name": "agy-orchestrator",
  "version": "0.0.1",
  "description": "Verified, approval-gated delegation from Claude Code (or any MCP agent) to Gemini 3.8 Flash via the Antigravity CLI.",
  "type": "module",
  "bin": { "agy-orchestrator": "dist/index.js" },
  "files": ["dist", "skills", "README.md", "LICENSE", "NOTICE"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:live": "vitest run --config vitest.live.config.ts",
    "typecheck": "tsc --noEmit",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  },
  "keywords": ["mcp", "claude-code", "antigravity", "agy", "gemini", "delegation"],
  "author": "Mountaser Halak (https://mountaserhalak.com)",
  "license": "MIT",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "prettier": "^3.8.4",
    "tsup": "^8.0.0",
    "typescript": "^5.5.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 4: Update `LICENSE`, add `NOTICE`, set the build target, add a placeholder `src/index.ts`**

In `LICENSE`, replace the line `Copyright (c) 2026 Shahzaib` with:
```
Copyright (c) 2026 Shahzaib
Copyright (c) 2026 elkaix
Copyright (c) 2026 Mountaser Halak
```

Create `NOTICE`:
```
agy-orchestrator
Copyright (c) 2026 Mountaser Halak

This project is a fork of agy-bridge (https://github.com/sshahzaiib/agy-bridge),
Copyright (c) 2026 Shahzaib, MIT License. Files derived from it:
  src/agy/quota.ts, src/config.ts (rewritten), project toolchain.

Portions are adapted from claude-agy-mcp (https://github.com/PyModel/claude-agy-mcp),
Copyright (c) 2026 elkaix, MIT License. Files derived from it:
  src/agy/stream.ts, test/fixtures/fake-agy.mjs.

Not affiliated with Google. "Antigravity" and "Gemini" are trademarks of Google LLC.
```

Replace `tsup.config.ts`:
```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
});
```

Replace `src/index.ts`:
```ts
#!/usr/bin/env node
// Placeholder entry point. The MCP server and CLI commands arrive in Plan 3.
console.log("agy-orchestrator 0.0.1");
```

- [ ] **Step 5: Copy the design docs into the repo and write a short README**

```bash
mkdir -p docs
cp -r "../docs/." docs/
```
Create `README.md`:
```markdown
# agy-orchestrator

Verified, approval-gated delegation from Claude Code (or any MCP agent) to Gemini 3.8 Flash
through the official Antigravity CLI (`agy`) in headless mode.

> Status: under construction (v0.0.1). Design: `docs/superpowers/specs/2026-10-17-agy-orchestrator-v2-design.md`.

Not affiliated with Google. Wrapping `agy` inside another agent is not officially supported on
consumer Antigravity plans. Every run requires your explicit approval; use at your own discretion.
```

- [ ] **Step 6: Install and verify the baseline**

Run:
```bash
npm install
npm run typecheck
npm test
npm run build && node dist/index.js
```
Expected: typecheck passes. Tests: `test/config.test.ts` and `test/agy/quota.test.ts` run. `quota.test.ts` fails on its import path `../src/quota.js`; fix that import to `../../src/agy/quota.js` and re-run until it passes. `config.test.ts` passes for now (it's replaced in Task 3). The last command prints `agy-orchestrator 0.0.1`.

- [ ] **Step 7: Format and commit**

```bash
npm run format
git add -A
git commit -m "chore: fork agy-bridge as agy-orchestrator, strip tool/server/fallback layers"
```

---

### Task 2: CI matrix (Windows, Linux, macOS)

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: npm scripts from Task 1
- Produces: CI running typecheck, tests, build and format check on 3 OSes × Node 20/22

- [ ] **Step 1: Write the workflow**

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, ubuntu-latest, macos-latest]
        node: [20, 22]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      - run: npm run format:check
```

- [ ] **Step 2: Validate locally and commit**

Run: `npm ci && npm run typecheck && npm test && npm run build && npm run format:check`
Expected: all succeed.
```bash
git add .github/workflows/ci.yml
git commit -m "ci: test matrix on windows, linux, macos with node 20 and 22"
```

---

### Task 3: Config (`.agy-orchestrator.json` + environment)

**Files:**
- Modify (rewrite): `src/config.ts`
- Modify (rewrite): `test/config.test.ts`

**Interfaces:**
- Consumes: `zod`
- Produces:
```ts
export const EFFORTS: readonly ["low", "medium", "high"];
export type Effort = "low" | "medium" | "high";
export interface ProjectConfig {
  testCommand?: string[]; setupCommand?: string[]; protectedPaths: string[];
  model: string; effort: Effort; gate: "elicitation" | "client"; approval: "per_plan" | "per_task";
  maxConcurrent: number; maxRunsPerHour: number; refuseRatio: number; skillRoots: string[];
  allowedCommands: string[]; unknownCommands: "ask_user" | "deny" | "allow"; allowedMcp: string[]; web: boolean;
}
export interface RuntimeConfig { agyPath: string; skipPermissions: boolean; sandbox: boolean; defaultTimeoutSec: number; }
export interface Config { project: ProjectConfig; runtime: RuntimeConfig; }
export class ConfigError extends Error {}
export const CONFIG_FILE = ".agy-orchestrator.json";
export function parseProjectConfig(raw: unknown): ProjectConfig;            // throws ConfigError
export function loadRuntimeConfig(env?: Record<string, string | undefined>): RuntimeConfig;
export function loadConfig(opts: { repoRoot?: string; env?: Record<string, string | undefined>;
  readFile?: (path: string) => string | undefined }): Config;
```

- [ ] **Step 1: Write the failing tests**

`test/config.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  parseProjectConfig,
  loadRuntimeConfig,
  loadConfig,
  ConfigError,
  CONFIG_FILE,
} from "../src/config.js";

describe("parseProjectConfig", () => {
  it("applies defaults to an empty object", () => {
    const c = parseProjectConfig({});
    expect(c.model).toBe("gemini-3.8-flash-high");
    expect(c.effort).toBe("high");
    expect(c.gate).toBe("elicitation");
    expect(c.approval).toBe("per_plan");
    expect(c.maxConcurrent).toBe(2);
    expect(c.maxRunsPerHour).toBe(10);
    expect(c.refuseRatio).toBe(1.5);
    expect(c.protectedPaths).toContain("tests/**");
    expect(c.skillRoots).toEqual([".agents/skills", ".claude/skills", "~/.claude/skills"]);
    expect(c.testCommand).toBeUndefined();
    expect(c.allowedCommands).toEqual([]);
    expect(c.unknownCommands).toBe("deny");
    expect(c.allowedMcp).toEqual([]);
    expect(c.web).toBe(false);
  });

  it("validates tool-gate settings", () => {
    expect(parseProjectConfig({ allowed_mcp: ["github/*"], unknown_commands: "allow", web: true }))
      .toMatchObject({ allowedMcp: ["github/*"], unknownCommands: "allow", web: true });
    expect(() => parseProjectConfig({ allowed_mcp: ["socraticode"] })).toThrow(ConfigError);
    expect(() => parseProjectConfig({ unknown_commands: "maybe" })).toThrow(ConfigError);
  });

  it("maps snake_case keys", () => {
    const c = parseProjectConfig({
      test_command: ["npm", "test"],
      setup_command: ["npm", "ci"],
      max_concurrent: 1,
      refuse_ratio: 2,
    });
    expect(c.testCommand).toEqual(["npm", "test"]);
    expect(c.setupCommand).toEqual(["npm", "ci"]);
    expect(c.maxConcurrent).toBe(1);
    expect(c.refuseRatio).toBe(2);
  });

  it("rejects efforts other than low, medium, high", () => {
    expect(() => parseProjectConfig({ effort: "max" })).toThrow(ConfigError);
    expect(() => parseProjectConfig({ effort: "xhigh" })).toThrow(/effort/);
  });

  it("accepts per_task approval and rejects the reserved auto mode", () => {
    expect(parseProjectConfig({ approval: "per_task" }).approval).toBe("per_task");
    expect(() => parseProjectConfig({ approval: "auto" })).toThrow(ConfigError);
  });

  it("rejects an empty test command and unknown gate", () => {
    expect(() => parseProjectConfig({ test_command: [] })).toThrow(ConfigError);
    expect(() => parseProjectConfig({ gate: "auto" })).toThrow(ConfigError);
  });

  it("rejects unknown keys so typos surface", () => {
    expect(() => parseProjectConfig({ tset_command: ["x"] })).toThrow(/tset_command/);
  });
});

describe("loadRuntimeConfig", () => {
  it("defaults skipPermissions to false", () => {
    expect(loadRuntimeConfig({}).skipPermissions).toBe(false);
    expect(loadRuntimeConfig({ AGY_SKIP_PERMISSIONS: "true" }).skipPermissions).toBe(true);
    expect(loadRuntimeConfig({ AGY_SKIP_PERMISSIONS: "1" }).skipPermissions).toBe(false);
  });
  it("reads agy path, sandbox and timeout", () => {
    const r = loadRuntimeConfig({ AGY_PATH: "/opt/agy", AGY_SANDBOX: "true", AGY_TIMEOUT: "90" });
    expect(r).toEqual({ agyPath: "/opt/agy", skipPermissions: false, sandbox: true, defaultTimeoutSec: 90 });
  });
  it("falls back to 1800s for a bad timeout", () => {
    expect(loadRuntimeConfig({ AGY_TIMEOUT: "-3" }).defaultTimeoutSec).toBe(1800);
  });
});

describe("loadConfig", () => {
  it("reads the project file from the repo root", () => {
    const seen: string[] = [];
    const cfg = loadConfig({
      repoRoot: "/repo",
      env: {},
      readFile: (p) => {
        seen.push(p);
        return JSON.stringify({ test_command: ["pytest", "-q"] });
      },
    });
    expect(seen).toEqual([path.join("/repo", CONFIG_FILE)]);
    expect(cfg.project.testCommand).toEqual(["pytest", "-q"]);
  });
  it("uses defaults when the file is missing", () => {
    const cfg = loadConfig({ repoRoot: "/repo", env: {}, readFile: () => undefined });
    expect(cfg.project.model).toBe("gemini-3.8-flash-high");
  });
  it("reports invalid JSON as ConfigError", () => {
    expect(() => loadConfig({ repoRoot: "/r", env: {}, readFile: () => "{nope" })).toThrow(ConfigError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL (`parseProjectConfig` is not exported).

- [ ] **Step 3: Implement `src/config.ts`**

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];
export const CONFIG_FILE = ".agy-orchestrator.json";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const command = z.array(z.string().min(1)).min(1);

const projectSchema = z
  .object({
    test_command: command.optional(),
    setup_command: command.optional(),
    protected_paths: z
      .array(z.string().min(1))
      .default([
        "tests/**",
        "test/**",
        "**/test_*.py",
        "**/*_test.*",
        "**/*.spec.*",
        "**/*.test.*",
        "**/conftest.py",
      ]),
    model: z.string().min(1).default("gemini-3.8-flash-high"),
    effort: z.enum(EFFORTS).default("high"),
    gate: z.enum(["elicitation", "client"]).default("elicitation"),
    // "auto" is reserved for a future fully automatic mode and deliberately rejected in v0.1.
    approval: z.enum(["per_plan", "per_task"]).default("per_plan"),
    max_concurrent: z.number().int().min(1).max(8).default(2),
    max_runs_per_hour: z.number().int().min(1).default(10),
    refuse_ratio: z.number().min(1).default(1.5),
    skill_roots: z.array(z.string().min(1)).default([".agents/skills", ".claude/skills", "~/.claude/skills"]),
    allowed_commands: z.array(z.string().min(1)).default([]),
    unknown_commands: z.enum(["ask_user", "deny", "allow"]).default("deny"),
    allowed_mcp: z.array(z.string().regex(/^[^/]+\/[^/]+$/, "use server/tool or server/*")).default([]),
    web: z.boolean().default(false),
  })
  .strict();

export interface ProjectConfig {
  testCommand?: string[];
  setupCommand?: string[];
  protectedPaths: string[];
  model: string;
  effort: Effort;
  gate: "elicitation" | "client";
  approval: "per_plan" | "per_task";
  maxConcurrent: number;
  maxRunsPerHour: number;
  refuseRatio: number;
  skillRoots: string[];
  allowedCommands: string[];
  unknownCommands: "ask_user" | "deny" | "allow";
  allowedMcp: string[];
  web: boolean;
}

export interface RuntimeConfig {
  agyPath: string;
  skipPermissions: boolean;
  sandbox: boolean;
  defaultTimeoutSec: number;
}

export interface Config {
  project: ProjectConfig;
  runtime: RuntimeConfig;
}

export function parseProjectConfig(raw: unknown): ProjectConfig {
  const parsed = projectSchema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}${"keys" in i ? ` ${(i as { keys: string[] }).keys.join(", ")}` : ""}`)
      .join("; ");
    throw new ConfigError(`Invalid ${CONFIG_FILE}: ${msg}`);
  }
  const p = parsed.data;
  return {
    ...(p.test_command ? { testCommand: p.test_command } : {}),
    ...(p.setup_command ? { setupCommand: p.setup_command } : {}),
    protectedPaths: p.protected_paths,
    model: p.model,
    effort: p.effort,
    gate: p.gate,
    approval: p.approval,
    maxConcurrent: p.max_concurrent,
    maxRunsPerHour: p.max_runs_per_hour,
    refuseRatio: p.refuse_ratio,
    skillRoots: p.skill_roots,
    allowedCommands: p.allowed_commands,
    unknownCommands: p.unknown_commands,
    allowedMcp: p.allowed_mcp,
    web: p.web,
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function loadRuntimeConfig(env: Record<string, string | undefined> = process.env): RuntimeConfig {
  return {
    agyPath: env.AGY_PATH || "agy",
    skipPermissions: env.AGY_SKIP_PERMISSIONS === "true",
    sandbox: env.AGY_SANDBOX === "true",
    defaultTimeoutSec: positiveInt(env.AGY_TIMEOUT, 1800),
  };
}

function defaultReadFile(p: string): string | undefined {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

export function loadConfig(opts: {
  repoRoot?: string;
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => string | undefined;
}): Config {
  const read = opts.readFile ?? defaultReadFile;
  let raw: unknown = {};
  if (opts.repoRoot) {
    const text = read(path.join(opts.repoRoot, CONFIG_FILE));
    if (text !== undefined) {
      try {
        raw = JSON.parse(text);
      } catch (e) {
        throw new ConfigError(`Invalid ${CONFIG_FILE}: ${(e as Error).message}`);
      }
    }
  }
  return { project: parseProjectConfig(raw), runtime: loadRuntimeConfig(opts.env ?? process.env) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/config.test.ts`
Expected: PASS (all tests). If the unknown-key test fails because the message lacks the key name, keep the `keys` join in the error mapping. zod's `unrecognized_keys` issue carries `keys`.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(config): project config file and runtime env with effort limited to low/medium/high"
```

---

### Task 4: Per-OS paths

**Files:**
- Create: `src/paths.ts`, `test/paths.test.ts`

**Interfaces:**
- Produces:
```ts
export interface PathEnv { platform: NodeJS.Platform; env: Record<string, string | undefined>; home: string; }
export function stateDir(p?: Partial<PathEnv>): string;     // .../agy-orchestrator
export function worktreeRoot(p?: Partial<PathEnv>): string; // stateDir/wt
export function jobsDir(p?: Partial<PathEnv>): string;      // stateDir/jobs
export function expandHome(input: string, home?: string): string;
```

- [ ] **Step 1: Write the failing tests**

`test/paths.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { stateDir, worktreeRoot, jobsDir, expandHome } from "../src/paths.js";

describe("stateDir", () => {
  it("uses LOCALAPPDATA on Windows", () => {
    expect(stateDir({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, home: "C:\\Users\\u" }))
      .toBe("C:\\Users\\u\\AppData\\Local\\agy-orchestrator");
  });
  it("falls back to home\\AppData\\Local on Windows", () => {
    expect(stateDir({ platform: "win32", env: {}, home: "C:\\Users\\u" }))
      .toBe("C:\\Users\\u\\AppData\\Local\\agy-orchestrator");
  });
  it("uses XDG_STATE_HOME on Linux", () => {
    expect(stateDir({ platform: "linux", env: { XDG_STATE_HOME: "/x/state" }, home: "/home/u" }))
      .toBe("/x/state/agy-orchestrator");
  });
  it("falls back to ~/.local/state on Linux", () => {
    expect(stateDir({ platform: "linux", env: {}, home: "/home/u" })).toBe("/home/u/.local/state/agy-orchestrator");
  });
  it("uses Application Support on macOS", () => {
    expect(stateDir({ platform: "darwin", env: {}, home: "/Users/u" }))
      .toBe("/Users/u/Library/Application Support/agy-orchestrator");
  });
});

describe("derived dirs", () => {
  it("nests wt and jobs under the state dir", () => {
    const p = { platform: "linux" as const, env: {}, home: "/home/u" };
    expect(worktreeRoot(p)).toBe("/home/u/.local/state/agy-orchestrator/wt");
    expect(jobsDir(p)).toBe("/home/u/.local/state/agy-orchestrator/jobs");
  });
});

describe("expandHome", () => {
  it("expands a leading ~", () => {
    expect(expandHome("~/.claude/skills", "/home/u")).toBe("/home/u/.claude/skills");
    expect(expandHome(".claude/skills", "/home/u")).toBe(".claude/skills");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/paths.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/paths.ts`**

```ts
import os from "node:os";
import path from "node:path";

export interface PathEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
}

const APP = "agy-orchestrator";

function resolveEnv(p: Partial<PathEnv> = {}): PathEnv {
  return { platform: p.platform ?? process.platform, env: p.env ?? process.env, home: p.home ?? os.homedir() };
}

function joinFor(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32.join : path.posix.join;
}

export function stateDir(p?: Partial<PathEnv>): string {
  const { platform, env, home } = resolveEnv(p);
  const join = joinFor(platform);
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), APP);
  if (platform === "darwin") return join(home, "Library", "Application Support", APP);
  return join(env.XDG_STATE_HOME || join(home, ".local", "state"), APP);
}

export function worktreeRoot(p?: Partial<PathEnv>): string {
  const e = resolveEnv(p);
  return joinFor(e.platform)(stateDir(e), "wt");
}

export function jobsDir(p?: Partial<PathEnv>): string {
  const e = resolveEnv(p);
  return joinFor(e.platform)(stateDir(e), "jobs");
}

export function expandHome(input: string, home: string = os.homedir()): string {
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(home, input.slice(2)).replace(/\\/g, home.includes("\\") ? "\\" : "/");
  return input;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/paths.test.ts`
Expected: PASS. If `expandHome` fails on Windows for the POSIX-style test, change its body to choose `path.posix.join` when `home` starts with `/`, else `path.win32.join`, and drop the `replace` call. The test pins the behaviour.

- [ ] **Step 5: Commit**

```bash
git add src/paths.ts test/paths.test.ts
git commit -m "feat(paths): per-OS state, worktree and jobs directories"
```

---

### Task 5: Cross-platform process-tree kill

**Files:**
- Create: `src/agy/kill.ts`, `test/agy/kill.test.ts`, `test/fixtures/tree-parent.mjs`, `test/helpers.ts`

**Interfaces:**
- Produces:
```ts
export interface KillDeps {
  platform: NodeJS.Platform;
  execFile: (file: string, args: string[]) => Promise<void>;
  processKill: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
}
export function treeSpawnOptions(platform?: NodeJS.Platform): { detached: boolean; windowsHide: true };
export async function killTree(pid: number, opts?: { graceMs?: number; deps?: Partial<KillDeps> }): Promise<void>;
export function isAlive(pid: number): boolean;
```
- `test/helpers.ts` produces `waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean>`, `fixture(name: string): string`.

- [ ] **Step 1: Write the fixture and helpers**

`test/fixtures/tree-parent.mjs` (spawns a grandchild, writes its pid, then waits forever):
```js
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const pidFile = process.argv[2];
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(pidFile, String(child.pid));
setInterval(() => {}, 1000);
```

`test/helpers.ts`:
```ts
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): string {
  return path.join(here, "fixtures", name);
}

export async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}
```

- [ ] **Step 2: Write the failing tests**

`test/agy/kill.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { killTree, treeSpawnOptions, isAlive } from "../../src/agy/kill.js";
import { fixture, waitFor } from "../helpers.js";

describe("killTree (unit)", () => {
  it("uses taskkill /T /F on Windows", async () => {
    const calls: string[][] = [];
    await killTree(42, {
      deps: { platform: "win32", execFile: async (f, a) => void calls.push([f, ...a]) },
    });
    expect(calls).toEqual([["taskkill", "/PID", "42", "/T", "/F"]]);
  });

  it("ignores taskkill failure (process already gone)", async () => {
    await expect(
      killTree(42, { deps: { platform: "win32", execFile: async () => { throw new Error("128"); } } }),
    ).resolves.toBeUndefined();
  });

  it("signals the process group on POSIX, escalating to SIGKILL", async () => {
    const sent: [number, string][] = [];
    await killTree(42, {
      graceMs: 10,
      deps: {
        platform: "linux",
        processKill: (pid, sig) => void sent.push([pid, sig]),
        sleep: async () => {},
      },
    });
    expect(sent).toEqual([[-42, "SIGTERM"], [-42, "SIGKILL"]]);
  });

  it("swallows ESRCH on POSIX", async () => {
    const err = Object.assign(new Error("gone"), { code: "ESRCH" });
    await expect(
      killTree(42, { deps: { platform: "linux", processKill: () => { throw err; }, sleep: async () => {} } }),
    ).resolves.toBeUndefined();
  });
});

describe("treeSpawnOptions", () => {
  it("detaches on POSIX only", () => {
    expect(treeSpawnOptions("linux")).toEqual({ detached: true, windowsHide: true });
    expect(treeSpawnOptions("win32")).toEqual({ detached: false, windowsHide: true });
  });
});

describe("killTree (integration)", () => {
  it("kills a parent and its grandchild", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "agyo-kill-"));
    const pidFile = path.join(dir, "gc.pid");
    const parent = spawn(process.execPath, [fixture("tree-parent.mjs"), pidFile], {
      stdio: "ignore",
      ...treeSpawnOptions(),
    });
    expect(await waitFor(() => existsSync(pidFile), 5000)).toBe(true);
    const gc = Number(readFileSync(pidFile, "utf8"));
    expect(isAlive(gc)).toBe(true);

    await killTree(parent.pid!, { graceMs: 500 });

    expect(await waitFor(() => !isAlive(gc), 5000)).toBe(true);
    expect(await waitFor(() => !isAlive(parent.pid!), 5000)).toBe(true);
  }, 15000);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/agy/kill.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `src/agy/kill.ts`**

```ts
import { execFile as execFileCb } from "node:child_process";

export interface KillDeps {
  platform: NodeJS.Platform;
  execFile: (file: string, args: string[]) => Promise<void>;
  processKill: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: KillDeps = {
  platform: process.platform,
  execFile: (file, args) =>
    new Promise((resolve, reject) =>
      execFileCb(file, args, { windowsHide: true }, (err) => (err ? reject(err) : resolve())),
    ),
  processKill: (pid, signal) => process.kill(pid, signal),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Spawn options that make killTree able to reach the whole tree. */
export function treeSpawnOptions(platform: NodeJS.Platform = process.platform): { detached: boolean; windowsHide: true } {
  // POSIX: detached puts the child in its own process group so kill(-pid) reaches grandchildren.
  // Windows: taskkill /T walks the tree; detached would open a new console, so keep it off.
  return { detached: platform !== "win32", windowsHide: true };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function killTree(pid: number, opts: { graceMs?: number; deps?: Partial<KillDeps> } = {}): Promise<void> {
  const d: KillDeps = { ...defaultDeps, ...opts.deps };
  if (d.platform === "win32") {
    try {
      await d.execFile("taskkill", ["/PID", String(pid), "/T", "/F"]);
    } catch {
      // Already exited, or access denied for an exited tree: nothing left to kill.
    }
    return;
  }
  const signalGroup = (sig: NodeJS.Signals): boolean => {
    try {
      d.processKill(-pid, sig);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw e;
    }
  };
  if (!signalGroup("SIGTERM")) return;
  await d.sleep(opts.graceMs ?? 3000);
  signalGroup("SIGKILL");
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/agy/kill.test.ts`
Expected: PASS, including the integration test, on the local OS. CI covers the other two.

- [ ] **Step 6: Commit**

```bash
git add src/agy/kill.ts test/agy/kill.test.ts test/fixtures/tree-parent.mjs test/helpers.ts
git commit -m "feat(agy): cross-platform process-tree kill (taskkill /T /F, POSIX process groups)"
```

---

### Task 6: Stream-json parser

**Files:**
- Create: `src/agy/types.ts`, `src/agy/stream.ts`, `test/agy/stream.test.ts`

**Interfaces:**
- Produces (`types.ts`):
```ts
export interface AgyUsage { inputTokens: number; outputTokens: number; thinkingTokens: number; cacheReadTokens: number; totalTokens: number; }
export const EMPTY_USAGE: AgyUsage;
export interface AgyResult { conversationId?: string; status: string; response: string; error?: string; durationSec: number; numTurns: number; usage: AgyUsage; structuredOutput?: unknown; }
export type StreamEvent =
  | { kind: "init"; conversationId?: string; model?: string; cwd?: string; tools: string[]; permissionMode?: string }
  | { kind: "step"; stepIndex: number; state: string; stepType: string; toolName?: string;
      toolParams?: Record<string, unknown>; toolOutput?: string; textDelta?: string; usage?: AgyUsage }
  | { kind: "result"; result: AgyResult }
  | { kind: "other"; event: string };
```
- Produces (`stream.ts`): `export class StreamParser { push(chunk: string): StreamEvent[]; flush(): StreamEvent[] }`, `export function parseLine(line: string): StreamEvent | null`, `export function usageOf(raw: unknown): AgyUsage`.

- [ ] **Step 1: Write the types**

`src/agy/types.ts`:
```ts
export interface AgyUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

export const EMPTY_USAGE: AgyUsage = {
  inputTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
};

export interface AgyResult {
  conversationId?: string;
  status: string;
  response: string;
  error?: string;
  durationSec: number;
  numTurns: number;
  usage: AgyUsage;
  structuredOutput?: unknown;
}

export type StreamEvent =
  | { kind: "init"; conversationId?: string; model?: string; cwd?: string; tools: string[]; permissionMode?: string }
  | {
      kind: "step";
      stepIndex: number;
      state: string;
      stepType: string;
      toolName?: string;
      toolParams?: Record<string, unknown>;
      toolOutput?: string;
      textDelta?: string;
      usage?: AgyUsage;
    }
  | { kind: "result"; result: AgyResult }
  | { kind: "other"; event: string };
```

- [ ] **Step 2: Write the failing tests (real agy 1.4.0 lines, sanitized)**

`test/agy/stream.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { StreamParser, parseLine, usageOf } from "../../src/agy/stream.js";

const CID = "79e99482-1b43-4003-999d-0137c0dd25cf";
const INIT = JSON.stringify({
  event: "init",
  conversation_id: CID,
  init: { model: "gemini-3.8-flash-high", cwd: "C:\\work\\repo", tools: ["view_file", "write_to_file"], permission_mode: "always-proceed" },
});
const TOOL_WRITE = JSON.stringify({
  event: "step_update",
  step_update: {
    conversation_id: CID, step_index: 72, state: "ACTIVE", step_type: "tool", tool_name: "write_to_file",
    tool_info: { name: "write_to_file", parameters: { TargetFile: "C:\\work\\repo\\src\\a.ts" } },
  },
});
const TOOL_CMD_DONE = JSON.stringify({
  event: "step_update",
  step_update: {
    conversation_id: CID, step_index: 12, state: "DONE", step_type: "tool", tool_name: "run_command", duration_seconds: 0.65,
    tool_info: { name: "run_command", parameters: { CommandLine: "git log -n 5 --oneline" }, output: "abc123 init" },
  },
});
const RESPONSE = JSON.stringify({
  event: "step_update",
  step_update: {
    conversation_id: CID, step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "hello",
    usage: { input_tokens: 16322, output_tokens: 312, thinking_tokens: 250, cache_read_tokens: 0, total_tokens: 16634 },
  },
});
const RESULT = JSON.stringify({
  event: "result",
  result: {
    conversation_id: CID, status: "SUCCESS", response: "", duration_seconds: 883.87, num_turns: 1,
    usage: { input_tokens: 346400, output_tokens: 115067, thinking_tokens: 47803, cache_read_tokens: 7868742, total_tokens: 461467 },
  },
});

describe("parseLine", () => {
  it("parses init", () => {
    expect(parseLine(INIT)).toEqual({
      kind: "init", conversationId: CID, model: "gemini-3.8-flash-high", cwd: "C:\\work\\repo",
      tools: ["view_file", "write_to_file"], permissionMode: "always-proceed",
    });
  });
  it("parses tool steps with parameters", () => {
    expect(parseLine(TOOL_WRITE)).toEqual({
      kind: "step", stepIndex: 72, state: "ACTIVE", stepType: "tool", toolName: "write_to_file",
      toolParams: { TargetFile: "C:\\work\\repo\\src\\a.ts" },
    });
    expect(parseLine(TOOL_CMD_DONE)).toMatchObject({ toolName: "run_command", toolOutput: "abc123 init" });
  });
  it("parses agent responses with usage", () => {
    expect(parseLine(RESPONSE)).toMatchObject({ stepType: "agent_response", textDelta: "hello", usage: { inputTokens: 16322, totalTokens: 16634 } });
  });
  it("parses the result envelope", () => {
    expect(parseLine(RESULT)).toEqual({
      kind: "result",
      result: {
        conversationId: CID, status: "SUCCESS", response: "", durationSec: 883.87, numTurns: 1,
        usage: { inputTokens: 346400, outputTokens: 115067, thinkingTokens: 47803, cacheReadTokens: 7868742, totalTokens: 461467 },
      },
    });
  });
  it("returns null for non-JSON and objects without event", () => {
    expect(parseLine("[agy] something")).toBeNull();
    expect(parseLine("{}")).toBeNull();
  });
  it("keeps unknown events as other", () => {
    expect(parseLine('{"event":"future_thing"}')).toEqual({ kind: "other", event: "future_thing" });
  });
});

describe("StreamParser", () => {
  it("handles lines split across chunks and CRLF", () => {
    const p = new StreamParser();
    const half = Math.floor(INIT.length / 2);
    expect(p.push(INIT.slice(0, half))).toEqual([]);
    const evs = p.push(INIT.slice(half) + "\r\n" + RESULT + "\n");
    expect(evs.map((e) => e.kind)).toEqual(["init", "result"]);
  });
  it("flushes a final line without newline", () => {
    const p = new StreamParser();
    p.push(RESULT);
    expect(p.flush().map((e) => e.kind)).toEqual(["result"]);
  });
});

describe("usageOf", () => {
  it("defaults missing numbers to 0", () => {
    expect(usageOf({ input_tokens: 5 })).toEqual({ inputTokens: 5, outputTokens: 0, thinkingTokens: 0, cacheReadTokens: 0, totalTokens: 0 });
    expect(usageOf(undefined).totalTokens).toBe(0);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/agy/stream.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `src/agy/stream.ts`**

```ts
// Adapted from claude-agy-mcp src/envelope.ts (MIT, Copyright (c) 2026 elkaix).
// Extended with tool names, parameters and outputs, which agy 1.4.0 emits on tool steps.
import { EMPTY_USAGE, type AgyResult, type AgyUsage, type StreamEvent } from "./types.js";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function usageOf(raw: unknown): AgyUsage {
  if (!isObj(raw)) return { ...EMPTY_USAGE };
  return {
    inputTokens: num(raw.input_tokens),
    outputTokens: num(raw.output_tokens),
    thinkingTokens: num(raw.thinking_tokens),
    cacheReadTokens: num(raw.cache_read_tokens),
    totalTokens: num(raw.total_tokens),
  };
}

function resultOf(r: Obj): AgyResult {
  return {
    ...(str(r.conversation_id) ? { conversationId: str(r.conversation_id) } : {}),
    status: str(r.status) ?? "",
    response: str(r.response) ?? "",
    ...(str(r.error) ? { error: str(r.error) } : {}),
    durationSec: num(r.duration_seconds),
    numTurns: num(r.num_turns),
    usage: usageOf(r.usage),
    ...("structured_output" in r ? { structuredOutput: r.structured_output } : {}),
  };
}

export function parseLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let o: unknown;
  try {
    o = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isObj(o)) return null;
  const event = str(o.event);
  if (!event) return null;

  if (event === "init") {
    const init = isObj(o.init) ? o.init : {};
    const conversationId = str(o.conversation_id) ?? str(init.conversation_id);
    return {
      kind: "init",
      ...(conversationId ? { conversationId } : {}),
      ...(str(init.model) ? { model: str(init.model) } : {}),
      ...(str(init.cwd) ? { cwd: str(init.cwd) } : {}),
      tools: Array.isArray(init.tools) ? init.tools.filter((t): t is string => typeof t === "string") : [],
      ...(str(init.permission_mode) ? { permissionMode: str(init.permission_mode) } : {}),
    };
  }

  if (event === "step_update") {
    const s = isObj(o.step_update) ? o.step_update : {};
    const info = isObj(s.tool_info) ? s.tool_info : undefined;
    const toolName = str(s.tool_name) ?? (info ? str(info.name) : undefined);
    return {
      kind: "step",
      stepIndex: num(s.step_index),
      state: str(s.state) ?? "",
      stepType: str(s.step_type) ?? "",
      ...(toolName ? { toolName } : {}),
      ...(info && isObj(info.parameters) ? { toolParams: info.parameters } : {}),
      ...(info && str(info.output) !== undefined ? { toolOutput: str(info.output) } : {}),
      ...(str(s.text_delta) !== undefined ? { textDelta: str(s.text_delta) } : {}),
      ...(s.usage ? { usage: usageOf(s.usage) } : {}),
    };
  }

  if (event === "result") {
    return isObj(o.result) ? { kind: "result", result: resultOf(o.result) } : null;
  }

  return { kind: "other", event };
}

/** Feeds growing stdout and yields whole-line events; never splits a line. */
export class StreamParser {
  private rest = "";

  push(chunk: string): StreamEvent[] {
    const lines = (this.rest + chunk).split("\n");
    this.rest = lines.pop() ?? "";
    return lines.map(parseLine).filter((e): e is StreamEvent => e !== null);
  }

  flush(): StreamEvent[] {
    const last = this.rest;
    this.rest = "";
    const ev = parseLine(last);
    return ev ? [ev] : [];
  }
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/agy/stream.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agy/types.ts src/agy/stream.ts test/agy/stream.test.ts
git commit -m "feat(agy): stream-json parser with tool names and parameters (adapted from claude-agy-mcp)"
```

---

### Task 7: Quota detection (forked) and outcome classification

**Files:**
- Modify: `src/agy/quota.ts` (add a minimum cooldown), `test/agy/quota.test.ts`
- Create: `src/agy/classify.ts`, `test/agy/classify.test.ts`
- Modify: `src/agy/types.ts` (add `Outcome`)

**Interfaces:**
- Consumes: `detectQuota(log: string): QuotaInfo | null` (existing, `QuotaInfo = { resetText?: string; resetSeconds?: number }`), `AgyResult`, `StreamEvent`
- Produces (`types.ts`):
```ts
export type Outcome =
  | { type: "success"; response: string; conversationId?: string; usage: AgyUsage; durationSec: number; structuredOutput?: unknown }
  | { type: "quota"; resetInSec?: number; resetText?: string; conversationId?: string }
  | { type: "denied"; detail: string; conversationId?: string }
  | { type: "timeout"; partialResponse: string; conversationId?: string }
  | { type: "guard_violation"; reason: string; event: StreamEvent; conversationId?: string }
  | { type: "cancelled"; conversationId?: string }
  | { type: "error"; message: string; exitCode: number | null; conversationId?: string };
```
- Produces (`classify.ts`):
```ts
export interface ClassifyInput {
  exitCode: number | null; spawnError?: NodeJS.ErrnoException; stderr: string; log: string;
  result?: AgyResult; conversationId?: string; watchdogFired: boolean; agyCommand: string;
}
export function classify(input: ClassifyInput): Outcome;
export const PRINT_TIMEOUT_RE: RegExp;
```
- Produces (`quota.ts`): `MIN_COOLDOWN_SEC = 60`; `CooldownRegistry.set` clamps to at least 60 s.

- [ ] **Step 1: Add the Outcome type to `src/agy/types.ts`**

Append:
```ts
export type Outcome =
  | { type: "success"; response: string; conversationId?: string; usage: AgyUsage; durationSec: number; structuredOutput?: unknown }
  | { type: "quota"; resetInSec?: number; resetText?: string; conversationId?: string }
  | { type: "denied"; detail: string; conversationId?: string }
  | { type: "timeout"; partialResponse: string; conversationId?: string }
  | { type: "guard_violation"; reason: string; event: StreamEvent; conversationId?: string }
  | { type: "cancelled"; conversationId?: string }
  | { type: "error"; message: string; exitCode: number | null; conversationId?: string };
```

- [ ] **Step 2: Write the failing tests**

Append to `test/agy/quota.test.ts`:
```ts
describe("minimum cooldown", () => {
  it("clamps 'Resets in 0s' to at least 60 seconds", () => {
    let now = 0;
    const reg = new CooldownRegistry(() => now);
    reg.set("gemini", 0);
    now = 59_000;
    expect(reg.cooling("gemini")).toBe(true);
    now = 61_000;
    expect(reg.cooling("gemini")).toBe(false);
  });
});
```

`test/agy/classify.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { classify, type ClassifyInput } from "../../src/agy/classify.js";
import { EMPTY_USAGE } from "../../src/agy/types.js";

const base: ClassifyInput = { exitCode: 0, stderr: "", log: "", watchdogFired: false, agyCommand: "agy" };
const ok = (response: string) => ({ status: "SUCCESS", response, durationSec: 3, numTurns: 1, usage: EMPTY_USAGE });
const LOG_429 = "E1017 log.go:398] RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 2h13m5s.";

describe("classify", () => {
  it("reports a missing binary", () => {
    const o = classify({ ...base, exitCode: null, spawnError: Object.assign(new Error("x"), { code: "ENOENT" }) });
    expect(o).toMatchObject({ type: "error" });
    expect((o as { message: string }).message).toMatch(/agy CLI not found at "agy"/);
  });

  it("returns success for a non-empty SUCCESS response", () => {
    expect(classify({ ...base, result: ok("done"), conversationId: "c1" }))
      .toEqual({ type: "success", response: "done", conversationId: "c1", usage: EMPTY_USAGE, durationSec: 3 });
  });

  it("prefers quota from the log over everything else", () => {
    expect(classify({ ...base, log: LOG_429, result: ok("") })).toEqual({ type: "quota", resetInSec: 7985, resetText: "2h13m5s" });
  });

  it("treats the print-timeout notice as timeout even when status is SUCCESS", () => {
    const stderr = "[agy] print timeout after 15m0s with turn in progress; returning partial output";
    expect(classify({ ...base, stderr, result: ok("") })).toEqual({ type: "timeout", partialResponse: "" });
  });

  it("treats a fired watchdog as timeout", () => {
    expect(classify({ ...base, exitCode: null, watchdogFired: true })).toEqual({ type: "timeout", partialResponse: "" });
  });

  it("maps status ERROR to error with agy's message", () => {
    expect(classify({ ...base, exitCode: 1, result: { ...ok(""), status: "ERROR", error: "invalid model" } }))
      .toMatchObject({ type: "error", message: "invalid model", exitCode: 1 });
  });

  it("maps CANCELED and INTERRUPTED to cancelled", () => {
    expect(classify({ ...base, result: { ...ok(""), status: "CANCELED" } })).toEqual({ type: "cancelled" });
    expect(classify({ ...base, result: { ...ok(""), status: "INTERRUPTED" } })).toEqual({ type: "cancelled" });
  });

  it("maps an empty response with a permission notice to denied", () => {
    const o = classify({ ...base, stderr: "tool run_command requires permission; denied in print mode", result: ok("") });
    expect(o).toMatchObject({ type: "denied" });
  });

  it("maps an empty response without other evidence to error", () => {
    expect(classify({ ...base, result: ok("   ") })).toMatchObject({ type: "error", message: expect.stringMatching(/empty response/) });
  });

  it("maps a non-zero exit with no result to error with stderr", () => {
    expect(classify({ ...base, exitCode: 2, stderr: "boom" })).toMatchObject({ type: "error", message: "boom", exitCode: 2 });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/agy/quota.test.ts test/agy/classify.test.ts`
Expected: FAIL (the min-cooldown test fails; the classify module is missing).

- [ ] **Step 4: Implement the minimum cooldown in `src/agy/quota.ts`**

Add below `DEFAULT_COOLDOWN_SEC`:
```ts
/** agy sometimes reports "Resets in 0s"; never cool down for less than this. */
export const MIN_COOLDOWN_SEC = 60;
```
Replace the body of `CooldownRegistry.set`:
```ts
  set(model: string, resetSeconds: number | undefined): void {
    const sec = Math.max(MIN_COOLDOWN_SEC, resetSeconds ?? DEFAULT_COOLDOWN_SEC);
    this.until.set(model, this.now() + sec * 1000);
  }
```

- [ ] **Step 5: Implement `src/agy/classify.ts`**

```ts
import { detectQuota } from "./quota.js";
import type { AgyResult, Outcome } from "./types.js";

/** Seen live on agy 1.4.0 when --print-timeout fires: exit 0, status SUCCESS, empty response. */
export const PRINT_TIMEOUT_RE = /print timeout after \S+ with turn in progress/;
/** Provisional: the exact soft-deny wording is unverified (Plan 2 records the real text). */
const DENIED_RE = /\b(permission|denied|not allowed|requires approval)\b/i;

export interface ClassifyInput {
  exitCode: number | null;
  spawnError?: NodeJS.ErrnoException;
  stderr: string;
  log: string;
  result?: AgyResult;
  conversationId?: string;
  watchdogFired: boolean;
  agyCommand: string;
}

export function classify(i: ClassifyInput): Outcome {
  const cid = i.conversationId ?? i.result?.conversationId;
  const withCid = <T extends object>(o: T) => (cid ? { ...o, conversationId: cid } : o);

  if (i.spawnError) {
    const message =
      i.spawnError.code === "ENOENT"
        ? `agy CLI not found at "${i.agyCommand}". Install the Antigravity CLI or set AGY_PATH.`
        : `agy failed to start: ${i.spawnError.message}`;
    return { type: "error", message, exitCode: null };
  }

  const quota = detectQuota(i.log) ?? detectQuota(i.stderr);
  if (quota) {
    return withCid({
      type: "quota" as const,
      ...(quota.resetSeconds !== undefined ? { resetInSec: quota.resetSeconds } : {}),
      ...(quota.resetText ? { resetText: quota.resetText } : {}),
    });
  }

  if (i.watchdogFired || PRINT_TIMEOUT_RE.test(i.stderr)) {
    return withCid({ type: "timeout" as const, partialResponse: i.result?.response ?? "" });
  }

  const r = i.result;
  if (r) {
    if (r.status === "ERROR" || r.status === "INVALID") {
      return withCid({ type: "error" as const, message: r.error || `agy status ${r.status}`, exitCode: i.exitCode });
    }
    if (r.status === "CANCELED" || r.status === "INTERRUPTED") return withCid({ type: "cancelled" as const });
    if (r.status === "SUCCESS" && r.response.trim()) {
      return withCid({
        type: "success" as const,
        response: r.response,
        usage: r.usage,
        durationSec: r.durationSec,
        ...(r.structuredOutput !== undefined ? { structuredOutput: r.structuredOutput } : {}),
      });
    }
    if (DENIED_RE.test(i.stderr)) {
      return withCid({ type: "denied" as const, detail: i.stderr.trim().slice(0, 2000) });
    }
    if (i.exitCode === 0 || i.exitCode === null) {
      return withCid({ type: "error" as const, message: `agy returned an empty response (status ${r.status || "unknown"}).`, exitCode: i.exitCode });
    }
  }

  const stderr = i.stderr.trim();
  return withCid({
    type: "error" as const,
    message: stderr ? stderr.slice(0, 2000) : `agy exited with code ${i.exitCode} and no result.`,
    exitCode: i.exitCode,
  });
}
```

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run test/agy/quota.test.ts test/agy/classify.test.ts`
Expected: PASS. The quota fixture `2h13m5s` gives 7985 seconds.

- [ ] **Step 7: Commit**

```bash
git add src/agy/quota.ts src/agy/classify.ts src/agy/types.ts test/agy/quota.test.ts test/agy/classify.test.ts
git commit -m "feat(agy): classify runs into typed outcomes; treat print-timeout SUCCESS as timeout"
```

---

### Task 8: Fake agy fixture

**Files:**
- Create: `test/fixtures/fake-agy.mjs`

**Interfaces:**
- Produces: a Node script run as `node fake-agy.mjs <agy args…>`. The scenario comes from the env var `FAKE_AGY_SCENARIO`. Optional env vars: `FAKE_AGY_ARGSFILE` (writes argv as JSON), `FAKE_AGY_PIDFILE` (grandchild pid), `FAKE_AGY_WRITE` (target path for a `write_to_file` event). Scenarios: `success`, `needs-closed-stdin`, `quota-hang`, `quota-exit`, `print-timeout`, `soft-deny`, `error`, `hang`, `grandchild-hang`, `write-event-hang`.

- [ ] **Step 1: Write the fixture**

`test/fixtures/fake-agy.mjs`:
```js
// Scenario-driven stand-in for `agy -p ... --output-format stream-json`.
// Event shapes copied from a live agy 1.4.0 run. Inspired by claude-agy-mcp's fake-agy (MIT, (c) 2026 elkaix).
import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const scenario = process.env.FAKE_AGY_SCENARIO ?? "success";
const logFile = flag("--log-file");
const model = flag("--model") ?? "gemini-3.8-flash-high";
const cid = flag("--conversation") ?? "fake-0000-conversation";

if (process.env.FAKE_AGY_ARGSFILE) writeFileSync(process.env.FAKE_AGY_ARGSFILE, JSON.stringify(args));

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const log = (line) => logFile && appendFileSync(logFile, line + "\n");
const usage = { input_tokens: 1200, output_tokens: 80, thinking_tokens: 20, cache_read_tokens: 900, total_tokens: 1280 };
const hang = () => setInterval(() => {}, 1000);

const init = () =>
  out({ event: "init", conversation_id: cid, init: { model, cwd: process.cwd(), tools: ["view_file", "write_to_file", "run_command"], permission_mode: "request-review" } });
const step = (i, extra) => out({ event: "step_update", step_update: { conversation_id: cid, step_index: i, state: "DONE", ...extra } });
const result = (status, response, extra = {}) =>
  out({ event: "result", result: { conversation_id: cid, status, response, duration_seconds: 1.5, num_turns: 1, usage, ...extra } });

log("I1017 12:08:01.243347 server.go:1743] Language server version: 1.4.0 (fake)");

function main() {
  switch (scenario) {
    case "success":
      init();
      step(0, { step_type: "user_input" });
      step(1, { step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file", parameters: { AbsolutePath: "src/a.ts" }, output: "10 lines" } });
      step(2, { step_type: "agent_response", text_delta: "done", usage });
      result("SUCCESS", "done");
      return;
    case "quota-hang":
      init();
      log("E1017 12:09:00.000000 log.go:398] agent executor error: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 2h13m5s.");
      hang();
      return;
    case "quota-exit":
      init();
      log("E1017 12:09:00.000000 log.go:398] agent executor error: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 30s.");
      result("SUCCESS", "");
      return;
    case "print-timeout":
      init();
      process.stderr.write("[agy] print timeout after 1s with turn in progress; returning partial output\n");
      result("SUCCESS", "");
      return;
    case "soft-deny":
      init();
      process.stderr.write("tool run_command requires permission; denied in print mode. Add command(npm) to permissions.allow\n");
      result("SUCCESS", "");
      return;
    case "error":
      init();
      result("ERROR", "", { error: "invalid model selection" });
      process.exitCode = 1;
      return;
    case "hang":
      init();
      hang();
      return;
    case "grandchild-hang": {
      init();
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      if (process.env.FAKE_AGY_PIDFILE) writeFileSync(process.env.FAKE_AGY_PIDFILE, String(child.pid));
      hang();
      return;
    }
    case "write-event-hang":
      init();
      out({ event: "step_update", step_update: { conversation_id: cid, step_index: 3, state: "ACTIVE", step_type: "tool", tool_name: "write_to_file", tool_info: { name: "write_to_file", parameters: { TargetFile: process.env.FAKE_AGY_WRITE ?? "tests/a.test.ts" } } } });
      hang();
      return;
    default:
      process.stderr.write(`fake-agy: unknown scenario ${scenario}\n`);
      process.exitCode = 3;
  }
}

if (scenario === "needs-closed-stdin") {
  // Real agy reads stdin until EOF even in print mode; an open stdin hangs it.
  process.stdin.resume();
  process.stdin.on("end", () => {
    init();
    result("SUCCESS", "stdin closed");
  });
} else {
  main();
}
```

- [ ] **Step 2: Smoke-test it by hand**

Run:
```bash
FAKE_AGY_SCENARIO=success node test/fixtures/fake-agy.mjs -p hi --output-format stream-json
```
Expected: 5 JSON lines, ending with `"event":"result"` and `"response":"done"`. On PowerShell, set the variable with `$env:FAKE_AGY_SCENARIO="success"` first.

- [ ] **Step 3: Commit**

```bash
git add test/fixtures/fake-agy.mjs
git commit -m "test: scenario-driven fake agy matching agy 1.4.0 stream-json"
```

---

### Task 9: `agy.run()`: spawn and supervise

**Files:**
- Create: `src/agy/run.ts`, `src/agy/index.ts`, `test/agy/run.test.ts`

**Interfaces:**
- Consumes: `StreamParser` (Task 6), `classify` (Task 7), `killTree`, `treeSpawnOptions` (Task 5), `detectQuota` (quota.ts), `Effort` (config.ts)
- Produces:
```ts
export interface RunRequest {
  prompt: string;                 // < 8000 chars; real briefs live in files
  cwd: string;
  model: string;
  effort?: Effort;
  mode?: "accept-edits" | "plan";
  timeoutSec: number;
  conversationId?: string;
  jsonSchemaPath?: string;
  addDirs?: string[];
  skipPermissions?: boolean;
  sandbox?: boolean;
  agy: { command: string; prefixArgs?: string[] };
  signal?: AbortSignal;
  /** Return a reason string to kill the run immediately (live guard, Plan 2). */
  guard?: (ev: StreamEvent) => string | null;
}
export interface RunDeps {
  spawn: typeof import("node:child_process").spawn;
  killTree: (pid: number) => Promise<void>;
  makeLogPath: () => string;
  readLog: (path: string) => Promise<string>;
  removeLog: (path: string) => Promise<void>;
  pollMs: number;
  graceSec: number;
}
export const MAX_PROMPT_CHARS = 8000;
export function buildArgs(req: RunRequest, logPath: string): string[];
export async function run(req: RunRequest, onEvent?: (ev: StreamEvent) => void, deps?: Partial<RunDeps>): Promise<Outcome>;
```
- `src/agy/index.ts` re-exports `run`, `buildArgs`, `MAX_PROMPT_CHARS`, `killTree`, `CooldownRegistry`, and the types `RunRequest`, `RunDeps`, `Outcome`, `StreamEvent`, `AgyResult`, `AgyUsage`.

- [ ] **Step 1: Write the failing tests**

`test/agy/run.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, buildArgs, MAX_PROMPT_CHARS, type RunRequest } from "../../src/agy/index.js";
import { isAlive } from "../../src/agy/kill.js";
import type { StreamEvent } from "../../src/agy/types.js";
import { fixture, waitFor } from "../helpers.js";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "agyo-run-"));

function req(scenario: string, extra: Partial<RunRequest> = {}, env: Record<string, string> = {}): RunRequest {
  Object.assign(process.env, { FAKE_AGY_SCENARIO: scenario, ...env });
  return {
    prompt: "Execute the task described in .agy-task/brief.md.",
    cwd: tmp(),
    model: "gemini-3.8-flash-high",
    timeoutSec: 20,
    agy: { command: process.execPath, prefixArgs: [fixture("fake-agy.mjs")] },
    ...extra,
  };
}
const fast = { pollMs: 50, graceSec: 1 };

describe("buildArgs", () => {
  it("always includes stream-json, print-timeout and log-file, and no permission bypass by default", () => {
    const a = buildArgs(req("success", { effort: "medium", mode: "accept-edits", conversationId: "c9" }), "/tmp/l.log");
    expect(a).toEqual([
      "-p", "Execute the task described in .agy-task/brief.md.",
      "--output-format", "stream-json",
      "--model", "gemini-3.8-flash-high",
      "--print-timeout", "20s",
      "--log-file", "/tmp/l.log",
      "--effort", "medium",
      "--mode", "accept-edits",
      "--conversation", "c9",
    ]);
    expect(a).not.toContain("--dangerously-skip-permissions");
  });
  it("adds opt-in flags", () => {
    const a = buildArgs(req("success", { skipPermissions: true, sandbox: true, addDirs: ["/x"], jsonSchemaPath: "s.json" }), "l");
    expect(a).toEqual(expect.arrayContaining(["--dangerously-skip-permissions", "--sandbox", "--add-dir", "/x", "--json-schema", "s.json"]));
  });
});

describe("run", () => {
  it("returns success with events streamed to onEvent", async () => {
    const events: StreamEvent[] = [];
    const o = await run(req("success"), (e) => events.push(e), fast);
    expect(o).toMatchObject({ type: "success", response: "done", conversationId: "fake-0000-conversation" });
    expect(events.map((e) => e.kind)).toEqual(["init", "step", "step", "step", "result"]);
  });

  it("closes stdin so agy does not hang", async () => {
    const o = await run(req("needs-closed-stdin", { timeoutSec: 5 }), undefined, fast);
    expect(o).toMatchObject({ type: "success", response: "stdin closed" });
  });

  it("passes the args it built to agy", async () => {
    const argsFile = path.join(tmp(), "args.json");
    await run(req("success", {}, { FAKE_AGY_ARGSFILE: argsFile }), undefined, fast);
    const argv = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    expect(argv).toContain("--print-timeout");
    expect(argv).toContain("stream-json");
    delete process.env.FAKE_AGY_ARGSFILE;
  });

  it("detects quota in the log, kills agy promptly, and returns the reset time", async () => {
    const started = Date.now();
    const o = await run(req("quota-hang", { timeoutSec: 60 }), undefined, fast);
    expect(o).toMatchObject({ type: "quota", resetInSec: 7985, resetText: "2h13m5s" });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it("detects quota when agy exits 0 with an empty response", async () => {
    expect(await run(req("quota-exit"), undefined, fast)).toMatchObject({ type: "quota", resetInSec: 30 });
  });

  it("maps the print-timeout notice to timeout", async () => {
    expect(await run(req("print-timeout"), undefined, fast)).toMatchObject({ type: "timeout" });
  });

  it("maps a soft deny to denied", async () => {
    expect(await run(req("soft-deny"), undefined, fast)).toMatchObject({ type: "denied" });
  });

  it("maps status ERROR to error", async () => {
    expect(await run(req("error"), undefined, fast)).toMatchObject({ type: "error", message: "invalid model selection" });
  });

  it("fires the watchdog on a hang", async () => {
    const o = await run(req("hang", { timeoutSec: 1 }), undefined, { pollMs: 50, graceSec: 0 });
    expect(o).toMatchObject({ type: "timeout" });
  }, 15_000);

  it("cancels on abort and kills the whole tree", async () => {
    const pidFile = path.join(tmp(), "gc.pid");
    const ac = new AbortController();
    const p = run(req("grandchild-hang", { timeoutSec: 60, signal: ac.signal }, { FAKE_AGY_PIDFILE: pidFile }), undefined, fast);
    expect(await waitFor(() => existsSync(pidFile), 5000)).toBe(true);
    const gc = Number(readFileSync(pidFile, "utf8"));
    ac.abort();
    expect(await p).toMatchObject({ type: "cancelled" });
    expect(await waitFor(() => !isAlive(gc), 8000)).toBe(true);
    delete process.env.FAKE_AGY_PIDFILE;
  }, 20_000);

  it("kills immediately when the guard returns a reason", async () => {
    const guard = (e: StreamEvent) =>
      e.kind === "step" && e.toolName === "write_to_file" && String(e.toolParams?.TargetFile).startsWith("tests/")
        ? "write to protected path tests/a.test.ts"
        : null;
    const o = await run(req("write-event-hang", { timeoutSec: 60, guard }), undefined, fast);
    expect(o).toMatchObject({ type: "guard_violation", reason: "write to protected path tests/a.test.ts" });
  }, 20_000);

  it("reports a missing binary", async () => {
    const o = await run({ ...req("success"), agy: { command: "definitely-not-agy-xyz" } }, undefined, fast);
    expect(o).toMatchObject({ type: "error", message: expect.stringMatching(/not found/) });
  });

  it("rejects prompts over the limit before spawning", async () => {
    await expect(run({ ...req("success"), prompt: "x".repeat(MAX_PROMPT_CHARS + 1) })).rejects.toThrow(/prompt too long/);
  });

  it("deletes the log file afterwards", async () => {
    const logPath = path.join(tmp(), "agy.log");
    await run(req("success"), undefined, { ...fast, makeLogPath: () => logPath });
    expect(existsSync(logPath)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/agy/run.test.ts`
Expected: FAIL (module `src/agy/index.js` not found).

- [ ] **Step 3: Implement `src/agy/run.ts`**

```ts
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Effort } from "../config.js";
import { classify } from "./classify.js";
import { killTree as nodeKillTree, treeSpawnOptions } from "./kill.js";
import { detectQuota } from "./quota.js";
import { StreamParser } from "./stream.js";
import type { AgyResult, Outcome, StreamEvent } from "./types.js";

export const MAX_PROMPT_CHARS = 8000;
const MAX_STDERR = 1024 * 1024;

export interface RunRequest {
  prompt: string;
  cwd: string;
  model: string;
  effort?: Effort;
  mode?: "accept-edits" | "plan";
  timeoutSec: number;
  conversationId?: string;
  jsonSchemaPath?: string;
  addDirs?: string[];
  skipPermissions?: boolean;
  sandbox?: boolean;
  agy: { command: string; prefixArgs?: string[] };
  signal?: AbortSignal;
  guard?: (ev: StreamEvent) => string | null;
}

export interface RunDeps {
  spawn: typeof nodeSpawn;
  killTree: (pid: number) => Promise<void>;
  makeLogPath: () => string;
  readLog: (path: string) => Promise<string>;
  removeLog: (path: string) => Promise<void>;
  pollMs: number;
  graceSec: number;
}

const defaultDeps: RunDeps = {
  spawn: nodeSpawn,
  killTree: (pid) => nodeKillTree(pid),
  // Private per-run temp dir: agy's log contains the account email.
  makeLogPath: () => path.join(mkdtempSync(path.join(os.tmpdir(), "agyo-")), "agy.log"),
  readLog: async (p) => {
    try {
      return await readFile(p, "utf8");
    } catch {
      return "";
    }
  },
  removeLog: async (p) => {
    await rm(path.dirname(p).includes("agyo-") ? path.dirname(p) : p, { recursive: true, force: true });
  },
  pollMs: 1000,
  graceSec: 15,
};

export function buildArgs(req: RunRequest, logPath: string): string[] {
  const a = [
    "-p", req.prompt,
    "--output-format", "stream-json",
    "--model", req.model,
    "--print-timeout", `${req.timeoutSec}s`,
    "--log-file", logPath,
  ];
  if (req.effort) a.push("--effort", req.effort);
  if (req.mode) a.push("--mode", req.mode);
  if (req.conversationId) a.push("--conversation", req.conversationId);
  if (req.jsonSchemaPath) a.push("--json-schema", req.jsonSchemaPath);
  for (const d of req.addDirs ?? []) a.push("--add-dir", d);
  if (req.sandbox) a.push("--sandbox");
  if (req.skipPermissions) a.push("--dangerously-skip-permissions");
  return a;
}

export async function run(
  req: RunRequest,
  onEvent?: (ev: StreamEvent) => void,
  overrides: Partial<RunDeps> = {},
): Promise<Outcome> {
  if (req.prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`prompt too long (${req.prompt.length} > ${MAX_PROMPT_CHARS} chars); put the brief in a file`);
  }
  const d: RunDeps = { ...defaultDeps, ...overrides };
  const logPath = d.makeLogPath();
  const args = [...(req.agy.prefixArgs ?? []), ...buildArgs(req, logPath)];

  try {
    return await new Promise<Outcome>((resolve) => {
      const parser = new StreamParser();
      let stderr = "";
      let conversationId: string | undefined;
      let result: AgyResult | undefined;
      let settled = false;
      let watchdogFired = false;
      const timers: NodeJS.Timeout[] = [];

      const child = d.spawn(req.agy.command, args, {
        cwd: req.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        ...treeSpawnOptions(),
      });
      child.stdin?.end();

      const stopTimers = () => timers.forEach((t) => clearTimeout(t));
      const finish = (o: Outcome) => {
        if (settled) return;
        settled = true;
        stopTimers();
        clearInterval(poller);
        req.signal?.removeEventListener("abort", onAbort);
        resolve(o);
      };
      const kill = () => {
        if (child.pid !== undefined) void d.killTree(child.pid).catch(() => {});
      };
      const cidOf = <T extends object>(o: T) => (conversationId ? { ...o, conversationId } : o);

      const handle = (ev: StreamEvent) => {
        if (ev.kind === "init" && ev.conversationId) conversationId = ev.conversationId;
        if (ev.kind === "result") result = ev.result;
        onEvent?.(ev);
        const reason = req.guard?.(ev);
        if (reason && !settled) {
          kill();
          finish(cidOf({ type: "guard_violation" as const, reason, event: ev }));
        }
      };

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => parser.push(chunk).forEach(handle));
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        if (stderr.length < MAX_STDERR) stderr += chunk;
      });

      let polling = false;
      const poller = setInterval(async () => {
        if (polling || settled) return;
        polling = true;
        try {
          const q = detectQuota(await d.readLog(logPath));
          if (q && !settled) {
            kill();
            finish(cidOf({
              type: "quota" as const,
              ...(q.resetSeconds !== undefined ? { resetInSec: q.resetSeconds } : {}),
              ...(q.resetText ? { resetText: q.resetText } : {}),
            }));
          }
        } finally {
          polling = false;
        }
      }, d.pollMs);

      timers.push(
        setTimeout(() => {
          watchdogFired = true;
          kill();
          finish(cidOf({ type: "timeout" as const, partialResponse: result?.response ?? "" }));
        }, (req.timeoutSec + d.graceSec) * 1000),
      );

      const onAbort = () => {
        kill();
        finish(cidOf({ type: "cancelled" as const }));
      };
      if (req.signal?.aborted) onAbort();
      req.signal?.addEventListener("abort", onAbort, { once: true });

      let exitCode: number | null = null;
      const conclude = async (spawnError?: NodeJS.ErrnoException) => {
        if (settled) return;
        parser.flush().forEach(handle);
        if (settled) return;
        finish(
          classify({
            exitCode,
            ...(spawnError ? { spawnError } : {}),
            stderr,
            log: await d.readLog(logPath),
            ...(result ? { result } : {}),
            ...(conversationId ? { conversationId } : {}),
            watchdogFired,
            agyCommand: req.agy.command,
          }),
        );
      };
      child.on("error", (e) => void conclude(e as NodeJS.ErrnoException));
      child.on("exit", (code) => {
        exitCode = code;
        // Grandchildren can hold pipes open; don't wait forever for "close".
        const t = setTimeout(() => void conclude(), 2000);
        t.unref();
        timers.push(t);
      });
      child.on("close", (code) => {
        exitCode = code ?? exitCode;
        void conclude();
      });
    });
  } finally {
    await d.removeLog(logPath).catch(() => {});
  }
}
```

- [ ] **Step 4: Implement `src/agy/index.ts`**

```ts
export { run, buildArgs, MAX_PROMPT_CHARS, type RunRequest, type RunDeps } from "./run.js";
export { killTree } from "./kill.js";
export { CooldownRegistry } from "./quota.js";
export type { Outcome, StreamEvent, AgyResult, AgyUsage } from "./types.js";
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/agy/run.test.ts`
Expected: PASS. If the "missing binary" test hangs on Windows, the cause is `spawn` emitting `error` without `exit`. `conclude` already handles `error`; check that the `error` listener is registered before any `await`.

- [ ] **Step 6: Full suite, typecheck, format, commit**

Run: `npm run typecheck && npm test && npm run format:check`
Expected: all pass.
```bash
git add src/agy/run.ts src/agy/index.ts test/agy/run.test.ts
git commit -m "feat(agy): run() supervises headless agy and returns typed outcomes"
```

---

### Task 10: Opt-in live smoke test against real agy

**Files:**
- Create: `vitest.live.config.ts`, `test/live/agy.live.test.ts`
- Modify: `vitest.config.ts` (exclude live)

**Interfaces:**
- Consumes: `run()` (Task 9), `loadRuntimeConfig()` (Task 3)
- Produces: `npm run test:live`, which spends a tiny amount of real quota and is never run in CI

- [ ] **Step 1: Configure vitest**

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], exclude: ["test/live/**", "node_modules/**"] },
});
```
`vitest.live.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/live/**/*.live.test.ts"], testTimeout: 180_000 },
});
```

- [ ] **Step 2: Write the live test**

`test/live/agy.live.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../../src/agy/index.js";
import type { StreamEvent } from "../../src/agy/types.js";
import { loadRuntimeConfig } from "../../src/config.js";

describe("live agy", () => {
  it("answers a trivial prompt with gemini-3.8-flash-low", async () => {
    const rt = loadRuntimeConfig();
    const events: StreamEvent[] = [];
    const o = await run(
      {
        prompt: "Reply with exactly the word: pong. Do not use any tools.",
        cwd: mkdtempSync(path.join(os.tmpdir(), "agyo-live-")),
        model: "gemini-3.8-flash-low",
        mode: "plan",
        timeoutSec: 120,
        agy: { command: rt.agyPath },
      },
      (e) => events.push(e),
    );
    const init = events.find((e) => e.kind === "init");
    console.log("permission_mode:", init?.kind === "init" ? init.permissionMode : "n/a", "outcome:", o.type);
    expect(o.type).toBe("success");
    if (o.type === "success") {
      expect(o.response.toLowerCase()).toContain("pong");
      expect(o.usage.totalTokens).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 3: Run it once by hand (spends a little quota)**

Run: `npm run test:live`
Expected: PASS, printing `permission_mode: … outcome: success`. Write down the printed `permission_mode`. Plan 2 uses it, because a global `always-proceed` setting overrides `--mode plan`.

- [ ] **Step 4: Confirm the normal suite excludes it, then commit**

Run: `npm test`
Expected: the live test is not collected.
```bash
git add vitest.config.ts vitest.live.config.ts test/live/agy.live.test.ts
git commit -m "test: opt-in live smoke test against the real agy CLI"
```

---

## Self-review (done while writing)
- **Spec coverage (Plan 1 scope):** §4 `agy` module interface → Tasks 6, 7, 9. Windows/POSIX kill (§14) → Task 5. Config file (§4) → Task 3. Per-OS paths (§14) → Task 4. Fake agy (§15) → Task 8. Known issues §9.5 (stdin, print-timeout, quota hang, prompt size, tree kill) → Tasks 7–9. CI matrix (§15) → Task 2. Code reuse and NOTICE (§12) → Task 1. V2 (`--log-file` exists) is confirmed by `agy --help`. V11 (tool params in stream) is confirmed by the live run and encoded in Task 6 tests. Everything else (pipeline, jobs, tools, CLI, learning, skill) belongs to Plans 2–4 per the index.
- **Outcome variant added:** `cancelled` isn't in the spec's Outcome list but is needed for `agy_act cancel`. That's a deliberate extension.
- **Type consistency:** `RunRequest.effort: Effort` comes from `config.ts`. `Outcome` is defined in `types.ts` and used by `classify.ts` and `run.ts`. `StreamEvent.toolParams` is used by the guard test.
- **Placeholders:** none. The soft-deny regex is marked provisional on purpose, because the real wording is unverified. Plan 2 records it from a live denial.
