// The fake Backend's Plugin host (ticket 23): what roster-core's does, for UI tests and the plain
// browser. A fake Plugin is TypeScript shaped like its Lua: `load(roster)` gets a `roster` module
// with only the functions its grants give (as the core's), and functions it hands over come back
// as `{ handler: N }`. Errors name the Plugin and `init.lua`, a load error or a third error
// disables it, as in the core. The built-in `hosts` Plugin is here as the core's Lua is.
import PERMISSIONS from "../../../crates/roster-core/tests/fixtures/plugin-permissions.json";
import { PLUGIN_COMMANDS, ROSTER_ONLY } from "../plugins/cmd";
import { fakeFoldersPlugin } from "./fakeFolders";
import { redact, redactError } from "./redact";
import { BackendCallError, type Host, type OpenSession, type PluginEventName, type PluginCaller, type PluginData, type PluginManifest, type PluginReply } from "./types";

type Fn = (arg: Record<string, unknown>) => unknown;
type Spec = Record<string, unknown>;

/** The `roster` module a fake Plugin's `load` gets. */
export interface FakeRoster {
  api_version: number;
  plugin: { name: string; version: string; permissions: string[]; config: Record<string, unknown> };
  commands: { add(name: string, spec: Spec): void; remove(name: string): void };
  /** The Plugin's own files (api 3, decision Q93): kept in memory here, per Plugin. */
  storage: {
    read(name: string): string | null;
    write(name: string, text: string): void;
    list(): string[];
    remove(name: string): boolean;
    read_json(name: string): unknown;
    write_json(name: string, value: unknown): void;
  };
  /** api 3 (ticket 61): the message line, and the command line opened with text. */
  echo(text: string, opts?: { quiet?: boolean }): void;
  cmdline(text: string): void;
  keymap: { set(context: string, keys: string, action: string | false): void; del(context: string, keys: string): void };
  themes: { define(id: string, theme: Spec): void; remove(id: string): void };
  sidebar: { set(id: string, spec: Spec): void; remove(id: string): void };
  status: { set(id: string, spec: Spec): void; remove(id: string): void };
  finders: { set(id: string, spec: Spec): void; remove(id: string): void };
  help: { set(id: string, spec: Spec): void; remove(id: string): void };
  health: { set(id: string, spec: Spec): void; remove(id: string): void; answer(check: number, lines: unknown): void };
  tutor: { set(id: string, spec: Spec): void; remove(id: string): void };
  badges: { set(host: string, text: string | null): void };
  float: { open(spec: Spec): void; close(): void };
  views: { set(id: string, spec: Spec): void; update(id: string, changes: Spec): void; open(id: string, opts?: { select?: string }): void; close(id: string): void; remove(id: string): void };
  details: { set(id: string, host: string, spec: Spec | null): void; remove(id: string): void };
  clipboard: { copy(text: string): void };
  notify(text: string, level?: "info" | "warn" | "error", opts?: { actions?: { label: string; run: string }[]; quiet?: boolean }): void;
  on(event: PluginEventName, f: Fn): void;
  /** Timers (ticket 79): the app keeps the clock and calls back, as the core does. */
  defer(ms: number, f: () => void): number;
  every(ms: number, f: () => void): number;
  cancel(timer: number): void;
  has(permission: string): boolean;
  /** Ticket 78: a question the app draws, a command line, progress and toolbar controls. */
  confirm(spec: Spec): void;
  cmd(line: string): void;
  progress: { set(id: string, spec: Spec): void; remove(id: string): void };
  toolbar: { set(id: string, spec: Spec): void; remove(id: string): void };
  inventory?: {
    hosts(): Host[];
    host(name: string): Host | undefined;
    groups(): Record<string, { title: string; description: string }>;
    /** api 4 (decision Q127): every Host and group without waiting; `done` runs later. */
    request(done: (list: { hosts: Host[]; groups: Record<string, { title: string; description: string }> } | undefined, err?: string) => void): void;
  };
  /** `list` (api 4, decision Q127) with inventory.read or terminal.read: the Sessions open now. */
  sessions: { show(session: number, line?: string): void; list?(): { session: number; host?: string }[]; open?(host: string): void };
  terminal?: { send(session: number, text: string): void };
  /** With a `serve:` grant: roster serve's methods by name, answered by the fake Backend.
   * `request` doesn't wait: `done` runs later, as the core's does (decision Q103). */
  serve?: {
    call(method: string, params?: Spec): unknown;
    request(method: string, params: Spec | null | undefined, done: (result: unknown, err?: string) => void): void;
  };
}

/** How a fake Plugin's `roster.serve.call` reaches the fake Backend: the result, or a thrown
 * BackendCallError (its code ends the Plugin's error, as the core's does). */
export type FakeServe = (method: string, params: Spec) => unknown;

export interface FakePlugin {
  manifest: Omit<PluginManifest, "permissions"> & { permissions: string[] };
  /** Its init.lua. */
  load(roster: FakeRoster): void;
}

const RISKS: Record<string, string> = {
  "inventory.write": "Can change Hosts. The changes stay Pending until you review and Publish them.",
  "sessions.open": "Can open Sessions on your Hosts.",
  "terminal.read":
    "Sees everything your Sessions print, including anything a server echoes back. A password you type at a prompt that echoes it would be visible too.",
  "terminal.write": "Can type into your open Sessions, as if you typed it: it can run commands on your servers.",
};
const SUMMARIES: Record<string, string> = {
  "inventory.read": "Read your Hosts and their Login references (never a password)",
  "inventory.write": "Change Hosts, as Pending changes",
  "sessions.open": "Open Sessions",
  "terminal.read": "Read what your Sessions print",
  "terminal.write": "Type into your Sessions",
};

/** The serve methods whose summary and risk say more than "Call roster's …" (permission.rs). */
const SERVE: Record<string, { summary: string; risk: string | null } | undefined> = PERMISSIONS.serve;

const EVENT_NEEDS: Record<PluginEventName, string[]> = {
  lock: [],
  unlock: [],
  host_selected: ["inventory.read", "terminal.read"],
  session_open: ["inventory.read", "terminal.read"],
  session_exit: ["inventory.read", "terminal.read"],
  inventory_changed: ["inventory.read"],
  terminal_output: ["terminal.read"],
  command_done: ["terminal.read"],
  job_progress: ["serve:mesh.job", "serve:discover.status", "serve:host.check_job"],
};

/** As runtime.rs's JOB_KINDS: a `job_progress` reaches a Plugin only for a kind of job it may ask
 * about (decision Q112f). */
const JOB_KINDS: Record<string, string> = {
  mesh: "serve:mesh.job",
  discover: "serve:discover.status",
  check: "serve:host.check_job",
};
const hearsThis = (name: PluginEventName, payload: Record<string, unknown>, grants: Set<string>): boolean => {
  if (name !== "job_progress") return true;
  const needs = typeof payload.kind === "string" ? JOB_KINDS[payload.kind] : undefined;
  return needs !== undefined && grants.has(needs);
};

const isName = (s: string) => /^[a-z0-9_.]*$/.test(s);

/** Whether a Plugin may ever call `method`, as permission.rs's serve_method_allowed. */
function serveMethodAllowed(method: string): boolean {
  return (
    PERMISSIONS.serve_methods.includes(method) ||
    PERMISSIONS.serve_prefixes.some((p) => method.length > p.length && method.startsWith(p) && isName(method.slice(p.length)))
  );
}

/** Whether a Plugin may call `method` only in the user's call, as permission.rs's serve_user_only:
 * every method the install prompt flags (decision Q100). */
const userOnlyMethod = (method: string): boolean => !PERMISSIONS.serve_reads.includes(method);

/** As runtime.rs's own_command: one the Plugin added that no built-in has (the app's, as it last
 * said, the ones a Plugin may run, and the ones that change trust or writes, issue #184). */
const ownCommand = (r: { commands: Set<string> }, word: string, builtins: ReadonlySet<string> | null): boolean =>
  r.commands.has(word) && !ROSTER_ONLY.includes(word) && !PLUGIN_COMMANDS.some((c) => c.name === word) && builtins !== null && !builtins.has(word);
/** As runtime.rs's not_yet: the Plugin's command can't run before the app has said its built-ins. */
const notYet = (r: { commands: Set<string> }, word: string, builtins: ReadonlySet<string> | null): string | null =>
  builtins === null && r.commands.has(word) && !ROSTER_ONLY.includes(word) && !PLUGIN_COMMANDS.some((c) => c.name === word)
    ? `:${word} can't run yet: the app hasn't told roster its own commands`
    : null;

// ------------------------------------------------------------------ network:<site> (Q97)
// As roster-core's plugin/network.rs Site::parse, on the same table of cases.

const isLabel = (l: string) => /^[a-z0-9-]{1,63}$/.test(l) && !l.startsWith("-") && !l.endsWith("-");
const isDomain = (s: string) => {
  const labels = s.split(".");
  return s.length <= 253 && labels.length >= 2 && labels.every(isLabel) && !/^[0-9]+$/.test(labels.at(-1) ?? "");
};
const isIpv4 = (s: string) => /^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$/.test(s) && s.split(".").every((n) => Number(n) <= 255);

/** An IPv6 address's eight groups, or null. */
function ipv6Groups(s: string): number[] | null {
  if (!/^[0-9a-f:]+$/.test(s)) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (h: string) => (h === "" ? [] : h.split(":"));
  const head = part(halves[0] ?? "");
  const tail = halves.length === 2 ? part(halves[1] ?? "") : [];
  if ([...head, ...tail].some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  return [...head, ...Array<string>(missing).fill("0"), ...tail].map((g) => parseInt(g, 16));
}

/** RFC 5952's form, as Rust writes an Ipv6Addr. */
function ipv6Text(g: number[]): string {
  let best = -1;
  let len = 0;
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > len && j - i > 1) [best, len] = [i, j - i];
    i = j;
  }
  const hex = (xs: number[]) => xs.map((x) => x.toString(16)).join(":");
  return best < 0 ? hex(g) : `${hex(g.slice(0, best))}::${hex(g.slice(best + len))}`;
}

function v4Public(s: string): boolean {
  const [a = 0, b = 0, c = 0] = s.split(".").map(Number);
  return !(
    a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) || a >= 224
  );
}

interface Site {
  http: boolean;
  /** `private:` before it (decision Q116): a name on the private network. */
  private: boolean;
  /** Its name, port and scheme without the pin: the key two pins can't share. */
  bare: string;
  /** Its name, when it names one exactly (not a wildcard, not an address). */
  name: string | null;
  /** `#sha256:` after it, the fingerprint's 64 hex digits. */
  pin: string | null;
  /** Where it reaches, as a person reads it, without the pin. */
  place: string;
  /** An address that isn't public (the core's is_public; IPv6 simplified to global unicast). */
  inside: boolean;
}

const SITE_HELP =
  "a site is a domain such as api.example.com, *.example.com for the names under it, or an address such as 10.0.0.5; http:// before it allows plain http, :PORT after it another port; private: before a name keeps it inside your private network, and #sha256:FINGERPRINT after an https site trusts only that certificate";

/** A `network:` site, or why the core refuses it. */
function parseSite(text: string): Site | string {
  const bad = (why: string) => `"network:${text}": ${why} (${SITE_HELP})`;
  const priv = text.startsWith("private:");
  let rest = priv ? text.slice(8) : text;
  let pin: string | null = null;
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    const p = rest.slice(hash + 1);
    if (!/^sha256:[0-9a-f]{64}$/.test(p)) return bad("a pin is #sha256: and the certificate's SHA-256 fingerprint as 64 lower-case hex digits, without colons");
    pin = p.slice(7);
    rest = rest.slice(0, hash);
  }
  const http = rest.startsWith("http://");
  if (http) rest = rest.slice(7);
  else if (rest.includes("://")) return bad("only http:// may come before a site; https is the default");
  if (rest === "") return bad("which site?");
  if (/[A-Z]/.test(rest)) return bad("write it in lower case");
  if (/[/?#@ ]/.test(rest)) return bad("only a site, with no path, user or spaces");
  let host: string;
  let port: string | null = null;
  let inside = false;
  let kind: "name" | "under" | "ip" = "name";
  let shown: string | null = null;
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close < 0) return bad("an IPv6 address goes in [ ]");
    const addr = rest.slice(1, close);
    const tail = rest.slice(close + 1);
    if (tail !== "" && !tail.startsWith(":")) return bad("only :PORT may follow ]");
    if (tail !== "") port = tail.slice(1);
    const g = ipv6Groups(addr);
    if (!g) return bad("that isn't an IPv6 address");
    if (ipv6Text(g) !== addr) return bad(`write the address as [${ipv6Text(g)}]`);
    const [g0 = 0, g1 = 0] = g;
    inside = (g0 & 0xe000) !== 0x2000 || (g0 === 0x2001 && (g1 === 0x0db8 || g1 < 0x0200));
    host = `[${addr}]`;
    kind = "ip";
  } else {
    const colon = rest.indexOf(":");
    host = colon < 0 ? rest : rest.slice(0, colon);
    if (colon >= 0) port = rest.slice(colon + 1);
    if (isIpv4(host)) {
      inside = !v4Public(host);
      kind = "ip";
    } else if (host.startsWith("*.")) {
      if (!isDomain(host.slice(2))) return bad("*. goes before a domain of two names or more, such as *.example.com");
      kind = "under";
      shown = `any site under ${host.slice(2)}${http ? " over plain http" : ""}${port !== null ? ` on port ${port}` : ""}`;
    } else if (host.includes("*")) return bad("a wildcard is only *. at the start");
    else if (!(isDomain(host) || (priv && isLabel(host) && !/^[0-9]+$/.test(host)))) {
      return bad(/^[0-9.]+$/.test(host) ? "that isn't an IPv4 address" : "that isn't a domain with a dot in it, such as api.example.com");
    }
  }
  if (port !== null && !(/^[1-9][0-9]{0,4}$/.test(port) && Number(port) <= 65535)) return bad("the port is a number from 1 to 65535");
  if (priv) {
    if (kind === "ip") return bad(`an address is a site of its own: write network:${http ? "http://" : ""}${host}`);
    if (kind === "under") return bad("private: names one site, never a wildcard");
    if (host === "localhost" || host.endsWith(".localhost")) return bad("that's this computer, not your private network: list 127.0.0.1 if you mean it");
  }
  if (pin !== null) {
    if (http) return bad("plain http has no certificate to pin");
    if (kind === "under") return bad("a pin is for one site, never a wildcard");
  }
  const bare = `${http ? "http://" : ""}${host}${port !== null ? `:${port}` : ""}`;
  const place = `${shown ?? bare}${priv ? " on your private network" : ""}`;
  return { http, private: priv, bare, name: kind === "name" ? host : null, pin, place, inside };
}

function networkSummary(site: Site): string {
  return `Send and fetch over the network: ${site.place}${site.pin ? ", with a pinned certificate" : ""}`;
}

function networkRisk(site: Site): string {
  let text = `Can send data to ${site.place} and fetch from it: anything the Plugin can read (your Hosts, what your Sessions print) could leave this computer.`;
  if (site.http) text += " Plain http: anyone on the way can read and change it.";
  if (site.inside) text += " That address is on this computer or a private network.";
  if (site.private) text += " It reaches inside your private network: whatever your network's DNS says that name is there. roster lets it reach only a private address, never this computer or the internet.";
  if (site.pin) text += ` Trusts only the certificate whose SHA-256 starts ${site.pin.slice(0, 16)}, in place of the ones your computer trusts, for this site alone.`;
  return text;
}

/** What one manifest's sites may not say together (network.rs's check_together). */
function sitesProblem(permissions: readonly string[]): string | null {
  const sites = permissions
    .filter((p) => p.startsWith("network:"))
    .map((p) => [p, parseSite(p.slice(8))] as const)
    .flatMap(([p, s]) => (typeof s === "string" ? [] : [[p, s] as const]));
  for (const [i, [pa, a]] of sites.entries()) {
    for (const [pb, b] of sites.slice(i + 1)) {
      if (a.name !== null && a.name === b.name && a.private !== b.private) {
        return `"${pa}" and "${pb}": ${a.name} is either a name on your private network (private:${a.name}) or a public one, not both`;
      }
      if (a.pin !== b.pin && a.bare === b.bare && a.private === b.private) {
        return `"${pa}" and "${pb}": ${a.private ? "private:" : ""}${a.bare} is one site, with one pin or none`;
      }
    }
  }
  return null;
}

/** Why the core refuses `p` in a manifest (permission.rs's Permission::parse), or null. */
function permissionProblem(p: string): string | null {
  if (PERMISSIONS.permissions.includes(p)) return null;
  if (p === "network") return `"network" names the site it may reach: "network:api.example.com", one for each site`;
  if (p.startsWith("network:")) {
    const site = parseSite(p.slice(8));
    return typeof site === "string" ? site : null;
  }
  if (p.startsWith("serve:")) {
    const method = p.slice(6);
    if (serveMethodAllowed(method)) return null;
    return `"serve:${method}" can't be granted: a Plugin may call only ${PERMISSIONS.serve_methods.join(", ")} and the mesh.* and discover.* methods, never one that reaches a secret`;
  }
  return `${JSON.stringify(p)} isn't a permission (there's inventory.read, inventory.write, sessions.open, terminal.read, terminal.write, serve:<method> and network:<site>)`;
}

/** What the core refuses in a manifest: the first permission it can't grant. From the table the
 * core is tested on too (crates/roster-core/tests/fixtures/plugin-permissions.json). */
export function manifestProblem(m: FakePlugin["manifest"]): string | null {
  for (const p of m.permissions) {
    const problem = permissionProblem(p);
    if (problem) return `roster-plugin.lua: permissions: ${problem}`;
  }
  const together = sitesProblem(m.permissions);
  return together ? `roster-plugin.lua: permissions: ${together}` : null;
}

export function described(m: FakePlugin["manifest"]): PluginManifest {
  const problem = manifestProblem(m);
  if (problem) throw new BackendCallError(`${m.name}: ${problem}`);
  return {
    ...m,
    permissions: m.permissions.map((name) => {
      const site = name.startsWith("network:") ? parseSite(name.slice(8)) : null;
      if (site && typeof site !== "string") {
        return { name, summary: networkSummary(site), risk: networkRisk(site) };
      }
      return {
      name,
      summary: SUMMARIES[name] ?? SERVE[name]?.summary ?? `Call roster's ${name.replace(/^serve:/, "")}`,
      risk:
        RISKS[name] ??
        SERVE[name]?.risk ??
        (name.startsWith("serve:") && !PERMISSIONS.serve_reads.includes(name.slice(6))
          ? `Can run roster's ${name.slice(6)}, which can change things on your Hosts or in the Inventory.`
          : null),
      };
    }),
  };
}

/** A file name `roster.storage` takes, as folder.rs checks it: a plain name, never a path. */
function storageName(name: string, fn: string): string {
  if (!name) throw new Error(`roster.storage.${fn}: a file needs a name, like "folders.json"`);
  if (name.length > 100) throw new Error(`roster.storage.${fn}: the name is over 100 characters`);
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.startsWith(".")) {
    throw new Error(`roster.storage.${fn}: ${JSON.stringify(name)} isn't a file name: letters, digits, - _ and . only, not starting with . (no folders, no paths)`);
  }
  return name;
}

/** The status bar's Host count, as crates/roster-core/plugins/hosts/init.lua writes it. */
export const fakeHostsPlugin: FakePlugin = {
  manifest: { name: "hosts", version: "1.0.0", description: "The status bar's Host count", author: "roster", api: 2, permissions: ["inventory.read"] },
  load(roster) {
    const inventory = roster.inventory;
    if (!inventory) return;
    const show = () => {
      const n = inventory.hosts().length;
      roster.status.set("hosts", { text: `${n.toLocaleString("en-US")} ${n === 1 ? "Host" : "Hosts"}` });
    };
    show();
    roster.on("inventory_changed", show);
  },
};

interface Running {
  manifest: PluginManifest;
  grants: Set<string>;
  handlers: Map<number, Fn>;
  /** The timers waiting, by handler: whether each repeats. */
  timers: Map<number, boolean>;
  /** The commands it added: `roster.cmd` may run them (ticket 78). */
  commands: Set<string>;
  listeners: Map<string, Fn[]>;
  errors: number;
  disabled: string | null;
  /** Its `roster.serve.request` calls not yet answered and run. */
  requests: number;
}

/** How many `roster.serve.request` calls a Plugin may have waiting, as runtime.rs's. */
const MAX_SERVE_REQUESTS = 8;

export function fakePluginHost(
  plugins: Record<string, FakePlugin>,
  hosts: () => Host[],
  /** Paths found elsewhere (a Package's `package:NAME`), with the settings they're handed. */
  extra: (path: string) => { plugin: FakePlugin; config: Record<string, unknown> } | undefined = () => undefined,
  /** roster serve, for the Plugins granted a `serve:` method. */
  serve: FakeServe = (method) => {
    throw new BackendCallError(`unknown method '${method}'`, -32601);
  },
): {
  pluginManifest(path: string): Promise<{ manifest: PluginManifest; dir: string }>;
  pluginTypes(path: string): Promise<string>;
  pluginLoad(path: string, grants: readonly string[], settings?: Record<string, unknown> | null): Promise<{ manifest: PluginManifest; dir: string; reply: PluginReply }>;
  pluginForget(plugin: string): Promise<boolean>;
  pluginBuiltins(names: readonly string[]): Promise<void>;
  pluginData(names: readonly string[]): Promise<Record<string, PluginData>>;
  /** What each Plugin keeps in its data folder (tests look). */
  pluginFiles(plugin: string): Map<string, string>;
  pluginCall(plugin: string, handler: number, args: unknown, user?: PluginCaller): Promise<PluginReply>;
  pluginEvent(name: PluginEventName, payload: Record<string, unknown>): Promise<PluginReply[]>;
  pluginSessions(open: OpenSession[]): Promise<void>;
  pluginUnload(plugin: string): Promise<boolean>;
  onPluginReply(onReply: (reply: PluginReply) => void): () => void;
  /** As the core does when a request answers: hands `reply` to whoever listens. */
  pluginReplied(reply: PluginReply): void;
  /** Resolves once every request the Plugin made has answered and run (as the core's
   * `PluginHost::requests` reaching 0). */
  pluginSettled(plugin: string): Promise<void>;
} {
  const all: Record<string, FakePlugin> = { "builtin:hosts": fakeHostsPlugin, "builtin:folders": fakeFoldersPlugin, ...plugins };
  /** Each Plugin's data folder, by its name: kept across reloads, gone with pluginForget. */
  const files = new Map<string, Map<string, string>>();
  const filesOf = (name: string) => {
    let f = files.get(name);
    if (!f) files.set(name, (f = new Map()));
    return f;
  };
  /** The handlers the app calls as it likes (a command's complete, a finder's items, a :check
   * section's check): never a user's call. */
  const quiet = new Set<number>();
  const running = new Map<string, Running>();
  /** The app's built-in commands, as it last said (PluginHost::set_builtins): null until it has. */
  let builtins: ReadonlySet<string> | null = null;
  let next = 0;
  let ops: unknown[] = [];
  /** Whether the run is a call the user started: only then may a Plugin copy. */
  let userCall = false;
  /** Whether the run carries the user's call one hop (a request's answer, or a command `roster.cmd`
   * ran): a request or a command line made in it doesn't carry it further (issue #183). */
  let carried = false;
  const replyWatchers = new Set<(reply: PluginReply) => void>();
  /** The Sessions open now, as the app last listed them (a Quick Connect Session's host is null). */
  let open: OpenSession[] = [];

  const configs = new Map<string, Record<string, unknown>>();
  const find = (path: string) => {
    const found = extra(path);
    const p = found?.plugin ?? all[path];
    if (found) configs.set(path, found.config);
    if (!p) throw new BackendCallError(`${path} has no roster-plugin.lua: is it a roster Plugin?`);
    return p;
  };

  const data = (r: Running, v: unknown): unknown => {
    if (typeof v === "function") {
      const id = ++next;
      r.handlers.set(id, v as Fn);
      return { handler: id };
    }
    if (Array.isArray(v)) return v.map((x) => data(r, x));
    if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, data(r, x)]));
    return v;
  };

  const userOnly = (what: string) => {
    if (!userCall) throw new Error(`${what}: only while the user runs one of your actions, commands or finder items`);
  };

  const module = (r: Running, config: Record<string, unknown> = {}): FakeRoster => {
    const push = (op: Record<string, unknown>) => ops.push(data(r, op));
    const piece = (kind: string) => ({
      set: (id: string, spec: Spec) => {
        const op = data(r, { op: kind, id, spec }) as { spec: Record<string, { handler?: number } | undefined> };
        // As runtime.rs: what the app runs on its own is never the user's call.
        const unasked = kind === "finder" ? op.spec.items : kind === "health" ? op.spec.check : undefined;
        if (unasked?.handler !== undefined) quiet.add(unasked.handler);
        ops.push(op);
      },
      remove: (id: string) => push({ op: "remove", kind, id }),
    });
    const m: FakeRoster = {
      api_version: 4,
      plugin: { name: r.manifest.name, version: r.manifest.version, permissions: [...r.grants], config },
      commands: {
        add: (name, spec) => {
          r.commands.add(name);
          const op = data(r, { op: "command", name, desc: spec.desc ?? "", run: spec.run, ...(spec.complete ? { complete: spec.complete } : {}) }) as Record<string, unknown>;
          const c = op.complete as { handler?: number } | undefined;
          if (c?.handler !== undefined) quiet.add(c.handler);
          ops.push(op);
        },
        remove: (name) => {
          r.commands.delete(name);
          push({ op: "remove", kind: "command", id: name });
        },
      },
      keymap: {
        set: (context, keys, action) => push({ op: "key", context, keys, action }),
        del: (context, keys) => push({ op: "key", context, keys, action: false }),
      },
      themes: { define: (id, theme) => push({ op: "theme", id, theme }), remove: (id) => push({ op: "remove", kind: "theme", id }) },
      sidebar: piece("section"),
      status: piece("status"),
      finders: piece("finder"),
      help: piece("help"),
      health: { ...piece("health"), answer: (check, lines) => push({ op: "health_answer", check, checks: lines }) },
      tutor: piece("tutor"),
      badges: { set: (host, text) => push({ op: "badge", host, text }) },
      float: { open: (spec) => push({ op: "float", spec }), close: () => push({ op: "float", spec: null }) },
      views: {
        set: (id, spec) => push({ op: "view", id, spec }),
        update: (id, changes) => push({ op: "view_update", id, changes }),
        open: (id, opts) => {
          if (!userCall) throw new Error("roster.views.open: only while the user runs one of your actions, commands or finder items");
          push({ op: "view_open", id, ...(opts?.select !== undefined ? { select: opts.select } : {}) });
        },
        close: (id) => push({ op: "view_close", id }),
        remove: (id) => push({ op: "remove", kind: "view", id }),
      },
      details: {
        set: (id, host, spec) => push({ op: "details", id, host, spec }),
        remove: (id) => push({ op: "remove", kind: "details", id }),
      },
      clipboard: {
        copy: (text) => {
          if (!userCall) throw new Error("roster.clipboard.copy: only while the user runs one of your actions, commands or finder items");
          push({ op: "copy", text });
        },
      },
      notify: (text, level = "info", opts) =>
        push({ op: "notify", text, level, ...(opts?.actions ? { actions: opts.actions } : {}), ...(opts?.quiet !== undefined ? { quiet: opts.quiet } : {}) }),
      echo: (text, opts) => {
        userOnly("roster.echo");
        push({ op: "echo", text, ...(opts?.quiet ? { quiet: true } : {}) });
      },
      cmdline: (text) => {
        userOnly("roster.cmdline");
        const word = text.trim().split(/\s+/)[0] ?? "";
        const why = notYet(r, word, builtins);
        if (why) throw new Error(`roster.cmdline: ${why}`);
        if (!ownCommand(r, word, builtins)) throw new Error(`roster.cmdline: ${JSON.stringify(word)} isn't one of your commands`);
        push({ op: "cmdline", text });
      },
      storage: {
        read: (name) => filesOf(r.manifest.name).get(storageName(name, "read")) ?? null,
        write: (name, text) => {
          if (text.length > 1024 * 1024) throw new Error(`roster.storage.write: ${name} would be ${text.length} bytes: a file holds at most 1 MB (1048576 bytes)`);
          filesOf(r.manifest.name).set(storageName(name, "write"), text);
        },
        list: () => [...filesOf(r.manifest.name).keys()].sort(),
        remove: (name) => filesOf(r.manifest.name).delete(storageName(name, "remove")),
        read_json: (name) => {
          const text = filesOf(r.manifest.name).get(storageName(name, "read_json"));
          if (text === undefined) return null;
          try {
            return JSON.parse(text) as unknown;
          } catch (e) {
            throw new Error(`roster.storage.read_json: ${name} isn't JSON (${String(e)})`, { cause: e });
          }
        },
        write_json: (name, value) => filesOf(r.manifest.name).set(storageName(name, "write_json"), `${JSON.stringify(value, null, 2)}\n`),
      },
      on: (event, f) => {
        const needs = EVENT_NEEDS[event];
        if (needs.length && !needs.some((p) => r.grants.has(p))) throw new Error(`roster.on: the ${event} event needs the ${needs.join(" or ")} permission`);
        r.listeners.set(event, [...(r.listeners.get(event) ?? []), f]);
      },
      confirm: (spec) => {
        userOnly("roster.confirm");
        if (typeof spec.run !== "function") throw new Error("roster.confirm: `run` must be a function: what happens when the user confirms");
        push({ op: "confirm", spec });
      },
      cmd: (line) => {
        userOnly("roster.cmd");
        const word = line.trim().split(/\s+/)[0] ?? "";
        if (!word) throw new Error('roster.cmd: which command? (a line such as "finder alerts")');
        const why = notYet(r, word, builtins);
        if (why) throw new Error(`roster.cmd: ${why}`);
        if (!ownCommand(r, word, builtins)) {
          const rule = PLUGIN_COMMANDS.find((c) => c.name === word);
          if (!rule) throw new Error(`roster.cmd: :${word} isn't one a Plugin may run (its own commands, and ${PLUGIN_COMMANDS.map((c) => c.name).join(", ")})`);
          if (rule.permission && !r.grants.has(rule.permission)) throw new Error(`roster.cmd: :${word} needs the ${rule.permission} permission`);
        }
        push(carried ? { op: "cmd", line: line.trim(), user: false } : { op: "cmd", line: line.trim() });
      },
      progress: piece("progress"),
      toolbar: piece("toolbar"),
      sessions: {
        show: (session, line) => {
          userOnly("roster.sessions.show");
          push({ op: "session_show", session, line: line ?? null });
        },
      },
      defer: (ms, f) => timer(r, "roster.defer", ms, f, false),
      every: (ms, f) => timer(r, "roster.every", ms, f, true),
      cancel: (id) => {
        if (!r.timers.delete(id)) return;
        r.handlers.delete(id);
        ops.push({ op: "remove", kind: "timer", id: String(id) });
      },
      has: (p) => {
        if (permissionProblem(p) === null) return r.grants.has(p);
        if (p === "network") return [...r.grants].some((g) => g.startsWith("network:"));
        if (p.startsWith("serve:") || p.startsWith("network:")) return false;
        throw new Error(`roster.has: ${JSON.stringify(p)} isn't a permission`);
      },
    };
    if (r.grants.has("inventory.read")) {
      // As the core's, which reads them from serve: cmd:/env: references cut (Q92).
      const groups = () => Object.fromEntries([...new Set(hosts().map((h) => h.group))].map((g) => [g, { title: "", description: "" }]));
      m.inventory = {
        hosts: () => redact(hosts()),
        host: (name) => redact(hosts().find((h) => h.name === name)),
        groups: () => redact(groups()),
        request: (done) => {
          if (r.requests >= MAX_SERVE_REQUESTS) {
            throw new Error(`roster.inventory.request: ${MAX_SERVE_REQUESTS} requests are waiting for roster serve already: wait for one to answer`);
          }
          const list = redact({ hosts: hosts(), groups: groups() });
          later(r, () => done(list));
        },
      };
    }
    // As runtime.rs: there for whoever may hear session_open.
    if (EVENT_NEEDS.session_open.some((p) => r.grants.has(p))) {
      m.sessions.list = () => open.map(({ session, host }) => (host === null ? { session } : { session, host }));
    }
    if (r.grants.has("sessions.open")) m.sessions.open = (host) => push({ op: "open", host });
    if (r.grants.has("terminal.write")) m.terminal = { send: (session, text) => push({ op: "send", session, text }) };
    // As runtime.rs: `roster.serve` with any serve: grant, each call checked against its own.
    if ([...r.grants].some((g) => g.startsWith("serve:"))) {
      // serve's answers and errors with their cmd:/env: references cut, as runtime.rs's redacted (Q92).
      const errorText = (e: unknown) =>
        redactError(e instanceof BackendCallError && e.code !== null ? `${e.message} (code ${e.code})` : e instanceof Error ? e.message : String(e));
      m.serve = {
        call: (method, params = {}) => {
          if (!r.grants.has(`serve:${method}`)) throw new Error(`roster.serve.call: not granted (serve:${method})`);
          if (userOnlyMethod(method)) userOnly(`roster.serve.call ${method}`);
          try {
            return redact(serve(method, params));
          } catch (e) {
            // No `cause`: serve's own error is uncut, and a Plugin could read it there (Q92).
            // eslint-disable-next-line preserve-caught-error -- the cut message is all a Plugin gets
            throw new Error(`roster.serve.call ${method}: ${errorText(e)}`);
          }
        },
        // serve is asked now (the core's thread asks at once); `done` runs later, as a call of its
        // own whose reply goes to whoever listens.
        request: (method, params, done) => {
          const what = `roster.serve.request ${method}`;
          if (!r.grants.has(`serve:${method}`)) throw new Error(`roster.serve.request: not granted (serve:${method})`);
          if (userOnlyMethod(method)) userOnly(what);
          if (r.requests >= MAX_SERVE_REQUESTS) {
            throw new Error(`${what}: ${MAX_SERVE_REQUESTS} requests are waiting for roster serve already: wait for one to answer`);
          }
          let answer: () => void;
          try {
            const result = redact(serve(method, params ?? {}));
            answer = () => done(result ?? undefined);
          } catch (e) {
            answer = () => done(undefined, `${what}: ${errorText(e)}`);
          }
          later(r, answer);
        },
      };
    }
    return m;
  };

  /** A request's answer: `answer` runs later as a call of its own, carrying the user's call one
   * hop when it was made in one, its reply to whoever listens (as runtime.rs's ask_later). */
  const later = (r: Running, answer: () => void) => {
    const user = userCall && !carried;
    r.requests++;
    setTimeout(() => {
      r.requests--;
      if (running.get(r.manifest.name) !== r || r.disabled) return;
      [userCall, carried] = [user, user];
      let reply: PluginReply;
      try {
        reply = run(r.manifest.name, r, answer);
      } finally {
        [userCall, carried] = [false, false];
      }
      if (reply.ops.length || reply.error) for (const w of replyWatchers) w(reply);
    }, 0);
  };

  /** As runtime.rs's add_timer: the same floors, ceiling and op. */
  const timer = (r: Running, what: string, ms: number, f: () => void, every: boolean): number => {
    if (!Number.isFinite(ms) || ms < 0 || ms > 2_147_483_647) throw new Error(`${what}: ms must be a number of milliseconds from 0 to 2147483647`);
    if (every && ms < 1000) throw new Error(`${what}: at least 1000 ms between runs (use roster.defer for once, soon)`);
    if (r.timers.size >= 100) throw new Error(`${what}: more than 100 timers waiting at once (roster.cancel the ones you don't need)`);
    const id = ++next;
    r.handlers.set(id, () => f());
    r.timers.set(id, every);
    ops.push({ op: "timer", id: String(id), ms: Math.max(50, Math.ceil(ms)), every, run: { handler: id } });
    return id;
  };

  /** Runs `body` as a call into the Plugin: its ops, or its error (and a strike). */
  const run = (name: string, r: Running, body: () => unknown, loading = false): PluginReply => {
    ops = [];
    try {
      const result = body();
      return { plugin: name, result: data(r, result) ?? null, ops, error: null, disabled: null };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      r.errors += loading ? 3 : 1;
      if (r.errors >= 3) r.disabled = loading ? `it failed to load: ${name}: init.lua: ${message}` : `it failed ${r.errors} times`;
      return { plugin: name, result: null, ops: [], error: { plugin: name, file: "init.lua", line: null, message }, disabled: r.disabled };
    }
  };

  return {
    async pluginTypes(path) {
      // No disk here: the stubs would go to the folder's types/roster.lua.
      if (!path.trim()) throw new BackendCallError("which folder? :plugins types PATH");
      return `${path.replace(/[\\/]+$/, "")}/types/roster.lua`;
    },
    async pluginManifest(path) {
      return { manifest: described(find(path).manifest), dir: path };
    },
    async pluginLoad(path, grants, settings) {
      const p = find(path);
      const manifest = described(p.manifest);
      const r: Running = {
        manifest,
        grants: new Set(p.manifest.permissions.filter((x) => grants.includes(x))),
        handlers: new Map(),
        timers: new Map(),
        commands: new Set(),
        listeners: new Map(),
        errors: 0,
        disabled: null,
        requests: 0,
      };
      running.set(manifest.name, r);
      const config = path.startsWith("builtin:") && settings ? settings : configs.get(path);
      const reply = run(manifest.name, r, () => p.load(module(r, config)), true);
      return { manifest, dir: path, reply };
    },
    async pluginCall(plugin, handler, args, user = true) {
      const r = running.get(plugin);
      if (!r || r.disabled) {
        const message = r?.disabled ? `it's disabled: ${r.disabled}` : "it isn't loaded";
        return { plugin, result: null, ops: [], error: { plugin, file: null, line: null, message }, disabled: null };
      }
      const f = r.handlers.get(handler);
      if (!f) return { plugin, result: null, ops: [], error: { plugin, file: null, line: null, message: "that action is gone: the Plugin replaced it" }, disabled: null };
      // A timer firing isn't something the user started; a deferred one is gone once it runs.
      const timer = r.timers.get(handler);
      if (timer === false) {
        r.timers.delete(handler);
        r.handlers.delete(handler);
      }
      userCall = user !== false && timer === undefined && !quiet.has(handler);
      carried = userCall && user === "carried";
      try {
        return run(plugin, r, () => f((args ?? {}) as Record<string, unknown>));
      } finally {
        [userCall, carried] = [false, false];
      }
    },
    async pluginEvent(name, payload) {
      const replies: PluginReply[] = [];
      // serve's own text (job_progress) is cut as its answers are, as runtime.rs's heard_payload.
      const heard = name === "job_progress" ? redact(payload) : payload;
      for (const [plugin, r] of running) {
        const fs = r.listeners.get(name);
        const needs = EVENT_NEEDS[name];
        if (!fs || r.disabled || (needs.length && !needs.some((p) => r.grants.has(p))) || !hearsThis(name, payload, r.grants)) continue;
        const reply = run(plugin, r, () => fs.forEach((f) => f(heard)));
        if (reply.ops.length || reply.error) replies.push(reply);
      }
      return replies;
    },
    async pluginSessions(list) {
      // As mod.rs's set_sessions: the app's whole list replaces the last.
      open = list.map((o) => ({ ...o }));
    },
    async pluginUnload(plugin) {
      return running.delete(plugin);
    },
    async pluginBuiltins(names) {
      builtins = new Set(names);
    },
    async pluginForget(plugin) {
      return files.delete(plugin);
    },
    async pluginData(names) {
      // As folder.rs counts: files and their bytes (UTF-8, as written to disk); none until written.
      const out: Record<string, PluginData> = {};
      for (const n of names) {
        const f = files.get(n);
        out[n] = f ? { state: "used", files: f.size, bytes: [...f.values()].reduce((a, t) => a + new TextEncoder().encode(t).length, 0) } : { state: "none" };
      }
      return out;
    },
    pluginFiles: (plugin) => filesOf(plugin),
    onPluginReply(onReply) {
      replyWatchers.add(onReply);
      return () => replyWatchers.delete(onReply);
    },
    pluginReplied(reply) {
      for (const w of replyWatchers) w(reply);
    },
    async pluginSettled(plugin) {
      while ((running.get(plugin)?.requests ?? 0) > 0) await new Promise((done) => setTimeout(done, 0));
    },
  };
}
