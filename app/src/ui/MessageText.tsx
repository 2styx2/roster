// A message's text as the message line draws it (round 18): a command it names (":help commands",
// "(:help adding-hosts)") is something you'd type, so it's set in Iosevka (taste.md, the paste
// rule), as the empty state's command is. In a slip's plain sentence and an empty line, a file it
// names ("roster.yml", "init.lua") is data too, so it's Iosevka as well (round 19). The words around
// it stay Inter. Keys it names ("Open one with ␣ f.") are keycaps, as every other key hint is
// (round 21: "␣" in Inter read as an underscore); `:messages` keeps the text.
import { Fragment } from "react";
import { Keys } from "./Keys";
import { messageParts } from "./messageParts";

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
