// `:help TOPIC /TEXT`, `:helpgrep` and the outline (ticket 43), on HelpView and the finders alone.
import { beforeAll, describe, expect, it } from "vitest";
import { defaultConfig } from "../config/fixture";
import type { FinderContext } from "../finder/sources";
import { defaultOptions, keymapOf } from "../keymap";
import { builtinRegistries } from "../registries";
import { helpgrepFinder, HelpView, outlineFinder } from "./command";
import { helpContext } from "./pages";
import { helpText } from "./text";

// The guides' text is a chunk the app loads on the first :help (T213); these read it.
beforeAll(() => helpText.load());

function view(): HelpView {
  const r = builtinRegistries();
  const v = new HelpView();
  const ctx = helpContext(r, { keymap: keymapOf(r.keymap.list()), options: defaultOptions, config: defaultConfig, configPath: null, state: {}, activeTheme: null });
  v.setContext(() => ctx);
  return v;
}
const none = {} as FinderContext;

describe("help's finders", () => {
  it(":help TOPIC /TEXT opens the topic with a search", () => {
    const v = view();
    expect(v.openTopic("config#the-sandbox /require")).toBe(true);
    expect(v.snapshot().at).toEqual({ page: "config", anchor: "config#the-sandbox", search: "require" });
  });

  it(":helpgrep lists a heading that has the words first, and never the index's summaries", () => {
    const v = view();
    const found = helpgrepFinder(v).search?.(none, "sandbox") ?? [];
    expect(found[0]).toMatchObject({ label: "The sandbox", command: "help config#the-sandbox /sandbox" });
    expect(found.some((i) => i.path?.startsWith("roster help"))).toBe(false);
    expect(helpgrepFinder(v).search?.(none, "zzqxj")).toEqual([]);
  });

  it("the outline is the open page's headings and entries, in order", () => {
    const v = view();
    expect(outlineFinder(v).items(none)).toEqual([]);
    v.openTopic("options");
    const items = outlineFinder(v).items(none);
    expect(items[0]).toMatchObject({ label: "Options", command: "help options" });
    expect(items.find((i) => i.label === "terminal.size")).toMatchObject({ command: "help terminal.size", path: "Fonts and the terminal" });
  });
});
