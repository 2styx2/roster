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
/**
 * The pre-auth window: what a Session prints before it has logged in is ssh's (and roster
 * askpass's) own, and that's all classifyExit may read. Once logged in, the output is the Host's,
 * where a nested ssh's error or a forged `roster askpass:` line would look just like ours. ssh
 * doesn't say when the login succeeded, so the window closes after PRE_AUTH_MS (roster's ssh
 * config has ConnectTimeout 10, and askpass answers in a few seconds) or PRE_AUTH_BYTES of output
 * (ssh's own messages are short), whichever comes first. A 255 after that is a dropped Session
 * (row 20), told apart only by ssh's drop lines in the last output.
 */
const PRE_AUTH_MS = 30_000;
const PRE_AUTH_BYTES = 8 * 1024;
/** The latest attempt's last output after the window, for classifyDrop. */
const LATE_LIMIT = 4 * 1024;

type Sink = (data: Uint8Array) => void;

/** What a tab's terminal is wired to; the same object for the tab's whole life. */
/** Where Plugins hear the Sessions (setOutputTap): their output, and each resize sent to one. */
export interface OutputTap {
  output(id: number, host: string | null, data: Uint8Array): void;
  resized(id: number): void;
}

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
  /** Counts the Session starts in this tab, so a late event from an earlier one is ignored. */
  attempt: number;
  size: TermSize;
  /** The size the Session was last told about. */
  sentSize: TermSize;
  replay: Uint8Array[];
  replayBytes: number;
  /** The current attempt's output (decoded) inside the pre-auth window, for classifyExit. */
  preAuth: string;
  preAuthBytes: number;
  /** When the current attempt started, or null once its pre-auth window has closed. */
  windowFrom: number | null;
  /** The current attempt's last output after the window (decoded), for classifyDrop. */
  late: string;
  /** Decodes this tab's output for `preAuth`, `late` and `saveScan`. Its own, and new each attempt: a streaming decoder
   * holds a character split across chunks, which must not end up in another tab's text. */
  decoder: TextDecoder;
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
  /** The attempt's last output while a save may be offered: where the box's name is read from. */
  saveScan: string;
}

/** How much of the output after the login is searched for the box's name. */
const SAVE_SCAN_LIMIT = 4 * 1024;

export class Tabs {
  private readonly backend: Backend;
  private entries: Entry[] = [];
  private active: number | null = null;
  private previous: number | null = null;
  private nextId = 1;
  private lastSize: TermSize = { cols: 80, rows: 24 };
  private snap: TabsSnapshot = { tabs: [], active: null, previous: null };
  private readonly listeners = new Set<() => void>();
  private onVaultLocked: () => void = () => {};
  /** Sees every Session's output as it arrives (Plugins with terminal.read, ticket 23). */
  private outputTap: OutputTap | null = null;
  private asksAboutKeys = true;
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
    entry.saveScan = "";
    if (save.saved === null) void this.backend.forgetTyped(save.held).catch(() => {});
  }

  /** Tells serve to forget what it holds for a Session no tab will offer to save. */
  private forgetHeld(session: SessionHandle) {
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
    if (text) entry.saveScan = (entry.saveScan + text).slice(-SAVE_SCAN_LIMIT);
    if (!save?.loggedIn) return;
    const user = entry.tab.quick?.to.user;
    const name = user ? hostnameIn(entry.saveScan, user) : null;
    if (name && name !== save.hostname) entry.tab = { ...entry.tab, save: { ...save, hostname: name } };
  }

  /** Called when a password Host's vault turns out to be locked (`session.prepare` code 14): the
   * app shows the lock screen, then calls `resumeAfterUnlock`. */
  setVaultLockedHandler(handler: () => void) {
    this.onVaultLocked = handler;
  }

  /** Hands every Session's output to `tap` too (null stops it): what Plugins with terminal.read
   * get. Only output: what's typed into a Session never goes there. It also hears each resize
   * sent to a Session, after which the Session may print its screen again (ticket 73). */
  setOutputTap(tap: OutputTap | null) {
    this.outputTap = tap;
  }

  /** Whether roster can be asked about a Host's key (API 11, ticket 36). Without it, roster's "no
   * host key recorded" (44) is a refusal like any other. */
  setAsksAboutKeys(asks: boolean) {
    this.asksAboutKeys = asks;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): TabsSnapshot => this.snap;

  private changed() {
    this.snap = { tabs: this.entries.map((e) => e.tab), active: this.active, previous: this.previous };
    for (const l of this.listeners) l();
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

  /** Closes the attempt's pre-auth window once its time is up. */
  private windowOpen(entry: Entry): boolean {
    if (entry.windowFrom !== null && this.now() - entry.windowFrom >= PRE_AUTH_MS) entry.windowFrom = null;
    return entry.windowFrom !== null;
  }

  /** Keeps the attempt's output for classifyExit / classifyDrop; returns it decoded (the tab's
   * streaming decoder, so a character split across chunks comes out whole). */
  private keepTail(entry: Entry, data: Uint8Array): string {
    const text = entry.decoder.decode(data, { stream: true });
    if (this.windowOpen(entry) && entry.preAuthBytes + data.length <= PRE_AUTH_BYTES) {
      entry.preAuth += text;
      entry.preAuthBytes += data.length;
      return text;
    }
    entry.windowFrom = null;
    entry.late += text;
    if (entry.late.length > LATE_LIMIT) entry.late = entry.late.slice(-LATE_LIMIT);
    return text;
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
    if (!this.windowOpen(entry)) {
      return exit.code === 255 ? classifyDrop({ host, tail: terminalTail(entry.late) }) : null;
    }
    return classifyExit({ exitCode: exit.code, tail: terminalTail(entry.preAuth), host, auth: entry.tab.auth });
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
      tab: { id, host, label: this.label(host, null), status: { state: "connecting" }, auth: null, shell: false, attempt: 1, quick, save: null },
      session: null,
      closing: false,
      attempt: 0,
      size,
      sentSize: size,
      replay: [],
      replayBytes: 0,
      preAuth: "",
      preAuthBytes: 0,
      windowFrom: null,
      late: "",
      decoder: new TextDecoder(),
      sink: null,
      before: null,
      keyAsked: false,
      pending: [],
      saveScan: "",
      wiring: {
        attach: (sink) => this.attach(id, sink),
        onData: (data) => this.write(id, data),
        onResize: (s) => this.resize(id, s),
      },
    };
    this.entries.push(entry);
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
    const state = entry?.tab.status.state;
    if (!entry || (state !== "ended" && state !== "failed")) return false;
    const to = host ?? entry.tab.host;
    const label = to === entry.tab.host ? entry.tab.label : this.label(to, id);
    this.dropSave(entry);
    entry.before = entry.tab;
    entry.keyAsked = false;
    // A Quick Connect asks again, key and password (it keeps neither); to a Host, it's a Host's tab.
    const quick = host === undefined && entry.tab.quick ? { to: entry.tab.quick.to, id: null } : null;
    entry.tab = { ...entry.tab, host: to, label, status: { state: "connecting" }, shell: false, attempt: entry.tab.attempt + 1, quick };
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
    open: (size: TermSize, events: SessionEvents) => Promise<SessionHandle> = (size, events) =>
      this.backend.openSession(entry.tab.host, size, events),
  ) {
    const attempt = ++entry.attempt;
    const current = () => entry.attempt === attempt && !entry.closing;
    const { id } = entry.tab;
    entry.sentSize = { ...entry.size };
    entry.preAuth = "";
    entry.preAuthBytes = 0;
    entry.windowFrom = this.now();
    entry.late = "";
    entry.decoder = new TextDecoder();
    entry.saveScan = "";
    open(entry.size, {
        output: (data) => {
          if (!current()) return;
          const before = entry.tab;
          const text = this.keepTail(entry, data);
          this.scanForName(entry, text);
          this.output(entry, data);
          // A Quick Connect Session isn't on a Host of the Inventory: no Host to name.
          this.outputTap?.output(id, entry.tab.quick ? null : entry.tab.host, data);
          if (!entry.tab.shell && data.length > 0) entry.tab = { ...entry.tab, shell: true };
          if (entry.tab !== before) this.changed();
        },
        exit: (exit) => {
          if (!current()) return;
          entry.session = null;
          // A Session that ends without saving: serve forgets the password it held for it.
          this.dropSave(entry);
          if (this.find(id)) this.setStatus(entry, { state: "ended", exit, problem: this.classify(entry, exit) });
        },
      })
      .then(
        (session) => {
          if (!current()) {
            // Closed or started again while it opened: nothing will ever save what serve holds for it.
            this.forgetHeld(session);
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
          for (const data of entry.pending.splice(0)) void session.write(data).catch(() => {});
          const quick = entry.tab.quick && { ...entry.tab.quick, id: session.quick ?? null };
          const held = session.held;
          const save: SaveOffer | null =
            held === undefined ? null : { held, loggedIn: this.loggedInEarly.delete(held), hostname: null, saved: null };
          entry.tab = { ...entry.tab, auth: session.auth, quick, save };
          if (save) this.scanForName(entry, "");
          else entry.saveScan = "";
          this.setStatus(entry, { state: "open" });
          this.sendSize(entry);
        },
        (e: unknown) => {
          if (!current()) return;
          if (e instanceof BackendCallError && e.code === SessionRefusal.hostKeyUnknown && this.asksAboutKeys && !entry.keyAsked) {
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

  /** The tab's Session couldn't start: roster refused, or a step before it failed. */
  private refused(entry: Entry, e: unknown) {
    const code = e instanceof BackendCallError ? e.code : null;
    const problem = this.mark(entry, problemFromCallError(entry.tab.host, e));
    if (code === SessionRefusal.vaultLocked) {
      const message = "The vault is locked. Unlock it and this Session opens.";
      this.setStatus(entry, { state: "failed", message, code, problem: { ...problem, message } });
      this.onVaultLocked();
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    this.setStatus(entry, { state: "failed", message, code, problem });
  }

  /** A check that a step started now still belongs to the tab: not closed, cancelled or started
   * again since. */
  private turn(entry: Entry): () => boolean {
    const attempt = entry.attempt;
    return () => entry.attempt === attempt && !entry.closing;
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
    entry.attempt++; // a key fetched for an earlier attempt is no longer asked about
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
    this.start(entry, (size, events) => this.backend.openSession(entry.tab.host, size, events, typed));
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
    entry.attempt++; // a key still being fetched is no longer asked about
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
    this.dropSave(entry);
    entry.sink = null;
    void entry.session?.close().catch(() => {});
    entry.session = null;
    this.entries.splice(i, 1);
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

  /** Keystrokes for the tab's Session; held until it's open, dropped once it has ended. */
  write(id: number, data: string) {
    const entry = this.find(id);
    if (!entry) return;
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
    this.outputTap?.resized(entry.tab.id);
    void session.resize(size).catch(() => {});
  }
}
