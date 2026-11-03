// What keeps an xterm fed a Session's output going when xterm.js itself goes wrong (ticket 172,
// #323). A CsiClamp bound to an xterm (csiClamp.ts) installs it there.
//
// xterm.js 6.0.0 throws inside `write` on ED 1 (`ESC[1J`, erase above, and DECSED `ESC[?1J`) with
// the cursor at the last column of the bottom row while nothing has scrolled off the screen yet:
// `eraseInDisplay` clears the next line's wrap flag at `lines.get(y + 1)`, the screen row without
// the scrollback's offset, which isn't there. A throw inside xterm.js's write queue stops that
// queue for good: the rest of that write and every later one never reach the screen. So each of
// the xterm's handlers runs inside a try/catch (xterm.js has no public hook for it), and an ED 1
// that throws is run again as the ED 2 a correct terminal's ED 1 amounts to there (decision Q158).

import type { Terminal } from "@xterm/xterm";

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

const guardedXterms = new WeakSet<Terminal>();
/** The handlers catchThrows put in place. */
const wrappers = new WeakSet<object>();
/** The xterms whose first throw has been logged. */
const logged = new WeakSet<object>();

/** Logs `e` for `t`'s first throw only, by the error's type: never its message or the output,
 * which may hold what the Session printed. */
function logOnce(t: object, e: unknown) {
  if (logged.has(t)) return;
  logged.add(t);
  const kind = e instanceof Error ? e.name : typeof e;
  console.warn(`roster: a handler threw (${kind}) on a sequence in a Session's output; it was skipped`);
}

/** Makes `t` safe for a Session's output: any of xterm.js's handlers that throws skips just that
 * sequence, so what follows it in the write (and every later write) is still drawn, and an ED 1
 * that throws (above) is drawn as a correct terminal draws it. Once per xterm. */
export function guardXterm(t: Terminal) {
  if (guardedXterms.has(t)) return;
  guardedXterms.add(t);
  catchThrows(t);
}

/** `run`, a handler roster registers on an xterm a Session's output reaches (an OSC 133 mark, OSC
 * 52), made safe: a throw skips that sequence (it's used up), logged as guardXterm logs. */
export function guarded<A extends unknown[]>(t: object, run: (...args: A) => boolean): (...args: A) => boolean {
  return (...args: A) => {
    try {
      return run(...args);
    } catch (e) {
      logOnce(t, e);
      return true;
    }
  };
}

/** xterm.js's parameters for a CSI (its `Params`): the first is ED's mode. */
type Params = { params: Int32Array };

function catchThrows(t: Terminal) {
  const handler = inputHandler(t);
  if (!handler) return;
  for (const name of HANDLERS) {
    const run = handler[name];
    if (typeof run !== "function") continue;
    const call = (args: unknown[]): unknown => (run as (...a: unknown[]) => unknown).apply(handler, args);
    const wrapped = (...args: unknown[]): unknown => {
      try {
        return call(args);
      } catch (e) {
        // ED 1 throws only with the cursor (where ED moves it) at the end of the bottom row and
        // nothing scrolled off: a correct ED 1 erases every row there, so it's drawn as ED 2
        // (the same protect flag for DECSED), no log. It had erased the cursor's row already.
        const params = args[0] as Params | undefined;
        if (name === "eraseInDisplay" && params?.params[0] === 1) {
          params.params[0] = 2;
          try {
            return call(args);
          } catch (again) {
            logOnce(t, again);
            return true;
          } finally {
            params.params[0] = 1;
          }
        }
        logOnce(t, e);
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
