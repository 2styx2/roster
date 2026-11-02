// Copy and paste in a terminal, as Windows Terminal does them. What's copied or pasted goes only
// between the clipboard and the terminal: never into a log, the State or a message
// (docs/app/security.md; a paste may well be a password).
import type { Clipboard } from "../platform/types";

/** What copy and paste need from a terminal (xterm.js's Terminal has all of it). `paste` is
 * xterm's: line ends become Enter (CR), and the text goes inside bracketed-paste marks when the
 * shell asked for them, so a multi-line paste doesn't run line by line. */
export interface Selectable {
  getSelection(): string;
  hasSelection(): boolean;
  clearSelection(): void;
  paste(text: string): void;
}

/** The selection as it's copied: each line without the spaces after its end, as Windows
 * Terminal trims them (TextBuffer's CopyRequest, trimTrailingWhitespace). A full-screen program
 * pads its rows with spaces, which xterm keeps. A line that wrapped comes as one line, so the
 * spaces where it wrapped stay; xterm ends lines with \r\n on Windows. */
export function copiedText(selection: string): string {
  return selection.replace(/ +(?=\r?\n)| +$/g, "");
}

/** Copies the selection; false (and the clipboard untouched) when nothing is selected. */
export function copySelection(term: Selectable, clipboard: Clipboard): boolean {
  const text = copiedText(term.getSelection());
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

/** Pastes the clipboard's text into the terminal. A refused or empty clipboard does nothing. */
export async function pasteClipboard(term: Selectable, clipboard: Clipboard): Promise<void> {
  try {
    const text = await clipboard.readText();
    if (text) term.paste(text);
  } catch {
    // the WebView refused the clipboard: nothing to paste
  }
}

/** Right-click: copy the selection and clear it, or paste when there's none. With
 * `programHasMouse` (a program turned mouse reporting on, and Shift isn't held) and nothing
 * selected, it's the program's, as in Windows Terminal: xterm has sent it the click, and nothing
 * is pasted (decision Q149). A selection (made with Shift+drag) is still copied. */
export async function rightClick(term: Selectable, clipboard: Clipboard, { programHasMouse = false }: { programHasMouse?: boolean } = {}): Promise<void> {
  if (term.hasSelection()) {
    copySelection(term, clipboard);
    term.clearSelection();
    return;
  }
  if (programHasMouse) return;
  await pasteClipboard(term, clipboard);
}
