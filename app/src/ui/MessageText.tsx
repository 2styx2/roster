// A message's text as the message line draws it (round 18): a command it names (":help commands",
// "(:help adding-hosts)") is something you'd type, so it's set in Iosevka (taste.md, the paste
// rule), as the empty state's command is. In a slip's plain sentence and an empty line, a file it
// names ("roster.yml", "init.lua") is data too, so it's Iosevka as well (round 19). The words around
// it stay Inter. Keys it names ("Open one with ␣ f.") are keycaps, as every other key hint is
// (round 21: "␣" in Inter read as an underscore); `:messages` keeps the text.
import { Fragment } from "react";
import { Keys } from "./Keys";

/** A command a message names: a colon at a word's start, the command, and at most one lowercase
 * argument (":edit HOST" marks only ":edit": HOST is a placeholder). A trailing "." or ":" is the
 * sentence's. */
const COMMAND = /(^|[\s(“"'])(:[a-z][a-z0-9-]*(?: [a-z0-9](?:[\w#.:/-]*[\w#/-])?)?)/g;

/** A file a message names by its name: roster.yml, init.lua, team.yaml (a trailing "." is the
 * sentence's). A place in one ("folders.yml:3") is left as the sentence has it. */
const FILE = /(^|[\s(“"'`])([\w-][\w.-]*\.(?:ya?ml|lua))(?![\w-]|:\d)/g;

/** A roster.yml setting a message names with its value ("reviewed: true"): data, like the file
 * it goes in (round 21: it was set in Inter beside an Iosevka roster.yml). Only a yes/no value, so
 * a sentence's "Note: true…" can't be taken for one. */
const SETTING = /(^|[\s(“"'])([a-z][a-z_]*: (?:true|false))(?![\w-])/g;

/** What was typed, quoted back by a slip ("Not a command: blah.", "No help for zzqxj."): data
 * too (round 19), set in Iosevka with no quote marks. The word runs to the sentence's end. */
const TYPED = /(^|[\s(])((?<=(?:Not a command:|No help for) )[^\s]+?)(?=[.,]?(?:\s|$))/g;

/** Keys a message names, as the keymap writes them: the Leader "␣" and one or more keys after it,
 * each one character, a chord ("Ctrl+x") or a function key ("␣ f", "␣ d d"). A trailing "." is
 * the sentence's. */
const KEYS = /(^|[\s(])(␣(?: (?:(?:Ctrl|Alt|Shift|Meta)\+\S+?|F\d{1,2}|[^\s]))+)(?=[.,;:)]?(?:\s|$))/gu;

export interface MessagePart {
  text: string;
  /** Set in Iosevka as something you'd type: a command (":help commands") or what was typed. */
  command: boolean;
  /** A file name ("roster.yml"), or a setting in one ("reviewed: true"). */
  file?: true;
  /** Keys, in the keymap's notation ("␣ f"): drawn as keycaps. */
  keys?: true;
}

/** `text` split into words, the commands it names and what it quotes back as typed (and with
 * `files`, the files), in order. */
export function messageParts(text: string, files = false): MessagePart[] {
  const found = [
    ...[...text.matchAll(KEYS)].map((m) => ({ m, file: false, keys: true })),
    ...[...text.matchAll(COMMAND)].map((m) => ({ m, file: false, keys: false })),
    ...[...text.matchAll(TYPED)].map((m) => ({ m, file: false, keys: false })),
    ...(files ? [...text.matchAll(FILE)].map((m) => ({ m, file: true, keys: false })) : []),
    ...(files ? [...text.matchAll(SETTING)].map((m) => ({ m, file: true, keys: false })) : []),
  ]
    .map(({ m, file, keys }) => ({ start: (m.index ?? 0) + (m[1]?.length ?? 0), text: m[2] ?? "", file, keys }))
    .sort((a, b) => a.start - b.start);
  const parts: MessagePart[] = [];
  let at = 0;
  for (const f of found) {
    if (f.start < at) continue;
    if (f.start > at) parts.push({ text: text.slice(at, f.start), command: false });
    parts.push(
      f.keys
        ? { text: f.text, command: false, keys: true }
        : f.file
          ? { text: f.text, command: false, file: true }
          : { text: f.text, command: true },
    );
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
        p.keys ? (
          <Keys key={i} keys={p.text} className="message-keys" />
        ) : p.command || p.file ? (
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
