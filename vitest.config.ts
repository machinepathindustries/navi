import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "external", "dist", "tests/fixtures/**"],
    setupFiles: ["tests/setup-db.ts"],
    testTimeout: 60_000,
  },
});
