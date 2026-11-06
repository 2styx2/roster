// `:tutor` (ticket 55, decision Q76): Neovim's `:Tutor`, in roster's own look. A tutorial is a
// help page of lessons, each with steps to try; a step ticks itself when the app sees it done (an
// app event: a command that ran, a Session that opened, a help page you went to), not when text
// is typed. Tutorials are a Registry (ADR 0006), so a Plugin ships its own (`roster.tutor.set`).
// Progress is kept in the State (`tutor`), so `:tutor` resumes at the first lesson not finished.
import { code, h, keys, link, p, text, type Block, type Inline } from "../help/doc";
import type { HelpContext, HelpPage } from "../help/pages";
import { keysFor } from "../keymap";
import { BUILTIN, Registry, type Entry } from "../registry";

/** What the app tells a running tutorial: an event's name and its fields. */
export interface TutorEvent {
  name: string;
  data: Readonly<Record<string, string | number | null | undefined>>;
}

/** The events a step can wait for (docs/plugins.md lists them for Plugins' tutorials). */
export const TUTOR_EVENTS = [
  "command",
  "session_open",
  "session_exit",
  "host_selected",
  "help_open",
  "help_back",
  "help_forward",
  "help_search",
] as const;

/** A step is done when an event has this name and every other field matches: equal, ignoring
 * case; `"*"` means the field is there and not empty, `""` that it's missing or empty. */
export interface StepMatch {
  event: string;
  [field: string]: string;
}

export interface TutorStep {
  /** Unique in its tutorial: what the State keeps once it's done. */
  id: string;
  /** What to do. The context gives the keys bound now, so a rebound key is the one shown. */
  text(ctx: HelpContext): Inline[];
  /** Any of these ticks it. */
  on: readonly StepMatch[];
}

export interface TutorLesson {
  title: string;
  /** What the lesson teaches, before its steps. */
  about(ctx: HelpContext): Block[];
  steps: readonly TutorStep[];
  /** After the steps: a NOTE, as Neovim's tutor has. */
  note?(ctx: HelpContext): Block[];
}

export interface TutorialDef extends Entry {
  title: string;
  /** One line, for the index and the topic finder. */
  summary: string;
  intro(ctx: HelpContext): Block[];
  lessons: readonly TutorLesson[];
  /** The summary at the end: what was learned and where to go next. */
  outro(ctx: HelpContext): Block[];
}

export type TutorRegistry = Registry<TutorialDef>;

/** The tutorial `:tutor` alone starts. */
export const DEFAULT_TUTORIAL = "roster";

/** A tutorial's help page: `tutor` for roster's own, `tutor-NAME` for the others. */
export const tutorPage = (id: string): string => (id === DEFAULT_TUTORIAL ? "tutor" : `tutor-${id}`);

/** A lesson's topic: `tutor#lesson-2`. */
export const lessonAnchor = (id: string, n: number): string => `${tutorPage(id)}#lesson-${n}`;

export function stepMatches(match: StepMatch, event: TutorEvent): boolean {
  if (match.event !== event.name) return false;
  return Object.entries(match).every(([field, want]) => {
    if (field === "event") return true;
    const raw = event.data[field];
    const got = raw === null || raw === undefined ? "" : String(raw).trim();
    if (want === "*") return got !== "";
    return got.toLowerCase() === want.trim().toLowerCase();
  });
}

/** The ids of the steps `event` ticks that weren't done yet. */
export function stepsDoneBy(def: TutorialDef, done: ReadonlySet<string>, event: TutorEvent): string[] {
  return def.lessons.flatMap((l) => l.steps.filter((s) => !done.has(s.id) && s.on.some((m) => stepMatches(m, event))).map((s) => s.id));
}

/** Where `:tutor` resumes: the first lesson with a step not done, or the top once all are. */
export function resumeAt(def: TutorialDef, done: ReadonlySet<string>): string | undefined {
  const n = def.lessons.findIndex((l) => l.steps.some((s) => !done.has(s.id)));
  return n < 0 || n === 0 ? undefined : lessonAnchor(def.id, n + 1);
}

/** What the State keeps under `tutor`: per tutorial, the ids of the steps done. */
export const TUTOR_KEY = "tutor";

interface Store {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  subscribe(listener: () => void): () => void;
}

const EMPTY: ReadonlySet<string> = new Set();

/** The steps done, kept in the State (the real one: the demo Inventory's State is thrown away). */
export class TutorProgress {
  private readonly store: Store;
  private cacheFor: unknown = undefined;
  private cache = new Map<string, ReadonlySet<string>>();

  constructor(store: Store) {
    this.store = store;
  }

  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);

  /** Changes when any tutorial's progress does (for useSyncExternalStore). */
  snapshot = (): unknown => this.store.get(TUTOR_KEY);

  done(tutorial: string): ReadonlySet<string> {
    const raw = this.store.get(TUTOR_KEY);
    if (raw !== this.cacheFor) {
      this.cacheFor = raw;
      this.cache = new Map();
    }
    let set = this.cache.get(tutorial);
    if (!set) {
      const list = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>)[tutorial] : undefined;
      set = Array.isArray(list) ? new Set(list.filter((x): x is string => typeof x === "string")) : EMPTY;
      this.cache.set(tutorial, set);
    }
    return set;
  }

  /** Feeds `event` to `def`: returns the steps it ticked. */
  feed(def: TutorialDef, event: TutorEvent): string[] {
    const ticked = stepsDoneBy(def, this.done(def.id), event);
    if (ticked.length) this.write(def.id, [...this.done(def.id), ...ticked]);
    return ticked;
  }

  /** Starts `tutorial` over. */
  reset(tutorial: string) {
    this.write(tutorial, []);
  }

  private write(tutorial: string, steps: string[]) {
    const raw = this.store.get(TUTOR_KEY);
    const all = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    this.store.set(TUTOR_KEY, { ...all, [tutorial]: steps });
  }
}

// ---------- The page ----------

/** A tutorial as a help page: its intro, the lesson index (each lesson's steps done), the
 * lessons with their steps, then its summary. */
export function tutorHelpPage(def: TutorialDef): HelpPage {
  return {
    id: tutorPage(def.id),
    source: def.source,
    title: def.title,
    summary: def.summary,
    order: def.source === BUILTIN ? 5 : 1001,
    ...(def.source === BUILTIN ? { part: "Getting started" } : {}),
    body: (ctx) => tutorBody(def, ctx),
  };
}

function tutorBody(def: TutorialDef, ctx: HelpContext): Block[] {
  const done = ctx.tutor?.done(def.id) ?? EMPTY;
  const running = ctx.tutor?.running === def.id;
  const start = def.id === DEFAULT_TUTORIAL ? ":tutor" : `:tutor ${def.id}`;
  const count = (l: TutorLesson) => l.steps.filter((s) => done.has(s.id)).length;
  return [
    h(1, def.title, tutorPage(def.id)),
    running
      ? p(
          "You're on the ",
          { t: "strong", children: [text("demo Inventory")] },
          ": made-up Hosts whose Sessions are pretend shells on this Box. Nothing you do here reaches your network, your vault or your ",
          code("roster.yml"),
          ". Your own Sessions keep running behind it. ",
          code(":tutor quit"),
          " goes back to them; ",
          code(start),
          " comes back here, where you left off.",
        )
      : p(
          code(start),
          " starts it on a demo Inventory, so nothing you try reaches your network, and comes back where you left off. Your own Sessions keep running behind it.",
        ),
    ...def.intro(ctx),
    h(2, "Lessons", `${tutorPage(def.id)}#lessons`),
    {
      t: "list",
      ordered: false,
      items: def.lessons.map((l, i): Inline[] => {
        const n = count(l);
        return [
          link(lessonAnchor(def.id, i + 1), `Lesson ${i + 1}: ${l.title}`),
          text(n === l.steps.length ? " · done" : ` · ${n} of ${l.steps.length} done`),
        ];
      }),
    },
    ...def.lessons.flatMap((l, i): Block[] => [
      { t: "h", level: 2, text: [text(`Lesson ${i + 1}: ${l.title}`)], anchor: lessonAnchor(def.id, i + 1) },
      ...l.about(ctx),
      ...l.steps.map((s): Block => ({ t: "step", id: s.id, text: s.text(ctx), done: done.has(s.id) })),
      ...(l.note?.(ctx) ?? []),
    ]),
    h(2, "Summary", `${tutorPage(def.id)}#summary`),
    ...def.outro(ctx),
  ];
}

/** Keeps a help page for each tutorial, as tutorials come and go. Returns what stops it. */
export function syncTutorPages(tutorials: TutorRegistry, help: Registry<HelpPage>): () => void {
  const pages = new Map<TutorialDef, () => void>();
  const sync = () => {
    const now = new Set(tutorials.list());
    for (const [def, drop] of pages) {
      if (!now.has(def)) {
        drop();
        pages.delete(def);
      }
    }
    for (const def of now) if (!pages.has(def)) pages.set(def, help.register(tutorHelpPage(def)));
  };
  sync();
  const stop = tutorials.subscribe(sync);
  return () => {
    stop();
    for (const drop of pages.values()) drop();
    pages.clear();
  };
}

// ---------- roster's own tutorial ----------

/** The keys bound to `line` after the Leader now, or the command if none is. */
function keyOr(ctx: HelpContext, line: string): Inline[] {
  const bound = keysFor(ctx.keymap, line, { global: false });
  return bound.length ? [keys(bound[0] as string)] : [code(`:${line}`)];
}

const on = (event: string, fields: Record<string, string> = {}): StepMatch => ({ ...fields, event });

export const rosterTutorial: TutorialDef = {
  id: DEFAULT_TUTORIAL,
  source: BUILTIN,
  title: "roster tutor",
  summary: "Learn roster by doing it, on a demo Inventory: Hosts, Sessions, help, your Config",
  intro: (ctx) => [
    p(
      "This tutor teaches the few keys and commands you need every day by having you do them. Each lesson ends in steps; a step ticks itself when you do it, wherever you do it. Read a lesson, try its steps, then go on to the next.",
    ),
    p(
      keys("␣"),
      " is the Leader, ",
      code(ctx.options.leader),
      " now: press it, let go, then press the next key. The keys shown are the ones bound now, so if your ",
      code("init.lua"),
      " changes them, this page shows yours.",
    ),
  ],
  lessons: [
    {
      title: "Find a Host",
      about: (ctx) => [
        p(
          "The Picker finds a Host by any part of its name, address or group: a few letters are enough. ",
          ...keyOr(ctx, "find"),
          " opens it from anywhere, the terminal included; Enter opens a Session to the Host it picked, Esc closes it.",
        ),
      ],
      steps: [
        { id: "picker", text: (ctx) => [text("Open the Picker with "), ...keyOr(ctx, "find"), text(".")], on: [on("command", { id: "find" })] },
        {
          id: "session",
          text: () => [text("Type "), code("demo-01"), text(" and press Enter: a Session to it opens.")],
          on: [on("session_open", { host: "demo-01" })],
        },
      ],
    },
    {
      title: "More than one Session",
      about: (ctx) => [
        p(
          "Each Session is a tab, listed in the Sidebar's Sessions. ",
          ...keyOr(ctx, "next"),
          " and ",
          ...keyOr(ctx, "prev"),
          " go to the next and previous one, and ",
          ...keyOr(ctx, "session 1"),
          " to ",
          ...keyOr(ctx, "session 9"),
          " straight to one by number.",
        ),
      ],
      steps: [
        { id: "second", text: () => [text("Open a second Session, to "), code("demo-02"), text(".")], on: [on("session_open", { host: "demo-02" })] },
        {
          id: "switch",
          text: (ctx) => [text("Go back to "), code("demo-01"), text(" with "), ...keyOr(ctx, "prev"), text(" or "), ...keyOr(ctx, "session 1"), text(".")],
          on: [on("command", { id: "prev" }), on("command", { id: "next" }), on("command", { id: "session" })],
        },
      ],
      note: () => [p("NOTE: roster has no split panes: Sessions are tabs, one on screen at a time, and the keys above move between them.")],
    },
    {
      title: "Find your way in help",
      about: (ctx) => [
        p(
          "You're reading help now. ",
          code(":help TOPIC"),
          " opens a page or an entry on one, ",
          ...keyOr(ctx, "help"),
          " finds a topic, and links go to other topics. As in Neovim, ",
          keys("Ctrl+o"),
          " goes back and ",
          keys("Ctrl+i"),
          " forward; ",
          keys("/"),
          " searches the page and ",
          keys("Esc"),
          " closes help.",
        ),
      ],
      steps: [
        {
          id: "link",
          text: () => [text("Follow this link to the quick reference: "), link("quickref", [code("quickref")]), text(". Tab gets to it, Enter follows it.")],
          on: [on("help_open", { page: "quickref" })],
        },
        { id: "back", text: () => [text("Come back here with "), keys("Ctrl+o"), text(".")], on: [on("help_back")] },
        {
          id: "option",
          text: () => [
            text("Open "),
            code(":help options"),
            text(" and find "),
            code("terminal.size"),
            text(": search the page with "),
            keys("/"),
            text(", or go straight there with "),
            code(":help terminal.size"),
            text(". Then come back with "),
            keys("Ctrl+o"),
            text("."),
          ],
          on: [on("help_open", { anchor: "terminal.size" }), on("help_search", { page: "options", query: "terminal.size" })],
        },
      ],
    },
    {
      title: "Make it yours",
      about: () => [
        p(
          "roster is yours to shape, like Neovim: the Theme, the keys, the layout. ",
          code(":theme"),
          " picks a Theme with a live preview. Everything else lives in ",
          code("init.lua"),
          ", your Config, and ",
          code(":config"),
          " opens it in your editor.",
        ),
      ],
      steps: [
        {
          id: "theme",
          text: () => [text("Change the Theme with "), code(":theme"), text(": move to preview one, Enter keeps it. In the demo it's forgotten when you leave.")],
          on: [on("command", { id: "theme", arg: "*" })],
        },
        {
          id: "config",
          text: () => [text("Open your "), code("init.lua"), text(" with "), code(":config"), text(". It's your real Config: the demo doesn't change it, but your editor will.")],
          on: [on("command", { id: "config", arg: "" })],
        },
      ],
    },
  ],
  outro: (ctx) => [
    p("You've found a Host and opened Sessions to it, moved between them, found your way in help, and changed how roster looks. That's most of a day's work."),
    {
      t: "list",
      ordered: false,
      items: [
        [code(":tutor quit"), text(" goes back to your own Inventory and Sessions.")],
        [link("start", "Getting started"), text(" picks up from here, by where you come from.")],
        [link("quickref", "The quick reference"), text(" has the commands you'll use most, with their keys.")],
        [link("config", "Your init.lua"), text(" has every option; "), ...keyOr(ctx, "keys"), text(" shows every key.")],
      ],
    },
  ],
};

export function builtinTutorRegistry(): TutorRegistry {
  const registry = new Registry<TutorialDef>();
  registry.register(rosterTutorial);
  return registry;
}
