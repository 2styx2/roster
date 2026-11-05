// The real Backend: Tauri commands in src-tauri/src/lib.rs, which drive `roster serve` through
// roster-core. A serve method the app calls as it is goes through the one `serve_call` command
// (roster-core serve_api.rs lists them); the others are where the core adds something. Only
// imported when running inside Tauri (see index.ts).
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CallErrorWire, OpenedSession } from "../config/core.gen";
import {
  BackendCallError,
  BackendStartError,
  type Backend,
  type BackendInfo,
  type BackendProblem,
  type CallErrorData,
  type Host,
  type AddHostParams,
  type HostAdd,
  type HostChanges,
  type BoxCheck,
  type CheckStarted,
  type HostCheck,
  type HostKeyScan,
  type HostKeyTrust,
  type HostList,
  type QuickConnect,
  type QuickSave,
  type QuickSaveParams,
  type SaveLogin,
  type SaveLoginParams,
  type VaultConfigured,
  type TypedPassword,
  type HostUpdate,
  type InventoryChanged,
  type JobProgress,
  type InventoryReload,
  type Inventories,
  type InventoryUsed,
  type NewInventory,
  type PendingChanges,
  type PackageChecked,
  type PackageStatus,
  type OpenSession,
  type PluginReply,
  type PublishResult,
  type PullResult,
  type SaveTargets,
  type VaultItemFields,
  type SignedOut,
  type ScannedKey,
  type ProviderStatus,
  type SignInStep,
  type VaultStatus,
  type SessionEvents,
  type SessionExit,
  type SessionHandle,
  type SiteRequests,
  type PluginData,
  type TermSize,
} from "./types";

function isProblem(e: unknown): e is BackendProblem {
  return typeof e === "object" && e !== null && "hint" in e && "message" in e && "kind" in e;
}

function callError(e: unknown): BackendCallError {
  if (typeof e === "object" && e !== null && "kind" in e) {
    const w = e as CallErrorWire;
    switch (w.kind) {
      case "rpc": {
        const data = typeof w.data === "object" && w.data !== null ? (w.data as CallErrorData) : null;
        return new BackendCallError(w.message, w.code, data);
      }
      case "exited":
        return new BackendCallError(`The backend exited (code ${w.code ?? "?"}). ${w.stderr}`.trim(), null, null, true);
      case "timeout":
        return new BackendCallError("The backend didn't answer in time.", null, null, true, true);
      case "io":
        return new BackendCallError(w.message);
    }
  }
  return new BackendCallError(String(e));
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw callError(e);
  }
}

/** One Session's channel: raw output bytes (an ArrayBuffer), then `{exit}` as JSON. */
type SessionMessage = ArrayBuffer | Uint8Array | number[] | { exit: SessionExit };

function sessionChannel(events: SessionEvents): Channel<SessionMessage> {
  const ch = new Channel<SessionMessage>();
  ch.onmessage = (m) => {
    if (m instanceof ArrayBuffer) events.output(new Uint8Array(m));
    else if (m instanceof Uint8Array) events.output(m);
    else if (Array.isArray(m)) events.output(Uint8Array.from(m));
    else events.exit(m.exit);
  };
  return ch;
}

async function openSession(host: string, size: TermSize, events: SessionEvents, typed?: TypedPassword, marks?: string): Promise<SessionHandle> {
  // A typed password (ticket 16) goes once to serve's stdin, inside session.prepare's request.
  const { id, auth, held, conpty, user } = await call<OpenedSession>("session_open", {
    host,
    password: typed?.password ?? null,
    save: typed?.save === true,
    marks: marks ?? null,
    cols: size.cols,
    rows: size.rows,
    events: sessionChannel(events),
  });
  return {
    id,
    auth,
    ...(held === undefined ? {} : { held }),
    ...(conpty ? { conpty } : {}),
    ...(user === undefined ? {} : { fillUser: user }),
    write: (data) => call("session_write", { id, data }),
    resize: ({ cols, rows }) => call("session_resize", { id, cols, rows }),
    close: () => call("session_close", { id }),
    // Only the prompt line goes; the password stays in the core (ticket 119).
    fill: (prompt, hop) => call<{ host: string }>("session_fill", { id, prompt, hop: hop ?? null }),
  };
}

/** A Quick Connect (ticket 14): the typed password goes once to serve's stdin, inside quick.prepare's request. */
async function openQuickSession(
  to: QuickConnect,
  password: string | null,
  size: TermSize,
  events: SessionEvents,
  options: { save?: boolean } = {},
): Promise<SessionHandle> {
  const { id, auth, quick, held } = await call<OpenedSession>("quick_session_open", {
    to,
    password,
    save: options.save === true,
    cols: size.cols,
    rows: size.rows,
    events: sessionChannel(events),
  });
  return {
    id,
    auth,
    ...(quick === undefined ? {} : { quick }),
    ...(held === undefined ? {} : { held }),
    write: (data) => call("session_write", { id, data }),
    resize: ({ cols, rows }) => call("session_resize", { id, cols, rows }),
    close: () => call("session_close", { id }),
  };
}

/** One open Session as plugin_sessions takes it (mod.rs's OpenSession). */
function openSessionArg(o: OpenSession) {
  return { session: o.session, host: o.host, cwd: o.cwd ?? null };
}

/** A serve method the core passes on as it is (`serve_call`). Secrets in `params` (a typed
 * password, a vault answer) go once to serve's stdin and are wiped there. */
function serve<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return call<T>("serve_call", { method, params });
}

export function tauriBackend(): Backend {
  return {
    async connect(options) {
      try {
        return await invoke<BackendInfo>("backend_connect", { restart: options?.restart ?? false });
      } catch (e) {
        if (isProblem(e)) throw new BackendStartError(e);
        throw callError(e);
      }
    },
    listHosts: () => serve<HostList>("hosts.list"),
    // `settled` (serve API 20) only when true, so an older serve gets what it always did.
    getHost: (name, options) => serve<Host>("host.get", options?.settled === true ? { name, settled: true } : { name }),
    vaultStatus: () => serve<VaultStatus>("vault.status"),
    unlockVault: (password) => serve<ProviderStatus>("vault.unlock", { password }),
    lockVault: () => serve<{ locked: string[] }>("vault.lock"),
    signOut: () => serve<SignedOut>("vault.logout"),
    configureVault: (settings) => serve<VaultConfigured>("vault.configure", { ...settings }),
    saveTargets: () => serve<SaveTargets>("vault.targets"),
    vaultItemFields: (item, provider) => serve<VaultItemFields>("vault.item_fields", { item, ...(provider ? { provider } : {}) }),
    signIn: (start) => serve<SignInStep>("vault.login", { action: "start", ...start }),
    signInAnswer: (login, answer) => serve<SignInStep>("vault.login", { action: "answer", login, ...answer }),
    signInCancel: async () => {
      await serve("vault.login", { action: "cancel" }).catch(() => {});
    },
    openSession,
    openQuickSession,
    checkHost: (host, onStarted) => {
      const started = new Channel<CheckStarted>();
      if (onStarted) started.onmessage = onStarted;
      return call<HostCheck>("host_check", { host, started });
    },
    stopCheck: (job) => call<{ stopping: boolean }>("host_check_stop", { job }).then((r) => r.stopping),
    checkBox: () => serve<BoxCheck>("box.check"),
    listJobs: () => serve<{ jobs: JobProgress[] }>("jobs.list").then((r) => r.jobs),
    pullInventory: () => serve<PullResult>("inventory.pull"),
    // Named Inventories (ticket 115, API 27): which one serve runs on, and making another one active.
    listInventories: () => serve<Inventories>("inventories.list"),
    useInventory: (name) => serve<InventoryUsed>("inventories.use", { name }),
    createInventory: (params) => call<NewInventory>("inventory_create", { params }),
    cancelCreateInventory: () => call<boolean>("inventory_create_cancel"),
    verifyLogin: (host, changes: HostChanges) => serve<HostCheck>("host.verify_login", { host, changes }),
    updateHost: (host, changes: HostChanges) => serve<HostUpdate>("host.update", { host, changes }),
    pendingChanges: () => serve<PendingChanges>("changes.diff"),
    discardChanges: () => serve<{ discarded: boolean; backup: string | null }>("changes.discard"),
    publishChanges: (message) => serve<PublishResult>("changes.publish", { message }),
    scanKey: (address, port) => serve<ScannedKey>("host.scan_key", { address, port }),
    scanHostKey: (host) => serve<HostKeyScan>("host.scan_key", { host }),
    // The core sends only a SHA256 fingerprint to be trusted.
    trustHostKey: (host, fingerprint) => call<HostKeyTrust>("host_key_trust", { host, fingerprint }),
    addHost: (params: AddHostParams) => serve<HostAdd>("host.add", { ...params }),
    // `reviewed: false` (API 9) only when unmarking, so a review reads as it did for an older roster.
    reviewHost: (host, reviewed = true) => serve<HostUpdate>("host.review", reviewed ? { host } : { host, reviewed: false }),
    // The Live Inventory (ticket 28).
    removeHost: (host) => serve("host.remove", { host }),
    renameHost: (host, to) => serve("host.rename", { host, to }),
    moveHost: (host, group) => serve("host.move", { host, group }),
    newGroup: (name, title) => serve("group.new", { name, ...(title ? { title } : {}) }),
    renameGroup: (group, to) => serve("group.rename", { group, to }),
    deleteGroup: (group, to) => serve("group.delete", { group, ...(to ? { to } : {}) }),
    reloadInventory: () => serve<InventoryReload>("inventory.reload"),
    watchInventory: (auto) => serve("inventory.watch", { auto }),
    // "Save to vault" after a Session's own login (tickets 15, 16): ids and names only.
    saveQuick: (params: QuickSaveParams) => serve<QuickSave>("quick.save", { ...params }),
    saveLogin: (params: SaveLoginParams) => serve<SaveLogin>("host.save_login", { ...params }),
    forgetTyped: (held) => serve<{ forgotten: boolean }>("vault.forget_typed", { held }),
    // Plugins (ticket 23): they run in the core; only data comes back.
    pluginManifest: (path) => call("plugin_manifest", { path }),
    pluginTypes: (path) => call<string>("plugin_types", { path }),
    pluginLoad: (path, grants, settings, builtins) => call("plugin_load", { path, grants, settings: settings ?? null, builtins: builtins ?? null }),
    pluginCall: (plugin, handler, args, user, builtins) => call<PluginReply>("plugin_call", { plugin, handler, args, user: user !== false, carried: user === "carried", builtins: builtins ?? null }),
    pluginEvent: (name, payload, builtins) => call<PluginReply[]>("plugin_event", { name, payload, builtins: builtins ?? null }),
    pluginSessions: (open) => call<null>("plugin_sessions", { open: open.map(openSessionArg) }).then(() => undefined),
    pluginUnload: (plugin) => call<boolean>("plugin_unload", { plugin }),
    pluginForget: (plugin) => call<boolean>("plugin_forget", { plugin }),
    pluginRequests: () => call<Record<string, SiteRequests[]>>("plugin_requests"),
    pluginData: (names) => call<Record<string, PluginData>>("plugin_data", { names }),
    onPluginReply(onReply) {
      const stop = listen<PluginReply>("plugin-reply", (e) => onReply(e.payload));
      return () => void stop.then((f) => f());
    },
    // `:tutor`'s demo (ticket 66, decision Q123): the same commands, on the demo's own host.
    async demoPlugins(hosts) {
      const id = await call<number>("plugin_demo_start", { hosts });
      // Every call names its demo: one for an earlier demo reaches nothing (decision Q123).
      const onDemo = id;
      return {
        pluginManifest: (path) => call("plugin_manifest", { path }),
        pluginTypes: (path) => call<string>("plugin_types", { path }),
        pluginLoad: (path, grants, settings, builtins) => call("plugin_load", { path, grants, settings: settings ?? null, builtins: builtins ?? null, onDemo }),
        pluginCall: (plugin, handler, args, user, builtins) =>
          call<PluginReply>("plugin_call", { plugin, handler, args, user: user !== false, carried: user === "carried", builtins: builtins ?? null, onDemo }),
        pluginEvent: (name, payload, builtins) => call<PluginReply[]>("plugin_event", { name, payload, builtins: builtins ?? null, onDemo }),
        pluginSessions: (open) => call<null>("plugin_sessions", { open: open.map(openSessionArg), onDemo }).then(() => undefined),
        pluginUnload: (plugin) => call<boolean>("plugin_unload", { plugin, onDemo }),
        pluginForget: (plugin) => call<boolean>("plugin_forget", { plugin, onDemo }),
        onPluginReply(onReply) {
          const stop = listen<{ demo: number; reply: PluginReply }>("plugin-demo-reply", (e) => {
            if (e.payload.demo === id) onReply(e.payload.reply);
          });
          return () => void stop.then((f) => f());
        },
        close: () => call<unknown>("plugin_demo_stop", { id }).then(() => undefined),
      };
    },
    // Packages (ticket 24): git runs in the core; init.lua says what may be fetched.
    packagesSync: () => call<PackageStatus[]>("packages_sync"),
    packagesPin: (name) => call<PackageStatus>("packages_pin", { name }),
    packagesDiscard: (name) => call<unknown>("packages_discard", { name }).then(() => undefined),
    packagesRemove: (name) => call<unknown>("packages_remove", { name }).then(() => undefined),
    packagesCheck: (name) => call<PackageChecked[]>("packages_check", name === undefined ? {} : { name }),
    packagesApply: (name, commit) => call<PackageStatus>("packages_apply", { name, commit }),
    packagesClean: () => call<string[]>("packages_clean"),
    onLoggedIn(onLogin) {
      const stop = listen<{ method: string; params: { held?: unknown } }>("roster-notification", (e) => {
        const held = e.payload.params?.held;
        if (e.payload.method === "session.logged_in" && typeof held === "string") onLogin(held);
      });
      return () => void stop.then((f) => f());
    },
    onJobProgress(onProgress) {
      const stop = listen<{ method: string; params: unknown }>("roster-notification", (e) => {
        if (e.payload.method === "job.progress") onProgress(e.payload.params as JobProgress);
      });
      return () => void stop.then((f) => f());
    },
    onInventoryChanged(onChange) {
      const stop = listen<{ method: string; params: unknown }>("roster-notification", (e) => {
        if (e.payload.method === "inventory.changed") onChange(e.payload.params as InventoryChanged);
      });
      return () => void stop.then((f) => f());
    },
  };
}
