// The guides' Markdown, which the app loads the first time help needs it (T213, decision Q189), not at
// start: it's a chunk of its own (guideText.ts, built from docs/ and bundled with the app, so it's
// read from disk like the rest of the app, never fetched from the network). What startup needs to
// find a guide's topics before then is the build-time tag table (tagTable.ts, served as
// `virtual:help-tags`), as Neovim's doc/tags.
//
// This is the one place that knows the chunk: `load()` brings it in (once, however many ask; again
// after a failure), `markdown(id)` reads a guide's text once it's here, `blocks(id, make)` keeps
// what a guide's text was made into for as long as that text, and `subscribe` tells whoever shows
// it (HelpView, the `:helpgrep` finder) that it came.
import type { Block } from "./doc";

export type GuideTexts = Readonly<Record<string, string>>;

export class HelpText {
  private texts: GuideTexts | null = null;
  private loading: Promise<void> | null = null;
  private error: string | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly made = new Map<string, Block[]>();

  constructor(private loader: () => Promise<GuideTexts>) {}

  ready = (): boolean => this.texts !== null;

  /** A guide's Markdown; undefined until the text is loaded, or for a page that isn't a guide. */
  markdown(id: string): string | undefined {
    return this.texts?.[id];
  }

  /** A guide's text made into blocks by `make`, once per text: none until it's loaded. */
  blocks(id: string, make: (markdown: string) => Block[]): Block[] {
    const kept = this.made.get(id);
    if (kept) return kept;
    const markdown = this.markdown(id);
    if (markdown === undefined) return [];
    const blocks = make(markdown);
    this.made.set(id, blocks);
    return blocks;
  }

  /** Why the last load failed; null before any, while one is under way and once it's loaded. */
  failed = (): string | null => this.error;

  /** Brings the text in. Resolves when it's here; rejects when it couldn't load (the next call
   * tries again). */
  load(): Promise<void> {
    if (this.texts) return Promise.resolve();
    if (!this.loading) this.error = null;
    this.loading ??= this.loader().then(
      (texts) => this.use(texts),
      (e: unknown) => {
        const err = e instanceof Error ? e : new Error(String(e));
        this.loading = null;
        this.error = err.message;
        // Who shows the text says it couldn't load (`:helpgrep`, #431's review F4).
        for (const l of this.listeners) l();
        throw err;
      },
    );
    return this.loading;
  }

  /** The text, given as it is: the docs website and its tests build every page at once, with the
   * chunk imported as an ordinary module. */
  use(texts: GuideTexts) {
    if (this.texts) return;
    this.texts = texts;
    this.made.clear();
    for (const l of this.listeners) l();
  }

  /** Starts over with nothing loaded, the text to come from `loader`: the App tests give each case
   * a first `:help` of its own, with a loader they hold back. */
  restart(loader: () => Promise<GuideTexts>) {
    this.loader = loader;
    this.texts = null;
    this.made.clear();
    this.loading = null;
    this.error = null;
    for (const l of this.listeners) l();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

/** The app's: the chunk is guideText.ts, a dynamic import Vite builds as `guideText-*.js`. */
export const helpText = new HelpText(() => import("./guideText").then((m) => m.guideTexts));
