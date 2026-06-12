import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/live/**/*.test.ts"],
    testTimeout: 120_000,
    // One worker: stages share module state and place real orders sequentially.
    fileParallelism: false,
  },
});
