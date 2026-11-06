// The guides' text is a chunk of its own, loaded on the first `:help` that needs it (T213, Q189).
// HelpView is where that wait happens: a guide opens when its text is there, with no empty panel
// first; only a wait past 150 ms shows the panel saying it's loading.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../config/fixture";
import { defaultOptions, keymapOf } from "../keymap";
import { builtinRegistries } from "../registries";
import type { FinderContext } from "../finder/sources";
import { helpCommand, helpgrepFinder, HelpView } from "./command";
import { helpContext, pageBody } from "./pages";
import { HelpText } from "./text";

/** A loader the test answers by hand. */
function deferred() {
  let answer: (texts: Record<string, string>) => void = () => {};
  let fail: (e: Error) => void = () => {};
  const calls = { n: 0 };
  const loader = () => {
    calls.n += 1;
    return new Promise<Record<string, string>>((res, rej) => {
      answer = res;
      fail = rej;
    });
  };
  return { loader, calls, answer: (t: Record<string, string>) => answer(t), fail: (e: Error) => fail(e) };
}

function viewWith(text: HelpText): HelpView {
  const r = builtinRegistries();
  const v = new HelpView(text);
  const ctx = helpContext(r, { keymap: keymapOf(r.keymap.list()), options: defaultOptions, config: defaultConfig, configPath: null, state: {}, activeTheme: null, text });
  v.setContext(() => ctx);
  return v;
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("HelpText", () => {
  it("draws a guide from the text it has now, after a restart too", async () => {
    const text = new HelpText(() => Promise.resolve({ config: "# Your init.lua\n\nThe first text." }));
    const ctx = viewWith(text).context()!;
    await text.load();
    expect(JSON.stringify(pageBody(ctx, "config"))).toContain("The first text.");
    text.restart(() => Promise.resolve({ config: "# Your init.lua\n\nThe second text." }));
    expect(pageBody(ctx, "config")).toEqual([]);
    await text.load();
    expect(JSON.stringify(pageBody(ctx, "config"))).toContain("The second text.");
  });

  it("loads once, however many ask, and tells its listeners", async () => {
    const d = deferred();
    const text = new HelpText(d.loader);
    const heard = vi.fn();
    text.subscribe(heard);
    expect(text.ready()).toBe(false);
    const a = text.load();
    const b = text.load();
    d.answer({ config: "# Your init.lua" });
    await Promise.all([a, b]);
    expect(d.calls.n).toBe(1);
    expect(text.ready()).toBe(true);
    expect(text.markdown("config")).toBe("# Your init.lua");
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("tries again after a load that failed", async () => {
    const d = deferred();
    const text = new HelpText(d.loader);
    const first = text.load();
    d.fail(new Error("no chunk"));
    await expect(first).rejects.toThrow("no chunk");
    expect(text.ready()).toBe(false);
    const second = text.load();
    d.answer({});
    await second;
    expect(d.calls.n).toBe(2);
    expect(text.ready()).toBe(true);
  });
});

describe("HelpView with the guides' text still to load", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens a guide only once its text is there: no empty page first", async () => {
    const d = deferred();
    const v = viewWith(new HelpText(d.loader));
    expect(v.openTopic("config#the-sandbox")).toBe(true);
    expect(v.snapshot().at).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    expect(v.snapshot().at).toBeNull();
    d.answer({ config: "# Your init.lua" });
    await flush();
    expect(v.snapshot()).toMatchObject({ at: { page: "config", anchor: "config#the-sandbox" }, loading: false });
  });

  it("past 150 ms it shows the page as loading, then the page, as one step back", async () => {
    const d = deferred();
    const v = viewWith(new HelpText(d.loader));
    v.open({ page: "options" });
    v.openTopic("keyboard");
    await vi.advanceTimersByTimeAsync(149);
    expect(v.snapshot().at).toEqual({ page: "options" });
    await vi.advanceTimersByTimeAsync(1);
    expect(v.snapshot()).toMatchObject({ at: { page: "keyboard" }, loading: true });
    d.answer({ keyboard: "# Keyboard" });
    await flush();
    expect(v.snapshot()).toMatchObject({ at: { page: "keyboard" }, loading: false, canBack: true });
    v.goBack();
    expect(v.snapshot().at).toEqual({ page: "options" });
    expect(v.snapshot().canBack).toBe(false);
  });

  it("a generated page opens at once, and a later open wins over one still waiting", async () => {
    const d = deferred();
    const v = viewWith(new HelpText(d.loader));
    v.openTopic("keyboard");
    v.openTopic("options");
    expect(v.snapshot().at).toEqual({ page: "options" });
    d.answer({ keyboard: "# Keyboard" });
    await vi.advanceTimersByTimeAsync(200);
    expect(v.snapshot().at).toEqual({ page: "options" });
  });

  it(":h <Tab> completes a guide's headings from the tag table, and starts the text loading", () => {
    const d = deferred();
    const v = viewWith(new HelpText(d.loader));
    expect(helpCommand(v).complete?.("config#the-sa", [])).toContain("config#the-sandbox");
    expect(d.calls.n).toBe(1);
  });

  it("says so when the text can't load", async () => {
    const d = deferred();
    const v = viewWith(new HelpText(d.loader));
    v.openTopic("keyboard");
    d.fail(new Error("no chunk"));
    await flush();
    expect(v.snapshot()).toMatchObject({ at: { page: "keyboard" }, loading: false, failed: "no chunk" });
  });

  it("past 150 ms, it's one open to the tutor, said when the page is there (#431 F2)", async () => {
    const d = deferred();
    const v = viewWith(new HelpText(d.loader));
    const moves: (string | undefined)[] = [];
    v.subscribe(() => moves.push(v.snapshot().moved));
    v.openTopic("keyboard");
    await vi.advanceTimersByTimeAsync(150);
    expect(v.snapshot()).toMatchObject({ loading: true });
    expect(v.snapshot().moved).toBeUndefined();
    d.answer({ keyboard: "# Keyboard" });
    await flush();
    expect(v.snapshot()).toMatchObject({ loading: false, moved: "open" });
    expect(moves.filter((m) => m === "open")).toHaveLength(1);
  });

  it("cancelPending drops a :help still waiting, so it never opens later (#431 F3)", async () => {
    const d = deferred();
    const v = viewWith(new HelpText(d.loader));
    v.openTopic("keyboard");
    v.cancelPending();
    d.answer({ keyboard: "# Keyboard" });
    await vi.advanceTimersByTimeAsync(200);
    expect(v.snapshot().at).toBeNull();
    // Cancelling with nothing waiting changes nothing.
    v.open({ page: "options" });
    v.cancelPending();
    expect(v.snapshot().at).toEqual({ page: "options" });
  });
});

describe(":helpgrep when the guides' text can't load (#431 F4)", () => {
  it("says so above what it found in the other pages", async () => {
    const d = deferred();
    const v = viewWith(new HelpText(d.loader));
    const finder = helpgrepFinder(v);
    finder.open?.();
    d.fail(new Error("no chunk"));
    await new Promise((done) => setTimeout(done, 0));
    const found = finder.search?.({} as FinderContext, "terminal") ?? [];
    expect(found[0]).toMatchObject({ label: "Couldn't load help's guides: no chunk. Only the other pages are searched." });
    expect(found[0]?.disabled).toBeTruthy();
    expect(found.length).toBeGreaterThan(1);
  });
});
