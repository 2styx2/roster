// Generated from roster-core's Rust types by crates/roster-core/tests/ts_types.rs: don't edit.
// `ROSTER_WRITE_TS=1 cargo test --test ts_types` writes it again.

/**
 * What a load gave: the Config in effect, and the error if the file couldn't be used.
 */
export type ConfigReport = {
  config: Config,
  error: ConfigError | null,
  /**
   * The file's full path, for messages ("edit C:\Users\…\init.lua").
   */
  path: string,
  /**
   * Counts the reloads, from 1: the frontend keeps the highest it has seen, so a report that
   * arrives late (a startup load after a save's event) never replaces a newer one.
   */
  version: number,
};

/**
 * What went wrong: where, and what. Shown as `init.lua:12: message`.
 */
export type ConfigError = {
  /**
   * Relative to the config dir: `init.lua`, `lua/keys.lua`.
   */
  file: string,
  line: number | null,
  message: string,
};

/**
 * The whole Config: built-in defaults with `init.lua`'s values layered over them.
 */
export type Config = {
  /**
   * A Theme's id, or "auto" to follow the OS with `dark_theme` / `light_theme`.
   */
  theme: string,
  darkTheme: string,
  lightTheme: string,
  /**
   * New Themes (or changed copies of bundled ones), by id.
   */
  themes: { [key in string]: ThemeDef },
  /**
   * Colour tokens set over whichever Theme is in use.
   */
  colors: ThemeColors,
  /**
   * The UI's fonts (decision Q30).
   */
  fonts: Fonts,
  /**
   * The rest of the UI's look.
   */
  ui: Ui,
  /**
   * Every panel's default width (ticket 95, decision Q106): `panel.width`.
   */
  panel: Panel,
  /**
   * Per panel or view id (`help`, `details`, a Plugin view's id): its default place and width.
   */
  views: { [key in string]: ViewLayout },
  terminal: Terminal,
  /**
   * The chord that takes the keyboard back from a terminal.
   */
  leader: string,
  vim: boolean,
  idleLockMinutes: number,
  /**
   * How old the last pull of the infra repo may be before a form pulls again, in the background
   * (decision Q88); 0 pulls every time.
   */
  pullFreshMinutes: number,
  /**
   * The view mode at start: "standard" or "focus" (decision Q36).
   */
  defaultMode: ViewMode,
  /**
   * Open Sessions listed in the Sidebar, or in a tab strip.
   */
  sessions: SessionsIn,
  /**
   * Key bindings: in Lua, per context, key or sequence → action (a command line), or false
   * to unbind. Sent as a list.
   */
  keys: Keys,
  /**
   * The layout of each view mode (decision Q39).
   */
  modes: Modes,
  /**
   * Personal Folders (GLOSSARY: Folder) defined here; read-only in the app.
   */
  folders: Array<FolderDef>,
  /**
   * The command that runs roster (development). The `ROSTER_APP_ROSTER` env var wins.
   */
  rosterCommand: RosterCommand | null,
  /**
   * "auto", "local", "wsl" or "wsl:<distro>". `ROSTER_APP_WSL_DISTRO` wins.
   */
  backend: BackendChoice,
  /**
   * What `:config` opens init.lua with (ticket 32).
   */
  editor: Editor,
  /**
   * Reload on every save of a `.lua` file. Off by default: `:source` reloads, as in Neovim
   * (decision Q58).
   */
  autoReload: boolean,
  /**
   * The proxy Plugins' requests to public names go through (decision Q116): `http://HOST:PORT`,
   * never with credentials. None: they go direct.
   */
  pluginProxy: string | null,
  /**
   * This Box's own vault settings, sent to roster serve (`vault.configure`, tickets 35 and 41).
   */
  vault: VaultConfig,
  /**
   * Packages: Plugins from git repos, pinned in `roster.lock` (ticket 24, decision Q83). In
   * Lua, `{ "owner/repo", tag = "v1.0.0", config = { … } }` or a plain `"owner/repo"`; the
   * first item becomes `source` (config/lua.rs).
   */
  packages: Array<PackageSpec>,
  /**
   * Where each value came from in the file, for warnings the frontend raises (an unknown
   * command in `keys`). Filled in after the schema check; never read from Lua.
   */
  lines: { [key in string]: ConfigLocation },
  /**
   * The options the file set, in its returned table or through `roster.set`, as Lua paths
   * down to each value (`terminal.size`, `modes.focus.sidebar`), sorted. `:help options`
   * (ticket 37) says these came from init.lua, even when a value equals its default. Filled
   * in after the schema check; never read from Lua.
   */
  set: Array<string>,
  /**
   * The deprecated options the file set (ticket 48), each applied under its new name; the
   * frontend warns about each one, at `lines[old]`. Never read from Lua.
   */
  deprecated: Array<DeprecatedUse>,
};

/**
 * A place in a Lua file.
 */
export type ConfigLocation = {
  /**
   * Relative to the config dir, `/`-separated: `init.lua`, `lua/keys.lua`.
   */
  file: string,
  line: number,
};

/**
 * A deprecated option the file set, for the frontend's warning.
 */
export type DeprecatedUse = {
  old: string,
  new: string,
  /**
   * Its row in `:help deprecated`: `deprecated#terminalfont_size`.
   */
  topic: string,
};

/**
 * A Theme defined in `init.lua`: a bundled one (`base`) with tokens changed, or a new one.
 */
export type ThemeDef = {
  /**
   * Shown in the app; the id if left out.
   */
  label?: string,
  /**
   * "dark" or "light": which OS appearance it suits. The base's if left out.
   */
  appearance?: Appearance,
  /**
   * The Theme it starts from: every token it doesn't set comes from there. Defaults to
   * Roster dark or Roster light, by `appearance`.
   */
  base?: string,
  colors: ThemeColors,
  terminal: ThemeTerminalColors,
  /**
   * The terminal's 16 colours; `false` keeps the standard palette even if the base has its
   * own. Left out: the base's.
   */
  ansi: AnsiChoice,
};

export type Appearance = "dark" | "light";

/**
 * The UI's colour tokens (src/theme/theme.ts ThemeColors).
 */
export type ThemeColors = {
  accent?: string,
  accentText?: string,
  accentInk?: string,
  tone?: string,
  bg?: string,
  chrome?: string,
  sidebar?: string,
  panel?: string,
  raised?: string,
  raisedLine?: string,
  hover?: string,
  line?: string,
  lineStrong?: string,
  text?: string,
  muted?: string,
  faint?: string,
  warn?: string,
  error?: string,
  danger?: string,
  dangerText?: string,
  backdrop?: string,
  shadow?: string,
  syntaxKeyword?: string,
  syntaxString?: string,
  syntaxNumber?: string,
  syntaxComment?: string,
  syntaxFunction?: string,
  syntaxPunctuation?: string,
  syntaxKey?: string,
  syntaxCommand?: string,
};

/**
 * A Theme's own terminal colours, apart from the 16 ANSI ones.
 */
export type ThemeTerminalColors = {
  background?: string,
  foreground?: string,
  cursor?: string,
  cursorAccent?: string,
  selectionBackground?: string,
  searchMatch?: string,
  searchActiveMatch?: string,
};

/**
 * The 16 ANSI colours; any left out keep the standard palette's (decision Q37).
 */
export type Ansi = {
  black?: string,
  red?: string,
  green?: string,
  yellow?: string,
  blue?: string,
  magenta?: string,
  cyan?: string,
  white?: string,
  brightBlack?: string,
  brightRed?: string,
  brightGreen?: string,
  brightYellow?: string,
  brightBlue?: string,
  brightMagenta?: string,
  brightCyan?: string,
  brightWhite?: string,
};

/**
 * `ansi = { … }`, `ansi = false`, or nothing.
 */
export type AnsiChoice = "inherit" | "standard" | Ansi;

/**
 * `terminal.colors`: any terminal colour, the ANSI ones included.
 */
export type TerminalColors = {
  background?: string,
  foreground?: string,
  cursor?: string,
  cursorAccent?: string,
  selectionBackground?: string,
  searchMatch?: string,
  searchActiveMatch?: string,
  black?: string,
  red?: string,
  green?: string,
  yellow?: string,
  blue?: string,
  magenta?: string,
  cyan?: string,
  white?: string,
  brightBlack?: string,
  brightRed?: string,
  brightGreen?: string,
  brightYellow?: string,
  brightBlue?: string,
  brightMagenta?: string,
  brightCyan?: string,
  brightWhite?: string,
};

export type Fonts = {
  /**
   * A family name ("Inter") or a whole CSS font stack (anything with a comma).
   */
  ui: string,
  /**
   * The wordmark's and code-like UI text's font.
   */
  mono: string,
  /**
   * The UI's body text size in px; the rest of the type scale and the row height follow it.
   */
  uiSize: number,
};

/**
 * The UI's look, apart from fonts and colours.
 */
export type Ui = {
  /**
   * Show the keycap hints (status bar, empty states, panels, Picker footers, menus). Unset:
   * `:hints` decides and the State keeps its choice; set, it wins.
   */
  hints: boolean | null,
  /**
   * What the message line shows (ticket 111): `"quiet"`, errors, warnings and answers only, as
   * Neovim; `"all"`, routine confirmations and tips too. Unset: `:messages` decides and the
   * State keeps its choice (quiet until it makes one); set, it wins.
   */
  messages: MessagesLevel | null,
};

/**
 * `ui.messages`: which messages the message line shows.
 */
export type MessagesLevel = "quiet" | "all";

/**
 * `panel`: what every panel and view starts with (ticket 95). The user's own choice, kept in the
 * State, wins over these: they're defaults (decision Q106).
 */
export type Panel = {
  /**
   * A docked panel's width in percent of the window (10 to 95). Unset: each panel's own.
   */
  width: number | null,
};

/**
 * `views.ID`: one panel's or view's default place and width.
 */
export type ViewLayout = {
  /**
   * Docked beside the terminal (`"panel"`) or over the whole window (`"full"`).
   */
  place: PanelPlace | null,
  /**
   * Docked width in percent of the window (10 to 95).
   */
  width: number | null,
};

export type PanelPlace = "panel" | "full";

export type Terminal = {
  /**
   * Font families in order of preference: the first one installed (or bundled) is used
   * (ticket 33). A name, a CSS stack, or a list.
   */
  font: FontList,
  /**
   * A number is px; "16pt" is points, converted as Windows Terminal does. Zoom keys move it,
   * `Ctrl+0` comes back here.
   */
  size: FontSize,
  /**
   * 100–900. Medium (500) by default; the bundled Iosevka has 400, 500 and 700.
   */
  weight: number,
  boldWeight: number,
  /**
   * A multiple of the font's own line height (xterm's lineHeight).
   */
  lineHeight: number,
  /**
   * A multiple of the font size, as Windows Terminal's `cellHeight`; wins over
   * `line_height` when set.
   */
  cellHeight: number | null,
  scrollback: number,
  copyOnSelect: boolean,
  /**
   * Right-click copies the selection, or pastes when nothing is selected.
   */
  rightClickPaste: boolean,
  /**
   * A program may set the clipboard with OSC 52 (write only, from the Session on screen, at
   * most 1 MiB; decision Q149), as in Windows Terminal.
   */
  osc52: boolean,
  /**
   * xterm's renderer: WebGL (fast) or the DOM (the browser's own text rendering).
   */
  renderer: Renderer,
  cursorStyle: CursorStyle,
  /**
   * Bold text in the bright ANSI colours too (xterm's drawBoldTextInBrightColors).
   */
  boldIsBright: boolean,
  /**
   * Terminal colours over the Theme's: background, cursor, the 16 ANSI colours…
   */
  colors: TerminalColors,
  /**
   * Send each Session's shell the one-line hook that turns on OSC 133 marks and OSC 7 (ticket
   * 121, decision Q130). Unset: a Host's `shell_hooks: true` in roster.yml decides; `true`: every
   * Session but a Host's `shell_hooks: false`; `false`: none.
   */
  shellHooks: boolean | null,
};

/**
 * Font families, most wanted first. From Lua: a name ("Iosevka"), a CSS stack
 * ("\"Fira Code\", Consolas"), or a list ({ "Iosevka Nerd Font", "Iosevka" }).
 */
export type FontList = Array<string>;

/**
 * A font size: px, or points (Windows Terminal's unit).
 */
export type FontSize = number;

export type Renderer = "webgl" | "dom";

export type CursorStyle = "block" | "bar" | "underline";

export type ViewMode = "standard" | "focus";

export type SessionsIn = "sidebar" | "tabs";

/**
 * The Config's key bindings, in context order, then key order.
 */
export type Keys = Array<ConfigKey>;

/**
 * One key binding from the Config.
 */
export type ConfigKey = {
  context: KeyContext,
  /**
   * A chord or a sequence: "x", "Ctrl+n", "g g".
   */
  keys: string,
  action: KeyAction,
};

/**
 * The keymap's contexts (src/keymap.ts Keymap).
 */
export type KeyContext = "leader" | "list" | "listVim" | "picker" | "pickerVim" | "cmdline" | "terminal" | "global";

/**
 * What a key does: an action (a command line such as "session 1"), or nothing (`false`
 * unbinds a default). Serialized as the string, or null.
 */
export type KeyAction = string | null;

/**
 * Each view mode's layout (decision Q39). The pieces: title bar, Sidebar (and its sections),
 * session bar, status bar (and its segments).
 */
export type Modes = {
  standard: ModeConfig,
  focus: ModeConfig,
};

/**
 * One mode's layout, as sent to the frontend: every piece, shown or not.
 */
export type ModeConfig = {
  /**
   * OS fullscreen (Focus by default).
   */
  fullscreen: boolean,
  titlebar: boolean,
  sidebar: SidebarPiece,
  sessionbar: SessionBarPiece,
  statusbar: StatusBarPiece,
  /**
   * The visible controls for common commands (decision Q65): in the title bar, or a bar of
   * their own at the top when the mode has no title bar.
   */
  toolbar: ToolbarPiece,
  /**
   * The pieces `init.lua` set, by name ("sidebar", "toolbar"…): what it sets wins over what the
   * app keeps in the State (the Sidebar shown or hidden, issue #78). Empty for the defaults.
   */
  set: Array<string>,
};

export type SidebarPiece = {
  shown: boolean,
  side: Side,
  /**
   * Section ids in order ("sessions", "folders", "inventory"); null: all, in their order.
   */
  sections: Array<string> | null,
};

export type Side = "left" | "right";

export type SessionBarPiece = {
  shown: boolean,
  at: Edge,
};

export type Edge = "top" | "bottom";

export type StatusBarPiece = {
  shown: boolean,
  /**
   * Segment ids in order ("backend", "box", "inventory", "hosts", "path", "changes", "hints", "mode"); null: all.
   */
  segments: Array<string> | null,
};

/**
 * The toolbar (decision Q65): `true`, `false`, or its controls in order (`{ "add", "find" }`,
 * ids from the app's toolbar registry: "sidebar", "find", "quick", "add", "changes", "publish", "details", and the
 * ones not shown by default, "cmdline", "keys", "help", "lock", "mode"); null: the default set.
 */
export type ToolbarPiece = {
  shown: boolean,
  controls: Array<string> | null,
};

/**
 * A Folder defined in `init.lua`.
 */
export type FolderDef = {
  name: string,
  hosts: Array<string>,
};

/**
 * `roster_command = "uv run --project ~/work/roster roster"` (split on spaces) or a list.
 */
export type RosterCommand = Array<string>;

/**
 * Which roster to run (ticket 19 adds native Windows `local`).
 */
export type BackendChoice = string;

/**
 * What `:config` opens init.lua with: the OS's app for the file, or `$EDITOR` inside WSL (in a
 * console window of its own).
 */
export type Editor = "os" | "wsl";

/**
 * What init.lua says about the vault: this Box's own settings, which win over roster.yml's
 * `providers:`. The app sends them to roster serve (`vault.configure`) at start and after every
 * `:source`. Paths and choices only, never a secret (docs/app/security.md).
 */
export type VaultConfig = {
  /**
   * Where "Save to vault" puts new Vault items by default (ticket 35). None: roster.yml's.
   */
  saveTo: SaveTo | null,
  /**
   * KeePassXC (ticket 41): a local database is this Box's, not the team's.
   */
  kp: KeePassXc,
};

/**
 * `save_to`: the personal vault, an organization's collection (Bitwarden, by name or id), or a
 * group (KeePassXC). The same shape as roster.yml's `providers: NAME: save_to:`.
 */
export type SaveTo = "personal" | { organization: string, collection: string, } | { group: string, };

export type KeePassXc = {
  /**
   * The `.kdbx`, on the Box roster runs on (WSL's file system for a WSL Backend).
   */
  database: string | null,
  /**
   * A key file used with the master password, on the same Box.
   */
  keyFile: string | null,
};

/**
 * A Package named in `init.lua` (ticket 24): where its git repo is, which version, and the
 * settings it's handed. At most one of `tag`, `branch` and `commit`; none means the repo's
 * default branch. Checked by `config::package_spec::check_specs`.
 */
export type PackageSpec = {
  /**
   * `"owner/repo"` (on GitHub) or a full git URL (`https://…`, `ssh://…`, `git@host:path`,
   * `file://…` or a full path to a repo on this machine).
   */
  source: string,
  /**
   * The Package's name (its folder and its key in `roster.lock`); the repo's name by default.
   */
  name: string | null,
  tag: string | null,
  branch: string | null,
  commit: string | null,
  /**
   * The folder in the repo that holds the Plugin (`plugins/topology`), when it isn't the repo's
   * top (decision Q94). Relative, inside the repo, `/` between folders.
   */
  dir: string | null,
  /**
   * Settings handed to the Package as `roster.plugin.config` (a table; never a function).
   */
  config: Record<string, unknown>,
};

/**
 * What `:config` did (ticket 32): init.lua's full path, and whether it was just made.
 */
export type ConfigOpened = {
  path: string,
  /**
   * It was just made, from the example with every option commented out.
   */
  created: boolean,
};

/**
 * What `:config import-terminal` would do, before it does it.
 */
export type ImportPreview = {
  settingsPath: string,
  /**
   * One line per thing it takes ("Font: Iosevka Nerd Font, 16 pt (21.3 px)").
   */
  summary: Array<string>,
  diff: Array<DiffLine>,
  /**
   * The Theme it defines for the profile's colour scheme, which the app then chooses as
   * `:theme` does (decision Q69); none without a scheme.
   */
  theme: string | null,
  /**
   * Options it sets that init.lua sets again where it wins: in its returned table, or in a
   * line after the block (an older block is replaced in place, so a line below it stays later).
   */
  overridden: Array<ImportOverridden>,
  /**
   * There's no init.lua yet: it would be made from the commented-out example.
   */
  created: boolean,
  /**
   * What [`apply`] checks init.lua against, so a file changed since isn't overwritten.
   */
  base: string,
  /**
   * The fingerprint of init.lua as this preview would leave it: [`apply`] writes only that.
   */
  result: string,
  /**
   * The date in the block's comment, so applying it another day writes the same block.
   */
  date: string,
  /**
   * The Config error the new file would have, if any.
   */
  error: string | null,
};

export type DiffLine = {
  kind: DiffKind,
  text: string,
};

export type DiffKind = "same" | "add" | "remove";

/**
 * An option the import sets that init.lua sets again where it wins.
 */
export type ImportOverridden = {
  option: string,
  by: Wins,
  /**
   * The later line; none for the returned table.
   */
  at: ConfigLocation | null,
};

/**
 * What wins over the import for an option it sets.
 */
export type Wins = "returned" | "later";

/**
 * What the app hands back to [`apply`] from the [`Preview`] the user confirmed.
 */
export type Previewed = {
  base: string,
  result: string,
  date: string,
};

/**
 * What the UI learns about the Backend once it's up.
 */
export type BackendInfo = {
  /**
   * "Local" or "WSL: <distro>": the label the UI shows.
   */
  backend: string,
  /**
   * Where serve runs: on this machine, or in a WSL distro.
   */
  kind: BackendKind,
  /**
   * The WSL distro serve runs in (`kind: "wsl"`); null on this machine. Empty: WSL's default.
   */
  distro: string | null,
  /**
   * The command line that runs serve.
   */
  command: Array<string>,
  /**
   * The `inventory.info` result as roster sent it (its shape is serve's, not the core's).
   */
  inventory: unknown,
};

/**
 * Where serve runs ([`Target`]), as the frontend tells them apart.
 */
export type BackendKind = "local" | "wsl";

export type BackendProblem = {
  kind: BackendProblemKind,
  /**
   * What went wrong, one sentence.
   */
  message: string,
  /**
   * What to do about it.
   */
  hint: string,
  /**
   * Raw detail for the curious: roster's stderr, the command that ran.
   */
  detail: string | null,
};

export type BackendProblemKind = "no-wsl" | "roster-missing" | "roster-too-old" | "inventory-not-found" | "inventory-invalid" | "failed";

export type CallErrorWire = { "kind": "rpc", code: number, message: string, data: unknown, } | { "kind": "exited", code: number | null, stderr: string, } | { "kind": "timeout" } | { "kind": "io", message: string, };

/**
 * Why making an Inventory failed (`inventory_create`): which roster to run couldn't be found or
 * started (a [`BackendError`], with its kind and what to do, as `backend_connect` says it), or
 * serve's call failed. On the wire it's either shape as it is.
 */
export type InventoryCreateError = BackendProblem | CallErrorWire;

/**
 * A check the core has under way (`host.check {background: true}`), as it starts: serve's job id,
 * and whether it's the app's own to stop (#221 item 1): the core started it, or joined a check it
 * had started itself. A check another caller started (a Plugin's `host.check`) isn't: stopping it
 * would cut that caller's answer short.
 */
export type CheckStarted = {
  job: string,
  own: boolean,
};

/**
 * A Session that's started, as the frontend hears of it.
 */
export type OpenedSession = {
  id: number,
  /**
   * How it logs in: "key" or "password", as serve said.
   */
  auth: "key" | "password",
  /**
   * serve's id for a Quick Connect (ticket 14).
   */
  quick?: string,
  /**
   * The id serve holds a typed password under for "Save to vault" (tickets 15, 16), when asked.
   */
  held?: string,
  /**
   * Its PTY is Windows' ConPTY: the app offers only the fills the core makes there (decision
   * Q151 (i), ticket 162).
   */
  conpty: boolean,
  /**
   * The ssh user the core fills sudo's prompt for (`session.prepare`'s login), so the app judges
   * sudo's prompt by the same user (the review of #308, #6). None for a Quick Connect.
   */
  user?: string,
};

/**
 * How a Session ended.
 */
export type SessionExit = {
  /**
   * The exit code; `None` when a signal ended it.
   */
  code: number | null,
  /**
   * True when the app closed it ([`SessionManager::close`]): the code is then meaningless
   * (on Windows, closing gives `0xC000013A`).
   */
  closed: boolean,
};

/**
 * The message a Session's channel ends with, after its output: `{"exit": {code, closed}}`.
 */
export type SessionExitMessage = {
  exit: SessionExit,
};

/**
 * Facts about this machine the terminal needs: the Windows build, for xterm's `windowsPty`.
 */
export type PlatformInfo = {
  windowsBuild: number | null,
};

/**
 * `folders.yml`'s path and text (null: no file yet).
 */
export type FoldersFile = {
  path: string,
  text: string | null,
};

/**
 * Whose call a run is (decision Q98, issue #183), as the app says it with each call.
 */
export type PluginCallBy = "user" | "carried" | "app";

/**
 * What a Plugin's manifest says about it: shown in the install prompt before any of its code runs.
 */
export type PluginManifest = {
  name: string,
  version: string,
  description: string,
  author: string | null,
  /**
   * The `roster.api_version` it was written for.
   */
  api: number,
  permissions: Array<PluginPermission>,
};

/**
 * A permission as the manifest asks for it, with what it allows and why it's risky (decision Q81).
 */
export type PluginPermission = {
  name: string,
  summary: string,
  risk: string | null,
};

/**
 * `:plugins install PATH`'s first step: the manifest, and the folder as the app keeps it.
 */
export type PluginManifestRead = {
  manifest: PluginManifest,
  dir: string,
};

/**
 * What a load gives back: the manifest, the folder as the app keeps it, the load's reply, and the
 * grants the core no longer takes, each with why (`serve:x.y: …`): it runs without them.
 */
export type PluginLoaded = {
  manifest: PluginManifest,
  dir: string,
  reply: PluginReply,
  refused: Array<string>,
};

/**
 * The answer to a load, a call or an event, for one Plugin.
 */
export type PluginReply = {
  plugin: string,
  /**
   * What the function returned, as data (a finder's items, say).
   */
  result: unknown,
  /**
   * The UI changes the Plugin asked for, in order (docs/plugins.md, "Ops"): untrusted data,
   * which the app's plugins/ops.ts checks.
   */
  ops: unknown[],
  error: PluginErrorInfo | null,
  /**
   * Set when the Plugin is now disabled, with why: the frontend takes its UI away.
   */
  disabled: string | null,
  /**
   * The events the Plugin listens for now, in [`api::EVENTS`]' order, when that's news to the app:
   * always at load, then only after a call, event or answer that changed it (#223, decision
   * Q185: the app keeps a command's output for `command_done` only while a Plugin listens).
   */
  listens?: Array<string>,
};

/**
 * What went wrong in a Plugin: shown as `recent-alerts: init.lua:12: message`.
 */
export type PluginErrorInfo = {
  plugin: string,
  file: string | null,
  line: number | null,
  message: string,
};

/**
 * A demo's reply nobody asked for (`plugin-demo-reply`), with the demo's number so an old demo's
 * never reaches a new one.
 */
export type PluginDemoReply = {
  demo: number,
  reply: PluginReply,
};

/**
 * How a Plugin used one site, for `:plugins` (decision Q116): counts and a time, never a path,
 * a query, a header or a body.
 */
export type SiteRequests = {
  /**
   * The site as its permission names it (`api.example.com`, `private:nas.lan`).
   */
  site: string,
  requests: number,
  /**
   * Of those, the ones that got no answer (an HTTP error status is an answer).
   */
  failed: number,
  /**
   * When the last one was sent, in milliseconds since 1970.
   */
  last: number,
};

/**
 * How full a Plugin's data folder is, for `:plugins` (ticket 98): what the caps count, never
 * what the files hold.
 */
export type PluginData = { "state": "none" } | { "state": "used", files: number, bytes: number, } | { "state": "problem", message: string, };

/**
 * A Package as `:packages` lists it.
 */
export type PackageStatus = {
  name: string,
  /**
   * As init.lua writes it (`owner/repo`).
   */
  source: string,
  /**
   * The git URL that means.
   */
  url: string,
  /**
   * The folder in the repo the Plugin loads from (`plugins/topology`); none for the top.
   */
  dir: string | null,
  /**
   * What init.lua asks for: `tag v1.0.0`, `branch main`, `commit 1a2b3c4`, `default branch`.
   */
  wants: string,
  /**
   * The commit its clone is at, if it has one.
   */
  commit: string | null,
  /**
   * The commit `roster.lock` pins, if it pins one for this source.
   */
  locked: string | null,
  /**
   * Installed: the lock pins the commit the clone is at. Not yet: waiting for the install prompt.
   */
  pinned: boolean,
  /**
   * The settings init.lua hands it (`roster.plugin.config`).
   */
  config: Record<string, unknown>,
  /**
   * Something the user should know (init.lua names another version than the lock).
   */
  note: string | null,
  /**
   * Why it couldn't be cloned or checked out.
   */
  error: string | null,
};

/**
 * A newer commit for a Package, as `:packages update` shows it before applying it.
 */
export type PackageUpdate = {
  from: string,
  to: string,
  /**
   * `1a2b3c4 Subject`, newest first (at most [`MAX_LOG`]).
   */
  log: Array<string>,
  /**
   * `git diff --stat`.
   */
  stat: string,
  /**
   * The diff itself, cut to [`MAX_DIFF`].
   */
  diff: string,
  truncated: boolean,
  /**
   * The new version's manifest (its permissions are compared with what was asked before).
   */
  manifest: PluginManifest | null,
  manifestError: string | null,
};

/**
 * One Package's answer to [`Packages::check`]: an update, an error, or neither (up to date).
 */
export type PackageChecked = {
  name: string,
  update: PackageUpdate | null,
  error: string | null,
};
