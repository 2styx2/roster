// The one command table (ticket 07, decision Q36): every app action is a command here, its id
// being its `:` command-line name. It's a Registry (ADR 0006): built-ins register as "builtin",
// and the Config and Plugins can add or shadow commands the same way. Keys (the keymap maps a key to a command line such as
// "session 1"), the command line and buttons (the Sidebar, the tab strip) all run commands
// through runLine, so a view mode only changes how commands are presented, never which exist.
// A command acts through CommandContext, which App provides: one part per feature.

import { configCommand, type ConfigContext } from "../config/command";
import { checkCommand, type CheckContext } from "../errors/command";
import { changesCommands, editCommand, groupCommand, hostCommand, reviewCommand, unreviewCommand, type InventoryContext } from "../inventory/commands";
import { inventoryCommand } from "../inventory/switch";
import { matching } from "../ui/completion";
import { BUILTIN, Registry, type Entry } from "../registry";
import { sessionCommands as s, type SessionContext } from "../session/commands";
import { sidebarCommands, type SidebarContext } from "../sidebar/commands";
import type { Message } from "../ui/messages";
import { viewCommands, type ViewContext } from "../view/commands";

/** What any command can ask of the app, whatever its feature. */
export interface AppContext {
  openPicker(): void;
  /** The command line, with `initial` typed in already (a prompt for the rest). */
  openCommandLine(initial?: string): void;
  /** Opens the Finder over a finder source (`sessions`, `hosts`, `tree`…), with `query` typed in
   * already when there's one (`:helpgrep TEXT`). */
  openFinder(source: string, query?: string): void;
  toggleStatusBar(): void;
  toggleKeys(): void;
  lock(): void;
  /** `:vault signout` (ticket 42): asks first, naming the account, then signs the vault CLI out
   * and shows the lock screen's full sign-in form; says why for a provider with no account. */
  vault(action: VaultAction): void;
  /** Back to Terminal mode, closing the topmost side panel (Key bindings, :check) if one is open. */
  toTerminal(): void;
  /** Closes the topmost side panel, if one is open. */
  closePanel(): void;
  /** The Host the user means: the one under the Sidebar's cursor, else the Session on screen's. */
  selectedHost(): string | null;
  /** Every Host's name, in roster.yml order (empty until the Inventory is loaded). */
  hostNames(): readonly string[];
  /** A one-line message for the user: an error, a warning or an answer, or a quiet one (ui/messages.ts). */
  say(message: Message): void;
  /** Says the Backend, the Box and the Inventory's path, whole (the status bar cuts them). */
  showInfo(): void;
  /** Host details (ticket 18): shows the Host's panel; null shows or hides it for the selected
   * Host. */
  details(host: string | null): void;
}

/** What commands can ask of the app: each feature's part, which its own commands take (a
 * feature's module declares it beside them), and App provides. */
export type CommandContext = AppContext & SessionContext & InventoryContext & CheckContext & SidebarContext & ViewContext & ConfigContext;

/** What `:vault` does: `:vault signout`. */
const VAULT_ACTIONS = ["signout"] as const;
export type VaultAction = (typeof VAULT_ACTIONS)[number];

/** A command; `C` is the part of the app it acts through (a feature's commands take their own). */
export interface CommandDef<C = CommandContext> extends Entry {
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
  run(ctx: C, arg: string | undefined): void;
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
  /** The named Inventories, as serve last listed them (`:inventory`, ticket 115). */
  inventoryNames?: readonly string[];
}

const builtinCommands: readonly CommandDef[] = [
  { id: "find", source: BUILTIN, area: "Hosts", label: () => "Find a Host", run: (ctx) => ctx.openPicker() },
  s.connect,
  s.open,
  s.here,
  s.quick,
  s.save,
  s.fill,
  s.integrate,
  s.reconnect,
  checkCommand,
  editCommand,
  hostCommand,
  groupCommand,
  inventoryCommand,
  reviewCommand,
  unreviewCommand,
  ...changesCommands,
  s.next,
  s.prev,
  s.session,
  s.close,
  ...sidebarCommands,
  ...viewCommands,
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
  configCommand,
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
