// The stylesheets keep `--faint` out of text (decision Q53, ticket 29 M1 option B): `faint` fails
// 4.5:1 in every Theme, so it's only for decorative icons and rules. A rule that sets `color`
// (or a placeholder's colour) to `--faint` must be one that draws only an icon; those are listed
// here by selector, so a new text rule can't slip in.
import { describe, expect, it } from "vitest";
import logoCss from "./chrome/logo.css?raw";
import helpDocCss from "./help/doc.css?raw";
import signinCss from "./lock/signin.css?raw";
import stylesCss from "./styles.css?raw";
import keysCss from "./ui/keys.css?raw";

const SHEETS: [string, string][] = [
  ["src/styles.css", stylesCss],
  ["src/lock/signin.css", signinCss],
  ["src/ui/keys.css", keysCss],
  ["src/help/doc.css", helpDocCss],
  ["src/chrome/logo.css", logoCss],
];

/** Selectors whose element holds only an icon (an SVG drawn in `currentColor`), never text. */
const ICON_ONLY = new Set([".sb-icon", ".picker-search-icon"]);

/** Every innermost rule of a stylesheet as [selector, declarations, the at-rules around it],
 * nesting flattened. */
function rules(css: string): [string, string, string[]][] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: [string, string, string[]][] = [];
  const stack: { selector: string; body: string }[] = [];
  let buf = "";
  for (const ch of text) {
    if (ch === "{") {
      stack.push({ selector: buf.trim(), body: "" });
      buf = "";
    } else if (ch === "}") {
      const top = stack.pop();
      if (!top) continue;
      const body = top.body + buf;
      const at = stack.map((s) => s.selector).filter((s) => s.startsWith("@"));
      if (!top.selector.startsWith("@")) out.push([top.selector, body, at]);
      buf = "";
    } else if (ch === ";" && stack.length) {
      const top = stack.at(-1);
      if (top) top.body += buf + ";";
      buf = "";
    } else {
      buf += ch;
    }
  }
  return out;
}

/** The selectors (each of a list) whose rule colours text with `--faint`. */
function faintText(css: string): string[] {
  return rules(css)
    .filter(([, body]) => /(^|;)\s*color\s*:\s*var\(--faint\)/.test(body))
    .flatMap(([selector]) => selector.split(",").map((s) => s.trim().replace(/\s+/g, " ")))
    .filter((s) => !ICON_ONLY.has(s));
}

describe("the stylesheets", () => {
  it("finds rules inside @media and nested blocks", () => {
    const css = "a { color: red; } @media (x) { .b { color: var(--faint); } } .c { x: 1; @starting-style { y: 2; } }";
    expect(rules(css).map(([s, , at]) => [s, at])).toEqual([
      ["a", []],
      [".b", ["@media (x)"]],
      [".c", []],
    ]);
  });

  it("catches a text rule that uses --faint, and lets an icon rule through", () => {
    expect(faintText(".hint { color: var(--faint); } .sb-icon { color: var(--faint); }")).toEqual([".hint"]);
    expect(faintText(".line { border-top: 1px solid var(--faint); }")).toEqual([]);
  });

  it.each(SHEETS)("%s never colours text with --faint", (_name, css) => {
    // vite.config.ts must let Vitest load the sheet, or `?raw` is empty and this passes by itself.
    expect(css).toContain("var(--");
    expect(faintText(css)).toEqual([]);
  });
});

describe("the second tone (decision Q57)", () => {
  it.each(SHEETS)("%s draws only shapes with --tone, never text", (_name, css) => {
    const text = rules(css)
      .filter(([, body]) => /(^|;)\s*(color|caret-color|-webkit-text-fill-color)\s*:[^;]*var\(--tone\)/.test(body))
      .map(([selector]) => selector);
    expect(text).toEqual([]);
  });
});

describe("native controls (S6)", () => {
  it("take the Theme's accent, not the browser's blue", () => {
    const root = rules(stylesCss).find(([selector]) => selector === ":root");
    expect(root?.[1]).toMatch(/accent-color\s*:\s*var\(--accent\)/);
  });
});

describe("type sizes (N6)", () => {
  /** Every font size in px a rule sets, through `font-size` or the `font` shorthand. */
  const sizes = (css: string) =>
    rules(css).flatMap(([selector, body]) =>
      [...body.matchAll(/(?:^|;)\s*font(?:-size)?\s*:[^;]*?(\d+(?:\.\d+)?)px/g)].map((m) => [selector, Number(m[1])] as const),
    );

  it("finds sizes in font-size and in the font shorthand", () => {
    expect(sizes(".a { font-size: 10px; } .b { font: 500 10.5px/1 var(--mono); } .c { width: 7px; }")).toEqual([
      [".a", 10],
      [".b", 10.5],
    ]);
  });

  it.each(SHEETS)("%s sets no text below the scale's 11 px step", (_name, css) => {
    expect(sizes(css).filter(([, px]) => px < 11)).toEqual([]);
  });
});

describe("hover (N8)", () => {
  it.each(SHEETS)("%s keeps every :hover rule for a real pointer", (_name, css) => {
    const loose = rules(css)
      .filter(([selector, , at]) => selector.includes(":hover") && !at.some((a) => /hover:\s*hover/.test(a)))
      .map(([selector]) => selector);
    expect(loose).toEqual([]);
  });
});

describe("what sits over a terminal (issue #78, item 6)", () => {
  // xterm.js gives its own layers z-indexes up to 11 (the link layer, the helpers). Unless the
  // terminal's box is a stacking context of its own, those layers paint over the error panel and
  // the "ended" note that follow it in the Session's pane, and swallow their clicks: the error's
  // Details couldn't be opened, nor Reconnect pressed. `isolation: isolate` keeps them inside.
  it("keeps xterm's layers inside the terminal's own stacking context", () => {
    const wrap = rules(stylesCss).find(([selector]) => selector === ".term-wrap");
    expect(wrap?.[1]).toMatch(/(^|;)\s*isolation\s*:\s*isolate/);
  });
});

// WebKitGTK (the Linux build, ticket 20) may not know `scrollbar-width` or `scrollbar-color`, so the
// scrollbars would come out wide and in GTK's colours. ::-webkit-scrollbar says the same for it;
// Chromium (WebView2) ignores those rules wherever the standard properties are set.
describe("scrollbars on WebKitGTK (ticket 20)", () => {
  const all = rules(stylesCss);
  const webkit = (part: string) => all.filter(([sel]) => sel.includes(`::-webkit-scrollbar${part}`));

  it("are thin and take the Theme's colours, as scrollbar-width and scrollbar-color ask", () => {
    expect(webkit("").some(([, body]) => /width:\s*\d+px/.test(body) && /height:\s*\d+px/.test(body))).toBe(true);
    expect(webkit("-thumb").some(([, body]) => body.includes("var(--raised-line)"))).toBe(true);
  });

  it("are hidden wherever scrollbar-width: none hides them", () => {
    const hidden = all.filter(([, body]) => /scrollbar-width:\s*none/.test(body)).map(([sel]) => sel);
    expect(hidden.length).toBeGreaterThan(0);
    for (const sel of hidden) {
      expect(
        webkit("").some(([s, body]) => s.includes(`${sel}::-webkit-scrollbar`) && /display:\s*none/.test(body)),
        `${sel}::-webkit-scrollbar { display: none }`,
      ).toBe(true);
    }
  });
});

describe("the Sidebar's row buttons (decision Q88)", () => {
  it("show on the selected row, and no hover rule reveals them or hides a row's address", () => {
    const all = rules(stylesCss);
    const hover = all.filter(([sel]) => sel.includes(":hover") && /\.sb-(row|heading)/.test(sel));
    for (const [sel] of hover) expect(sel, sel).not.toMatch(/\.sb-(action|detail|num|badge)/);
    expect(all.some(([sel, body]) => sel.includes(".sb-row.selected .sb-action") && /display:\s*grid/.test(body))).toBe(true);
    expect(all.some(([sel]) => /\.sb-row\.raised \.sb-action/.test(sel))).toBe(false);
  });
});

describe("the Picker's details (decision Q88, T72, round 16)", () => {
  it("is one key in the footer for the selected Host, never a control on a row", () => {
    const all = rules(stylesCss);
    for (const [sel] of all) expect(sel, sel).not.toMatch(/\.picker-row[^,]*\.picker-info/);
    expect(all.some(([sel]) => sel.includes(".picker-footer .picker-info-hint"))).toBe(true);
  });
});

describe("Plugins' UI (ticket 73)", () => {
  const body = (selector: string) =>
    rules(stylesCss)
      .filter(([s, , at]) => at.length === 0 && s.split(",").some((x) => x.trim() === selector))
      .map(([, b]) => b)
      .join(";");

  it("a Plugin's float lies over the terminal in every layout, so opening it never resizes a Session", () => {
    expect(body(".side-panel.plugin-float")).toMatch(/position\s*:\s*absolute/);
  });

  it("a Plugin's badge is a chip with tabular digits, cut when long, and never the accent", () => {
    const tag = body(".sb-tag");
    expect(tag).toMatch(/font-variant-numeric\s*:\s*tabular-nums/);
    expect(tag).toMatch(/text-overflow\s*:\s*ellipsis/);
    expect(tag).not.toMatch(/--accent/);
  });
});

describe("the Key bindings panel's rows (round 18)", () => {
  const body = (selector: string) =>
    rules(stylesCss)
      .filter(([s, , at]) => at.length === 0 && s.split(",").some((x) => x.trim() === selector))
      .map(([, b]) => b)
      .join(";");
  it("are one line each: the description is cut with an ellipsis, the keys never wrap", () => {
    expect(stylesCss).toMatch(/\.keys-panel tbody tr:not\(\.group\)\s*\{\s*display:\s*flex;/);
    const desc = body(".keys-panel td:first-child");
    expect(desc).toMatch(/white-space\s*:\s*nowrap/);
    expect(desc).toMatch(/text-overflow\s*:\s*ellipsis/);
    expect(body(".keys-keys")).toMatch(/white-space\s*:\s*nowrap/);
    expect(body(".keys-list")).toMatch(/flex-wrap\s*:\s*nowrap/);
  });
});

describe("the status bar's order of giving way (rounds 18, 19, 21)", () => {
  it("cuts nothing by CSS: FitBar gives every segment way by its own forms (round 21)", () => {
    // Round 21: the Backend's label was cut to a stub ("WSL:…") and this Box's middle-cut name cut
    // again at its end, both clipped by the bar's edge at 480. FitBar steps them (FitBar.test.tsx).
    expect(stylesCss).toMatch(/\.statusbar \.path \{ flex: none; \}/);
    expect(stylesCss).toMatch(/\.statusbar > \* \{ flex: none; \}/);
    expect(stylesCss).not.toMatch(/\.statusbar \.(?:backend|box|session-seg) \{[^}]*flex:/);
    expect(stylesCss).not.toMatch(/\.statusbar-cut \{[^}]*text-overflow/);
  });
});

describe("the Finder's list", () => {
  it("stacks its rows: it never takes the Picker's column grid", () => {
    // Round 2 made .picker-list a grid; the Finder, which reuses the class, laid every row side by side.
    expect(stylesCss).toMatch(/\.picker-list\.finder-list\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column/);
  });
});

describe("the Sidebar's cursor and menus (round 19)", () => {
  const body = (selector: string) =>
    rules(stylesCss)
      .filter(([s, , at]) => at.length === 0 && s.split(",").map((x) => x.trim()).includes(selector))
      .map(([, b]) => b)
      .join(";");
  it("outlines a heading's whole row, so its + sits inside the cursor", () => {
    expect(body(".sb-heading.cursor")).toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--accent\)/);
    expect(stylesCss).not.toMatch(/\.sb-heading\.cursor\s*>\s*\.sb-heading-button/);
  });
  it("draws a menu's group split as a rule you can see, the border's tone", () => {
    expect(body(".row-menu-sep")).toMatch(/background:\s*var\(--line-strong\)/);
  });
});
