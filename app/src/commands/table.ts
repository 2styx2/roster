// The one command table (ticket 07, decision Q36): every app action is a command here, its id
// being its `:` command-line name. It's a Registry (ADR 0006): built-ins register as "builtin",
// and the Config and Plugins can add or shadow commands the same way. Keys (the keymap maps a key to a command line such as
// "session 1"), the command line and buttons (the Sidebar, the tab strip) all run commands
// through runLine, so a view mode only changes how commands are presented, never which exist.
// A command acts through CommandContext, which App provides.

import { groupCommand, hostCommand, type InventoryOp } from "../inventory/commands";
import { BUILTIN, Registry, type Entry } from "../registry";
import type { SidebarRow } from "../sidebar/Sidebar";
import { VIEW_MODES, type ViewMode } from "../view/layout";
import type { Message } from "../ui/messages";

export type ListMove = "down" | "up" | "top" | "bottom" | "choose";

/** h folds (or goes to the parent), l unfolds (or goes to the first child), toggle flips. */
export type FoldHow = "fold" | "unfold" | "toggle";

/** What commands can ask of the app. */
export interface CommandContext {
  openPicker(): void;
  /** Opens a Session to the Host (the app checks it exists and is reviewed); `here`: in the
   * current tab if its Session has ended, else a new one. */
  connect(host: string, here?: boolean): void;
  /** Quick Connect (ticket 14): a Session to `user@address[:port]`, a box that isn't in the
   * Inventory; null opens the Picker to type one. */
  quickConnect(target: string | null): void;
  /** Goes to the Host's open Session if there is one, else opens one (as `connect`). */
  open(host: string): void;
  /** Reconnects the current tab if its Session has ended or was refused. */
  reconnect(): void;
  /** Runs roster's diagnostics (`host.check`) for the Host; with none, this Box's health (`:help health`). */
  check(host: string | null): void;
  /** The Session `delta` places after the current one, wrapping. */
  selectRelative(delta: number): void;
  /** The Nth Session, counting from 1. */
  selectNth(n: number): void;
  /** Closes the Nth Session, or the current one. */
  close(n: number | null): void;
  toggleSidebar(): void;
  toggleStatusBar(): void;
  /** The command line, with `initial` typed in already (a prompt for the rest). */
  openCommandLine(initial?: string): void;
  toggleKeys(): void;
  lock(): void;
  /** `:vault signout` (ticket 42): asks first, naming the account, then signs the vault CLI out
   * and shows the lock screen's full sign-in form; says why for a provider with no account. */
  vault(action: VaultAction): void;
  /** Back to Terminal mode, closing the topmost side panel (Key bindings, :check) if one is open. */
  toTerminal(): void;
  /** Closes the topmost side panel, if one is open. */
  closePanel(): void;
  /** Moves the list cursor (the Sidebar in Standard), or chooses the row under it. */
  list(move: ListMove): void;
  /** Folds or unfolds the Sidebar row (or section heading) `id`, or the one under the cursor. */
  fold(id: string | null, how: FoldHow): void;
  /** The Sidebar row under the cursor, or null. */
  cursorRow(): SidebarRow | null;
  /** The Host the user means: the one under the Sidebar's cursor, else the Session on screen's. */
  selectedHost(): string | null;
  /** Every Host's name, in roster.yml order (empty until the Inventory is loaded). */
  hostNames(): readonly string[];
  /** A one-line message for the user: an error, a warning or an answer, or a quiet one (ui/messages.ts). */
  say(message: Message): void;
  /** The view mode now (decision Q36). */
  viewMode(): ViewMode;
  /** Switches to `mode`, or to the other one. */
  setViewMode(mode: ViewMode | null): void;
  /** Opens the Finder over a finder source (`sessions`, `hosts`, `tree`…), with `query` typed in
   * already when there's one (`:helpgrep TEXT`). */
  openFinder(source: string, query?: string): void;
  /** Says the Backend, the Box and the Inventory's path, whole (the status bar cuts them). */
  showInfo(): void;
  /** Host details (ticket 18): shows the Host's panel; null shows or hides it for the selected
   * Host. */
  details(host: string | null): void;
  /** Opens the edit form for the Host, or the selected one (ticket 10). */
  edit(host: string | null): void;
  /** Opens the add-Host form (ticket 11), in `group` (else the selected Host's). */
  addHost(group?: string): void;
  /** Opens "Save to vault" for the current Session, once it logged in with a password typed for it
   * (tickets 15, 16). */
  saveSession(): void;
  /** Fills the password prompt the current Session shows from the vault (ticket 119): only when
   * one is detected; the password goes from serve to the Session's PTY through the core, never
   * through the frontend. */
  fillPrompt(): void;
  /** `:integrate` (ticket 121): sends the current Session's shell the hook line now. */
  integrate(): void;
  /** Removes, renames or moves a Host, or makes, renames or deletes a group (ticket 28): asks
   * first where it should (removing a Host; a group whose Hosts need somewhere to go). */
  inventory(op: InventoryOp): void;
  /** Every group's name, in roster.yml order. */
  groupNames(): readonly string[];
  /** Marks the Host, or the selected one, reviewed (ticket 11); `reviewed: false` un-reviews it
   * (issue #78), for a review made by mistake. */
  review(host: string | null, reviewed?: boolean): void;
  /** Shows the Pending changes; `discard` asks to discard them straight away, `publish` opens
   * the Publish step (the diff for a last look, and the commit message). */
  showChanges(then?: "discard" | "publish"): void;
  /** Pulls the infra repo (fast-forward only) and says what happened. */
  pull(): void;
  /** `:config` (ticket 32): opens init.lua (making it first if there's none), reads it again,
   * or says where it is. */
  config(what: ConfigAction): void;
}

/** What `:vault` does: `:vault signout`. */
export const VAULT_ACTIONS = ["signout"] as const;
export type VaultAction = (typeof VAULT_ACTIONS)[number];

/** What `:config` does: `:config`, `:config reload`, `:config path`, `:config types`. */
export const CONFIG_ACTIONS = ["open", "reload", "path", "import-terminal", "types"] as const;
export type ConfigAction = (typeof CONFIG_ACTIONS)[number];
/** The ones typed after `config` (open is `:config` alone). */
const CONFIG_SUBCOMMANDS: readonly string[] = CONFIG_ACTIONS.filter((a) => a !== "open");

export interface CommandDef extends Entry {
  /** id: the `:` name, and what the keymap binds keys to. */
  area: string;
  /** What it does, for the Key bindings panel and completion. */
  label(arg?: string): string;
  /** More about it, for `:help commands` (and `:help :ID`): one paragraph of Markdown under the
   * label, whose links are help topics (`[options](options)`, `[:review](:review)`). */
  doc?: string;
  arg?: "host" | "number" | "text";
  /** The argument may be left out. */
  optionalArg?: boolean;
  /** App mode goes on after it (moving a list); otherwise keys go back to the terminal. */
  staysInAppMode?: boolean;
  /** A list or tree motion (j, k, h, l…): ranked last in completion, as it's meant for keys. */
  motion?: boolean;
  /** Typed now and then (`config`): ranked after the everyday commands in completion, so `co`
   * still completes `connect` first. */
  seldom?: boolean;
  run(ctx: CommandContext, arg: string | undefined): void;
  /** Completions for the argument typed so far (whole arguments), when `arg` is "text". A
   * command from the Config or a Plugin completes the same way (ticket 34). */
  complete?(arg: string, hostNames: readonly string[], ctx?: CompletionContext): string[];
}

/** What completion knows of the app now, beyond the command table (ticket 34). */
export interface CompletionContext {
  /** Every Host's name, in roster.yml order. */
  hostNames: readonly string[];
  /** The Sidebar's rows that fold, by id: `section:sessions`, `group:subnet-42`, `folders:Lab`. */
  foldIds: readonly string[];
  /** The open Sessions' Hosts, in order (what `session N` and `close N` take). */
  sessions: readonly string[];
  /** Every group's name, in roster.yml order (`host move`, `group …`, ticket 28). */
  groupNames?: readonly string[];
  /** The web services of a Host, or (null) of the current one: Host details', else the selected
   * Host's (`:open`, ticket 18). */
  webServices?(host: string | null): readonly string[];
}

/** Names that start with `word` first, then the rest that contain it, without case. */
export function matching(names: readonly string[], word: string): string[] {
  const w = word.toLowerCase();
  const lower = (n: string) => n.toLowerCase();
  return [...names.filter((n) => lower(n).startsWith(w)), ...names.filter((n) => !lower(n).startsWith(w) && lower(n).includes(w))];
}

const fold = (id: string, how: FoldHow, label: string): CommandDef => ({
  id,
  source: BUILTIN,
  area: "Sidebar",
  arg: "text",
  optionalArg: how !== "toggle",
  label: (row) => (row ? `${label} ${row}` : label),
  staysInAppMode: true,
  motion: true,
  run: (ctx, row) => ctx.fold(row ?? null, how),
  complete: (row, _hosts, ctx) => matching(ctx?.foldIds ?? [], row),
});

const list = (move: ListMove, label: string): CommandDef => ({
  id: move,
  source: BUILTIN,
  area: "Sidebar",
  label: () => label,
  staysInAppMode: move !== "choose",
  motion: true,
  run: (ctx) => ctx.list(move),
});

export const builtinCommands: readonly CommandDef[] = [
  { id: "find", source: BUILTIN, area: "Hosts", label: () => "Find a Host", run: (ctx) => ctx.openPicker() },
  {
    id: "connect",
    source: BUILTIN,
    area: "Hosts",
    arg: "host",
    label: (h) => (h ? `Connect to ${h}` : "Open a Session to a Host, or to user@address (Quick Connect)"),
    doc:
      "Opens a new Session to the Host, in a tab of its own. A Host that isn't reviewed yet stays closed until you " +
      "review it ([:review](:review)). Anything that isn't a Host's name but reads as `user@address` or " +
      "`user@address:port` is a Quick Connect: the tab shows the box's host key for you to check, and asks for a " +
      "password (left empty, this Box's own keys log in). [:here](:here) reuses a tab whose Session has ended; " +
      "[Connection errors](errors-guide) says what to do when it doesn't connect.",
    run: (ctx, h) => ctx.connect(h ?? ""),
  },
  {
    // A Host (or its open Session), or a web service in the default browser (ticket 18, Q71):
    // `open HOST`, `open SERVICE` (the current Host's), `open HOST SERVICE`. A Host's name wins.
    id: "open",
    source: BUILTIN,
    area: "Hosts",
    arg: "text",
    label: (a) =>
      a
        ? a.includes(" ")
          ? `Open ${a.replace(" ", "'s ")} in the browser`
          : `Open ${a}: the Host or its Session, else the current Host's web service`
        : "Open a Host or go to its Session, or open a web service in the browser",
    run: (ctx, a) => ctx.open(a ?? ""),
    complete: (word, hostNames, ctx) => {
      const space = word.indexOf(" ");
      if (space >= 0) {
        const host = word.slice(0, space);
        return matching(ctx?.webServices?.(host) ?? [], word.slice(space + 1).trimStart()).map((s) => `${host} ${s}`);
      }
      const names = [...new Set([...(ctx?.webServices?.(null) ?? []), ...[...hostNames].sort()])];
      return matching(names, word);
    },
  },
  {
    id: "here",
    source: BUILTIN,
    area: "Hosts",
    arg: "host",
    label: (h) => (h ? `Connect to ${h} in this tab` : "Open a Host in this tab, if its Session has ended"),
    run: (ctx, h) => ctx.connect(h ?? "", true),
  },
  {
    id: "quick",
    source: BUILTIN,
    area: "Hosts",
    arg: "text",
    optionalArg: true,
    label: (t) => (t ? `Quick Connect to ${t}` : "Quick Connect: a Session to user@address[:port], not in the Inventory"),
    run: (ctx, t) => ctx.quickConnect(t ?? null),
  },
  {
    id: "save",
    source: BUILTIN,
    area: "Sessions",
    label: () => "Save to vault: the password typed for this Session, once it logged in",
    run: (ctx) => ctx.saveSession(),
  },
  {
    id: "fill",
    source: BUILTIN,
    area: "Sessions",
    label: () => "Fill sudo's password prompt on screen from the Host's Login in the vault",
    run: (ctx) => ctx.fillPrompt(),
  },
  {
    id: "integrate",
    source: BUILTIN,
    area: "Sessions",
    label: () => "Turn on shell integration in this Session's shell: one line that marks its prompts and says its folder",
    run: (ctx) => ctx.integrate(),
  },
  {
    id: "reconnect",
    source: BUILTIN,
    area: "Sessions",
    label: () => "Reconnect an ended Session",
    run: (ctx) => ctx.reconnect(),
  },
  {
    id: "check",
    source: BUILTIN,
    area: "Hosts",
    arg: "host",
    optionalArg: true,
    label: (h) =>
      h
        ? `Check ${h}`
        : "Check this Box's health: roster.yml, ssh, the vault, askpass, init.lua, the font, Plugins' sections. With a Host (% for the one on screen): why a Session to it would fail",
    run: (ctx, h) => ctx.check(h ?? null),
  },
  {
    id: "edit",
    source: BUILTIN,
    area: "Inventory",
    arg: "host",
    optionalArg: true,
    label: (h) => (h ? `Edit ${h}` : "Edit a Host: title, description, type, address, user, Login"),
    run: (ctx, h) => ctx.edit(h ?? null),
  },
  hostCommand,
  groupCommand,
  {
    id: "review",
    source: BUILTIN,
    area: "Inventory",
    arg: "host",
    optionalArg: true,
    label: (h) => (h ? `Mark ${h} reviewed` : "Mark a Host reviewed, so it can be opened"),
    run: (ctx, h) => ctx.review(h ?? null),
  },
  {
    id: "unreview",
    source: BUILTIN,
    area: "Inventory",
    arg: "host",
    optionalArg: true,
    label: (h) => (h ? `Mark ${h} unreviewed` : "Mark a Host unreviewed again (a review made by mistake)"),
    run: (ctx, h) => ctx.review(h ?? null, false),
  },
  { id: "changes", source: BUILTIN, area: "Inventory", label: () => "Show the Pending changes", run: (ctx) => ctx.showChanges() },
  {
    id: "discard",
    source: BUILTIN,
    area: "Inventory",
    label: () => "Discard the Pending changes (asks first)",
    run: (ctx) => ctx.showChanges("discard"),
  },
  {
    id: "publish",
    source: BUILTIN,
    area: "Inventory",
    label: () => "Publish the Pending changes: commit and push roster.yml (a last look first)",
    run: (ctx) => ctx.showChanges("publish"),
  },
  { id: "pull", source: BUILTIN, area: "Inventory", label: () => "Pull the infra repo (fast-forward only)", run: (ctx) => ctx.pull() },
  { id: "next", source: BUILTIN, area: "Sessions", label: () => "Next Session", run: (ctx) => ctx.selectRelative(1) },
  { id: "prev", source: BUILTIN, area: "Sessions", label: () => "Previous Session", run: (ctx) => ctx.selectRelative(-1) },
  {
    id: "session",
    source: BUILTIN,
    area: "Sessions",
    arg: "number",
    label: (n) => `Go to Session ${n ?? "N"}`,
    run: (ctx, n) => ctx.selectNth(Number(n)),
  },
  {
    id: "close",
    source: BUILTIN,
    area: "Sessions",
    arg: "number",
    optionalArg: true,
    label: (n) => (n ? `Close Session ${n}` : "Close the Session"),
    run: (ctx, n) => ctx.close(n === undefined ? null : Number(n)),
  },
  { id: "sidebar", source: BUILTIN, area: "Sidebar", label: () => "Show or hide the Sidebar", run: (ctx) => ctx.toggleSidebar() },
  list("down", "Move down"),
  list("up", "Move up"),
  list("top", "Go to the top"),
  list("bottom", "Go to the bottom"),
  list("choose", "Switch to it"),
  fold("fold", "fold", "Fold, or go to the parent"),
  fold("unfold", "unfold", "Unfold, or go to the first child"),
  fold("togglefold", "toggle", "Fold or unfold"),
  {
    id: "mode",
    source: BUILTIN,
    area: "View",
    arg: "text",
    optionalArg: true,
    label: (m) => (m ? `Switch to ${m} mode` : "Switch the view mode"),
    run: (ctx, m) => {
      if (m === undefined) return ctx.setViewMode(null);
      const mode = VIEW_MODES.find((v) => v === m.toLowerCase());
      if (!mode) return ctx.say(`Not a view mode: ${m} (${VIEW_MODES.join(", ")})`);
      ctx.setViewMode(mode);
    },
    complete: (m) => VIEW_MODES.filter((v) => v.startsWith(m.toLowerCase())),
  },
  {
    id: "focus",
    source: BUILTIN,
    area: "View",
    label: () => "Focus mode on or off",
    run: (ctx) => ctx.setViewMode(ctx.viewMode() === "focus" ? "standard" : "focus"),
  },
  { id: "cmdline", source: BUILTIN, area: "App", label: () => "Command line", run: (ctx) => ctx.openCommandLine() },
  { id: "keys", source: BUILTIN, area: "App", label: () => "Key bindings", run: (ctx) => ctx.toggleKeys() },
  { id: "statusbar", source: BUILTIN, area: "App", label: () => "Show or hide the status bar", run: (ctx) => ctx.toggleStatusBar() },
  { id: "lock", source: BUILTIN, area: "App", label: () => "Lock", run: (ctx) => ctx.lock() },
  {
    id: "vault",
    source: BUILTIN,
    area: "App",
    seldom: true,
    arg: "text",
    label: (what) =>
      what === "signout"
        ? "Sign the vault CLI out, to sign in to a different account (asks first)"
        : "The vault: signout signs its CLI out, to use a different account",
    run: (ctx, what) => {
      const action = VAULT_ACTIONS.find((a) => a === what?.toLowerCase());
      if (!action) return ctx.say(`vault takes ${VAULT_ACTIONS.join(", ")}`);
      ctx.vault(action);
    },
    complete: (what) => VAULT_ACTIONS.filter((a) => a.startsWith(what.toLowerCase())),
  },
  { id: "terminal", source: BUILTIN, area: "App", label: () => "Back to the terminal", run: (ctx) => ctx.toTerminal() },
  { id: "hidepanel", source: BUILTIN, area: "App", label: () => "Close the side panel", run: (ctx) => ctx.closePanel() },
  {
    id: "config",
    source: BUILTIN,
    area: "App",
    seldom: true,
    arg: "text",
    optionalArg: true,
    label: (what) =>
      what === "reload"
        ? "Read init.lua again"
        : what === "path"
          ? "Say where init.lua is"
          : what === "import-terminal"
            ? "Copy Windows Terminal's font and colours into init.lua"
            : what === "types"
              ? "Write the option types for your editor (types/roster-config.lua)"
              : "Open init.lua, the Config",
    run: (ctx, what) => {
      if (what === undefined) return ctx.config("open");
      const action = CONFIG_SUBCOMMANDS.find((a) => a === what.toLowerCase()) as ConfigAction | undefined;
      if (!action) {
        const list = CONFIG_SUBCOMMANDS.slice(0, -1).join(", ") + " or " + CONFIG_SUBCOMMANDS.at(-1);
        return ctx.say(`config takes nothing, ${list}`);
      }
      ctx.config(action);
    },
    complete: (what) => CONFIG_SUBCOMMANDS.filter((a) => a.startsWith(what.toLowerCase())),
  },
  {
    // `:info` alone says what the app runs on; `:info HOST` shows Host details (ticket 18, Q71).
    id: "info",
    source: BUILTIN,
    area: "Hosts",
    arg: "host",
    optionalArg: true,
    label: (h) =>
      h ? `Show ${h}'s details` : "Show a Host's details (address, services, Logins), or alone: the Backend, the Box and the Inventory",
    run: (ctx, h) => (h ? ctx.details(h) : ctx.showInfo()),
  },
  {
    id: "details",
    source: BUILTIN,
    area: "Hosts",
    label: () => "Show or hide Host details for the selected Host",
    run: (ctx) => ctx.details(null),
  },
];

export type CommandRegistry = Registry<CommandDef>;

/** What the functions below need of the registry. */
export type Commands = Pick<CommandRegistry, "get" | "list">;

/** A command registry holding the built-in commands. */
export function builtinCommandRegistry(): CommandRegistry {
  const registry = new Registry<CommandDef>();
  for (const c of builtinCommands) registry.register(c);
  return registry;
}

export type ParsedLine =
  | { kind: "empty" }
  | { kind: "ok"; command: CommandDef; arg: string | undefined }
  | { kind: "error"; message: string };

export function parseLine(commands: Commands, line: string): ParsedLine {
  const [name, ...rest] = line.trim().split(/\s+/).filter(Boolean);
  if (!name) return { kind: "empty" };
  const command = commands.get(name);
  if (!command) return { kind: "error", message: `Not a command: ${name}` };
  const arg = rest.length ? rest.join(" ") : undefined;
  if (!command.arg) {
    return arg === undefined ? { kind: "ok", command, arg } : { kind: "error", message: `${name} takes no argument` };
  }
  if (arg === undefined) {
    if (command.optionalArg) return { kind: "ok", command, arg };
    const what = command.arg === "host" ? "a Host name" : command.arg === "number" ? "a number" : "an argument";
    return { kind: "error", message: `${name} needs ${what}` };
  }
  if (command.arg === "number" && !/^[1-9]\d*$/.test(arg)) {
    return { kind: "error", message: `${name} needs a number` };
  }
  return { kind: "ok", command, arg };
}

/** Runs a command line; a bad one is said, not thrown. Returns the command that ran. */
export function runLine(commands: Commands, ctx: CommandContext, line: string): CommandDef | undefined {
  const parsed = parseLine(commands, line);
  if (parsed.kind === "error") ctx.say(parsed.message);
  if (parsed.kind !== "ok") return undefined;
  parsed.command.run(ctx, parsed.arg);
  return parsed.command;
}

/** Area and label of a command line (for the Key bindings panel). */
export function describeLine(commands: Commands, line: string): { area: string; label: string } {
  const parsed = parseLine(commands, line);
  if (parsed.kind !== "ok") return { area: "Other", label: `${line} (not a command)` };
  return { area: parsed.command.area, label: parsed.command.label(parsed.arg) };
}

/** Everyday commands first, then seldom ones, then list and tree motions. */
const rankOf = (c: CommandDef) => (c.motion ? 2 : c.seldom ? 1 : 0);

/** Complete lines for what's typed so far: command names, then what the command offers (its
 * `complete` hook), Host names for a Host argument, or the open Sessions' numbers. */
export function complete(
  commands: Commands,
  input: string,
  hostNames: readonly string[],
  more: Omit<CompletionContext, "hostNames"> = { foldIds: [], sessions: [] },
): string[] {
  const space = input.indexOf(" ");
  if (space < 0) {
    // List and tree motions last: they're there to be run, but they're meant for keys.
    return commands
      .list()
      .filter((c) => c.id.startsWith(input))
      .sort((a, b) => rankOf(a) - rankOf(b) || a.id.localeCompare(b.id))
      .map((c) => (c.arg && !c.optionalArg ? `${c.id} ` : c.id));
  }
  const command = commands.get(input.slice(0, space));
  if (!command) return [];
  const word = input.slice(space + 1).trimStart();
  const args = command.complete
    ? command.complete(word, hostNames, { hostNames, ...more })
    : command.arg === "host"
      ? matching([...hostNames].sort(), word)
      : command.arg === "number"
        ? more.sessions.map((_, i) => String(i + 1)).filter((n) => n.startsWith(word))
        : [];
  return args.map((a) => `${command.id} ${a}`);
}
