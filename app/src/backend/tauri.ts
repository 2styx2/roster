// The real Backend: Tauri commands in src-tauri/src/lib.rs, which drive `roster serve` through
// roster-core. Only imported when running inside Tauri (see index.ts).
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  type PendingChanges,
  type PackageChecked,
  type PackageStatus,
  type PluginReply,
  type PublishResult,
  type PullResult,
  type SaveTargets,
  type SignedOut,
  type ScannedKey,
  type ProviderStatus,
  type SignInStep,
  type VaultStatus,
  type SessionAuth,
  type SessionEvents,
  type SessionExit,
  type SessionHandle,
  type SiteRequests,
  type PluginData,
  type TermSize,
} from "./types";

/** roster-core's CallError, as serde sends it. */
type CallErrorWire =
  | { kind: "rpc"; code: number; message: string; data?: unknown }
  | { kind: "exited"; code: number | null; stderr: string }
  | { kind: "timeout" }
  | { kind: "io"; message: string };

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

async function openSession(host: string, size: TermSize, events: SessionEvents, typed?: TypedPassword): Promise<SessionHandle> {
  // A typed password (ticket 16) goes once to serve's stdin, like vault_unlock's.
  const { id, auth, held } = await call<{ id: number; auth: SessionAuth; held?: string }>("session_open", {
    host,
    password: typed?.password ?? null,
    save: typed?.save === true,
    cols: size.cols,
    rows: size.rows,
    events: sessionChannel(events),
  });
  return {
    id,
    auth,
    ...(held === undefined ? {} : { held }),
    write: (data) => call("session_write", { id, data }),
    resize: ({ cols, rows }) => call("session_resize", { id, cols, rows }),
    close: () => call("session_close", { id }),
    // Only the prompt line goes; the password stays in the core (ticket 119).
    fill: (prompt, hop) => call<{ host: string }>("session_fill", { id, prompt, hop: hop ?? null }),
  };
}

/** A Quick Connect (ticket 14): the typed password goes once to serve's stdin, like vault_unlock's. */
async function openQuickSession(
  to: QuickConnect,
  password: string | null,
  size: TermSize,
  events: SessionEvents,
  options: { save?: boolean } = {},
): Promise<SessionHandle> {
  const { id, auth, quick, held } = await call<{ id: number; auth: SessionAuth; quick?: string; held?: string }>("quick_session_open", {
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

function inventoryCall<T>(method: string, params: Record<string, unknown>): Promise<T> {
  return call<T>("inventory_call", { method, params });
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
    listHosts: () => call<HostList>("hosts_list"),
    getHost: (name, options) => call<Host>("host_get", { name, settled: options?.settled ?? false }),
    vaultStatus: () => call<VaultStatus>("vault_status"),
    unlockVault: (password) => call<ProviderStatus>("vault_unlock", { password }),
    lockVault: () => call<{ locked: string[] }>("vault_lock"),
    signOut: () => call<SignedOut>("vault_logout"),
    configureVault: (settings) => call<VaultConfigured>("vault_configure", { settings }),
    saveTargets: () => call<SaveTargets>("vault_targets"),
    // Secrets in these params go once to serve's stdin, like vault_unlock's password.
    signIn: (start) => call<SignInStep>("vault_login", { params: { action: "start", ...start } }),
    signInAnswer: (login, answer) =>
      call<SignInStep>("vault_login", { params: { action: "answer", login, ...answer } }),
    signInCancel: async () => {
      await call("vault_login", { params: { action: "cancel" } }).catch(() => {});
    },
    openSession,
    openQuickSession,
    checkHost: (host) => call<HostCheck>("host_check", { host }),
    checkBox: () => call<BoxCheck>("box_check"),
    pullInventory: () => call<PullResult>("inventory_pull"),
    verifyLogin: (host, changes: HostChanges) => call<HostCheck>("host_verify_login", { host, changes }),
    updateHost: (host, changes: HostChanges) => call<HostUpdate>("host_update", { host, changes }),
    pendingChanges: () => call<PendingChanges>("changes_diff"),
    discardChanges: () => call<{ discarded: boolean; backup: string | null }>("changes_discard"),
    publishChanges: (message) => call<PublishResult>("changes_publish", { message }),
    scanKey: (address, port) => call<ScannedKey>("host_scan_key", { address, port }),
    scanHostKey: (host) => call<HostKeyScan>("host_key_scan", { host }),
    trustHostKey: (host, fingerprint) => call<HostKeyTrust>("host_key_trust", { host, fingerprint }),
    // A typed password goes once to serve's stdin, like vault_unlock's.
    addHost: (params: AddHostParams) => call<HostAdd>("host_add", { params }),
    reviewHost: (host, reviewed = true) => call<HostUpdate>("host_review", { host, reviewed }),
    // The Live Inventory (ticket 28): one allow-listed Tauri command for its methods.
    removeHost: (host) => inventoryCall("host.remove", { host }),
    renameHost: (host, to) => inventoryCall("host.rename", { host, to }),
    moveHost: (host, group) => inventoryCall("host.move", { host, group }),
    newGroup: (name, title) => inventoryCall("group.new", { name, ...(title ? { title } : {}) }),
    renameGroup: (group, to) => inventoryCall("group.rename", { group, to }),
    deleteGroup: (group, to) => inventoryCall("group.delete", { group, ...(to ? { to } : {}) }),
    reloadInventory: () => inventoryCall<InventoryReload>("inventory.reload", {}),
    watchInventory: (auto) => inventoryCall("inventory.watch", { auto }),
    // "Save to vault" after a Session's own login (tickets 15, 16): ids and names only.
    saveQuick: (params: QuickSaveParams) => call<QuickSave>("save_call", { method: "quick.save", params }),
    saveLogin: (params: SaveLoginParams) => call<SaveLogin>("save_call", { method: "host.save_login", params }),
    forgetTyped: (held) => call<{ forgotten: boolean }>("save_call", { method: "vault.forget_typed", params: { held } }),
    // Plugins (ticket 23): they run in the core; only data comes back.
    pluginManifest: (path) => call("plugin_manifest", { path }),
    pluginTypes: (path) => call<string>("plugin_types", { path }),
    pluginLoad: (path, grants, settings) => call("plugin_load", { path, grants, settings: settings ?? null }),
    pluginCall: (plugin, handler, args, user) => call<PluginReply>("plugin_call", { plugin, handler, args, user: user !== false, carried: user === "carried" }),
    pluginEvent: (name, payload) => call<PluginReply[]>("plugin_event", { name, payload }),
    pluginSessions: (open) => call<null>("plugin_sessions", { open: open.map((o) => [o.session, o.host]) }).then(() => undefined),
    pluginUnload: (plugin) => call<boolean>("plugin_unload", { plugin }),
    pluginForget: (plugin) => call<boolean>("plugin_forget", { plugin }),
    pluginBuiltins: (names) => call<null>("plugin_builtins", { names }).then(() => undefined),
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
        pluginLoad: (path, grants, settings) => call("plugin_load", { path, grants, settings: settings ?? null, onDemo }),
        pluginCall: (plugin, handler, args, user) => call<PluginReply>("plugin_call", { plugin, handler, args, user: user !== false, carried: user === "carried", onDemo }),
        pluginEvent: (name, payload) => call<PluginReply[]>("plugin_event", { name, payload, onDemo }),
        pluginSessions: (open) => call<null>("plugin_sessions", { open: open.map((o) => [o.session, o.host]), onDemo }).then(() => undefined),
        pluginUnload: (plugin) => call<boolean>("plugin_unload", { plugin, onDemo }),
        pluginForget: (plugin) => call<boolean>("plugin_forget", { plugin, onDemo }),
        pluginBuiltins: (names) => call<null>("plugin_builtins", { names, onDemo }).then(() => undefined),
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
