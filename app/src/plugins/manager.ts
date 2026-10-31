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
//   prompt, showing its git URL as the unverified source. Cancel removes the clone. `:packages
//   update` shows each new commit with its diff and any new permission before applying it, and
//   declining keeps the old version.
//
// `:plugins` (the command and panel), `:packages` and the prompts are drawn by PluginsPanel.tsx.
import type { Backend, PackageStatus, PackageUpdate, PluginErrorInfo, PluginEventName, PluginManifest, PluginReply } from "../backend/types";
import { themeOf } from "../config/apply";
import type { CommandDef } from "../commands/table";
import type { FinderItem } from "../finder/sources";
import { parseMarkdown } from "../help/markdown";
import { pluginTutorial } from "../tutor/plugin";
import { DEFAULT_TUTORIAL, tutorPage } from "../tutor/tutor";
import { bindingId, type KeymapContext } from "../keymap";
import type { Registries } from "../registries";
import type { SidebarRow } from "../sidebar/Sidebar";
import { parseOp, type PluginFloat, type PluginOp, type PluginRow, type Run } from "./ops";

/** What the manager asks of the app. */
export interface PluginUi {
  /** Runs a command line, as typing it after `:` does. */
  run(line: string): void;
  /** Types `text` into Session `id` (terminal.write). */
  send(id: number, text: string): void;
  /** Puts `text` on the clipboard (`roster.clipboard.copy`; the core allows it only in a call
   * the user started). Rejects when the clipboard can't be written. */
  copy(text: string): Promise<void>;
}

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

/** The built-in features written as Plugins: always installed, granted what they ask until revoked. */
export const BUILTIN_PLUGINS = ["builtin:hosts"] as const;

export const STATE_KEY = "plugins";

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
}

/** A question for the user: install this Plugin, or allow what its update newly asks for. */
export interface Prompt {
  kind: "install" | "update";
  path: string;
  manifest: PluginManifest;
  /** The permissions being asked about (all of them at install; the new ones on update). */
  asking: readonly string[];
  /** A Package's prompt: its git URL (the unverified source), and for an update the new commit
   * with its diff. Declining a Package's update keeps the version it has. */
  package?: { name: string; url: string; commit: string | null; update?: PackageUpdate };
}

/** A Plugin's message for the toast: its error, or what it asked to say. */
export interface Notice {
  id: number;
  plugin: string;
  level: "info" | "warn" | "error";
  text: string;
}

export interface Snapshot {
  plugins: readonly PluginStatus[];
  /** The Packages init.lua names, as the core last described them (`:packages`). */
  packages: readonly PackageStatus[];
  prompts: readonly Prompt[];
  notices: readonly Notice[];
  float: (PluginFloat & { plugin: string }) | null;
}

/** What the State store gives the manager. */
export interface PluginStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

type PluginBackend = Pick<
  Backend,
  | "pluginManifest"
  | "pluginLoad"
  | "pluginCall"
  | "pluginEvent"
  | "pluginUnload"
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
const OUTPUT_MAX = 16 * 1024;

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

/** After the app resizes a Session, how long what it prints is checked for a repaint. */
const REPAINT_MS = 1000;
/** How many of a Session's last lines a repaint is checked against (more than a screenful). */
const RECENT_LINES = 500;

/** ESC sequences (colours, cursor moves, titles) out of terminal output, for Plugins to match on.
 * A move to a row (`ESC[r;cH`, `ESC[H`, `ESC[rd`) is a line break: ConPTY and full-screen
 * programs draw rows by position, and those rows mustn't run together into one line. */
export function plainText(s: string): string {
  return (
    s
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*[Hfd]/g, "\n")
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|\r/g, "")
  );
}

/** What a Session printed lately, as Plugins got it: the lines already sent, and the one not
 * finished yet, so a repaint of its screen can be told from new output. */
interface Seen {
  lines: string[];
  set: Map<string, number>;
  partial: string;
  /** Until when what it prints may be its screen again (a resize was just sent). */
  repaintUntil: number;
}

/** Takes `text` from Plugins' view when it's a repaint: each whole line already sent lately is
 * dropped (a new line goes through, and is remembered). Returns what's left to send. */
function unrepainted(seen: Seen, text: string, repaint: boolean): string {
  const parts = (seen.partial + text).split("\n");
  const rest = parts.pop() ?? "";
  const kept: string[] = [];
  // The first part finishes the line held back last time: only its new end is sent.
  let first = seen.partial !== "";
  const remember = (line: string) => {
    seen.lines.push(line);
    seen.set.set(line, (seen.set.get(line) ?? 0) + 1);
    while (seen.lines.length > RECENT_LINES) {
      const old = seen.lines.shift() as string;
      const n = (seen.set.get(old) ?? 1) - 1;
      if (n === 0) seen.set.delete(old);
      else seen.set.set(old, n);
    }
  };
  for (const part of parts) {
    const line = part.trim();
    const again = repaint && line !== "" && (seen.set.has(line) || line === seen.partial.trim());
    if (first) {
      first = false;
      kept.push(part.slice(seen.partial.length));
    } else if (!again) kept.push(part);
    if (line !== "" && !again) remember(line);
  }
  const partial = seen.partial;
  seen.partial = rest;
  // The line not finished yet: a repaint draws it again too (the prompt).
  if (repaint && rest.trim() !== "" && rest.trim() === partial.trim()) return kept.length ? `${kept.join("\n")}\n` : "";
  if (parts.length === 0) return rest.slice(partial.length);
  return [...kept, rest].join("\n");
}

interface Loaded {
  manifest: PluginManifest;
  path: string;
  granted: string[];
  disposers: Map<string, () => void>;
}

export class PluginManager {
  /** The Plugins running now. */
  private readonly loaded = new Map<string, Loaded>();
  /** Every Plugin loaded since the start, running or not: what `:plugins` lists. */
  private readonly known = new Map<string, Omit<Loaded, "disposers">>();
  private readonly problems = new Map<string, string>();
  private readonly waiting = new Map<string, Prompt>();
  private readonly uses = new Map<string, Use[]>();
  private prompts: Prompt[] = [];
  private notices: Notice[] = [];
  private float: Snapshot["float"] = null;
  private noticeId = 0;
  private snap: Snapshot = { plugins: [], packages: [], prompts: [], notices: [], float: null };
  private packages: PackageStatus[] = [];
  /** Packages whose install the user cancelled this run: not asked again until the next start. */
  private readonly declined = new Set<string>();
  /** The settings each loaded Package got, so a changed init.lua reloads it. */
  private readonly packageConfig = new Map<string, string>();
  private starting: Promise<void> | null = null;
  /** Package work runs one at a time (a sync, an update, a clean). */
  private packageWork: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private readonly pendingOutput = new Map<number, { host: string | null; text: string; decoder: TextDecoder; repaint: boolean }>();
  /** Each Session's recent output as Plugins got it, to tell a repaint from new lines. */
  private readonly seenOutput = new Map<number, Seen>();
  private outputTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

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

  /** Loads the built-in Plugins and every installed one. One that asks for a permission the user
   * hasn't been asked about waits for the update prompt. */
  start(): Promise<void> {
    this.starting ??= this.startNow();
    return this.starting;
  }

  private async startNow(): Promise<void> {
    if (this.started) return;
    this.started = true;
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
      await this.start();
      let statuses: PackageStatus[];
      try {
        statuses = await this.backend.packagesSync();
      } catch (e) {
        this.notify("packages", "error", `Packages: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      this.packages = statuses;
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
    });
  }

  private async syncPackage(p: PackageStatus) {
    const path = `${PACKAGE_PREFIX}${p.name}`;
    const entry = this.installed().find((e) => e.path === path);
    if (!p.pinned || !entry) {
      if (this.declined.has(p.name)) {
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
          { kind: "install", path, manifest, asking: manifest.permissions.map((x) => x.name), package: { name: p.name, url: p.url, commit: p.commit } },
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

  /** `:packages update`: fetches every Package and asks about each new commit, showing its diff
   * and any permission it newly asks for. Says what it found. */
  checkPackages(): Promise<string> {
    return this.serially(async () => {
      await this.start();
      let checked;
      try {
        checked = await this.backend.packagesCheck();
      } catch (e) {
        return `Couldn't check the Packages: ${e instanceof Error ? e.message : String(e)}`;
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
          { kind: "update", path, manifest: u.manifest, asking, package: { name: c.name, url: status?.url ?? "", commit: u.to, update: u } },
        ];
        updates.push(c.name);
      }
      this.changed();
      const found = updates.length === 0 ? "All Packages are up to date" : `${updates.length === 1 ? "An update" : `${updates.length} updates`}: ${updates.join(", ")}`;
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
      for (const entry of this.installed().filter((e) => paths.has(e.path))) await this.forget(entry.name);
      this.saveInstalled(this.installed().filter((e) => !paths.has(e.path)));
      this.changed();
      return gone.length === 0 ? "Nothing to clean: init.lua names every Package" : `Removed ${gone.join(", ")}`;
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
        this.declined.add(pkg.name);
        await this.backend.packagesDiscard(pkg.name).catch(() => undefined);
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

  /** Runs what a Plugin's row, action, finder item or command handed over. */
  async call(plugin: string, handler: number, args: unknown = {}): Promise<unknown> {
    if (!this.loaded.has(plugin)) return undefined;
    this.used(plugin, "ran an action");
    const reply = await this.backend.pluginCall(plugin, handler, args).catch((e: unknown) => this.lost(plugin, e));
    this.apply(reply);
    return reply.result;
  }

  /** Tells the Plugins that listen. */
  async event(name: PluginEventName, payload: Record<string, unknown> = {}): Promise<void> {
    if (name === "session_exit" && typeof payload.session === "number") this.sessionGone(payload.session);
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

  /** A Session's output (tabs' tap): batched, decoded and stripped of escape sequences, then
   * sent as `terminal_output` to the Plugins granted terminal.read. */
  output(session: number, host: string | null, data: Uint8Array) {
    if (!this.readsTerminal()) return;
    let p = this.pendingOutput.get(session);
    if (!p) {
      p = { host, text: "", decoder: new TextDecoder(), repaint: false };
      this.pendingOutput.set(session, p);
    }
    if (this.now() < (this.seenOutput.get(session)?.repaintUntil ?? 0)) p.repaint = true;
    p.text = (p.text + p.decoder.decode(data, { stream: true })).slice(-OUTPUT_MAX);
    this.outputTimer ??= setTimeout(() => this.flushOutput(), OUTPUT_EVERY_MS);
  }

  /** Sends what's waiting now (tests call it rather than wait). */
  flushOutput() {
    if (this.outputTimer) clearTimeout(this.outputTimer);
    this.outputTimer = null;
    for (const [session, p] of this.pendingOutput) {
      let seen = this.seenOutput.get(session);
      if (!seen) {
        seen = { lines: [], set: new Map(), partial: "", repaintUntil: 0 };
        this.seenOutput.set(session, seen);
      }
      const text = unrepainted(seen, plainText(p.text), p.repaint);
      p.text = "";
      p.repaint = false;
      if (text) void this.event("terminal_output", { session, host: p.host, text });
    }
  }

  /** The app just resized `session`'s terminal: what it prints for a moment may be its screen
   * again (ConPTY repaints it on Windows; full-screen programs redraw), which isn't new output
   * (ticket 73). Lines it already sent are kept from the Plugins then; new ones still go. */
  resized(session: number) {
    if (!this.readsTerminal()) return;
    let seen = this.seenOutput.get(session);
    if (!seen) {
      seen = { lines: [], set: new Map(), partial: "", repaintUntil: 0 };
      this.seenOutput.set(session, seen);
    }
    seen.repaintUntil = this.now() + REPAINT_MS;
  }

  /** A Session that ended takes what it printed with it. */
  sessionGone(session: number) {
    this.seenOutput.delete(session);
    this.pendingOutput.delete(session);
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

  /** Every loaded or known Plugin's name (`:plugins remove` completes them). */
  names(): string[] {
    return this.snap.plugins.map((p) => p.name);
  }

  // ---------------------------------------------------------------- loading

  private async loadPath(path: string, granted: string[] | null, name: string) {
    let result;
    try {
      // A built-in Plugin is granted everything it asks for until a permission is revoked.
      result = await this.backend.pluginLoad(path, granted ?? ["inventory.read", "inventory.write", "sessions.open", "terminal.read", "terminal.write"]);
    } catch (e) {
      await this.unload(name);
      this.problems.set(name, e instanceof Error ? e.message : String(e));
      this.notify(name, "error", `${name}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const { manifest, reply } = result;
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
    for (const r of Object.values(this.registries)) (r as { unregisterSource(s: string): void }).unregisterSource(name);
    if (this.float?.plugin === name) this.float = null;
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
          void copying.then((ok) => ok && this.notify(name, op.level, `${name}: ${op.text}`));
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
      for (const r of Object.values(this.registries)) (r as { unregisterSource(s: string): void }).unregisterSource(name);
      if (this.float?.plugin === name) this.float = null;
    }
    this.changed();
  }

  /** The command line that runs `run` for `plugin`. */
  private line(plugin: string, run: Run): string {
    return "command" in run ? run.command : `plugins call ${plugin} ${run.handler}`;
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
          run: (_ctx, arg) => {
            const args = (arg ?? "").trim();
            if ("command" in run) this.ui.run(run.command);
            else void this.call(plugin, run.handler, { args, words: args ? args.split(/\s+/) : [] });
          },
        };
        return this.put(l, `command:${op.name}`, r.commands.register(def));
      }
      case "key": {
        const context = KEY_CONTEXTS[op.context];
        if (!context) return refuse(`keys go after the Leader or in the Sidebar (leader, list, list_vim), not ${op.context}`);
        const id = bindingId(context, op.keys);
        if (this.taken(r.keymap, id, plugin)) return refuse(`${op.keys} (${op.context}) is bound already, by ${r.keymap.get(id)?.source ?? "roster"}`);
        // Nor may it start with a bound key, or be the start of one: either would hide the other.
        const clash = r.keymap
          .list()
          .find((b) => b.context === context && b.source !== plugin && b.action !== null && (op.keys.startsWith(`${b.keys} `) || b.keys.startsWith(`${op.keys} `)));
        if (clash) return refuse(`${op.keys} (${op.context}) would hide ${clash.keys}, bound by ${clash.source}`);
        return this.put(l, `key:${id}`, r.keymap.register({ id, source: plugin, context, keys: op.keys, action: op.action === false ? null : op.action }));
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
        const rows = op.rows.map((row) => this.row(plugin, op.id, row));
        const section = { id: op.id, title: op.title, count: rows.length, rows, ...(op.empty ? { empty: op.empty } : {}) };
        return this.put(l, `section:${op.id}`, r.sidebar.register({ id: op.id, source: plugin, order: op.order, build: () => section }));
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
            ...(op.run ? { command: this.line(plugin, op.run) } : {}),
          }),
        );
      }
      case "finder": {
        if (this.taken(r.finders, op.id, plugin)) return refuse(`there's a finder named ${op.id} already`);
        const items = op.items.map(
          (i): FinderItem => ({
            id: i.id,
            label: i.label,
            ...(i.detail ? { detail: i.detail } : {}),
            ...(i.path ? { path: i.path } : {}),
            command: this.line(plugin, i.run),
          }),
        );
        return this.put(
          l,
          `finder:${op.id}`,
          r.finders.register({ id: op.id, source: plugin, title: op.title, prompt: `${op.title} ›`, items: () => items }),
        );
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
        return this.put(l, `health:${op.id}`, r.health.register({ id: op.id, source: plugin, title: op.title, order: 500, checks: () => checks }));
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
        return this.notify(plugin, op.level, `${plugin}: ${op.text}`);
      case "open":
        return this.ui.run(`connect ${op.host}`);
      case "send":
        return this.ui.send(op.session, op.text);
      case "copy":
        return void this.ui.copy(op.text).catch(() => undefined);
      case "remove":
        return this.drop(l, `${op.kind}:${op.id}`);
    }
  }

  private row(plugin: string, section: string, row: PluginRow): SidebarRow {
    return {
      id: `${section}:${row.id}`,
      label: row.label,
      ...(row.detail ? { detail: row.detail } : {}),
      ...(row.note ? { note: row.note } : {}),
      ...(row.host ? { host: row.host } : {}),
      ...(row.badge ? { badge: row.badge } : {}),
      ...(row.count !== undefined ? { count: row.count } : {}),
      ...(row.level !== undefined ? { level: row.level } : {}),
      ...(row.title ? { title: row.title } : {}),
      command: row.run ? this.line(plugin, row.run) : row.host ? `open ${row.host}` : "",
      actions: row.actions.map((a) => ({ label: a.label, icon: a.icon, command: this.line(plugin, a.run) })),
    };
  }

  private notify(plugin: string, level: Notice["level"], text: string) {
    this.notices = [...this.notices, { id: ++this.noticeId, plugin, level, text }].slice(-MAX_NOTICES);
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
      };
    });
    this.snap = { plugins, packages: this.packages, prompts: this.prompts, notices: this.notices, float: this.float };
    for (const l of this.listeners) l();
  }
}
