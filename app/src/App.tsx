// The app shell: connect to the Backend, then the view mode's layout (view/layout.ts): Standard
// has the Sidebar and the status bar around the Sessions' terminals (or an empty state); Focus is
// fullscreen with only the terminal and, if asked for, the session bar. The Key bindings panel,
// the check panel, the command line, the Picker and the Finder work the same in both. A Backend
// that can't start gets an error screen that says what to fix.
//
// Keys: the focus-mode machine (keyboard/mode.ts) decides whether a key is the terminal's or the
// app's; the app's keys are command lines run through the one command table (commands/table.ts),
// which is also what the command line and every button run. The commands, keymap and Sidebar
// sections are registries (ADR 0006), read live. What each part of the workspace does is its own
// hook; this file wires them together and draws the screen.
import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Latest, useLatest } from "./ui/latest";
import { Overlays, type Overlay } from "./app/Overlays";
import { PluginLayers } from "./app/PluginLayers";
import { infoLine } from "./app/infoLine";
import { useBuiltins } from "./app/useBuiltins";
import { useWorkspaceLife } from "./app/useWorkspaceLife";
import { WindowFrame } from "./chrome/WindowFrame";
import { useTabsConfig } from "./session/useTabsConfig";
import { useWorkspaceTheme } from "./theme/useWorkspaceTheme";
import { useMessages, type MessageDivert } from "./ui/useMessages";
import { usePluginBridge, type PluginHandlers } from "./app/usePluginBridge";
import { type Backend } from "./backend/types";
import { useConnection } from "./app/useConnection";
import { runLine, type AppContext, type CommandContext, type Commands } from "./commands/table";
import { layoutWarnings } from "./config/apply";
import type { ConfigContext } from "./config/command";
import { ConfigToast } from "./config/ConfigToast";
import { defaultConfig } from "./config/defaults";
import { ImportPanel } from "./config/ImportPanel";
import type { ConfigReport } from "./config/types";
import { useConfigActions } from "./config/useConfigActions";
import { useConfigReport } from "./config/useConfigReport";
import { HostDetails } from "./details/HostDetails";
import { webServices } from "./details/details";
import { useDetails } from "./details/useDetails";
import { CheckPanel } from "./errors/CheckPanel";
import type { CheckContext } from "./errors/command";
import { RosterApi } from "./errors/rosterApi";
import { useCheck } from "./errors/useCheck";
import { ErrorScreen } from "./ErrorScreen";
import type { FinderContext } from "./finder/sources";
import { HelpView } from "./help/command";
import { HelpPanel } from "./help/HelpPanel";
import { useHelp } from "./help/useHelp";
import { FirstRun } from "./inventory/FirstRun";
import { inventoryActions } from "./inventory/actions";
import type { InventoryContext } from "./inventory/commands";
import { Forms } from "./inventory/Forms";
import { SwitchPanel } from "./inventory/SwitchPanel";
import { useInventories } from "./inventory/useInventories";
import { useForms } from "./inventory/useForms";
import { useInventory } from "./inventory/useInventory";
import { BindingsPanel } from "./keyboard/BindingsPanel";
import { bindingRows } from "./keyboard/bindings";
import { terminalMode } from "./keyboard/mode";
import { useAppKeys } from "./keyboard/useAppKeys";
import { defaultOptions, keyHint, keymapOf, listKeyFor, type CommandLine as Line, type Options } from "./keymap";
import { TypedPasswordsContext } from "./lock/forgetOnLock";
import type { Clock } from "./ui/clock";
import { LockGate } from "./lock/LockScreen";
import { SignOutPanel } from "./lock/SignOutPanel";
import { useWorkspaceVault } from "./lock/useWorkspaceVault";
import { NO_DEFAULTS, PanelLayout, type PanelPlace } from "./panel/layout";
import { PanelFrame } from "./panel/PanelFrame";
import { closeTop, usePanelState, type Layer } from "./panel/stack";
import { pickerTimer } from "./picker/timing";
import { memoryPlatform } from "./platform/memory";
import type { Platform } from "./platform/types";
import { PluginNotices, PluginProgressItems } from "./plugins/PluginsPanel";
import { type QuickTarget } from "./quick/target";
import { builtinRegistries, type Registries } from "./registries";
import { sessionActions } from "./session/actions";
import type { SessionContext } from "./session/commands";
import { SessionsMain } from "./session/SessionsMain";
import { Tabs } from "./session/tabs";
import { connectPhase } from "./session/status";
import { useRecent, useWindowTitle } from "./session/useRecent";
import { hostMenu } from "./sidebar/hostMenu";
import { hostDot, hostLights } from "./sidebar/sections";
import type { SidebarRow } from "./sidebar/model";
import { sidebarContext } from "./sidebar/context";
import { Sidebar } from "./sidebar/Sidebar";
import { useSidebarModel } from "./sidebar/useSidebarModel";
import { StateStore } from "./state/store";
import { defaultTerminalOptions } from "./terminal/options";
import { TerminalView, type TerminalViewComponent } from "./terminal/TerminalView";
import { useTerminalEnv } from "./terminal/useTerminalEnv";
import { defaultAppearance, type AppearanceOptions } from "./theme/theme";
import { DemoBanner } from "./tutor/DemoBanner";
import { resumeAt, tutorPage, type TutorEvent, type TutorialDef } from "./tutor/tutor";
import { useDemo, type TutorLink } from "./tutor/useDemo";
import { shownControls, type ToolbarContext } from "./chrome/toolbar";
import { countOf } from "./ui/format";
import { HintsShown } from "./ui/hints";
import { MESSAGES_VIEW, quiet, shownText, spokenText } from "./ui/messages";
import { MessageText } from "./ui/MessageText";
import { useFocusReturn } from "./ui/useFocusReturn";
import { useMediaMatch } from "./ui/useMediaMatch";
import { GraphMemory } from "./graph/memory";
import type { ViewContext } from "./view/commands";
import { isShown, otherMode, placed, type Place } from "./view/layout";
import { SessionBar } from "./view/SessionBar";
import { ModeHint } from "./view/ModeHint";
import { StatusBar } from "./view/StatusBar";
import { useLayout } from "./view/useLayout";
import { ViewPanel } from "./view/ViewContent";
import { sectionsFor, ViewHost } from "./view/views";
import { version as APP_VERSION } from "../package.json";

const noSubscribe = () => () => {};
const noSnapshot = () => undefined;
const noHandlers: PluginHandlers = { run: () => {}, openCommandLine: () => {}, showSession: () => false, onScreen: () => null };

export interface AppProps {
  backend: Backend;
  options?: Options;
  /** Commands, keymap and Sidebar sections; the built-ins unless a test passes its own. */
  registries?: Registries;
  /** For the idle lock; tests pass a manual one. */
  clock?: Clock;
  /** The terminal each Session draws in (tests pass a stub; xterm needs a real browser). */
  terminalView?: TerminalViewComponent;
  /** Theme, fonts and the title bar (ticket 09), until a Config gives its own. */
  appearance?: AppearanceOptions;
  /** The State file, clipboard, Windows build, window controls and fullscreen (tests: an in-memory one). */
  platform?: Platform;
  /** Hosts to open Sessions to once the Backend is up, in order (a fixture's open Sessions: the
   * dev page's `?fixture=worst-case`, and the UI tests), once the app is first unlocked. */
  openAtStart?: readonly string[];
  /** This build's version (package.json's), for what's new after an upgrade (ticket 47); tests
   * pass their own. */
  appVersion?: string;
  /** The Config as the app starts (ticket 21): it replaces `options` and `appearance`, and its keys,
   * Themes and Folders go into the registries. Later saves come through `platform.config`. */
  config?: ConfigReport | null;
}

interface WorkspaceProps extends AppProps {
  /** The State, made by App so `:tutor`'s progress and the workspace share it. */
  store?: StateStore;
  tutor?: TutorLink;
  /** Hidden behind the demo Inventory (`:tutor`): it keeps its Sessions, vault and State, but
   * takes no keys and leaves the document's Theme to the demo. */
  suspended?: boolean;
}

/** The app: your workspace, and while a tutorial runs (`:tutor`, ticket 55, decision Q76), the demo
 * Inventory's in front of it. The workspace stays mounted behind, hidden and inert, so its
 * Sessions keep running and its vault and State are never touched; leaving the demo throws the
 * demo's workspace (its fake Backend, its State in memory) away and shows yours again. */
export function App(props: AppProps) {
  const [platform] = useState(() => props.platform ?? memoryPlatform());
  const [store] = useState(() => new StateStore(platform));
  const { real, demo } = useDemo(props.backend, platform, store);
  return (
    <>
      <div className="app-slot" hidden={demo !== null} inert={demo !== null}>
        <Workspace {...props} platform={platform} store={store} tutor={real} suspended={demo !== null} />
      </div>
      {demo && (
        <div className="app-slot">
          <Workspace
            backend={demo.backend}
            platform={demo.platform}
            config={props.config ?? null}
            tutor={demo.link}
            {...(props.terminalView ? { terminalView: props.terminalView } : {})}
            {...(props.clock ? { clock: props.clock } : {})}
            {...(props.appVersion ? { appVersion: props.appVersion } : {})}
            {...(props.appearance ? { appearance: props.appearance } : {})}
          />
        </div>
      )}
    </>
  );
}

function Workspace({
  backend,
  options: optionsProp = defaultOptions,
  registries: given,
  clock,
  terminalView = TerminalView,
  platform: platformProp,
  appearance: appearanceProp = defaultAppearance,
  openAtStart,
  config: configProp = null,
  appVersion = APP_VERSION,
  store: storeProp,
  tutor,
  suspended = false,
}: WorkspaceProps) {
  const [registries] = useState(() => given ?? builtinRegistries());
  const [platform] = useState(() => platformProp ?? memoryPlatform());
  const [store] = useState(() => storeProp ?? new StateStore(platform));
  const appState = useSyncExternalStore(store.subscribe, store.snapshot);
  const configState = useConfigReport(platform, registries, configProp);
  const { report, config, derived } = configState;
  const options = derived?.options ?? optionsProp;
  const appearance = derived?.appearance ?? appearanceProp;
  const terminalOptions = derived?.terminalOptions ?? defaultTerminalOptions;

  // A Sidebar row's own command's trouble goes under the row (round 20): the Sidebar's model says which.
  const [divert] = useState(() => new Latest<MessageDivert | null>(null));
  const { message, say, log: messageLog, choice: messagesChoice } = useMessages(registries, store, config?.ui.messages ?? null, divert);

  const commandList = useSyncExternalStore(registries.commands.subscribe, registries.commands.list);
  const bindingList = useSyncExternalStore(registries.keymap.subscribe, registries.keymap.list);
  const errorRows = useSyncExternalStore(registries.errors.subscribe, registries.errors.list);
  const finderSources = useSyncExternalStore(registries.finders.subscribe, registries.finders.list);
  const toolbarDefs = useSyncExternalStore(registries.toolbar.subscribe, registries.toolbar.list);
  const sectionDefs = useSyncExternalStore(registries.sidebar.subscribe, registries.sidebar.list);
  const statusDefs = useSyncExternalStore(registries.status.subscribe, registries.status.list);
  const viewList = useSyncExternalStore(registries.views.subscribe, registries.views.list);
  const detailsList = useSyncExternalStore(registries.details.subscribe, registries.details.list);
  const commands: Commands = useMemo(() => ({ get: (id) => registries.commands.get(id), list: () => commandList }), [registries, commandList]);
  const keymap = useMemo(() => keymapOf(bindingList), [bindingList]);

  const [tabs] = useState(() => new Tabs(backend));
  const sessions = useSyncExternalStore(tabs.subscribe, tabs.snapshot);
  /** Hosts with a Session that's connected or connecting (not ended or refused): their nodes are
   * lit wherever a Host is listed (taste.md: the accent means live, Q301). */
  const liveHosts = useMemo(() => hostLights(sessions), [sessions]);
  useWindowTitle(sessions);
  const { focus, mainRef, treeRef } = useFocusReturn();
  const { conn, info, caps, hosts, connect, reloadHosts } = useConnection(backend, tabs, say, config ? JSON.stringify([config.backend, config.rosterCommand]) : null);
  const ready = conn.state === "ready";
  const workspaceVault = useWorkspaceVault(backend, tabs, info, caps, config, { idleMs: options.idleLockMinutes * 60_000, clock, say, focus });
  const { vault, configures, targetsVersion, bumpTargets, typed, signingOut } = workspaceVault;
  const hostByName = useMemo(() => new Map((hosts?.hosts ?? []).map((h) => [h.name, h])), [hosts]);
  const groupNames = useMemo(() => {
    const names = Object.keys(hosts?.groups ?? {});
    for (const h of hosts?.hosts ?? []) if (!names.includes(h.group)) names.push(h.group);
    return names;
  }, [hosts]);

  const [viewHost] = useState(() => new ViewHost());
  const viewAt = useSyncExternalStore(viewHost.subscribe, viewHost.snapshot);
  const openView = viewAt.at === null ? undefined : viewList.find((v) => v.id === viewAt.at);
  const [graphMemory] = useState(() => new GraphMemory(store));
  // Every panel's place and width (ticket 95, decision Q106): the user's, kept in the State, over
  // init.lua's `views` and `panel.width`.
  const [panelLayout] = useState(() => new PanelLayout(store));
  // The body says what the layering and the terminal's minimum need, without CSS :has() (#176);
  // only those two, since focus moving between panels changes the layout too.
  const bodyPanels = useSyncExternalStore(panelLayout.subscribe, () => `${panelLayout.anyDocked() ? "d" : ""}${panelLayout.anyFull() ? "f" : ""}`);
  const [helpView] = useState(() => new HelpView());

  // `:tutor` (ticket 55): on the demo Inventory, what happens is fed to the tutorial running, whose
  // steps tick themselves; what a step ticks is said once (the page shows it as a ✓).
  const tutorNow = useLatest(tutor);
  const tutorEvent = useCallback(
    (name: string, data: TutorEvent["data"]) => {
      const link = tutorNow.get();
      if (link?.demo) link.progress.feed(link.demo.tutorial, { name, data });
    },
    [tutorNow],
  );
  const [handlers] = useState(() => new Latest(noHandlers));
  const { plugins, snapshot: pluginSnap, layers: pluginLayers } = usePluginBridge({
    backend,
    registries,
    store,
    platform,
    viewHost,
    messages: { choice: messagesChoice, log: messageLog },
    say,
    send: (id, text) => tabs.write(id, text),
    handlers,
    sessions,
    ready,
    locked: vault.locked,
    hostsVersion: hosts,
    jobs: caps.has("jobs"),
    packagesKey: JSON.stringify(config?.packages ?? []),
    demo: tutor?.demo ? { onStop: tutor.demo.onStop, problem: tutor.demo.problem } : null,
    tutorEvent,
    focus,
  });

  const { viewMode, setViewMode, layout, toggle, hint } = useLayout({
    options,
    config,
    configLayouts: derived?.layouts ?? null,
    store,
    appState,
    platform,
    clock,
    say,
  });
  // The layouts' names are checked once the Plugins have loaded, and again as they come and go:
  // a Plugin's section or segment isn't there while the Config is applied (ticket 79).
  const layoutsJudged = pluginSnap.settled || conn.state === "failed";
  const warnings = useMemo(
    () =>
      config && layoutsJudged
        ? [...configState.warnings, ...layoutWarnings({ sections: sectionDefs, segments: statusDefs, controls: toolbarDefs }, config)]
        : configState.warnings,
    [config, configState.warnings, layoutsJudged, sectionDefs, statusDefs, toolbarDefs],
  );

  const { theme, themeChoice, themeInEffect, hintsChoice, hintsShown } = useWorkspaceTheme(registries.themes, store, config, appearance, !suspended);

  const inventory = useInventory({
    backend,
    registries,
    info,
    caps,
    reloadHosts,
    bumpTargets,
    setStale: configState.setStale,
    say,
    autoReload: config?.autoReload ?? false,
    pullFreshMinutes: options.pullFreshMinutes,
    clock,
  });
  const { pendingCount, plain } = inventory;
  const check = useCheck({
    backend,
    registries,
    info,
    caps,
    report,
    warnings,
    terminalOptions,
    fontInstalled: platform.fontInstalled,
    openHealth: () => helpView.open({ page: "health" }),
    say,
  });
  const overlay = usePanelState<NonNullable<Overlay>>(focus, "overlay");
  const setOverlay = overlay.set;
  const openCommandLine = (initial = "") => overlay.open({ cmdline: initial });
  const reopenLine = useCallback((line: string, caret: number) => setOverlay({ cmdline: line, caret }), [setOverlay]);
  // `:tutor`'s progress: a tick re-renders the tutorial's page.
  const tutorDone = useSyncExternalStore(tutor?.progress.subscribe ?? noSubscribe, tutor?.progress.snapshot ?? noSnapshot);
  const running = tutor?.demo?.tutorial.id ?? null;
  const tutorCtx = useMemo(() => {
    void tutorDone;
    const progress = tutor?.progress;
    return progress ? { done: (id: string) => progress.done(id), running } : undefined;
  }, [tutor?.progress, running, tutorDone]);
  const hintsStored = hintsChoice.stored();
  const messagesStored = messagesChoice.stored();
  const helpState = useMemo(() => ({ theme: themeInEffect, hints: hintsStored, messages: messagesStored }), [themeInEffect, hintsStored, messagesStored]);
  const help = useHelp({
    view: helpView,
    registries,
    keymap,
    options,
    config: config ?? defaultConfig,
    configPath: report?.path ?? null,
    state: helpState,
    activeTheme: theme.id,
    health: check.health,
    tutor: tutorCtx,
    overlayOpen: overlay.value !== null,
    tutorEvent,
    reopenLine,
    focus,
  });
  const inventories = useInventories({
    backend,
    info,
    caps,
    tabs,
    sessions,
    say,
    focus,
    connect,
    lockNow: vault.lockNow,
    pendingNow: inventory.pendingNow,
    openCommandLine,
  });
  const configActions = useConfigActions({
    platform,
    report,
    take: configState.take,
    themeChoice,
    focus,
    say,
    source: () => void runLine(commands, ctx, "source init.lua"),
  });

  // The panels over the workspace (panel/stack.ts).
  const { form, removing, openForm } = useForms(focus, inventory);
  const keysPanel = usePanelState<true>(focus, "keys", { fromInside: true });
  const pluginsPanel = usePanelState<true>(focus, "plugins");
  const packagesPanel = usePanelState<true>(focus, "packages");

  const outputTap = useMemo(() => ({ output: plugins.output.bind(plugins) }), [plugins]);
  useTabsConfig({ tabs, caps, config, hosts: hosts?.hosts ?? [], hostByName, lockVault: vault.lock, outputTap });

  const terminal = useTerminalEnv({ options: terminalOptions, theme, keymap, platform, viewMode, layout, say });
  const sidebar = useSidebarModel({ registries, layout, sessions, hosts, hostByName, options, appState, store, caps, pending: inventory.pending, addKeys: keyHint(keymap, "host add") });
  useLayoutEffect(() => divert.set(sidebar.divert));
  const recent = useRecent({ sessions, store, hosts, recentHosts: appState.recentHosts });
  const staysInAppMode = (line: Line) => commands.get(line.split(" ")[0] ?? "")?.staysInAppMode ?? false;
  const unlocked = ready && !vault.locked;
  const keys = useAppKeys({
    keymap,
    options,
    listening: unlocked && !suspended,
    noOverlay: overlay.value === null,
    focus,
    staysInAppMode,
    onAppMode: sidebar.enterCursor,
    run,
  });
  const { keyState, setMode } = keys;
  // In a narrow window the Sidebar floats over the terminal: it steps aside while a Session is in
  // front and you're in the terminal (or over the idle pane, whose map and Find are then what shows),
  // unless `sidebar` (␣ e) showed it over this one.
  // A short window: the idle map keeps three Hosts, so its Find stays above the status bar.
  const short = useMediaMatch("(max-height: 460px)");
  const sidebarTucked = sidebar.shown && sidebar.narrow && keyState.mode !== "app" && !sidebar.peek;

  const [pickerTime] = useState(pickerTimer);
  const pickerShown = overlay.value === "picker" && !vault.locked;
  useLayoutEffect(() => {
    if (pickerShown) pickerTime.shown();
  }, [pickerShown, pickerTime]);
  const [reveal, setReveal] = useState<{ session: number; text: string; nonce: number } | null>(null);

  // The command line ran `line`, a key or a button did: one way in for all of them.
  function run(line: Line) {
    say("");
    // A `:help` still waiting for the guides' text never opens over what ran next (T213, #431 F3).
    helpView.cancelPending();
    const ran = runLine(commands, ctx, line);
    if (ran) {
      const arg = line.trim().split(/\s+/).slice(1).join(" ");
      tutorEvent("command", { id: ran.id, arg: arg || null });
    }
  }
  const runFromUi = (line: Line) => {
    setMode(terminalMode);
    run(line);
  };
  const copy = (text: string) => platform.clipboard.writeText(text);
  const onScreenTab = sessions.tabs.find((t) => t.id === sessions.active);
  const closeOverlay = () => {
    overlay.close();
    setMode(terminalMode);
  };
  const selectedHost = () => sidebar.cursorRow()?.host ?? onScreenTab?.host ?? null;
  const details = useDetails(focus, hostByName, selectedHost, say);
  // The panels from the top down (the one drawn last is the topmost): what Esc closes first.
  const layers = (): Layer[] => [
    ...pluginLayers,
    { id: "view", open: openView !== undefined, close: () => viewHost.close() },
    help.layer,
    pluginsPanel.layer,
    packagesPanel.layer,
    keysPanel.layer,
    signingOut.layer,
    inventories.layer,
    removing.layer,
    configActions.importing.layer,
    form.layer,
    check.layer,
    details.panel.layer,
  ];
  const { openWeb, whyNoSave, ...session } = sessionActions({
    tabs,
    sessions,
    hostByName,
    caps,
    platform,
    say,
    currentHost: () => details.panel.value ?? selectedHost(),
    openQuickPicker: () => overlay.open("quick"),
    findKeys: keyHint(keymap, "find"),
  });
  const inventoryCmds = inventoryActions({
    backend,
    info,
    caps,
    hosts,
    hostByName,
    groupNames,
    inventory,
    reloadHosts,
    say,
    selectedHost,
    openForm,
    askRemove: (h) => removing.open({ host: h.name, group: h.group }),
    openCommandLine,
  });

  // What commands act on, one part per feature. Rebuilt each render, so it always sees the
  // current state.
  const appCtx: AppContext = {
    openPicker: () => {
      if (overlay.value !== "picker") pickerTime.start();
      overlay.open("picker");
    },
    toggleStatusBar: () => toggle(layout.bar),
    openCommandLine,
    toggleKeys: () => (keysPanel.value ? keysPanel.close() : keysPanel.open(true)),
    lock: workspaceVault.lock,
    vault: workspaceVault.askSignOut,
    toTerminal: () => {
      setMode(terminalMode);
      ctx.closePanel();
    },
    closePanel: () => void closeTop(layers()),
    selectedHost,
    hostNames: () => hosts?.hosts.map((h) => h.name) ?? [],
    say,
    showInfo: () => {
      if (!info) return;
      const renderer = sessions.active !== null ? terminal.renderer : null;
      say(infoLine({ info, terminalOptions, fontInstalled: platform.fontInstalled, fontSize: terminal.fontSize, renderer, pickerMs: pickerTime.last() }));
    },
    details: details.show,
    openFinder: (source, query) => {
      if (!registries.finders.get(source)) return say(`No finder named ${source}`);
      overlay.open(query ? { finder: source, query } : { finder: source });
    },
  };
  const sessionCtx: SessionContext = {
    ...session,
    saveSession: () => {
      const why = whyNoSave(onScreenTab);
      if (why !== null) return say(why);
      if (onScreenTab) openForm({ kind: "save", tab: onScreenTab.id });
    },
  };
  const sidebarCtx = sidebarContext(sidebar, {
    toggleSidebar: () => {
      if (sidebarTucked || (sidebar.narrow && sidebar.peek)) {
        const peeking = sidebar.peek;
        sidebar.togglePeek();
        return say(
          quiet(
            peeking ? "Sidebar tucked away" : "Sidebar shown",
            peeking ? "Sidebar tucked away while the window is narrow" : "Sidebar shown over the terminal until you switch Sessions",
          ),
        );
      }
      toggle("sidebar");
    },
    keysToApp: (app) => setMode(app ? { mode: "app", pending: [] } : terminalMode),
    staysInAppMode,
    run,
    say,
  });
  const inventoryCtx: InventoryContext = { ...inventoryCmds, groupNames: () => groupNames, switchInventory: inventories.ask };
  const checkCtx: CheckContext = { checkHost: check.checkHost, checkBox: check.checkBox, stopCheck: check.stopOwn };
  const viewCtx: ViewContext = { viewMode: () => viewMode, setViewMode: (mode) => setViewMode(mode ?? otherMode(viewMode)) };
  const configCtx: ConfigContext = { config: (what) => configActions.run[what]() };
  const ctx: CommandContext = { ...appCtx, ...sessionCtx, ...sidebarCtx, ...inventoryCtx, ...checkCtx, ...viewCtx, ...configCtx };

  // What Plugins' calls reach here, and the built-ins that act on the workspace's own objects.
  useLayoutEffect(() =>
    handlers.set({
      run,
      openCommandLine,
      showSession: (id, line) => {
        if (!sessions.tabs.some((t) => t.id === id)) return false;
        tabs.select(id);
        ctx.toTerminal();
        if (line) setReveal((r) => ({ session: id, text: line, nonce: (r?.nonce ?? 0) + 1 }));
        return true;
      },
      onScreen: () => (onScreenTab ? { session: onScreenTab.id, host: onScreenTab.quick ? null : onScreenTab.host } : null),
    }),
  );
  const messagesDeps = useMemo(() => ({ choice: messagesChoice, log: messageLog, open: () => viewHost.open(MESSAGES_VIEW) }), [messagesChoice, messageLog, viewHost]);
  const openTutorial = (def: TutorialDef) => {
    const anchor = tutor ? resumeAt(def, tutor.progress.done(def.id)) : undefined;
    helpView.open({ page: tutorPage(def.id), ...(anchor ? { anchor } : {}) });
  };
  useBuiltins(
    registries,
    { help: helpView, theme: themeChoice, hints: hintsChoice, messages: messagesDeps, views: viewHost, panels: panelLayout, plugins },
    tutor,
    { plugins: () => pluginsPanel.open(true), packages: () => packagesPanel.open(true), tutorial: openTutorial },
  );
  const configPanel = config?.panel;
  const configViews = config?.views;
  useEffect(() => {
    const views = Object.fromEntries(
      Object.entries(configViews ?? {}).map(([id, v]) => [id, { ...(v.place ? { place: v.place } : {}), ...(v.width !== null ? { width: v.width } : {}) }]),
    );
    panelLayout.setDefaults(configPanel || configViews ? { width: configPanel?.width ?? null, views } : NO_DEFAULTS);
  }, [panelLayout, configPanel, configViews]);

  const noSessions = sessions.tabs.length === 0;
  const { setPromptButton } = useWorkspaceLife({
    store,
    platform,
    registries,
    tabs,
    appVersion,
    unlocked,
    suspended,
    noSessions,
    openAtStart,
    demoTutorial: tutor?.demo?.tutorial ?? null,
    openTutorial,
    focus,
    say,
  });

  const [toastClosedFor, setToastClosedFor] = useState<ConfigReport | null>(null);
  const finderCtx = useMemo<FinderContext | null>(
    () =>
      hosts
        ? { sessions, hosts, hostByName, sessionsIn: options.sessions, state: appState, folded: new Set(appState.folded), recent: appState.recentHosts, sidebar: sectionDefs }
        : null,
    [sessions, hosts, hostByName, options.sessions, appState, sectionDefs],
  );
  const detailsHost = details.host;
  const toolbarCtx: ToolbarContext = {
    pendingCount,
    sidebarShown: sidebar.shown,
    quickConnect: caps.has("quickConnect"),
    canAdd: caps.has("add"),
    detailsShown: detailsHost !== undefined,
    plain,
  };
  const toolbarControls = unlocked && isShown(layout, "toolbar") ? shownControls(toolbarDefs, layout.controls, toolbarCtx) : [];
  const frame = (content: ReactNode) => (
    <TypedPasswordsContext.Provider value={typed}>
      <HintsShown value={hintsShown}>
        <RosterApi.Provider value={info ? caps : undefined}>
          <WindowFrame
            layout={layout}
            controls={platform.window}
            toolbar={{ controls: toolbarControls, ctx: toolbarCtx, keymap, leader: options.leader, run: runFromUi }}
            banner={tutor?.demo && <DemoBanner tutorial={tutor.demo.tutorial} done={tutorCtx?.done(tutor.demo.tutorial.id) ?? null} onLeave={tutor.demo.leave} />}
            over={
              <>
                {report !== toastClosedFor && <ConfigToast error={report?.error ?? null} warnings={warnings} onClose={() => setToastClosedFor(report)} />}
                <PluginNotices notices={pluginSnap.notices} onClose={(id) => plugins.dismissNotice(id)} onAction={(id, i) => plugins.noticeAction(id, i)} />
              </>
            }
          >
            {content}
          </WindowFrame>
        </RosterApi.Provider>
      </HintsShown>
    </TypedPasswordsContext.Provider>
  );

  if (conn.state === "connecting") {
    return frame(
      <div className="screen center">
        <p className="muted starting">Starting the backend…</p>
      </div>,
    );
  }
  if (conn.state === "failed" && conn.problem.kind === "inventory-not-found") {
    // T212: no Inventory on this Box: the three ways to make one, through serve
    return frame(
      <FirstRun
        problem={conn.problem}
        create={(params) => backend.createInventory(params)}
        cancel={() => backend.cancelCreateInventory()}
        onMade={(made) =>
          void connect(true).then((ok) => {
            if (ok) say(`Made ${made.path}, the Inventory ${made.name} now${made.hosts ? ` (${countOf(made.hosts, "Host")})` : ": add Hosts with + on a group, or :discover"}.`);
          })
        }
        onRetry={() => void connect(true)}
        copy={copy}
      />,
    );
  }
  if (conn.state === "failed") {
    return frame(<ErrorScreen problem={conn.problem} note={inventories.startNote} onRetry={() => void connect(true)} copy={copy} />);
  }

  const appMode = keyState.mode === "app" && overlay.value === null;
  const spokenMessage = spokenText(message, messagesChoice.all());
  const shownMessage = shownText(message, messagesChoice.all());
  const slipShown = typeof message !== "string" && message.kind === "slip";
  const findKeys = keyHint(keymap, "find");
  // The Session on screen, for the status bar's segment: its node as in the Sidebar.
  const statusSession = (() => {
    if (!onScreenTab) return null;
    const ended = onScreenTab.status.state === "ended" || onScreenTab.status.state === "failed";
    const known = hostByName.get(onScreenTab.host);
    const connecting = connectPhase(onScreenTab) !== null;
    const dot = ended ? "ended" : connecting ? "connecting" : (onScreenTab.auth ?? (known ? hostDot(known) : "key"));
    return { label: onScreenTab.label, dot, lit: !ended && !connecting } as const;
  })();
  const cursorRow = sidebar.cursorRow();
  const progress = <PluginProgressItems progress={pluginSnap.progress} onCancel={(id) => say(plugins.cancelProgress(id))} />;
  /** The pieces the layout places at `at`, in order. The title bar is drawn by `frame` above
   * every screen (the lock and error screens too). */
  const pieces = (at: Place) =>
    placed(layout, at).map((id) => {
      if (id === "statusbar") {
        return (
          <StatusBar
            key="statusbar"
            info={conn.info}
            layout={layout}
            registries={registries}
            inventories={inventories.inventories}
            pendingCount={pendingCount}
            stale={configState.stale}
            keymap={keymap}
            leader={options.leader}
            appMode={appMode}
            pendingKeys={keyState.pending}
            progress={progress}
            run={run}
            vim={options.vim}
            session={statusSession}
            sessionCount={sessions.tabs.length}
            cursorHasMenu={Boolean(cursorRow?.menu || cursorRow?.actions?.length)}
          />
        );
      }
      if (id === "sessionbar") {
        return (
          <div key={id} className="piece" data-place={at}>
            <SessionBar box={conn.info.inventory.box} snapshot={sessions} hostByName={hostByName} run={run} />
          </div>
        );
      }
      return null;
    });
  const panelKeys = keyHint(keymap, "panel");
  // Every docked panel and view goes in a frame: docked or full window, its width, its edge.
  const framed = (id: string, title: string, kind: string, node: ReactNode, extra: { side?: "left" | "right"; fallback?: PanelPlace } = {}) => (
    <PanelFrame key={`panel:${id}`} id={id} title={title} kind={kind} layout={panelLayout} keys={panelKeys} {...extra}>
      {node}
    </PanelFrame>
  );
  const actions = { run, copy };
  const overlayProps = {
    overlay: overlay.value,
    locked: vault.locked,
    close: closeOverlay,
    run,
    commands,
    keymap,
    options,
    caps,
    hosts: conn.hosts,
    recent: appState.recentHosts,
    sessions,
    completion: {
      foldIds: sidebar.rows.filter((r) => r.foldable).map((r) => r.id),
      groupNames,
      inventoryNames: inventories.inventories?.inventories.map((i) => i.name) ?? [],
      webServices: (name: string | null) => {
        const h = hostByName.get(name ?? details.panel.value ?? selectedHost() ?? "");
        return h ? webServices(h) : [];
      },
    },
    finders: finderSources,
    finderCtx,
    say,
    live: liveHosts,
    addKeys: keyHint(keymap, "host add"),
    helpFromLine: (line: string, caret: number, topic: string) => help.fromLine(line, caret, () => run(`help ${topic}`)),
    openQuick: (to: QuickTarget) => tabs.openQuick(to),
  };

  const shell = (
    <div className={`screen app ${appMode ? "mode-app" : "mode-terminal"}`} data-view={viewMode}>
      {pieces("top")}
      <div
        className={`body sidebar-${sidebar.side}`}
        {...(sidebar.shown ? { "data-sidebar": "" } : {})}
        {...(sidebarTucked ? { "data-tucked": "" } : {})}
        {...(bodyPanels.includes("d") ? { "data-docked": "" } : {})}
        {...(bodyPanels.includes("f") ? { "data-full": "" } : {})}
      >
        {sidebar.shown && (
          <Sidebar
            sections={sidebar.sections}
            side={sidebar.side}
            cursor={appMode ? sidebar.cursor : null}
            selected={appMode ? sidebar.cursor : sidebar.selected}
            onSelect={sidebar.setSelected}
            leaderHint={options.leader}
            findKeys={findKeys}
            run={(line) => {
              // The row it's for (the one just clicked, or whose menu is open, else the cursor's)
              // hears what its command says went wrong, under it (round 20).
              sidebar.runFromRow();
              runFromUi(line);
            }}
            slip={sidebar.slip}
            onSlipDone={sidebar.clearSlip}
            treeRef={treeRef}
            menu={sidebar.menu}
            onMenu={sidebar.setMenu}
            rowMenu={(row: SidebarRow) => {
              const h = row.host === undefined ? undefined : hostByName.get(row.host);
              return hostMenu(row, {
                reviewed: h ? h.reviewed : null,
                caps,
                folders: commands.get("folder") !== undefined,
                keys: (command) => keyHint(keymap, command),
                hasSession: h !== undefined && liveHosts.has(h.name),
                openKeys: listKeyFor(keymap.list, "choose"),
              });
            }}
            onTreeFocus={keys.treeFocused}
            onTreeBlur={keys.treeBlurred}
          />
        )}
        <SessionsMain
          mainRef={mainRef}
          onPaneClick={() => setMode(terminalMode)}
          tabStrip={options.sessions === "tabs"}
          noHostsIn={conn.hosts.hosts.length === 0 ? { path: conn.info.inventory.path, caps } : null}
          findKeys={findKeys}
          addHost={sidebar.addHost}
          recent={{ box: conn.info.inventory.box, hosts: short ? recent.hosts.slice(0, 3) : recent.hosts, title: recent.title }}
          dotOf={hostDot}
          quietFind={sidebar.shown && !sidebarTucked}
          bottomLine={
            // The bottom line, as Neovim's: the message row, where the command line types too, so
            // opening it never resizes the pane or the terminal (round 10); its completions float above.
            <div className="bottom-line">
              <Overlays at="line" {...overlayProps} />
              {/* Quiet (ticket 111), a routine confirmation's short form ("Sidebar hidden") stays in the
                  line as visually hidden text, so a screen reader still hears what changed. Its line
                  is always there, as Neovim's message row is: a message coming or going never resizes
                  the pane (or the terminal, which would tell the remote side). */}
              <div className={`message-line${slipShown ? " slip" : ""}`} role="status" title={shownMessage || undefined}>
                {spokenMessage ? <span className="visually-hidden">{spokenMessage}</span> : <MessageText text={shownMessage} files={slipShown} />}
              </div>
            </div>
          }
          panes={{
            tabs,
            snapshot: sessions,
            leader: options.leader,
            terminalView,
            terminalEnv: terminal.env,
            reconnectKeys: keyHint(keymap, "reconnect"),
            closeKeys: keyHint(keymap, "close"),
            say,
            run,
            errorRows,
            copy,
            addressOf: (name) => hostByName.get(name)?.ip ?? null,
            canSave: caps.has("saveToVault") && vault.view.state === "unlocked",
            saveKeys: keyHint(keymap, "save"),
            canFill: caps.has("fill"),
            fillKeys: keyHint(keymap, "fill"),
            reveal,
          }}
        />
        {detailsHost &&
          framed(
            "details",
            "Host details",
            "details",
            <HostDetails
              host={detailsHost}
              groups={conn.hosts.groups}
              onOpen={(service, url) => openWeb(detailsHost.name, service, url)}
              onClose={details.panel.close}
              cmdlineKeys={keyHint(keymap, "cmdline")}
              leader={options.leader}
              sections={sectionsFor(detailsList, detailsHost.name)}
            />,
            { side: sidebar.side === "right" ? "left" : "right" },
          )}
        {openView &&
          framed(
            `view:${openView.id}`,
            openView.title,
            "view",
            <ViewPanel view={openView} leader={options.leader} onClose={() => viewHost.close()} graphs={graphMemory} select={viewAt.select} asked={viewAt.asked} />,
            { fallback: openView.place },
          )}
        {configActions.importing.value && (
          <ImportPanel
            preview={configActions.importing.value.preview}
            problem={configActions.importing.value.problem}
            writing={configActions.importing.value.writing}
            onClose={configActions.importing.close}
            onWrite={configActions.writeImport}
          />
        )}
        {check.check && framed("check", "Check", "check", <CheckPanel check={check.check} rows={errorRows} actions={actions} onClose={check.close} onStop={check.stop} />)}
        {hosts && (
          <Forms
            form={form}
            removing={removing}
            backend={backend}
            hosts={hosts}
            hostByName={hostByName}
            sessions={sessions}
            tabs={tabs}
            caps={caps}
            inventory={inventory}
            vaultTargets={{ choose: configures, version: targetsVersion }}
            errorRows={errorRows}
            actions={actions}
            layout={panelLayout}
            panelKeys={panelKeys}
            editKeys={keyHint(keymap, "edit")}
            leader={options.leader}
            reloadHosts={reloadHosts}
            say={say}
          />
        )}
        <SwitchPanel inventories={inventories} />
        <SignOutPanel asking={signingOut} signOut={vault.signOut} />
        <PluginLayers
          plugins={plugins}
          snapshot={pluginSnap}
          pluginsPanel={pluginsPanel}
          packagesPanel={packagesPanel}
          layout={panelLayout}
          panelKeys={panelKeys}
          safe={setPromptButton}
          restoreFocus={focus.restore}
          run={run}
        />
        {keysPanel.value &&
          framed(
            "keys",
            "Key bindings",
            "keys",
            <BindingsPanel
              rows={bindingRows(keymap, options, commands)}
              leader={options.leader}
              onClose={keysPanel.close}
              onHelp={(option) => {
                keysPanel.close();
                run(`help ${help.optionTopic(option)}`);
              }}
            />,
          )}
        {help.at.at &&
          framed(
            "help",
            "Help",
            "help",
            <HelpPanel
              view={helpView}
              snapshot={help.at}
              ctx={help.ctx}
              leader={options.leader}
              vim={options.vim}
              onFind={() => run("help")}
              onOutline={() => run("finder outline")}
              onSearch={(page, query) => tutorEvent("help_search", { page, query })}
            />,
          )}
      </div>
      {pieces("bottom")}
      {/* Progress needs a place without the status bar (Focus hides it, ticket 85): a corner. */}
      {pluginSnap.progress.length > 0 && !(["top", "bottom"] as const).some((at) => placed(layout, at).includes("statusbar")) && (
        <div className="corner-progress" role="group" aria-label="What Plugins are doing">
          {progress}
        </div>
      )}
      {hint && <ModeHint keymap={keymap} leader={options.leader} viewMode={viewMode} />}
      <Overlays at="dialog" {...overlayProps} />
    </div>
  );
  // The lock screen is the mark, this Box and one field (taste.md): how long until it locks again
  // is :help lock's to say, not a line under the field.
  return frame(
    <LockGate vault={vault} box={conn.info.inventory.box} errorRows={errorRows} copy={copy}>
      {shell}
    </LockGate>,
  );
}
