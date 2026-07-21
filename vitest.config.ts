import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: { enabled: false },
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
