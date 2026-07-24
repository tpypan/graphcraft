import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: { enabled: false },
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts"],
    maxWorkers: 1,
    testTimeout:
      process.platform === "win32" ? 60_000 : process.platform === "darwin" ? 30_000 : 15_000,
  },
});
