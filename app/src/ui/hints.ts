// The keycap hints (iteration 3 feedback): on by default, off with `ui.hints = false` in init.lua or
// `:hints off`, whose choice the State keeps unless init.lua sets it, which wins.
// Hidden hints are only out of sight: the bindings work as before, and the keys stay in what
// assistive tech reads (styles.css hides `.keys` and `.key-hint` under `data-hints="off"`).
//
// The command registers through the registries, as a Plugin would (ADR 0006).
import { createContext } from "react";
import type { CommandDef } from "../commands/table";
import type { Registries } from "../registries";
import { BUILTIN } from "../registry";
import { quiet, type Message } from "./messages";

/** The State key holding `:hints`'s choice. */
export const HINTS_KEY = "hints";

const WORDS = ["on", "off", "toggle"] as const;

/** Whether keycap hints are shown, for what CSS can't hide (a tooltip naming a key). */
export const HintsShown = createContext(true);

export class HintsChoice {
  private configValue: boolean | null = null;
  private readonly state: { get(key: string): unknown; set(key: string, value: unknown): void };

  constructor(state: { get(key: string): unknown; set(key: string, value: unknown): void }) {
    this.state = state;
  }

  /** init.lua's `ui.hints`, or null when it doesn't set it. */
  setConfig(value: boolean | null) {
    this.configValue = value;
  }

  /** The State's choice, if it holds one. */
  stored(): boolean | null {
    const v = this.state.get(HINTS_KEY);
    return typeof v === "boolean" ? v : null;
  }

  /** init.lua's value, else the State's, else shown. */
  shown(): boolean {
    return this.configValue ?? this.stored() ?? true;
  }

  /** `on`, `off` or `toggle` (also no word); returns what to tell the user: the new state is quiet
   * (ticket 111), a refusal isn't. */
  set(word: string | undefined): Message {
    const w = word ?? "toggle";
    if (!(WORDS as readonly string[]).includes(w)) return "hints takes on, off or toggle";
    if (this.configValue !== null) {
      return `Key hints are set in init.lua (ui.hints = ${String(this.configValue)}). Change them there.`;
    }
    const next = w === "toggle" ? !this.shown() : w === "on";
    this.state.set(HINTS_KEY, next);
    return quiet(next ? "Key hints shown" : "Key hints hidden");
  }
}

export function hintsCommand(choice: HintsChoice): CommandDef {
  return {
    id: "hints",
    source: BUILTIN,
    area: "View",
    arg: "text",
    optionalArg: true,
    seldom: true,
    label: (w) => (w === "on" ? "Show the key hints" : w === "off" ? "Hide the key hints" : "Show or hide the key hints"),
    run: (ctx, w) => ctx.say(choice.set(w)),
    complete: (arg) => WORDS.filter((w) => w.startsWith(arg)),
  };
}

/** Registers the `hints` command; returns what removes it. */
export function registerHints(registries: Registries, choice: HintsChoice): () => void {
  return registries.commands.register(hintsCommand(choice));
}
