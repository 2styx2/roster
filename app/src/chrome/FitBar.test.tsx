import { describe, expect, it } from "vitest";
import { giveWay } from "./FitBar";

/** A 400 px bar whose segments are `widths` wide (jsdom has no layout): a Box, a path and three
 * hints. The bar's content is the sum of what's still shown. */
function bar(widths: { box: number; path: number; hints: number[] }) {
  const el = document.createElement("footer");
  Object.defineProperty(el, "clientWidth", { value: 400 });
  const box = document.createElement("span");
  box.className = "box";
  const cut = document.createElement("span");
  cut.className = "statusbar-cut";
  Object.defineProperty(cut, "scrollWidth", { value: 10 });
  Object.defineProperty(cut, "clientWidth", { value: 10 });
  box.append(cut);
  const path = document.createElement("span");
  path.className = "path";
  const hints = document.createElement("span");
  hints.className = "statusbar-hints";
  const right = document.createElement("span");
  right.append(hints);
  const parts = widths.hints.map(() => document.createElement("button"));
  hints.append(...parts);
  el.append(box, path, right);
  const width = () =>
    widths.box +
    (path.hasAttribute("data-off") ? 0 : widths.path) +
    parts.reduce((sum, p, i) => sum + (p.hasAttribute("data-off") ? 0 : (widths.hints[i] ?? 0)), 0);
  Object.defineProperty(el, "scrollWidth", { get: () => Math.max(400, width()) });
  return { el, path, parts };
}

describe("the status bar gives way in order (round 19)", () => {
  it("removes the hints last first, then the path, and only as many as it must", () => {
    const { el, path, parts } = bar({ box: 160, path: 120, hints: [60, 60, 60] });
    giveWay(el);
    // 460 px of content in 400: the last hint goes, and the rest fit.
    expect(parts.map((p) => p.hasAttribute("data-off"))).toEqual([false, false, true]);
    expect(parts[2]).toHaveAttribute("aria-hidden", "true");
    expect(path).not.toHaveAttribute("data-off");
  });

  it("removes the path once every hint is gone, and brings them back when there's room", () => {
    const sizes = { box: 300, path: 120, hints: [60, 60] };
    const { el, path, parts } = bar(sizes);
    giveWay(el);
    expect(parts.every((p) => p.hasAttribute("data-off"))).toBe(true);
    expect(path).toHaveAttribute("data-off");
    sizes.box = 100;
    giveWay(el);
    expect([path, ...parts].some((p) => p.hasAttribute("data-off"))).toBe(false);
    expect(path).not.toHaveAttribute("aria-hidden");
  });
});
