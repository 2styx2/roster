// Copy and paste in a terminal, as Windows Terminal does them. What's copied or pasted goes only
// between the clipboard and the terminal: never into a log, the State or a message
// (docs/app/security.md; a paste may well be a password).
import type { Clipboard } from "../platform/types";
import { runsOnWindows } from "../platform/os";

/** What copy and paste need from a terminal (xterm.js's Terminal has all of it). `paste` is
 * xterm's: line ends become Enter (CR), and the text goes inside bracketed-paste marks when the
 * shell asked for them, so a multi-line paste doesn't run line by line. */
export interface Selectable {
  getSelection(): string;
  hasSelection(): boolean;
  clearSelection(): void;
  paste(text: string): void;
}

/** The line end a copy uses: \r\n on Windows, as Windows Terminal's copy
 * (microsoft/terminal src/buffer/out/textBuffer.cpp, TextBuffer::GetPlainText adds L"\r\n"
 * after every row but the last that didn't wrap), and \n elsewhere, as macOS and Linux
 * terminals. Decided by roster's own OS test (platform/os.ts, the one Ctrl+V's binding uses),
 * not xterm.js's (it joins rows with \r\n when `navigator.platform` says Windows). */
export function copyLineEnd(): "\r\n" | "\n" {
  return runsOnWindows() ? "\r\n" : "\n";
}

/** The selection as it's copied: each line without the spaces after its end, as Windows
 * Terminal trims them (TextBuffer's CopyRequest, trimTrailingWhitespace), and ended with `eol`
 * (copyLineEnd). A full-screen program pads its rows with spaces, which xterm keeps. A line that
 * wrapped comes as one line, so the spaces where it wrapped stay. */
export function copiedText(selection: string, eol: "\r\n" | "\n" = copyLineEnd()): string {
  return selection.replace(/ +(?=\r?\n)| +$/g, "").replace(/\r?\n/g, eol);
}

/** Copies the selection; false (and the clipboard untouched) when nothing is selected. */
export function copySelection(term: Selectable, clipboard: Clipboard): boolean {
  const text = copiedText(term.getSelection());
  // A clipboard another program holds refuses it; the selection stays to copy again.
  if (text) void clipboard.writeText(text).catch(() => {});
  return Boolean(text);
}

/** Ctrl+C as Windows Terminal has it: with a selection, copy it and clear it (true: the key is
 * used up); without one, false, and the key goes to the shell as its interrupt. */
export function copyIfSelected(term: Selectable, clipboard: Clipboard): boolean {
  if (!term.hasSelection()) return false;
  copySelection(term, clipboard);
  term.clearSelection();
  return true;
}

/** A paste without its control characters, as Windows Terminal pastes (ControlCore::PasteText,
 * FilterStringForPaste with ControlCodes): every C0 but tab, CR and LF goes, and DEL and C1. So
 * text holding ESC can't end a bracketed paste early (`ESC [ 201 ~`) and run the rest as typed,
 * nor send a program keys of its own. Bracketed paste or not, as Windows Terminal. */
export function pasteFilter(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

/** Pastes `text` into the terminal, filtered (pasteFilter): every paste goes through here. */
export function pasteText(term: Pick<Selectable, "paste">, text: string): void {
  const filtered = pasteFilter(text);
  if (filtered) term.paste(filtered);
}

/** Pastes the clipboard's text into the terminal. A refused or empty clipboard does nothing. */
export async function pasteClipboard(term: Selectable, clipboard: Clipboard): Promise<void> {
  try {
    const text = await clipboard.readText();
    if (text) pasteText(term, text);
  } catch {
    // the WebView refused the clipboard: nothing to paste
  }
}

/** Right-click, as Windows Terminal (`ControlInteractivity.cpp` `PointerPressed`, decisions Q149
 * and Q166). With `programHasMouse` (a program turned mouse reporting on, and the key that takes
 * the mouse back isn't held) it's the program's, selection or not: xterm has sent it the click,
 * and nothing is copied or pasted. Otherwise it copies the selection and clears it, or pastes
 * when there's none; with `copyOnSelect` on it pastes after the copy, so a right-click on a
 * selection pastes that selection ("CopyOnSelect: right click always pastes"), but only when the
 * copy landed: a refused copy, or a selection of only spaces (nothing to copy), pastes nothing. */
export async function rightClick(
  term: Selectable,
  clipboard: Clipboard,
  { programHasMouse = false, copyOnSelect = false }: { programHasMouse?: boolean; copyOnSelect?: boolean } = {},
): Promise<void> {
  if (programHasMouse) return;
  if (term.hasSelection()) {
    const text = copiedText(term.getSelection());
    term.clearSelection();
    if (!text) return;
    // Waited for, so the paste reads what was just copied (Windows Terminal's copy is done before
    // its paste). It fails closed: when the copy didn't land, nothing is pasted, since the
    // clipboard still holds what was there before (a password, say), not the selection.
    try {
      await clipboard.writeText(text);
    } catch {
      return;
    }
    if (!copyOnSelect) return;
  }
  await pasteClipboard(term, clipboard);
}

/** Whether a right-click is the program's: it has mouse reporting on, the click came from a
 * pointer (a context menu from the Menu key or Shift+F10 pastes as before), and the key that
 * takes the mouse back isn't held. That key is xterm.js's own (`shouldForceSelection`): Shift,
 * or on macOS Option when `macOptionClickForcesSelection` is on, as xterm then neither reports
 * the click nor drags a program's selection. As Windows Terminal (`_canSendVTMouseInput`). */
export function programHasMouse(
  e: { shiftKey: boolean; altKey: boolean; button: number },
  mouseTrackingMode: "none" | "x10" | "vt200" | "drag" | "any",
  { mac, macOptionClickForcesSelection }: { mac: boolean; macOptionClickForcesSelection: boolean },
): boolean {
  if (mouseTrackingMode === "none" || e.button !== 2) return false;
  const forced = mac ? e.altKey && macOptionClickForcesSelection : e.shiftKey;
  return !forced;
}
