// The end-to-end suite (`npm run e2e`): Vitest in Node drives headless Chromium (playwright-core)
// against e2e/index.html, served by Vite with the app's own config. Kept out of `npm run check`,
// which needs no browser; CI runs both (app-frontend in .github/workflows/ci.yml).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: import.meta.dirname,
    environment: "node",
    include: ["**/*.e2e.ts"],
    globalSetup: ["./server.ts"],
    // One browser, one page per file; files one at a time, so a busy machine runs one Chromium.
    fileParallelism: false,
    // Only how long a broken test takes to say so: every wait is for an event (testing.md, T146).
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
