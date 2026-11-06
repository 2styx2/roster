// Keycaps: every key hint in the app is drawn by this, from the keymap's own notation (keymap.ts):
// chords separated by spaces ("␣ d d"), modifiers joined with "+" ("Ctrl+Shift+c"). "␣" is the
// Leader: it gets a cap with the space-bar glyph and the real chord as its tooltip, so it never
// reads as an underscore.
import { Fragment } from "react";
import { messageParts } from "./messageParts";
import "./keys.css";

const NAMES: Record<string, string> = {
  ArrowDown: "↓",
  ArrowUp: "↑",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  Enter: "↵",
  Backspace: "⌫",
  Space: "Space",
  Meta: "Win",
};

export const LEADER = "␣";

/** A chord's parts: "Ctrl+Shift+c" → ["Ctrl", "Shift", "c"]; "Ctrl++" → ["Ctrl", "+"]. */
export function chordParts(chord: string): string[] {
  if (chord.length <= 1) return [chord];
  const parts = chord.split("+");
  // A trailing "+" key splits into two empty strings.
  if (chord.endsWith("++")) return [...parts.slice(0, -2), "+"];
  return parts;
}

const SpaceGlyph = () => (
  <svg viewBox="0 0 12 8" width="11" height="8" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3">
    <path d="M1 2.5v3h10v-3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function Cap({ name, leader }: { name: string; leader?: string | undefined }) {
  if (name === LEADER) {
    return (
      <kbd className="keycap keycap-leader" title={leader ? `Leader (${leader})` : "Leader"}>
        <SpaceGlyph />
        {/* The glossary's word, so a hint reads "Find a Host, Leader f", not "open box f". */}
        <span className="visually-hidden">Leader</span>
      </kbd>
    );
  }
  return <kbd className="keycap">{NAMES[name] ?? name}</kbd>;
}

export interface KeysProps {
  /** A key sequence in keymap notation, "␣ f" or "Ctrl+Space". */
  keys: string;
  /** The Leader chord, for the ␣ cap's tooltip. */
  leader?: string | undefined;
  className?: string;
}

export function Keys({ keys, leader, className }: KeysProps) {
  const chords = keys.split(" ").filter(Boolean);
  return (
    <span className={`keys${className ? ` ${className}` : ""}`}>
      {chords.map((chord, i) => (
        <Fragment key={i}>
          {i > 0 && " "}
          <span className="chord">
            {chordParts(chord).map((p, j) => (
              <Fragment key={j}>
                {/* The "+" is for copying and screen readers; the caps show the chord. */}
                {j > 0 && <span className="visually-hidden">+</span>}
                <Cap name={p} leader={leader} />
              </Fragment>
            ))}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

/** Where the clause naming some keys starts in the text before them: after a sentence's end
 * (the clause is a sentence of its own), or at a ", " or " or " (the clause is the sentence's
 * tail). */
function clauseStart(before: string): { at: number; sentence: boolean } {
  let found: { at: number; sentence: boolean } = { at: 0, sentence: true };
  for (const m of before.matchAll(/\.\s+|,\s+|\s+or\s+/g)) {
    found = m[0].startsWith(".") ? { at: m.index + m[0].length, sentence: true } : { at: m.index, sentence: false };
  }
  return found;
}

/** Text with key sequences in backticks drawn as keycaps: "Drag a Host here, or `␣ a`". The
 * word before the keys stays on their line ("press ␣ a"), so a wrap never leaves keys alone.
 * The clause naming the keys is a `.key-hint`, so hiding the hints (`ui.hints = false`) leaves
 * whole sentences: "No Folders yet. Drag a Host here." */
/** Plain words with the files they name ("roster.yml") set as data, in Iosevka (round 19: the
 * Sidebar's "add them in roster.yml" set it in Inter while the pane set it in Iosevka). */
function withFiles(text: string, key: string): React.ReactNode {
  const parts = messageParts(text, true);
  if (!parts.some((p) => p.file)) return text;
  return (
    <Fragment key={key}>
      {parts.map((p, i) => (p.file ? <code key={i}>{p.text}</code> : <Fragment key={i}>{p.text}</Fragment>))}
    </Fragment>
  );
}

export function WithKeys({ text, leader }: { text: string; leader?: string | undefined }) {
  const parts = text.split("`");
  const out: React.ReactNode[] = [];
  // What's left of the current text part after an earlier hint took its start.
  let rest = parts[0] ?? "";
  for (let i = 1; i < parts.length; i += 2) {
    const keys = parts[i] ?? "";
    const { at, sentence } = clauseStart(rest);
    const lead = rest.slice(at);
    const word = lead.search(/\S+\s*$/);
    const after = parts[i + 1] ?? "";
    const dot = after.indexOf(".");
    // A sentence of its own takes its full stop with it; a tail leaves it to the sentence.
    const end = dot < 0 ? after.length : sentence ? dot + 1 : dot;
    out.push(withFiles(rest.slice(0, at), `t${i}`));
    out.push(
      <span key={i} className="key-hint">
        {word < 0 ? lead : lead.slice(0, word)}
        <span className="keys-with-word">
          {word < 0 ? "" : lead.slice(word)}
          <Keys keys={keys} leader={leader} />
        </span>
        {after.slice(0, end)}
      </span>,
    );
    rest = after.slice(end);
  }
  out.push(withFiles(rest, "end"));
  return <>{out}</>;
}
