// A message's text as the message line draws it (round 18): a command it names (":help commands",
// "(:help adding-hosts)") is something you'd type, so it's set in Iosevka (taste.md, the paste
// rule), as the empty state's command is. The words around it stay Inter.
import { Fragment } from "react";

/** A command a message names: a colon at a word's start, the command, and at most one lowercase
 * argument (":edit HOST" marks only ":edit": HOST is a placeholder). A trailing "." or ":" is the
 * sentence's. */
const COMMAND = /(^|[\s(“"'])(:[a-z][a-z0-9-]*(?: [a-z0-9](?:[\w#.:/-]*[\w#/-])?)?)/g;

/** What was typed, quoted back by a slip ("Not a command: blah.", "No help for zzqxj."): data
 * too (round 19), set in Iosevka with no quote marks. The word runs to the sentence's end. */
const TYPED = /(^|[\s(])((?<=(?:Not a command:|No help for) )[^\s]+?)(?=[.,]?(?:\s|$))/g;

/** `text` split into words and the commands it names, in order. `command` marks what's set in
 * Iosevka: a command, or what was typed. */
export function messageParts(text: string): { text: string; command: boolean }[] {
  const parts: { text: string; command: boolean }[] = [];
  let at = 0;
  const found = [...text.matchAll(COMMAND), ...text.matchAll(TYPED)].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  for (const m of found) {
    if ((m.index ?? 0) + (m[1]?.length ?? 0) < at) continue;
    const start = (m.index ?? 0) + (m[1]?.length ?? 0);
    if (start > at) parts.push({ text: text.slice(at, start), command: false });
    parts.push({ text: m[2] ?? "", command: true });
    at = start + (m[2]?.length ?? 0);
  }
  if (at < text.length) parts.push({ text: text.slice(at), command: false });
  return parts;
}

export function MessageText({ text }: { text: string }) {
  return (
    <>
      {messageParts(text).map((p, i) =>
        p.command ? (
          <code key={i} className="message-cmd">
            {p.text}
          </code>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </>
  );
}
