import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Live tests trade real funds on Monad; run them explicitly via `pnpm test:live`.
    exclude: ["**/node_modules/**", "tests/live/**"],
    testTimeout: 30_000,
  },
});
