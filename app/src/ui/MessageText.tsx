// A message's text as the message line draws it (round 18): a command it names (":help commands",
// "(:help adding-hosts)") is something you'd type, so it's set in Iosevka (taste.md, the paste
// rule), as the empty state's command is. In a slip's plain sentence and an empty line, a file it
// names ("roster.yml", "init.lua") is data too, so it's Iosevka as well (round 19). The words around
// it stay Inter.
import { Fragment } from "react";

/** A command a message names: a colon at a word's start, the command, and at most one lowercase
 * argument (":edit HOST" marks only ":edit": HOST is a placeholder). A trailing "." or ":" is the
 * sentence's. */
const COMMAND = /(^|[\s(“"'])(:[a-z][a-z0-9-]*(?: [a-z0-9](?:[\w#.:/-]*[\w#/-])?)?)/g;

/** A file a message names by its name: roster.yml, init.lua, team.yaml (a trailing "." is the
 * sentence's). A place in one ("folders.yml:3") is left as the sentence has it. */
const FILE = /(^|[\s(“"'`])([\w-][\w.-]*\.(?:ya?ml|lua))(?![\w-]|:\d)/g;

export interface MessagePart {
  text: string;
  /** A command (":help commands"). */
  command: boolean;
  /** A file name ("roster.yml"). */
  file?: true;
}

/** `text` split into words and the commands it names (and with `files`, the files), in order. */
export function messageParts(text: string, files = false): MessagePart[] {
  const found = [
    ...[...text.matchAll(COMMAND)].map((m) => ({ m, file: false })),
    ...(files ? [...text.matchAll(FILE)].map((m) => ({ m, file: true })) : []),
  ]
    .map(({ m, file }) => ({ start: (m.index ?? 0) + (m[1]?.length ?? 0), text: m[2] ?? "", file }))
    .sort((a, b) => a.start - b.start);
  const parts: MessagePart[] = [];
  let at = 0;
  for (const f of found) {
    if (f.start < at) continue;
    if (f.start > at) parts.push({ text: text.slice(at, f.start), command: false });
    parts.push(f.file ? { text: f.text, command: false, file: true } : { text: f.text, command: true });
    at = f.start + f.text.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), command: false });
  return parts;
}

/** `files`: set the files it names in Iosevka too (a slip's sentence, round 19). */
export function MessageText({ text, files = false }: { text: string; files?: boolean }) {
  return (
    <>
      {messageParts(text, files).map((p, i) =>
        p.command || p.file ? (
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
