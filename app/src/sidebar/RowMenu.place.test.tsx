// Round 20: a row menu opened from a key near the window's foot scrolls the tree up just enough to
// open under its row, and a menu that must open upward lands on row edges (it had sliced the row
// above it mid-glyph). jsdom lays nothing out, so the rows' boxes are given by hand.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { RowMenu, scrollForMenu, snapUp } from "./RowMenu";

const ROW = 30;

/** A tree of `n` rows ROW tall in a scroller whose top is at `top`, `view` tall; row `i`'s box
 * follows the scroller's scrollTop, as a laid-out one would. */
function tree(n: number, top: number, view: number) {
  const treeEl = document.createElement("div");
  treeEl.setAttribute("role", "tree");
  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";
  Object.defineProperty(scroller, "scrollHeight", { value: n * ROW });
  Object.defineProperty(scroller, "clientHeight", { value: view });
  scroller.getBoundingClientRect = () => new DOMRect(0, top, 280, view);
  const rows = Array.from({ length: n }, (_, i) => {
    const li = document.createElement("li");
    li.className = "sb-row";
    li.getBoundingClientRect = () => new DOMRect(0, top + i * ROW - scroller.scrollTop, 280, ROW);
    scroller.append(li);
    return li;
  });
  treeEl.append(scroller);
  document.body.append(treeEl);
  return { scroller, rows };
}

const entries = [
  { label: "Open", command: "open a" },
  { label: "Details", command: "info a" },
];

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("a row menu near the window's foot (round 20)", () => {
  it("from a key, scrolls the tree so the menu opens under its row", () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(140);
    const { scroller, rows } = tree(40, 40, 740);
    const row = rows[22]!; // 700–730: 140 under it doesn't fit in 800
    render(<RowMenu label="a" entries={entries} at={null} anchor={() => row} leader="␣" run={() => {}} close={() => {}} />);
    expect(scroller.scrollTop).toBe(Math.ceil(730 + 140 + 4 - 800));
    const menu = document.querySelector<HTMLElement>(".row-menu")!;
    expect(parseFloat(menu.style.top)).toBe(row.getBoundingClientRect().bottom);
  });

  it("opened upward, both its edges sit on row edges, the room shared as padding", () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(140);
    const { rows } = tree(25, 40, 740); // nothing to scroll: the last row can't move up
    const row = rows[22]!;
    render(<RowMenu label="a" entries={entries} at={null} anchor={() => row} leader="␣" run={() => {}} close={() => {}} />);
    const menu = document.querySelector<HTMLElement>(".row-menu")!;
    const top = parseFloat(menu.style.top);
    // The row's top is 700: 140 above it is 560, inside the row 550–580, so the top goes to 550.
    expect(top).toBe(550);
    expect((top - 40) % ROW).toBe(0);
    expect(parseFloat(menu.style.paddingTop) + parseFloat(menu.style.paddingBottom)).toBe(10);
  });
});

describe("scrollForMenu and snapUp", () => {
  it("scrolls only when that's enough and the row stays in the scroller", () => {
    expect(scrollForMenu({ top: 100, bottom: 130 }, 140, 800, 500, 40)).toBe(0);
    expect(scrollForMenu({ top: 700, bottom: 730 }, 140, 800, 500, 40)).toBe(74);
    expect(scrollForMenu({ top: 700, bottom: 730 }, 140, 800, 10, 40)).toBe(0);
    expect(scrollForMenu({ top: 60, bottom: 90 }, 900, 800, 5000, 40)).toBe(0);
  });

  it("leaves a top above the rows as it is", () => {
    const edges = [100, 130, 130, 160];
    expect(snapUp(130, 80, edges)).toEqual({ top: 50, bottom: 130, extra: 0 });
    expect(snapUp(160, 40, edges)).toEqual({ top: 100, bottom: 160, extra: 20 });
  });
});
