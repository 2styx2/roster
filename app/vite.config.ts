/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri dev expects a fixed port (1420, strictPort). Browser runs in WSL use another one,
// e.g. `npm run dev -- --port 5179`, so the two never collide (docs/app/dev/testing.md).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"] },
    // src/config/fixture.ts imports the Rust core's defaults fixture from ../crates, and the help
    // pages (src/help/guides.ts) bundle the guides from ../docs and the Plugin API's stubs; the docs
    // lint (src/help/lint.test.ts) reads ../plugins/README.md for its headings.
    fs: { allow: [".", "../crates/roster-core/tests/fixtures", "../docs", "../examples/plugins/types", "../plugins"] },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // App.worst.test.tsx reads styles.css (`?raw`) for the rules that cut text off, and
    // styles.test.ts reads every stylesheet to keep `--faint` out of text. Keycaps, the mark and
    // the help page have their own sheets, which the docs website uses too (src/docs-site).
    css: { include: [/src\/styles\.css/, /src\/lock\/signin\.css/, /src\/ui\/keys\.css/, /src\/chrome\/logo\.css/, /src\/help\/doc\.css/] },
  },
});
