// Plugins in the frontend (ticket 23, ADR 0006, decisions Q81 and Q82; docs/plugins.md). The Lua
// runs in roster-core; this module is everything the app does around it, behind one object:
//
// - which Plugins are installed and what each was granted, kept in the State (`plugins`), and the
//   install and update prompts (`install`, `answer`): nothing loads with a permission the user
//   wasn't asked about;
// - turning a Plugin's ops into registry entries with the Plugin's name as their source, so the
//   core draws them in roster's style and unloading takes them all away (`unregisterSource`);
// - running what a Plugin handed over (`plugins call NAME N`), and sending it events, among them
//   the Sessions' output for the Plugins granted terminal.read;
// - errors: a toast naming the Plugin, file and line, and its UI taken away once it's disabled.
//
// - Packages (ticket 24): Plugins from git repos that init.lua names. The core clones and pins them
//   (`packagesSync`); each one is the Plugin `package:NAME` and goes through the same install
//   prompt, showing its git URL as the unverified source. Cancel removes the clone and is kept in
//   the State (`DECLINED_KEY`) until `:packages install NAME`. `:packages update [NAME]` shows each
//   new commit with its diff and any new permission before applying it, and declining keeps the
//   old version.
//
// `:plugins` (the command and panel), `:packages` and the prompts are drawn by PluginsPanel.tsx.
import type { Backend, Host, OpenSession, PackageStatus, PackageUpdate, PluginErrorInfo, PluginEventName, PluginCaller, PluginManifest, PluginData, PluginReply, SiteRequests } from "../backend/types";
import { themeOf } from "../config/apply";
import type { CommandContext, CommandDef } from "../commands/table";
import { sectionFinder, type FinderItem, type FinderSourceDef } from "../finder/sources";
import { hostRow } from "../sidebar/sections";
import { parseMarkdown } from "../help/markdown";
import { pluginTutorial } from "../tutor/plugin";
import { DEFAULT_TUTORIAL, tutorPage } from "../tutor/tutor";
import { HEALTH_LATER_MS, SECTION_WAIT_MS } from "../health/health";
import { bindingId, type KeymapContext } from "../keymap";
import type { Registries } from "../registries";
import { BUILTIN } from "../registry";
import type { SidebarRow } from "../sidebar/Sidebar";
import pluginApi from "../../../crates/roster-core/tests/fixtures/plugin-api.json";
import { lineRefused } from "./cmd";
import { CommittedLines, lastLines, OUTPUT_MAX, type Run as OutputRun, type ScreenSize } from "./committed";
import {
  MAX_TABLE_ROWS,
  parseFinderItems,
  parseHealthChecks,
  parseOp,
  type PluginConfirm,
  type PluginContent,
  type PluginFinderItem,
  type PluginFloat,
  type PluginOp,
  type PluginProgress,
  type PluginRow,
  type PluginRowAction,
  type PluginView,
  type Run,
} from "./ops";
import { mergeRows, type TableRow } from "../ui/table";
import { detailsId, type Content, type GraphModel } from "../view/views";
import { mergeGraph, type GraphNode } from "../graph/model";
import { MAX_CLUSTERS, MAX_EDGES, MAX_NODES, type PluginGraph } from "./graphOps";
import { quiet, type Message } from "../ui/messages";

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
}

/** What a Plugin's function is told about what ran it (api 3, `HandlerContext`). */
export type HandlerContext = Record<string, string | number | null>;

/** A Plugin as the State keeps it. */
export interface Installed {
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

/** The built-in features written as Plugins: always installed, granted what they ask until revoked. */
export const BUILTIN_PLUGINS = ["builtin:hosts", "builtin:folders"] as const;

export const STATE_KEY = "plugins";
/** The State's Packages whose install the user cancelled: not asked again while init.lua names
 * the same repo and folder for them (issue #111). */
export const DECLINED_KEY = "packagesDeclined";

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
export interface Use {
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

/** A Plugin's message for the toast: its error, or what it asked to say. */
export interface Notice {
  id: number;
  plugin: string;
  level: "info" | "warn" | "error";
  text: string;
  /** Buttons (ticket 91): each runs a command line for its Plugin, on the user's click. */
  actions?: readonly { label: string; command: string }[];
}

/** A Plugin's question, waiting for the user's answer (ticket 78). */
export type PendingConfirm = PluginConfirm & { plugin: string; id: number };

/** Something long a Plugin is doing (ticket 78). `stopping` once the user cancelled it. */
export type RunningProgress = PluginProgress & { plugin: string; id: string; stopping: boolean };

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
export interface PluginStore {
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
  | "pluginBuiltins"
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
export const PACKAGE_PREFIX = "package:";
const packageName = (path: string) => (path.startsWith(PACKAGE_PREFIX) ? path.slice(PACKAGE_PREFIX.length) : null);


/** Contexts a Plugin may bind keys in: after the Leader and in the Sidebar, never the terminal. */
const KEY_CONTEXTS: Record<string, KeymapContext> = { leader: "leader", list: "list", list_vim: "listVim" };

const MAX_USES = 8;
const MAX_NOTICES = 4;
/** How often the Sessions' output goes to the Plugins that read it, and how much at once. */
const OUTPUT_EVERY_MS = 200;

/** The Installed entries in the State (untrusted): anything malformed is dropped. */
export function parseInstalled(json: unknown): Installed[] {
  if (!Array.isArray(json)) return [];
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return json.flatMap((e): Installed[] => {
    if (typeof e !== "object" || e === null) return [];
    const { path, name, granted, asked } = e as Record<string, unknown>;
    if (typeof path !== "string" || typeof name !== "string") return [];
    return [{ path, name, granted: strings(granted), asked: strings(asked) }];
  });
}

export const describeError = (e: PluginErrorInfo) =>
  `${e.plugin}: ${e.file ? `${e.file}${e.line === null ? "" : `:${e.line}`}: ` : ""}${e.message}`;

/** Up to three key sequences like `keys` (the same keys before its last) that nothing in
 * `context` binds, and that hide no binding nor are hidden by one: what to suggest instead. */
export function freeKeys(bindings: readonly { context: string; keys: string; source: string; action: string | null }[], context: string, keys: string, plugin: string): string[] {
  const parts = keys.split(" ");
  const prefix = parts.slice(0, -1).join(" ");
  const bound = bindings.filter((b) => b.context === context && b.source !== plugin && b.action !== null).map((b) => b.keys);
  const clashes = (k: string) => bound.some((b) => b === k || b.startsWith(`${k} `) || k.startsWith(`${b} `));
  return [..."abcdefghijklmnopqrstuvwxyz"]
    .map((c) => (prefix ? `${prefix} ${c}` : c))
    .filter((k) => !clashes(k))
    .slice(0, 3);
}

interface Loaded {
  manifest: PluginManifest;
  path: string;
  granted: string[];
  disposers: Map<string, () => void>;
  /** Its views as last set and updated, so an update changes some rows in place. */
  views?: Map<string, PluginView>;
}

export class PluginManager {
  /** The Plugins running now. */
  private readonly loaded = new Map<string, Loaded>();
  /** Every Plugin loaded since the start, running or not: what `:plugins` lists. */
  private readonly known = new Map<string, Omit<Loaded, "disposers">>();
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
  private notices: Notice[] = [];
  private float: Snapshot["float"] = null;
  private confirm: PendingConfirm | null = null;
  private confirmId = 0;
  private readonly progress = new Map<string, RunningProgress>();
  private noticeId = 0;
  private snap: Snapshot = { plugins: [], packages: [], prompts: [], notices: [], float: null, confirm: null, progress: [], declined: [], settled: false };
  private settled = false;
  private packages: PackageStatus[] = [];
  /** Packages `:plugins remove` took out this run while init.lua still names them: not asked
   * again until the next start. A cancelled install is kept in the State instead (`DECLINED_KEY`). */
  private readonly declined = new Set<string>();
  /** The settings each loaded Package got, so a changed init.lua reloads it. */
  private readonly packageConfig = new Map<string, string>();
  private starting: Promise<void> | null = null;
  /** Package work runs one at a time (a sync, an update, a clean). */
  private packageWork: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  /** Each Session's lines as its terminal commits them (committed.ts), for terminal.read. */
  private readonly screens = new Map<number, { host: string | null; lines: CommittedLines; done: Promise<void> }>();
  private outputTimer: ReturnType<typeof setTimeout> | null = null;
  /** The flush running, if any: the next waits for it (a Session's events stay in order). */
  private flushing: Promise<void> = Promise.resolve();
  /** The last list of open Sessions sent to the core, once it's there. */
  private sessionsSent: Promise<unknown> = Promise.resolve();
  private started = false;
  /** Every built-in command id seen so far (issue #184): it only grows, so a built-in an effect
   * takes out and puts back is never a Plugin's own in between. */
  private readonly builtinsSeen = new Set<string>();
  /** The list the core has taken, as sent (sorted, one per line): "" until a send succeeds. */
  private builtinsHeld = "";
  /** The last send: each waits for the one before, so the core gets them in order. */
  private builtinsSending: Promise<void> = Promise.resolve();
  /** Sends that failed in a row, and the retry waiting. */
  private builtinsFailed = 0;
  private builtinsRetry: ReturnType<typeof setTimeout> | null = null;
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

  constructor(
    private readonly backend: PluginBackend,
    private readonly registries: Registries,
    private readonly store: PluginStore,
    private readonly ui: PluginUi,
    private readonly now: () => number = Date.now,
  ) {}

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

  /** Whether the user cancelled this Package's install, this run or before, from the repo and
   * folder init.lua names now. */
  private isDeclined(p: { name: string; url: string; dir: string | null }): boolean {
    return this.declined.has(p.name) || this.cancelledInstalls().some((d) => d.name === p.name && d.url === p.url && d.dir === p.dir);
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
    // roster's own commands, before any Plugin runs and whenever one registers later (App's
    // effects register some after this): none is a Plugin's own to run (issue #184).
    this.stopBuiltins = this.registries.commands.subscribe(() => void this.sendBuiltins());
    await this.sendBuiltins();
    const list = this.installed();
    for (const path of BUILTIN_PLUGINS) {
      const name = path.slice("builtin:".length);
      const entry = list.find((e) => e.path === path);
      await this.loadPath(path, entry ? entry.granted : null, name);
    }
    // Packages load in syncPackages, once the core has their clones.
    for (const entry of list.filter((e) => !e.path.startsWith("builtin:") && packageName(e.path) === null)) {
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
   * commit, showing its diff and any permission it newly asks for. Says what it found. */
  checkPackages(only?: string): Promise<string> {
    return this.serially(async () => {
      await this.start();
      if (only !== undefined) {
        const p = this.packages.find((x) => x.name === only);
        if (!p) return `init.lua names no Package ${only}`;
        if (!p.pinned) return `${only} isn't installed: :packages install ${only} asks to install it`;
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
      const p = this.packages.find((x) => x.name === name);
      if (!p) return `init.lua names no Package ${name}`;
      const path = `${PACKAGE_PREFIX}${name}`;
      if (p.pinned && this.installed().some((e) => e.path === path)) return `${name} is installed already: :packages update ${name} checks it for a new version`;
      this.declined.delete(name);
      this.saveCancelled(this.cancelledInstalls().filter((d) => d.name !== name));
      await this.syncPackagesNow();
      if (this.prompts.some((x) => x.path === path)) return null;
      const now = this.packages.find((x) => x.name === name);
      return now?.error ? `${name}: ${now.error}` : `${name} can't be installed: see :packages`;
    });
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
      return `Wrote ${file}: the Plugin API ${pluginApi.api_version}'s types, for lua-language-server`;
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
      this.declined.add(pkg);
      this.packages = this.packages.map((p) => (p.name === pkg ? { ...p, commit: null, locked: null, pinned: false } : p));
    }
    await this.forget(name);
    // Its data folder goes with it (decision Q93): a Plugin installed again starts empty.
    await this.backend.pluginForget(name).catch(() => false);
    this.saveInstalled(this.installed().filter((e) => e.name !== name));
    this.changed();
    const stillNamed = pkg !== null && this.packages.some((p) => p.name === pkg);
    return stillNamed ? `Removed ${name}. init.lua still names it: take it out, or it asks again at the next start` : null;
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
    const reply = await this.backend.pluginCall(plugin, handler, args, user).catch((e: unknown) => this.lost(plugin, e));
    this.apply(reply);
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
    this.apply(reply);
  }

  /** Tells the Plugins that listen. A Session that ended sends what it had first. */
  async event(name: PluginEventName, payload: Record<string, unknown> = {}): Promise<void> {
    if (this.stopped) return;
    if (name === "session_exit" && typeof payload.session === "number") {
      const session = payload.session;
      const flushed = this.flushing.then(() => this.flushSession(session));
      this.flushing = flushed.catch(() => {});
      await flushed.catch(() => {});
      this.sessionGone(session);
    }
    return this.send(name, payload);
  }

  /** The Sessions open now, in the order they opened: the whole list, which replaces the core's
   * (`roster.sessions.list()`, ticket 96). Sent even while no Plugin runs, so one loaded later
   * knows them; a Session event sent after it waits for it, so a listener's list agrees. */
  sessions(open: OpenSession[]): void {
    if (this.stopped) return;
    this.sessionsSent = this.sessionsSent.then(() => this.backend.pluginSessions(open)).catch(() => {});
  }

  private async send(name: PluginEventName, payload: Record<string, unknown>): Promise<void> {
    if (name === "session_open" || name === "session_exit") await this.sessionsSent;
    if (this.loaded.size === 0) return;
    const replies = await this.backend.pluginEvent(name, payload).catch(() => []);
    for (const r of replies) {
      this.used(r.plugin, `heard ${name}`);
      this.apply(r);
    }
  }

  /** Whether any running Plugin may read the Sessions' output (so it's worth decoding). */
  readsTerminal(): boolean {
    return [...this.loaded.values()].some((l) => l.granted.includes("terminal.read"));
  }

  /** A Session's output (tabs' tap), with the size of its terminal: it goes through a terminal
   * of its own, and the lines it commits go as `terminal_output` to the Plugins granted
   * terminal.read, batched (ticket 79: from the terminal's buffer, not the raw stream). */
  output(session: number, host: string | null, data: Uint8Array, size: ScreenSize) {
    if (!this.readsTerminal()) {
      for (const id of [...this.screens.keys()]) this.sessionGone(id);
      return;
    }
    let s = this.screens.get(session);
    if (!s) {
      s = { host, lines: new CommittedLines(size), done: Promise.resolve() };
      this.screens.set(session, s);
    }
    s.host = host;
    // In order: a resize lands between the output before it and after it.
    const { lines } = s;
    s.done = s.done.then(() => {
      lines.resize(size);
      return lines.write(data);
    });
    if (!this.stopped) this.outputTimer ??= setTimeout(() => void this.flushOutput(), OUTPUT_EVERY_MS);
  }

  /** Sends the lines committed so far (tests call it rather than wait). Flushes run one after
   * another, so a Session's events never interleave. */
  flushOutput(): Promise<void> {
    if (this.outputTimer) clearTimeout(this.outputTimer);
    this.outputTimer = null;
    const run = this.flushing.then(() => Promise.all([...this.screens.keys()].map((id) => this.flushSession(id)))).then(() => {});
    this.flushing = run.catch(() => {});
    return run;
  }

  /** Sends what Session `session` committed: each run of lines of one kind as a
   * `terminal_output`, then the commands that ended in it (ticket 94: a marked shell's). */
  private async flushSession(session: number): Promise<void> {
    const s = this.screens.get(session);
    if (!s) return;
    await s.done;
    const runs = s.lines.takeRuns();
    const done = s.lines.takeDone();
    // Too much at once: the last whole lines that fit, in all the runs together.
    let room = OUTPUT_MAX;
    const kept: OutputRun[] = [];
    for (let i = runs.length - 1; i >= 0 && room > 0; i--) {
      const r = runs[i] as OutputRun;
      const text = lastLines(r.text, room);
      if (text) kept.unshift({ text, kind: r.kind });
      room -= r.text.length;
    }
    for (const r of kept) await this.send("terminal_output", { session, host: s.host, text: r.text, kind: r.kind });
    for (const d of done) await this.send("command_done", { session, host: s.host, ...d });
  }

  /** A Session that ended takes its terminal with it. */
  sessionGone(session: number) {
    this.screens.get(session)?.lines.dispose();
    this.screens.delete(session);
  }

  /** A notice's button (ticket 91): the user's click runs its command line, as `roster.cmd` would
   * (so `view ID` may open the Plugin's view), and the notice goes. */
  noticeAction(id: number, index: number) {
    const n = this.notices.find((x) => x.id === id);
    const a = n?.actions?.[index];
    if (!n || !a) return;
    this.dismissNotice(id);
    this.runLine(n.plugin, a.command);
  }

  dismissNotice(id: number) {
    this.notices = this.notices.filter((n) => n.id !== id);
    this.changed();
  }

  closeFloat() {
    if (!this.float) return;
    this.float = null;
    this.changed();
  }

  /** Loads built-in Plugin `name` again if its settings changed (init.lua's Folders did). */
  async reloadBuiltin(name: string): Promise<void> {
    if (!this.started || !this.loaded.has(name)) return;
    const path = `builtin:${name}`;
    const settings = (await this.ui.builtinSettings?.(name).catch(() => null)) ?? null;
    if (this.builtinConfig.get(name) === JSON.stringify(settings)) return;
    const entry = this.installed().find((e) => e.path === path);
    await this.loadPath(path, entry ? entry.granted : null, name);
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
    if (this.builtinsRetry) clearTimeout(this.builtinsRetry);
    this.builtinsRetry = null;
    for (const [name, l] of [...this.loaded]) {
      for (const d of l.disposers.values()) d();
      this.loaded.delete(name);
      this.forgetUi(name);
    }
    if (this.outputTimer) clearTimeout(this.outputTimer);
    this.outputTimer = null;
    for (const s of this.screens.values()) s.lines.dispose();
    this.screens.clear();
    this.changed();
  }

  /** Every loaded or known Plugin's name (`:plugins remove` completes them). */
  names(): string[] {
    return this.snap.plugins.map((p) => p.name);
  }

  /** Tells the core every built-in command seen, unless it has that list already. A send that
   * fails is said once (quietly), retried after 1 s, 2 s, … up to 30 s apart, and tried again before
   * each Plugin loads; until one gets through the core refuses every Plugin's own command line too
   * (runtime.rs), and the app checks every line itself. */
  private sendBuiltins(): Promise<void> {
    for (const c of this.registries.commands.list()) if (c.source === BUILTIN) this.builtinsSeen.add(c.id);
    this.builtinsSending = this.builtinsSending.then(() => this.sendBuiltinsNow());
    return this.builtinsSending;
  }

  private async sendBuiltinsNow(): Promise<void> {
    const names = [...this.builtinsSeen].sort();
    const list = names.join("\n");
    if (this.stopped || list === this.builtinsHeld) return;
    try {
      await this.backend.pluginBuiltins(names);
      this.builtinsHeld = list;
      this.builtinsFailed = 0;
      if (this.builtinsRetry) clearTimeout(this.builtinsRetry);
      this.builtinsRetry = null;
    } catch {
      if (this.builtinsFailed++ === 0) this.ui.say?.(quiet("Plugins: couldn't tell roster its own commands; trying again"));
      if (this.builtinsRetry || this.stopped) return;
      const wait = Math.min(1000 * 2 ** (this.builtinsFailed - 1), 30_000);
      this.builtinsRetry = setTimeout(() => {
        this.builtinsRetry = null;
        void this.sendBuiltins();
      }, wait);
    }
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
    // The core has the built-ins before this Plugin runs, or is asked again (issue #184).
    await this.sendBuiltins();
    let result;
    try {
      // A built-in Plugin is granted everything it asks for until a permission is revoked.
      const builtin = path.startsWith("builtin:") ? path.slice("builtin:".length) : null;
      const settings = builtin === null ? null : ((await this.ui.builtinSettings?.(builtin).catch(() => null)) ?? null);
      if (builtin !== null) this.builtinConfig.set(builtin, JSON.stringify(settings));
      // The list of open Sessions sent last is in the core first: the Plugin may read it at load.
      await this.sessionsSent;
      result = await this.backend.pluginLoad(path, granted ?? ["inventory.read", "inventory.write", "sessions.open", "terminal.read", "terminal.write"], settings);
    } catch (e) {
      await this.unload(name);
      this.problems.set(name, e instanceof Error ? e.message : String(e));
      this.notify(name, "error", `${name}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const { manifest, reply } = result;
    // Stopped while it loaded: the core's copy goes too, and nothing of it is shown.
    if (this.stopped) return void (await this.backend.pluginUnload(manifest.name).catch(() => false));
    await this.unload(manifest.name, false);
    const asked = manifest.permissions.map((p) => p.name);
    const info = { manifest, path, granted: granted === null ? asked : granted.filter((g) => asked.includes(g)) };
    this.known.set(manifest.name, info);
    this.loaded.set(manifest.name, { ...info, disposers: new Map() });
    this.problems.delete(manifest.name);
    this.apply(reply);
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
   * the failure is said instead (decision Q87). */
  private apply(reply: PluginReply) {
    const name = reply.plugin;
    const l = this.loaded.get(name);
    if (l) {
      let copying: Promise<boolean> | null = null;
      for (const raw of reply.ops) {
        const op = parseOp(raw);
        if ("invalid" in op) this.notify(name, "warn", `${name}: ${op.invalid}`);
        else if (op.op === "copy") {
          const before: Promise<boolean> = copying ?? Promise.resolve(true);
          const done = this.ui.copy(op.text).then(
            () => true,
            (e: unknown) => {
              this.notify(name, "error", `${name}: couldn't copy to the clipboard: ${e instanceof Error ? e.message : String(e)}`);
              return false;
            },
          );
          copying = Promise.all([before, done]).then(([a, b]) => a && b);
        } else if (op.op === "notify" && copying) {
          void copying.then((ok) => ok && this.notify(name, op.level, `${name}: ${op.text}`, op.actions, op.quiet));
        } else this.applyOp(l, name, op);
      }
    }
    if (reply.error) this.notify(name, "error", describeError(reply.error) + (reply.disabled ? ". It's disabled." : ""));
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
    if (this.float?.plugin === name) this.float = null;
    if (this.confirm?.plugin === name) this.confirm = null;
    for (const [id, p] of this.progress) if (p.plugin === name) this.progress.delete(id);
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
    const c = this.confirm;
    if (!c) return;
    this.confirm = null;
    this.changed();
    if (yes) this.runFor(c.plugin, c.run, { confirm: "yes" });
    else if (c.cancel) this.runFor(c.plugin, c.cancel, { confirm: "no" });
  }

  /** `:cancel [ID]`: stops a progress through its Plugin's `cancel`. Says what happened. */
  cancelProgress(id?: string): Message {
    const list = [...this.progress.values()];
    const p = id ? this.progress.get(id) : list.filter((x) => x.cancel && !x.stopping).at(-1);
    if (!p) return id ? `Nothing called ${id} is running: :cancel lists none` : "Nothing running can be cancelled";
    if (!p.cancel) return `${p.title} can't be stopped`;
    if (p.stopping) return `${p.title}: stopping already`;
    this.progress.set(p.id, { ...p, stopping: true });
    this.changed();
    this.runFor(p.plugin, p.cancel, { progress: p.id });
    // Quiet (ticket 117): the progress itself shows it's stopping.
    return quiet(`Stopping ${p.title}`);
  }

  /** The ids `:cancel` completes: what can be stopped now. */
  cancellable(): string[] {
    return [...this.progress.values()].filter((p) => p.cancel && !p.stopping).map((p) => p.id);
  }

  /** A float's button, by its place (ticket 78). */
  floatAction(index: number) {
    const f = this.float;
    const a = f?.actions[index];
    if (f && a) this.runFor(f.plugin, a.run, { action: index + 1 });
  }

  /** A float's link: the address was checked when it came (http or https). */
  openLink(index: number) {
    const link = this.float?.links[index];
    if (link) this.ui.openUrl?.(link.url);
  }

  private put(l: Loaded, key: string, dispose: () => void) {
    l.disposers.get(key)?.();
    l.disposers.set(key, dispose);
  }

  private drop(l: Loaded, key: string) {
    l.disposers.get(key)?.();
    l.disposers.delete(key);
  }

  /** An id taken by another source (a built-in, init.lua, another Plugin) stays theirs. */
  private taken(registry: { get(id: string): { source: string } | undefined }, id: string, plugin: string) {
    const e = registry.get(id);
    return e !== undefined && e.source !== plugin;
  }

  private applyOp(l: Loaded, plugin: string, op: PluginOp) {
    const r = this.registries;
    const refuse = (what: string) => this.notify(plugin, "warn", `${plugin}: ${what}`);
    switch (op.op) {
      case "command": {
        if (op.name === "plugins" || this.taken(r.commands, op.name, plugin)) return refuse(`:${op.name} is taken (${r.commands.get(op.name)?.source ?? "roster"})`);
        const run = op.run;
        const def: CommandDef = {
          id: op.name,
          source: plugin,
          area: plugin,
          arg: "text",
          optionalArg: true,
          label: (a) => (a ? `${op.desc || op.name} ${a}` : op.desc || op.name),
          run: (ctx, arg) => {
            const args = (arg ?? "").trim();
            const running = `${plugin} ${op.name}`;
            this.runningCommands.add(running);
            try {
              // Run by the Plugin's own `roster.cmd`, it's the user's call carried, or the app's.
              const by = this.lineCaller?.plugin === plugin ? this.lineCaller.by : true;
              this.runFor(plugin, run, { args, words: args ? args.split(/\s+/) : [], ...this.cursor(plugin, ctx) } as unknown as HandlerContext, by);
            } finally {
              this.runningCommands.delete(running);
            }
          },
          ...(op.complete ? { complete: this.completer(plugin, op.name, op.complete.handler) } : {}),
        };
        return this.put(l, `command:${op.name}`, r.commands.register(def));
      }
      case "key": {
        const context = KEY_CONTEXTS[op.context];
        if (!context) return refuse(`keys go after the Leader or in the Sidebar (leader, list, list_vim), not ${op.context}`);
        const id = bindingId(context, op.keys);
        if (op.action !== false && this.taken(r.keymap, id, plugin)) {
          const by = r.keymap.get(id);
          const shown = op.context === "leader" ? `␣ ${op.keys}` : `${op.keys} (${op.context})`;
          const free = freeKeys(r.keymap.list(), context, op.keys, plugin);
          const where = op.context === "leader" ? "after the Leader" : `in ${op.context}`;
          return refuse(
            `${shown} is taken (by ${by?.source ?? "roster"}${by?.action ? `: ${by.action}` : ""}).` +
              (free.length ? ` Free ${where}: ${free.join(", ")}.` : "") +
              " Choose another (:keys lists them all)",
          );
        }
        // Nor may it start with a bound key, or be the start of one: either would hide the other.
        const clash = r.keymap
          .list()
          .find((b) => b.context === context && b.source !== plugin && b.action !== null && (op.keys.startsWith(`${b.keys} `) || b.keys.startsWith(`${op.keys} `)));
        if (clash) return refuse(`${op.keys} (${op.context}) would hide ${clash.keys}, bound by ${clash.source}`);
        // `false` (keymap.del, api 3) takes the Plugin's own binding off; it never claims keys.
        if (op.action === false) return this.drop(l, `key:${id}`);
        // Its line goes through `plugins run`, as a button's does (ticket 88, Q98): `:keys` shows that.
        const action = this.line(plugin, { command: op.action });
        return this.put(l, `key:${id}`, r.keymap.register({ id, source: plugin, context, keys: op.keys, action }));
      }
      case "theme": {
        if (this.taken(r.themes, op.id, plugin)) return refuse(`there's a Theme named ${op.id} already`);
        const baseId = op.theme.base ?? (op.theme.appearance === "light" ? "roster-light" : "roster-dark");
        const base = r.themes.get(baseId) ?? r.themes.get("roster-dark");
        if (!base) return;
        return this.put(l, `theme:${op.id}`, r.themes.register(themeOf(op.id, op.theme, base, plugin)));
      }
      case "section": {
        if (this.taken(r.sidebar, op.id, plugin)) return refuse(`there's a Sidebar section named ${op.id} already`);
        const actions = op.actions.map((a, i) => this.rowAction(plugin, a, { section: op.id, action: i + 1 }));
        const drop = op.drop;
        const build = ({ hostByName }: { hostByName: ReadonlyMap<string, Host> }) => {
          const rows = op.rows.map((row) => this.row(plugin, op.id, row, hostByName));
          return {
            id: op.id,
            title: op.title,
            count: op.count ?? rows.length,
            rows,
            ...(op.empty ? { empty: op.empty } : {}),
            ...(actions.length ? { actions } : {}),
            ...(drop ? { drop: (host: string) => this.line(plugin, drop, { section: op.id, dropped: host }) } : {}),
          };
        };
        return this.put(l, `section:${op.id}`, r.sidebar.register({ id: op.id, source: plugin, order: op.order, build }));
      }
      case "status": {
        if (this.taken(r.status, op.id, plugin)) return refuse(`there's a status segment named ${op.id} already`);
        return this.put(
          l,
          `status:${op.id}`,
          r.status.register({
            id: op.id,
            source: plugin,
            text: op.text,
            ...(op.title ? { title: op.title } : {}),
            ...(op.run ? { command: this.line(plugin, op.run, { segment: op.id }) } : {}),
          }),
        );
      }
      case "finder": {
        if (this.taken(r.finders, op.id, plugin)) return refuse(`there's a finder named ${op.id} already`);
        const key = `finder:${op.id}`;
        const item = (i: PluginFinderItem): FinderItem => ({
          id: i.id,
          label: i.label,
          ...(i.detail ? { detail: i.detail } : {}),
          ...(i.path ? { path: i.path } : {}),
          command: this.line(plugin, i.run, { finder: op.id, item: i.id }),
        });
        const register = (items: FinderItem[] | null, open?: () => void) => {
          const def: FinderSourceDef = {
            id: op.id,
            source: plugin,
            title: op.title,
            prompt: op.prompt,
            items: () => items ?? [],
            ...(items === null ? { empty: "Loading…" } : {}),
            ...(open ? { open } : {}),
          };
          const dispose = r.finders.register(def);
          this.put(l, key, dispose);
          return dispose;
        };
        if ("section" in op.items) {
          // One of its own sections' rows (api 3), as roster's own `inventory` finder lists its.
          const own = op.items.section;
          const finder = sectionFinder(own, op.title, op.prompt, plugin);
          const def: FinderSourceDef = { ...finder, items: (ctx) => (r.sidebar.get(own)?.source === plugin ? finder.items(ctx) : []) };
          return this.put(l, key, r.finders.register(def));
        }
        if (!("handler" in op.items)) return void register(op.items.map(item));
        // Its items come from a function: run each time the finder opens (ticket 79).
        const handler = op.items.handler;
        let current: () => void;
        const open = () => {
          const mine = current;
          void this.call(plugin, handler, {}, `listed ${op.id}`, false).then((result) => {
            // Replaced (or gone) meanwhile: what came back is for a finder that isn't there.
            if (l.disposers.get(key) !== mine || this.loaded.get(plugin) !== l) return;
            const items = parseFinderItems(result ?? [], `roster.finders.set ${op.id}`);
            if ("invalid" in items) this.notify(plugin, "warn", `${plugin}: ${items.invalid}`);
            current = register("invalid" in items ? [] : items.map(item), open);
          });
        };
        current = register(null, open);
        return;
      }
      case "timer": {
        // The clock is here; the function runs in the Plugin. A repeating one waits again once
        // a run has answered, so a slow run never piles up behind itself.
        const key = `timer:${op.id}`;
        let handle: ReturnType<typeof setTimeout> | null = null;
        let live = true;
        const fire = async () => {
          handle = null;
          // A deferred one is gone in the core as it runs.
          if (!op.every) l.disposers.delete(key);
          await this.call(plugin, op.run.handler, {}, null, false);
          if (live && op.every && this.loaded.get(plugin) === l) handle = setTimeout(() => void fire(), op.ms);
        };
        handle = setTimeout(() => void fire(), op.ms);
        return this.put(l, key, () => {
          live = false;
          if (handle) clearTimeout(handle);
        });
      }
      case "help": {
        if (this.taken(r.help, op.id, plugin)) return refuse(`there's a help page named ${op.id} already`);
        const blocks = parseMarkdown(op.markdown);
        return this.put(
          l,
          `help:${op.id}`,
          r.help.register({ id: op.id, source: plugin, title: op.title, summary: op.summary, order: 1000, body: () => blocks }),
        );
      }
      case "tutor": {
        const page = tutorPage(op.id);
        if (op.id === DEFAULT_TUTORIAL || this.taken(r.tutorials, op.id, plugin)) return refuse(`there's a tutorial named ${op.id} already`);
        if (this.taken(r.help, page, plugin)) return refuse(`there's a help page named ${page} already`);
        return this.put(l, `tutor:${op.id}`, r.tutorials.register(pluginTutorial(plugin, op)));
      }
      case "health": {
        if (this.taken(r.health, op.id, plugin)) return refuse(`there's a :check section named ${op.id} already`);
        const checks = op.checks.map((c) => ({ section: op.id, ...c }));
        const check = op.check;
        // With `check` (api 3, like vim.health), each `:check` calls the Plugin for its lines.
        const run =
          check === undefined
            ? () => checks
            : "command" in check
              ? () => [{ section: op.id, level: "error" as const, message: "check must be a function" }]
              : async () => this.healthCheck(plugin, op.id, check.handler);
        // A check may answer later, from a request's answer: :check waits for it that long.
        const wait = check === undefined ? undefined : HEALTH_LATER_MS + SECTION_WAIT_MS;
        return this.put(l, `health:${op.id}`, r.health.register({ id: op.id, source: plugin, title: op.title, order: 500, checks: run, ...(wait ? { wait } : {}) }));
      }
      case "health_answer": {
        // Only the Plugin whose run it is can answer it; one for a run that's over is dropped.
        this.laterChecks.get(`${plugin}:${op.check}`)?.(op.checks);
        return;
      }
      case "badge": {
        const id = `${plugin}:${op.host}`;
        if (op.text === null) return this.drop(l, `badge:${id}`);
        return this.put(l, `badge:${id}`, r.badges.register({ id, source: plugin, host: op.host, text: op.text }));
      }
      case "float":
        this.float = op.spec ? { ...op.spec, plugin } : this.float?.plugin === plugin ? null : this.float;
        return;
      case "notify":
        return this.notify(plugin, op.level, `${plugin}: ${op.text}`, op.actions, op.quiet);
      case "open":
        return this.ui.run(`connect ${op.host}`);
      case "send":
        return this.ui.send(op.session, op.text);
      case "copy":
        return void this.ui.copy(op.text).catch(() => undefined);
      case "confirm": {
        // One question at a time: a newer one replaces it (another Plugin's hears its cancel).
        const before = this.confirm;
        this.confirm = { ...op.confirm, plugin, id: ++this.confirmId };
        // The app's doing, not the user's answer: never the user's call for that Plugin.
        if (before && before.plugin !== plugin && before.cancel) this.runFor(before.plugin, before.cancel, { confirm: "no" }, false);
        return;
      }
      case "progress": {
        const other = this.progress.get(op.id);
        if (other && other.plugin !== plugin) return refuse(`there's a progress named ${op.id} already, from ${other.plugin}`);
        // Setting it again after a cancel says it's still stopping until the Plugin says otherwise.
        this.progress.set(op.id, { ...op.progress, plugin, id: op.id, stopping: false });
        return;
      }
      case "toolbar": {
        if (this.taken(r.toolbar, op.id, plugin)) return refuse(`there's a toolbar control named ${op.id} already`);
        const c = op.control;
        return this.put(
          l,
          `toolbar:${op.id}`,
          r.toolbar.register({
            id: op.id,
            source: plugin,
            label: () => c.label,
            ...(c.icon ? { icon: c.icon } : {}),
            ...(c.text || !c.icon ? { text: c.text ?? c.label } : {}),
            command: this.line(plugin, c.run, { toolbar: op.id }),
            side: "end",
            byDefault: true,
          }),
        );
      }
      case "cmd": {
        // One hop (issue #183): made in the user's own call, the Plugin's own command it names is
        // that call carried; made in a carried run (`user: false`), it's the app's call.
        const outer = this.lineCaller;
        this.lineCaller = { plugin, by: op.user === false ? false : "carried" };
        try {
          return this.runLine(plugin, op.line);
        } finally {
          this.lineCaller = outer;
        }
      }
      case "echo":
        return this.ui.say ? this.ui.say(op.quiet ? quiet(op.text) : op.text) : this.notify(plugin, "info", `${plugin}: ${op.text}`);
      case "cmdline": {
        // Its own commands only (the core checks too): never a line for roster's or another's.
        const word = op.text.trim().split(/\s+/)[0] ?? "";
        if (r.commands.get(word)?.source !== plugin) return refuse(`roster.cmdline: ${word} isn't one of its commands`);
        return this.ui.openCommandLine?.(op.text);
      }
      case "session_show":
        if (this.ui.showSession && !this.ui.showSession(op.session, op.line)) return refuse(`there's no Session ${op.session} now: it has ended`);
        return;
      case "view": {
        if (this.taken(r.views, op.id, plugin)) return refuse(`there's a view named ${op.id} already`);
        (l.views ??= new Map()).set(op.id, op.view);
        return this.putView(l, plugin, op.id, op.view);
      }
      case "view_update": {
        const view = l.views?.get(op.id);
        if (!view) return refuse(`roster.views.update: there's no view ${op.id} (roster.views.set it first)`);
        const u = op.update;
        // `remove` is a graph's nodes and clusters in a graph, else a table's rows.
        const tableChange = u.rows.length > 0 || u.clear === true || (u.remove.length > 0 && !view.graph) || u.columns !== undefined || u.sort !== undefined || u.actions !== undefined;
        if (tableChange && !view.table) return refuse(`roster.views.update ${op.id}: the view has no table to change`);
        if (u.graph && !view.graph) return refuse(`roster.views.update ${op.id}: the view has no graph for nodes and edges`);
        let graph = view.graph;
        if (graph && (u.graph || u.remove.length)) {
          const g = u.graph ?? { nodes: [], edges: [], clusters: [], removeEdges: [] };
          const data = mergeGraph(graph.data, { ...g, remove: u.remove });
          const over = graphOver(data);
          if (over) return refuse(`roster.views.update ${op.id}: more than ${over}`);
          graph = { ...graph, data, ...(g.filter ? { filter: g.filter } : {}) };
        }
        let table = view.table;
        if (table && (u.rows.length || u.remove.length || u.clear)) {
          const rows = mergeRows(u.clear ? [] : table.rows, u.rows, u.remove);
          if (rows.length > MAX_TABLE_ROWS) return refuse(`roster.views.update ${op.id}: more than ${MAX_TABLE_ROWS.toLocaleString("en-US")} rows`);
          table = { ...table, rows };
        }
        if (table && (u.columns || u.sort || u.actions)) {
          const columns = u.columns ?? table.columns;
          const sort = u.sort ?? (table.sort && columns.some((c) => c.id === table?.sort?.by) ? table.sort : null);
          if (sort && !columns.some((c) => c.id === sort.by)) return refuse(`roster.views.update ${op.id}: sort names no column (${sort.by})`);
          table = { ...table, columns, sort, ...(u.actions ? { actions: u.actions } : {}) };
        }
        const next: PluginView = {
          ...view,
          ...(u.title !== undefined ? { title: u.title } : {}),
          ...(u.facts !== undefined ? { facts: u.facts } : {}),
          ...(table ? { table } : {}),
          ...(graph ? { graph } : {}),
        };
        if (u.text === "") delete next.text;
        else if (u.text !== undefined) next.text = u.text;
        l.views?.set(op.id, next);
        return this.putView(l, plugin, op.id, next);
      }
      case "view_open":
      case "view_close": {
        if (r.views.get(op.id)?.source !== plugin) return refuse(`${op.op === "view_open" ? "roster.views.open" : "roster.views.close"}: there's no view ${op.id} of yours`);
        if (op.op === "view_close") return this.ui.closeView?.(op.id);
        if (op.select !== undefined && this.ui.openView) return this.ui.openView(op.id, op.select);
        return this.ui.run(`view ${op.id}`);
      }
      case "details": {
        const id = detailsId(op.id, op.host);
        const other = r.details.list().find((e) => e.section === op.id && e.source !== plugin);
        if (other) return refuse(`there's a Host-details section named ${op.id} already, from ${other.source}`);
        if (op.section === null) return this.drop(l, `details:${id}`);
        const content = this.content(plugin, { section: op.id, host: op.host }, op.section);
        return this.put(
          l,
          `details:${id}`,
          r.details.register({ id, source: plugin, section: op.id, host: op.host, title: op.section.title, order: op.section.order, content }),
        );
      }
      case "remove":
        if (op.kind === "view") l.views?.delete(op.id);
        if (op.kind === "progress") {
          if (this.progress.get(op.id)?.plugin === plugin) this.progress.delete(op.id);
          return;
        }
        if (op.kind === "details") {
          for (const key of [...l.disposers.keys()].filter((k) => k.startsWith(`details:${op.id}@`))) this.drop(l, key);
          return;
        }
        return this.drop(l, `${op.kind}:${op.id}`);
    }
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
      const reply = await this.backend.pluginCall(plugin, handler, { health: id, check: run, ...this.onScreen(plugin) }, false).catch((e: unknown) => this.lost(plugin, e));
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

  private putView(l: Loaded, plugin: string, id: string, view: PluginView) {
    const content = this.content(plugin, { view: id }, view);
    if (view.graph) content.graph = this.graph(plugin, id, view.graph);
    this.put(l, `view:${id}`, this.registries.views.register({ id, source: plugin, title: view.title, place: view.place, content }));
  }

  /** A view's or section's content, with what its table's rows and actions run. A function gets
   * the row: `{ row, host, view | section }`. */
  private content(plugin: string, where: { view?: string; section?: string; host?: string }, c: PluginContent): Content {
    const go = (run: Run) => (row: TableRow) => {
      const host = row.host ?? where.host;
      this.runFor(plugin, run, { row: row.id, ...(host ? { host } : {}), ...(where.view ? { view: where.view } : {}), ...(where.section ? { section: where.section } : {}) });
    };
    const t = c.table;
    // Without its own `open`, a row with a Host opens that Host, as a Sidebar row does.
    const openHost = (row: TableRow) => {
      if (row.host) this.ui.run(`open ${row.host}`);
    };
    // A heading's button gets the view or section (and its Host): `{ view }`, `{ section, host }`.
    const head = c.actions.map((a) => ({ label: a.label, icon: a.icon, ...(a.key ? { key: a.key } : {}), run: () => this.runFor(plugin, a.run, { ...where }) }));
    return {
      ...(head.length ? { actions: head } : {}),
      ...(c.text ? { text: c.text } : {}),
      facts: c.facts,
      ...(t
        ? {
            table: {
              columns: t.columns,
              rows: t.rows,
              sort: t.sort,
              ...(t.empty ? { empty: t.empty } : {}),
              ...(t.open ? { open: go(t.open) } : t.rows.some((row) => row.host) ? { open: openHost } : {}),
              actions: t.actions.map((a) => ({
                label: a.label,
                ...(a.key ? { key: a.key } : {}),
                ...(a.icon ? { icon: a.icon } : {}),
                ...(a.when ? { when: a.when } : {}),
                run: go(a.run),
              })),
            },
          }
        : {}),
    };
  }

  /** A view's graph, with what its `open` and actions run. A function gets the node:
   * `{ node, host, view }`. */
  private graph(plugin: string, view: string, g: PluginGraph): GraphModel {
    // As a table's: a function gets the node with the handler context (the Session on screen when
    // it may know); a command line goes through `:plugins run`.
    const go = (run: Run) => (node: GraphNode) => this.runFor(plugin, run, { node: node.id, ...(node.host ? { host: node.host } : {}), view });
    // Without its own `open`, a node with a Host opens that Host, as a table row does.
    const openHost = (node: GraphNode) => {
      if (node.host) this.ui.run(`open ${node.host}`);
    };
    return {
      data: g.data,
      ...(g.reach ? { reach: g.reach } : {}),
      ...(g.filter ? { filter: g.filter } : {}),
      ...(g.open ? { open: go(g.open) } : g.data.nodes.some((n) => n.host) ? { open: openHost } : {}),
      actions: g.actions.map((a) => ({ label: a.label, ...(a.key ? { key: a.key } : {}), ...(a.icon ? { icon: a.icon } : {}), ...(a.when ? { when: a.when } : {}), run: go(a.run) })),
    };
  }

  private row(plugin: string, section: string, row: PluginRow, hostByName: ReadonlyMap<string, Host>): SidebarRow {
    const id = `${section}:${row.id}`;
    const context = { section, row: row.id };
    const own = row.actions.map((a, i) => this.rowAction(plugin, a, { ...context, action: i + 1 }));
    const extra = {
      ...(row.drop ? { drop: (host: string) => this.line(plugin, row.drop as Run, { ...context, dropped: host }) } : {}),
      ...(row.dragOut ? { dragOut: this.line(plugin, row.dragOut, context) } : {}),
      ...(row.host ? { drag: row.host } : {}),
      ...(row.icon ? { icon: row.icon } : {}),
    };
    // Drawn as the Inventory draws the Host (api 3), with the row's own buttons after.
    const host = row.kind === "host" && row.host ? hostByName.get(row.host) : undefined;
    if (host) {
      const base = hostRow(host, id, row.level ?? 0);
      return { ...base, ...extra, ...(row.run ? { command: this.line(plugin, row.run, context) } : {}), actions: [...(base.actions ?? []), ...own] };
    }
    const dot = row.kind === "host" && row.host ? { dot: "off" as const } : {};
    return {
      ...dot,
      ...extra,
      ...(row.fold ? { foldable: true } : {}),
      id,
      label: row.label,
      ...(row.detail ? { detail: row.detail } : {}),
      ...(row.note ? { note: row.note } : {}),
      ...(row.host ? { host: row.host } : {}),
      ...(row.badge ? { badge: row.badge } : {}),
      ...(row.count !== undefined ? { count: row.count } : {}),
      ...(row.level !== undefined ? { level: row.level } : {}),
      ...(row.title ? { title: row.title } : {}),
      command: row.run ? this.line(plugin, row.run, context) : row.fold ? `togglefold ${id}` : row.host ? `open ${row.host}` : "",
      actions: own,
    };
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
  private completer(plugin: string, command: string, handler: number) {
    const key = `${plugin}\0${command}`;
    return (arg: string): string[] => {
      const last = this.completions.get(key);
      if (!last || last.arg !== arg) {
        void this.call(plugin, handler, arg, null, false).then((result) => {
          const list = Array.isArray(result) ? result.filter((x): x is string => typeof x === "string").slice(0, 200) : [];
          const before = this.completions.get(key);
          this.completions.set(key, { arg, list });
          if (JSON.stringify(before) !== JSON.stringify({ arg, list })) this.changed();
        });
        // Until it answers: the last list, kept to what still starts with what's typed.
        return (last?.list ?? []).filter((c) => c.toLowerCase().startsWith(arg.toLowerCase()));
      }
      return last.list;
    };
  }

  private rowAction(plugin: string, a: PluginRowAction, context: HandlerContext) {
    return { label: a.label, icon: a.icon, command: this.line(plugin, a.run, context) };
  }

  /** A notice; an info one is quiet (on the message line, heard but not seen) unless it has
   * buttons or the Plugin said `quiet = false`, while `ui.messages` is quiet (ticket 117).
   * Warnings and errors always show. `:messages` keeps it either way. Public for the app's own
   * notices about Plugins, as `:tutor`'s demo's (ticket 66). */
  notify(plugin: string, level: Notice["level"], text: string, actions: Notice["actions"] = [], asked?: boolean) {
    const routine = level === "info" && (asked ?? actions.length === 0);
    if (routine && this.ui.say && this.ui.messagesAll?.() === false) return this.ui.say(quiet(text));
    this.ui.log?.(text);
    const notice: Notice = { id: ++this.noticeId, plugin, level, text, ...(actions.length ? { actions } : {}) };
    this.notices = [...this.notices, notice].slice(-MAX_NOTICES);
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
    const builtin = (path: string) => path.startsWith("builtin:");
    const names = new Set([...this.known.keys(), ...this.problems.keys(), ...this.waiting.keys(), ...this.installed().map((e) => e.name)]);
    const installed = this.installed();
    const plugins = [...names].sort().map((name): PluginStatus => {
      const l = this.known.get(name);
      const entry = installed.find((e) => e.name === name);
      const path = l?.path ?? entry?.path ?? this.waiting.get(name)?.path ?? `builtin:${name}`;
      return {
        name,
        path,
        builtin: builtin(path),
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
      notices: this.notices,
      float: this.float,
      confirm: this.confirm,
      progress: [...this.progress.values()],
      declined: this.packages.filter((p) => !p.pinned && this.isDeclined(p)).map((p) => p.name),
      settled: this.settled,
    };
    for (const l of this.listeners) l();
  }
}

/** What a graph holds more of than it may, or null. */
function graphOver(g: { nodes: readonly unknown[]; edges: readonly unknown[]; clusters: readonly unknown[] }): string | null {
  if (g.nodes.length > MAX_NODES) return `${MAX_NODES.toLocaleString("en-US")} nodes`;
  if (g.edges.length > MAX_EDGES) return `${MAX_EDGES.toLocaleString("en-US")} edges`;
  if (g.clusters.length > MAX_CLUSTERS) return `${MAX_CLUSTERS.toLocaleString("en-US")} clusters`;
  return null;
}
