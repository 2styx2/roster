// Plugins in the workspace (ticket 23): the Lua runs in roster-core; they act on the app through
// command lines, and their UI goes into the registries with their name as its source. This is
// what the workspace tells them (the events) and what it lets them do (PluginUi).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Backend } from "../backend/types";
import { foldersSettings } from "../folders/file";
import type { Platform } from "../platform/types";
import { PluginManager, type Snapshot } from "../plugins/manager";
import { SessionList } from "../plugins/sessionList";
import type { Registries } from "../registries";
import { isLive } from "../session/status";
import type { TabsSnapshot } from "../session/tabs";
import type { StateStore } from "../state/store";
import type { TutorEvent } from "../tutor/tutor";
import { errorText } from "../ui/format";
import type { Message, MessageLog, MessagesChoice } from "../ui/messages";
import type { ViewHost } from "../view/views";
import type { Latest } from "./latest";

/** What a Plugin's calls reach in the workspace, as of its last render. */
export interface PluginHandlers {
  run(line: string): void;
  openCommandLine(text: string): void;
  /** Goes to Session `id` and finds `line` up its scrollback; false with no such Session. */
  showSession(id: number, line: string | null): boolean;
  /** The Session on screen, for a handler's context (api 3); its host null for a Quick Connect. */
  onScreen(): { session: number; host: string | null } | null;
}

export interface PluginBridge {
  plugins: PluginManager;
  snapshot: Snapshot;
}

export function usePluginBridge(opts: {
  backend: Backend;
  registries: Registries;
  store: StateStore;
  platform: Platform;
  viewHost: ViewHost;
  messages: { choice: MessagesChoice; log: MessageLog };
  say(m: Message): void;
  send(id: number, text: string): void;
  handlers: Latest<PluginHandlers>;
  sessions: TabsSnapshot;
  ready: boolean;
  locked: boolean;
  /** Each new Host list is an `inventory_changed` (the Host count). */
  hostsVersion: unknown;
  /** serve pushes its jobs' progress (API 20, decision Q112). */
  jobs: boolean;
  packagesKey: string;
  /** On `:tutor`'s demo Inventory: a load failure says so (#233), its Plugins stop when it ends
   * (ticket 66), and why yours aren't there is said once. */
  demo: { onStop(stop: () => void): () => void; problem: string | null } | null;
  tutorEvent(name: string, data: TutorEvent["data"]): void;
}): PluginBridge {
  const { backend, registries, store, platform, viewHost, say, handlers, sessions, tutorEvent } = opts;
  const { choice: messagesChoice, log: messageLog } = opts.messages;
  const isDemo = opts.demo !== null;
  const [plugins] = useState(
    () =>
      new PluginManager(backend, registries, store, {
        run: (line) => handlers.get().run(line),
        send: (id, text) => opts.send(id, text),
        copy: (text) => platform.clipboard.writeText(text),
        onScreen: () => handlers.get().onScreen(),
        closeView: (id) => viewHost.close(id),
        openView: (id, select) => viewHost.open(id, select),
        showSession: (id, line) => handlers.get().showSession(id, line),
        openUrl: (url) => {
          platform.openUrl?.(url).catch((e: unknown) => say(`Couldn't open ${url}: ${errorText(e)}`));
        },
        say,
        // A Plugin's messages follow ui.messages as roster's own do (tickets 117, 118).
        messagesAll: () => messagesChoice.all(),
        log: (message) => messageLog.push(message),
        openCommandLine: (text) => handlers.get().openCommandLine(text),
        // Folders (ticket 61, decision Q93): init.lua's Folders, and the ones to move in once.
        builtinSettings: async (name) => (name === "folders" ? foldersSettings(registries.folders, platform.folders, store) : null),
        demo: isDemo,
      }),
  );
  const snapshot = useSyncExternalStore(plugins.subscribe, plugins.snapshot);

  const demoStop = opts.demo?.onStop;
  useEffect(() => demoStop?.(() => plugins.stop()), [demoStop, plugins]);
  const demoProblem = opts.demo?.problem ?? null;
  useEffect(() => {
    if (demoProblem && !plugins.snapshot().notices.some((n) => n.text === demoProblem)) plugins.notify("tutor", "warn", demoProblem);
  }, [demoProblem, plugins]);
  // What a Plugin does when one of its HTTP requests answers comes from the core on its own.
  useEffect(() => backend.onPluginReply((r) => plugins.replied(r)), [backend, plugins]);
  const { ready, locked, jobs, packagesKey, hostsVersion } = opts;
  useEffect(() => {
    if (ready) void plugins.start();
  }, [ready, plugins]);
  useEffect(() => {
    if (ready) void plugins.syncPackages();
  }, [ready, plugins, packagesKey]);
  useEffect(() => {
    void plugins.event(locked ? "lock" : "unlock");
  }, [locked, plugins]);
  const firstHosts = useRef<unknown>(null);
  useEffect(() => {
    if (hostsVersion === null) return;
    if (firstHosts.current === null) firstHosts.current = hostsVersion;
    else void plugins.event("inventory_changed");
  }, [hostsVersion, plugins]);
  useEffect(() => {
    if (!ready || !jobs) return;
    return backend.onJobProgress((job) => void plugins.event("job_progress", job));
  }, [backend, ready, jobs, plugins]);
  // Folders (GLOSSARY) is a built-in Plugin (ticket 61, decision Q93): init.lua's Folders are its
  // settings, so a change to them loads it again.
  useEffect(() => registries.folders.subscribe(() => void plugins.reloadBuiltin("folders")), [registries, plugins]);

  // Sessions opening and ending as Plugin events. Each tab's state and Host (a Quick Connect
  // Session's is null), so a tab closed while it ran still names its Host in `session_exit`.
  const seen = useRef(new Map<number, { state: "live" | "ended"; host: string | null }>());
  // The Sessions open now, in the order they opened (a reconnect is a new open, so it goes last):
  // the whole list goes to the core on start and whenever it changes, before the events that
  // changed it, for `roster.sessions.list()` (ticket 96, decision Q127).
  const order = useRef(new Map<number, string | null>());
  // A folder change waits a little (SessionList: review of #426, L3); an open or an end goes at once.
  const [list] = useState(() => new SessionList((open) => plugins.sessions(open)));
  useEffect(() => () => list.stop(), [list]);
  useEffect(() => {
    const before = seen.current;
    const now = new Map<number, { state: "live" | "ended"; host: string | null }>();
    const events: [() => void, () => void][] = [];
    for (const t of sessions.tabs) {
      const ended = !isLive(t.status);
      const host = t.quick ? null : t.host;
      now.set(t.id, { state: ended ? "ended" : "live", host });
      if (!ended && before.get(t.id)?.state !== "live") {
        order.current.delete(t.id);
        order.current.set(t.id, host);
        // A Quick Connect Session's `host` is nil to a Plugin: it isn't a Host of the Inventory.
        events.push([() => void plugins.event("session_open", { session: t.id, host }), () => tutorEvent("session_open", { host: t.host })]);
      }
      if (ended && before.get(t.id)?.state === "live") {
        order.current.delete(t.id);
        const code = t.status.state === "ended" ? t.status.exit.code : null;
        events.push([() => void plugins.event("session_exit", { session: t.id, host, code }), () => tutorEvent("session_exit", { host: t.host, code })]);
      }
    }
    for (const [id, was] of before) {
      if (now.has(id)) continue;
      order.current.delete(id);
      if (was.state === "live") events.push([() => void plugins.event("session_exit", { session: id, host: was.host, code: null }), () => {}]);
    }
    seen.current = now;
    // With the folder each one's shell last said (OSC 7, #242): the core gives it to terminal.read's
    // Plugins only (Q185), and a `cd` sends the list again.
    const cwds = new Map(sessions.tabs.map((t) => [t.id, t.cwd ?? null]));
    list.update([...order.current].map(([session, host]) => ({ session, host, cwd: cwds.get(session) ?? null })));
    for (const [toPlugins, toTutor] of events) {
      toPlugins();
      toTutor();
    }
  }, [sessions.tabs, plugins, tutorEvent, list]);
  // The Session on screen: Plugins hear `host_selected` only for a Host's (a Quick Connect
  // Session isn't on one).
  const onScreen = sessions.tabs.find((t) => t.id === sessions.active);
  const onScreenHost = onScreen?.host ?? null;
  const onScreenQuick = Boolean(onScreen?.quick);
  useEffect(() => {
    if (!onScreenHost) return;
    if (!onScreenQuick) void plugins.event("host_selected", { host: onScreenHost });
    tutorEvent("host_selected", { host: onScreenHost });
  }, [onScreenHost, onScreenQuick, plugins, tutorEvent]);

  return { plugins, snapshot };
}
