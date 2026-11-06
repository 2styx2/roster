// globalSetup of the full-stack suite (`npm run e2e:full`): the stand-in Hosts (a real sshd each,
// in podman or docker containers, from ./Containerfile) and Vite serving the real app with
// `@tauri-apps/*` swapped for the bridge's transport (./tauri). Each test file starts its own
// bridge and `roster serve` in a sandbox (stack.ts).
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { createServer } from "vite";
import type { TestProject } from "vitest/node";

/** A stand-in Host: its container's hostname (what `hostname` prints in a Session) and the port
 * its sshd is reachable at on 127.0.0.1. */
export interface StandIn {
  name: string;
  port: number;
}

declare module "vitest" {
  export interface ProvidedContext {
    /** The real app's page; add `?bridge=` (stack.ts). */
    fullAppUrl: string;
    standIns: StandIn[];
  }
}

const here = import.meta.dirname;
const IMAGE = "roster-e2e-app-host";
/** The stand-in Hosts' made-up names. */
const NAMES = ["lab-01", "lab-02"];

/** podman, or docker where there's no podman (CI may have either); `$CONTAINER_CLI` picks one. */
export function containerCli(): string {
  if (process.env.CONTAINER_CLI) return process.env.CONTAINER_CLI;
  for (const cli of ["podman", "docker"]) {
    try {
      execFileSync(cli, ["--version"], { stdio: "ignore" });
      return cli;
    } catch {
      // not installed: try the next
    }
  }
  throw new Error("the full-stack tests need podman or docker for their stand-in Hosts");
}

export default async function setup(project: TestProject) {
  const cli = containerCli();
  const run = (args: string[]) => execFileSync(cli, args, { encoding: "utf8" }).trim();
  run(["build", "-q", "-t", IMAGE, "-f", resolve(here, "Containerfile"), here]);
  const prefix = `roster-e2e-app-${process.pid}`;
  const standIns: StandIn[] = [];
  const started: string[] = [];
  const stop = () => {
    for (const c of started) {
      try {
        execFileSync(cli, ["rm", "-f", c], { stdio: "ignore" });
      } catch {
        // already gone
      }
    }
  };
  try {
    for (const name of NAMES) {
      const container = `${prefix}-${name}`;
      run(["run", "-d", "--rm", "--name", container, "--hostname", name, "-p", "127.0.0.1::22", IMAGE]);
      started.push(container);
      // "127.0.0.1:PORT" (docker may add an IPv6 line).
      const port = Number(run(["port", container, "22"]).split("\n")[0]!.split(":").pop());
      standIns.push({ name, port });
    }
  } catch (e) {
    stop();
    throw e;
  }
  const app = resolve(here, "../..");
  const shim = (file: string) => resolve(here, "tauri", file);
  const server = await createServer({
    root: app,
    configFile: resolve(app, "vite.config.ts"),
    logLevel: "warn",
    server: { port: 0, strictPort: false, host: "127.0.0.1", hmr: false, watch: null },
    resolve: {
      alias: [
        { find: /^@tauri-apps\/api\/core$/, replacement: shim("core.ts") },
        { find: /^@tauri-apps\/api\/event$/, replacement: shim("event.ts") },
        { find: /^@tauri-apps\/api\/window$/, replacement: shim("window.ts") },
        { find: /^@tauri-apps\/plugin-clipboard-manager$/, replacement: shim("clipboard.ts") },
      ],
    },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Vite didn't listen on a port");
  project.provide("fullAppUrl", `http://127.0.0.1:${address.port}/index.html`);
  project.provide("standIns", standIns);
  return async () => {
    await server.close();
    stop();
  };
}
