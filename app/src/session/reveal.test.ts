// Round 21: where a key question's card scrolls when focus moves in it. The geometry is Quick
// Connect's card at 480×320 with Inter and Iosevka loaded, as measured in Chromium in round 22
// (with `:help host-keys` 5 px lower): the title's rule at 100.39 px, the footer's top at 212 px,
// 22 px fades, and the body's lines in content pixels, unrounded, since a line 1 px past the
// title's rule is what round 22's reviewers saw as cut.
import { describe, expect, it } from "vitest";
import { revealTop, type RevealGeometry, type Span } from "./reveal";

// Content coordinates (scrollTop 0) of each line of text and each field under the title.
const LINES: Span[] = [
  { top: 107.39, bottom: 126.39 }, // roster hasn't seen a key at this address before.
  { top: 137.39, bottom: 155.39 }, // ssh-ed25519
  { top: 156.98, bottom: 174.98 }, // SHA256:…
  { top: 189.78, bottom: 206.78 }, // I've checked this key
  { top: 192.08, bottom: 205.08 }, // the box
  { top: 217.58, bottom: 234.58 }, // Compare it with the machine's console or its owner before
  { top: 244.17, bottom: 261.17 }, // you trust it.
  { top: 245.17, bottom: 262.17 }, // :help host-keys
  { top: 270.17, bottom: 287.17 }, // Password for root
  { top: 291.36, bottom: 323.36 }, // the password field
  { top: 330.36, bottom: 346.36 }, // Leave it empty to log in with this Box's keys.
];
const ROW: Span = { top: 182.58, bottom: 214.58 };
const PRINT: Span = { top: 133.39, bottom: 180.58 };
const TITLE = 100.39;
const FOOTER = 212;

/** The geometry as read at scroll `s` (viewport pixels move up by s). */
function at(s: number, target: Span = ROW, also: Span | null = PRINT): RevealGeometry {
  const up = (x: Span) => ({ top: x.top - s, bottom: x.bottom - s });
  return {
    scrollTop: s,
    maxScroll: 146,
    titleBottom: TITLE,
    footerTop: FOOTER,
    fade: 22,
    target: up(target),
    also: also && up(also),
    lines: LINES.map(up),
    pin: 0,
  };
}

const cut = (s: number) =>
  LINES.filter((l) =>
    [TITLE + s, FOOTER + s].some((edge) => l.top < edge - 0.05 && l.bottom > edge + 0.05),
  );

describe("revealTop: a blocked Enter lands on the box (round 21)", () => {
  it("from the password field, scrolled to the bottom, it scrolls back until the box is whole between the fades", () => {
    // Round 20 kept 139: the box's row at 44–76 px, under the title.
    const s = revealTop(at(139));
    expect(s).toBeLessThan(139);
    expect(ROW.top - s).toBeGreaterThanOrEqual(TITLE + 22);
    expect(ROW.bottom - s).toBeLessThanOrEqual(FOOTER - 22);
    expect(cut(s)).toEqual([]);
  });

  it("from Trust and connect at the card's opening scroll, the row isn't left under the footer", () => {
    // Round 20 kept 11: the row at 172–204 px, into the footer's fade (and 192–224 px, cut by
    // the footer, in the reviewers' run).
    const s = revealTop(at(11));
    expect(ROW.bottom - s).toBeLessThanOrEqual(FOOTER - 22);
    expect(ROW.top - s).toBeGreaterThanOrEqual(TITLE + 22);
    expect(cut(s)).toEqual([]);
  });

  it("lands on the same scroll whichever way it came, so the card doesn't wander", () => {
    // Round 22: with no line allowed past an edge, 139 stopped at 56 (fingerprint under the
    // title) and 0 at 26; the most of the key now wins from everywhere.
    const from = [0, 11, 60, 100, 139, 146].map((s) => revealTop(at(s)));
    expect(new Set(from).size).toBe(1);
  });

  it("the box wins when the box and the key's top can't both fit between the fades", () => {
    // 68 px between the fades; the key's top to the row's foot is 81 px.
    const s = revealTop(at(139));
    expect(ROW.top - s).toBeGreaterThanOrEqual(TITLE + 22);
    expect(PRINT.top - s).toBeLessThan(TITLE + 22);
  });

  it("shows the key's top too when there's room for both", () => {
    const tall = { ...at(139), footerTop: 260 };
    const s = revealTop(tall);
    expect(PRINT.top - s).toBeGreaterThanOrEqual(TITLE + 22 - 0.5);
    expect(ROW.bottom - s).toBeLessThanOrEqual(260 - 22);
  });

  it("stays put when the target is already whole and nothing is cut", () => {
    expect(revealTop(at(26))).toBe(26);
  });

  it("leaves no line even 1 px across the title's rule: the opening sentence goes wholly under (round 22)", () => {
    // Round 21 landed on 25, "roster hasn't seen a key…" 1 px below the rule (allowed then).
    const s = revealTop(at(0));
    expect(s).toBe(26);
    expect(LINES[0]!.bottom - s).toBeLessThanOrEqual(TITLE + 0.05);
    expect(cut(s)).toEqual([]);
  });

  it("never stops between 0 and the title's pin, where the title would creep", () => {
    const s = revealTop({ ...at(0), pin: 47 });
    expect(s === 0 || s >= 47).toBe(true);
  });

  it("a control (Tab to `:help host-keys`) is brought whole into view with no line cut", () => {
    const help: Span = { top: 245.17, bottom: 262.17 };
    const s = revealTop(at(0, help, null));
    expect(help.bottom - s).toBeLessThanOrEqual(FOOTER - 22);
    expect(cut(s)).toEqual([]);
  });

  it("a fade that isn't drawn takes no room: with no text below the footer it has none", () => {
    // The Host question at 480×320 scrolls 30 px; `:help host-keys` sits 210–235 px at rest.
    const help: Span = { top: 210, bottom: 235 };
    const g: RevealGeometry = {
      scrollTop: 0,
      maxScroll: 30,
      titleBottom: TITLE,
      footerTop: FOOTER,
      fade: 22,
      target: help,
      also: null,
      lines: [
        { top: 113, bottom: 132 }, // roster hasn't seen this Host's key before.
        { top: 195, bottom: 212 }, // Compare it with the Host's console or its owner before you
        { top: 213, bottom: 230 }, // trust it. :help host-keys
      ],
      pin: 0,
    };
    // From 23 on, nothing but padding lies below the footer (round 23: the fade is drawn for
    // text below it, not for any scroll left), so the link is whole at its edge.
    const s = revealTop(g);
    expect(s).toBe(23);
    expect(help.bottom - s).toBeLessThanOrEqual(FOOTER);
    expect(g.lines.every((l) => l.bottom - s <= FOOTER)).toBe(true);
  });
});

describe("revealTop: Quick Connect with Save to vault at 480×320 (round 23)", () => {
  // Content coordinates as measured in Chromium (scrollTop 0), the card scrolling 176 px.
  const LABEL: Span = { top: 270.2, bottom: 287.2 }; // Password for root
  const FIELD: Span = { top: 290.4, bottom: 322.4 };
  const NOTE: Span = { top: 330.4, bottom: 346.4 }; // Leave it empty to log in with this Box's keys.
  const SAVE_TEXT: Span = { top: 357.5, bottom: 373.5 }; // Save to vault once it logs in
  const SAVE: Span = { top: 359, bottom: 372 }; // its box
  const lines = [...LINES.slice(0, 8), LABEL, FIELD, NOTE, SAVE_TEXT, SAVE];
  const geometry = (s: number, target: Span | null, also: Span | null = null): RevealGeometry => {
    const up = (x: Span) => ({ top: x.top - s, bottom: x.bottom - s });
    return {
      scrollTop: s,
      maxScroll: 176,
      titleBottom: TITLE,
      footerTop: FOOTER,
      fade: 22,
      target: target && up(target),
      also: also && up(also),
      lines: lines.map(up),
      pin: 0,
    };
  };
  const crossed = (s: number) =>
    lines.filter((l) => [TITLE + s, FOOTER + s].some((e) => l.top < e - 0.05 && l.bottom > e + 0.05));

  it("Tab to the save box cuts no line at the title: \"Password for root\" stays whole", () => {
    // Round 22's rule drew the footer's fade over the last 7 px of padding, so the box was only
    // clear of it at 176, where "Password for root" sat 94.2–111.2 across the title's 100.4.
    const s = revealTop(geometry(135, SAVE));
    expect(crossed(s)).toEqual([]);
    expect(SAVE_TEXT.bottom - s).toBeLessThanOrEqual(FOOTER);
    expect(LABEL.top - s).toBeGreaterThanOrEqual(TITLE);
  });

  it("moving to a pinned button only settles the card: from a cut scroll to the nearest clean one", () => {
    const s = revealTop(geometry(176, null));
    expect(crossed(s)).toEqual([]);
    expect(Math.abs(s - 176)).toBeLessThanOrEqual(10);
    // Already clean: it stays.
    expect(revealTop(geometry(169, null))).toBe(169);
  });
});
