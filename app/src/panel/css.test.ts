// @vitest-environment node
// The panels' sizes are in two places that must agree: layout.ts arranges and resizes them, and
// styles.css draws them (a media query can't read a CSS variable, nor jsdom a stylesheet). This
// reads styles.css and holds it to layout.ts's numbers.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_PANEL_PX, FLOAT_GAP_PX, NARROW_WINDOW_PX, PANEL_MIN_PX, TERMINAL_MIN_PX } from "./layout";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");
const all = (re: RegExp) => [...css.matchAll(re)].map((m) => Number(m[1]));

describe("styles.css and panel/layout.ts", () => {
  it("float the panels below the same window width", () => {
    const widths = all(/@media \(max-width: (\d+)px\) \{\s*[^}]*(?:panel|\.help-panel)/g);
    expect(widths.length).toBeGreaterThan(0);
    expect(new Set(widths)).toEqual(new Set([NARROW_WINDOW_PX]));
  });

  it("keep the same room for the terminal, the same narrowest panel and the same default width", () => {
    expect(all(/\.workspace \{ min-width: (\d+)px; \}/g)).toEqual([TERMINAL_MIN_PX]);
    expect(all(/--pane-max: max\(var\(--pane-min\), calc\(100% - var\(--sidebar-room, 0px\) - (\d+)px\)\)/g)).toEqual([TERMINAL_MIN_PX]);
    expect(all(/--pane-min: min\((\d+)px, 100%\)/g)).toEqual([PANEL_MIN_PX]);
    expect(all(/--keys-width: (\d+)px/g)).toEqual([DEFAULT_PANEL_PX]);
    expect(new Set(all(/--pane-max: calc\(100% - (\d+)px\)/g))).toEqual(new Set([FLOAT_GAP_PX]));
  });
});
