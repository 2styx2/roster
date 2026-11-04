/* eslint-disable no-control-regex -- the characters refused are control characters */
// The folder a shell says it's in, with OSC 7 (`ESC ] 7 ; file://HOST/PATH BEL`): ticket 121
// (#210, Q130e), read strictly since #242 (Q185), as Plugins get it too. It comes from the Host's
// shell, in its output, so it's that shell's word and anything the Host prints can forge it: it's
// only ever shown and reported, never used to reach a file or a folder.

/** The longest folder roster takes, in characters once decoded; a longer one is no folder. */
export const FOLDER_MAX = 1024;
/** The longest OSC 7 text looked at (a folder of FOLDER_MAX characters, every byte escaped). */
const TEXT_MAX = 4 * 3 * FOLDER_MAX + 300;
/** A host name: letters, digits, `.`, `-`, `_`, at most 253 (none, as in `file:///tmp`, is fine). */
const HOST = /^[A-Za-z0-9._-]{0,253}$/;
/** What a folder may not hold: C0 and C1 controls, DEL, and the characters that reorder or break
 * the text around them (bidi marks, embeddings, overrides and isolates; line and paragraph
 * separators), so a folder shown in a tooltip or by a Plugin is the text it looks like. */
const REFUSED = /[\x00-\x1f\x7f-\x9f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const decoder = new TextDecoder("utf-8", { fatal: true });

/** The folder in an OSC 7's text (`file://HOST/PATH`, percent-decoded as UTF-8; a `%` that
 * starts no escape is a `%`, as hooks send `$PWD` unencoded), or null for anything else: another
 * scheme, a host part that isn't a plain host name, escapes that aren't UTF-8, a control or
 * reordering character, or a folder longer than FOLDER_MAX (never a cut one). */
export function folderOf(text: string): string | null {
  if (text.length > TEXT_MAX || !text.startsWith("file://")) return null;
  const rest = text.slice("file://".length);
  const slash = rest.indexOf("/");
  if (slash < 0 || !HOST.test(rest.slice(0, slash))) return null;
  const raw = rest.slice(slash);
  if (REFUSED.test(raw)) return null;
  const bytes: number[] = [];
  const utf8 = new TextEncoder();
  for (let i = 0; i < raw.length; ) {
    const hex = raw[i] === "%" ? raw.slice(i + 1, i + 3) : "";
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 3;
    } else {
      const c = String.fromCodePoint(raw.codePointAt(i) ?? 0);
      bytes.push(...utf8.encode(c));
      i += c.length;
    }
  }
  let folder: string;
  try {
    folder = decoder.decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
  if (folder.length > FOLDER_MAX || REFUSED.test(folder)) return null;
  return folder;
}
