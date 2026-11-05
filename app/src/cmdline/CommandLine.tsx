// The command line (`␣ :`): one input at the bottom, like vim's. Completion works as in a shell
// (ticket 34): the candidates for what's typed are listed under the line (the command table's
// `complete` hooks and the registries, so the Config's and Plugins' commands complete too); Tab
// first fills in what they all share, then Tab / Shift+Tab cycle through them; Ctrl+Y accepts the
// one in the line; Enter runs the line (or only accepts a command that still needs its argument);
// Esc cancels the completion, back to what was typed, and a second Esc closes. The keys are the
// keymap's `cmdline` context, so init.lua can rebind them. Each command candidate says what it
// does and its key (ticket 29 S8), so the command line is also where commands are discovered.
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { chordOf, defaultKeymap, type CmdlineAction, type KeyTable } from "../keymap";
import { prefixFill } from "../ui/completion";
import { formatCount } from "../ui/format";
import { Keys } from "../ui/Keys";

/** What a candidate does: its command's label, and the keys bound to it. */
export interface Candidate {
  label: string;
  keys: string | null;
}

/** Candidates listed at once; the window follows the selected one, and Tab reaches them all. */
const SHOWN = 8;

export interface CommandLineProps {
  /** Typed in already (a command asking for the rest, like `folder add esxi-02 `). */
  initial?: string;
  /** Where the cursor starts in `initial` (the end by default): back from help, where it was. */
  caret?: number;
  complete(input: string): string[];
  /** A command candidate's label and keys; null for an argument (a Host name). */
  describe?(candidate: string): Candidate | null;
  /** The keymap's `cmdline` context. */
  keys?: KeyTable<CmdlineAction>;
  /** The Leader chord, for the ␣ cap's tooltip. */
  leader?: string;
  onRun(line: string): void;
  onClose(): void;
  /** `cmdline.help` (Ctrl+], F1): help on the line's command, with the line and the cursor to
   * come back to. */
  onHelp?(line: string, caret: number): void;
}

/** While cycling: the candidates for what was typed, which one is in the line, and the typed text
 * Esc goes back to. */
interface Cycle {
  candidates: string[];
  index: number;
  typed: string;
}

export function CommandLine({ initial = "", caret, complete, describe, keys = defaultKeymap.cmdline, leader, onRun, onClose, onHelp }: CommandLineProps) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (caret !== undefined) inputRef.current?.setSelectionRange(caret, caret);
    // Only where the line starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [cycle, setCycle] = useState<Cycle | null>(null);
  const listId = useId();
  const candidates = useMemo(() => cycle?.candidates ?? complete(value), [cycle, complete, value]);
  // The row the line holds: the one Tab moved to, or the candidate the typed line already is
  // (round 18: no row was marked). Enter runs the line, so only a row equal to it is marked; the
  // first row isn't, since Enter wouldn't run it.
  const current = cycle?.index ?? candidates.findIndex((c) => c.trim() === value.trim() && value.trim() !== "");

  function step(by: 1 | -1) {
    if (cycle) {
      const n = cycle.candidates.length;
      const index = (cycle.index + by + n) % n;
      setCycle({ ...cycle, index });
      setValue(cycle.candidates[index] ?? value);
      return;
    }
    const list = complete(value);
    if (list.length === 0) return;
    const fill = by === 1 ? prefixFill(value, list) : null;
    if (fill !== null) return setValue(fill);
    const index = by === 1 ? 0 : list.length - 1;
    setCycle({ candidates: list, index, typed: value });
    setValue(list[index] ?? value);
  }

  function accept(line = value) {
    setValue(line);
    setCycle(null);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const action = keys[chordOf(e)]?.action;
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    switch (action) {
      case "cmdline.next":
        return step(1);
      case "cmdline.prev":
        return step(-1);
      case "cmdline.accept":
        return accept();
      case "cmdline.run":
        // A command that still needs its argument (`connect `) is accepted, not run.
        if (cycle && value.endsWith(" ")) return accept();
        return onRun(value);
      case "cmdline.cancel":
        if (cycle) return accept(cycle.typed);
        return onClose();
      case "cmdline.help":
        return onHelp?.(value, e.currentTarget.selectionStart ?? value.length);
    }
  }

  // The rows shown: the first SHOWN, the window moving down once the selection passes them.
  const start = Math.max(0, Math.min(current - SHOWN + 1, candidates.length - SHOWN));
  const shown = candidates.slice(start, start + SHOWN);
  const below = candidates.length - start - shown.length;
  const optionId = (i: number) => `${listId}-${i}`;

  return (
    <div className="cmdline">
      {candidates.length > 0 && (
        <div className="cmdline-candidates">
          <ul role="listbox" id={listId} aria-label="Completions">
            {shown.map((c, k) => {
              const i = start + k;
              const about = describe?.(c) ?? null;
              return (
                <li
                  key={c}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === current}
                  aria-setsize={candidates.length}
                  aria-posinset={i + 1}
                  className={i === current ? "selected" : undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => accept(c)}
                >
                  <span className="cmd-id">{c}</span>
                  {about && (
                    <span className="cmd-about">
                      <span className="visually-hidden">: </span>
                      <span className="cmd-label" title={about.label}>
                        {about.label}
                      </span>
                      {about.keys && <Keys keys={about.keys} leader={leader} className="cmd-keys" />}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {(start > 0 || below > 0) && (
            <p className="more" aria-hidden="true">
              {[start > 0 && `${formatCount(start)} above`, below > 0 && `+${formatCount(below)} more`].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
      )}
      <div className="cmdline-input">
        <span aria-hidden="true">:</span>
        <input
          ref={inputRef}
          role="combobox"
          aria-label="Command"
          aria-expanded={candidates.length > 0}
          aria-controls={listId}
          aria-activedescendant={current >= 0 ? optionId(current) : undefined}
          aria-autocomplete="list"
          autoFocus
          spellCheck={false}
          autoComplete="off"
          value={value}
          onChange={(e) => accept(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  );
}
