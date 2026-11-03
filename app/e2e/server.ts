// Starts Vite on a free port for the suite and tells each test file its URLs (`inject("url")`, the
// terminal harness; `inject("appUrl")`, the whole app).
import { resolve } from "node:path";
import { createServer } from "vite";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    url: string;
    /** The whole app's page (index.html), on the fake Backend; add `?fixture=<name>`. */
    appUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const app = resolve(import.meta.dirname, "..");
  const server = await createServer({
    root: app,
    configFile: resolve(app, "vite.config.ts"),
    logLevel: "warn",
    // Port 0: whatever is free, so it never collides with `tauri dev` (1420) or another run.
    server: { port: 0, strictPort: false, host: "127.0.0.1", hmr: false, watch: null },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Vite didn't listen on a port");
  project.provide("url", `http://127.0.0.1:${address.port}/e2e/index.html`);
  project.provide("appUrl", `http://127.0.0.1:${address.port}/index.html`);
  return async () => {
    await server.close();
  };
}
