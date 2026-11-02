// `:help [TOPIC]` and the `help` finder (ticket 37), registered through the registries as a Plugin
// would (ADR 0006). HelpView is the help panel's state outside React (like ThemeChoice): which
// page and entry it shows, and the way back. App hands it the live HelpContext each render.
import { matching, type CommandDef } from "../commands/table";
import type { FinderItem, FinderSourceDef } from "../finder/sources";
import type { Registries } from "../registries";
import { BUILTIN } from "../registry";
import { optionRows, optionTag } from "../config/reference";
import { plain } from "./doc";
import { grepTexts } from "./grep";
import { lineTopic } from "./lookup";
import { findTopic, headingTag, pageBody, pageTexts, topics, type HelpContext, type Topic } from "./pages";

/** Where the help panel is: a page, and the entry or heading on it. */
export interface HelpPlace {
  page: string;
  anchor?: string;
  /** Text to search the page for on arriving (`:help config#the-sandbox /require`, and what
   * `:helpgrep` opens), its first match from the anchor on. */
  search?: string;
}

export interface HelpSnapshot {
  /** Null while help is closed. */
  at: HelpPlace | null;
  canBack: boolean;
  canForward: boolean;
  /** Counts opens, so opening the same topic again scrolls to it again. */
  seq: number;
  /** How it got to `at` (`:tutor` waits for a Ctrl+O back, ticket 55). */
  moved?: "open" | "back" | "forward";
}

const place = (t: Topic | HelpPlace, search?: string): HelpPlace => ({
  page: t.page,
  ...(t.anchor ? { anchor: t.anchor } : {}),
  ...(search ? { search } : {}),
});

export class HelpView {
  private snap: HelpSnapshot = { at: null, canBack: false, canForward: false, seq: 0 };
  private back: HelpPlace[] = [];
  private forward: HelpPlace[] = [];
  private readonly listeners = new Set<() => void>();
  private ctx: (() => HelpContext) | null = null;

  /** What topics are resolved against: App sets it every render. */
  setContext(ctx: () => HelpContext) {
    this.ctx = ctx;
  }

  context(): HelpContext | null {
    return this.ctx?.() ?? null;
  }

  snapshot = (): HelpSnapshot => this.snap;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Shows `to`, searching it for `search`; the place it leaves is where Ctrl+O goes back to. */
  open(to: Topic | HelpPlace, search?: string) {
    if (this.snap.at) this.back.push(this.snap.at);
    this.forward = [];
    this.set(place(to, search), "open");
  }

  /** Opens the topic `query` names; false when there's none. `TOPIC /TEXT` also searches the
   * page for TEXT, from the topic on. */
  openTopic(query: string): boolean {
    const ctx = this.context();
    const m = /^(.*?)\s+\/(.+)$/.exec(query.trim());
    const topic = ctx ? findTopic(ctx, m ? (m[1] as string) : query) : undefined;
    if (!topic) return false;
    this.open(topic, m?.[2]?.trim());
    return true;
  }

  goBack() {
    const to = this.back.pop();
    if (!to || !this.snap.at) return;
    this.forward.push(this.snap.at);
    this.set(to, "back");
  }

  goForward() {
    const to = this.forward.pop();
    if (!to || !this.snap.at) return;
    this.back.push(this.snap.at);
    this.set(to, "forward");
  }

  close() {
    if (!this.snap.at) return;
    this.back = [];
    this.forward = [];
    this.snap = { at: null, canBack: false, canForward: false, seq: this.snap.seq };
    this.changed();
  }

  private set(at: HelpPlace, moved: "open" | "back" | "forward") {
    this.snap = { at, canBack: this.back.length > 0, canForward: this.forward.length > 0, seq: this.snap.seq + 1, moved };
    this.changed();
  }

  private changed() {
    for (const l of this.listeners) l();
  }
}

export function helpCommand(view: HelpView): CommandDef {
  return {
    id: "help",
    source: BUILTIN,
    area: "App",
    arg: "text",
    optionalArg: true,
    label: (topic) => (topic ? `Help on ${topic}` : "Help: find a topic"),
    run: (ctx, topic) => {
      if (topic === undefined) return ctx.openFinder("help");
      if (!view.openTopic(topic)) ctx.say(`No help for ${topic}. :help alone lists the topics.`);
    },
    complete: (arg) => {
      const ctx = view.context();
      return ctx ? matching(topics(ctx).map((t) => t.tag), arg) : [];
    },
  };
}

/** The topic finder (`␣ ?`): every topic, fuzzy-matched; Enter runs `help TAG`. */
export function helpFinder(view: HelpView): FinderSourceDef {
  return {
    id: "help",
    source: BUILTIN,
    title: "Find a help topic",
    prompt: "Help",
    items: (): FinderItem[] => {
      const ctx = view.context();
      if (!ctx) return [];
      return topics(ctx).map((t) => ({
        id: t.tag,
        label: t.label,
        ...(t.label !== t.tag ? { detail: t.tag } : {}),
        ...(t.path ? { path: t.path } : {}),
        command: `help ${t.tag}`,
      }));
    },
  };
}

/** `:lookup` (␣ F1, ticket 52): help on what's selected, Neovim's `K`. A Host's row opens
 * `:connect`, any other row the command it runs; with no row under the cursor, the topic finder. */
export function lookupCommand(view: HelpView): CommandDef {
  return {
    id: "lookup",
    source: BUILTIN,
    area: "App",
    label: () => "Help on what's selected",
    run: (ctx) => {
      const row = ctx.cursorRow();
      const hctx = view.context();
      const topic = row && hctx ? (row.host ? ":connect" : lineTopic(hctx.commands, row.command)) : null;
      if (!topic || !view.openTopic(topic)) ctx.openFinder("help");
    },
  };
}

/** `:helpgrep [TEXT]`: searches the text of every page (Neovim's `:helpgrep`), in a finder. */
export function helpgrepCommand(): CommandDef {
  return {
    id: "helpgrep",
    source: BUILTIN,
    area: "App",
    arg: "text",
    optionalArg: true,
    label: (text) => (text ? `Search every help page for ${text}` : "Search every help page"),
    run: (ctx, text) => ctx.openFinder("helpgrep", text),
  };
}

/** The `helpgrep` finder: every paragraph, list item, table row and entry of every page that
 * has all the words typed, as typed (not fuzzy: this is text). Enter opens the page there and
 * searches it for the first word, so n and N go on from there. */
export function helpgrepFinder(view: HelpView): FinderSourceDef {
  const search = (query: string): FinderItem[] => {
    const ctx = view.context();
    if (!ctx) return [];
    const first = query.trim().split(/\s+/)[0];
    // The index and `all` only repeat other pages' titles and summaries.
    const texts = pageTexts(ctx).filter((hit) => hit.page !== "index" && hit.page !== "all");
    return grepTexts(texts, query).map(({ hit, label }, k) => ({ id: `${k}`, label, path: hit.where, command: `help ${hit.tag} /${first}` }));
  };
  return {
    id: "helpgrep",
    source: BUILTIN,
    title: "Search every help page",
    prompt: "Help text",
    prose: true,
    empty: "Type words to search every help page.",
    items: () => [],
    search: (_ctx, query) => search(query),
  };
}

/** The `outline` finder (`g O` in help): the open page's headings and entries, in page order. */
export function outlineFinder(view: HelpView): FinderSourceDef {
  return {
    id: "outline",
    source: BUILTIN,
    title: "This help page's outline",
    prompt: "Outline",
    prose: true,
    items: (): FinderItem[] => {
      const ctx = view.context();
      const at = view.snapshot().at;
      if (!ctx || !at) return [];
      const items: FinderItem[] = [];
      // What a heading or entry sits under, as the finder's faint path.
      let section = "";
      let under = "";
      for (const b of pageBody(ctx, at.page)) {
        if (b.t === "h") {
          const tag = b.level === 1 ? at.page : headingTag(at.page, b.anchor);
          if (b.level <= 2) section = b.level === 2 ? plain(b.text) : "";
          items.push({ id: tag, label: plain(b.text), ...(b.level > 2 && section ? { path: section } : {}), command: `help ${tag}` });
          under = b.level === 1 ? "" : plain(b.text);
        } else if (b.t === "defs") {
          for (const d of b.items) {
            if (d.anchor) items.push({ id: d.anchor, label: plain(d.term), ...(under ? { path: under } : {}), command: `help ${d.anchor}` });
          }
        }
      }
      return items;
    },
  };
}

/** `:options [TEXT]`: the `options` finder, Neovim's `:options` window as a finder. */
export function optionsCommand(): CommandDef {
  return {
    id: "options",
    source: BUILTIN,
    area: "App",
    arg: "text",
    optionalArg: true,
    label: (text) => (text ? `Find the option ${text}` : "Find an option: its value now, its default and where it was set"),
    doc: "Every init.lua option, with the value it has now and where that was set: a file and line of the Config, `default`, or the State. Read-only: Enter opens the option's entry in [`:help options`](options); [`:config`](:config) opens init.lua to change it.",
    run: (ctx, text) => ctx.openFinder("options", text),
  };
}

/** The `options` finder: each option that holds a value, its value now on the left after the
 * name, where it was set on the right, and its default and type in the footer. Enter opens its help. */
export function optionsFinder(view: HelpView): FinderSourceDef {
  const rows = () => {
    const ctx = view.context();
    return ctx ? optionRows(ctx.config, ctx.state) : [];
  };
  return {
    id: "options",
    source: BUILTIN,
    title: "Find an option",
    prompt: "Options",
    items: (): FinderItem[] =>
      rows().map((r) => ({ id: r.name, label: r.name, path: r.value, detail: r.where, command: `help ${optionTag(r.name)}` })),
    note: (item) => {
      const r = item && rows().find((x) => x.name === item.id);
      return r ? `Default ${r.default} · ${r.entry.ty}` : undefined;
    },
    help: (item) => optionTag(item.id),
  };
}

/** Registers `:help`, `:helpgrep` and their finders; returns what removes them. */
export function registerHelp(registries: Registries, view: HelpView): () => void {
  const disposers = [
    registries.commands.register(helpCommand(view)),
    registries.commands.register(helpgrepCommand()),
    registries.commands.register(lookupCommand(view)),
    registries.finders.register(helpFinder(view)),
    registries.finders.register(helpgrepFinder(view)),
    registries.finders.register(outlineFinder(view)),
    registries.commands.register(optionsCommand()),
    registries.finders.register(optionsFinder(view)),
  ];
  return () => disposers.forEach((d) => d());
}
