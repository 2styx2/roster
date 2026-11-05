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
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Latest } from "./app/latest";
import { usePluginBridge, type PluginHandlers } from "./app/usePluginBridge";
import { BackendCallError, type Backend, type Host, type VaultAccount } from "./backend/types";
import { useConnection } from "./backend/useConnection";
import { publishChecked } from "./backend/afterTimeout";
import { CommandLine } from "./cmdline/CommandLine";
import { registerBuiltins } from "./commands/builtins";
import { complete, runLine, type CommandContext, type Commands } from "./commands/table";
import { layoutWarnings } from "./config/apply";
import { ConfigToast } from "./config/ConfigToast";
import { defaultConfig } from "./config/fixture";
import { ImportPanel } from "./config/ImportPanel";
import type { ConfigReport } from "./config/types";
import { useConfigActions } from "./config/useConfigActions";
import { useConfigReport } from "./config/useConfigReport";
import { HostDetails } from "./details/HostDetails";
import { resolveOpen, webServices, webUrl } from "./details/details";
import { AddPanel } from "./edit/AddPanel";
import { ChangesPanel, type ChangesStep } from "./edit/ChangesPanel";
import { EditPanel } from "./edit/EditPanel";
import { afterPull } from "./edit/pull";
import { CheckPanel } from "./errors/CheckPanel";
import { RosterApi } from "./errors/rosterApi";
import { useCheck } from "./errors/useCheck";
import { ErrorScreen } from "./ErrorScreen";
import { Finder } from "./finder/Finder";
import type { FinderContext, FinderItem } from "./finder/sources";
import { HelpView } from "./help/command";
import { HelpPanel } from "./help/HelpPanel";
import { itemTopic, lineTopic, optionTopic } from "./help/lookup";
import { topics } from "./help/pages";
import { useHelp } from "./help/useHelp";
import { ConfirmPanel } from "./inventory/ConfirmPanel";
import { FirstRun } from "./inventory/FirstRun";
import { addedMessage, discardedMessage, notReviewedMessage, publishedMessage, reviewedMessage, savedMessage, savedToVaultMessage, afterChange } from "./inventory/said";
import { nothingPending } from "./inventory/store";
import { useInventories } from "./inventory/useInventories";
import { useInventory } from "./inventory/useInventory";
import { BindingsPanel } from "./keyboard/BindingsPanel";
import { bindingRows } from "./keyboard/bindings";
import { terminalMode } from "./keyboard/mode";
import { useAppKeys } from "./keyboard/useAppKeys";
import { defaultOptions, keyHint, keymapOf, keysFor, type CommandLine as Line, type Options } from "./keymap";
import { TypedPasswordsContext } from "./lock/forgetOnLock";
import type { Clock } from "./lock/idle";
import { LockGate, noAccountWords, serverName, SIGN_OUT_WHAT, signOutQuestion } from "./lock/LockScreen";
import { useWorkspaceVault } from "./lock/useWorkspaceVault";
import { NEWS_KEY, newsNote } from "./news/news";
import { NO_DEFAULTS, PanelLayout, type PanelPlace } from "./panel/layout";
import { PanelFrame } from "./panel/PanelFrame";
import { closeTop, usePanelState, type Layer } from "./panel/stack";
import { pickerTimer } from "./picker/timing";
import { Picker } from "./picker/Picker";
import { memoryPlatform } from "./platform/memory";
import type { Platform } from "./platform/types";
import { PackagesPanel, PluginConfirmPanel, PluginFloatPanel, PluginNotices, PluginProgressItems, PluginPrompt, PluginsPanel } from "./plugins/PluginsPanel";
import { SavePanel } from "./quick/SavePanel";
import { parseQuickTarget, type QuickTarget } from "./quick/target";
import { builtinRegistries, type Registries } from "./registries";
import { INTEGRATE_SAYS } from "./session/integrate";
import { SessionPanes, TabStrip } from "./session/Sessions";
import { PromptWatch } from "./session/prompt";
import { XtermPromptScreen } from "./session/promptScreen";
import { shellHooksOn } from "./session/shellHooks";
import { Tabs } from "./session/tabs";
import { hostMenu } from "./sidebar/hostMenu";
import type { SidebarRow } from "./sidebar/model";
import { Sidebar } from "./sidebar/Sidebar";
import { useSidebarModel } from "./sidebar/useSidebarModel";
import { usedHost } from "./state/appState";
import { StateStore } from "./state/store";
import { fontInUse } from "./terminal/fonts";
import { defaultTerminalOptions } from "./terminal/options";
import { rendererLabel } from "./terminal/renderer";
import { TerminalView, type TerminalViewComponent } from "./terminal/TerminalView";
import { useTerminalEnv } from "./terminal/useTerminalEnv";
import { defaultAppearance, type AppearanceOptions } from "./theme/theme";
import { chosenAppearance, stateChoiceWins, ThemeChoice } from "./theme/picker";
import { useTheme } from "./theme/useTheme";
import { DemoBanner } from "./tutor/DemoBanner";
import { resumeAt, tutorPage, type TutorEvent, type TutorialDef } from "./tutor/tutor";
import { useDemo, type TutorLink } from "./tutor/useDemo";
import { Logo } from "./chrome/Logo";
import { TitleBar } from "./chrome/TitleBar";
import { shownControls, Toolbar, type ToolbarContext } from "./chrome/toolbar";
import { countOf, errorText } from "./ui/format";
import { HintsChoice, HintsShown } from "./ui/hints";
import { Keys } from "./ui/Keys";
import { MESSAGES_VIEW, MessageLog, MessagesChoice, lineAfter, logView, quiet, shownText, spokenText, type Message } from "./ui/messages";
import { useFocusReturn } from "./ui/useFocusReturn";
import { GraphMemory } from "./graph/memory";
import { isShown, otherMode, placed, type Place } from "./view/layout";
import { SessionBar } from "./view/SessionBar";
import { StatusBar } from "./view/StatusBar";
import { useLayout } from "./view/useLayout";
import { ViewPanel } from "./view/ViewContent";
import { sectionsFor, ViewHost } from "./view/views";
import { version as APP_VERSION } from "../package.json";

/** An overlay with its own input, which takes the keys while it's open. */
type Overlay = "picker" | "quick" | { cmdline: string; caret?: number } | { finder: string; query?: string } | null;

/** The open form: one at a time (ticket 10's edit, 11's add, 15's save, the Pending changes). */
type Form = { kind: "edit"; host: string } | { kind: "add"; group: string } | { kind: "save"; tab: number } | { kind: "changes"; step: ChangesStep };

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

  // The message line, as Neovim's (ticket 111, decision Q115): init.lua's `ui.messages`, else
  // `:messages`'s choice in the State, else quiet (routine confirmations and tips don't show).
  // Every message goes into `:messages`'s history too, quiet ones included.
  const [message, setMessageNow] = useState<Message>("");
  const [messageLog] = useState(() => new MessageLog());
  const [messagesChoice] = useState(() => new MessagesChoice(store));
  messagesChoice.setConfig(config?.ui.messages ?? null);
  // A quiet message from the background (a Plugin's notice, roster's own unasked one) keeps a line
  // that shows, an error above all (decision Q162).
  const say = useCallback(
    (m: Message) => {
      setMessageNow((now) => lineAfter(now, m, messagesChoice.all()));
      messageLog.push(m);
    },
    [messageLog, messagesChoice],
  );

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
  const { vault, configures, targetsVersion, bumpTargets, typed } = useWorkspaceVault(backend, tabs, info, caps, config, {
    idleMs: options.idleLockMinutes * 60_000,
    clock,
    say,
  });
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
    () => (config && layoutsJudged ? [...configState.warnings, ...layoutWarnings(registries, config)] : configState.warnings),
    // The registries' lists are what layoutWarnings reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config, configState.warnings, layoutsJudged, registries, sectionDefs, statusDefs, toolbarDefs],
  );

  // The Theme (ticket 30, decision Q69): a preview in the `themes` finder, else the choice kept in
  // the State while it wins (init.lua leaves the Theme to it, or still names the Theme it was made
  // over), else init.lua's `theme`, else the Config's (`auto` follows the OS).
  const [themeChoice] = useState(() => new ThemeChoice(store, registries.themes));
  const preview = useSyncExternalStore(themeChoice.subscribe, themeChoice.previewing);
  const configTheme = config && config.theme !== "auto" ? config.theme : null;
  const configThemeAt = config?.lines.theme ?? null;
  // The State's choice (a registered Theme's id); appState re-renders when it changes.
  const stored = themeChoice.stored();
  const storedOver = themeChoice.storedOver();
  const chosen = useMemo(() => chosenAppearance(appearance, { configTheme, stored, storedOver, preview }), [appearance, configTheme, stored, storedOver, preview]);
  const themeInEffect = stateChoiceWins({ configTheme, stored, storedOver }) ? stored : null;
  const theme = useTheme(registries.themes, chosen, !suspended);
  useLayoutEffect(() => {
    themeChoice.setConfigTheme(configTheme, configThemeAt);
    themeChoice.setActive(theme.id);
  }, [themeChoice, configTheme, configThemeAt, theme.id]);
  // The keycap hints (iteration 3 feedback): init.lua's `ui.hints`, else `:hints`'s choice in the
  // State (appState re-renders when it changes), else shown.
  const [hintsChoice] = useState(() => new HintsChoice(store));
  hintsChoice.setConfig(config?.ui.hints ?? null);
  const hintsShown = hintsChoice.shown();
  useLayoutEffect(() => {
    if (!suspended) document.documentElement.dataset.hints = hintsShown ? "on" : "off";
  }, [hintsShown, suspended]);

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
  const { pending, pendingCount, plain, kept, gate } = inventory;
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
  const signingOut = usePanelState<VaultAccount>(focus);
  const [details, setDetails] = useState<string | null>(null);
  const editing = form.value?.kind === "edit" ? form.value.host : null;

  // What Sessions work with: a password Host whose vault turns out locked (session.prepare code 14)
  // brings up the lock screen, and the tab opens by itself once it's unlocked again; Plugins hear
  // every Session's output; a new Host's key is asked about; shell hooks (ticket 121) and prompt
  // fills (ticket 119), a nested ssh's (ticket 120) read at the shell's C mark against the
  // Inventory as it is then.
  const lockVault = vault.lock;
  const asksAboutKeys = caps.has("hostKey");
  const shellHooksInit = config?.terminal.shellHooks ?? null;
  const canFill = caps.has("fill");
  const canNestedFill = caps.has("nestedFill");
  const [inventoryNow] = useState(() => new Latest<readonly Host[]>([]));
  useLayoutEffect(() => inventoryNow.set(hosts?.hosts ?? []));
  useEffect(() => {
    tabs.configure({
      onVaultLocked: () => void lockVault(),
      outputTap: { output: (id, host, data, size) => plugins.output(id, host, data, size) },
      asksAboutKeys,
      shellHooks: {
        on: (tab) => shellHooksOn(shellHooksInit, tab.quick ? undefined : hostByName.get(tab.host)?.shell_hooks),
        screen: (size) => new XtermPromptScreen(size),
      },
      fillPrompts: canFill
        ? {
            userOf: (host) => hostByName.get(host)?.ssh.user ?? null,
            watch: (size, user, nonce) => new PromptWatch(size, user, { hosts: inventoryNow.get, fill: canNestedFill }, nonce),
          }
        : null,
    });
    return () => tabs.configure({ outputTap: null });
  }, [tabs, plugins, lockVault, asksAboutKeys, shellHooksInit, hostByName, canFill, canNestedFill, inventoryNow]);

  const terminal = useTerminalEnv({ options: terminalOptions, theme, keymap, platform, viewMode, layout, say });
  const sidebar = useSidebarModel({ registries, layout, sessions, hosts, hostByName, options, appState, store, caps, pending, addKeys: keyHint(keymap, "host add") });
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
  const openHost = (host: string, here: boolean) => {
    const current = tabs.snapshot().active;
    if (!(here && current !== null && tabs.reconnect(current, host))) tabs.open(host);
    store.update((s) => usedHost(s, host));
  };
  /** Hands a web service's URL to the default browser (ticket 18): http or https only, checked
   * here and again in the Tauri shell. */
  const openWeb = (host: string, service: string, url: string) => {
    const checked = webUrl(url);
    if (!checked) return say(`${host}'s ${service} has no http or https URL to open`);
    if (!platform.openUrl) return say(`There's no browser to hand ${checked} to here`);
    platform.openUrl(checked).then(
      () => say(quiet(`Opened ${host}'s ${service} in the browser`, `Opened ${host}'s ${service} in the browser: ${checked}`)),
      (e: unknown) => say(`Couldn't open ${checked}: ${errorText(e)}`),
    );
  };
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

  // What commands act on. Rebuilt each render, so it always sees the current state.
  const ctx: CommandContext = {
    openPicker: () => {
      if (overlay === null) focus.remember();
      if (overlay !== "picker") pickerTime.start();
      setOverlay("picker");
    },
    connect: (name, here = false) => {
      const host = hostByName.get(name);
      if (!host && parseQuickTarget(name)) return ctx.quickConnect(name);
      if (!host) return say(`No Host named ${name}`);
      if (!host.reviewed) return say(notReviewedMessage(name, caps.has("add")));
      openHost(name, here);
    },
    quickConnect: (text) => {
      if (!caps.has("quickConnect")) return say(caps.needsNewer("quickConnect"));
      if (text === null) {
        if (overlay === null) focus.remember();
        return setOverlay("quick");
      }
      const to = parseQuickTarget(text);
      if (!to) return say(`${text} isn't a Quick Connect address: type user@address, or user@address:port`);
      tabs.openQuick(to);
    },
    // A Host, or a web service in the default browser (ticket 18, decision Q71).
    open: (arg) => {
      const to = resolveOpen(arg, hostByName, details ?? selectedHost(), sessions.tabs.map((t) => t.host));
      if (to.kind === "error") return say(to.message);
      if (to.kind === "web") return openWeb(to.host, to.service, to.url);
      const tab = sessions.tabs.find((t) => t.host === to.host);
      if (tab) tabs.select(tab.id);
      else ctx.connect(to.host);
    },
    reconnect: () => {
      if (sessions.active !== null) tabs.reconnect(sessions.active);
    },
    checkHost: check.checkHost,
    checkBox: check.checkBox,
    stopCheck: check.stopOwn,
    sessionOnScreen: () => (onScreenTab ? { host: onScreenTab.host, quick: Boolean(onScreenTab.quick) } : null),
    selectRelative: (delta) => tabs.selectRelative(delta),
    selectNth: (n) => tabs.selectNth(n),
    close: (n) => {
      const id = n === null ? sessions.active : (sessions.tabs[n - 1]?.id ?? null);
      if (id !== null) tabs.close(id);
    },
    toggleSidebar: () => toggle("sidebar"),
    toggleStatusBar: () => toggle(layout.bar),
    openCommandLine,
    toggleKeys: () => (keysPanel.value ? closeKeys() : keysPanel.open(true)),
    lock: () => {
      if (!vault.lock()) say("Nothing to lock: no Host Login uses a vault with a master password.");
    },
    vault: () => {
      if (!caps.has("signOut")) return say(caps.needsNewer("signOut"));
      // Ask roster who the CLI is signed in as now: a sign-in from the lock screen doesn't say.
      backend.vaultStatus().then(
        (s) => {
          if (!s.provider) return say("Nothing to sign out of: no Host Login uses a vault with an account.");
          if (!s.can_sign_out) return say(noAccountWords(s.provider));
          if (!s.account) return say("The vault CLI isn't signed in on this Box, so there's no account to sign out of.");
          signingOut.open(s.account);
        },
        (e: unknown) => say(`Couldn't ask the vault who's signed in: ${errorText(e)}`),
      );
    },
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
    inventory: (op) => {
      if (!caps.has("live")) return say(caps.needsNewer("live"));
      if (op.op === "remove") {
        const h = hostByName.get(op.host);
        if (!h) return say(`No Host named ${op.host}`);
        return removing.open({ host: h.name, group: h.group });
      }
      if (op.op === "group-delete" && op.to === undefined) {
        const members = hosts?.hosts.filter((h) => h.group === op.group) ?? [];
        if (members.length > 0) {
          // Where should they go? The command line asks, with the groups to complete.
          if (groupNames.every((g) => g === op.group)) {
            return say(`${op.group} has ${countOf(members.length, "Host")} and there's no other group for them: make one first (:group new)`);
          }
          openCommandLine(`group delete ${op.group} `);
          return say(`${op.group} has ${countOf(members.length, "Host")}: name the group they move to (Tab completes), or Esc to keep it`);
        }
      }
      void inventory.run(op);
    },
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
    edit: (name) => {
      const host = name ?? selectedHost();
      if (!host) return say("edit needs a Host name (no Host is selected)");
      if (!hostByName.has(host)) return say(`No Host named ${host}`);
      if (!caps.has("edit")) return say(caps.needsNewer("edit"));
      openForm({ kind: "edit", host });
    },
    addHost: (inGroup) => {
      if (!caps.has("add")) return say(caps.needsNewer("add"));
      const at = selectedHost();
      openForm({ kind: "add", group: inGroup ?? (at && hostByName.get(at)?.group) ?? Object.keys(hosts?.groups ?? {})[0] ?? "" });
    },
    integrate: () => {
      if (!onScreenTab) return say("No Session to integrate: open one first.");
      const label = onScreenTab.label;
      void tabs.integrate(onScreenTab.id).then((r) => say(INTEGRATE_SAYS[r](label)));
    },
    saveSession: () => {
      if (!caps.has("saveToVault")) return say(caps.needsNewer("saveToVault"));
      const tab = onScreenTab;
      if (!tab?.save) return say("Nothing to save: tick Save to vault when you type a Session's password.");
      if (tab.save.saved !== null) return say(`Already saved as ${tab.save.saved}.`);
      if (!tab.save.loggedIn) return say(`${tab.host} hasn't logged in yet: roster saves the password only after it works.`);
      openForm({ kind: "save", tab: tab.id });
    },
    fillPrompt: () => {
      if (!canFill) return say(caps.needsNewer("fill"));
      const id = sessions.active;
      if (id === null) return say("No Session to fill");
      tabs.fill(id).then(
        (host) => say(quiet(`Filled ${host}'s password`)),
        (e: unknown) => {
          const fix = e instanceof BackendCallError ? e.data?.["fix"] : undefined;
          say(typeof fix === "string" && fix ? `${errorText(e)} - ${fix}` : errorText(e));
        },
      );
    },
    review: (name, reviewed = true) => {
      const verb = reviewed ? "review" : "unreview";
      const host = name ?? selectedHost();
      if (!host) return say(`${verb} needs a Host name (no Host is selected)`);
      const h = hostByName.get(host);
      if (!h) return say(`No Host named ${host}`);
      if (!caps.has("add")) return say(caps.needsNewer("review", `:${verb}`));
      if (!reviewed && !caps.has("unreview")) return say(caps.needsNewer("unreview"));
      const already = reviewed ? `${host} is already reviewed.` : `${host} isn't reviewed.`;
      if (h.reviewed === reviewed) return say(already);
      backend.reviewHost(host, reviewed).then(
        (r) => {
          reloadHosts();
          inventory.refreshPending();
          say(r.changed ? reviewedMessage(host, reviewed, plain, kept, afterChange(r)) : already);
        },
        (e: unknown) => say(`Couldn't mark ${host} ${reviewed ? "reviewed" : "unreviewed"}: ${errorText(e)}`),
      );
    },
    showChanges: (then) => {
      if (!caps.has("edit")) return say(caps.needsNewer("changes"));
      if (plain && info) return say(nothingPending(info.inventory));
      if (then === "publish" && !caps.has("publish")) return say(caps.needsNewer("publish"));
      inventory.refreshPending();
      openForm({ kind: "changes", step: then ?? "diff" });
    },
    switchInventory: inventories.ask,
    pull: () => {
      if (!caps.has("edit")) return say(caps.needsNewer("pull"));
      say(quiet("Pulling the infra repo…"));
      gate.pull().then(
        (r) =>
          say(
            !r.upstream
              ? "This branch has no upstream: nothing to pull."
              : r.updated
                ? `Pulled ${countOf(r.commits, "commit")} from ${r.upstream}${afterPull(r)}.`
                : `Up to date with ${r.upstream}.`,
          ),
        (e: unknown) => say(`Couldn't pull: ${errorText(e)}`),
      );
    },
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
  const [panelOpeners] = useState(() => new Latest({ plugins: () => {}, packages: () => {}, tutorial: (def: TutorialDef) => void def }));
  useLayoutEffect(() =>
    panelOpeners.set({
      plugins: () => pluginsPanel.open(true),
      packages: () => packagesPanel.open(true),
      tutorial: (def) => {
        const anchor = tutor ? resumeAt(def, tutor.progress.done(def.id)) : undefined;
        helpView.open({ page: tutorPage(def.id), ...(anchor ? { anchor } : {}) });
      },
    }),
  );
  useEffect(
    () =>
      registerBuiltins(registries, {
        help: helpView,
        theme: themeChoice,
        hints: hintsChoice,
        messages: { choice: messagesChoice, log: messageLog, open: () => viewHost.open(MESSAGES_VIEW) },
        views: viewHost,
        panels: panelLayout,
        plugins: { manager: plugins, openPlugins: () => panelOpeners.get().plugins(), openPackages: () => panelOpeners.get().packages() },
        // `:tutor` (ticket 55): starts a tutorial on the demo Inventory, or, on it, opens the page again.
        tutor: tutor
          ? {
              start: (def) =>
                tutor.demo
                  ? def.id === tutor.demo.tutorial.id
                    ? panelOpeners.get().tutorial(def)
                    : tutor.demo.switchTo(def)
                  : tutor.start?.(def, plugins.forDemo()),
              quit: () => {
                if (!tutor.demo) return false;
                tutor.demo.leave();
                return true;
              },
              reset: (def) => {
                tutor.progress.reset(def.id);
                if (tutor.demo?.tutorial.id === def.id) panelOpeners.get().tutorial(def);
              },
            }
          : null,
      }),
    [registries, helpView, themeChoice, hintsChoice, messagesChoice, messageLog, viewHost, panelLayout, plugins, panelOpeners, tutor],
  );
  // `:messages`'s view: the new list goes in before the old one comes out, so an open one stays open.
  const loggedMessages = useSyncExternalStore(messageLog.subscribe, messageLog.snapshot);
  const [messagesView] = useState(() => new Latest<(() => void) | null>(null));
  useEffect(() => {
    const remove = registries.views.register(logView(loggedMessages));
    messagesView.get()?.();
    messagesView.set(remove);
  }, [registries, loggedMessages, messagesView]);
  useEffect(
    () => () => {
      messagesView.get()?.();
      messagesView.set(null);
    },
    [registries, messagesView],
  );
  const configPanel = config?.panel;
  const configViews = config?.views;
  useEffect(() => {
    const views = Object.fromEntries(
      Object.entries(configViews ?? {}).map(([id, v]) => [id, { ...(v.place ? { place: v.place } : {}), ...(v.width !== null ? { width: v.width } : {}) }]),
    );
    panelLayout.setDefaults(configPanel || configViews ? { width: configPanel?.width ?? null, views } : NO_DEFAULTS);
  }, [panelLayout, configPanel, configViews]);

  // The State file, once: what changed before it was read (Hosts picked) is replayed over it; and
  // what's new (ticket 47), said once after an upgrade when the workspace first shows.
  const [newsLine, setNewsLine] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void store.load().then(() => {
      const { note, seen } = newsNote(store.snapshot(), appVersion);
      if (store.get(NEWS_KEY) !== seen) store.set(NEWS_KEY, seen);
      if (note && live) setNewsLine(note);
    });
    return () => {
      live = false;
    };
  }, [store, appVersion]);
  // The window's size and place go in the State; the Tauri shell restores them at the next start.
  useEffect(() => platform.window?.watchGeometry((g) => store.set("window", g)), [platform, store]);
  useEffect(() => {
    if (!unlocked || !newsLine) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- saying it once the workspace shows is the effect
    say(newsLine);
    setNewsLine(null);
  }, [unlocked, newsLine, say]);
  // A fixture's Sessions open once the app is first unlocked, as if the user had opened them.
  const [opened] = useState(() => new Latest(false));
  useEffect(() => {
    if (!unlocked || opened.get() || !openAtStart) return;
    opened.set(true);
    for (const host of openAtStart) tabs.open(host);
  }, [unlocked, openAtStart, tabs, opened]);
  // On the demo Inventory: the tutorial running is the demo's too (a Plugin's isn't registered in
  // the demo's registries), and once the demo is up its page opens where you left off.
  const demoTutorial = tutor?.demo?.tutorial ?? null;
  useEffect(() => {
    if (demoTutorial && registries.tutorials.get(demoTutorial.id) !== demoTutorial) return registries.tutorials.register(demoTutorial);
  }, [registries, demoTutorial]);
  useEffect(() => {
    if (unlocked && demoTutorial) panelOpeners.get().tutorial(demoTutorial);
  }, [unlocked, demoTutorial, panelOpeners]);
  // Closing the app ends every Session.
  useEffect(() => () => tabs.closeAll(), [tabs]);

  // Where the keys go. A Plugin's prompt that came up behind the lock screen (a Package init.lua
  // names, at start) keeps them, on its safe choice, so Esc answers it and a stray Enter installs
  // nothing (ticket 56, decision Q87); this workspace's own prompt: the demo's never reaches for yours.
  const [promptButton] = useState(() => new Latest<HTMLButtonElement | null>(null));
  const keysHome = useCallback(() => focus.toMain(promptButton.get()), [promptButton, focus]);
  useEffect(() => {
    if (unlocked) keysHome();
  }, [unlocked, keysHome]);
  // With the last Session closed, the keys need somewhere to go.
  const noSessions = sessions.tabs.length === 0;
  useEffect(() => {
    if (noSessions && (document.activeElement === document.body || document.activeElement === null)) focus.toMain();
  }, [noSessions, focus]);
  // Back from the demo Inventory: the keys come back here.
  const [wasSuspended] = useState(() => new Latest(suspended));
  useEffect(() => {
    if (wasSuspended.get() && !suspended) keysHome();
    wasSuspended.set(suspended);
  }, [suspended, wasSuspended, keysHome]);
  // A Plugin's question (ticket 78) or float (ticket 91) takes the keys; answering or closing puts
  // them back where they were. Before the panel's own effect focuses its button (layout effects
  // run first), and only when a new one comes up.
  const confirmId = pluginSnap.confirm?.id ?? null;
  useLayoutEffect(() => {
    if (confirmId !== null && !document.activeElement?.closest(".plugin-confirm")) focus.remember();
  }, [confirmId, focus]);
  const floatKey = pluginSnap.float ? `${pluginSnap.float.plugin}:${pluginSnap.float.title}` : null;
  useLayoutEffect(() => {
    if (floatKey !== null && !document.activeElement?.closest(".plugin-float")) focus.remember();
  }, [floatKey, focus]);

  // The custom title bar (decision Q32) sits above every screen, the lock screen too, so the window
  // can always be moved and closed; the view mode's layout says whether it shows at all. The
  // toolbar (decision Q65) is in it once the app is ready and unlocked, else a bar of its own.
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
  const toolbar = (side: "start" | "end") => (
    <Toolbar controls={toolbarControls} ctx={toolbarCtx} keysFor={(command) => keyHint(keymap, command)} leader={options.leader} run={runFromUi} side={side} />
  );
  const frame = (content: ReactNode) => (
    <TypedPasswordsContext.Provider value={typed}>
      <HintsShown value={hintsShown}>
        <RosterApi.Provider value={info ? caps.api : undefined}>
          <div className="window">
            {isShown(layout, "titlebar") && <TitleBar controls={platform.window} start={toolbar("start")} end={toolbar("end")} />}
            {!isShown(layout, "titlebar") && toolbarControls.length > 0 && (
              <div className="toolbar-bar" data-tauri-drag-region>
                {toolbar("start")}
                <div className="titlebar-fill" />
                {toolbar("end")}
              </div>
            )}
            {tutor?.demo && <DemoBanner tutorial={tutor.demo.tutorial} done={tutorCtx?.done(tutor.demo.tutorial.id) ?? null} onLeave={tutor.demo.leave} />}
            <div className="window-body">{content}</div>
            {report !== toastClosedFor && <ConfigToast error={report?.error ?? null} warnings={warnings} onClose={() => setToastClosedFor(report)} />}
            <PluginNotices notices={pluginSnap.notices} onClose={(id) => plugins.dismissNotice(id)} onAction={(id, i) => plugins.noticeAction(id, i)} />
          </div>
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
  const modeKeys = [keyHint(keymap, "mode"), keyHint(keymap, "focus"), ...keysFor(keymap, "mode", { leader: false }), ...keysFor(keymap, "focus", { leader: false })].filter(
    (k): k is string => k !== null,
  );
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
  const finderSource = overlay !== null && typeof overlay === "object" && "finder" in overlay ? finderSources.find((s) => s.id === overlay.finder) : undefined;
  const panelKeys = keyHint(keymap, "panel");
  // Every docked panel and view goes in a frame: docked or full window, its width, its edge.
  const framed = (id: string, title: string, kind: string, node: ReactNode, extra: { side?: "left" | "right"; fallback?: PanelPlace } = {}) => (
    <PanelFrame key={`panel:${id}`} id={id} title={title} kind={kind} layout={panelLayout} keys={panelKeys} {...extra}>
      {node}
    </PanelFrame>
  );
  const formDone = (said: Message) => {
    form.close();
    reloadHosts();
    inventory.refreshPending();
    say(said);
  };
  const closeFormAndRun = (line: Line) => {
    form.close();
    run(line);
  };
  const actions = { run, copy };
  const saveId = form.value?.kind === "save" ? form.value.tab : null;
  const saveTab = sessions.tabs.find((t) => t.id === saveId) ?? null;
  const editHost = editing === null ? undefined : hostByName.get(editing);

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
        <main
          className="workspace"
          ref={mainRef}
          tabIndex={-1}
          aria-label="Workspace"
          onMouseDown={(e) => {
            if ((e.target as HTMLElement).closest(".pane")) setMode(terminalMode);
          }}
        >
          {options.sessions === "tabs" && !noSessions && <TabStrip snapshot={sessions} run={run} />}
          {noSessions && conn.hosts.hosts.length === 0 ? (
            // Nothing to find yet: say where Hosts come from (S7), not "Find a Host".
            <div className="empty">
              <Logo size={48} className="empty-mark" />
              <p className="empty-title">No Hosts in the Inventory yet.</p>
              <p className="empty-hint">
                Add them to <code>{conn.info.inventory.path}</code> and they show up here.
              </p>
            </div>
          ) : noSessions ? (
            <div className="empty">
              <Logo size={48} className="empty-mark" />
              <p className="empty-title">No Sessions open</p>
              <button type="button" className="find primary" onMouseDown={(e) => e.preventDefault()} onClick={() => run("find")}>
                Find a Host
              </button>
              {findKeys && (
                <p className="empty-hint key-hint">
                  or press <Keys keys={findKeys} leader={options.leader} />
                </p>
              )}
            </div>
          ) : (
            <SessionPanes
              tabs={tabs}
              snapshot={sessions}
              leader={options.leader}
              terminalView={terminalView}
              terminalEnv={terminal.env}
              reconnectKeys={keyHint(keymap, "reconnect")}
              run={run}
              errorRows={errorRows}
              copy={copy}
              addressOf={(name) => hostByName.get(name)?.ip ?? null}
              canSave={caps.has("saveToVault") && vault.view.state === "unlocked"}
              saveKeys={keyHint(keymap, "save")}
              canFill={canFill}
              fillKeys={keyHint(keymap, "fill")}
              reveal={reveal}
            />
          )}
        </main>
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
        {editHost &&
          framed(
            "edit",
            "Edit",
            "edit",
            <EditPanel
              key={editHost.name}
              backend={backend}
              host={editHost}
              pendingCount={pendingCount}
              rows={errorRows}
              actions={actions}
              pull={gate}
              onSaved={(update) => formDone(savedMessage(update, plain))}
              onClose={form.close}
              {...(caps.has("add") ? { onReview: (name: string) => closeFormAndRun(`review ${name}`) } : {})}
              {...(caps.has("unreview") ? { onUnreview: (name: string) => closeFormAndRun(`host unreview ${name}`) } : {})}
            />,
          )}
        {form.value?.kind === "add" &&
          hosts &&
          framed(
            "add",
            "Add a Host",
            "add",
            <AddPanel
              backend={backend}
              hosts={hosts}
              group={form.value.group}
              pendingCount={pendingCount}
              rows={errorRows}
              actions={actions}
              pull={gate}
              chooseTarget={configures}
              fillFromItem={caps.has("itemFields")}
              targetsVersion={targetsVersion}
              onAdded={(r) => formDone(addedMessage(r, plain, kept))}
              onClose={form.close}
            />,
          )}
        {saveTab?.save &&
          hosts &&
          framed(
            "save",
            "Save to vault",
            "save",
            <SavePanel
              key={saveTab.id}
              plain={plain}
              backend={backend}
              hosts={hosts}
              what={
                saveTab.quick
                  ? { quick: { id: saveTab.save.held, to: saveTab.quick.to, hostname: saveTab.save.hostname } }
                  : { host: { held: saveTab.save.held, name: saveTab.host } }
              }
              group={Object.keys(hosts.groups)[0] ?? ""}
              pendingCount={pendingCount}
              rows={errorRows}
              actions={actions}
              pull={gate}
              chooseTarget={configures}
              targetsVersion={targetsVersion}
              onSaved={(r) => {
                tabs.saved(saveTab.id, r.host.name);
                formDone(savedToVaultMessage(r, plain, kept));
              }}
              onClose={form.close}
            />,
          )}
        {form.value?.kind === "changes" &&
          pending &&
          framed(
            "changes",
            "Pending changes",
            "changes",
            <ChangesPanel
              key={form.value.step}
              changes={pending}
              step={form.value.step}
              editKeys={keyHint(keymap, "edit")}
              leader={options.leader}
              canPublish={caps.has("publish")}
              rows={errorRows}
              actions={actions}
              onDiscard={async () => {
                try {
                  say(discardedMessage(await backend.discardChanges()));
                } catch (e) {
                  say(`Couldn't discard: ${errorText(e)}`);
                }
                reloadHosts();
                inventory.refreshPending();
              }}
              onPublish={async (text) => {
                // After a timeout, publishChecked asks roster whether it was published, and says so.
                const r = await publishChecked(backend, text);
                reloadHosts();
                inventory.refreshPending();
                say(publishedMessage(r));
                return r;
              }}
              onClose={form.close}
            />,
          )}
        {removing.value && (
          <ConfirmPanel
            key={removing.value.host}
            title={`Remove ${removing.value.host}?`}
            body={
              <>
                <code>{removing.value.host}</code> leaves group {removing.value.group} in roster.yml,{" "}
                {plain ? "saved straight away (roster keeps the file as it was in roster.yml.bak)." : "as a Pending change you can discard until it’s Published."} Its vault
                item, if it has one, stays in the vault.
              </>
            }
            action="Remove"
            onConfirm={async () => {
              const host = removing.value?.host ?? "";
              await inventory.run({ op: "remove", host });
              removing.close();
            }}
            onClose={removing.close}
          />
        )}
        {inventories.question.value && (
          <ConfirmPanel
            key={inventories.question.value.to}
            title="Switch Inventory"
            body={inventories.question.value.body}
            more={inventories.question.value.more}
            action={inventories.question.value.action}
            keep={inventories.question.value.action === null ? "Close" : "Stay"}
            danger={false}
            onConfirm={inventories.confirm}
            onClose={inventories.question.close}
          />
        )}
        {signingOut.value && (
          <ConfirmPanel
            title={signOutQuestion(signingOut.value)}
            body={
              <>
                {SIGN_OUT_WHAT} Server: <span className="mono">{serverName(signingOut.value.server)}</span>. The app locks and shows the sign-in form; open
                Sessions keep running behind it.
              </>
            }
            action="Sign out"
            onConfirm={async () => {
              const account = signingOut.value;
              signingOut.set(null);
              if (account) await vault.signOut(account);
            }}
            onClose={signingOut.close}
          />
        )}
        {pluginSnap.prompts[0] && (
          <PluginPrompt
            key={`${pluginSnap.prompts[0].kind}:${pluginSnap.prompts[0].manifest.name}:${pluginSnap.prompts[0].package?.commit ?? ""}`}
            prompt={pluginSnap.prompts[0]}
            safe={(el) => promptButton.set(el)}
            onAnswer={(allow) => {
              const prompt = pluginSnap.prompts[0];
              if (prompt) void plugins.answer(prompt, allow);
              focus.restore();
            }}
          />
        )}
        {pluginsPanel.value &&
          framed(
            "plugins",
            "Plugins",
            "plugins",
            <PluginsPanel
              snapshot={pluginSnap}
              onGrant={(name, perm, on) => void plugins.setGrant(name, perm, on)}
              onClose={pluginsPanel.close}
              onRefresh={() => void plugins.refreshRequests()}
              onOpen={() => void plugins.refreshData()}
              onRun={run}
            />,
          )}
        {packagesPanel.value && framed("packages", "Packages", "packages", <PackagesPanel snapshot={pluginSnap} onClose={packagesPanel.close} onRun={run} />)}
        {pluginSnap.confirm && (
          <PluginConfirmPanel
            key={pluginSnap.confirm.id}
            confirm={pluginSnap.confirm}
            onAnswer={(yes) => {
              plugins.answerConfirm(yes);
              focus.restore();
            }}
          />
        )}
        {pluginSnap.float && (
          <PluginFloatPanel
            key={pluginSnap.float.plugin}
            float={pluginSnap.float}
            onAction={(i) => plugins.floatAction(i)}
            onLink={(i) => plugins.openLink(i)}
            onClose={() => {
              plugins.closeFloat();
              focus.restore();
            }}
          />
        )}
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
      {overlay !== null && typeof overlay === "object" && "cmdline" in overlay && (
        <CommandLine
          key={overlay.cmdline}
          initial={overlay.cmdline}
          complete={(input) =>
            complete(commands, input, hosts?.hosts.map((h) => h.name) ?? [], {
              foldIds: sidebar.rows.filter((r) => r.foldable).map((r) => r.id),
              sessions: sessions.tabs.map((t) => t.host),
              groupNames,
              inventoryNames: inventories.inventories?.inventories.map((i) => i.name) ?? [],
              webServices: (name) => {
                const h = hostByName.get(name ?? details ?? selectedHost() ?? "");
                return h ? webServices(h) : [];
              },
            })
          }
          describe={(candidate) => {
            // A command name: its label and key. A Session's number: its Host.
            const [id = "", arg = ""] = candidate.split(" ");
            const command = commands.get(id);
            if (command && arg === "") return { label: command.label(), keys: keyHint(keymap, id) };
            const tab = command?.arg === "number" ? sessions.tabs[Number(arg) - 1] : undefined;
            return tab ? { label: tab.host, keys: null } : null;
          }}
          keys={keymap.cmdline}
          leader={options.leader}
          {...(overlay.caret !== undefined ? { caret: overlay.caret } : {})}
          onHelp={(line, caret) => {
            const topic = lineTopic(commands, line);
            if (!topic) return say(`No command starts with ${line.trim().split(/\s+/)[0]}: Tab lists them`);
            closeOverlay();
            help.fromLine(line, caret, () => run(`help ${topic}`));
          }}
          onClose={closeOverlay}
          onRun={(line) => {
            closeOverlay();
            run(line);
          }}
        />
      )}
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
      {hint && modeKeys.length > 0 && (
        <div className="mode-hint key-hint" role="status" aria-label={`How to leave ${viewMode === "focus" ? "Focus" : "this mode"}`}>
          {/* Two ways out, not one sequence: "␣ m or F11", never "␣ m F11". */}
          {modeKeys.map((k, i) => (
            <Fragment key={k}>
              {i > 0 && <span className="muted"> or </span>}
              <Keys keys={k} leader={options.leader} />
            </Fragment>
          ))}{" "}
          leave {viewMode === "focus" ? "Focus" : "this mode"}
        </div>
      )}
      {finderSource && finderCtx && !vault.locked && (
        <Finder
          key={finderSource.id}
          source={finderSource}
          {...(typeof overlay === "object" && overlay && "finder" in overlay && overlay.query ? { initialQuery: overlay.query } : {})}
          ctx={finderCtx}
          keymap={keymap}
          vim={options.vim}
          onClose={closeOverlay}
          onChoose={(item: FinderItem) => {
            closeOverlay();
            run(item.command);
          }}
          onHelp={(item: FinderItem) => {
            const topic = itemTopic(commands, finderSource, item);
            closeOverlay();
            run(topic ? `help ${topic}` : "help");
          }}
        />
      )}
      {(overlay === "picker" || overlay === "quick") && !vault.locked && (
        <Picker
          quickFirst={overlay === "quick"}
          {...(caps.has("quickConnect")
            ? {
                onQuick: (to: QuickTarget) => {
                  closeOverlay();
                  tabs.openQuick(to);
                },
              }
            : {})}
          hosts={conn.hosts}
          recent={appState.recentHosts}
          vim={options.vim}
          keymap={keymap}
          onClose={closeOverlay}
          onOpen={(host, how) => {
            closeOverlay();
            run(`${how?.here ? "here" : "connect"} ${host.name}`);
          }}
          onInfo={(host: Host) => {
            closeOverlay();
            run(`info ${host.name}`);
          }}
          onHelp={(topic: string) => {
            closeOverlay();
            run(`help ${topic}`);
          }}
          {...(caps.has("add")
            ? {
                onReview: (host: Host) => {
                  closeOverlay();
                  run(`review ${host.name}`);
                },
              }
            : {})}
        />
      )}
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
