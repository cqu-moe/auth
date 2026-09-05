import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "frontend/src/**/*.test.{ts,tsx}"],
  },
});
