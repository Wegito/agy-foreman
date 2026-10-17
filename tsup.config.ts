import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", "agyo-hook": "src/pipeline/hook-entry.ts" },
  format: ["esm"],
  target: "node20",
  // The hook is copied alone into each worktree's .agents/, so it must not import shared chunks.
  splitting: false,
  clean: true,
});
