// `:help TOPIC /TEXT`, `:helpgrep` and the outline (ticket 43), on HelpView and the finders alone.
import { beforeAll, describe, expect, it } from "vitest";
import { defaultConfig } from "../config/fixture";
import type { FinderContext } from "../finder/sources";
import { defaultOptions, keymapOf } from "../keymap";
import { builtinRegistries } from "../registries";
import { helpFinder, helpgrepFinder, HelpView, outlineFinder } from "./command";
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
  it("the topic finder shows an alias and what it goes to as one row, tagged by the alias", () => {
    const finder = helpFinder(view());
    // Before a query, help's pages, each under its group, with what it is after its title (round 21).
    const pages = finder.items(none);
    expect(pages.every((r) => r.group !== undefined && r.note)).toBe(true);
    expect(pages.find((r) => r.id === "errors-guide")?.group).toBe("Reference");
    const rows = finder.search?.(none, "host key") ?? [];
    const hostKeys = rows.filter((r) => r.label === rows.find((x) => x.detail === "host-keys")?.label);
    expect(hostKeys).toHaveLength(1);
    expect(hostKeys[0]?.command).toBe("help errors-guide#checking-a-host-key");
    expect(rows.some((r) => r.id === "host-keys")).toBe(false);
    // Its page column is the page's short name (round 21: two pages read "Connection errors…").
    expect(hostKeys[0]?.path).toBe("When a Session fails");
  });

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
