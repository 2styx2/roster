// The open tabs, one Session each, outside React: a Session must outlive a component remount
// (StrictMode mounts twice; ticket 07 will move terminals around), so the store opens and closes
// Sessions and keeps each one's recent output to replay into whichever terminal attaches.
// React reads it through useSyncExternalStore (useTabs).
import {
  BackendCallError,
  HostKeyError,
  SessionRefusal,
  type Backend,
  type HostKeyScan,
  type QuickConnect,
  type SessionAuth,
  type SessionEvents,
  type SessionExit,
  type SessionHandle,
  type TermSize,
} from "../backend/types";
import { classifyDrop, classifyExit, terminalTail, type Problem } from "../errors/classify";
import { problemFromCallError } from "../errors/catalog";
import { hostnameIn } from "../quick/hostname";
import { formatQuickTarget, type QuickTarget } from "../quick/target";
// Types only: the watch itself (xterm) comes from setFillPrompts, so this module loads without a
// terminal (the docs site's generator reads tabs.ts's helpers in Node).
import type { Breadcrumb, PasswordPrompt, PromptWatch } from "./prompt";
import { ShellHooks, TokenMask, hasTyping, newNonce, type IntegrateResult, type PromptScreen } from "./shellHooks";
import { hopWords } from "./breadcrumb";
import { isLive } from "./status";
import { Attempt } from "./attempt";

export type TabStatus =
  | { state: "connecting" }
  /** roster has no host key recorded for the Host (ticket 36, decision Q60): nothing connects until
   * the user answers. `key` is null while it's being fetched; `trusting` while it's being recorded. */
  | { state: "asking"; key: HostKeyScan | null; trusting: boolean }
  /** The Host's Login is `auth: prompt` (ticket 16): roster has no password for it, so the tab asks
   * for one (`connectPrompted`) before anything connects. */
  | { state: "password"; user: string; address: string; port: number }
  | { state: "open" }
  /** roster refused (`session.prepare`) or the PTY couldn't start; `code` is roster's. */
  | { state: "failed"; message: string; code: number | null; problem: Problem }
  /** `problem`: why ssh failed (exit 255, classified from what it printed before logging in, or a
   * dropped Session after that), or null. */
  | { state: "ended"; exit: SessionExit; problem: Problem | null };

export interface Tab {
  id: number;
  host: string;
  /** The Host's name, with " (2)", " (3)"… on further Sessions to the same Host. */
  label: string;
  status: TabStatus;
  /** How its Session logs in, once one has opened (the tab's state dot: hollow for password). */
  auth: SessionAuth | null;
  /** The Session has reached a shell: it printed something since it started connecting. Until
   * then it's still connecting, from the user's side, even once ssh runs (it's logging in), and
   * the row and the pane say so (issue #78). */
  shell: boolean;
  /** 1 for the first Session in the tab, 2 and on after each reconnect ("Reconnecting to …"). */
  attempt: number;
  /** A Quick Connect (ticket 14): the box, which isn't in the Inventory (`host` is then
   * `user@address`), and serve's id for it once a Session has opened (ticket 15's "Save to vault"
   * refers to it). Null for a Session to a Host. */
  quick: { to: QuickTarget; id: string | null } | null;
  /** "Save to vault" (tickets 15, 16): serve holds the password typed for this Session under
   * `held`. `loggedIn` once the Session logged in with it (serve says so), `hostname` what the
   * box's shell calls it, `saved` the Host it was saved as. Null when nothing is held. */
  save: SaveOffer | null;
  /** sudo's password prompt at the Session's cursor (ticket 119), while it's there: the line as
   * the Host printed it, why roster won't fill it when the shell's marks leave it unsure, and
   * whether there were marks at all. Null otherwise. Never a password. */
  prompt: PasswordPrompt | null;
  /** The folder the shell last said it's in (OSC 7, ticket 121); absent or null until it says. */
  cwd?: string | null;
  /** Where a nested ssh took the Session (ticket 120): the Inventory Host it's on now, or a target
   * roster can't resolve, until that ssh ends. Absent or null on the Session's own Host. */
  hop?: Breadcrumb | null;
  /** The Inventory roster ran on when this Session opened (ticket 115), set only while roster may
   * run on another now (or hasn't said which yet): its name, else its file, else "another
   * Inventory". `label` then ends with " · " and that, and the Session is never filled, started
   * again or sent the shell hook line, since serve would answer for a Host of the same name in
   * another Inventory. */
  from?: string | null;
}

/** Where a serve runs (ticket 115): `inventories.list`'s `name` and `path` (`inventory.info`'s path
 * before API 27). Two are the same Inventory only when both match. */
export interface InventoryAt {
  name: string | null;
  path: string | null;
}

/** A tab opened on a serve that never said where it runs, before serve started again. */
const LOST = "lost";

export type { Breadcrumb, PasswordPrompt };

/** How Tabs watches Host Sessions for sudo's prompt (ticket 119). */
export interface FillPrompts {
  /** The Host's login user, which sudo's prompt must name; null: don't watch it. */
  userOf(host: string): string | null;
  /** A watch for a Session of `size` whose login user is `user`, whose shell hooks carry the token
   * `nonce` (prompt.ts's PromptWatch). */
  watch(size: TermSize, user: string, nonce: string): PromptWatch;
}

/** What Tabs works with from the app (`configure`). */
export interface TabsConfig {
  /** A password Host's vault turned out locked (`session.prepare` code 14): the app shows the lock
   * screen, then calls `resumeAfterUnlock`. */
  onVaultLocked: () => void;
  /** Sees every Session's output as it arrives (Plugins with terminal.read, ticket 23), and each
   * resize sent to one, after which the Session may print its screen again (ticket 73). Never
   * what's typed. */
  outputTap: OutputTap | null;
  /** Whether roster can be asked about a Host's key (API 11, ticket 36). Without it, roster's "no
   * host key recorded" (44) is a refusal like any other. */
  asksAboutKeys: boolean;
  /** How Host Sessions are watched for sudo's prompt (ticket 119); null (an older roster) watches
   * nothing. Each Session started after it's set is watched, never a Quick Connect. */
  fillPrompts: FillPrompts | null;
  /** Shell hooks (ticket 121): `on` says whether roster sends a tab's Session the hook line by
   * itself, asked when the login goes quiet at a prompt (so a Config reload counts); `screen` makes
   * the screen each Session started after it's set reads its prompt off (ticket 159: xterm, fed the
   * Session's output at its size, so it's there for a tab that isn't on screen too). Null: no hook
   * line is ever sent. */
  shellHooks: { on(tab: Tab): boolean; screen: ((size: TermSize) => PromptScreen) | null } | null;
}

/** What a tab's tooltip says about its Session: how it logged in, the Host a nested ssh took it to
 * (ticket 120), and the folder its shell is in (OSC 7), a line each; empty when it knows none yet. */
export function tabFacts(tab: Tab): string {
  return [tab.auth ? `${tab.auth} login` : "", tab.hop ? hopWords(tab.hop) : "", tab.cwd ? `in ${tab.cwd}` : ""].filter(Boolean).join("\n");
}

export interface SaveOffer {
  held: string;
  loggedIn: boolean;
  hostname: string | null;
  saved: string | null;
}

export interface TabsSnapshot {
  tabs: readonly Tab[];
  active: number | null;
  /** The tab that was active before this one (the session bar's `-`), while it's still open. */
  previous: number | null;
}

const encoder = new TextEncoder();

/** Output kept per tab for a terminal that attaches later (or again). */
const REPLAY_LIMIT = 1024 * 1024;

type Sink = (data: Uint8Array) => void;

/** Where Plugins hear the Sessions: their output, with the size its PTY has. */
export interface OutputTap {
  output(id: number, host: string | null, data: Uint8Array, size: TermSize): void;
}

/** What a tab's terminal is wired to; the same object for the tab's whole life. */
export interface TerminalWiring {
  attach(sink: Sink): () => void;
  onData(data: string): void;
  onResize(size: TermSize): void;
}

interface Entry {
  tab: Tab;
  session: SessionHandle | null;
  /** Closed by the user before the Session finished opening. */
  closing: boolean;
  /** Counts the Session starts in this tab (and key questions), so a late answer to an earlier one
   * is ignored. */
  seq: number;
  /** The latest Session start's own state. */
  run: Attempt;
  size: TermSize;
  /** The size the Session was last told about. */
  sentSize: TermSize;
  replay: Uint8Array[];
  replayBytes: number;
  sink: Sink | null;
  wiring: TerminalWiring;
  /** The tab as it was before a reconnect, put back if the user cancels a host key question. */
  before: Tab | null;
  /** This open or reconnect has asked about the Host's key already: roster saying "no key" again
   * after that is an error, not another question. */
  keyAsked: boolean;
  /** Keys typed before the Session finished opening. On Windows this includes xterm's answer
   * to ConPTY's cursor-position request, which ConPTY waits for before starting anything. */
  pending: string[];
  /** A fill is under way: a second press waits for it. */
  filling: boolean;
}

/** The most a fill's window keeps from Plugins when no line break ends it. */
const FILL_WINDOW_LIMIT = 4 * 1024;

export class Tabs {
  private readonly backend: Backend;
  private entries: Entry[] = [];
  private active: number | null = null;
  private previous: number | null = null;
  private nextId = 1;
  private lastSize: TermSize = { cols: 80, rows: 24 };
  private snap: TabsSnapshot = { tabs: [], active: null, previous: null };
  private readonly listeners = new Set<() => void>();
  private config: TabsConfig = { onVaultLocked: () => {}, outputTap: null, asksAboutKeys: true, fillPrompts: null, shellHooks: null };
  /** Where the serve now running runs (ticket 115): null until it has said (fail closed). */
  private here: InventoryAt | null = null;
  /** Each tab's Inventory by its id, where its Session opened (or last started again): null while
   * the serve it opened on hasn't said, LOST once that serve was replaced before it did. */
  private readonly opened = new Map<number, InventoryAt | null | typeof LOST>();
  private readonly now: () => number;

  /** Held ids serve said logged in before their tab knew it held them. */
  private readonly loggedInEarly = new Set<string>();

  /** `now`: the clock the pre-auth window is timed with (tests move it). */
  constructor(backend: Backend, { now = Date.now }: { now?: () => number } = {}) {
    this.backend = backend;
    this.now = now;
    backend.onLoggedIn?.((held) => this.loggedIn(held));
  }

  /** serve says the Session holding `held` has logged in with its typed password (Q43). */
  private loggedIn(held: string) {
    const entry = this.entries.find((e) => e.tab.save?.held === held);
    if (!entry?.tab.save) {
      this.loggedInEarly.add(held);
      return;
    }
    entry.tab = { ...entry.tab, save: { ...entry.tab.save, loggedIn: true } };
    // The shell's first prompt (and title) usually arrived before serve said so.
    this.scanForName(entry, "");
    this.changed();
  }

  /** Tells serve to forget the password it holds for the tab's Session, unless it was saved. */
  private dropSave(entry: Entry) {
    const save = entry.tab.save;
    if (!save) return;
    entry.tab = { ...entry.tab, save: null };
    entry.run.saveScan = "";
    // One that doesn't reach serve is still forgotten there: at vault.lock, and 10 minutes after it
    // was typed (docs/app/security.md).
    if (save.saved === null) void this.backend.forgetTyped(save.held).catch(() => {});
  }

  /** Tells serve to forget what it holds for a Session no tab will offer to save. */
  private forgetHeld(session: SessionHandle) {
    // As dropSave: serve forgets it by itself at vault.lock or after 10 minutes.
    if (session.held !== undefined) void this.backend.forgetTyped(session.held).catch(() => {});
  }

  /** The user turned the offer down: serve forgets the password now. */
  dismissSave(id: number) {
    const entry = this.find(id);
    if (!entry?.tab.save) return;
    this.dropSave(entry);
    this.changed();
  }

  /** The tab's Session was saved as Host `name` (serve forgot the password itself). */
  saved(id: number, name: string) {
    const entry = this.find(id);
    if (!entry?.tab.save) return;
    entry.tab = { ...entry.tab, save: { ...entry.tab.save, saved: name } };
    this.changed();
  }

  /** Keeps the attempt's recent output, while a save may still be offered, and reads the box's name
   * from it once the Session has logged in. serve's `session.logged_in` usually lands after the
   * shell's first prompt, so the output before it is kept too (only the last SAVE_SCAN_LIMIT). */
  private scanForName(entry: Entry, text: string) {
    const save = entry.tab.save;
    if (save ? save.saved !== null : entry.session !== null) return;
    entry.run.scan(text);
    if (!save?.loggedIn) return;
    const user = entry.tab.quick?.to.user;
    const name = user ? hostnameIn(entry.run.saveScan, user) : null;
    if (name && name !== save.hostname) entry.tab = { ...entry.tab, save: { ...save, hostname: name } };
  }

  /** How the tabs work with what the app knows (TabsConfig); what isn't given stays as it was. */
  configure(config: Partial<TabsConfig>) {
    this.config = { ...this.config, ...config };
  }

  /** `:integrate`: sends the shell hook line to the tab's Session now; answers once a marked
   * prompt came back or didn't, or at once with why nothing was sent. */
  integrate(id: number): Promise<IntegrateResult> {
    const entry = this.find(id);
    const hooks = entry?.run.hooks;
    if (!entry || !hooks || !entry.session) return Promise.resolve("not-open");
    // Never at a password prompt (ticket 119): the line would be taken for the password.
    if (entry.tab.prompt !== null || entry.filling) return Promise.resolve("no-prompt");
    return hooks.integrate();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): TabsSnapshot => this.snap;

  private changed() {
    this.snap = { tabs: this.entries.map((e) => this.marked(e.tab)), active: this.active, previous: this.previous };
    for (const l of this.listeners) l();
  }

  /** serve is starting again (ticket 115): every tab opened so far counts as another Inventory's
   * until the new serve says where it runs (`setInventory`), and for good if it never does. */
  serveStarting() {
    for (const [id, where] of this.opened) if (where === null) this.opened.set(id, LOST);
    this.here = null;
    this.changed();
  }

  /** Where the serve now running runs (`inventories.list`'s `name` and `path`). Tabs opened on it
   * before it said count as opened there; the others stay marked until it's theirs. */
  setInventory(at: InventoryAt) {
    for (const [id, where] of this.opened) if (where === null) this.opened.set(id, at);
    this.here = at;
    this.changed();
  }

  /** The Inventory the tab's Session came from, while roster may run on another now; else null. */
  elsewhere(id: number): string | null {
    const where = this.opened.get(id);
    if (where === undefined || where === null) return null;
    if (where === LOST) return "another Inventory";
    if (this.here && this.here.name === where.name && this.here.path === where.path) return null;
    return where.name ?? where.path ?? "another Inventory";
  }

  /** The tab as the snapshot shows it: marked with its Inventory while that isn't roster's now. */
  private marked(tab: Tab): Tab {
    const from = this.elsewhere(tab.id);
    return from === null ? tab : { ...tab, label: `${tab.label} · ${from}`, from, prompt: null };
  }

  private find(id: number): Entry | undefined {
    return this.entries.find((e) => e.tab.id === id);
  }

  private setStatus(entry: Entry, status: TabStatus) {
    entry.tab = { ...entry.tab, status };
    this.changed();
  }

  private output(entry: Entry, data: Uint8Array) {
    entry.replay.push(data);
    entry.replayBytes += data.length;
    while (entry.replayBytes > REPLAY_LIMIT && entry.replay.length > 1) {
      entry.replayBytes -= entry.replay.shift()?.length ?? 0;
    }
    entry.sink?.(data);
  }

  /** A Quick Connect's Problem says so (its fixes then leave out the Host-only ones). */
  private mark(entry: Entry, problem: Problem): Problem {
    return entry.tab.quick ? { ...problem, quick: true } : problem;
  }

  /** Why the Session ended, from its exit code and output (null: it ended normally). */
  private classify(entry: Entry, exit: SessionExit): Problem | null {
    const problem = this.classifyExit(entry, exit);
    return problem && this.mark(entry, problem);
  }

  private classifyExit(entry: Entry, exit: SessionExit): Problem | null {
    if (exit.closed) return null;
    const host = entry.tab.host;
    const run = entry.run;
    if (!run.windowOpen()) {
      return exit.code === 255 ? classifyDrop({ host, tail: terminalTail(run.late, 30, { strippedAtCapture: true }) }) : null;
    }
    return classifyExit({ exitCode: exit.code, tail: terminalTail(run.preAuth, 30, { strippedAtCapture: true }), host, auth: entry.tab.auth });
  }

  /** "host", or "host (n)" with the smallest n no other tab to `host` uses. */
  private label(host: string, except: number | null): string {
    const taken = new Set(
      this.entries.filter((e) => e.tab.host === host && e.tab.id !== except).map((e) => e.tab.label),
    );
    let n = 1;
    const name = (i: number) => (i === 1 ? host : `${host} (${i})`);
    while (taken.has(name(n))) n++;
    return name(n);
  }

  /** Opens a Session to `host` in a new tab, which becomes the active one. Returns the tab id.
   * Any number of tabs may hold Sessions to the same Host. */
  open(host: string): number {
    const entry = this.add(host, null);
    this.start(entry);
    return entry.tab.id;
  }

  /** Opens a Quick Connect to `to` in a new tab, which becomes the active one (ticket 14): it
   * fetches the box's key and asks for it to be confirmed, with the password, before anything
   * connects (`connectQuick`). Returns the tab id. */
  openQuick(to: QuickTarget): number {
    const entry = this.add(formatQuickTarget(to), { to, id: null });
    this.askQuick(entry);
    return entry.tab.id;
  }

  /** A new tab, made the active one. */
  private add(host: string, quick: Tab["quick"]): Entry {
    const id = this.nextId++;
    const size = { ...this.lastSize };
    const entry: Entry = {
      tab: { id, host, label: this.label(host, null), status: { state: "connecting" }, auth: null, shell: false, attempt: 1, quick, save: null, prompt: null, cwd: null },
      session: null,
      closing: false,
      seq: 0,
      run: new Attempt(0, this.now, false),
      size,
      sentSize: size,
      replay: [],
      replayBytes: 0,
      sink: null,
      before: null,
      keyAsked: false,
      pending: [],
      filling: false,
      wiring: {
        attach: (sink) => this.attach(id, sink),
        onData: (data) => this.write(id, data),
        onResize: (s) => this.resize(id, s),
      },
    };
    this.entries.push(entry);
    this.opened.set(id, this.here);
    this.activate(id);
    this.changed();
    return entry;
  }

  /** Opens again every tab that was waiting for the vault (code 14). Each asks roster afresh, so
   * a password Session gets a new one-time token. */
  resumeAfterUnlock() {
    for (const entry of this.entries) {
      const s = entry.tab.status;
      if (s.state === "failed" && s.code === SessionRefusal.vaultLocked) this.reconnect(entry.tab.id);
    }
  }

  /**
   * Opens a new Session in a tab whose Session has ended or was refused, to the same Host or to
   * `host`. It asks roster again (`session.prepare`), so a fixed problem or a rebooted Host just
   * works. The old output stays above. Returns false (and does nothing) for a tab that's still
   * connecting or open.
   */
  reconnect(id: number, host?: string): boolean {
    const entry = this.find(id);
    if (!entry || isLive(entry.tab.status)) return false;
    // A Session from another Inventory (ticket 115): its Host's name means another Host here.
    if (host === undefined && this.elsewhere(id) !== null) return false;
    this.opened.set(id, this.here);
    const to = host ?? entry.tab.host;
    const label = to === entry.tab.host ? entry.tab.label : this.label(to, id);
    this.dropSave(entry);
    entry.before = entry.tab;
    entry.keyAsked = false;
    // A Quick Connect asks again, key and password (it keeps neither); to a Host, it's a Host's tab.
    const quick = host === undefined && entry.tab.quick ? { to: entry.tab.quick.to, id: null } : null;
    entry.tab = { ...entry.tab, host: to, label, status: { state: "connecting" }, shell: false, attempt: entry.tab.attempt + 1, quick, cwd: null };
    entry.pending = [];
    this.output(entry, encoder.encode(`\r\n\x1b[2m[reconnecting to ${to}…]\x1b[0m\r\n`));
    this.changed();
    if (quick) this.askQuick(entry);
    else this.start(entry);
    return true;
  }

  /** Asks the Backend for a Session for the tab (it's in the "connecting" state). `openSession`
   * runs `session.prepare` right before the spawn, so an askpass token is never stale. */
  private start(
    entry: Entry,
    open: (size: TermSize, events: SessionEvents, marks: string) => Promise<SessionHandle> = (size, events, marks) =>
      this.backend.openSession(entry.tab.host, size, events, undefined, marks),
  ) {
    // A Session from another Inventory (ticket 115) is never started again here: serve would start
    // one to its own Host of that name.
    const from = this.elsewhere(entry.tab.id);
    if (from !== null) {
      const message = `${entry.tab.host} came from ${from}: roster may run on another Inventory now, so it isn't started again here`;
      this.setStatus(entry, { state: "failed", message, code: null, problem: this.mark(entry, problemFromCallError(entry.tab.host, new Error(message))) });
      return;
    }
    entry.run.stop();
    const run = (entry.run = new Attempt(++entry.seq, this.now));
    const current = () => entry.seq === run.seq && !entry.closing;
    const { id } = entry.tab;
    entry.sentSize = { ...entry.size };
    // The attempt's token in roster's own shell marks (ticket 120): only its own shell ever knows it.
    const nonce = newNonce();
    const mask = new TokenMask(nonce);
    const fill = entry.tab.quick ? null : this.config.fillPrompts;
    const user = fill?.userOf(entry.tab.host) ?? null;
    const watch = (run.watch = fill && user !== null ? fill.watch(entry.size, user, nonce) : null);
    if (entry.tab.prompt !== null || entry.tab.hop) entry.tab = { ...entry.tab, prompt: null, hop: null };
    const hooks = (run.hooks = this.hooksFor(entry, run, current, nonce));
    open(entry.size, {
        output: (data) => {
          if (!current()) return;
          const before = entry.tab;
          const text = run.keepTail(data);
          this.scanForName(entry, text);
          if (watch) void watch.write(data).then(() => this.promptChanged(entry, watch));
          // The screen gets it unless the shell hooks hold it back; Plugins always get it as it came.
          const shown = hooks.output(data, text);
          if (shown) this.output(entry, shown);
          // A Quick Connect Session isn't on a Host of the Inventory: no Host to name.
          // Plugins never see the attempt's token: not the echoed hook line (its whole window stays
          // out), nor anything after that prints it.
          const echoed = this.config.outputTap ? pastEchoWindow(run, nonce, data) : null;
          const plugins = echoed ? pastFillWindow(run, echoed) : null;
          if (plugins && plugins.length > 0) this.tapOut(entry, id, mask, mask.mask(plugins));
          if (!entry.tab.shell && data.length > 0) entry.tab = { ...entry.tab, shell: true };
          if (entry.tab !== before) this.changed();
        },
        exit: (exit) => {
          if (!current()) return;
          entry.session = null;
          const rest = mask.flush();
          if (rest.length > 0) this.config.outputTap?.output(id, entry.tab.quick ? null : entry.tab.host, rest, entry.sentSize);
          run.stop();
          if (entry.tab.prompt !== null || entry.tab.hop) entry.tab = { ...entry.tab, prompt: null, hop: null };
          // A Session that ends without saving: serve forgets the password it held for it.
          this.dropSave(entry);
          if (this.find(id)) this.setStatus(entry, { state: "ended", exit, problem: this.classify(entry, exit) });
        },
      }, nonce)
      .then(
        (session) => {
          if (!current()) {
            // Closed or started again while it opened: nothing will ever save what serve holds for it.
            this.forgetHeld(session);
            // A Session nobody shows any more: if closing fails, its exit is ignored all the same.
            void session.close().catch(() => {});
            return;
          }
          // It may already have ended (ssh failing at once): then there's nothing to talk to, but
          // knowing the auth now tells a refused password from a refused key.
          const s = entry.tab.status;
          if (s.state === "ended") {
            this.forgetHeld(session);
            entry.tab = { ...entry.tab, auth: session.auth };
            this.setStatus(entry, { ...s, problem: this.classify(entry, s.exit) });
            return;
          }
          if (s.state !== "connecting") {
            this.forgetHeld(session);
            return;
          }
          entry.session = session;
          // Windows' ConPTY (ticket 162): the watch offers only the fills the core makes there.
          if (session.conpty && watch) {
            watch.conptyRules(session.fillUser ?? null);
            this.promptChanged(entry, watch);
          }
          // A write that fails is a Session that's ending: its exit says why.
          for (const data of entry.pending.splice(0)) void session.write(data).catch(() => {});
          const quick = entry.tab.quick && { ...entry.tab.quick, id: session.quick ?? null };
          const held = session.held;
          const save: SaveOffer | null =
            held === undefined ? null : { held, loggedIn: this.loggedInEarly.delete(held), hostname: null, saved: null };
          entry.tab = { ...entry.tab, auth: session.auth, quick, save };
          if (save) this.scanForName(entry, "");
          else run.saveScan = "";
          this.setStatus(entry, { state: "open" });
          this.sendSize(entry);
        },
        (e: unknown) => {
          if (!current()) return;
          if (e instanceof BackendCallError && e.code === SessionRefusal.hostKeyUnknown && this.config.asksAboutKeys && !entry.keyAsked) {
            this.askAboutKey(entry);
            return;
          }
          if (e instanceof BackendCallError && e.code === SessionRefusal.passwordNeeded && !entry.tab.quick) {
            const d = e.data ?? {};
            const user = typeof d["user"] === "string" ? d["user"] : "";
            const address = typeof d["address"] === "string" ? d["address"] : "";
            const port = typeof d["port"] === "number" ? d["port"] : 22;
            this.setStatus(entry, { state: "password", user, address, port });
            return;
          }
          this.refused(entry, e);
        },
      );
  }

  /** The attempt's shell hooks: they write only to its own Session, show only while it's current. */
  private hooksFor(entry: Entry, run: Attempt, current: () => boolean, nonce: string): ShellHooks {
    return new ShellHooks({
      write: (line) => {
        // Never while a password prompt is up or being filled (ticket 119): the hook line would
        // be taken for the password. The hooks try again at their next idle prompt.
        if (!current() || !entry.session || entry.tab.prompt !== null || entry.filling) return false;
        // Nor to a Session from another Inventory (ticket 115).
        if (this.elsewhere(entry.tab.id) !== null) return false;
        // Its token proves the Session's own shell only if the line can only have gone there.
        run.watch?.hookSent();
        run.watch?.typed(line);
        run.echoWindow = { tail: new Uint8Array(0) };
        void entry.session.write(line).catch(() => {});
        return true;
      },
      show: (data) => {
        if (current()) this.output(entry, data);
      },
      cwd: (path) => {
        if (!current() || entry.tab.cwd === path) return;
        entry.tab = { ...entry.tab, cwd: path };
        this.changed();
      },
      enabled: () => (this.config.shellHooks?.on(entry.tab) ?? false) && this.elsewhere(entry.tab.id) === null,
      // No marked prompt came: what was printed meanwhile stays out of Plugins' sight (it held the
      // echo); what comes next goes to them.
      settled: () => {
        if (current()) run.echoWindow = null;
      },
    }, nonce, this.config.shellHooks?.screen?.(entry.size) ?? null);
  }

  /** The tab's Session couldn't start: roster refused, or a step before it failed. */
  private refused(entry: Entry, e: unknown) {
    const code = e instanceof BackendCallError ? e.code : null;
    const problem = this.mark(entry, problemFromCallError(entry.tab.host, e));
    if (code === SessionRefusal.vaultLocked) {
      const message = "The vault is locked. Unlock it and this Session opens.";
      this.setStatus(entry, { state: "failed", message, code, problem: { ...problem, message } });
      this.config.onVaultLocked();
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    this.setStatus(entry, { state: "failed", message, code, problem });
  }

  /** A check that a step started now still belongs to the tab: not closed, cancelled or started
   * again since. */
  private turn(entry: Entry): () => boolean {
    const seq = entry.seq;
    return () => entry.seq === seq && !entry.closing;
  }

  /** Starts the Session again in the same tab (after its key was trusted or turned out recorded). */
  private restart(entry: Entry) {
    this.setStatus(entry, { state: "connecting" });
    this.start(entry);
  }

  /** roster has no key recorded for the Host (ticket 36): fetch the one it offers and ask. A key
   * that turns out recorded meanwhile isn't asked about: the Session starts again, and ssh checks
   * it strictly (a different one is refused, Q44). */
  private askAboutKey(entry: Entry) {
    entry.keyAsked = true;
    const current = this.turn(entry);
    const { host } = entry.tab;
    this.setStatus(entry, { state: "asking", key: null, trusting: false });
    this.backend.scanHostKey(host).then(
      (key) => {
        if (!current()) return;
        if (key.recorded !== "none") return this.restart(entry);
        this.setStatus(entry, { state: "asking", key, trusting: false });
      },
      (e: unknown) => {
        if (current()) this.refused(entry, e);
      },
    );
  }

  /** A Quick Connect (ticket 14): fetch the key the box offers and ask about it, with the password.
   * A key that differs from one roster recorded for the address is never asked about (Q44). */
  private askQuick(entry: Entry) {
    const quick = entry.tab.quick;
    if (!quick) return;
    entry.seq++; // a key fetched for an earlier attempt is no longer asked about
    const current = this.turn(entry);
    const { address, port } = quick.to;
    this.setStatus(entry, { state: "asking", key: null, trusting: false });
    this.backend.scanKey(address, port).then(
      (key) => {
        if (!current()) return;
        if (key.recorded === "changed") {
          const message = `${entry.tab.host}'s host key changed - not connecting`;
          return this.refused(
            entry,
            new BackendCallError(message, HostKeyError.changed, {
              offered: key.fingerprint,
              fix: "Don't accept it blindly: compare the new fingerprint with the box's console or its owner. If the change is expected (a reinstall), delete its line in ~/.ssh/roster_known_hosts.",
            }),
          );
        }
        this.setStatus(entry, { state: "asking", key: { ...key, host: entry.tab.host }, trusting: false });
      },
      (e: unknown) => {
        if (current()) this.refused(entry, e);
      },
    );
  }

  /** The user confirmed the Quick Connect's key and typed the password (empty: log in with this
   * Box's keys). It goes straight to the Backend, once; the tab keeps no copy. With `save` ("Save
   * to vault", ticket 15), serve holds it until the Session has logged in and it's saved. */
  connectQuick(id: number, password: string, save = false) {
    const entry = this.find(id);
    const s = entry?.tab.status;
    const quick = entry?.tab.quick;
    if (!entry || !quick || s?.state !== "asking" || !s.key || s.trusting) return;
    const to: QuickConnect = { ...quick.to, fingerprint: s.key.fingerprint };
    const typed = password === "" ? null : password;
    this.setStatus(entry, { state: "connecting" });
    const options = save && typed !== null ? { save: true } : {};
    this.start(entry, (size, events) => this.backend.openQuickSession(to, typed, size, events, options));
  }

  /** The user typed the password for an `auth: prompt` Host (ticket 16). It goes straight to the
   * Backend, once; the tab keeps no copy. With `save`, roster holds it until the Session has logged
   * in and it's saved. */
  connectPrompted(id: number, password: string, save = false) {
    const entry = this.find(id);
    if (!entry || entry.tab.status.state !== "password" || password === "") return;
    const typed = save ? { password, save: true } : { password };
    this.setStatus(entry, { state: "connecting" });
    this.start(entry, (size, events, marks) => this.backend.openSession(entry.tab.host, size, events, typed, marks));
  }

  /** The user trusts the key the tab asks about: roster records it (if the Host still offers
   * exactly that key) and the Session opens. */
  trustKey(id: number) {
    const entry = this.find(id);
    const s = entry?.tab.status;
    if (!entry || entry.tab.quick || s?.state !== "asking" || !s.key || s.trusting) return;
    const current = this.turn(entry);
    this.setStatus(entry, { ...s, trusting: true });
    this.backend.trustHostKey(entry.tab.host, s.key.fingerprint).then(
      () => {
        if (current()) this.restart(entry);
      },
      (e: unknown) => {
        if (current()) this.refused(entry, e);
      },
    );
  }

  /** The user doesn't trust it: nothing is recorded and nothing connects. A new tab closes; a
   * reconnected one goes back to how it was. */
  cancelKey(id: number) {
    const entry = this.find(id);
    const s = entry?.tab.status;
    if (!entry || !(s?.state === "password" || (s?.state === "asking" && !s.trusting))) return;
    if (!entry.before) return this.close(id);
    entry.seq++; // a key still being fetched is no longer asked about
    entry.tab = entry.before;
    entry.before = null;
    this.changed();
  }

  /** Closes the tab and ends its Session (kills ssh). */
  close(id: number) {
    const i = this.entries.findIndex((e) => e.tab.id === id);
    const entry = this.entries[i];
    if (!entry) return;
    entry.closing = true;
    entry.run.stop();
    this.dropSave(entry);
    entry.sink = null;
    void entry.session?.close().catch(() => {});
    entry.session = null;
    this.entries.splice(i, 1);
    this.opened.delete(id);
    if (this.previous === id) this.previous = null;
    if (this.active === id) {
      const next = this.entries[Math.min(i, this.entries.length - 1)];
      this.active = next ? next.tab.id : null;
      if (this.previous === this.active) this.previous = null;
    }
    this.changed();
  }

  closeAll() {
    for (const e of [...this.entries]) this.close(e.tab.id);
  }

  select(id: number) {
    if (!this.find(id) || this.active === id) return;
    this.activate(id);
    this.changed();
  }

  private activate(id: number) {
    if (this.active !== null && this.active !== id) this.previous = this.active;
    this.active = id;
  }

  /** Selects the tab `delta` places after the active one (negative: before), wrapping around. */
  selectRelative(delta: number) {
    const n = this.entries.length;
    if (n === 0) return;
    const i = this.entries.findIndex((e) => e.tab.id === this.active);
    const next = this.entries[(((i + delta) % n) + n) % n];
    if (next) this.select(next.tab.id);
  }

  /** Selects the `n`th tab, counting from 1; a number past the end does nothing. */
  selectNth(n: number) {
    const entry = this.entries[n - 1];
    if (entry) this.select(entry.tab.id);
  }

  /** Stable callbacks for the tab's terminal (so it never re-attaches on a re-render). */
  wiring(id: number): TerminalWiring | undefined {
    return this.find(id)?.wiring;
  }

  /** Routes the tab's output to `sink`, starting with what it printed so far. Returns detach. */
  attach(id: number, sink: Sink): () => void {
    const entry = this.find(id);
    if (!entry) return () => {};
    for (const chunk of entry.replay) sink(chunk);
    entry.sink = sink;
    return () => {
      if (entry.sink === sink) entry.sink = null;
    };
  }

  /**
   * Fills the password prompt the tab's Session shows from the vault (ticket 119, decision Q129):
   * the user pressed the fill key. Only the prompt line goes to the Backend; the core asks serve
   * for the Host's password and types it into the PTY if the prompt doesn't echo, so nothing of it
   * reaches the frontend. Resolves with the Host's name; rejects with why it didn't fill: no prompt,
   * the marks say it may be another Host's, a Quick Connect, or the Backend's refusal (a locked
   * vault also shows the lock screen first, the existing unlock flow; press the key again after).
   */
  async fill(id: number): Promise<string> {
    const entry = this.find(id);
    if (!entry) throw new Error("No Session to fill");
    const from = this.elsewhere(id);
    if (from !== null) {
      throw new Error(`Won't fill: ${entry.tab.label}'s Session came from ${from}, and roster may run on another Inventory now. Type that password yourself.`);
    }
    const { session } = entry;
    // What the watch says now, not what the tab last showed: a key typed since may have changed it.
    const run = entry.run;
    if (run.watch) this.promptChanged(entry, run.watch);
    const prompt = run.watch ? entry.tab.prompt : null;
    if (!session || entry.tab.status.state !== "open" || prompt === null) {
      throw new Error(`No password prompt in ${entry.tab.label}'s Session right now`);
    }
    if (!session.fill) throw new Error(`${entry.tab.label} is a Quick Connect: roster has no Login of it to fill`);
    const { elsewhere } = prompt;
    if (elsewhere !== null) {
      throw new Error(`Won't fill: ${elsewhere}. Type that password yourself.`);
    }
    if (entry.filling) throw new Error("Already filling this prompt");
    entry.filling = true;
    // Spent while it's tried: no offer, and no second press, until a new prompt shows. A refusal
    // from roster serve (a code: the vault, the prompt, the Host) typed nothing, so the prompt is
    // offered again; the core's own refusals (no code) typed its probe, so it stays spent.
    const watch = run.watch;
    watch?.spent();
    entry.tab = { ...entry.tab, prompt: null };
    this.changed();
    // What the Session prints from here until its next line break stays out of Plugins' sight:
    // with sudo's pwfeedback that's a `*` per key of the password (ticket 154).
    run.fillWindow = { dropped: 0 };
    try {
      // A nested ssh's prompt names the Host roster resolved it to (ticket 120); the core checks the
      // Session printed it, and serve that the Host is still what it was resolved to.
      return (await session.fill(prompt.line, prompt.hop ?? undefined)).host;
    } catch (e) {
      // Nothing was typed but at most the probe: what comes next is the Session's own.
      run.fillWindow = null;
      if (watch && e instanceof BackendCallError && typeof e.code === "number") {
        watch.unspent();
        this.promptChanged(entry, watch);
      }
      if (e instanceof BackendCallError && e.code === SessionRefusal.vaultLocked) {
        this.config.onVaultLocked();
        throw new BackendCallError("The vault is locked. Unlock it, then press the fill key again.", e.code, e.data);
      }
      throw e;
    } finally {
      entry.filling = false;
    }
  }

  /** Keystrokes for the tab's Session; held until it's open, dropped once it has ended. */
  write(id: number, data: string) {
    const entry = this.find(id);
    if (!entry) return;
    const { hooks, watch } = entry.run;
    hooks?.typed(data);
    // A nested ssh's prompt after you've typed into it may not be its login's (ticket 120).
    if (hasTyping(data) && watch) {
      watch.typed(data);
      this.promptChanged(entry, watch);
    }
    // A write that fails is a Session that's ending: its exit says why.
    if (entry.session) void entry.session.write(data).catch(() => {});
    else if (entry.tab.status.state === "connecting") entry.pending.push(data);
  }

  /** The tab's terminal has this size now; the Session hears about it once it's open. */
  resize(id: number, size: TermSize) {
    this.lastSize = { ...size };
    const entry = this.find(id);
    if (!entry) return;
    entry.size = { ...size };
    this.sendSize(entry);
  }

  private sendSize(entry: Entry) {
    const { size, sentSize, session } = entry;
    if (!session || (size.cols === sentSize.cols && size.rows === sentSize.rows)) return;
    entry.sentSize = { ...size };
    entry.run.watch?.resize(size);
    entry.run.hooks?.resize(size);
    // A resize that fails is a Session that's ending; the next one is sent whole anyway.
    void session.resize(size).catch(() => {});
  }

  /** Hands Plugins `data`; output the mask holds back goes after 50 ms if nothing follows it. */
  private tapOut(entry: Entry, id: number, mask: TokenMask, data: Uint8Array) {
    const host = entry.tab.quick ? null : entry.tab.host;
    if (data.length > 0) this.config.outputTap?.output(id, host, data, entry.sentSize);
    if (!mask.holding()) return;
    setTimeout(() => {
      if (!mask.holding() || !this.find(id)) return;
      const rest = mask.flush();
      if (rest.length > 0) this.config.outputTap?.output(id, host, rest, entry.sentSize);
    }, 50);
  }

  /** What `watch` says of the prompt now, onto the tab, if it's still the tab's watch. */
  private promptChanged(entry: Entry, watch: PromptWatch) {
    if (entry.run.watch !== watch || !this.find(entry.tab.id)) return;
    const prompt = watch.prompt();
    const hop = watch.hop();
    const was = entry.tab.prompt;
    const wasHop = entry.tab.hop ?? null;
    const samePrompt =
      prompt?.line === was?.line &&
      prompt?.elsewhere === was?.elsewhere &&
      prompt?.marked === was?.marked &&
      prompt?.kind === was?.kind &&
      prompt?.hop?.host === was?.hop?.host;
    const sameHop = hop?.to === wasHop?.to && hop?.known === wasHop?.known;
    if (samePrompt && sameHop) return;
    entry.tab = { ...entry.tab, prompt, hop };
    this.changed();
  }
}

/** What of `data` Plugins may get while roster's hook line may be echoing: nothing until the
 * attempt's first own prompt mark (`133;A;roster=TOKEN`), then from that mark on. */
function pastEchoWindow(run: Attempt, nonce: string, data: Uint8Array): Uint8Array | null {
  const window = run.echoWindow;
  if (!window) return data;
  const seen = new Uint8Array(window.tail.length + data.length);
  seen.set(window.tail);
  seen.set(data, window.tail.length);
  const at = indexOfBytes(seen, `\x1b]133;A;roster=${nonce}`);
  if (at < 0) {
    window.tail = seen.slice(-64);
    return null;
  }
  run.echoWindow = null;
  return seen.subarray(at);
}

/** What of `data` Plugins may get while a fill's window is open: nothing before the Session's
 * next line break (`\n`), then from that line break on (ticket 154). */
function pastFillWindow(run: Attempt, data: Uint8Array): Uint8Array | null {
  const window = run.fillWindow;
  if (!window) return data;
  const at = data.indexOf(0x0a);
  if (at < 0) {
    window.dropped += data.length;
    if (window.dropped > FILL_WINDOW_LIMIT) run.fillWindow = null;
    return null;
  }
  run.fillWindow = null;
  return data.subarray(at);
}

/** Where the ASCII `needle` first starts in `bytes`, or -1. */
function indexOfBytes(bytes: Uint8Array, needle: string): number {
  const n = new TextEncoder().encode(needle);
  const first = n[0] ?? 0;
  for (let i = bytes.indexOf(first); i >= 0 && i + n.length <= bytes.length; i = bytes.indexOf(first, i + 1)) {
    let j = 1;
    while (j < n.length && bytes[i + j] === n[j]) j++;
    if (j === n.length) return i;
  }
  return -1;
}
