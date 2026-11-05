// A message's text as the message line draws it (round 18): a command it names (":help commands",
// "(:help adding-hosts)") is something you'd type, so it's set in Iosevka (taste.md, the paste
// rule), as the empty state's command is. The words around it stay Inter.
import { Fragment } from "react";

/** A command a message names: a colon at a word's start, the command, and at most one lowercase
 * argument (":edit HOST" marks only ":edit": HOST is a placeholder). A trailing "." or ":" is the
 * sentence's. */
const COMMAND = /(^|[\s(“"'])(:[a-z][a-z0-9-]*(?: [a-z0-9](?:[\w#.:/-]*[\w#/-])?)?)/g;

/** `text` split into words and the commands it names, in order. */
export function messageParts(text: string): { text: string; command: boolean }[] {
  const parts: { text: string; command: boolean }[] = [];
  let at = 0;
  for (const m of text.matchAll(COMMAND)) {
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
