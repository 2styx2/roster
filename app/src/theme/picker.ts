// The Theme picker (ticket 30, decisions Q51 and Q69): `:theme` opens the `themes` finder over
// every registered Theme (bundled, init.lua's, a Plugin's) and previews the one under the cursor
// live; Enter runs `theme ID`, which applies it and keeps it in the State; Esc reverts. `:theme ID`
// chooses straight away. Like Neovim's `:colorscheme`, a choice always applies. If init.lua names
// a Theme too (`theme = "nord"`), the State remembers that value with the choice, and the choice
// stays until init.lua's value changes; then init.lua wins again (Q69). `theme = "auto"` (the
// default) leaves it to the State.
//
// It registers its finder source and command through the registries, as a Plugin would (ADR 0006).
import type { CommandDef } from "../commands/table";
import type { ConfigLocation } from "../config/types";
import type { FinderItem, FinderSourceDef } from "../finder/sources";
import type { Registries } from "../registries";
import { BUILTIN } from "../registry";
import type { AppearanceOptions, ThemeRegistry } from "./theme";

/** The State key holding the chosen Theme's id. */
export const THEME_KEY = "theme";
/** The State key holding init.lua's `theme` when the choice was made (null: it didn't set one). */
export const THEME_OVER_KEY = "themeOver";

export interface Chosen {
  /** The Theme init.lua names, or null for `theme = "auto"` (or no init.lua). */
  configTheme: string | null;
  /** The State's choice, if it's a registered Theme. */
  stored: string | null;
  /** init.lua's `theme` when that choice was made (null or absent: none). */
  storedOver?: string | null;
  /** The Theme the picker is previewing. */
  preview: string | null;
}

/** Whether the State's choice is the one in effect (decision Q69): always when init.lua leaves
 * the Theme to it, else only while init.lua still names the Theme the choice was made over. */
export function stateChoiceWins(c: Omit<Chosen, "preview">): boolean {
  if (!c.stored) return false;
  return c.configTheme === null || c.configTheme === (c.storedOver ?? null);
}

/** The appearance with the picker's choice applied: a preview, else the State's choice when it
 * wins, else init.lua's Theme, else the Config's (`auto` follows the OS). */
export function chosenAppearance(base: AppearanceOptions, c: Chosen): AppearanceOptions {
  const id = c.preview ?? (stateChoiceWins(c) ? c.stored : c.configTheme);
  return id && id !== base.theme ? { ...base, theme: id } : base;
}

const where = (at: ConfigLocation | null) => (at ? `${at.file}:${at.line}` : "init.lua");

/** The picker's state outside React: the preview, plus what App tells it (init.lua's Theme and
 * the Theme on screen). The choice itself lives in the State. */
export class ThemeChoice {
  private previewId: string | null = null;
  private configId: string | null = null;
  private configAt: ConfigLocation | null = null;
  /** The init.lua value the pin note was last said for: it's said once. */
  private toldFor: string | null = null;
  private activeId = "";
  private readonly listeners = new Set<() => void>();
  private readonly state: { get(key: string): unknown; set(key: string, value: unknown): void };
  readonly themes: Pick<ThemeRegistry, "get" | "list">;

  constructor(
    state: { get(key: string): unknown; set(key: string, value: unknown): void },
    themes: Pick<ThemeRegistry, "get" | "list">,
  ) {
    this.state = state;
    this.themes = themes;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  previewing = (): string | null => this.previewId;

  preview(id: string | null) {
    if (id === this.previewId) return;
    this.previewId = id;
    for (const l of this.listeners) l();
  }

  /** The State's choice, if that Theme is registered. */
  stored(): string | null {
    const id = this.state.get(THEME_KEY);
    return typeof id === "string" && this.themes.get(id) ? id : null;
  }

  /** init.lua's `theme` when the State's choice was made (null: none). */
  storedOver(): string | null {
    const id = this.state.get(THEME_OVER_KEY);
    return typeof id === "string" ? id : null;
  }

  /** The State's choice when it's the one in effect, else null (init.lua's wins, or none). */
  inEffect(): string | null {
    const c = { configTheme: this.configId, stored: this.stored(), storedOver: this.storedOver() };
    return stateChoiceWins(c) ? c.stored : null;
  }

  /** init.lua's Theme, or null when it says `auto`. */
  configTheme = (): string | null => this.configId;
  /** init.lua's Theme and the line that sets it (`Config.lines.theme`). */
  setConfigTheme(id: string | null, at: ConfigLocation | null = null) {
    this.configId = id;
    this.configAt = at;
  }

  /** The Theme on screen (where the finder starts). */
  active = (): string => this.activeId;
  setActive(id: string) {
    this.activeId = id;
  }

  /** Applies `id` and keeps it in the State; returns what to tell the user ("" when nothing). */
  choose(id: string): string {
    if (!this.themes.get(id)) {
      return `No Theme named ${id} (${this.themes.list().map((t) => t.id).join(", ")})`;
    }
    return this.keep(id);
  }

  /** Keeps `id` in the State over init.lua's Theme as it is now, registered or not (an import's
   * Theme is registered once init.lua is sourced). Returns the pin note, said once per value. */
  keep(id: string): string {
    this.state.set(THEME_KEY, id);
    this.state.set(THEME_OVER_KEY, this.configId);
    const pin = this.configId;
    if (!pin || pin === id || this.toldFor === pin) return "";
    this.toldFor = pin;
    const label = this.themes.get(id)?.label ?? id;
    return `Theme ${label}. ${where(this.configAt)} also sets theme = "${pin}": this choice stays until that line changes. Delete the line to unpin it.`;
  }

  /** The finder's note while init.lua sets `theme`, else null. */
  pinNote(): string | null {
    const pin = this.configId;
    return pin ? `${where(this.configAt)} sets "${pin}"; Enter overrides it until that line changes` : null;
  }
}

export function themesFinder(choice: ThemeChoice): FinderSourceDef {
  return {
    id: "themes",
    source: BUILTIN,
    title: "Choose a Theme",
    prompt: "Themes",
    items: () =>
      choice.themes.list().map((t) => ({
        id: `theme:${t.id}`,
        label: t.label,
        // The Theme in use says so, and the finder opens on it: Esc after a preview goes back to it.
        detail: [t.appearance, ...(t.source === BUILTIN ? [] : [t.source]), ...(t.id === choice.active() ? ["current"] : [])].join(" · "),
        command: `theme ${t.id}`,
      })),
    initial: (items) => Math.max(0, items.findIndex((i) => i.command === `theme ${choice.active()}`)),
    move: (item: FinderItem | undefined) => {
      if (item) choice.preview(item.command.slice("theme ".length));
    },
    close: () => choice.preview(null),
    help: (item) => `themes#${item.command.slice("theme ".length)}`,
    note: (item) => {
      const pinned = choice.pinNote();
      if (pinned) return pinned;
      // Where it's set for good (ticket 32): Enter keeps it on this Box only.
      return item ? `In init.lua: theme = "${item.command.slice("theme ".length)}"` : undefined;
    },
  };
}

export function themeCommand(choice: ThemeChoice): CommandDef {
  return {
    id: "theme",
    source: BUILTIN,
    area: "View",
    arg: "text",
    optionalArg: true,
    label: (id) => (id ? `Theme ${choice.themes.get(id)?.label ?? id}` : "Choose a Theme"),
    run: (ctx, id) => {
      if (!id) return ctx.openFinder("themes");
      const message = choice.choose(id);
      if (message) ctx.say(message);
    },
    complete: (arg) =>
      choice.themes
        .list()
        .map((t) => t.id)
        .filter((id) => id.startsWith(arg)),
  };
}

/** Registers the `themes` finder and the `theme` command; returns what removes them. */
export function registerThemePicker(registries: Registries, choice: ThemeChoice): () => void {
  const disposers = [registries.finders.register(themesFinder(choice)), registries.commands.register(themeCommand(choice))];
  return () => disposers.forEach((d) => d());
}
