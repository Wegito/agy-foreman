import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Many tests create real git repos and processes; 5s is too tight on Windows under load.
    testTimeout: 20_000,
    include: ["test/**/*.test.ts"],
    exclude: ["test/live/**", "node_modules/**"],
    globalSetup: ["test/setup/build-hook.ts"],
  },
});
