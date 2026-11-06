// Plugins in the workspace (ticket 23): the Lua runs in roster-core; they act on the app through
// command lines, and their UI goes into the registries with their name as its source. This is
// what the workspace tells them (the events) and what it lets them do (PluginUi).
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Backend } from "../backend/types";
import { foldersBuiltin } from "../folders/builtin";
import { useStoreLayer, type Layer } from "../panel/stack";
import type { Platform } from "../platform/types";
import { PluginManager, type Snapshot } from "../plugins/manager";
import { SessionEvents } from "../plugins/sessionEvents";
import { SessionList } from "../plugins/sessionList";
import type { Registries } from "../registries";
import type { TabsSnapshot } from "../session/tabs";
import type { StateStore } from "../state/store";
import type { TutorEvent } from "../tutor/tutor";
import { errorText } from "../ui/format";
import type { Message, MessageLog, MessagesChoice } from "../ui/messages";
import type { ViewHost } from "../view/views";
import type { Latest } from "../ui/latest";
import type { FocusReturn } from "../ui/useFocusReturn";

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
  /** A Plugin's question, then its float: the topmost layers. */
  layers: Layer[];
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
  focus: FocusReturn;
}): PluginBridge {
  const { backend, registries, store, platform, viewHost, say, handlers, sessions, tutorEvent } = opts;
  const { choice: messagesChoice, log: messageLog } = opts.messages;
  const isDemo = opts.demo !== null;
  const [builtins] = useState(() => [foldersBuiltin(registries.folders, platform.folders, store)]);
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
        builtinSettings: async (name) => (await builtins.find((b) => b.name === name)?.settings()) ?? null,
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
  useEffect(() => {
    const stops = builtins.map((b) => b.watch(() => void plugins.reloadBuiltin(b.name)));
    return () => stops.forEach((stop) => stop());
  }, [builtins, plugins]);

  // A Plugin's question (ticket 78) or float (ticket 91) takes the keys; answering or closing puts
  // them back where they were.
  const confirmKey = useCallback(() => plugins.snapshot().confirm?.id.toString() ?? null, [plugins]);
  const floatKey = useCallback(() => {
    const f = plugins.snapshot().float;
    return f ? `${f.plugin}:${f.title}` : null;
  }, [plugins]);
  const closeConfirm = useCallback(() => plugins.answerConfirm(false), [plugins]);
  const closeFloat = useCallback(() => plugins.closeFloat(), [plugins]);
  const confirmLayer = useStoreLayer(opts.focus, "plugin-confirm", plugins, confirmKey, closeConfirm);
  const floatLayer = useStoreLayer(opts.focus, "plugin-float", plugins, floatKey, closeFloat);

  // A folder change waits a little (SessionList: review of #426, L3); an open or an end goes at once.
  const [list] = useState(() => new SessionList((open) => plugins.sessions(open)));
  useEffect(() => () => list.stop(), [list]);
  const [sessionEvents] = useState(() => new SessionEvents());
  useEffect(() => {
    const { events, open } = sessionEvents.next(sessions.tabs);
    // The list goes to the core before the events that changed it.
    list.update(open);
    for (const e of events) {
      void plugins.event(e.name, e.payload);
      if (e.tutor) tutorEvent(e.name, e.tutor);
    }
  }, [sessions.tabs, plugins, tutorEvent, list, sessionEvents]);
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

  return { plugins, snapshot, layers: [confirmLayer, floatLayer] };
}
