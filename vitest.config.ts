import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: { enabled: false },
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts"],
    maxWorkers: 1,
    testTimeout: 15_000,
  },
});
