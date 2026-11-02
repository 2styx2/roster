// The message line, as Neovim's (ticket 111, decision Q115): quiet by default. Errors, warnings,
// the answer to something you asked (`:info`, `:config path`) and results that need attention
// (a Publish, "Wrote Windows Terminal's profile…") are plain strings and always show. A routine
// action's confirmation ("Saved esx-02 as a Pending change…") and a toggle's tip ("Sidebar
// hidden, and kept that way. modes.standard.sidebar = false in init.lua makes it the default")
// are `quiet`: they show only with `ui.messages = "all"` in init.lua, or `:messages all`, whose
// choice the State keeps unless init.lua sets it (which wins), as `:hints` does for the keycap
// hints.
//
// Quiet, the message line shows nothing, but a quiet message's short form ("Sidebar hidden")
// still goes to the line as visually hidden text, so a screen reader hears what changed (WCAG
// 4.1.3). Every message, quiet or not, goes into a short history that `:messages` alone lists,
// as Neovim's `:messages` does.
//
// The command and the view register through the registries, as a Plugin would (ADR 0006).
import type { CommandDef } from "../commands/table";
import type { Registries } from "../registries";
import { BUILTIN } from "../registry";
import type { ViewDef } from "../view/views";

/** The State key holding `:messages`'s choice. */
export const MESSAGES_KEY = "messages";
/** The view `:messages` alone opens. */
export const MESSAGES_VIEW = "messages";

export type MessagesLevel = "quiet" | "all";

const LEVELS: readonly MessagesLevel[] = ["quiet", "all"];
const WORDS = ["all", "quiet", "toggle", "clear"] as const;
/** How many `:messages` keeps (Neovim keeps 200 by default too). */
const KEPT = 200;

/** A routine action's confirmation, or a toggle's tip: shown only with every message on. */
export interface Quiet {
  kind: "quiet";
  /** What changed, alone ("Sidebar hidden"): what a screen reader hears while quiet. */
  said: string;
  /** The whole line shown with every message on: what changed, and what it teaches. */
  text: string;
}

/** What goes on the message line: an error, a warning or an answer (always shown), or a quiet one. */
export type Message = string | Quiet;

export function quiet(said: string, text: string = said): Quiet {
  return { kind: "quiet", said, text };
}

/** A message's whole text, as the line shows it with every message on. */
export function textOf(message: Message): string {
  return typeof message === "string" ? message : message.text;
}

/** What the message line shows. */
export function shownText(message: Message, all: boolean): string {
  if (typeof message === "string") return message;
  return all ? message.text : "";
}

/** What the message line holds as visually hidden text: a quiet message's short form while quiet
 * (with every message on, the line says it all). */
export function spokenText(message: Message, all: boolean): string {
  return typeof message === "string" || all ? "" : message.said;
}

export class MessagesChoice {
  private configValue: MessagesLevel | null = null;
  private readonly state: { get(key: string): unknown; set(key: string, value: unknown): void };

  constructor(state: { get(key: string): unknown; set(key: string, value: unknown): void }) {
    this.state = state;
  }

  /** init.lua's `ui.messages`, or null when it doesn't set it. */
  setConfig(value: MessagesLevel | null) {
    this.configValue = value;
  }

  /** The State's choice, if it holds one. */
  stored(): MessagesLevel | null {
    const v = this.state.get(MESSAGES_KEY);
    return (LEVELS as readonly unknown[]).includes(v) ? (v as MessagesLevel) : null;
  }

  /** init.lua's value, else the State's, else quiet. */
  level(): MessagesLevel {
    return this.configValue ?? this.stored() ?? "quiet";
  }

  /** Whether every message shows, quiet ones too. */
  all(): boolean {
    return this.level() === "all";
  }

  /** `all`, `quiet` or `toggle`; returns what to tell the user. Plain text, not quiet:
   * `:messages quiet` must still say it did. */
  set(word: "all" | "quiet" | "toggle"): string {
    if (this.configValue !== null) {
      return `Messages are set in init.lua (ui.messages = "${this.configValue}"). Change it there.`;
    }
    const next: MessagesLevel = word === "toggle" ? (this.all() ? "quiet" : "all") : word;
    this.state.set(MESSAGES_KEY, next);
    return next === "all" ? "Messages: all" : "Messages: quiet (errors, warnings and answers only; :messages lists the rest)";
  }
}

export interface LoggedMessage {
  at: Date;
  text: string;
  quiet: boolean;
}

/** The recent messages, quiet ones too, oldest first. */
export class MessageLog {
  private snap: readonly LoggedMessage[] = [];
  private readonly listeners = new Set<() => void>();

  snapshot = (): readonly LoggedMessage[] => this.snap;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  push(message: Message, at: Date = new Date()) {
    const text = textOf(message);
    if (!text) return;
    this.set([...this.snap, { at, text, quiet: typeof message !== "string" }].slice(-KEPT));
  }

  clear() {
    this.set([]);
  }

  private set(next: readonly LoggedMessage[]) {
    this.snap = next;
    for (const l of this.listeners) l();
  }
}

const two = (n: number) => String(n).padStart(2, "0");
const clock = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;

/** The `messages` view: the recent messages as a table, quiet ones muted. */
export function logView(entries: readonly LoggedMessage[]): ViewDef {
  return {
    id: MESSAGES_VIEW,
    source: BUILTIN,
    title: "Messages",
    place: "panel",
    content: {
      facts: [],
      table: {
        columns: [
          { id: "at", label: "Time", kind: "data", width: 8 },
          { id: "text", label: "Message", kind: "text" },
        ],
        rows: entries.map((m, i) => ({ id: String(i), cells: { at: clock(m.at), text: m.text }, ...(m.quiet ? { tone: "muted" as const } : {}) })),
        sort: null,
        empty: "No messages yet.",
        actions: [],
      },
    },
  };
}

export function messagesCommand(choice: MessagesChoice, log: MessageLog, open: () => void): CommandDef {
  return {
    id: "messages",
    source: BUILTIN,
    area: "View",
    arg: "text",
    optionalArg: true,
    seldom: true,
    label: (w) =>
      w === "all"
        ? "Show every message, routine ones too"
        : w === "quiet"
          ? "Show only errors, warnings and answers"
          : w === "toggle"
            ? "Switch between every message and quiet"
            : w === "clear"
              ? "Forget the recent messages"
              : "List the recent messages",
    run: (ctx, arg) => {
      const w = (arg ?? "").trim();
      if (w === "") return open();
      if (w === "clear") return log.clear();
      if (w === "all" || w === "quiet" || w === "toggle") return ctx.say(choice.set(w));
      ctx.say("messages takes all, quiet, toggle or clear (alone, it lists the recent ones)");
    },
    complete: (arg) => WORDS.filter((w) => w.startsWith(arg)),
  };
}

/** Registers the `messages` command; returns what removes it. */
export function registerMessages(registries: Registries, choice: MessagesChoice, log: MessageLog, open: () => void): () => void {
  return registries.commands.register(messagesCommand(choice, log, open));
}
