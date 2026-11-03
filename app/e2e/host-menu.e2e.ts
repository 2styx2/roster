// A Host row's menu in the whole app, end to end (T173, #324; the menu is T166's, decision Q156):
// index.html on the fake Backend's `many-hosts` fixture in headless Chromium, real layout, real
// right-clicks and keys. RowMenu.test.ts checks placeMenu's math; jsdom has no layout, so this is
// where the menu is shown to land on screen, next to its row and focused, at a narrow and a wide
// window, on rows at the top and the bottom of the Sidebar, opened at the row's left and right ends
// and from the keyboard (the Menu key, Shift+F10). Every corner is checked to be the menu's own
// pixel, so a menu cut off by a scrolling ancestor or under another layer fails too.
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { inject } from "vitest";
import { launch } from "./browser";
// The fake Backend's master password (src/backend/fake.ts FAKE_PASSWORD; not imported, as that
// module is the browser's).
const FAKE_PASSWORD = "correct horse";

let browser: Browser;
let context: BrowserContext | null = null;

beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
});
afterEach(async () => {
  await context?.close();
  context = null;
});

/** The app at `size`, unlocked, its Inventory listed. */
async function openApp(size: { width: number; height: number }): Promise<Page> {
  context = await browser.newContext({ viewport: size });
  const page = await context.newPage();
  // No dev toggle over the window: it isn't in the shipped app.
  await page.goto(`${inject("appUrl")}?fixture=many-hosts&toggle=off`);
  await page.getByLabel(/master password/i).fill(FAKE_PASSWORD);
  await page.keyboard.press("Enter");
  await page.getByRole("group", { name: "Inventory" }).getByRole("treeitem").first().waitFor();
  return page;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Scrolls the Sidebar so the `n`th Host row is at its top or its bottom, and gives that row's name
 * and box (the scroll is over by the time this returns: the next frame has been drawn). */
async function rowAt(page: Page, n: number, where: "top" | "bottom"): Promise<{ name: string; box: Box }> {
  return page.evaluate(
    async ([n, where]) => {
      const inventory = document.querySelector('[role="group"][aria-label="Inventory"]');
      // A Host's row: a treeitem whose name isn't a group's ("subnet-1, 3 Hosts").
      const hosts = Array.from(inventory?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []).filter(
        (el) => !/, \d+ Hosts?$/.test(el.getAttribute("aria-label") ?? ""),
      );
      const row = hosts[n];
      if (!row) throw new Error(`no Host row ${n}`);
      row.scrollIntoView({ block: where === "top" ? "start" : "end" });
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const r = row.getBoundingClientRect();
      // It's the row the pointer would hit there: shown, not under a heading or the Sidebar's foot.
      const hit = document.elementFromPoint(r.left + 8, (r.top + r.bottom) / 2);
      if (!hit || !row.contains(hit)) throw new Error(`Host row ${n} isn't on screen at the ${where}`);
      const name = (row.getAttribute("aria-label") ?? "").split(",")[0] ?? "";
      return { name, box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } };
    },
    [n, where] as const,
  );
}

interface Opened {
  label: string | null;
  box: Box;
  view: { width: number; height: number };
  /** The corners (just inside the rounding) that show something other than the menu. */
  hidden: string[];
  /** What has focus: the menu, its first item, another of its items, or something else. */
  focus: "menu" | "first item" | "item" | "outside";
  /** The box of the row it's for, now (the App-mode cursor may have scrolled it into view). */
  row: Box | null;
}

/** The open menu, once its opening transition (if any) is over, so its box is its final one. */
async function opened(page: Page): Promise<Opened> {
  await page.getByRole("menu").waitFor();
  return page.evaluate(async () => {
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    if (!menu) throw new Error("no menu");
    await Promise.all(menu.getAnimations({ subtree: true }).map((a) => a.finished));
    const r = menu.getBoundingClientRect();
    // Just inside the rounded corners.
    const d = (parseFloat(getComputedStyle(menu).borderTopLeftRadius) || 0) + 2;
    const corners: [string, number, number][] = [
      ["top left", r.left + d, r.top + d],
      ["top right", r.right - d, r.top + d],
      ["bottom left", r.left + d, r.bottom - d],
      ["bottom right", r.right - d, r.bottom - d],
    ];
    const hidden = corners.filter(([, x, y]) => !menu.contains(document.elementFromPoint(x, y))).map(([c]) => c);
    const label = menu.getAttribute("aria-label") ?? "";
    const rowBox = Array.from(document.querySelectorAll('[role="group"][aria-label="Inventory"] [role="treeitem"]'))
      .find((el) => (el.getAttribute("aria-label") ?? "").split(",")[0] === label)
      ?.getBoundingClientRect();
    const active = document.activeElement;
    const first = menu.querySelector('[role="menuitem"]');
    const focus =
      active === menu ? "menu" : active === first ? "first item" : active && menu.contains(active) ? "item" : "outside";
    return {
      label,
      box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      view: { width: window.innerWidth, height: window.innerHeight },
      hidden,
      focus,
      row: rowBox ? { left: rowBox.left, top: rowBox.top, right: rowBox.right, bottom: rowBox.bottom } : null,
    } satisfies Opened;
  });
}

/** Fully in the window, every corner its own. */
function expectOnScreen(m: Opened) {
  expect(m.box.left).toBeGreaterThanOrEqual(0);
  expect(m.box.top).toBeGreaterThanOrEqual(0);
  expect(m.box.right).toBeLessThanOrEqual(m.view.width);
  expect(m.box.bottom).toBeLessThanOrEqual(m.view.height);
  expect(m.hidden).toEqual([]);
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1;

const NARROW = { width: 420, height: 520 };
const WIDE = { width: 1600, height: 1000 };
// Host rows far enough down the list that each can be scrolled to the Sidebar's top or bottom.
const TOP_ROW = 30;
const BOTTOM_ROW = 60;

describe.each([
  ["narrow", NARROW],
  ["wide", WIDE],
] as const)("a Host row's menu in a %s window (T173)", (_, size) => {
  describe.each([
    ["top", TOP_ROW],
    ["bottom", BOTTOM_ROW],
  ] as const)("on a row at the Sidebar's %s", (where, n) => {
    // Below the row where there's room (the top), flipped above it where there isn't (the bottom).
    const expectSide = (m: Opened, above: number, below: number) => {
      if (where === "top") expect(near(m.box.top, below), `menu top ${m.box.top}, expected ${below}`).toBe(true);
      else expect(near(m.box.bottom, above), `menu bottom ${m.box.bottom}, expected ${above}`).toBe(true);
    };

    it.each([
      ["left", 4],
      ["right", -4],
    ] as const)("right-clicked at its %s end: on screen, at the pointer, the menu focused", async (_end, dx) => {
      const page = await openApp(size);
      const { name, box } = await rowAt(page, n, where);
      const x = dx > 0 ? box.left + dx : box.right + dx;
      const y = (box.top + box.bottom) / 2;
      await page.mouse.click(x, y, { button: "right" });
      const m = await opened(page);
      expect(m.label).toBe(name);
      expectOnScreen(m);
      // A corner at the pointer: below it, or above it when flipped; moved left only to stay in.
      expectSide(m, y, y);
      expect(m.box.left).toBeLessThanOrEqual(x);
      expect(m.box.right).toBeGreaterThanOrEqual(x);
      expect(m.focus).toBe("menu");
    });

    it.each([["ContextMenu"], ["Shift+F10"]] as const)(
      "opened by %s on the App-mode cursor: on screen, under or over the row, its first item focused",
      async (key) => {
        const page = await openApp(size);
        const { name, box } = await rowAt(page, n, where);
        // A click selects the row (and opens the Host: its Session's row goes in above, moving the
        // list), and the leader puts the App-mode cursor on it, scrolled into view: the row's box is
        // read once the menu is open. The Menu key comes at once, before that scroll's event, which
        // once closed the menu (T173's fix in RowMenu.tsx).
        await page.mouse.click(box.left + 8, (box.top + box.bottom) / 2);
        await page.keyboard.press("Control+Space");
        await page.keyboard.press(key);
        const m = await opened(page);
        expect(m.label).toBe(name);
        expectOnScreen(m);
        const row = m.row;
        if (!row) throw new Error(`no row for ${name}`);
        expectSide(m, row.top, row.bottom);
        // Beside the row: it overlaps it across.
        expect(m.box.left).toBeLessThan(row.right);
        expect(m.box.right).toBeGreaterThan(row.left);
        expect(m.focus).toBe("first item");
      },
    );
  });
});
