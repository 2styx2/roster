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
import { Latest } from "./app/latest";
import { Overlays, type Overlay } from "./app/Overlays";
import { PluginLayers } from "./app/PluginLayers";
import { useBuiltins } from "./app/useBuiltins";
import { useWorkspaceLife } from "./app/useWorkspaceLife";
import { WindowFrame } from "./chrome/WindowFrame";
import { useTabsConfig } from "./session/useTabsConfig";
import { useWorkspaceTheme } from "./theme/useWorkspaceTheme";
import { useMessages } from "./ui/useMessages";
import { usePluginBridge, type PluginHandlers } from "./app/usePluginBridge";
import { type Backend } from "./backend/types";
import { useConnection } from "./backend/useConnection";
import { runLine, type CommandContext, type Commands } from "./commands/table";
import { layoutWarnings } from "./config/apply";
import { ConfigToast } from "./config/ConfigToast";
import { defaultConfig } from "./config/fixture";
import { ImportPanel } from "./config/ImportPanel";
import type { ConfigReport } from "./config/types";
import { useConfigActions } from "./config/useConfigActions";
import { useConfigReport } from "./config/useConfigReport";
import { HostDetails } from "./details/HostDetails";
import { webServices } from "./details/details";
import { CheckPanel } from "./errors/CheckPanel";
import { RosterApi } from "./errors/rosterApi";
import { useCheck } from "./errors/useCheck";
import { ErrorScreen } from "./ErrorScreen";
import type { FinderContext } from "./finder/sources";
import { HelpView } from "./help/command";
import { HelpPanel } from "./help/HelpPanel";
import { optionTopic } from "./help/lookup";
import { topics } from "./help/pages";
import { useHelp } from "./help/useHelp";
import { FirstRun } from "./inventory/FirstRun";
import { inventoryActions, type Form } from "./inventory/actions";
import { Forms } from "./inventory/Forms";
import { SwitchPanel } from "./inventory/SwitchPanel";
import { useInventories } from "./inventory/useInventories";
import { useInventory } from "./inventory/useInventory";
import { BindingsPanel } from "./keyboard/BindingsPanel";
import { bindingRows } from "./keyboard/bindings";
import { terminalMode } from "./keyboard/mode";
import { useAppKeys } from "./keyboard/useAppKeys";
import { defaultOptions, keyHint, keymapOf, type CommandLine as Line, type Options } from "./keymap";
import { TypedPasswordsContext } from "./lock/forgetOnLock";
import type { Clock } from "./lock/idle";
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
import { sessionCommands } from "./session/commands";
import { SessionsMain } from "./session/SessionsMain";
import { Tabs } from "./session/tabs";
import { hostMenu } from "./sidebar/hostMenu";
import type { SidebarRow } from "./sidebar/model";
import { Sidebar } from "./sidebar/Sidebar";
import { useSidebarModel } from "./sidebar/useSidebarModel";
import { StateStore } from "./state/store";
import { fontInUse } from "./terminal/fonts";
import { defaultTerminalOptions } from "./terminal/options";
import { rendererLabel } from "./terminal/renderer";
import { TerminalView, type TerminalViewComponent } from "./terminal/TerminalView";
import { useTerminalEnv } from "./terminal/useTerminalEnv";
import { defaultAppearance, type AppearanceOptions } from "./theme/theme";
import { DemoBanner } from "./tutor/DemoBanner";
import { resumeAt, tutorPage, type TutorEvent, type TutorialDef } from "./tutor/tutor";
import { useDemo, type TutorLink } from "./tutor/useDemo";
import { shownControls, type ToolbarContext } from "./chrome/toolbar";
import { countOf } from "./ui/format";
import { HintsShown } from "./ui/hints";
import { Keys } from "./ui/Keys";
import { MESSAGES_VIEW, shownText, spokenText } from "./ui/messages";
import { useFocusReturn } from "./ui/useFocusReturn";
import { GraphMemory } from "./graph/memory";
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

  const { message, say, log: messageLog, choice: messagesChoice } = useMessages(registries, store, config?.ui.messages ?? null);

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
  const [tutorNow] = useState(() => new Latest(tutor));
  useLayoutEffect(() => tutorNow.set(tutor));
  const tutorEvent = useCallback(
    (name: string, data: TutorEvent["data"]) => {
      const link = tutorNow.get();
      if (link?.demo) link.progress.feed(link.demo.tutorial, { name, data });
    },
    [tutorNow],
  );
  const [handlers] = useState(() => new Latest(noHandlers));
  const { plugins, snapshot: pluginSnap } = usePluginBridge({
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
  const [overlay, setOverlay] = useState<Overlay>(null);
  const openCommandLine = (initial = "") => {
    if (overlay === null) focus.remember();
    setOverlay({ cmdline: initial });
  };
  const reopenLine = useCallback((line: string, caret: number) => setOverlay({ cmdline: line, caret }), []);
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
    overlayOpen: overlay !== null,
    tutorEvent,
    reopenLine,
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
  const form = usePanelState<Form>(focus);
  const keysPanel = usePanelState<true>(focus);
  const pluginsPanel = usePanelState<true>(focus);
  const packagesPanel = usePanelState<true>(focus);
  const removing = usePanelState<{ host: string; group: string }>(focus);
  const [details, setDetails] = useState<string | null>(null);

  const outputTap = useMemo(() => ({ output: plugins.output.bind(plugins) }), [plugins]);
  useTabsConfig({ tabs, caps, config, hosts: hosts?.hosts ?? [], hostByName, lockVault: vault.lock, outputTap });

  const terminal = useTerminalEnv({ options: terminalOptions, theme, keymap, platform, viewMode, layout, say });
  const sidebar = useSidebarModel({ registries, layout, sessions, hosts, hostByName, options, appState, store, caps, pending: inventory.pending, addKeys: keyHint(keymap, "host add") });
  const staysInAppMode = (line: Line) => commands.get(line.split(" ")[0] ?? "")?.staysInAppMode ?? false;
  const unlocked = ready && !vault.locked;
  const keys = useAppKeys({
    keymap,
    options,
    listening: unlocked && !suspended,
    noOverlay: overlay === null,
    focus,
    staysInAppMode,
    onAppMode: sidebar.enterCursor,
    run,
  });
  const { keyState, setMode } = keys;

  const [pickerTime] = useState(pickerTimer);
  const pickerShown = overlay === "picker" && !vault.locked;
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
  const openForm = (next: Form) => {
    if (next.kind === "changes") inventory.setPending((p) => p ?? { state: "loading" });
    form.open(next);
  };
  const closeOverlay = () => {
    setOverlay(null);
    setMode(terminalMode);
    focus.restore();
  };
  // The panels from the top down (the one drawn last is the topmost): what Esc closes first.
  const layers = (): Layer[] => [
    {
      id: "plugin-confirm",
      open: pluginSnap.confirm !== null,
      close: () => {
        plugins.answerConfirm(false);
        focus.restore();
      },
    },
    {
      id: "plugin-float",
      open: pluginSnap.float !== null,
      close: () => {
        plugins.closeFloat();
        focus.restore();
      },
    },
    { id: "view", open: openView !== undefined, close: () => viewHost.close() },
    { id: "help", open: help.at.at !== null, close: () => helpView.close() },
    { id: "plugins", open: pluginsPanel.value !== null, close: pluginsPanel.close },
    { id: "packages", open: packagesPanel.value !== null, close: packagesPanel.close },
    { id: "keys", open: keysPanel.value !== null, close: closeKeys },
    { id: "sign-out", open: signingOut.value !== null, close: signingOut.close },
    { id: "switch", open: inventories.question.value !== null, close: inventories.question.close, held: inventories.switching() },
    { id: "remove", open: removing.value !== null, close: removing.close },
    { id: "import", open: configActions.importing.value !== null, close: configActions.importing.close },
    { id: "form", open: form.value !== null, close: form.close },
    { id: "check", open: check.check !== null, close: check.close },
    { id: "details", open: details !== null, close: () => setDetails(null) },
  ];
  function closeKeys() {
    keysPanel.set(null);
    if (document.activeElement?.closest('[data-panel="keys"]')) focus.restore();
  }
  const selectedHost = () => sidebar.cursorRow()?.host ?? onScreenTab?.host ?? null;
  const { openWeb, whyNoSave, ...session } = sessionCommands({
    tabs,
    sessions,
    hostByName,
    caps,
    store,
    platform,
    say,
    currentHost: () => details ?? selectedHost(),
    openQuickPicker: () => {
      if (overlay === null) focus.remember();
      setOverlay("quick");
    },
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

  // What commands act on. Rebuilt each render, so it always sees the current state.
  const ctx: CommandContext = {
    openPicker: () => {
      if (overlay === null) focus.remember();
      if (overlay !== "picker") pickerTime.start();
      setOverlay("picker");
    },
    ...session,
    checkHost: check.checkHost,
    checkBox: check.checkBox,
    stopCheck: check.stopOwn,
    toggleSidebar: () => toggle("sidebar"),
    toggleStatusBar: () => toggle(layout.bar),
    openCommandLine,
    toggleKeys: () => (keysPanel.value ? closeKeys() : keysPanel.open(true)),
    lock: workspaceVault.lock,
    vault: workspaceVault.askSignOut,
    toTerminal: () => {
      setMode(terminalMode);
      ctx.closePanel();
    },
    closePanel: () => void closeTop(layers()),
    list: (move) => {
      if (move !== "choose") return sidebar.move(move);
      const row = sidebar.cursorRow();
      if (row) sidebar.setSelected(row.id);
      // Enter on a group, Folder or heading folds it and stays in the Sidebar.
      setMode(row && staysInAppMode(row.command) ? { mode: "app", pending: [] } : terminalMode);
      if (row) run(row.command);
    },
    fold: sidebar.fold,
    cursorRow: sidebar.cursorRow,
    rowMenu: () => {
      const row = sidebar.cursorRow();
      if (!sidebar.shown) return say("The Sidebar is hidden: show it to use a Host's menu (sidebar)");
      if (!row?.menu) return say("Only a Host's row has a menu: move the cursor to one");
      sidebar.setMenu({ row: row.id, at: null });
    },
    selectedHost,
    hostNames: () => hosts?.hosts.map((h) => h.name) ?? [],
    groupNames: () => groupNames,
    ...inventoryCmds,
    say,
    viewMode: () => viewMode,
    setViewMode: (mode) => setViewMode(mode ?? otherMode(viewMode)),
    showInfo: () => {
      if (!info) return;
      // The command too: it's the program the master password and sign-in codes go to.
      // The terminal font in use (ticket 33): the first installed one in terminal.font. The
      // renderer: the visible terminal's, or with none on screen the one terminal.renderer asks for.
      const font = fontInUse(terminalOptions.fonts, platform.fontInstalled ?? (() => null));
      const size = `${Math.round(terminal.fontSize * 100) / 100} px`;
      const inUse = terminal.renderer;
      const renderer = rendererLabel(sessions.active !== null && inUse !== null ? inUse : terminalOptions.renderer);
      const picked = pickerTime.last();
      say(
        `Backend ${info.backend} · Box ${info.inventory.box} · Inventory ${info.inventory.path} · Command ${info.command.join(" ")} · ` +
          `Terminal ${font} ${size}, ${renderer}` +
          (picked === null ? "" : ` · Picker opened in ${Math.round(picked)} ms`),
      );
    },
    details: (name) => {
      if (name === null && details !== null && hostByName.has(details)) return setDetails(null);
      const host = name ?? selectedHost();
      if (!host) return say("No Host selected: pick one in the Sidebar or open its Session, or use :info HOST");
      if (!hostByName.has(host)) return say(`No Host named ${host}`);
      setDetails(host);
    },
    saveSession: () => {
      const why = whyNoSave(onScreenTab);
      if (why !== null) return say(why);
      if (onScreenTab) openForm({ kind: "save", tab: onScreenTab.id });
    },
    switchInventory: inventories.ask,
    config: (what) => configActions.run[what](),
    openFinder: (source, query) => {
      if (!registries.finders.get(source)) return say(`No finder named ${source}`);
      if (overlay === null) focus.remember();
      setOverlay(query ? { finder: source, query } : { finder: source });
    },
  };

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
    pluginConfirm: pluginSnap.confirm?.id ?? null,
    pluginFloat: pluginSnap.float ? `${pluginSnap.float.plugin}:${pluginSnap.float.title}` : null,
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
  const detailsHost = details === null ? undefined : hostByName.get(details);
  const toolbarCtx: ToolbarContext = { pendingCount, sidebarShown: sidebar.shown, quickConnect: caps.has("quickConnect"), detailsShown: detailsHost !== undefined, plain };
  const toolbarControls = unlocked && isShown(layout, "toolbar") ? shownControls(toolbarDefs, layout.controls, toolbarCtx) : [];
  const frame = (content: ReactNode) => (
    <TypedPasswordsContext.Provider value={typed}>
      <HintsShown value={hintsShown}>
        <RosterApi.Provider value={info ? caps.api : undefined}>
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

  const appMode = keyState.mode === "app" && overlay === null;
  const spokenMessage = spokenText(message, messagesChoice.all());
  const findKeys = keyHint(keymap, "find");
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
    overlay,
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
        const h = hostByName.get(name ?? details ?? selectedHost() ?? "");
        return h ? webServices(h) : [];
      },
    },
    finders: finderSources,
    finderCtx,
    say,
    helpFromLine: (line: string, caret: number, topic: string) => help.fromLine(line, caret, () => run(`help ${topic}`)),
    openQuick: (to: QuickTarget) => tabs.openQuick(to),
  };

  const shell = (
    <div className={`screen app ${appMode ? "mode-app" : "mode-terminal"}`} data-view={viewMode}>
      {pieces("top")}
      <div
        className={`body sidebar-${sidebar.side}`}
        {...(sidebar.shown ? { "data-sidebar": "" } : {})}
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
            run={runFromUi}
            treeRef={treeRef}
            menu={sidebar.menu}
            onMenu={sidebar.setMenu}
            rowMenu={(row: SidebarRow) => {
              const h = row.host === undefined ? undefined : hostByName.get(row.host);
              return hostMenu(row, { reviewed: h ? h.reviewed : null, caps, folders: commands.get("folder") !== undefined, keys: (command) => keyHint(keymap, command) });
            }}
            onTreeFocus={(from) => {
              // Tab (or a screen reader) reached the tree: it's App mode, as after the Leader.
              if (keys.mode() !== "terminal") return;
              focus.setBeforeTree(from);
              sidebar.enterCursor();
              setMode({ mode: "app", pending: [] });
            }}
            onTreeBlur={(to) => {
              // Focus went elsewhere (Tab on, a click): keys are the terminal's again. A Host row's
              // menu is the tree's own: App mode stays while it's open.
              if (keys.mode() === "app" && to !== null && !to.closest(".picker-backdrop, .cmdline, .row-menu")) setMode(terminalMode);
            }}
          />
        )}
        <SessionsMain
          mainRef={mainRef}
          onPaneClick={() => setMode(terminalMode)}
          tabStrip={options.sessions === "tabs"}
          noHostsIn={conn.hosts.hosts.length === 0 ? conn.info.inventory.path : null}
          findKeys={findKeys}
          panes={{
            tabs,
            snapshot: sessions,
            leader: options.leader,
            terminalView,
            terminalEnv: terminal.env,
            reconnectKeys: keyHint(keymap, "reconnect"),
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
              onClose={() => setDetails(null)}
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
              onClose={closeKeys}
              onHelp={(option) => {
                closeKeys();
                run(`help ${optionTopic(option, new Set(topics(help.ctx).map((t) => t.tag)))}`);
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
      <Overlays at="line" {...overlayProps} />
      {/* Quiet (ticket 111), a routine confirmation's short form ("Sidebar hidden") stays in the
          line as visually hidden text, so a screen reader still hears what changed. */}
      <div className={spokenMessage ? "message-line visually-hidden" : "message-line"} role="status">
        {shownText(message, messagesChoice.all()) || spokenMessage}
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
  const lockKey = keyHint(keymap, "lock");
  const lockHint = (
    <>
      Locks after {options.idleLockMinutes} minutes idle.
      {lockKey && (
        <span className="key-hint">
          {" "}
          <Keys keys={lockKey} leader={options.leader} /> locks now.
        </span>
      )}
    </>
  );
  return frame(
    <LockGate vault={vault} hint={lockHint} errorRows={errorRows} copy={copy}>
      {shell}
    </LockGate>,
  );
}
