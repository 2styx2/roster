// State nodes (ticket 29 M3, decision Q53, docs/app/design/taste.md): a Host's or Session's state
// drawn as a node whose shape carries it, so colour is never the only cue (WCAG 1.4.1), with the
// same state in words for assistive tech. Filled = key login, ring = password login, hollow grey
// = ended, dashed ring in the second tone = unreviewed (can't be opened; decision Q57), and an
// accent ring = connecting (issue #78). The colours are Theme tokens (styles.css): a node is
// muted at rest and takes the accent only when `lit`, its Host having a live or connecting Session
// (taste.md: the accent means live, decision Q185).

/** A row's state: key or password login, a Session that has ended, or a Host that can't be
 * opened (unreviewed). */
export type Dot = "key" | "password" | "ended" | "off" | "connecting";

const SHAPES: Record<Dot, string> = { key: "filled", password: "ring", ended: "hollow", off: "dashed", connecting: "ring" };

/** The state in words, for an accessible name ("password login"). */
export const DOT_WORDS: Record<Dot, string> = {
  key: "key login",
  password: "password login",
  ended: "ended",
  off: "unreviewed, can't be opened",
  connecting: "connecting",
};

/** How a node is lit (taste.md: the accent means live, decision Q185): `current` is the Session on
 * screen (or its Host), in the accent; `live` is another Session that's connected, in the text
 * colour; unlit nodes are muted. */
export type Light = "current" | "live";

export function StateDot({ dot, lit }: { dot: Dot; lit?: Light | false | undefined }) {
  return (
    <svg className={`dot ${dot}${lit === "current" ? " lit" : lit === "live" ? " on" : ""}`} data-shape={SHAPES[dot]} viewBox="0 0 8 8" width="8" height="8" aria-hidden="true">
      <circle cx="4" cy="4" r="3.25" />
    </svg>
  );
}
