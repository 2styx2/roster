// The worst case (ticket 27, decision Q47): the App rendered with the `worst-case` fixtures the
// dev page's "Demo data / Worst case" toggle uses (backend/worstCase.ts), and the invariants that
// keep it readable: nothing is cut off without its whole text in a tooltip, counts are grouped
// and pluralized, a missing field never prints as "undefined", the Leader is always a keycap.
// jsdom has no layout, so "cut off" means "styled to be cut off": every element a styles.css rule
// gives `text-overflow: ellipsis`. The screenshots in docs/app/design/break-ui/ show the layout.
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, fixtures } from "./backend/fake";
import { fixtureProps } from "./backend/fixtureProps";
import { LONG_NAME, LONG_NAME_OPEN, SHA_OFFERED, SHA_RECORDED, WORST_BINDINGS } from "./backend/worstCase";
import { defaultOptions, type Options } from "./keymap";
import { memoryPlatform } from "./platform/memory";
import { StubTerminal } from "./terminal/StubTerminal";
import css from "./styles.css?raw";

const LEADER = "{Control>} {/Control}";

/** The App as the dev page builds it for `?fixture=<name>`, unlocked. */
async function open(name: string, options: Partial<Options> = {}) {
  const scenario = fixtures[name];
  if (!scenario) throw new Error(`no fixture ${name}`);
  const user = userEvent.setup();
  render(
    <App
      backend={fakeBackend(scenario)}
      terminalView={StubTerminal}
      options={{ ...defaultOptions, ...options }}
      {...fixtureProps(scenario.app, memoryPlatform())}
    />,
  );
  // 1,284 Hosts take jsdom a while to draw, longer than the usual 10 s on a busy machine (T146).
  const slow = { timeout: 20_000 };
  await user.type(await screen.findByLabelText(/master password/i, {}, slow), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i }, slow);
  return user;
}

async function sessionsOpen(n: number) {
  const list = screen.getByRole("group", { name: "Sessions" });
  await expect.poll(() => within(list).queryAllByRole("button", { name: /^Close / }).length, { timeout: 10_000 }).toBe(n);
}

/** Every selector styles.css cuts off with an ellipsis. */
function cutSelectors(): string[] {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  for (const [, selectors, body] of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/text-overflow:\s*ellipsis/.test(body ?? "")) continue;
    out.push(...(selectors ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  }
  return out;
}

/** Elements styled to be cut off whose whole text isn't in a tooltip (theirs or an ancestor's). */
function cutWithoutTooltip(): string[] {
  const bad: string[] = [];
  for (const selector of cutSelectors()) {
    for (const el of document.querySelectorAll(selector)) {
      const text = el.textContent?.trim() ?? "";
      // Never shown: the Picker's sizer row only measures its columns.
      if (!text || el.closest('[aria-hidden="true"]')) continue;
      const title = el.closest("[title]")?.getAttribute("title") ?? "";
      // A middle cut ("server-10…7-203") keeps the name's start and end; the tooltip has it whole.
      const [head = "", tail] = text.split("…");
      const middleCut = tail !== undefined && title.startsWith(head) && title.endsWith(tail);
      if (!title.includes(text) && !middleCut) bad.push(`${selector}: "${text}"`);
    }
  }
  return bad;
}

/** Text that is a missing value printed as is. */
const leaked = () => (document.body.textContent ?? "").match(/\b(undefined|NaN|null)\b|\[object Object\]/g) ?? [];

/** "␣" drawn as text rather than as the Leader's keycap (it read as "_ f"). */
function bareLeaders(): string[] {
  const out: string[] = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n.textContent?.includes("␣") && !n.parentElement?.closest(".visually-hidden, input")) out.push(n.textContent);
  }
  return out;
}

describe("the worst case", () => {
  it("cuts nothing without a tooltip in the Sidebar and the status bar, and groups the counts", async () => {
    await open("worst-case");
    await sessionsOpen(50);
    expect(cutWithoutTooltip()).toEqual([]);
    expect(leaked()).toEqual([]);
    expect(bareLeaders()).toEqual([]);

    const bar = document.querySelector(".statusbar") as HTMLElement;
    expect(bar).toHaveTextContent("1,284 Hosts");
    const heading = (name: string) => within(screen.getByRole("group", { name })).getAllByRole("treeitem", { name })[0];
    expect(heading("Inventory")).toHaveTextContent("1,284");
    expect(heading("Sessions")).toHaveTextContent("50");
    expect(heading("Folders")).toHaveTextContent("100");
  }, 30_000);

  it("keeps two Sessions to one long-named Host apart: the (2) is never cut", async () => {
    await open("worst-case");
    await sessionsOpen(50);
    const tails = [...document.querySelectorAll(".sidebar .sb-tail")].map((t) => t.textContent);
    expect(tails).toEqual([" (2)", " (3)"]);
    const row = document.querySelector(".sb-tail")?.closest(".sb-item") as HTMLElement;
    expect(row.querySelector(".sb-label")).toHaveTextContent(LONG_NAME_OPEN);
    expect(row.querySelector(".sb-text")?.getAttribute("title")).toContain(`${LONG_NAME_OPEN} (2)`);
  }, 30_000);

  it("shows an unreviewed long name whole on hover, with why it can't be opened", async () => {
    await open("worst-case");
    const row = document.querySelector(`[data-row="inventory:${LONG_NAME}"]`) as HTMLElement;
    expect(row.querySelector(".sb-text")).toHaveAttribute("title", `${LONG_NAME}\nNot reviewed yet: can't be opened`);
    // The count of a long-named group is its own element, never cut with the name.
    const group = document.querySelector('[data-row^="group:fieldwork"]') as HTMLElement;
    expect(group.querySelector(".sb-num")).toHaveTextContent("13");
  }, 30_000);

  it("cuts nothing without a tooltip in the Picker, the command line and the Key bindings panel", async () => {
    const user = await open("worst-case");
    await user.keyboard(`${LEADER}f`);
    const picker = screen.getByRole("dialog", { name: "Find a Host" });
    expect(within(picker).getByText("200 of 1,284 Hosts")).toBeInTheDocument();
    // An unreviewed Host's long notice in the footer. Long names are pasted: each typed key
    // filters 1,284 Hosts again, and only where it ends up matters here (#62).
    await user.paste(LONG_NAME);
    await user.keyboard("{Enter}");
    // The notice, beside the hidden count that a screen reader hears.
    expect(within(picker).getAllByRole("status").map((s) => s.textContent).join(" ")).toMatch(/isn't reviewed yet/);
    expect(cutWithoutTooltip()).toEqual([]);
    await user.keyboard("{Escape}");
    await user.keyboard(`${LEADER}K`);
    const panel = screen.getByRole("complementary", { name: "Key bindings" });
    expect(within(panel).getAllByTitle(WORST_BINDINGS.source).length).toBeGreaterThan(0);
    await user.keyboard(`${LEADER}:`);
    await user.paste(`folder add ${LONG_NAME_OPEN} `);
    // The count sits under the listbox (its options carry aria-setsize), not inside it.
    expect(document.querySelector(".cmdline-candidates .more")).toHaveTextContent(/\+\d+ more/);
    expect(cutWithoutTooltip()).toEqual([]);
    expect(bareLeaders()).toEqual([]);
  }, 30_000);

  it("shows the whole SHA256 fingerprints in :check, and cuts its step messages only with a tooltip", async () => {
    const user = await open("worst-case");
    await user.keyboard(`${LEADER}:`);
    await user.paste(`check ${LONG_NAME_OPEN}`);
    await user.keyboard("{Enter}");
    const check = await screen.findByRole("region", { name: `Check ${LONG_NAME_OPEN}` });
    for (const f of [...SHA_RECORDED, SHA_OFFERED]) expect(within(check).getByText(f)).toBeInTheDocument();
    expect(cutWithoutTooltip()).toEqual([]);
    expect(leaked()).toEqual([]);
  }, 30_000);

  it("cuts nothing without a tooltip in Focus: the finders, the session bar and the hint", async () => {
    const user = await open("worst-case", { focus: { sessionbar: "bottom" } });
    await sessionsOpen(50);
    await user.keyboard("{F11}");
    const bar = screen.getByRole("navigation", { name: "Session bar" });
    expect(within(bar).getByRole("button", { current: true })).toHaveAccessibleName(/^50:/);
    await user.keyboard(`${LEADER}b`);
    expect(screen.getByRole("dialog", { name: "Find a Session" })).toBeInTheDocument();
    expect(cutWithoutTooltip()).toEqual([]);
    await user.keyboard("{Escape}");
    await user.keyboard(`${LEADER}t`);
    const tree = screen.getByRole("dialog", { name: "Find in the tree" });
    expect(within(tree).getByText(/^200 of 1,3\d\d$/)).toBeInTheDocument();
    expect(cutWithoutTooltip()).toEqual([]);
    expect(bareLeaders()).toEqual([]);
  }, 30_000);

  it("cuts nothing without a tooltip in the tab strip, and keeps the (2) there too", async () => {
    await open("worst-case", { sessions: "tabs" });
    const strip = await screen.findByRole("tablist", { name: "Sessions" });
    await expect.poll(() => within(strip).getAllByRole("tab").length).toBe(50);
    expect([...strip.querySelectorAll(".tab-tail")].map((t) => t.textContent)).toEqual([" (2)", " (3)"]);
    expect(cutWithoutTooltip()).toEqual([]);
  }, 30_000);
});

describe("one, and none", () => {
  it("says 1 Host, not 1 Hosts", async () => {
    const user = await open("worst-case-one");
    expect(document.querySelector(".statusbar")).toHaveTextContent("1 Host");
    expect(document.querySelector(".statusbar")).not.toHaveTextContent("1 Hosts");
    await user.keyboard(`${LEADER}f`);
    expect(screen.getByRole("dialog", { name: "Find a Host" })).toHaveTextContent("1 Host");
  });

  it("has an empty state everywhere, and keeps a key hint's word on its line", async () => {
    const user = await open("worst-case-empty");
    expect(document.querySelector(".statusbar")).toHaveTextContent("0 Hosts");
    expect(screen.getByText("No Hosts yet. Add them in roster.yml.")).toBeInTheDocument();
    const hint = document.querySelector(".sb-empty .keys-with-word");
    // "Drag a Host here, or ␣ a.": the word before the keys stays on their line.
    expect(hint).toHaveTextContent(/^or/);
    expect(hint?.querySelector(".keycap-leader")).not.toBeNull();
    await user.keyboard(`${LEADER}f`);
    expect(screen.getByText(/The Inventory has no Hosts yet/)).toBeInTheDocument();
    expect(leaked()).toEqual([]);
    expect(bareLeaders()).toEqual([]);
  });
});
