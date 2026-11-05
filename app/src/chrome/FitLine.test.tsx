import { describe, expect, it } from "vitest";
import { markOverflow } from "./FitLine";

/** A line 24 px high whose children sit at `tops` (jsdom has no layout). */
function line(tops: number[]) {
  const el = document.createElement("span");
  Object.defineProperty(el, "clientHeight", { value: 24 });
  el.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
  for (const top of tops) {
    const hint = document.createElement("button");
    hint.getBoundingClientRect = () => ({ top: 100 + top }) as DOMRect;
    el.append(hint);
  }
  return el;
}

describe("the status bar's hints (round 18)", () => {
  it("are whole on the line or not there: a hint that wrapped off is hidden and out of the accessibility tree", () => {
    const el = line([0, 0, 24]);
    markOverflow(el);
    const [a, b, c] = [...el.children];
    expect(a).not.toHaveAttribute("data-off");
    expect(b).not.toHaveAttribute("aria-hidden");
    expect(c).toHaveAttribute("data-off");
    expect(c).toHaveAttribute("aria-hidden", "true");
    // The window grows: it's back.
    c!.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    markOverflow(el);
    expect(c).not.toHaveAttribute("data-off");
    expect(c).not.toHaveAttribute("aria-hidden");
  });
});
