// The full-stack suite (`npm run e2e:full`): headless Chromium runs the real app, which reaches
// the real core through the bridge (roster-core shell/bridge.rs), and `roster serve` from this
// worktree, against stand-in Hosts in containers. Files one at a time: one Chromium, one bridge.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: import.meta.dirname,
    environment: "node",
    include: ["**/*.full.ts"],
    globalSetup: ["./setup.ts"],
    fileParallelism: false,
    // Only how long a broken test takes to say so: every wait is for an event (testing.md, T146).
    // A Session's first ssh login and serve's first start are the slowest steps on a busy machine.
    testTimeout: 90_000,
    hookTimeout: 180_000,
  },
});
