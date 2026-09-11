import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "shared/**/*.test.ts", "scripts/**/*.test.ts", "frontend/src/**/*.test.{ts,tsx}"],
  },
});
