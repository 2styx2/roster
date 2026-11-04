// The guides' Markdown, which the app loads the first time help needs it (T213, decision Q189), not at
// start: it's a chunk of its own (guideText.ts, built from docs/ and bundled with the app, so it's
// read from disk like the rest of the app, never fetched from the network). What startup needs to
// find a guide's topics before then is the build-time tag table (tags.ts), as Neovim's doc/tags.
//
// This is the one place that knows the chunk: `load()` brings it in (once, however many ask; again
// after a failure), `markdown(id)` reads a guide's text once it's here, and `subscribe` tells
// whoever shows it (HelpView, the `:helpgrep` finder) that it came.

export type GuideTexts = Readonly<Record<string, string>>;

export class HelpText {
  private texts: GuideTexts | null = null;
  private loading: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly loader: () => Promise<GuideTexts>) {}

  ready = (): boolean => this.texts !== null;

  /** A guide's Markdown; undefined until the text is loaded, or for a page that isn't a guide. */
  markdown(id: string): string | undefined {
    return this.texts?.[id];
  }

  /** Brings the text in. Resolves when it's here; rejects when it couldn't load (the next call
   * tries again). */
  load(): Promise<void> {
    if (this.texts) return Promise.resolve();
    this.loading ??= this.loader().then(
      (texts) => this.use(texts),
      (e: unknown) => {
        this.loading = null;
        throw e instanceof Error ? e : new Error(String(e));
      },
    );
    return this.loading;
  }

  /** The text, given as it is: the docs website and its tests build every page at once, with the
   * chunk imported as an ordinary module. */
  use(texts: GuideTexts) {
    if (this.texts) return;
    this.texts = texts;
    for (const l of this.listeners) l();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

/** The app's: the chunk is guideText.ts, a dynamic import Vite builds as `guideText-*.js`. */
export const helpText = new HelpText(() => import("./guideText").then((m) => m.guideTexts));
