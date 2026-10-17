import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

export default async function setup(project: TestProject) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const out = path.join(root, "test", ".tmp", "foreman-hook.mjs");
  await build({
    entryPoints: [path.join(root, "src/pipeline/hook-entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: out,
    logLevel: "silent",
  });
  project.provide("hookBundle", out);
}

declare module "vitest" {
  export interface ProvidedContext {
    hookBundle: string;
  }
}
