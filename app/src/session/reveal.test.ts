// Round 21: where a key question's card scrolls when focus moves in it. The geometry is Quick
// Connect's card at 480×320 with Inter and Iosevka loaded (measured in Chromium): the title's rule
// at 100 px, the footer's top at 212 px, 22 px fades, and the body's lines in content pixels.
import { describe, expect, it } from "vitest";
import { revealTop, type RevealGeometry, type Span } from "./reveal";

// Content coordinates (scrollTop 0) of each line of text and each field under the title.
const LINES: Span[] = [
  { top: 107.4, bottom: 126.4 }, // roster hasn't seen a key at this address before.
  { top: 137.4, bottom: 155.4 }, // ssh-ed25519
  { top: 157, bottom: 175 }, // SHA256:…
  { top: 189.8, bottom: 206.8 }, // I've checked this key
  { top: 192.1, bottom: 205.1 }, // the box
  { top: 217.6, bottom: 234.6 }, // Compare it with the machine's console or its owner before
  { top: 237.2, bottom: 254.2 }, // you trust it. :help host-keys
  { top: 263.2, bottom: 280.2 }, // Password for root
  { top: 284.4, bottom: 316.4 }, // the password field
  { top: 323.4, bottom: 339.4 }, // Leave it empty to log in with this Box's keys.
];
const ROW: Span = { top: 182.6, bottom: 214.6 };
const PRINT: Span = { top: 133.4, bottom: 181.4 };
const TITLE = 100;
const FOOTER = 212;

/** The geometry as read at scroll `s` (viewport pixels move up by s). */
function at(s: number, target: Span = ROW, also: Span | null = PRINT): RevealGeometry {
  const up = (x: Span) => ({ top: x.top - s, bottom: x.bottom - s });
  return {
    scrollTop: s,
    maxScroll: 139,
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
    [TITLE + s, FOOTER + s].some((edge) => l.top < edge - 1.5 && l.bottom > edge + 1.5),
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
    const from = [0, 11, 60, 100, 139].map((s) => revealTop(at(s)));
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

  it("never stops between 0 and the title's pin, where the title would creep", () => {
    const s = revealTop({ ...at(0), pin: 47 });
    expect(s === 0 || s >= 47).toBe(true);
  });

  it("a control (Tab to `:help host-keys`) is brought whole into view with no line cut", () => {
    const help: Span = { top: 238.2, bottom: 255.2 };
    const s = revealTop(at(0, help, null));
    expect(help.bottom - s).toBeLessThanOrEqual(FOOTER - 22);
    expect(cut(s)).toEqual([]);
  });

  it("a fade that isn't drawn takes no room: at the last scroll the footer has none", () => {
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
    expect(revealTop(g)).toBe(30);
  });
});
