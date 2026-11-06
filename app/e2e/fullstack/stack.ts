// One test file's whole stack: a sandbox (a fresh temp HOME, the stand-in vault CLIs first on PATH
// behind a tripwire for the real ones), the bridge (roster-core's `bridge` example, the app's
// commands over a WebSocket), and through it the real core and `uv run roster serve` from this
// worktree. The page then runs the real app against it (`stack.pageUrl`). Nothing here touches the
// real home folder, vault or Inventory (.claude/CLAUDE.md: the sandbox guard).
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { inject } from "vitest";
import type { StandIn } from "./setup";

const REPO = resolve(import.meta.dirname, "../../..");
const FAKES = join(REPO, "tests", "fakes");
const BRIDGE = join(REPO, "target", "debug", "examples", process.platform === "win32" ? "bridge.exe" : "bridge");
const VAULT_CLIS = ["bw", "op", "keepassxc-cli"];
/** The fake bw's master password (tests/fakes/bw). */
export const MASTER_PASSWORD = "hunter2";
/** The stand-in Hosts' account (Containerfile): its password lives only in the fake vault. */
export const HOST_USER = "ops";
export const HOST_PASSWORD = "ops-e2e-pass-1";
/** The vault item that holds it. */
export const HOST_ITEM = "lab ops login";

/** The stand-in Hosts as an Inventory group, each logging in with the vault item's password. */
export const labInventory = (s: Record<string, StandIn>) => `defaults:
  user: ${HOST_USER}
groups:
  lab:
    title: Lab
    hosts:
${["lab-01", "lab-02"]
  .map((n) => `      ${n}:\n        ip: 127.0.0.1\n        ssh: {port: ${s[n]!.port}}\n        auth: "bw:${HOST_ITEM}"\n        enroll: false\n`)
  .join("")}`;

export interface StackOptions {
  /** roster.yml's text (`{lab-01}` is replaced by that stand-in's port), or none: the first run. */
  inventory?: (standIns: Record<string, StandIn>) => string;
  /** Keep it as a team's: committed in a git repo (~/infra) with a remote, so edits are Pending
   * changes until they're published. */
  repo?: boolean;
  /** init.lua's text. The terminal always draws with the DOM renderer, so a test can read it. */
  initLua?: string;
}

export interface Stack {
  /** The real app on this stack. */
  pageUrl: string;
  home: string;
  /** init.lua's path. */
  initLua: string;
  /** roster.yml's path (where the first run creates one, too). */
  inventory: string;
  standIns: Record<string, StandIn>;
  /** What the bridge (and the core, and serve) wrote on stderr so far. */
  stderr(): string;
  /** The CLI in the same sandbox: `uv run roster ARGS`. */
  roster(args: string[]): string;
  stop(): Promise<void>;
}

/** The default init.lua: the DOM renderer, so the terminal's text is in the page. */
export const BASE_INIT = `roster.o.terminal.renderer = "dom"\n`;

function tripwire(dir: string, tool: string, ran: string) {
  const script = join(dir, tool);
  writeFileSync(script, `#!/bin/sh\nprintf "%s\\n" "${tool} $*" >> '${ran}'\necho "the full-stack tests ran a real ${tool}" >&2\nexit 1\n`);
  chmodSync(script, 0o755);
}

/** The sandbox guard: HOME is a fresh temp folder, the vault CLIs resolve to tests/fakes, roster is
 * this worktree's, and no ROSTER_CONFIG reaches it. Throws before anything runs otherwise. */
function assertSandbox(env: NodeJS.ProcessEnv, root: string) {
  const home = env.HOME ?? "";
  if (!home.startsWith(root) || !home.startsWith(realpathSync(tmpdir()))) throw new Error(`sandbox: HOME ${home} isn't a fresh temp folder`);
  if (env.ROSTER_CONFIG !== undefined) throw new Error("sandbox: ROSTER_CONFIG is set");
  for (const tool of VAULT_CLIS) {
    const found = execFileSync("sh", ["-c", `command -v ${tool}`], { env, encoding: "utf8" }).trim();
    if (realpathSync(found) !== join(FAKES, tool)) throw new Error(`sandbox: ${tool} resolves to ${found}, not tests/fakes`);
  }
  if (!env.ROSTER_APP_ROSTER?.includes(`--project ${REPO} `)) throw new Error("sandbox: roster isn't this worktree's");
}

export async function startStack(opts: StackOptions = {}): Promise<Stack> {
  const standIns = Object.fromEntries(inject("standIns").map((s) => [s.name, s]));
  const root = mkdtempSync(join(realpathSync(tmpdir()), "roster-e2e-app-"));
  const dirs = { home: join(root, "home"), bin: join(root, "bin"), guard: join(root, "guard"), state: join(root, "state"), run: join(root, "run"), tmp: join(root, "tmp") };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  chmodSync(dirs.run, 0o700);
  const ran = join(dirs.guard, "ran");
  for (const tool of VAULT_CLIS) {
    symlinkSync(join(FAKES, tool), join(dirs.bin, tool));
    tripwire(dirs.guard, tool, ran);
  }
  // The real roster (~/.local/bin) isn't on PATH, and a plain `roster` would trip.
  tripwire(dirs.guard, "roster", ran);
  const realHome = process.env.HOME ?? "";
  const path = (process.env.PATH ?? "").split(delimiter).filter((d) => d && !(realHome && d.startsWith(join(realHome, ".local"))));
  const uv = process.env.UV ?? execFileSync("sh", ["-c", "command -v uv"], { encoding: "utf8" }).trim();
  const config = join(dirs.home, ".config", "roster");
  mkdirSync(config, { recursive: true });
  const initLua = join(config, "init.lua");
  writeFileSync(initLua, opts.initLua ?? BASE_INIT);
  const items = [{ id: "e2e00001-aaaa", name: HOST_ITEM, login: { username: HOST_USER, password: HOST_PASSWORD } }];
  writeFileSync(join(root, "bw-items.json"), JSON.stringify(items));
  const env: NodeJS.ProcessEnv = {
    PATH: [dirs.bin, dirs.guard, ...path].join(delimiter),
    HOME: dirs.home,
    USER: process.env.USER ?? "e2e",
    LANG: "C.UTF-8",
    TERM: "xterm-256color",
    XDG_RUNTIME_DIR: dirs.run,
    TMPDIR: dirs.tmp,
    ROSTER_APP_STATE_DIR: dirs.state,
    ROSTER_APP_ROSTER: `${uv} run --no-sync --project ${REPO} roster`,
    UV_CACHE_DIR: join(root, "uv-cache"),
    UV_NO_CONFIG: "1",
    FAKE_BW_ITEMS: join(root, "bw-items.json"),
    FAKE_BW_DATA: join(root, "bw-data.json"),
    RUST_BACKTRACE: "1",
    GIT_AUTHOR_NAME: "e2e",
    GIT_AUTHOR_EMAIL: "e2e@example.invalid",
    GIT_COMMITTER_NAME: "e2e",
    GIT_COMMITTER_EMAIL: "e2e@example.invalid",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  assertSandbox(env, root);
  const inventory = opts.repo ? join(dirs.home, "infra", "roster.yml") : join(dirs.home, "roster.yml");
  const git = (args: string[], cwd: string) => execFileSync("git", args, { env, cwd, stdio: "ignore" });
  const roster = (args: string[]) => execFileSync(uv, ["run", "--no-sync", "--project", REPO, "roster", ...args], { env, cwd: dirs.home, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let child: ChildProcess | null = null;
  let stderr = "";
  let ws: string;
  // Whatever fails before the bridge is up takes the sandbox with it.
  try {
    if (opts.inventory) {
      mkdirSync(join(inventory, ".."), { recursive: true });
      writeFileSync(inventory, opts.inventory(standIns));
      if (opts.repo) {
        const origin = join(root, "origin.git");
        git(["init", "-q", "--bare", "-b", "main", origin], root);
        const work = join(inventory, "..");
        git(["init", "-q", "-b", "main"], work);
        git(["add", "roster.yml"], work);
        git(["commit", "-q", "-m", "The lab"], work);
        git(["remote", "add", "origin", origin], work);
        git(["push", "-q", "-u", "origin", "main"], work);
      }
      // This box's ssh config (Host blocks for the Inventory), as `roster sync` writes it.
      roster(["-c", inventory, "sync"]);
    }
    if (!existsSync(BRIDGE)) throw new Error(`no bridge at ${BRIDGE}: cargo build -p roster-core --features bridge --example bridge`);
    child = spawn(BRIDGE, [], { env, cwd: dirs.home, stdio: ["pipe", "pipe", "pipe"] });
    child!.stderr!.on("data", (b: Buffer) => (stderr += b.toString()));
    ws = await new Promise<string>((done, fail) => {
      const lines = createInterface({ input: child!.stdout! });
      lines.on("line", (l) => {
        const m = /^ROSTER_BRIDGE (\S+)$/.exec(l);
        if (m) done(m[1]!);
      });
      child!.on("exit", (code) => fail(new Error(`the bridge exited (${code}): ${stderr}`)));
    });
  } catch (e) {
    child?.kill();
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
  const bridge = child;
  return {
    pageUrl: `${inject("fullAppUrl")}?bridge=${encodeURIComponent(ws)}`,
    home: dirs.home,
    initLua,
    inventory,
    standIns,
    stderr: () => stderr,
    roster,
    async stop() {
      const exited = new Promise((done) => bridge.once("exit", done));
      bridge.stdin!.end();
      await exited;
      const tripped = existsSync(ran) ? readFileSync(ran, "utf8") : "";
      rmSync(root, { recursive: true, force: true });
      if (tripped) throw new Error(`the full-stack tests ran a real tool from PATH:\n${tripped}`);
    },
  };
}
