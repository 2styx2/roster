// The app shell: connect to the Backend, then the view mode's layout (view/layout.ts): Standard
// has the Sidebar and the status bar around the Sessions' terminals (or an empty state); Focus is
// fullscreen with only the terminal and, if asked for, the session bar. The Key bindings panel,
// the check panel, the command line, the Picker and the Finder work the same in both. A Backend
// that can't start gets an error screen that says what to fix.
//
// Keys: the focus-mode machine (keyboard/mode.ts) decides whether a key is the terminal's or the
// app's; the app's keys are command lines run through the one command table (commands/table.ts),
// which is also what the command line and every button run. The commands, keymap and Sidebar
// sections are registries (ADR 0006), read live.
import {
  Fragment,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ADD_API_VERSION,
  UNREVIEW_API_VERSION,
  BackendStartError,
  CHECK_API_VERSION,
  BOX_CHECK_API_VERSION,
  EDIT_API_VERSION,
  PUBLISH_API_VERSION,
  LIVE_API_VERSION,
  LiveError,
  BackendCallError,
  type Backend,
  type BackendInfo,
  type BackendProblem,
  type Host,
  type HostList,
  type SaveTarget,
  VAULT_CONFIG_API_VERSION,
  HOST_KEY_API_VERSION,
  QUICK_CONNECT_API_VERSION,
  SAVE_TO_VAULT_API_VERSION,
  SIGN_OUT_API_VERSION,
  type VaultAccount,
  type VaultSettings,
} from "./backend/types";
import { publishChecked } from "./backend/afterTimeout";
import { CommandLine } from "./cmdline/CommandLine";
import { complete, runLine, type CommandContext, type Commands, type FoldHow } from "./commands/table";
import { deriveConfig, registerConfig, type ConfigWarning } from "./config/apply";
import { ConfigToast } from "./config/ConfigToast";
import { initLuaReloader } from "./config/source";
import type { ConfigReport, ImportPreview } from "./config/types";
import { vaultSettingsOf } from "./config/vault";
import { ImportPanel } from "./config/ImportPanel";
import { registerFolders } from "./folders/folders";
import { FOLDERS_FILE, FoldersFile } from "./folders/file";
import type { InventoryOp } from "./inventory/commands";
import { ConfirmPanel } from "./inventory/ConfirmPanel";
import type { InventoryFileError } from "./backend/types";
import { ErrorScreen } from "./ErrorScreen";
import { Finder } from "./finder/Finder";
import type { FinderContext, FinderItem } from "./finder/sources";
import { CheckPanel, type CheckState } from "./errors/CheckPanel";
import { ChangesPanel, type ChangesState, type ChangesStep } from "./edit/ChangesPanel";
import { AddPanel } from "./edit/AddPanel";
import { EditPanel } from "./edit/EditPanel";
import { TitleBar } from "./chrome/TitleBar";
import { shownControls, Toolbar, type ToolbarContext } from "./chrome/toolbar";
import { BindingsPanel } from "./keyboard/BindingsPanel";
import { HelpView, registerHelp } from "./help/command";
import { HelpPanel } from "./help/HelpPanel";
import { NEWS_KEY, newsNote } from "./news/news";
import { version as APP_VERSION } from "../package.json";
import { itemTopic, lineTopic, optionTopic } from "./help/lookup";
import { helpContext, topics } from "./help/pages";
import { defaultConfig } from "./config/fixture";
import { bindingRows } from "./keyboard/bindings";
import { press, terminalMode, type KeyState } from "./keyboard/mode";
import { realClock, type Clock } from "./lock/idle";
import { pullGate } from "./edit/pull";
import { LockGate, noAccountWords, serverName, SIGN_OUT_WHAT, signOutQuestion } from "./lock/LockScreen";
import { useVault } from "./lock/useVault";
import { actionsOf, chordOf, defaultOptions, keymapOf, type CommandLine as Line, type Keymap, type Options } from "./keymap";
import { Picker } from "./picker/Picker";
import { builtinRegistries, type Registries } from "./registries";
import { BUILTIN } from "./registry";
import { SessionPanes, TabStrip } from "./session/Sessions";
import { parseQuickTarget, type QuickTarget } from "./quick/target";
import { SavePanel } from "./quick/SavePanel";
import { HostDetails } from "./details/HostDetails";
import { resolveOpen, webServices, webUrl } from "./details/details";
import { Tabs } from "./session/tabs";
import { allRows, moveCursor, Sidebar } from "./sidebar/Sidebar";
import { sectionBuilder } from "./sidebar/sections";
import { packagesCommand, pluginsCommand } from "./plugins/command";
import { PluginManager } from "./plugins/manager";
import { PackagesPanel, PluginFloatPanel, PluginNotices, PluginPrompt, PluginsPanel } from "./plugins/PluginsPanel";
import { badgesByHost } from "./view/status";
import { TerminalView, type TerminalEnv, type TerminalViewComponent } from "./terminal/TerminalView";
import { rendererLabel, type RendererInUse } from "./terminal/renderer";
import { pickerTimer } from "./picker/timing";
import { isLeaderKey } from "./terminal/keys";
import { fontFound, fontInUse } from "./terminal/fonts";
import { runHealth, type HealthContext, type HealthReport } from "./health/health";
import { defaultTerminalOptions, zoom, type TerminalOptions, type ZoomAction } from "./terminal/options";
import { memoryPlatform } from "./platform/memory";
import type { Platform } from "./platform/types";
import { setFolded, usedHost } from "./state/appState";
import { StateStore } from "./state/store";
import { tutorCommand } from "./tutor/command";
import { DemoBanner } from "./tutor/DemoBanner";
import { demoBackend, demoPlatform } from "./tutor/demo";
import { resumeAt, TutorProgress, tutorPage, type TutorEvent, type TutorialDef } from "./tutor/tutor";
import { defaultAppearance, terminalTheme, type AppearanceOptions } from "./theme/theme";
import { chosenAppearance, registerThemePicker, stateChoiceWins, ThemeChoice } from "./theme/picker";
import { useTheme } from "./theme/useTheme";
import { Logo } from "./chrome/Logo";
import { countOf } from "./ui/format";
import { HintsChoice, HintsShown, registerHints } from "./ui/hints";
import { Keys } from "./ui/Keys";
import {
  defaultLayouts,
  isShown,
  otherMode,
  pick,
  pieceToggled,
  placed,
  STATUS_SEGMENTS,
  togglePiece,
  type Layouts,
  type Place,
  type ViewMode,
} from "./view/layout";
import { SessionBar } from "./view/SessionBar";

type Conn =
  | { state: "connecting" }
  | { state: "failed"; problem: BackendProblem }
  | { state: "ready"; info: BackendInfo; hosts: HostList };

/** An overlay with its own input, which takes the keys while it's open. */
type Overlay = "picker" | "quick" | { cmdline: string; caret?: number } | { finder: string; query?: string } | null;

/** How long the hint on entering a mode stays. */
const HINT_MS = 2000;

const noSubscribe = () => () => {};
const noSnapshot = () => undefined;

const MODIFIERS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock"]);

function asProblem(e: unknown): BackendProblem {
  if (e instanceof BackendStartError) return e.problem;
  const message = e instanceof Error ? e.message : String(e);
  return { kind: "failed", message, hint: "Retry, or run the backend command in a terminal to see why.", detail: null };
}

/** The first key bound to `line` after the Leader, as the status bar hints write it. */
function hintFor(keymap: Keymap, line: Line): string | null {
  const key = Object.entries(keymap.leader).find(([, b]) => b.action === line)?.[0];
  return key ? `␣ ${key}` : null;
}

/** The global keys (no Leader) bound to any of `lines`. */
function globalKeysFor(keymap: Keymap, lines: readonly Line[]): string[] {
  return Object.entries(keymap.global)
    .filter(([, b]) => lines.includes(b.action))
    .map(([k]) => k);
}

export interface AppProps {
  backend: Backend;
  options?: Options;
  /** Commands, keymap and Sidebar sections; the built-ins unless a test (or ticket 21) passes its own. */
  registries?: Registries;
  /** For the idle lock; tests pass a manual one. */
  clock?: Clock;
  /** The terminal each Session draws in (tests pass a stub; xterm needs a real browser). */
  terminalView?: TerminalViewComponent;
  terminalOptions?: TerminalOptions;
  /** Theme, fonts and the title bar (ticket 09); the Config's later (ticket 21). */
  appearance?: AppearanceOptions;
  /** The State file, clipboard, Windows build, window controls and fullscreen (tests: an in-memory one). */
  platform?: Platform;
  /** The per-mode layout table (decision Q39); the defaults from the options unless ticket 21's
   * Config passes its own. */
  layouts?: Layouts;
  /** Hosts to open Sessions to once the Backend is up, in order (a fixture's open Sessions: the
   * dev page's `?fixture=worst-case`, and the UI tests), once the app is first unlocked. */
  openAtStart?: readonly string[];
  /** This build's version (package.json's), for what's new after an upgrade (ticket 47); tests
   * pass their own. */
  appVersion?: string;
  /** The Config as the app starts (ticket 21): it replaces `options`, `appearance`,
   * `terminalOptions` and `layouts`, and its keys, Themes and Folders go into the registries.
   * Later saves come through `platform.config`. */
  config?: ConfigReport | null;
}

/** What a workspace knows of `:tutor` (ticket 55): the progress (in the real State), and either
 * how to start a tutorial (the real workspace) or the one running on the demo Inventory. */
interface TutorLink {
  progress: TutorProgress;
  start?(tutorial: TutorialDef): void;
  demo?: { tutorial: TutorialDef; leave(): void; switchTo(tutorial: TutorialDef): void };
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
  const [progress] = useState(() => new TutorProgress(store));
  // The tutorial asked for, and the demo it runs on once its fake Backend has loaded.
  const [tutorial, setTutorial] = useState<TutorialDef | null>(null);
  const [loaded, setLoaded] = useState<{ backend: Backend; platform: Platform } | null>(null);
  useEffect(() => {
    if (!tutorial || loaded) return;
    let live = true;
    void demoBackend().then((backend) => {
      if (live) setLoaded({ backend, platform: demoPlatform(platform, (k) => store.get(k)) });
    });
    return () => {
      live = false;
    };
  }, [tutorial, loaded, platform, store]);
  // Another tutorial while one runs: the same demo, the new tutorial.
  const start = useCallback((def: TutorialDef) => setTutorial(def), []);
  const leave = useCallback(() => {
    setTutorial(null);
    setLoaded(null);
  }, []);
  const demo = tutorial && loaded ? { tutorial, ...loaded } : null;
  const real = useMemo(() => ({ progress, start }), [progress, start]);
  const inDemo = useMemo(() => (tutorial ? { progress, demo: { tutorial, leave, switchTo: start } } : null), [tutorial, progress, leave, start]);
  return (
    <>
      <div className="app-slot" hidden={demo !== null} inert={demo !== null}>
        <Workspace {...props} platform={platform} store={store} tutor={real} suspended={demo !== null} />
      </div>
      {demo && inDemo && (
        <div className="app-slot">
          <Workspace
            backend={demo.backend}
            platform={demo.platform}
            config={props.config ?? null}
            tutor={inDemo}
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
  terminalOptions: terminalOptionsProp = defaultTerminalOptions,
  platform: platformProp,
  appearance: appearanceProp = defaultAppearance,
  layouts: layoutsProp,
  openAtStart,
  config: configProp = null,
  appVersion = APP_VERSION,
  store: storeProp,
  tutor,
  suspended = false,
}: WorkspaceProps) {
  const [registries] = useState(() => given ?? builtinRegistries());
  const [platform] = useState(() => platformProp ?? memoryPlatform());

  // The Config (ticket 21): the one the app started with, then each save's. A broken save comes
  // with the last good Config and the error, so nothing changes but the toast.
  const [report, setReport] = useState<ConfigReport | null>(configProp);
  /** Config files saved since their last reload and not applied yet ("init.lua", "folders.yml",
   * "roster.yml"): the status bar's quiet hint to `:source` (decision Q58). */
  const [stale, setStaleFiles] = useState<readonly string[]>([]);
  const setStale = useCallback((file: string, on: boolean) => {
    setStaleFiles((s) => (s.includes(file) === on ? s : on ? [...s, file] : s.filter((f) => f !== file)));
  }, []);
  // The newest report wins: one that arrives late (or twice) never replaces a newer one.
  const takeReport = useCallback(
    (r: ConfigReport) => setReport((cur) => (cur && cur.version >= r.version ? cur : r)),
    [],
  );
  useEffect(() => {
    const source = platform.config;
    if (!source) return;
    const take = (r: ConfigReport) => {
      setStale("init.lua", false);
      takeReport(r);
    };
    let live = true;
    // Listen first, then ask again: a save between main.tsx's load and now isn't lost.
    const stopChanges = source.watch(take);
    // A save that wasn't applied (auto_reload off, decision Q58): a quiet hint to :source.
    const stopStale = source.watchStale(() => setStale("init.lua", true));
    const stop = () => {
      stopChanges();
      stopStale();
    };
    source.load().then(
      (r) => {
        if (live && r) take(r);
      },
      () => {},
    );
    return () => {
      live = false;
      stop();
    };
  }, [platform, takeReport, setStale]);
  const config = report?.config ?? null;
  const derived = useMemo(() => (config ? deriveConfig(config) : null), [config]);
  const options = derived?.options ?? optionsProp;
  const appearance = derived?.appearance ?? appearanceProp;
  const terminalOptions = derived?.terminalOptions ?? terminalOptionsProp;
  // Keys, Themes and Folders go through the registries as "init.lua"; the next Config replaces
  // them. Before paint, so a custom Theme never flashes the default.
  const [warnings, setWarnings] = useState<readonly ConfigWarning[]>([]);
  useLayoutEffect(() => {
    if (!config) return;
    const registered = registerConfig(registries, config);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- what registering found is its result
    setWarnings(registered.warnings);
    return registered.dispose;
  }, [registries, config]);
  const [toastClosedFor, setToastClosedFor] = useState<ConfigReport | null>(null);

  const commandList = useSyncExternalStore(registries.commands.subscribe, registries.commands.list);
  const bindingList = useSyncExternalStore(registries.keymap.subscribe, registries.keymap.list);
  const sectionDefs = useSyncExternalStore(registries.sidebar.subscribe, registries.sidebar.list);
  const errorRows = useSyncExternalStore(registries.errors.subscribe, registries.errors.list);
  const finderSources = useSyncExternalStore(registries.finders.subscribe, registries.finders.list);
  const toolbarDefs = useSyncExternalStore(registries.toolbar.subscribe, registries.toolbar.list);
  const commands: Commands = useMemo(
    () => ({ get: (id) => registries.commands.get(id), list: () => commandList }),
    [registries, commandList],
  );
  const keymap = useMemo(() => keymapOf(bindingList), [bindingList]);

  const [conn, setConn] = useState<Conn>({ state: "connecting" });
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const [check, setCheck] = useState<CheckState | null>(null);
  // `:check` with no Host (ticket 49): this Box's health, shown as `:help health`.
  const [health, setHealth] = useState<HealthReport | null>(null);
  const healthRun = useRef(0);
  /** `:config import-terminal`'s diff, while it's open (ticket 33). */
  const [importing, setImporting] = useState<{ preview: ImportPreview; problem: string | null; writing: boolean } | null>(null);
  const checkRun = useRef(0);
  // Ticket 10: the edit form (a Host's name), the Pending changes panel, and the last count.
  const [editing, setEditing] = useState<string | null>(null);
  const [changesView, setChangesView] = useState<{ step: ChangesStep } | null>(null);
  const [pending, setPending] = useState<ChangesState | null>(null);
  // Ticket 11: the add-Host form, with the group it starts in.
  const [adding, setAdding] = useState<{ group: string } | null>(null);
  // Ticket 15: "Save to vault" for a Session's typed password, once it logged in (the tab's id).
  const [saving, setSaving] = useState<number | null>(null);
  // Ticket 18: the Host details panel's Host (closed: null).
  const [details, setDetails] = useState<string | null>(null);
  // Ticket 28: removing a Host asks first.
  const [confirming, setConfirming] = useState<{ host: string; group: string } | null>(null);
  // Ticket 42: `:vault signout` asks first, naming the account.
  const [signingOut, setSigningOut] = useState<VaultAccount | null>(null);
  const [keyState, setKeyState] = useState<KeyState>(terminalMode);
  const keyRef = useRef<KeyState>(terminalMode);
  const [cursor, setCursor] = useState<string | null>(null);
  // The Sidebar's selected row (decision Q88): the one last clicked, or where j/k left the cursor.
  // Its buttons show; in App mode the cursor row is the selected one.
  const [selected, setSelected] = useState<string | null>(null);
  const moveTo = (id: string | null) => {
    setCursor(id);
    setSelected(id);
  };
  const [viewMode, setViewMode] = useState<ViewMode>(options.defaultMode);
  const [layouts, setLayouts] = useState<Layouts>(() => layoutsProp ?? derived?.layouts ?? defaultLayouts(options));
  // A Config whose layouts differ replaces them (and what `␣ e` / `␣ s` toggled); one that only
  // changed a colour keeps them.
  const modesKey = config ? JSON.stringify(config.modes) : null;
  const [layoutsFrom, setLayoutsFrom] = useState(modesKey);
  if (modesKey !== layoutsFrom) {
    setLayoutsFrom(modesKey);
    if (derived) setLayouts(derived.layouts);
  }
  const [hint, setHint] = useState(false);
  const [message, setMessage] = useState("");
  const [store] = useState(() => storeProp ?? new StateStore(platform));
  const appState = useSyncExternalStore(store.subscribe, store.snapshot);
  // The Sidebar shown or hidden (issue #78): what the toggle chose is kept in the State, per mode,
  // unless init.lua sets `modes.<mode>.sidebar`, which wins.
  const configSetsSidebar = config?.modes[viewMode].set?.includes("sidebar") ?? false;
  const storedSidebar = sidebarChoice(appState, viewMode);
  const layout = useMemo(() => {
    const base = layouts[viewMode];
    if (configSetsSidebar || storedSidebar === null || isShown(base, "sidebar") === storedSidebar) return base;
    return togglePiece(base, "sidebar");
  }, [layouts, viewMode, configSetsSidebar, storedSidebar]);
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
  const chosen = useMemo(
    () => chosenAppearance(appearance, { configTheme, stored, storedOver, preview }),
    [appearance, configTheme, stored, storedOver, preview],
  );
  const themeInEffect = stateChoiceWins({ configTheme, stored, storedOver }) ? stored : null;
  const theme = useTheme(registries.themes, chosen, !suspended);
  useLayoutEffect(() => {
    themeChoice.setConfigTheme(configTheme, configThemeAt);
    themeChoice.setActive(theme.id);
  }, [themeChoice, configTheme, configThemeAt, theme.id]);
  // The keycap hints (iteration 3 feedback): init.lua's `ui.hints`, else `:hints`'s choice in the
  // State (appState re-renders when it changes), else shown.
  const [hintsChoice] = useState(() => new HintsChoice(store));
  const configHints = config?.ui.hints ?? null;
  hintsChoice.setConfig(configHints);
  const hintsShown = hintsChoice.shown();
  useLayoutEffect(() => {
    if (!suspended) document.documentElement.dataset.hints = hintsShown ? "on" : "off";
  }, [hintsShown, suspended]);
  const [fontSize, setFontSize] = useState(terminalOptions.fontSize);
  // A new size in the Config is a new zoom reset point, and where the font goes now.
  const [sizeFrom, setSizeFrom] = useState(terminalOptions.fontSize);
  if (terminalOptions.fontSize !== sizeFrom) {
    setSizeFrom(terminalOptions.fontSize);
    setFontSize(terminalOptions.fontSize);
  }
  const [windowsBuild, setWindowsBuild] = useState<number | null>(null);
  const [tabs] = useState(() => new Tabs(backend));
  const sessions = useSyncExternalStore(tabs.subscribe, tabs.snapshot);
  // Plugins (ticket 23): the Lua runs in roster-core; they act on the app through command lines,
  // and their UI goes into the registries with their name as its source.
  const runRef = useRef<(line: string) => void>(() => {});
  const [plugins] = useState(
    () => new PluginManager(backend, registries, store, {
        run: (line) => runRef.current(line),
        send: (id, text) => tabs.write(id, text),
        copy: (text) => platform.clipboard.writeText(text),
      }),
  );
  const pluginSnap = useSyncExternalStore(plugins.subscribe, plugins.snapshot);
  const statusDefs = useSyncExternalStore(registries.status.subscribe, registries.status.list);
  const badgeList = useSyncExternalStore(registries.badges.subscribe, registries.badges.list);
  const hostBadges = useMemo(() => badgesByHost(badgeList), [badgeList]);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const openPlugins = useRef(() => {});
  useEffect(() => registries.commands.register(pluginsCommand(plugins, () => openPlugins.current())), [registries, plugins]);
  // `:tutor` (ticket 55): starts a tutorial on the demo Inventory, or, on it, opens the page again.
  const openTutorial = useRef((def: TutorialDef) => void def);
  useEffect(() => {
    if (!tutor) return;
    return registries.commands.register(
      tutorCommand(registries.tutorials, {
        start: (def) => (tutor.demo ? (def.id === tutor.demo.tutorial.id ? openTutorial.current(def) : tutor.demo.switchTo(def)) : tutor.start?.(def)),
        quit: () => {
          if (!tutor.demo) return false;
          tutor.demo.leave();
          return true;
        },
        reset: (def) => {
          tutor.progress.reset(def.id);
          if (tutor.demo?.tutorial.id === def.id) openTutorial.current(def);
        },
      }),
    );
  }, [registries, tutor]);
  // Packages (ticket 24): `:packages`, and a sync whenever init.lua's `packages` change.
  const [packagesOpen, setPackagesOpen] = useState(false);
  const openPackages = useRef(() => {});
  useEffect(() => registries.commands.register(packagesCommand(plugins, () => openPackages.current())), [registries, plugins]);
  useEffect(() => {
    tabs.setOutputTap({ output: (id, host, data) => plugins.output(id, host, data), resized: (id) => plugins.resized(id) });
    return () => tabs.setOutputTap(null);
  }, [tabs, plugins]);
  // `:tutor` (ticket 55): on the demo Inventory, what happens is fed to the tutorial running, whose
  // steps tick themselves; what a step ticks is said once (the page shows it as a ✓).
  const tutorRef = useRef(tutor);
  tutorRef.current = tutor;
  const tutorEvent = useCallback((name: string, data: TutorEvent["data"]) => {
    const link = tutorRef.current;
    if (link?.demo) link.progress.feed(link.demo.tutorial, { name, data });
  }, []);
  // Sessions opening and ending, and the Session on screen, as Plugin events.
  const seenTabs = useRef(new Map<number, "live" | "ended">());
  useEffect(() => {
    const before = seenTabs.current;
    const now = new Map<number, "live" | "ended">();
    for (const t of sessions.tabs) {
      const ended = t.status.state === "ended" || t.status.state === "failed";
      now.set(t.id, ended ? "ended" : "live");
      if (!ended && before.get(t.id) !== "live") {
        // A Quick Connect Session's `host` is nil to a Plugin: it isn't a Host of the Inventory.
        void plugins.event("session_open", { session: t.id, host: t.quick ? null : t.host });
        tutorEvent("session_open", { host: t.host });
      }
      if (ended && before.get(t.id) === "live") {
        const code = t.status.state === "ended" ? t.status.exit.code : null;
        void plugins.event("session_exit", { session: t.id, host: t.quick ? null : t.host, code });
        tutorEvent("session_exit", { host: t.host, code });
      }
    }
    for (const [id, was] of before) {
      if (!now.has(id) && was === "live") void plugins.event("session_exit", { session: id, host: null, code: null });
    }
    seenTabs.current = now;
  }, [sessions.tabs, plugins, tutorEvent]);
  const onScreenTab = sessions.tabs.find((t) => t.id === sessions.active);
  const onScreenHost = onScreenTab?.host ?? null;
  // A Quick Connect Session isn't on a Host: Plugins hear `host_selected` only for a Host's.
  const onScreenQuick = Boolean(onScreenTab?.quick);
  useEffect(() => {
    if (!onScreenHost) return;
    if (!onScreenQuick) void plugins.event("host_selected", { host: onScreenHost });
    tutorEvent("host_selected", { host: onScreenHost });
  }, [onScreenHost, onScreenQuick, plugins, tutorEvent]);
  const saveTab = sessions.tabs.find((t) => t.id === saving) ?? null;
  const mainRef = useRef<HTMLElement>(null);
  /** The safe choice of this workspace's Plugin prompt, while one is up. */
  const promptRef = useRef<HTMLButtonElement | null>(null);
  const setPromptButton = useCallback((el: HTMLButtonElement | null) => {
    promptRef.current = el;
  }, []);
  const returnFocus = useRef<Element | null>(null);
  // init.lua's vault settings reach roster (`vault.configure`, API 10; tickets 35 and 41) before the
  // lock screen asks where the vault stands (a KeePassXC database may be init.lua's), and again on
  // every `:source`.
  const connInfo = conn.state === "ready" ? conn.info : null;
  const configuresVault = connInfo !== null && connInfo.inventory.api_version >= VAULT_CONFIG_API_VERSION;
  const vaultSettingsKey = JSON.stringify(vaultSettingsOf(config?.vault));
  const [vaultConfiguredFor, setVaultConfiguredFor] = useState<BackendInfo | null>(null);
  /** Goes up when where "Save to vault" can go may have changed (ticket 35): the add form lists again. */
  const [targetsVersion, bumpTargets] = useReducer((n: number) => n + 1, 0);
  const vaultActive = connInfo !== null && (!configuresVault || vaultConfiguredFor === connInfo);
  const vault = useVault(backend, vaultActive, { idleMs: options.idleLockMinutes * 60_000, clock });
  const checkVault = vault.check;
  useEffect(() => {
    if (!connInfo || !configuresVault) return;
    let live = true;
    backend.configureVault(JSON.parse(vaultSettingsKey) as VaultSettings).then(
      (r) => {
        if (!live) return;
        setVaultConfiguredFor(connInfo);
        bumpTargets();
        // A KeePassXC database that changed forgot the master password: the lock screen again.
        if (r.locked.length) void checkVault();
        // A setting roster can't use is left out on its own; the rest apply.
        const refused = (r.refused ?? []).map((x) => `roster left out init.lua's vault.${x.setting}: ${x.message}`);
        if (refused.length) setMessage(refused.join(" "));
      },
      (e: unknown) => {
        if (!live) return;
        setVaultConfiguredFor(connInfo);
        setMessage(`roster didn't take init.lua's vault settings: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
    return () => {
      live = false;
    };
  }, [backend, connInfo, configuresVault, vaultSettingsKey, checkVault]);
  // A password Host whose vault turns out locked (session.prepare code 14) brings up the lock
  // screen; the tab opens by itself once the vault is unlocked again.
  // `vault` is a new object each render; its `lock` is stable, so the handler is set once.
  const lockVault = vault.lock;
  useEffect(() => tabs.setVaultLockedHandler(() => void lockVault()), [tabs, lockVault]);
  const asksAboutKeys = conn.state === "ready" && conn.info.inventory.api_version >= HOST_KEY_API_VERSION;
  const quickConnects = conn.state === "ready" && conn.info.inventory.api_version >= QUICK_CONNECT_API_VERSION;
  useEffect(() => tabs.setAsksAboutKeys(asksAboutKeys), [tabs, asksAboutKeys]);
  const vaultUnlocked = vault.view.state === "unlocked";
  const backendReady = conn.state === "ready";
  useEffect(() => {
    if (backendReady) void plugins.start();
  }, [backendReady, plugins]);
  const packagesKey = JSON.stringify(config?.packages ?? []);
  useEffect(() => {
    if (backendReady) void plugins.syncPackages();
  }, [backendReady, plugins, packagesKey]);
  useEffect(() => {
    void plugins.event(vault.locked ? "lock" : "unlock");
  }, [vault.locked, plugins]);
  useEffect(() => {
    if (vaultUnlocked) tabs.resumeAfterUnlock();
  }, [vaultUnlocked, tabs]);

  const hosts = conn.state === "ready" ? conn.hosts : null;
  // Each new Host list the app gets is an `inventory_changed` for the Plugins (the Host count).
  const firstHosts = useRef<typeof hosts>(null);
  useEffect(() => {
    if (!hosts) return;
    if (firstHosts.current === null) firstHosts.current = hosts;
    else void plugins.event("inventory_changed");
  }, [hosts, plugins]);
  const hostByName = useMemo(() => new Map((hosts?.hosts ?? []).map((h) => [h.name, h])), [hosts]);
  const groupNames = useMemo(() => {
    const names = Object.keys(hosts?.groups ?? {});
    for (const h of hosts?.hosts ?? []) if (!names.includes(h.group)) names.push(h.group);
    return names;
  }, [hosts]);
  const folded = useMemo(() => new Set(appState.folded), [appState.folded]);
  // The Live Inventory (ticket 28, API 8): what's added and not Published yet shows dimmed.
  const canLiveNow = conn.state === "ready" && conn.info.inventory.api_version >= LIVE_API_VERSION;
  const canUnreview = conn.state === "ready" && conn.info.inventory.api_version >= UNREVIEW_API_VERSION;
  const live = useMemo(() => {
    if (!canLiveNow) return undefined;
    const changes = pending?.state === "done" ? pending.changes : null;
    return {
      pendingHosts: new Set((changes?.hosts ?? []).filter((c) => c.change === "added").map((c) => c.host)),
      // A review that's still only a Pending change can be taken back from the same ✓ (issue #78).
      pendingReviews: canUnreview
        ? new Set((changes?.hosts ?? []).filter((c) => c.change === "changed" && c.fields.includes("reviewed")).map((c) => c.host))
        : new Set<string>(),
      pendingGroups: new Set((changes?.groups ?? []).filter((c) => c.change === "added").map((c) => c.group)),
    };
  }, [canLiveNow, canUnreview, pending]);
  // The mode's layout may pick and order the Sidebar's sections (decision Q39).
  const shownSectionDefs = useMemo(
    () => (layout.sections ? [...pick(sectionDefs, layout.sections)].map((d, i) => ({ ...d, order: i })) : sectionDefs),
    [sectionDefs, layout.sections],
  );
  // The Inventory heading's "Add a Host" (iteration 3 feedback): its keys, or why it can't.
  const addApi = conn.state === "ready" ? conn.info.inventory.api_version : 0;
  const addTooOld = `Adding a Host needs a newer roster (API version ${ADD_API_VERSION}; this one speaks ${addApi})`;
  const addKeys = hintFor(keymap, "host add");
  const addHost = useMemo(
    () => ({ keys: addKeys, tooOld: addApi >= ADD_API_VERSION ? null : addTooOld }),
    [addKeys, addApi, addTooOld],
  );
  // Kept between renders: a Session's events rebuild only the sections that show Sessions (#62).
  const [buildSections] = useState(sectionBuilder);
  const sections = useMemo(
    () =>
      hosts
        ? buildSections(shownSectionDefs, {
            sessions,
            hosts,
            hostByName,
            sessionsIn: options.sessions,
            state: appState,
            folded,
            ...(live ? { live } : {}),
            addHost,
            badges: hostBadges,
          })
        : [],
    [buildSections, shownSectionDefs, sessions, hosts, hostByName, options.sessions, appState, folded, live, addHost, hostBadges],
  );
  const rows = useMemo(() => allRows(sections), [sections]);
  const sidebarAt = layout.pieces.find((p) => p.id === "sidebar")?.at;
  const sidebarSide = sidebarAt === "right" ? "right" : "left";
  const sidebarShown = isShown(layout, "sidebar") && sections.length > 0;
  const finderCtx = useMemo<FinderContext | null>(
    () =>
      hosts
        ? {
            sessions,
            hosts,
            hostByName,
            sessionsIn: options.sessions,
            state: appState,
            folded,
            recent: appState.recentHosts,
            sidebar: sectionDefs,
          }
        : null,
    [sessions, hosts, hostByName, options.sessions, appState, folded, sectionDefs],
  );

  // The window follows the mode: OS fullscreen, or not (only when that changes).
  const fullscreen = useRef(false);
  useEffect(() => {
    if (fullscreen.current === layout.fullscreen) return;
    fullscreen.current = layout.fullscreen;
    platform.setFullscreen(layout.fullscreen).catch(() => {});
  }, [layout.fullscreen, platform]);

  // The hint on entering a mode that has one, for HINT_MS.
  const hintClock = clock ?? realClock;
  const showsHint = layout.hint;
  useEffect(() => {
    if (!showsHint) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- showing it is the effect
    setHint(true);
    const timer = hintClock.setTimeout(() => setHint(false), HINT_MS);
    return () => {
      hintClock.clearTimeout(timer);
      setHint(false);
    };
  }, [viewMode, showsHint, hintClock]);

  const connect = useCallback(
    async (restart: boolean) => {
      setConn({ state: "connecting" });
      try {
        const info = await backend.connect(restart ? { restart: true } : undefined);
        const hosts = await backend.listHosts();
        setConn({ state: "ready", info, hosts });
        const leftOut = servicesLeftOut(hosts);
        if (leftOut) setMessage(leftOut);
      } catch (e) {
        setConn({ state: "failed", problem: asProblem(e) });
      }
    },
    [backend],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- connecting is the effect
    void connect(false);
  }, [connect]);

  // Which roster runs (init.lua's `backend` and `roster_command`, ticket 19): the core reads them
  // when it starts serve, so a reload that changes either starts serve again, on the new Backend
  // (WSL to Windows and back). The first Config is the one the start used. Open Sessions keep
  // running where they are; the vault locks, since the new serve has never been unlocked.
  const backendPlan = config ? JSON.stringify([config.backend, config.rosterCommand]) : null;
  const startedPlan = useRef<string | null>(null);
  useEffect(() => {
    if (backendPlan === null) return;
    if (startedPlan.current === null || startedPlan.current === backendPlan) {
      startedPlan.current = backendPlan;
      return;
    }
    startedPlan.current = backendPlan;
    void connect(true);
  }, [backendPlan, connect]);

  // Pending changes (ticket 10): asked for once the Backend is up, and after every edit, discard
  // and pull. A roster older than API 5 has none to show.
  const apiVersion = conn.state === "ready" ? conn.info.inventory.api_version : 0;
  const canEdit = apiVersion >= EDIT_API_VERSION;
  const canPublish = apiVersion >= PUBLISH_API_VERSION;
  const canAdd = apiVersion >= ADD_API_VERSION;
  const canLive = apiVersion >= LIVE_API_VERSION;
  const canSave = apiVersion >= SAVE_TO_VAULT_API_VERSION && vault.view.state === "unlocked";
  const refreshPending = useCallback(() => {
    if (!canEdit) return;
    backend.pendingChanges().then(
      (changes) => setPending({ state: "done", changes }),
      (e: unknown) => setPending({ state: "error", message: e instanceof Error ? e.message : String(e) }),
    );
  }, [backend, canEdit]);
  useEffect(() => refreshPending(), [refreshPending]);
  /** The Inventory again, after roster.yml changed (an edit, a discard, a pull, an outside edit).
   * It updates in place: folds, the cursor and open Sessions stay. */
  const reloadHosts = useCallback(() => {
    backend.listHosts().then(
      (hosts) => {
        setConn((c) => (c.state === "ready" ? { ...c, hosts } : c));
        const leftOut = servicesLeftOut(hosts);
        if (leftOut) setMessage(leftOut);
      },
      () => {},
    );
  }, [backend]);

  // The pull before an Inventory write (decision Q88): one gate per Backend, shared by the forms
  // and `:pull`, so a pull within `pull_fresh_minutes` isn't repeated and one running is joined.
  const pullWindow = useRef(options.pullFreshMinutes);
  const pullClock = useRef(clock ?? realClock);
  const reloadRef = useRef(reloadHosts);
  useEffect(() => {
    pullWindow.current = options.pullFreshMinutes;
    pullClock.current = clock ?? realClock;
    reloadRef.current = reloadHosts;
  });
  const gate = useMemo(
    () =>
      pullGate(() => backend.pullInventory(), {
        windowMs: () => pullWindow.current * 60_000,
        now: () => pullClock.current.now(),
        onUpdated: () => reloadRef.current(),
      }),
    [backend],
  );

  // roster.yml edited outside the app (ticket 28, decision Q58): serve applies it with
  // auto_reload (the Sidebar follows), else only says so, for `:source`. A file that doesn't load
  // keeps the last good Inventory and says the line.
  const autoReload = config?.autoReload ?? false;
  useEffect(() => {
    if (conn.state !== "ready" || !canLive) return;
    const stop = backend.onInventoryChanged((change) => {
      if (!change.applied) return setStale("roster.yml", true);
      setStale("roster.yml", false);
      reloadHosts();
      refreshPending();
      bumpTargets();
      if (change.error) setMessage(inventoryBroken(change.error));
    });
    backend.watchInventory(autoReload).catch(() => {});
    return stop;
  }, [backend, conn.state, canLive, autoReload, reloadHosts, refreshPending, setStale]);
  // `:source` reloads roster.yml too.
  useEffect(() => {
    if (!canLive) return;
    return registries.reloaders.register({
      id: "roster.yml",
      source: BUILTIN,
      describe: "roster.yml (the Inventory)",
      files: () => ["roster.yml"],
      owns: (p) => /(^|[\\/])roster\.yml$/.test(p.trim()),
      async reload() {
        const r = await backend.reloadInventory();
        setStale("roster.yml", false);
        reloadHosts();
        refreshPending();
        bumpTargets();
        return r.error ? inventoryBroken(r.error) : null;
      },
    });
  }, [registries, backend, canLive, reloadHosts, refreshPending, setStale]);
  const pendingCount = pending?.state === "done" ? pending.changes.count : 0;

  // The State file and the Windows build, once. What changed before the file was read (Hosts
  // picked) is replayed over it.
  // What's new (ticket 47): said once after an upgrade, when the workspace first shows.
  const [newsLine, setNewsLine] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void store.load().then(() => {
      const { note, seen } = newsNote(store.snapshot(), appVersion);
      if (store.get(NEWS_KEY) !== seen) store.set(NEWS_KEY, seen);
      if (note && live) setNewsLine(note);
    });
    platform.windowsBuild().then(
      (build) => live && setWindowsBuild(build),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [platform, store, appVersion]);

  // The window's size and place go in the State; the Tauri shell restores them at the next start.
  useEffect(() => platform.window?.watchGeometry((g) => store.set("window", g)), [platform, store]);

  // Folders (GLOSSARY) register their section, commands and keys like a Plugin (ADR 0006). They
  // live in folders.yml next to init.lua (ticket 28, decision Q46) where there's a config folder,
  // else in the State (a plain browser).
  const [foldersFile] = useState(() => (platform.folders ? new FoldersFile(platform.folders, store) : null));
  useEffect(() => registerFolders(registries, foldersFile ?? store), [registries, store, foldersFile]);
  const autoReloadRef = useRef(autoReload);
  autoReloadRef.current = autoReload;
  useEffect(() => {
    const source = platform.folders;
    if (!foldersFile || !source) return;
    foldersFile.load().catch((e: unknown) => setMessage(`Can't read ${FOLDERS_FILE}: ${e instanceof Error ? e.message : String(e)}`));
    const stop = source.watch(() => {
      void foldersFile.isOutsideEdit().then(async (outside) => {
        if (!outside) return;
        if (!autoReloadRef.current) return setStale(FOLDERS_FILE, true);
        const problem = await foldersFile.reload();
        if (problem) setMessage(problem);
      });
    });
    const unregister = registries.reloaders.register({
      id: FOLDERS_FILE,
      source: BUILTIN,
      describe: "folders.yml (your Folders)",
      files: () => [FOLDERS_FILE],
      owns: (p) => /(^|[\\/])folders\.yml$/.test(p.trim()),
      async reload() {
        setStale(FOLDERS_FILE, false);
        return foldersFile.reload();
      },
    });
    return () => {
      stop();
      unregister();
    };
  }, [platform, foldersFile, registries, setStale]);
  useEffect(() => registerThemePicker(registries, themeChoice), [registries, themeChoice]);
  useEffect(() => registerHints(registries, hintsChoice), [registries, hintsChoice]);
  // `:help` (ticket 37): its pages read the live registries and the Config each time they show.
  const [helpView] = useState(() => new HelpView());
  const helpAt = useSyncExternalStore(helpView.subscribe, helpView.snapshot);
  useEffect(() => registerHelp(registries, helpView), [registries, helpView]);
  const themeList = useSyncExternalStore(registries.themes.subscribe, registries.themes.list);
  const helpPages = useSyncExternalStore(registries.help.subscribe, registries.help.list);
  const healthSections = useSyncExternalStore(registries.health.subscribe, registries.health.list);
  const hintsStored = hintsChoice.stored();
  const configPath = report?.path ?? null;
  // `:tutor`'s progress: a tick re-renders the tutorial's page.
  const tutorDone = useSyncExternalStore(tutor?.progress.subscribe ?? noSubscribe, tutor?.progress.snapshot ?? noSnapshot);
  const running = tutor?.demo?.tutorial.id ?? null;
  const tutorCtx = useMemo(() => {
    void tutorDone;
    const progress = tutor?.progress;
    return progress ? { done: (id: string) => progress.done(id), running } : undefined;
  }, [tutor?.progress, running, tutorDone]);
  const helpCtx = useMemo(
    () =>
      helpContext(
        {
          commands: { get: (id) => registries.commands.get(id), list: () => commandList },
          themes: { list: () => themeList },
          finders: { list: () => finderSources },
          errors: { list: () => errorRows },
          help: { list: () => helpPages },
        },
        {
          keymap,
          options,
          config: config ?? defaultConfig,
          configPath,
          state: { theme: themeInEffect, hints: hintsStored },
          activeTheme: theme.id,
          health: { sections: healthSections, report: health },
          ...(tutorCtx ? { tutor: tutorCtx } : {}),
        },
      ),
    [registries, commandList, keymap, options, config, configPath, themeInEffect, hintsStored, theme.id, themeList, helpPages, errorRows, finderSources, healthSections, health, tutorCtx],
  );
  helpView.setContext(() => helpCtx);
  // Where help went, for `:tutor`'s steps: a page opened, Ctrl+O back, Ctrl+I forward.
  useEffect(() => {
    const at = helpAt.at;
    if (at && helpAt.moved) tutorEvent(`help_${helpAt.moved}`, { page: at.page, anchor: at.anchor ?? null });
  }, [helpAt, tutorEvent]);
  const onHelpSearch = useCallback((page: string, query: string) => tutorEvent("help_search", { page, query }), [tutorEvent]);
  // `cmdline.help` (ticket 52): the command line to come back to when help closes, as it was.
  const backToLine = useRef<{ line: string; caret: number } | null>(null);
  // init.lua is what `:source` reloads (decision Q58); ticket 28 registers folders.yml and roster.yml.
  const reportPath = useRef<string | null>(null);
  reportPath.current = report?.path ?? null;
  useEffect(() => {
    const source = platform.config;
    if (!source) return;
    return registries.reloaders.register(
      initLuaReloader({
        path: () => reportPath.current,
        reload: async () => {
          const r = await source.reload();
          if (r) {
            setStale("init.lua", false);
            takeReport(r);
          }
          return r;
        },
      }),
    );
  }, [registries, platform, takeReport, setStale]);

  // How long the Picker took to open the last time (ticket 20, decision Q86), for `:info`.
  const [pickerTime] = useState(pickerTimer);
  const pickerShown = overlay === "picker" && !vault.locked;
  useLayoutEffect(() => {
    if (pickerShown) pickerTime.shown();
  }, [pickerShown, pickerTime]);
  // The renderer the visible terminal draws with (ticket 20): WebGL, or DOM and why.
  const [rendererInUse, setRendererInUse] = useState<RendererInUse | null>(null);
  const onZoom = useCallback(
    (action: ZoomAction) => setFontSize((size) => zoom(terminalOptions, size, action)),
    [terminalOptions],
  );
  const terminalKeys = useMemo(() => actionsOf(keymap.terminal), [keymap]);
  const termTheme = useMemo(() => terminalTheme(theme, terminalOptions.colors), [theme, terminalOptions.colors]);
  // What sits around the terminal: a change fits the terminal again and tells the Session.
  const layoutKey = [viewMode, ...(["top", "bottom", "left", "right"] as const).map((at) => placed(layout, at).join(","))].join(" ");
  const terminalEnv = useMemo<TerminalEnv>(
    () => ({
      options: terminalOptions,
      theme: termTheme,
      fontSize,
      windowsBuild,
      keys: terminalKeys,
      clipboard: platform.clipboard,
      onZoom,
      layout: layoutKey,
      onRenderer: setRendererInUse,
    }),
    [terminalOptions, termTheme, fontSize, windowsBuild, terminalKeys, platform, onZoom, layoutKey],
  );

  const openHost = useCallback(
    (host: string, here: boolean) => {
      const current = tabs.snapshot().active;
      if (!(here && current !== null && tabs.reconnect(current, host))) tabs.open(host);
      store.update((s) => usedHost(s, host));
    },
    [tabs, store],
  );

  useEffect(() => {
    if (conn.state !== "ready" || vault.locked) return;
    // A Plugin's prompt that came up behind the lock screen (a Package init.lua names, at start)
    // keeps the keys, on its safe choice, so Esc answers it and a stray Enter installs nothing
    // (ticket 56, decision Q87). This workspace's own prompt: the demo's never reaches for yours.
    (promptRef.current ?? mainRef.current)?.focus();
  }, [conn.state, vault.locked]);

  // With the last Session closed, the keys need somewhere to go.
  const noSessions = sessions.tabs.length === 0;
  useEffect(() => {
    if (noSessions && (document.activeElement === document.body || document.activeElement === null)) {
      mainRef.current?.focus();
    }
  }, [noSessions]);

  // A fixture's Sessions open once the app is first unlocked, as if the user had opened them.
  const opened = useRef(false);
  const unlockedOnce = conn.state === "ready" && !vault.locked;
  useEffect(() => {
    if (!unlockedOnce || opened.current || !openAtStart) return;
    opened.current = true;
    for (const host of openAtStart) tabs.open(host);
  }, [unlockedOnce, openAtStart, tabs]);
  useEffect(() => {
    if (!unlockedOnce || !newsLine) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- saying it once the workspace shows is the effect
    setMessage(newsLine);
    setNewsLine(null);
  }, [unlockedOnce, newsLine]);

  // On the demo Inventory: the tutorial running is the demo's too (a Plugin's isn't registered in
  // the demo's registries), and once the demo is up its page opens where you left off.
  const demoTutorial = tutor?.demo?.tutorial ?? null;
  useEffect(() => {
    if (demoTutorial && registries.tutorials.get(demoTutorial.id) !== demoTutorial) return registries.tutorials.register(demoTutorial);
  }, [registries, demoTutorial]);
  openTutorial.current = (def) => {
    const anchor = tutor ? resumeAt(def, tutor.progress.done(def.id)) : undefined;
    helpView.open({ page: tutorPage(def.id), ...(anchor ? { anchor } : {}) });
  };
  useEffect(() => {
    if (unlockedOnce && demoTutorial) openTutorial.current(demoTutorial);
  }, [unlockedOnce, demoTutorial]);

  // Closing the app ends every Session.
  useEffect(() => () => tabs.closeAll(), [tabs]);

  const setMode = useCallback((next: KeyState) => {
    keyRef.current = next;
    setKeyState(next);
  }, []);

  // The Sidebar's tree takes focus in App mode, so assistive tech follows its cursor (ticket 29
  // M4); `beforeTree` is where focus was (the terminal), and where it goes back to.
  const treeRef = useRef<HTMLDivElement | null>(null);
  const beforeTree = useRef<Element | null>(null);
  const inTree = () => treeRef.current?.contains(document.activeElement) ?? false;
  const setTree = useCallback((el: HTMLDivElement | null) => {
    treeRef.current = el;
  }, []);

  /** Remembers where focus was (the terminal), for when an overlay or panel closes. */
  const rememberFocus = () => {
    returnFocus.current = inTree() ? beforeTree.current : document.activeElement;
  };
  const restoreFocus = () => {
    const el = returnFocus.current;
    if (el instanceof HTMLElement && el.isConnected) el.focus();
    else mainRef.current?.focus();
  };

  const closeOverlay = () => {
    setOverlay(null);
    setMode(terminalMode);
    restoreFocus();
  };

  // Help opened from the command line (ticket 52) has closed: the line comes back as it was.
  useEffect(
    () =>
      helpView.subscribe(() => {
        const back = backToLine.current;
        if (helpView.snapshot().at || !back) return;
        backToLine.current = null;
        // Focus goes back, when the line closes, where it was before the line first opened.
        setOverlay({ cmdline: back.line, caret: back.caret });
      }),
    [helpView],
  );

  const closeEdit = () => {
    setEditing(null);
    restoreFocus();
  };
  const closeAdd = () => {
    setAdding(null);
    restoreFocus();
  };
  const closeSave = () => {
    setSaving(null);
    restoreFocus();
  };
  const closeConfirm = () => {
    setConfirming(null);
    restoreFocus();
  };
  const closeSignOut = () => {
    setSigningOut(null);
    restoreFocus();
  };
  const closeChanges = () => {
    setChangesView(null);
    restoreFocus();
  };

  const closeKeys = () => {
    setKeysOpen(false);
    if (document.activeElement?.closest(".keys-panel")) restoreFocus();
  };

  const cursorRow = () => rows.find((r) => r.id === cursor) ?? null;

  /** h, l and the chevrons: fold or unfold a row, or move to its parent or first child. */
  const fold = (id: string | null, how: FoldHow) => {
    const row = id === null ? cursorRow() : (rows.find((r) => r.id === id) ?? null);
    const target = id ?? row?.id;
    if (!target) return;
    const isFolded = row ? row.folded === true : folded.has(target);
    const foldable = row ? row.foldable === true : true;
    if (foldable && (how === "toggle" || (how === "fold") !== isFolded)) {
      const next = how === "toggle" ? !isFolded : how === "fold";
      store.update((s) => setFolded(s, target, next));
      // The cursor doesn't vanish into a folded row.
      if (next && cursor !== null && ancestorsOf(cursor).includes(target)) moveTo(target);
      return;
    }
    if (id !== null || !row) return;
    if (how === "fold" && row.parent) moveTo(row.parent);
    if (how === "unfold" && foldable) {
      const child = rows[rows.indexOf(row) + 1];
      if (child?.parent === row.id) moveTo(child.id);
    }
  };
  const ancestorsOf = (id: string): string[] => {
    const out: string[] = [];
    for (let r = rows.find((x) => x.id === id); r?.parent; r = rows.find((x) => x.id === r?.parent)) out.push(r.parent);
    return out;
  };

  // What commands act on. Rebuilt each render, so it always sees the current state.
  /** `:check` with no Host (ticket 49): every health section, shown as `:help health` (open at once,
   * saying it's checking, then filled in). roster's own sections need `box.check` (API 16). */
  const checkBox = () => {
    const run = ++healthRun.current;
    setHealth({ state: "running" });
    helpView.open({ page: "health" });
    const info = conn.state === "ready" ? conn.info : null;
    const api = info?.inventory.api_version ?? 0;
    const finish = (box: HealthContext["box"], boxProblem: string | null) => {
      if (run !== healthRun.current) return;
      const hctx: HealthContext = {
        box,
        boxProblem,
        backend: info ? { name: info.backend, rosterVersion: info.inventory.roster_version, apiVersion: api } : null,
        config: { path: report?.path ?? null, error: report?.error ?? null, warnings },
        font: { families: terminalOptions.fonts, inUse: fontFound(terminalOptions.fonts, platform.fontInstalled ?? (() => null)) },
      };
      setHealth({ state: "done", at: new Date(), sections: runHealth(registries.health.list(), hctx) });
    };
    if (!info || api < BOX_CHECK_API_VERSION) return finish(null, null);
    backend.checkBox().then(
      (box) => finish(box, null),
      (e: unknown) => finish(null, e instanceof Error ? e.message : String(e)),
    );
  };

  const ctx: CommandContext = {
    openPicker: () => {
      if (overlay === null) rememberFocus();
      if (overlay !== "picker") pickerTime.start();
      setOverlay("picker");
    },
    connect: (name, here = false) => {
      const host = hostByName.get(name);
      if (!host && parseQuickTarget(name)) return ctx.quickConnect(name);
      if (!host) return setMessage(`No Host named ${name}`);
      if (!host.reviewed) return setMessage(notReviewedMessage(name, canAdd));
      openHost(name, here);
    },
    quickConnect: (text) => {
      if (!quickConnects) {
        const api = conn.state === "ready" ? conn.info.inventory.api_version : 0;
        return setMessage(`Quick Connect needs a newer roster (API version ${QUICK_CONNECT_API_VERSION}; this one speaks ${api})`);
      }
      if (text === null) {
        if (overlay === null) rememberFocus();
        return setOverlay("quick");
      }
      const to = parseQuickTarget(text);
      if (!to) return setMessage(`${text} isn't a Quick Connect address: type user@address, or user@address:port`);
      tabs.openQuick(to);
    },
    // A Host, or a web service in the default browser (ticket 18, decision Q71).
    open: (arg) => {
      const sessionHosts = sessions.tabs.map((t) => t.host);
      const to = resolveOpen(arg, hostByName, details ?? ctx.selectedHost(), sessionHosts);
      if (to.kind === "error") return setMessage(to.message);
      if (to.kind === "web") return openWeb(to.host, to.service, to.url);
      const tab = sessions.tabs.find((t) => t.host === to.host);
      if (tab) tabs.select(tab.id);
      else ctx.connect(to.host);
    },
    reconnect: () => {
      if (sessions.active !== null) tabs.reconnect(sessions.active);
    },
    check: (name) => {
      if (name === null) return checkBox();
      const host = name;
      if (!hostByName.has(host)) return setMessage(`No Host named ${host}`);
      const api = conn.state === "ready" ? conn.info.inventory.api_version : 0;
      if (api < CHECK_API_VERSION) {
        return setMessage(`:check needs a newer roster (API version ${CHECK_API_VERSION}; this one speaks ${api})`);
      }
      const run = ++checkRun.current;
      setCheck({ state: "running", host });
      backend.checkHost(host).then(
        (result) => run === checkRun.current && setCheck({ state: "done", host, result }),
        (e: unknown) =>
          run === checkRun.current &&
          setCheck({ state: "error", host, message: e instanceof Error ? e.message : String(e) }),
      );
    },
    selectRelative: (delta) => tabs.selectRelative(delta),
    selectNth: (n) => tabs.selectNth(n),
    close: (n) => {
      const id = n === null ? sessions.active : (sessions.tabs[n - 1]?.id ?? null);
      if (id !== null) tabs.close(id);
    },
    toggleSidebar: () => {
      const shown = !isShown(layout, "sidebar");
      const name = `modes.${viewMode}.sidebar`;
      if (configSetsSidebar) {
        // init.lua sets it: this lasts until the Config is loaded again (or the app restarts).
        setLayouts((l) => ({ ...l, [viewMode]: togglePiece(l[viewMode], "sidebar") }));
        return setMessage(
          `Sidebar ${shown ? "shown" : "hidden"} for now: init.lua sets ${name} = ${String(!shown)}, which comes back on :source or a restart`,
        );
      }
      store.set(SIDEBAR_KEY, { ...sidebarChoices(appState), [viewMode]: shown });
      setMessage(`Sidebar ${shown ? "shown" : "hidden"}, and kept that way. ${name} = ${String(shown)} in init.lua makes it the default`);
    },
    toggleStatusBar: () => {
      const next = togglePiece(layout, layout.bar);
      setLayouts((l) => ({ ...l, [viewMode]: next }));
      setMessage(pieceToggled(viewMode, next, layout.bar));
    },
    openCommandLine: (initial = "") => {
      if (overlay === null) rememberFocus();
      setOverlay({ cmdline: initial });
    },
    toggleKeys: () => {
      if (keysOpen) return closeKeys();
      rememberFocus();
      setKeysOpen(true);
    },
    lock: () => {
      if (!vault.lock()) setMessage("Nothing to lock: no Host Login uses a vault with a master password.");
    },
    vault: () => {
      if (apiVersion < SIGN_OUT_API_VERSION) {
        return setMessage(`:vault signout needs a newer roster (API version ${SIGN_OUT_API_VERSION}; this one speaks ${apiVersion})`);
      }
      // Ask roster who the CLI is signed in as now: a sign-in from the lock screen doesn't say.
      backend.vaultStatus().then(
        (s) => {
          if (!s.provider) return setMessage("Nothing to sign out of: no Host Login uses a vault with an account.");
          if (!s.can_sign_out) return setMessage(noAccountWords(s.provider));
          if (!s.account) return setMessage("The vault CLI isn't signed in on this Box, so there's no account to sign out of.");
          if (!signingOut) rememberFocus();
          setSigningOut(s.account);
        },
        (e: unknown) => setMessage(`Couldn't ask the vault who's signed in: ${e instanceof Error ? e.message : String(e)}`),
      );
    },
    toTerminal: () => {
      setMode(terminalMode);
      ctx.closePanel();
    },
    // The panel drawn last (help, Key bindings, beside :check) is the topmost.
    closePanel: () => {
      if (pluginSnap.float) return plugins.closeFloat();
      if (helpAt.at) return helpView.close();
      if (pluginsOpen) return closePlugins();
      if (packagesOpen) return closePackages();
      if (keysOpen) return closeKeys();
      if (signingOut) return closeSignOut();
      if (confirming) return closeConfirm();
      if (editing !== null) return closeEdit();
      if (adding) return closeAdd();
      if (saving !== null) return closeSave();
      if (changesView) return closeChanges();
      if (check) {
        checkRun.current++;
        return setCheck(null);
      }
      if (details !== null) setDetails(null);
    },
    list: (move) => {
      if (move !== "choose") return moveTo(moveCursor(rows, cursor, move));
      const row = rows.find((r) => r.id === cursor);
      if (row) setSelected(row.id);
      // Enter on a group, Folder or heading folds it and stays in the Sidebar.
      setMode(row && staysInAppMode(row.command) ? { mode: "app", pending: [] } : terminalMode);
      if (row) run(row.command);
    },
    fold,
    cursorRow,
    selectedHost: () => {
      const row = cursorRow();
      if (row?.host) return row.host;
      return sessions.tabs.find((t) => t.id === sessions.active)?.host ?? null;
    },
    hostNames: () => hosts?.hosts.map((h) => h.name) ?? [],
    groupNames: () => groupNames,
    inventory: (op) => {
      if (!canLive) {
        return setMessage(`Changing the Inventory here needs a newer roster (API version ${LIVE_API_VERSION}; this one speaks ${apiVersion})`);
      }
      if (op.op === "remove") {
        const h = hostByName.get(op.host);
        if (!h) return setMessage(`No Host named ${op.host}`);
        if (!confirming) rememberFocus();
        return setConfirming({ host: h.name, group: h.group });
      }
      if (op.op === "group-delete" && op.to === undefined) {
        const members = hosts?.hosts.filter((h) => h.group === op.group) ?? [];
        if (members.length > 0) {
          // Where should they go? The command line asks, with the groups to complete.
          const others = groupNames.filter((g) => g !== op.group);
          if (others.length === 0) {
            return setMessage(`${op.group} has ${countOf(members.length, "Host")} and there's no other group for them: make one first (:group new)`);
          }
          ctx.openCommandLine(`group delete ${op.group} `);
          return setMessage(`${op.group} has ${countOf(members.length, "Host")}: name the group they move to (Tab completes), or Esc to keep it`);
        }
      }
      void runInventory(op);
    },
    say: setMessage,
    viewMode: () => viewMode,
    setViewMode: (mode) => setViewMode(mode ?? otherMode(viewMode)),
    showInfo: () => {
      if (conn.state === "ready") {
        // The command too: it's the program the master password and sign-in codes go to.
        const { backend, command, inventory } = conn.info;
        // The terminal font in use (ticket 33): the first installed one in terminal.font.
        const font = fontInUse(terminalOptions.fonts, platform.fontInstalled ?? (() => null));
        const size = `${Math.round(fontSize * 100) / 100} px`;
        // The visible terminal's, or with none on screen the one terminal.renderer asks for.
        const shown = sessions.active !== null && rendererInUse !== null;
        const renderer = rendererLabel(shown ? rendererInUse : terminalOptions.renderer);
        const picked = pickerTime.last();
        setMessage(
          `Backend ${backend} · Box ${inventory.box} · Inventory ${inventory.path} · Command ${command.join(" ")} · ` +
            `Terminal ${font} ${size}, ${renderer}` +
            (picked === null ? "" : ` · Picker opened in ${Math.round(picked)} ms`),
        );
      }
    },
    details: (name) => {
      if (name === null && details !== null && hostByName.has(details)) return setDetails(null);
      const host = name ?? ctx.selectedHost();
      if (!host) return setMessage("No Host selected: pick one in the Sidebar or open its Session, or use :info HOST");
      if (!hostByName.has(host)) return setMessage(`No Host named ${host}`);
      setDetails(host);
    },
    edit: (name) => {
      const host = name ?? ctx.selectedHost();
      if (!host) return setMessage("edit needs a Host name (no Host is selected)");
      if (!hostByName.has(host)) return setMessage(`No Host named ${host}`);
      if (!canEdit) return setMessage(`:edit needs a newer roster (API version ${EDIT_API_VERSION}; this one speaks ${apiVersion})`);
      if (editing === null && !changesView && !adding) rememberFocus();
      setChangesView(null);
      setAdding(null);
      setSaving(null);
      setEditing(host);
    },
    addHost: (inGroup) => {
      if (!canAdd) return setMessage(addTooOld);
      if (editing === null && !changesView && !adding) rememberFocus();
      const selected = ctx.selectedHost();
      const group = inGroup ?? (selected && hostByName.get(selected)?.group) ?? Object.keys(hosts?.groups ?? {})[0] ?? "";
      setChangesView(null);
      setEditing(null);
      setSaving(null);
      setAdding({ group });
    },
    saveSession: () => {
      const tab = sessions.tabs.find((t) => t.id === sessions.active);
      if (apiVersion < SAVE_TO_VAULT_API_VERSION) {
        return setMessage(`Save to vault needs a newer roster (API version ${SAVE_TO_VAULT_API_VERSION}; this one speaks ${apiVersion})`);
      }
      if (!tab?.save) return setMessage("Nothing to save: tick Save to vault when you type a Session's password.");
      if (tab.save.saved !== null) return setMessage(`Already saved as ${tab.save.saved}.`);
      if (!tab.save.loggedIn) return setMessage(`${tab.host} hasn't logged in yet: roster saves the password only after it works.`);
      if (editing === null && !changesView && !adding && saving === null) rememberFocus();
      setChangesView(null);
      setEditing(null);
      setAdding(null);
      setSaving(tab.id);
    },
    review: (name, reviewed = true) => {
      const verb = reviewed ? "review" : "unreview";
      const host = name ?? ctx.selectedHost();
      if (!host) return setMessage(`${verb} needs a Host name (no Host is selected)`);
      const h = hostByName.get(host);
      if (!h) return setMessage(`No Host named ${host}`);
      if (!canAdd) return setMessage(`:${verb} needs a newer roster (API version ${ADD_API_VERSION}; this one speaks ${apiVersion})`);
      if (!reviewed && apiVersion < UNREVIEW_API_VERSION) {
        return setMessage(`:host unreview needs a newer roster (API version ${UNREVIEW_API_VERSION}; this one speaks ${apiVersion})`);
      }
      const already = reviewed ? `${host} is already reviewed.` : `${host} isn't reviewed.`;
      if (h.reviewed === reviewed) return setMessage(already);
      const done = reviewed
        ? `Marked ${host} reviewed, as a Pending change. It can be opened now.`
        : `Marked ${host} unreviewed, as a Pending change. It can't be opened until it's reviewed again.`;
      backend.reviewHost(host, reviewed).then(
        (r) => {
          reloadHosts();
          refreshPending();
          setMessage(r.changed ? done : already);
        },
        (e: unknown) =>
          setMessage(`Couldn't mark ${host} ${reviewed ? "reviewed" : "unreviewed"}: ${e instanceof Error ? e.message : String(e)}`),
      );
    },
    showChanges: (then) => {
      if (!canEdit) return setMessage(`:changes needs a newer roster (API version ${EDIT_API_VERSION}; this one speaks ${apiVersion})`);
      if (then === "publish" && !canPublish) {
        return setMessage(`:publish needs a newer roster (API version ${PUBLISH_API_VERSION}; this one speaks ${apiVersion})`);
      }
      if (editing === null && !changesView && !adding) rememberFocus();
      setEditing(null);
      setAdding(null);
      setPending((p) => p ?? { state: "loading" });
      refreshPending();
      setChangesView({ step: then ?? "diff" });
    },
    pull: () => {
      if (!canEdit) return setMessage(`:pull needs a newer roster (API version ${EDIT_API_VERSION}; this one speaks ${apiVersion})`);
      setMessage("Pulling the infra repo…");
      gate.pull().then(
        (r) => {
          setMessage(
            !r.upstream
              ? "This branch has no upstream: nothing to pull."
              : r.updated
                ? `Pulled ${countOf(r.commits, "commit")} from ${r.upstream}.`
                : `Up to date with ${r.upstream}.`,
          );
        },
        (e: unknown) => setMessage(`Couldn't pull: ${e instanceof Error ? e.message : String(e)}`),
      );
    },
    config: (what) => {
      const source = platform.config;
      if (!source) return setMessage("There's no init.lua here: this window isn't the app (a plain browser)");
      const failed = (e: unknown) => (e instanceof Error ? e.message : String(e));
      if (what === "path") return setMessage(report ? `init.lua is at ${report.path}` : "init.lua hasn't been read yet");
      if (what === "import-terminal") {
        rememberFocus();
        source.importPreview().then(
          (preview) => setImporting({ preview, problem: null, writing: false }),
          (e: unknown) => setMessage(`Can't import: ${failed(e)}`),
        );
        return;
      }
      // `:config reload` is `:source init.lua` (decision Q58).
      if (what === "reload") return void runLine(commands, ctx, "source init.lua");
      source.open().then(
        ({ path, created }) =>
          setMessage(
            created
              ? `Created ${path} with every option commented out. Uncomment one and save: it applies at once.`
              : `Opened ${path}. Saving it applies it.`,
          ),
        (e: unknown) => setMessage(`Can't open init.lua: ${failed(e)}`),
      );
    },
    openFinder: (source, query) => {
      if (!registries.finders.get(source)) return setMessage(`No finder named ${source}`);
      if (overlay === null) rememberFocus();
      setOverlay(query ? { finder: source, query } : { finder: source });
    },
  };

  const copy = (text: string) => platform.clipboard.writeText(text);

  /** One Live Inventory change through roster (a Pending change), then the Sidebar and the count
   * again, and what happened in a line. A refusal is roster's message, with its fix. */
  async function runInventory(op: InventoryOp): Promise<void> {
    try {
      const said = await inventoryCall(op);
      setMessage(said);
    } catch (e) {
      setMessage(inventoryRefusal(e));
    }
    reloadHosts();
    refreshPending();
  }

  async function inventoryCall(op: InventoryOp): Promise<string> {
    const pendingNote = "as a Pending change";
    switch (op.op) {
      case "remove": {
        const r = await backend.removeHost(op.host);
        return `Removed ${r.removed} from ${r.group} ${pendingNote}. Its vault item, if any, is untouched.`;
      }
      case "rename": {
        const r = await backend.renameHost(op.host, op.to);
        return r.changed ? `Renamed ${op.host} to ${op.to} ${pendingNote}. Sessions use it after roster sync.` : `${op.host} already has that name.`;
      }
      case "move": {
        const r = await backend.moveHost(op.host, op.group);
        if (!r.changed) return `${op.host} is already in ${op.group}.`;
        const kept = r.pinned.length ? ` It keeps its ${r.pinned.join(", ")}, now written on the Host.` : "";
        return `Moved ${op.host} to ${op.group} ${pendingNote}.${kept}`;
      }
      case "group-new":
        await backend.newGroup(op.name);
        return `Added group ${op.name} ${pendingNote}. Drag Hosts onto it, or + adds one.`;
      case "group-rename": {
        const r = await backend.renameGroup(op.group, op.to);
        return r.changed ? `Renamed group ${op.group} to ${op.to} ${pendingNote}.` : `${op.group} already has that name.`;
      }
      case "group-delete": {
        const r = await backend.deleteGroup(op.group, op.to);
        return r.moved.length
          ? `Deleted group ${op.group}; ${countOf(r.moved.length, "Host")} moved to ${r.to ?? "?"}, ${pendingNote}.`
          : `Deleted group ${op.group} ${pendingNote}.`;
      }
    }
  }

  /** A refused Live Inventory change, said whole: roster's message and its fix. */
  function inventoryRefusal(e: unknown): string {
    if (!(e instanceof BackendCallError)) return `Couldn't change the Inventory: ${e instanceof Error ? e.message : String(e)}`;
    if (e.code === LiveError.groupNotEmpty) return `${e.message}.`;
    const fix = e.data?.fix ? ` (${e.data.fix})` : "";
    return `Couldn't change the Inventory: ${e.message}${fix}`;
  }

  /** Hands a web service's URL to the default browser (ticket 18): http or https only, checked
   * here and again in the Tauri shell. */
  function openWeb(host: string, service: string, url: string) {
    const checked = webUrl(url);
    if (!checked) return setMessage(`${host}'s ${service} has no http or https URL to open`);
    if (!platform.openUrl) return setMessage(`There's no browser to hand ${checked} to here`);
    platform.openUrl(checked).then(
      () => setMessage(`Opened ${host}'s ${service} in the browser: ${checked}`),
      (e: unknown) => setMessage(`Couldn't open ${checked}: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  function run(line: Line) {
    setMessage("");
    const ran = runLine(commands, ctx, line);
    if (ran) {
      const arg = line.trim().split(/\s+/).slice(1).join(" ");
      tutorEvent("command", { id: ran.id, arg: arg || null });
    }
  }
  runRef.current = run;
  openPlugins.current = () => {
    rememberFocus();
    setPluginsOpen(true);
  };
  const closePlugins = () => {
    setPluginsOpen(false);
    restoreFocus();
  };
  openPackages.current = () => {
    rememberFocus();
    setPackagesOpen(true);
  };
  const closePackages = () => {
    setPackagesOpen(false);
    restoreFocus();
  };

  const staysInAppMode = (line: Line) => commands.get(line.split(" ")[0] ?? "")?.staysInAppMode ?? false;

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (MODIFIERS.has(e.key)) return;
    // An overlay (the Picker, the command line, the bindings filter) opens in Terminal mode, so its
    // input gets the keys as a terminal would, until the Leader.
    const leaderKey = isLeaderKey(e, options.leader);
    const chord = leaderKey ? options.leader : chordOf(e);
    // A key the IME is composing with (chordOf names none) is the IME's.
    if (chord === "") return;
    const before = keyRef.current;
    const r = press(before, chord, { keymap, leader: options.leader, vim: options.vim, staysInAppMode });
    if (!r.consumed) return;
    e.preventDefault();
    e.stopPropagation();
    if (before.mode === "terminal" && r.state.mode === "app") {
      setCursor(
        (selected !== null && rows.some((row) => row.id === selected) ? selected : null) ??
          rows.find((row) => row.raised)?.id ??
          rows[0]?.id ??
          null,
      );
    }
    setMode(r.state);
    if (r.action) run(r.action);
  });

  // App mode with the Sidebar shown puts focus on its tree (the cursor is its active descendant);
  // back in Terminal mode, focus goes back where it was. An overlay or panel that took focus
  // keeps it, and a Session that became active has taken it already.
  const treeMode = keyState.mode === "app" && overlay === null;
  useEffect(() => {
    const tree = treeRef.current;
    if (treeMode) {
      if (tree && !tree.contains(document.activeElement)) {
        beforeTree.current = document.activeElement;
        tree.focus({ preventScroll: true });
      }
      return;
    }
    const back = beforeTree.current;
    if (keyState.mode !== "terminal" || back === null) return;
    beforeTree.current = null;
    // Focus is still on the tree, or was lost with it (the Sidebar hid with the view mode).
    const focused = document.activeElement;
    const lost = !focused || focused === document.body || (tree?.contains(focused) ?? false);
    if (!lost) return;
    if (back instanceof HTMLElement && back.isConnected) back.focus();
    if (document.activeElement === focused) mainRef.current?.focus();
  }, [treeMode, keyState.mode]);

  // Caught before anything else sees it, the terminal included (capture phase on window). While
  // locked, keys belong to the lock screen alone.
  const ready = conn.state === "ready" && !vault.locked;
  useEffect(() => {
    if (!ready || suspended) return;
    const handler = (e: KeyboardEvent) => onKey(e);
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [ready, suspended]);
  // Back from the demo Inventory: the keys come back here.
  const wasSuspended = useRef(suspended);
  useEffect(() => {
    if (wasSuspended.current && !suspended) (promptRef.current ?? mainRef.current)?.focus();
    wasSuspended.current = suspended;
  }, [suspended]);

  // The custom title bar (decision Q32) sits above every screen, the lock screen too, so the
  // window can always be moved and closed; it shows nothing but the mark. The view mode's layout
  // says whether it shows at all (Focus is OS fullscreen without it).
  const toast = report !== toastClosedFor && (
    <ConfigToast error={report?.error ?? null} warnings={warnings} onClose={() => setToastClosedFor(report)} />
  );
  // The toolbar (decision Q65): in the title bar once the app is ready and unlocked (the lock
  // screen shows nothing but the mark), else a bar of its own at the top.
  const detailsHost = details === null ? undefined : hostByName.get(details);
  const toolbarCtx: ToolbarContext = { pendingCount, sidebarShown, quickConnect: quickConnects, detailsShown: detailsHost !== undefined };
  const toolbarControls =
    ready && isShown(layout, "toolbar") ? shownControls(toolbarDefs, layout.controls, toolbarCtx) : [];
  const toolbar = (side: "start" | "end") => (
    <Toolbar
      controls={toolbarControls}
      ctx={toolbarCtx}
      keysFor={(command) => hintFor(keymap, command)}
      leader={options.leader}
      run={(line) => {
        setMode(terminalMode);
        run(line);
      }}
      side={side}
    />
  );
  const frame = (content: React.ReactNode) => (
    <HintsShown value={hintsShown}>
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
        {toast}
        <PluginNotices notices={pluginSnap.notices} onClose={(id) => plugins.dismissNotice(id)} />
      </div>
    </HintsShown>
  );

  if (conn.state === "connecting") {
    return frame(
      <div className="screen center">
        <p className="muted starting">Starting the backend…</p>
      </div>,
    );
  }
  if (conn.state === "failed") {
    return frame(<ErrorScreen problem={conn.problem} onRetry={() => void connect(true)} copy={copy} />);
  }

  const { info } = conn;
  const reconnectKey = hintFor(keymap, "reconnect");
  const appMode = keyState.mode === "app" && overlay === null;
  const findKeys = hintFor(keymap, "find");
  const sourceKeys = hintFor(keymap, "source");
  const hints = [
    [findKeys, "find"],
    [hintFor(keymap, "keys"), "keys"],
    [hintFor(keymap, "statusbar"), "hide this bar"],
  ].filter((h): h is [string, string] => h[0] !== null);

  const modeKeys = [hintFor(keymap, "mode"), hintFor(keymap, "focus"), ...globalKeysFor(keymap, ["mode", "focus"])].filter(
    (k): k is string => k !== null,
  );
  /** The pieces the layout places at `at`, in order. The title bar is drawn by `frame` above
   * every screen (the lock and error screens too); a Plugin's pieces come with ticket 23. */
  const pieces = (at: Place) =>
    placed(layout, at).map((id) => {
      if (id === "statusbar") return statusBar;
      if (id === "sessionbar") {
        return (
          <div key={id} className="piece" data-place={at}>
            <SessionBar box={info.inventory.box} snapshot={sessions} hostByName={hostByName} run={run} />
          </div>
        );
      }
      return null;
    });
  const finderSource = overlay !== null && typeof overlay === "object" && "finder" in overlay
    ? finderSources.find((s) => s.id === overlay.finder)
    : undefined;

  // The status bar's segments, as the mode's layout picks and orders them (decision Q39); the
  // hints and the mode go to the right.
  const segment = (id: string) => {
    switch (id) {
      case "backend":
        return (
          <span key={id} className="backend" title={info.backend}>
            <span className="status-dot" aria-hidden="true" />
            <span className="statusbar-cut">{info.backend}</span>
          </span>
        );
      case "box":
        return (
          <span key={id} className="box" title={info.inventory.box}>
            <span className="box-mark" aria-hidden="true" />
            <span className="statusbar-cut">{info.inventory.box}</span>
          </span>
        );
      case "path":
        return (
          <span key={id} className="statusbar-cut path" title={`${info.inventory.path}\n${info.command.join(" ")}`}>
            {info.inventory.path}
          </span>
        );
      case "changes":
        // Pending changes (ticket 10): only when there are some; it opens them.
        return (
          pendingCount > 0 && (
            <button
              key={id}
              type="button"
              className="statusbar-changes"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run("changes")}
              title="Show the Pending changes"
            >
              <span className="changes-dot" aria-hidden="true" />
              {countOf(pendingCount, "Pending change")}
            </button>
          )
        );
      case "hints":
        // They drop out whole, last first, when the bar runs out of room (never cut mid-key).
        return (
          <span key={id} className="statusbar-hints">
            {stale.length > 0 && (
              <span className="hint stale" title="Saved, not applied yet: auto_reload is off in init.lua">
                {stale.join(", ")} changed{" "}
                {sourceKeys ? (
                  <span className="key-hint">
                    <Keys keys={sourceKeys} leader={options.leader} /> apply
                  </span>
                ) : (
                  <>
                    <code>:source</code> applies
                  </>
                )}
              </span>
            )}
            {hints.map(([k, what]) => (
              <span key={what} className="hint key-hint">
                <Keys keys={k} leader={options.leader} /> {what}
              </span>
            ))}
          </span>
        );
      case "mode":
        return (
          appMode && (
            <span key={id} className="mode">
              APP{keyState.pending.length > 0 && <span className="pending"> {keyState.pending.join(" ")}</span>}
            </span>
          )
        );
      default: {
        // A Plugin's segment (the Host count is one: the built-in `hosts` Plugin).
        const def = statusDefs.find((d) => d.id === id);
        if (!def) return null;
        const title = def.title ?? `From ${def.source}`;
        return def.command ? (
          <button
            key={id}
            type="button"
            className="statusbar-plugin"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run(def.command ?? "")}
            title={title}
          >
            {def.text}
          </button>
        ) : (
          <span key={id} className={id === "hosts" ? "count" : "statusbar-plugin"} title={title}>
            {def.text}
          </span>
        );
      }
    }
  };
  // Segments Plugins add show after the layout's own, unless the layout lists them itself.
  const segments =
    layout.segments ?? [...STATUS_SEGMENTS, ...statusDefs.map((d) => d.id).filter((d) => !(STATUS_SEGMENTS as readonly string[]).includes(d))];
  const right = new Set(["hints", "mode"]);
  const statusBar = (
    <footer key="statusbar" className="statusbar">
      {segments.filter((id) => !right.has(id)).map(segment)}
      <span className="statusbar-right">{segments.filter((id) => right.has(id)).map(segment)}</span>
    </footer>
  );

  const shell = (
    <div className={`screen app ${appMode ? "mode-app" : "mode-terminal"}`} data-view={viewMode}>
      {pieces("top")}
      <div className={`body sidebar-${sidebarSide}`}>
        {sidebarShown && (
          <Sidebar
            sections={sections}
            side={sidebarSide}
            cursor={appMode ? cursor : null}
            selected={appMode ? cursor : selected}
            onSelect={setSelected}
            leaderHint={options.leader}
            findKeys={hintFor(keymap, "find")}
            run={(line) => {
              setMode(terminalMode);
              run(line);
            }}
            treeRef={setTree}
            onTreeFocus={(from) => {
              // Tab (or a screen reader) reached the tree: it's App mode, as after the Leader.
              if (keyRef.current.mode !== "terminal") return;
              beforeTree.current = from;
              setCursor(
        (selected !== null && rows.some((row) => row.id === selected) ? selected : null) ??
          rows.find((row) => row.raised)?.id ??
          rows[0]?.id ??
          null,
      );
              setMode({ mode: "app", pending: [] });
            }}
            onTreeBlur={(to) => {
              // Focus went elsewhere (Tab on, a click): keys are the terminal's again.
              if (keyRef.current.mode === "app" && to !== null && !to.closest(".picker-backdrop, .cmdline")) setMode(terminalMode);
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
                Add them to <code>{info.inventory.path}</code> and they show up here.
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
              terminalEnv={terminalEnv}
              reconnectKeys={reconnectKey}
              run={run}
              errorRows={errorRows}
              copy={copy}
              addressOf={(name) => hostByName.get(name)?.ip ?? null}
              canSave={canSave}
              saveKeys={hintFor(keymap, "save")}
            />
          )}
        </main>
        {detailsHost && conn.hosts && (
          <HostDetails
            host={detailsHost}
            groups={conn.hosts.groups}
            onOpen={(service, url) => openWeb(detailsHost.name, service, url)}
            onClose={() => setDetails(null)}
            cmdlineKeys={hintFor(keymap, "cmdline")}
            leader={options.leader}
          />
        )}
        {importing && (
          <ImportPanel
            preview={importing.preview}
            problem={importing.problem}
            writing={importing.writing}
            onClose={() => {
              setImporting(null);
              restoreFocus();
            }}
            onWrite={() => {
              const source = platform.config;
              if (!source) return;
              setImporting({ ...importing, writing: true, problem: null });
              const { base, result, date, theme: imported } = importing.preview;
              source.importApply({ base, result, date }).then(
                () => {
                  setImporting(null);
                  restoreFocus();
                  setMessage("Wrote Windows Terminal's profile into init.lua. Reloading it.");
                  // Applied now, whether or not a save reloads by itself.
                  source.reload().then(
                    (r) => {
                      if (r) {
                        setStale("init.lua", false);
                        takeReport(r);
                      }
                      if (r?.error) {
                        return setMessage(
                          "Wrote Windows Terminal's profile into init.lua, which now has an error: the last good Config is still in use",
                        );
                      }
                      // Its Theme is chosen as `:theme` chooses one, over init.lua's `theme` as the
                      // file now has it, never pinned there (decision Q69).
                      let note = "";
                      if (imported) {
                        const c = r?.config;
                        themeChoice.setConfigTheme(c && c.theme !== "auto" ? c.theme : null, c?.lines.theme ?? null);
                        note = themeChoice.keep(imported);
                      }
                      setMessage(`Wrote Windows Terminal's profile into init.lua, and applied it${note ? `. ${note}` : ""}`);
                    },
                    () => {},
                  );
                },
                (e: unknown) =>
                  setImporting({ ...importing, writing: false, problem: e instanceof Error ? e.message : String(e) }),
              );
            }}
          />
        )}
        {check && (
          <CheckPanel
            check={check}
            rows={errorRows}
            actions={{ run, copy }}
            onClose={() => {
              checkRun.current++;
              setCheck(null);
            }}
          />
        )}
        {editing !== null && hostByName.get(editing) && (
          <EditPanel
            key={editing}
            backend={backend}
            host={hostByName.get(editing) as Host}
            pendingCount={pendingCount}
            rows={errorRows}
            actions={{ run, copy }}
            pull={gate}
            onSaved={(update) => {
              closeEdit();
              reloadHosts();
              refreshPending();
              setMessage(
                (update.changed
                  ? `Saved ${update.host.name} as a Pending change. Sessions use it after roster sync.`
                  : `Nothing changed on ${update.host.name}.`) + (update.warnings?.length ? ` But ${update.warnings.join("; ")}.` : ""),
              );
            }}
            onClose={closeEdit}
            {...(canAdd
              ? {
                  onReview: (name: string) => {
                    closeEdit();
                    run(`review ${name}`);
                  },
                }
              : {})}
            {...(apiVersion >= UNREVIEW_API_VERSION
              ? {
                  onUnreview: (name: string) => {
                    closeEdit();
                    run(`host unreview ${name}`);
                  },
                }
              : {})}
          />
        )}
        {adding && hosts && (
          <AddPanel
            backend={backend}
            hosts={hosts}
            group={adding.group}
            pendingCount={pendingCount}
            rows={errorRows}
            actions={{ run, copy }}
            pull={gate}
            chooseTarget={configuresVault}
            targetsVersion={targetsVersion}
            onAdded={(r) => {
              closeAdd();
              reloadHosts();
              refreshPending();
              const where = `${r.host.name} to ${r.host.group}`;
              setMessage(
                (r.host.reviewed
                  ? `Added ${where} as a Pending change${r.item ? `; its password is in the vault as ${r.item.name}${savedIn(r.item.target)}` : ""}.`
                  : `Added ${where} unreviewed, as a Pending change. :review ${r.host.name} marks it reviewed.`) +
                  (r.warnings?.length ? ` But ${r.warnings.join("; ")}.` : ""),
              );
            }}
            onClose={closeAdd}
          />
        )}
        {saveTab?.save && hosts && (
          <SavePanel
            key={saveTab.id}
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
            actions={{ run, copy }}
            pull={gate}
            chooseTarget={configuresVault}
            targetsVersion={targetsVersion}
            onSaved={(r) => {
              tabs.saved(saveTab.id, r.host.name);
              closeSave();
              reloadHosts();
              refreshPending();
              setMessage(
                ("added" in r
                  ? `Saved ${r.host.name} to ${r.host.group} as a Pending change; its password is in the vault as ${r.item.name}${savedIn(r.item.target)}.`
                  : `Saved ${r.host.name}'s password to the vault as ${r.item.name}${savedIn(r.item.target)}; its Login points at it now, as a Pending change.`) +
                  (r.warnings?.length ? ` But ${r.warnings.join("; ")}.` : ""),
              );
            }}
            onClose={closeSave}
          />
        )}
        {changesView && pending && (
          <ChangesPanel
            key={changesView.step}
            changes={pending}
            step={changesView.step}
            editKeys={hintFor(keymap, "edit")}
            leader={options.leader}
            canPublish={canPublish}
            rows={errorRows}
            actions={{ run, copy }}
            onDiscard={async () => {
              try {
                const r = await backend.discardChanges();
                setMessage(r.discarded ? "Discarded the Pending changes: roster.yml is as the last commit has it." : "Nothing to discard.");
              } catch (e) {
                setMessage(`Couldn't discard: ${e instanceof Error ? e.message : String(e)}`);
              }
              reloadHosts();
              refreshPending();
            }}
            onPublish={async (message) => {
              // After a timeout, publishChecked asks roster whether it was published, and says so.
              const r = await publishChecked(backend, message);
              reloadHosts();
              refreshPending();
              setMessage(
                `Published ${r.commit.slice(0, 7)} to ${r.upstream}.` +
                  (r.sync.ok ? "" : " This Box's ssh config didn't follow: run roster sync."),
              );
              return r;
            }}
            onClose={closeChanges}
          />
        )}
        {confirming && (
          <ConfirmPanel
            key={confirming.host}
            title={`Remove ${confirming.host}?`}
            body={
              <>
                <code>{confirming.host}</code> leaves group {confirming.group} in roster.yml, as a Pending change you can
                discard until it&rsquo;s Published. Its vault item, if it has one, stays in the vault.
              </>
            }
            action="Remove"
            onConfirm={async () => {
              const host = confirming.host;
              await runInventory({ op: "remove", host });
              closeConfirm();
            }}
            onClose={closeConfirm}
          />
        )}
        {signingOut && (
          <ConfirmPanel
            title={signOutQuestion(signingOut)}
            body={
              <>
                {SIGN_OUT_WHAT} Server: <span className="mono">{serverName(signingOut.server)}</span>. The app locks and
                shows the sign-in form; open Sessions keep running behind it.
              </>
            }
            action="Sign out"
            onConfirm={async () => {
              const account = signingOut;
              setSigningOut(null);
              await vault.signOut(account);
            }}
            onClose={closeSignOut}
          />
        )}
        {pluginSnap.prompts[0] && (
          <PluginPrompt
            key={`${pluginSnap.prompts[0].kind}:${pluginSnap.prompts[0].manifest.name}:${pluginSnap.prompts[0].package?.commit ?? ""}`}
            prompt={pluginSnap.prompts[0]}
            safe={setPromptButton}
            onAnswer={(allow) => {
              const prompt = pluginSnap.prompts[0];
              if (prompt) void plugins.answer(prompt, allow);
              restoreFocus();
            }}
          />
        )}
        {pluginsOpen && <PluginsPanel snapshot={pluginSnap} onGrant={(name, perm, on) => void plugins.setGrant(name, perm, on)} onClose={closePlugins} />}
        {packagesOpen && <PackagesPanel snapshot={pluginSnap} onClose={closePackages} />}
        {pluginSnap.float && (
          <PluginFloatPanel
            key={pluginSnap.float.plugin}
            float={pluginSnap.float}
            onClose={() => {
              plugins.closeFloat();
              restoreFocus();
            }}
          />
        )}
        {keysOpen && (
          <BindingsPanel
            rows={bindingRows(keymap, options, commands)}
            leader={options.leader}
            onClose={closeKeys}
            onHelp={(option) => {
              closeKeys();
              run(`help ${optionTopic(option, new Set(topics(helpCtx).map((t) => t.tag)))}`);
            }}
          />
        )}
        {helpAt.at && (
          <HelpPanel
            view={helpView}
            snapshot={helpAt}
            ctx={helpCtx}
            leader={options.leader}
            vim={options.vim}
            onFind={() => run("help")}
            onOutline={() => run("finder outline")}
            onSearch={onHelpSearch}
          />
        )}
      </div>
      {overlay !== null && typeof overlay === "object" && "cmdline" in overlay && (
        <CommandLine
          key={overlay.cmdline}
          initial={overlay.cmdline}
          complete={(input) =>
            complete(commands, input, hosts?.hosts.map((h) => h.name) ?? [], {
              foldIds: rows.filter((r) => r.foldable).map((r) => r.id),
              sessions: sessions.tabs.map((t) => t.host),
              groupNames,
              webServices: (name) => {
                const h = hostByName.get(name ?? details ?? ctx.selectedHost() ?? "");
                return h ? webServices(h) : [];
              },
            })
          }
          describe={(candidate) => {
            // A command name: its label and key. A Session's number: its Host.
            const [id = "", arg = ""] = candidate.split(" ");
            const command = commands.get(id);
            if (command && arg === "") return { label: command.label(), keys: hintFor(keymap, id) };
            const tab = command?.arg === "number" ? sessions.tabs[Number(arg) - 1] : undefined;
            return tab ? { label: tab.host, keys: null } : null;
          }}
          keys={keymap.cmdline}
          leader={options.leader}
          {...(overlay.caret !== undefined ? { caret: overlay.caret } : {})}
          onHelp={(line, caret) => {
            const topic = lineTopic(commands, line);
            if (!topic) return setMessage(`No command starts with ${line.trim().split(/\s+/)[0]}: Tab lists them`);
            closeOverlay();
            backToLine.current = { line, caret };
            run(`help ${topic}`);
            if (!helpView.snapshot().at) backToLine.current = null;
          }}
          onClose={closeOverlay}
          onRun={(line) => {
            closeOverlay();
            run(line);
          }}
        />
      )}
      <div className="message-line" role="status">
        {message}
      </div>
      {pieces("bottom")}
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
          {...(quickConnects
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
          {...(canAdd
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
  const lockKey = hintFor(keymap, "lock");
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

/** Why an unreviewed Host won't open, and how to change that (`:review`, api 6), or roster.yml. */
export function notReviewedMessage(name: string, canReview: boolean): string {
  return canReview
    ? `${name} isn't reviewed yet, so it can't be opened. :review ${name} marks it reviewed.`
    : `${name} isn't reviewed yet, so it can't be opened. Review it in roster first.`;
}

/** Service entries roster left out of their Hosts (a bad port, url or login type in roster.yml):
 * the file still loaded, so this is said once, not shown as an error. Null when there are none. */
export function servicesLeftOut(list: HostList): string | null {
  const all = list.hosts.flatMap((h) => (h.problems ?? []).map((p) => ({ host: h.name, ...p })));
  const [first] = all;
  if (!first) return null;
  if (all.length === 1) {
    const why = first.message.replace(/^service '[^']*': /, "");
    return `roster.yml loaded, but left out ${first.host}'s service ${first.service}: ${why} (roster info ${first.host} says how to fix it)`;
  }
  const names = all.slice(0, 3).map((p) => `${p.host}'s ${p.service}`);
  const more = all.length > 3 ? `, and ${all.length - 3} more` : "";
  return `roster.yml loaded, but left out ${all.length} services it can't use (${names.join(", ")}${more}): roster hosts says why and how to fix them`;
}

/** roster.yml doesn't load (an outside edit): its line, and that the last good Inventory stays. */
/** Where a saved password went, for the add message: said unless it's the personal vault (ticket 35). */
function savedIn(target: Omit<SaveTarget, "save_to"> | undefined): string {
  return target && target.kind !== "personal" ? `, in ${target.label}` : "";
}

export function inventoryBroken(e: InventoryFileError): string {
  const at = `roster.yml${e.line ? `:${e.line}` : ""}`;
  return `${at} has an error (${e.message}): the last good Inventory is still in use`;
}

/** The State's key for the Sidebar shown or hidden, per view mode (issue #78). */
const SIDEBAR_KEY = "sidebar";

/** What the State holds for the Sidebar, per mode (untrusted: only booleans count). */
function sidebarChoices(state: Readonly<Record<string, unknown>>): Partial<Record<ViewMode, boolean>> {
  const v = state[SIDEBAR_KEY];
  if (typeof v !== "object" || v === null) return {};
  const out: Partial<Record<ViewMode, boolean>> = {};
  for (const [mode, shown] of Object.entries(v)) if (typeof shown === "boolean") out[mode as ViewMode] = shown;
  return out;
}

function sidebarChoice(state: Readonly<Record<string, unknown>>, mode: ViewMode): boolean | null {
  return sidebarChoices(state)[mode] ?? null;
}
