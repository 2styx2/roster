// What keeps an xterm fed a Session's output going when xterm.js itself goes wrong (ticket 172,
// #323). A CsiClamp bound to an xterm (csiClamp.ts) installs it there.
//
// xterm.js 6.0.0 throws inside `write` on ED 1 (`ESC[1J`, erase above, and DECSED `ESC[?1J`) with
// the cursor at the last column of the bottom row while nothing has scrolled off the screen yet:
// `eraseInDisplay` clears the next line's wrap flag at `lines.get(y + 1)`, the screen row without
// the scrollback's offset, which isn't there. A throw inside xterm.js's write queue stops that
// queue for good: the rest of that write and every later one never reach the screen.

import type { Terminal } from "@xterm/xterm";

/** The second parameter roster gives the ED 1 and ED 2 it writes in place of a Session's ED 1:
 * past CSI_PARAM_MAX (csiClamp.ts), so no sequence a Session prints reaches an xterm with it. */
export const ED1_TAG = 10000;

/** Bytes standing for one ED 1 (`?` for DECSED): an ED 1 and an ED 2, both tagged. At most one of
 * them is drawn: the ED 2 only where xterm.js would throw on the ED 1, where a correct terminal's
 * ED 1 erases every row anyway (the cursor at the end of the bottom row, nothing above the screen). */
export function ed1Pair(prefix: string): string {
  return `\x1b[${prefix}1;${ED1_TAG}J\x1b[${prefix}2;${ED1_TAG}J`;
}

/** The methods xterm.js 6's InputHandler runs for what it parses: a print, a control, an escape,
 * a CSI, an OSC or a DCS. */
const HANDLERS = [
  "print", "bell", "lineFeed", "carriageReturn", "backspace", "tab", "shiftOut", "shiftIn",
  "cursorUp", "cursorDown", "cursorForward", "cursorBackward", "cursorNextLine", "cursorPrecedingLine",
  "cursorCharAbsolute", "cursorPosition", "charPosAbsolute", "hPositionRelative", "linePosAbsolute",
  "vPositionRelative", "hVPosition", "tabClear", "cursorForwardTab", "cursorBackwardTab", "selectProtected",
  "eraseInDisplay", "eraseInLine", "insertLines", "deleteLines", "insertChars", "deleteChars", "scrollUp",
  "scrollDown", "scrollLeft", "scrollRight", "insertColumns", "deleteColumns", "eraseChars",
  "repeatPrecedingCharacter", "sendDeviceAttributesPrimary", "sendDeviceAttributesSecondary", "setMode",
  "setModePrivate", "resetMode", "resetModePrivate", "requestMode", "charAttributes", "deviceStatus",
  "deviceStatusPrivate", "softReset", "setCursorStyle", "setScrollRegion", "windowOptions", "saveCursor",
  "restoreCursor", "setTitle", "setIconName", "setOrReportIndexedColor", "setHyperlink", "setOrReportFgColor",
  "setOrReportBgColor", "setOrReportCursorColor", "restoreIndexedColor", "restoreFgColor", "restoreBgColor",
  "restoreCursorColor", "nextLine", "keypadApplicationMode", "keypadNumericMode", "selectDefaultCharset",
  "selectCharset", "index", "tabSet", "reverseIndex", "fullReset", "setgLevel", "screenAlignmentPattern",
  "requestStatusString",
] as const;

type Methods = Record<string, unknown>;

/** xterm.js 6's InputHandler behind a Terminal (not public API: its names are pinned by the
 * version in package.json and checked by ed1.test.ts). */
function inputHandler(t: Terminal): Methods | null {
  const core = (t as unknown as { _core?: { _inputHandler?: Methods } })._core;
  return core?._inputHandler ?? null;
}

const guarded = new WeakSet<Terminal>();
/** The handlers catchThrows put in place. */
const wrappers = new WeakSet<object>();

/** Makes `t` safe for a Session's output: the tagged ED 1 pair (ed1Pair) drawn as one ED 1, and
 * any handler that throws inside xterm.js skipped, so what follows it in the write (and every
 * later write) is still drawn. The first throw is logged, once per xterm, by name only: never the
 * message or the output, which may hold what the Session printed. Once per xterm. */
export function guardXterm(t: Terminal) {
  if (guarded.has(t)) return;
  guarded.add(t);
  catchThrows(t);
  // ED 1 where xterm.js would throw: skipped, and the tagged ED 2 after it drawn instead.
  let erase = false;
  const ed = (params: (number | number[])[]) => {
    if (params.length !== 2 || params[1] !== ED1_TAG) return false;
    if (params[0] === 1) {
      erase = ed1Throws(t);
      return erase;
    }
    const draw = erase;
    erase = false;
    return !draw;
  };
  t.parser.registerCsiHandler({ final: "J" }, ed);
  t.parser.registerCsiHandler({ prefix: "?", final: "J" }, ed);
}

/** Whether xterm.js 6.0.0's ED 1 throws here: the cursor (as ED moves it into the screen) at the
 * last column, and no buffer line after its row. */
function ed1Throws(t: Terminal): boolean {
  const b = t.buffer.active;
  const x = Math.min(t.cols, Math.max(0, b.cursorX));
  const y = Math.min(t.rows - 1, Math.max(0, b.cursorY));
  return x + 1 >= t.cols && b.getLine(y + 1) === undefined;
}

function catchThrows(t: Terminal) {
  const handler = inputHandler(t);
  if (!handler) return;
  let logged = false;
  for (const name of HANDLERS) {
    const run = handler[name];
    if (typeof run !== "function") continue;
    const wrapped = (...args: unknown[]): unknown => {
      try {
        return (run as (...a: unknown[]) => unknown).apply(handler, args);
      } catch (e) {
        if (!logged) {
          logged = true;
          const kind = e instanceof Error ? e.name : typeof e;
          console.warn(`roster: xterm.js threw (${kind}) on a sequence in a Session's output; it was skipped`);
        }
        return true;
      }
    };
    wrappers.add(wrapped);
    handler[name] = wrapped;
  }
}

/** Whether `t`'s xterm.js handlers are guarded against throwing (for the tests: false means an
 * xterm.js upgrade moved what catchThrows wraps). */
export function catchesThrows(t: Terminal): boolean {
  const handler = inputHandler(t);
  return handler !== null && HANDLERS.every((name) => wrappers.has(handler[name] as object));
}
