import { defineConfig } from "vitest/config";

// Requires a running Supabase stack: `pnpm db:start`.
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
