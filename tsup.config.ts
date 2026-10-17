import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", "agyo-hook": "src/pipeline/hook-entry.ts" },
  format: ["esm"],
  target: "node20",
  clean: true,
});
