// Plugins in the frontend (ticket 23, ADR 0006, decisions Q81 and Q82; docs/plugins.md). The Lua
// runs in roster-core; this module is everything the app does around it, behind one object:
//
// - which Plugins are installed and what each was granted, kept in the State (`plugins`), and the
//   install and update prompts (`install`, `answer`): nothing loads with a permission the user
//   wasn't asked about;
// - applying a Plugin's ops (opRegistry.ts): registry entries with the Plugin's name as their
//   source, so the core draws them in roster's style and unloading takes them all away
//   (`unregisterSource`), and what shown.ts keeps (notices, the float, the question, progress);
// - running what a Plugin handed over (`plugins call NAME N`), with roster's own commands, and
//   sending it events, among them the Sessions' output for terminal.read (outputFeed.ts);
// - errors: a toast naming the Plugin, file and line, and its UI taken away once it's disabled.
//
// - Packages (ticket 24): Plugins from git repos that init.lua names. The core clones and pins them
//   (`packagesSync`); each one is the Plugin `package:NAME` and goes through the same install
//   prompt, showing its git URL as the unverified source. Cancel (or `:plugins remove`) removes the clone and
//   is kept in the State (`DECLINED_KEY`) until `:packages install NAME`. `:packages update [NAME]` shows each
//   new commit with its diff and any new permission before applying it, and declining keeps the
//   old version.
//
// `:plugins` (the command and panel), `:packages` and the prompts are drawn by PluginsPanel.tsx.
import type { Backend, OpenSession, PackageStatus, PackageUpdate, PluginErrorInfo, PluginEventName, PluginCaller, PluginManifest, PluginData, PluginReply, SiteRequests } from "../backend/types";
import type { CommandContext } from "../commands/table";
import type { Registries } from "../registries";
import { BUILTIN } from "../registry";
import { HEALTH_LATER_MS } from "../health/health";
import { api_version as pluginApiVersion } from "../../../crates/roster-core/tests/fixtures/plugin-api.json?pick=api_version,commands,roster_only,tags";
import { lineRefused } from "./cmd";
import { CORE } from "./core.gen";
import type { ScreenSize } from "./committed";
import { parseHealthChecks, type PluginFloat, type Run } from "./ops";
import { applyOp, parseOp, type HandlerContext, type Loaded, type OpCall, type OpHost } from "./opRegistry";
import { OutputFeed } from "./outputFeed";
import { Shown, type Notice, type PendingConfirm, type RunningProgress } from "./shown";
import { backgroundQuiet, quiet, type Message } from "../ui/messages";

export type { HandlerContext } from "./opRegistry";
export type { Notice, PendingConfirm, RunningProgress } from "./shown";

/** What the manager asks of the app. */
export interface PluginUi {
  /** Runs a command line, as typing it after `:` does. */
  run(line: string): void;
  /** Types `text` into Session `id` (terminal.write). */
  send(id: number, text: string): void;
  /** Puts `text` on the clipboard (`roster.clipboard.copy`; the core allows it only in a call
   * the user started). Rejects when the clipboard can't be written. */
  copy(text: string): Promise<void>;
  /** The Session on screen and its Host (`null` for a Quick Connect Session), or null with none:
   * a handler's context has them for a Plugin granted inventory.read or terminal.read. */
  onScreen?(): { session: number; host: string | null } | null;
  /** Closes view `id` if it's the one open (`roster.views.close`). */
  closeView?(id: string): void;
  /** Opens view `id` with its node or row `select` selected (`roster.views.open(id, { select })`, T99). */
  openView?(id: string, select: string): void;
  /** Goes to Session `id` and, with `line`, finds that text up its scrollback
   * (`roster.sessions.show`). False when there's no such Session. */
  showSession?(id: number, line: string | null): boolean;
  /** Opens a float's link (http or https, checked) in the browser. */
  openUrl?(url: string): void;
  /** Says a line on the message line (`roster.echo`, api 3), quiet or not (Q115): a quiet one
   * follows `ui.messages`, and so does a Plugin's info notice (tickets 117, 118). */
  say?(message: Message): void;
  /** Whether every message shows (`ui.messages = "all"`); without it, notices always show. */
  messagesAll?(): boolean;
  /** Keeps a notice shown in `:messages`'s history, as the message line's are. */
  log?(message: Message): void;
  /** Opens the command line with `text` typed in (`roster.cmdline`, api 3). */
  openCommandLine?(text: string): void;
  /** The settings a built-in Plugin gets as `roster.plugin.config` (Folders: init.lua's Folders,
   * and folders.yml's to move in once, ticket 61), read at each load. */
  builtinSettings?(name: string): Promise<Record<string, unknown> | null>;
  /** This manager runs `:tutor`'s demo's Plugins (ticket 66): a Plugin that fails to load says
   * "(in the demo)" after its name, so it doesn't read as a failure in your workspace (#233). */
  demo?: boolean;
}

/** A Plugin as the State keeps it. */
interface Installed {
  /** The folder (or `builtin:NAME`). */
  path: string;
  name: string;
  /** What runs: granted and not revoked. */
  granted: string[];
  /** Every permission the user has been asked about (install, update): a new one asks again. */
  asked: string[];
}

/** The Plugins `:tutor`'s demo loads ([`PluginManager.forDemo`]): the State's list for the demo's
 * State, and the Packages its `packagesSync` gives. */
export interface DemoPlugins {
  installed: Installed[];
  packages: PackageStatus[];
}

const BUILTIN_PREFIX = CORE.builtin_prefix;
/** The built-in features written as Plugins: always installed, granted what they ask until revoked. */
const BUILTIN_PLUGINS: readonly string[] = CORE.bundled.map((name) => `${BUILTIN_PREFIX}${name}`);
const builtinName = (path: string) => (path.startsWith(BUILTIN_PREFIX) ? path.slice(BUILTIN_PREFIX.length) : null);

export const STATE_KEY = "plugins";
/** The State's Packages whose install the user cancelled, or that `:plugins remove` took out: not
 * asked again while init.lua names the same repo and folder for them (issues #111, #213). */
const DECLINED_KEY = "packagesDeclined";

/** A cancelled Package install as the State keeps it: its name, and the repo and folder it was
 * from, so another repo or folder under the same name is other code and asks. */
interface Declined {
  name: string;
  url: string;
  dir: string | null;
}

function parseDeclined(v: unknown): Declined[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((d: unknown) => {
    if (typeof d !== "object" || d === null) return [];
    const { name, url, dir } = d as Record<string, unknown>;
    if (typeof name !== "string" || typeof url !== "string" || (dir !== null && typeof dir !== "string")) return [];
    return [{ name, url, dir }];
  });
}

/** One thing a Plugin did, for `:plugins`' recent use. */
interface Use {
  at: number;
  what: string;
}

export interface PluginStatus {
  name: string;
  path: string;
  builtin: boolean;
  manifest: PluginManifest | null;
  granted: readonly string[];
  /** Why it isn't running (an error, disabled), if it isn't. */
  problem: string | null;
  /** Waiting for the user to answer an update's new permissions. */
  waiting: boolean;
  uses: readonly Use[];
  /** Its network requests by site since the app started, as the core last counted them
   * (`refreshRequests`, decision Q116). */
  requests: readonly SiteRequests[];
  /** How full its data folder is, as the core counted it when `:plugins` last opened
   * (`refreshData`, ticket 98); null before it has. */
  data: PluginData | null;
}

/** A question for the user: install this Plugin, or allow what its update newly asks for. */
export interface Prompt {
  kind: "install" | "update";
  path: string;
  manifest: PluginManifest;
  /** The permissions being asked about (all of them at install; the new ones on update). */
  asking: readonly string[];
  /** A Package's prompt: its git URL and folder in the repo (the unverified source), and for an
   * update the new commit with its diff. Declining a Package's update keeps the version it has. */
  package?: { name: string; url: string; dir: string | null; commit: string | null; update?: PackageUpdate };
}

export interface Snapshot {
  plugins: readonly PluginStatus[];
  /** The Packages init.lua names, as the core last described them (`:packages`). */
  packages: readonly PackageStatus[];
  prompts: readonly Prompt[];
  notices: readonly Notice[];
  float: (PluginFloat & { plugin: string }) | null;
  /** The question up, if any: one at a time, the latest asked. */
  confirm: PendingConfirm | null;
  /** Every progress, in the order they started. */
  progress: readonly RunningProgress[];
  /** The Packages init.lua names whose install the user cancelled: not asked again until
   * `:packages install NAME`. */
  declined: readonly string[];
  /** The Plugins and Packages the app starts with have loaded (or failed to), the first time:
   * until then a name init.lua gives one of their pieces can't be judged (ticket 79). */
  settled: boolean;
}

/** What the State store gives the manager. */
interface PluginStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

type PluginBackend = Pick<
  Backend,
  | "pluginManifest"
  | "pluginTypes"
  | "pluginLoad"
  | "pluginCall"
  | "pluginEvent"
  | "pluginSessions"
  | "pluginUnload"
  | "pluginForget"
  | "pluginRequests"
  | "pluginData"
  | "packagesSync"
  | "packagesPin"
  | "packagesDiscard"
  | "packagesRemove"
  | "packagesCheck"
  | "packagesApply"
  | "packagesClean"
>;

/** A Package's Plugin path, and back. */
export const PACKAGE_PREFIX = CORE.package_prefix;
const packageName = (path: string) => (path.startsWith(PACKAGE_PREFIX) ? path.slice(PACKAGE_PREFIX.length) : null);


const MAX_USES = 8;

/** The Installed entries in the State (untrusted): anything malformed is dropped. */
function parseInstalled(json: unknown): Installed[] {
  if (!Array.isArray(json)) return [];
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return json.flatMap((e): Installed[] => {
    if (typeof e !== "object" || e === null) return [];
    const { path, name, granted, asked } = e as Record<string, unknown>;
    if (typeof path !== "string" || typeof name !== "string") return [];
    return [{ path, name, granted: strings(granted), asked: strings(asked) }];
  });
}

const describeError = (e: PluginErrorInfo) =>
  `${e.plugin}: ${e.file ? `${e.file}${e.line === null ? "" : `:${e.line}`}: ` : ""}${e.message}`;

export class PluginManager {
  private readonly loaded = new Map<string, Loaded>();
  /** Every Plugin loaded since the start, running or not: what `:plugins` lists. */
  private readonly known = new Map<string, Omit<Loaded, "disposers" | "listens">>();
  private readonly problems = new Map<string, string>();
  /** The replies that came for a Plugin while it loads (answers to what its init.lua asked can
   * overtake the load's own reply): applied once the load's are. */
  private readonly loading = new Map<string, PluginReply[]>();
  /** The Plugin commands running now (`PLUGIN NAME`): a line that runs one of them again would
   * never end (a command whose line names itself, or two naming each other). */
  private readonly runningCommands = new Set<string>();
  /** While a Plugin's `roster.cmd` line runs (issue #183): whose call the Plugin's own command it
   * names is. The user's carried one hop when the line was made in the user's own call, else the
   * app's, so a chain of a Plugin's commands never keeps the user's call alive. */
  private lineCaller: { plugin: string; by: PluginCaller } | null = null;
  private readonly waiting = new Map<string, Prompt>();
  private readonly uses = new Map<string, Use[]>();
  private requests: Record<string, SiteRequests[]> = {};
  private data: Record<string, PluginData> = {};
  private prompts: Prompt[] = [];
  private readonly shown = new Shown();
  private snap: Snapshot = { plugins: [], packages: [], prompts: [], notices: [], float: null, confirm: null, progress: [], declined: [], settled: false };
  private settled = false;
  private packages: PackageStatus[] = [];
  /** The settings each loaded Package got, so a changed init.lua reloads it. */
  private readonly packageConfig = new Map<string, string>();
  private starting: Promise<void> | null = null;
  /** Package work runs one at a time (a sync, an update, a clean). */
  private packageWork: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private readonly feed = new OutputFeed((name, payload) => this.send(name, payload), {
    reads: () => this.readsTerminal(),
    done: () => this.hearsDone(),
  });
  /** The last list of open Sessions sent to the core, once it's there. */
  private sessionsSent: Promise<unknown> = Promise.resolve();
  private started = false;
  /** Every built-in command id seen so far (issue #184), sent with each load, call and event: it
   * only grows, so a built-in an effect takes out and puts back is never a Plugin's own in between. */
  private readonly builtinsSeen = new Set<string>();
  private stopBuiltins: (() => void) | null = null;
  /** Stopped for good (`stop`): nothing loads, no event or call reaches the core. */
  private stopped = false;
  /** What each built-in Plugin was last loaded with, so a change reloads it (`reloadBuiltin`). */
  private readonly builtinConfig = new Map<string, string>();
  /** A Plugin command's last completions (api 3), by plugin and command: what Tab shows while the
   * next answer comes. */
  private readonly completions = new Map<string, { arg: string; list: string[] }>();
  /** The `:check` runs whose `check` returned "later", by `PLUGIN:RUN`: what takes their lines
   * (`roster.health.answer`, decision Q112h). */
  private readonly laterChecks = new Map<string, (checks: unknown) => void>();
  private lastCheck = 0;

  /** What applying an op reaches of the manager (opRegistry.ts). */
  private readonly host: OpHost;

  constructor(
    private readonly backend: PluginBackend,
    private readonly registries: Registries,
    private readonly store: PluginStore,
    private readonly ui: PluginUi,
    private readonly now: () => number = Date.now,
  ) {
    this.host = {
      registries,
      ui,
      shown: this.shown,
      notify: (...args) => this.notify(...args),
      line: (plugin, run, context) => this.line(plugin, run, context),
      runFor: (plugin, run, context, user) => this.runFor(plugin, run, context, user),
      runLine: (plugin, line) => this.runLine(plugin, line),
      call: (plugin, handler, args, what, user) => this.call(plugin, handler, args, what, user),
      current: (plugin) => this.loaded.get(plugin),
      healthCheck: (plugin, id, handler) => this.healthCheck(plugin, id, handler),
      answerCheck: (plugin, check, checks) => this.laterChecks.get(`${plugin}:${check}`)?.(checks),
      runCommand: (plugin, name, run) => {
        const running = `${plugin} ${name}`;
        this.runningCommands.add(running);
        try {
          // Run by the Plugin's own `roster.cmd`, it's the user's call carried, or the app's.
          run(this.lineCaller?.plugin === plugin ? this.lineCaller.by : true);
        } finally {
          this.runningCommands.delete(running);
        }
      },
      runCmdLine: (plugin, by, line) => {
        const outer = this.lineCaller;
        this.lineCaller = { plugin, by };
        try {
          this.runLine(plugin, line);
        } finally {
          this.lineCaller = outer;
        }
      },
      complete: (plugin, command, handler, arg) => this.complete(plugin, command, handler, arg),
      cursor: (plugin, ctx) => this.cursor(plugin, ctx),
    };
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  snapshot = (): Snapshot => this.snap;

  private installed(): Installed[] {
    return parseInstalled(this.store.get(STATE_KEY));
  }

  private saveInstalled(list: Installed[]) {
    this.store.set(STATE_KEY, list);
  }

  private cancelledInstalls(): Declined[] {
    return parseDeclined(this.store.get(DECLINED_KEY));
  }

  private saveCancelled(list: Declined[]) {
    this.store.set(DECLINED_KEY, list);
  }

  /** Whether the user cancelled this Package's install, or took it out with `:plugins remove`,
   * this run or before, from the repo and folder init.lua names now. */
  private isDeclined(p: { name: string; url: string; dir: string | null }): boolean {
    return this.cancelledInstalls().some((d) => d.name === p.name && d.url === p.url && d.dir === p.dir);
  }

  /** Loads the built-in Plugins and every installed one. One that asks for a permission the user
   * hasn't been asked about waits for the update prompt. */
  start(): Promise<void> {
    this.starting ??= this.startNow();
    return this.starting;
  }

  private async startNow(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    // App's effects register some of roster's own commands after this.
    this.stopBuiltins = this.registries.commands.subscribe(() => void this.builtins());
    const list = this.installed();
    for (const path of BUILTIN_PLUGINS) {
      const name = builtinName(path) ?? path;
      const entry = list.find((e) => e.path === path);
      await this.loadPath(path, entry ? entry.granted : null, name);
    }
    // Packages load in syncPackages, once the core has their clones.
    for (const entry of list.filter((e) => builtinName(e.path) === null && packageName(e.path) === null)) {
      try {
        const { manifest } = await this.backend.pluginManifest(entry.path);
        const asking = manifest.permissions.map((p) => p.name).filter((p) => !entry.asked.includes(p));
        if (asking.length > 0) {
          const prompt: Prompt = { kind: "update", path: entry.path, manifest, asking };
          this.waiting.set(entry.name, prompt);
          this.prompts = [...this.prompts, prompt];
          this.changed();
          continue;
        }
        await this.loadPath(entry.path, entry.granted, entry.name);
      } catch (e) {
        this.problems.set(entry.name, String(e instanceof Error ? e.message : e));
        this.changed();
      }
    }
  }

  // ---------------------------------------------------------------- Packages

  private serially<T>(work: () => Promise<T>): Promise<T> {
    const next = this.packageWork.then(work, work);
    this.packageWork = next.catch(() => undefined);
    return next;
  }

  /** Brings the Packages in line with init.lua (at start, and whenever its `packages` change):
   * the core clones what's new and checks out what roster.lock pins; a Package not installed
   * yet gets the install prompt, an installed one loads (again, if its settings changed), and
   * one init.lua no longer names stops. */
  syncPackages(): Promise<void> {
    return this.serially(async () => {
      try {
        await this.syncPackagesNow();
      } finally {
        if (!this.settled) {
          this.settled = true;
          this.changed();
        }
      }
    });
  }

  private async syncPackagesNow(): Promise<void> {
    await this.start();
    {
      let statuses: PackageStatus[];
      try {
        statuses = await this.backend.packagesSync();
      } catch (e) {
        this.notify("packages", "error", `Packages: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      this.packages = statuses;
      // A cancelled install counts while init.lua names the same repo and folder for it.
      const cancelled = this.cancelledInstalls();
      const still = cancelled.filter((d) => statuses.some((p) => p.name === d.name && p.url === d.url && p.dir === d.dir));
      if (still.length !== cancelled.length) this.saveCancelled(still);
      const named = new Set(statuses.map((p) => `${PACKAGE_PREFIX}${p.name}`));
      for (const entry of this.installed().filter((e) => packageName(e.path) !== null && !named.has(e.path))) {
        if (this.loaded.has(entry.name)) await this.unload(entry.name);
        this.problems.set(entry.name, "init.lua no longer names it: :packages clean removes it");
      }
      for (const p of statuses) {
        if (p.error) continue;
        await this.syncPackage(p);
      }
      this.changed();
    }
  }

  private async syncPackage(p: PackageStatus) {
    const path = `${PACKAGE_PREFIX}${p.name}`;
    const entry = this.installed().find((e) => e.path === path);
    if (!p.pinned || !entry) {
      if (this.isDeclined(p)) {
        await this.backend.packagesDiscard(p.name).catch(() => undefined);
        return;
      }
      if (this.prompts.some((x) => x.path === path)) return;
      try {
        const { manifest } = await this.backend.pluginManifest(path);
        const other = this.installed().find((e) => e.name === manifest.name && e.path !== path);
        if (other) {
          this.notify(manifest.name, "error", `The Package ${p.name} is the Plugin ${manifest.name}, which is installed already, from ${other.path}`);
          return;
        }
        this.prompts = [
          ...this.prompts,
          { kind: "install", path, manifest, asking: manifest.permissions.map((x) => x.name), package: { name: p.name, url: p.url, dir: p.dir, commit: p.commit } },
        ];
      } catch (e) {
        this.notify(p.name, "error", `${p.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    const config = JSON.stringify(p.config);
    if (this.loaded.has(entry.name) && this.packageConfig.get(entry.name) === config) return;
    if (this.waiting.has(entry.name)) return;
    this.packageConfig.set(entry.name, config);
    await this.loadPath(path, entry.granted, entry.name);
  }

  /** `:packages update [NAME]`: fetches every Package (or the one named) and asks about each new
   * commit, showing its diff and any permission it newly asks for. Says what it found. NAME not
   * installed gets the install prompt instead, as `:packages install NAME` (issue #213): null once
   * it asks. */
  checkPackages(only?: string): Promise<string | null> {
    return this.serially(async () => {
      await this.start();
      if (only !== undefined) {
        const p = this.packages.find((x) => x.name === only);
        if (!p) return `init.lua names no Package ${only}`;
        if (!p.pinned) return this.installPackageNow(only);
      }
      let checked;
      try {
        checked = await this.backend.packagesCheck(only);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        return only === undefined ? `Couldn't check the Packages: ${why}` : `Couldn't check ${only}: ${why}`;
      }
      const updates: string[] = [];
      const failed: string[] = [];
      for (const c of checked) {
        if (c.error) failed.push(`${c.name}: ${c.error}`);
        const u = c.update;
        if (!u) continue;
        const status = this.packages.find((p) => p.name === c.name);
        const path = `${PACKAGE_PREFIX}${c.name}`;
        const entry = this.installed().find((e) => e.path === path);
        if (!u.manifest) {
          failed.push(`${c.name}: its new version can't be used: ${u.manifestError ?? "no manifest"}`);
          continue;
        }
        if (!entry) continue;
        const asking = u.manifest.permissions.map((x) => x.name).filter((x) => !entry.asked.includes(x));
        this.prompts = [
          ...this.prompts.filter((x) => x.path !== path),
          { kind: "update", path, manifest: u.manifest, asking, package: { name: c.name, url: status?.url ?? "", dir: status?.dir ?? null, commit: u.to, update: u } },
        ];
        updates.push(c.name);
      }
      this.changed();
      const upToDate = only === undefined ? "All Packages are up to date" : `${only} is up to date`;
      const found = updates.length === 0 ? upToDate : `${updates.length === 1 ? "An update" : `${updates.length} updates`}: ${updates.join(", ")}`;
      return failed.length ? `${found}. ${failed.join("; ")}` : found;
    });
  }

  /** `:packages clean`: removes the Packages init.lua no longer names, and what they added. */
  cleanPackages(): Promise<string> {
    return this.serially(async () => {
      let gone: string[];
      try {
        gone = await this.backend.packagesClean();
      } catch (e) {
        return `Couldn't clean the Packages: ${e instanceof Error ? e.message : String(e)}`;
      }
      const paths = new Set(gone.map((n) => `${PACKAGE_PREFIX}${n}`));
      for (const entry of this.installed().filter((e) => paths.has(e.path))) {
        await this.forget(entry.name);
        await this.backend.pluginForget(entry.name).catch(() => false);
      }
      this.saveInstalled(this.installed().filter((e) => !paths.has(e.path)));
      this.changed();
      return gone.length === 0 ? "Nothing to clean: init.lua names every Package" : `Removed ${gone.join(", ")}`;
    });
  }

  /** `:packages install NAME`: asks again about a Package init.lua names that isn't installed,
   * one whose install was cancelled (or that `:plugins remove` took out). Null once it asks. */
  installPackage(name: string): Promise<string | null> {
    return this.serially(async () => {
      await this.start();
      return this.installPackageNow(name);
    });
  }

  private async installPackageNow(name: string): Promise<string | null> {
    const p = this.packages.find((x) => x.name === name);
    if (!p) return `init.lua names no Package ${name}`;
    const path = `${PACKAGE_PREFIX}${name}`;
    if (p.pinned && this.installed().some((e) => e.path === path)) return `${name} is installed already: :packages update ${name} checks it for a new version`;
    this.saveCancelled(this.cancelledInstalls().filter((d) => d.name !== name));
    await this.syncPackagesNow();
    if (this.prompts.some((x) => x.path === path)) return null;
    const now = this.packages.find((x) => x.name === name);
    if (now?.error) return `${name}: ${now.error}`;
    // Installed before, and couldn't be fetched (errors.md row 116): it loads again as it was.
    if (now?.pinned && this.installed().some((e) => e.path === path)) return `Fetched ${name}`;
    return `${name} can't be installed: see :packages`;
  }

  /** `:plugins install PATH`: reads the manifest and asks (the install prompt). Nothing runs yet. */
  async install(path: string): Promise<string | null> {
    if (packageName(path) !== null) return "A Package installs from init.lua's packages: :help packages";
    try {
      const { manifest, dir } = await this.backend.pluginManifest(path);
      const already = this.installed().find((e) => e.name === manifest.name);
      if (already && already.path !== dir) return `A Plugin named ${manifest.name} is installed already, from ${already.path}`;
      this.prompts = [
        ...this.prompts.filter((p) => p.manifest.name !== manifest.name),
        { kind: "install", path: dir, manifest, asking: manifest.permissions.map((p) => p.name) },
      ];
      this.changed();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  /** The user's answer to a prompt: install or allow (true), or cancel (false). Cancelling an
   * install installs nothing; declining an update's new permissions runs it without them (each
   * can be granted later in `:plugins`). */
  async answer(prompt: Prompt, allow: boolean): Promise<void> {
    this.prompts = this.prompts.filter((p) => p !== prompt);
    const name = prompt.manifest.name;
    this.waiting.delete(name);
    this.changed();
    const pkg = prompt.package;
    if (pkg && prompt.kind === "install") {
      if (!allow) {
        this.saveCancelled([...this.cancelledInstalls().filter((d) => d.name !== pkg.name), { name: pkg.name, url: pkg.url, dir: pkg.dir }]);
        await this.backend.packagesDiscard(pkg.name).catch(() => undefined);
        this.changed();
        return;
      }
      try {
        const pinned = await this.backend.packagesPin(pkg.name);
        this.packages = this.packages.map((p) => (p.name === pkg.name ? pinned : p));
      } catch (e) {
        this.notify(name, "error", `${pkg.name}: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      this.packageConfig.set(name, JSON.stringify(this.packages.find((p) => p.name === pkg.name)?.config ?? {}));
    }
    if (pkg?.update) {
      // Declining a Package's update keeps the version it has: nothing changes.
      if (!allow) return;
      try {
        const moved = await this.backend.packagesApply(pkg.name, pkg.update.to);
        this.packages = this.packages.map((p) => (p.name === pkg.name ? moved : p));
      } catch (e) {
        this.notify(name, "error", `${pkg.name}: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    if (prompt.kind === "install" && !allow) return;
    const list = this.installed();
    const old = list.find((e) => e.name === name);
    const asked = [...new Set([...(old?.asked ?? []), ...prompt.asking])];
    const granted = allow ? [...new Set([...(old?.granted ?? []), ...prompt.asking])] : (old?.granted ?? []);
    const entry: Installed = { path: prompt.path, name, granted, asked };
    this.saveInstalled([...list.filter((e) => e.name !== name), entry]);
    await this.loadPath(entry.path, entry.granted, name);
  }

  /** Grants or revokes one permission (`:plugins`' toggles): the Plugin is loaded again with its
   * new grants at once, so a revoked function is gone and its UI with it. */
  async setGrant(name: string, permission: string, on: boolean): Promise<void> {
    const status = this.snap.plugins.find((p) => p.name === name);
    if (!status) return;
    const list = this.installed();
    const entry = list.find((e) => e.name === name) ?? {
      path: status.path,
      name,
      granted: [...status.granted],
      asked: status.manifest?.permissions.map((p) => p.name) ?? [],
    };
    const granted = on ? [...new Set([...entry.granted, permission])] : entry.granted.filter((g) => g !== permission);
    this.saveInstalled([...list.filter((e) => e.name !== name), { ...entry, granted, asked: [...new Set([...entry.asked, permission])] }]);
    await this.loadPath(entry.path, granted, name);
  }

  /** `:plugins reload NAME`: loads it again (after fixing it, or once it was disabled). */
  async reload(name: string): Promise<string | null> {
    const status = this.snap.plugins.find((p) => p.name === name);
    if (!status) return `No Plugin named ${name}`;
    await this.loadPath(status.path, [...status.granted], name);
    return null;
  }

  /** `:plugins types PATH` (ticket 74): writes the API's stubs into a Plugin's folder; says where. */
  async writeTypes(path: string): Promise<string> {
    try {
      const file = await this.backend.pluginTypes(path);
      return `Wrote ${file}: the Plugin API ${pluginApiVersion}'s types, for lua-language-server`;
    } catch (e) {
      return `Couldn't write the types: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** `:plugins remove NAME`: unloads it, takes its UI away and forgets it. A built-in one can only
   * have its permissions revoked. */
  async remove(name: string): Promise<string | null> {
    const status = this.snap.plugins.find((p) => p.name === name);
    if (!status) return `No Plugin named ${name}`;
    if (status.builtin) return `${name} is built into roster: revoke its permissions in :plugins instead`;
    const pkg = packageName(status.path);
    if (pkg !== null) {
      // A Package goes altogether: its clone and its line in roster.lock too.
      try {
        await this.backend.packagesRemove(pkg);
      } catch (e) {
        return `Couldn't remove ${pkg}: ${e instanceof Error ? e.message : String(e)}`;
      }
      // Remembered like a cancelled install (issue #213): the next start doesn't ask again while
      // init.lua names the same repo and folder; `:packages install NAME` does.
      const named = this.packages.find((p) => p.name === pkg);
      if (named) this.saveCancelled([...this.cancelledInstalls().filter((d) => d.name !== pkg), { name: pkg, url: named.url, dir: named.dir }]);
      this.packages = this.packages.map((p) => (p.name === pkg ? { ...p, commit: null, locked: null, pinned: false } : p));
    }
    await this.forget(name);
    // Its data folder goes with it (decision Q93): a Plugin installed again starts empty.
    await this.backend.pluginForget(name).catch(() => false);
    this.saveInstalled(this.installed().filter((e) => e.name !== name));
    this.changed();
    const stillNamed = pkg !== null && this.packages.some((p) => p.name === pkg);
    return stillNamed ? `Removed ${name}. init.lua still names it: :packages install ${pkg} brings it back` : null;
  }

  /** Unloads a Plugin and forgets what the manager knew of it (not its State entry). */
  private async forget(name: string) {
    await this.unload(name);
    this.known.delete(name);
    this.problems.delete(name);
    this.uses.delete(name);
    this.packageConfig.delete(name);
  }

  /** Runs what a Plugin's row, action, finder item or segment handed over, telling it which one
   * (`context`) and, when it may know, the Session on screen. */
  callWith(plugin: string, handler: number, context: HandlerContext, what = "ran an action", user: PluginCaller = true): Promise<unknown> {
    return this.call(plugin, handler, { ...context, ...this.onScreen(plugin) }, what, user);
  }

  /** The Session on screen, for a Plugin that may know it (the permissions that let it hear
   * `host_selected`): `{}` otherwise, or with none on screen. */
  private onScreen(plugin: string): HandlerContext {
    const granted = this.loaded.get(plugin)?.granted ?? [];
    if (!granted.includes("inventory.read") && !granted.includes("terminal.read")) return {};
    const on = this.ui.onScreen?.() ?? null;
    return on ? { session: on.session, session_host: on.host } : {};
  }

  /** Runs what a Plugin's row, action, finder item or command handed over; `what` is how
   * `:plugins` lists it among its recent use (null: not at all, a timer). `user`: whether the user
   * chose it (false: the app runs it on its own, never the user's call; "carried": the Plugin's own
   * command its `roster.cmd` ran from the user's call, that call one hop on). */
  async call(plugin: string, handler: number, args: unknown = {}, what: string | null = "ran an action", user: PluginCaller = true): Promise<unknown> {
    if (!this.loaded.has(plugin)) return undefined;
    if (what !== null) this.used(plugin, what);
    const reply = await this.backend.pluginCall(plugin, handler, args, user, this.builtins()).catch((e: unknown) => this.lost(plugin, e));
    this.apply(reply, { background: user === false });
    return reply.result;
  }

  /** A reply nobody asked for, from the core: what a Plugin did when one of its requests answered,
   * over the network (decision Q97) or from roster serve (Q103). Applied like a call's, if the
   * Plugin still runs. */
  replied(reply: PluginReply): void {
    const held = this.loading.get(reply.plugin);
    if (held) return void held.push(reply);
    if (!this.loaded.has(reply.plugin)) return;
    this.used(reply.plugin, "got an answer to a request");
    this.apply(reply, { background: true });
  }

  /** Tells the Plugins that listen. A Session that ended sends what it had first. */
  async event(name: PluginEventName, payload: Record<string, unknown> = {}): Promise<void> {
    if (this.stopped) return;
    if (name === "session_exit" && typeof payload.session === "number") await this.feed.ended(payload.session);
    return this.send(name, payload);
  }

  /** The Sessions open now, in the order they opened: the whole list, which replaces the core's
   * (`roster.sessions.list()`, ticket 96). Sent even while no Plugin runs, so one loaded later
   * knows them; a Session event sent after it waits for it, so a listener's list agrees. */
  sessions(open: OpenSession[]): void {
    if (this.stopped) return;
    // A list the core didn't take is replaced whole by the next, so a failed send needs no retry;
    // what follows it (a Session event, a load) still waits for it, and doesn't fail with it.
    this.sessionsSent = this.sessionsSent.then(() => this.backend.pluginSessions(open)).catch(() => {});
  }

  private async send(name: PluginEventName, payload: Record<string, unknown>): Promise<void> {
    if (name === "session_open" || name === "session_exit") await this.sessionsSent;
    if (this.loaded.size === 0) return;
    const replies = await this.backend.pluginEvent(name, payload, this.builtins()).catch(() => []);
    for (const r of replies) {
      this.used(r.plugin, `heard ${name}`);
      this.apply(r, { background: true });
    }
  }

  /** Whether any running Plugin may read the Sessions' output (so it's worth decoding). */
  readsTerminal(): boolean {
    return [...this.loaded.values()].some((l) => l.granted.includes("terminal.read"));
  }

  /** Whether any running Plugin hears `command_done` (#223, Q185): only then is a command's
   * output kept for it. The core says which events each listens for (a reply's `listens`). */
  private hearsDone(): boolean {
    return [...this.loaded.values()].some((l) => l.granted.includes("terminal.read") && l.listens.has("command_done"));
  }

  /** A Session's output (tabs' tap), with the size of its terminal: the lines it commits go as
   * `terminal_output` to the Plugins granted terminal.read (outputFeed.ts). */
  output(session: number, host: string | null, data: Uint8Array, size: ScreenSize) {
    this.feed.output(session, host, data, size);
  }

  /** Sends the lines committed so far (tests call it rather than wait). */
  flushOutput(): Promise<void> {
    return this.feed.flush();
  }

  /** A Session that ended takes its terminal with it. */
  sessionGone(session: number) {
    this.feed.gone(session);
  }

  /** A notice's button (ticket 91): the user's click runs its command line, as `roster.cmd` would
   * (so `view ID` may open the Plugin's view), and the notice goes. */
  noticeAction(id: number, index: number) {
    const a = this.shown.notices.find((x) => x.id === id)?.actions?.[index];
    if (!a) return;
    const n = this.shown.dismissNotice(id);
    this.changed();
    if (n) this.runLine(n.plugin, a.command);
  }

  dismissNotice(id: number) {
    this.shown.dismissNotice(id);
    this.changed();
  }

  closeFloat() {
    if (!this.shown.float) return;
    this.shown.float = null;
    this.changed();
  }

  /** Loads built-in Plugin `name` again if its settings changed (init.lua's Folders did). */
  async reloadBuiltin(name: string): Promise<void> {
    if (!this.started || !this.loaded.has(name)) return;
    const path = `${BUILTIN_PREFIX}${name}`;
    const settings = await this.builtinSettings(name);
    if (this.builtinConfig.get(name) === JSON.stringify(settings)) return;
    const entry = this.installed().find((e) => e.path === path);
    await this.loadPath(path, entry ? entry.granted : null, name);
  }

  /** The settings built-in Plugin `name` gets, or null: one the app can't read is said, and the
   * Plugin loads without them rather than not at all. */
  private async builtinSettings(name: string): Promise<Record<string, unknown> | null> {
    try {
      return (await this.ui.builtinSettings?.(name)) ?? null;
    } catch (e) {
      this.notify(name, "warn", `${name}: loads without its settings: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** What `:tutor`'s demo loads (ticket 66, decision Q123): the Plugins running now, each with what
   * it was granted (asked about all it asks, so the demo prompts for nothing), and the Packages
   * among them. A Plugin stopped, waiting for an answer, or not installed doesn't come along. */
  forDemo(): DemoPlugins {
    const installed = [...this.loaded.values()].map((l) => ({ path: l.path, name: l.manifest.name, granted: [...l.granted], asked: l.manifest.permissions.map((p) => p.name) }));
    const paths = new Set(installed.map((e) => e.path));
    return { installed, packages: this.packages.filter((p) => p.pinned && paths.has(`${PACKAGE_PREFIX}${p.name}`)) };
  }

  /** Stops every Plugin for good (ticket 66: the demo's manager, when the tutorial ends): their UI,
   * timers and listeners go, and nothing more is loaded, sent or called. The core's copies are
   * the caller's to stop (the demo's host goes with the demo). */
  stop(): void {
    this.stopped = true;
    this.stopBuiltins?.();
    this.stopBuiltins = null;
    for (const [name, l] of [...this.loaded]) {
      for (const d of l.disposers.values()) d();
      this.loaded.delete(name);
      this.forgetUi(name);
    }
    this.feed.stop();
    this.changed();
  }

  /** Every loaded or known Plugin's name (`:plugins remove` completes them). */
  names(): string[] {
    return this.snap.plugins.map((p) => p.name);
  }

  /** roster's own commands, every one seen so far, sorted. */
  private builtins(): string[] {
    for (const c of this.registries.commands.list()) if (c.source === BUILTIN) this.builtinsSeen.add(c.id);
    return [...this.builtinsSeen].sort();
  }

  // ---------------------------------------------------------------- loading

  private async loadPath(path: string, granted: string[] | null, name: string) {
    if (!this.loading.has(name)) this.loading.set(name, []);
    try {
      await this.loadNow(path, granted, name);
    } finally {
      const held = this.loading.get(name) ?? [];
      this.loading.delete(name);
      for (const r of held) this.replied(r);
    }
  }

  private async loadNow(path: string, granted: string[] | null, name: string) {
    if (this.stopped) return;
    let result;
    try {
      // A built-in Plugin is granted everything it asks for until a permission is revoked.
      const builtin = builtinName(path);
      const settings = builtin === null ? null : await this.builtinSettings(builtin);
      if (builtin !== null) this.builtinConfig.set(builtin, JSON.stringify(settings));
      // The list of open Sessions sent last is in the core first: the Plugin may read it at load.
      await this.sessionsSent;
      result = await this.backend.pluginLoad(path, granted ?? ["inventory.read", "inventory.write", "sessions.open", "terminal.read", "terminal.write"], settings, this.builtins());
    } catch (e) {
      await this.unload(name);
      this.problems.set(name, e instanceof Error ? e.message : String(e));
      this.notify(name, "error", `${this.named(name)}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const { manifest, reply } = result;
    // Stopped while it loaded: the core's copy goes too, and nothing of it is shown.
    if (this.stopped) return void (await this.backend.pluginUnload(manifest.name).catch(() => false));
    await this.unload(manifest.name, false);
    const asked = manifest.permissions.map((p) => p.name);
    const info = { manifest, path, granted: granted === null ? asked : granted.filter((g) => asked.includes(g)) };
    this.known.set(manifest.name, info);
    this.loaded.set(manifest.name, { ...info, listens: new Set(), disposers: new Map() });
    this.problems.delete(manifest.name);
    this.apply(reply, { loading: true, background: true });
    for (const why of result.refused ?? []) this.notify(manifest.name, "warn", `${manifest.name}: runs without a grant this version of roster doesn't take: ${why}`);
    this.changed();
  }

  private async unload(name: string, tellCore = true) {
    const l = this.loaded.get(name);
    if (l) {
      for (const d of l.disposers.values()) d();
      this.loaded.delete(name);
    }
    this.forgetUi(name);
    if (tellCore) await this.backend.pluginUnload(name).catch(() => false);
  }

  private lost(plugin: string, e: unknown): PluginReply {
    return {
      plugin,
      result: null,
      ops: [],
      error: { plugin, file: null, line: null, message: e instanceof Error ? e.message : String(e) },
      disabled: null,
    };
  }

  /** Applies a reply: its ops, then its error and whether it's now disabled. The core is the one
   * judge of what a Plugin may do: a `copy` op is in a reply only to a call the user started.
   * Notices after a copy wait for it: if it fails, they're dropped ("Copied" would be a lie) and
   * the failure is said instead (decision Q87). `background`: nothing the user did asked for it (a
   * timer, an event, a request's answer, a load), so a quiet notice keeps a line that shows (Q162). */
  private apply(reply: PluginReply, { loading = false, background = false }: { loading?: boolean; background?: boolean } = {}) {
    const name = reply.plugin;
    const l = this.loaded.get(name);
    if (l && reply.listens) l.listens = new Set(reply.listens);
    if (l) {
      const call: OpCall = { host: this.host, plugin: name, loaded: l, background, copying: null };
      for (const raw of reply.ops) {
        const op = parseOp(raw);
        if ("invalid" in op) this.notify(name, "warn", `${name}: ${op.invalid}`);
        else applyOp(call, op);
      }
    }
    if (reply.error) {
      const error = loading ? { ...reply.error, plugin: this.named(reply.error.plugin) } : reply.error;
      this.notify(name, "error", describeError(error) + (reply.disabled ? ". It's disabled." : ""));
    }
    if (reply.disabled) {
      this.problems.set(name, reply.disabled);
      if (l) {
        for (const d of l.disposers.values()) d();
        this.loaded.delete(name);
      }
      this.forgetUi(name);
    }
    this.changed();
  }

  /** Takes everything `name` put up away: its registry entries, float, question and progress. */
  private forgetUi(name: string) {
    for (const r of Object.values(this.registries)) (r as { unregisterSource(s: string): void }).unregisterSource(name);
    this.shown.forget(name);
  }

  /** The command line that runs `run` for `plugin`. A Plugin's own line goes through
   * `plugins run`, which checks it may (ticket 78): the label on a button says nothing about it.
   * A function hears `context`, what ran it (api 3), carried URI-encoded so spaces can't change it. */
  private line(plugin: string, run: Run, context: HandlerContext = {}): string {
    return "command" in run
      ? `plugins run ${plugin} ${run.command}`
      : `plugins call ${plugin} ${run.handler} ${encodeURIComponent(JSON.stringify(context))}`;
  }

  /** Runs `line` for `plugin` if it may (cmd.ts), else says why. */
  runLine(plugin: string, line: string) {
    const l = this.loaded.get(plugin);
    if (!l) return;
    const refused = lineRefused(line, plugin, l.granted, (name) => this.registries.commands.get(name)?.source);
    if (refused) return this.notify(plugin, "warn", `${plugin}: ${refused}`);
    const word = line.trim().split(/\s+/)[0] ?? "";
    if (this.runningCommands.has(`${plugin} ${word}`)) return this.notify(plugin, "warn", `${plugin}: :${word} runs itself (its line runs again)`);
    this.ui.run(line.trim());
  }

  /** Runs what `plugin` handed over: its function (with `context`, and the Session on screen
   * when it may know it), or its line. */
  private runFor(plugin: string, run: Run, context: HandlerContext = {}, user: PluginCaller = true) {
    if ("command" in run) this.runLine(plugin, run.command);
    else void this.callWith(plugin, run.handler, context, "ran an action", user);
  }

  /** The user's answer to the question up: `run` on yes, `cancel` on no (ticket 78). */
  answerConfirm(yes: boolean) {
    const c = this.shown.answer();
    if (!c) return;
    this.changed();
    if (yes) this.runFor(c.plugin, c.run, { confirm: "yes" });
    else if (c.cancel) this.runFor(c.plugin, c.cancel, { confirm: "no" });
  }

  /** `:cancel [ID]`: stops a progress through its Plugin's `cancel`. Says what happened. */
  cancelProgress(id?: string): Message {
    const progress = this.shown.progress;
    const list = [...progress.values()];
    const p = id ? progress.get(id) : list.filter((x) => x.cancel && !x.stopping).at(-1);
    if (!p) return id ? `Nothing called ${id} is running: :cancel lists none` : "Nothing running can be cancelled";
    if (!p.cancel) return `${p.title} can't be stopped`;
    if (p.stopping) return `${p.title}: stopping already`;
    progress.set(p.id, { ...p, stopping: true });
    this.changed();
    this.runFor(p.plugin, p.cancel, { progress: p.id });
    // Quiet (ticket 117): the progress itself shows it's stopping.
    return quiet(`Stopping ${p.title}`);
  }

  /** The ids `:cancel` completes: what can be stopped now. */
  cancellable(): string[] {
    return [...this.shown.progress.values()].filter((p) => p.cancel && !p.stopping).map((p) => p.id);
  }

  /** A float's button, by its place (ticket 78). */
  floatAction(index: number) {
    const f = this.shown.float;
    const a = f?.actions[index];
    if (f && a) this.runFor(f.plugin, a.run, { action: index + 1 });
  }

  /** A float's link: the address was checked when it came (http or https). */
  openLink(index: number) {
    const link = this.shown.float?.links[index];
    if (link) this.ui.openUrl?.(link.url);
  }

  /** Calls a `:check` section's `check` and gives its lines; what goes wrong is an ERROR line. */
  private async healthCheck(plugin: string, id: string, handler: number) {
    const error = (message: string) => [{ section: id, level: "error" as const, message, fix: `:plugins says how ${plugin} is doing; :plugins reload ${plugin} runs it again` }];
    if (!this.loaded.has(plugin)) return error(`${plugin} isn't running`);
    // Waiting for its answer before it runs: it may answer in the same reply.
    const run = ++this.lastCheck;
    const key = `${plugin}:${run}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answered = new Promise<{ checks: unknown } | "late">((resolve) => {
      this.laterChecks.set(key, (checks) => resolve({ checks }));
      timer = setTimeout(() => resolve("late"), HEALTH_LATER_MS);
    });
    let result: unknown;
    try {
      const reply = await this.backend.pluginCall(plugin, handler, { health: id, check: run, ...this.onScreen(plugin) }, false, this.builtins()).catch((e: unknown) => this.lost(plugin, e));
      this.used(plugin, "ran its :check section");
      this.apply(reply);
      if (reply.error) return error(`check failed: ${describeError(reply.error)}`);
      result = reply.result;
      if (result === "later") {
        const later = await answered;
        if (later === "late") return error(`check said it would answer later, and didn't within ${HEALTH_LATER_MS / 1000} seconds`);
        result = later.checks;
      }
    } finally {
      clearTimeout(timer);
      this.laterChecks.delete(key);
    }
    const parsed = parseHealthChecks(result, `roster.health.set ${id}: check`);
    if ("invalid" in parsed) return error(parsed.invalid);
    return parsed.map((c) => ({ section: id, ...c }));
  }

  /** What a Plugin's command hears of the Sidebar (api 3): the Host under the cursor (else on
   * screen) with inventory.read, and the row when it's on one of the Plugin's own sections. */
  private cursor(plugin: string, ctx: CommandContext): HandlerContext {
    const granted = this.loaded.get(plugin)?.granted ?? [];
    const out: HandlerContext = {};
    if (granted.includes("inventory.read")) {
      const host = typeof ctx.selectedHost === "function" ? ctx.selectedHost() : null;
      if (host) out.host = host;
    }
    const row = typeof ctx.cursorRow === "function" ? ctx.cursorRow() : null;
    for (const s of this.registries.sidebar.list()) {
      if (s.source !== plugin || !row) continue;
      if (row.id === `section:${s.id}`) out.section = s.id;
      else if (row.id.startsWith(`${s.id}:`)) {
        out.section = s.id;
        out.row = row.id.slice(s.id.length + 1);
      }
    }
    return out;
  }

  /** A Plugin command's `complete` (api 3): the app's completion is synchronous, so it answers
   * with the last list the Plugin gave (kept to what still matches) and asks again; the answer
   * redraws the command line. */
  private complete(plugin: string, command: string, handler: number, arg: string): string[] {
    const key = `${plugin}\0${command}`;
    const last = this.completions.get(key);
    if (last && last.arg === arg) return last.list;
    void this.call(plugin, handler, arg, null, false).then((result) => {
      const list = Array.isArray(result) ? result.filter((x): x is string => typeof x === "string").slice(0, 200) : [];
      const before = this.completions.get(key);
      this.completions.set(key, { arg, list });
      if (JSON.stringify(before) !== JSON.stringify({ arg, list })) this.changed();
    });
    // Until it answers: the last list, kept to what still starts with what's typed.
    return (last?.list ?? []).filter((c) => c.toLowerCase().startsWith(arg.toLowerCase()));
  }

  /** A Plugin's name as a load failure names it: marked "(in the demo)" on `:tutor`'s demo (#233). */
  private named(plugin: string): string {
    return this.ui.demo ? `${plugin} (in the demo)` : plugin;
  }

  /** A notice; an info one is quiet (on the message line, heard but not seen) unless it has
   * buttons or the Plugin said `quiet = false`, while `ui.messages` is quiet (ticket 117).
   * Warnings and errors always show. `:messages` keeps it either way. Public for the app's own
   * notices about Plugins, as `:tutor`'s demo's (ticket 66). `background`: nothing the user did
   * asked for it, so quiet, it keeps a line that shows, an error above all (decision Q162). */
  notify(plugin: string, level: Notice["level"], text: string, actions: Notice["actions"] = [], asked?: boolean, background = false) {
    const routine = level === "info" && (asked ?? actions.length === 0);
    if (routine && this.ui.say && this.ui.messagesAll?.() === false) return this.ui.say(background ? backgroundQuiet(text) : quiet(text));
    this.ui.log?.(text);
    this.shown.addNotice({ plugin, level, text, ...(actions.length ? { actions } : {}) });
    this.changed();
  }

  /** Asks the core how many requests each Plugin sent to each site (`:plugins` opening). A core
   * that can't say leaves the counts as they were. */
  async refreshRequests(): Promise<void> {
    let next: Record<string, SiteRequests[]>;
    try {
      next = await this.backend.pluginRequests();
    } catch {
      return;
    }
    // Asked every few seconds while :plugins is open: the same counts redraw nothing.
    if (JSON.stringify(next) === JSON.stringify(this.requests)) return;
    this.requests = next;
    this.changed();
  }

  /** Asks the core how full each Plugin's data folder is (`:plugins` opening, ticket 98): one
   * listing per folder, so once per opening rather than with the request counts. A core that
   * can't say leaves the sizes as they were. */
  async refreshData(): Promise<void> {
    let next: Record<string, PluginData>;
    try {
      next = await this.backend.pluginData(this.snap.plugins.map((p) => p.name));
    } catch {
      return;
    }
    if (JSON.stringify(next) === JSON.stringify(this.data)) return;
    this.data = next;
    this.changed();
  }

  private used(plugin: string, what: string) {
    const list = this.uses.get(plugin) ?? [];
    this.uses.set(plugin, [{ at: this.now(), what }, ...list].slice(0, MAX_USES));
  }

  private changed() {
    const names = new Set([...this.known.keys(), ...this.problems.keys(), ...this.waiting.keys(), ...this.installed().map((e) => e.name)]);
    const installed = this.installed();
    const plugins = [...names].sort().map((name): PluginStatus => {
      const l = this.known.get(name);
      const entry = installed.find((e) => e.name === name);
      const path = l?.path ?? entry?.path ?? this.waiting.get(name)?.path ?? `${BUILTIN_PREFIX}${name}`;
      return {
        name,
        path,
        builtin: builtinName(path) !== null,
        manifest: l?.manifest ?? this.waiting.get(name)?.manifest ?? null,
        granted: l?.granted ?? entry?.granted ?? [],
        problem: this.problems.get(name) ?? null,
        waiting: this.waiting.has(name),
        uses: this.uses.get(name) ?? [],
        requests: this.requests[name] ?? [],
        data: this.data[name] ?? null,
      };
    });
    this.snap = {
      plugins,
      packages: this.packages,
      prompts: this.prompts,
      notices: this.shown.notices,
      float: this.shown.float,
      confirm: this.shown.confirm,
      progress: [...this.shown.progress.values()],
      declined: this.packages.filter((p) => !p.pinned && this.isDeclined(p)).map((p) => p.name),
      settled: this.settled,
    };
    for (const l of this.listeners) l();
  }
}

