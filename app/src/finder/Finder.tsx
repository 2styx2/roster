// The Finder (ticket 22): a Telescope-style fuzzy finder over one finder source (sources.ts),
// as an overlay over the terminal. Typing goes to the query; the Picker's keys move (arrows,
// Ctrl+N/P, then j/k with vim on once you've moved, and Tab / Shift+Tab, Tab first filling the
// query with what the matching labels share, ticket 34); Enter or a click runs the item's command
// line, Esc closes. It's the same in every view mode; Focus leans on it to reach what the Sidebar
// shows in Standard (decision Q36).
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { chordOf, type Keymap } from "../keymap";
import { finderResults, type FinderContext, type FinderItem, type FinderSourceDef } from "./sources";
import { prefixFill } from "../ui/completion";
import { Announce } from "../ui/Announce";
import { countOf, formatCount } from "../ui/format";
import { Keys } from "../ui/Keys";
import { StateDot } from "../ui/StateDot";

/** Rows actually rendered; the rest are counted. */
const MAX_ROWS = 200;

// The session bar's tmux marks (decision Q36), with their words for assistive tech and a legend.
const MARKS = { current: "*", previous: "-" } as const;

export interface FinderProps {
  source: FinderSourceDef;
  ctx: FinderContext;
  keymap: Keymap;
  vim: boolean;
  /** What the query starts as (`:helpgrep TEXT`). */
  initialQuery?: string;
  onChoose(item: FinderItem): void;
  onClose(): void;
  /** `picker.help` (F1): help on the selected item (ticket 52). */
  onHelp?(item: FinderItem): void;
}

export function Finder({ source, ctx, keymap, vim, initialQuery = "", onChoose, onClose, onHelp }: FinderProps) {
  const [query, setQuery] = useState(initialQuery);
  const [moved, setMoved] = useState<number | null>(null);
  const [inList, setInList] = useState(false);
  const [notice, setNotice] = useState("");
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo(() => finderResults(source, ctx, query), [source, ctx, query]);
  const shown = results.items.slice(0, MAX_ROWS);
  const current = Math.max(0, Math.min(moved ?? results.selected, shown.length - 1));

  // A source may preview the selected item (the `themes` finder), and undo it when the Finder
  // closes, however it closes.
  const selectedItem = shown[current];
  useEffect(() => source.move?.(selectedItem), [source, selectedItem]);
  useEffect(() => () => source.close?.(), [source]);
  // Once per opening (the Finder is keyed by the source's id), not each time it registers again.
  const opened = useRef(source.open);
  useEffect(() => opened.current?.(), []);

  useLayoutEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${current}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  function choose(item: FinderItem | undefined) {
    if (!item) return;
    if (item.disabled) return setNotice(item.disabled);
    onChoose(item);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const chord = chordOf(e);
    const action = (keymap.picker[chord] ?? (vim && inList ? keymap.pickerVim[chord] : undefined))?.action;
    if (!action) {
      if (chord.length === 1 || chord === "Backspace") setInList(false);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    switch (action) {
      case "picker.down":
        setMoved(Math.min(current + 1, shown.length - 1));
        setInList(true);
        break;
      case "picker.up":
        setMoved(Math.max(current - 1, 0));
        setInList(true);
        break;
      case "picker.next":
      case "picker.prev": {
        const fill = action === "picker.next" && !inList ? prefixFill(query, shown.map((i) => i.label)) : null;
        if (fill !== null) {
          setQuery(fill);
          setMoved(null);
          setNotice("");
          break;
        }
        if (shown.length === 0) break;
        setMoved((current + (action === "picker.next" ? 1 : -1) + shown.length) % shown.length);
        setInList(true);
        break;
      }
      case "picker.choose":
      case "picker.chooseHere":
        choose(shown[current]);
        break;
      case "picker.close":
        onClose();
        break;
      case "picker.help": {
        const item = shown[current];
        if (item) onHelp?.(item);
        break;
      }
    }
  }

  const activeId = shown[current] ? `${listId}-${current}` : undefined;

  return (
    <div className="picker-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`picker finder${source.prose ? " prose" : ""}`} role="dialog" aria-label={source.title}>
        <div className="finder-query">
          <span className="finder-prompt">{source.prompt} ›</span>
          <input
            role="combobox"
            aria-label={source.title}
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            autoFocus
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setMoved(null);
              setNotice("");
            }}
            onKeyDown={onKeyDown}
          />
          <span className="finder-count" aria-hidden="true">
            {results.items.length > shown.length
              ? `${formatCount(shown.length)} of ${formatCount(results.items.length)}`
              : formatCount(results.items.length)}
          </span>
        </div>
        <ul className="picker-list" role="listbox" id={listId} ref={listRef} aria-label={source.prompt}>
          {shown.map((item, i) => (
            <li
              key={item.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === current}
              aria-disabled={item.disabled ? true : undefined}
              data-label={item.label}
              data-index={i}
              className={`finder-row${i === current ? " selected" : ""}${item.disabled ? " unreviewed" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => i !== current && setMoved(i)}
              onClick={() => choose(item)}
            >
              {item.dot && <StateDot dot={item.dot} />}
              <span className="finder-label" title={item.label}>
                <span className="finder-name" dir="auto">
                  {item.label}
                </span>
                {item.mark && (
                  <>
                    <span className="finder-mark" aria-hidden="true">
                      {MARKS[item.mark]}
                    </span>
                    <span className="visually-hidden">, {item.mark}</span>
                  </>
                )}
              </span>
              {item.path && (
                <span className="finder-path" title={item.path}>
                  {item.path}
                </span>
              )}
              {item.detail && <span className="finder-detail">{item.detail}</span>}
            </li>
          ))}
        </ul>
        {/* How many results the query left, said once typing pauses (the count above is only seen). */}
        <Announce text={results.items.length ? countOf(results.items.length, "result") : query ? "No matches" : ""} />
        {shown.length === 0 && <p className="picker-empty">{query ? `Nothing matches “${query}”.` : (source.empty ?? "Nothing here yet.")}</p>}
        <div className="picker-footer">
          <span role="status" title={notice || source.note?.(shown[current]) || undefined}>
            {notice || source.note?.(shown[current])}
          </span>
          {shown.some((i) => i.mark) && (
            <span className="finder-legend" aria-hidden="true">
              * current · - previous
            </span>
          )}
          <span className="picker-hint key-hint">
            <Keys keys="Enter" /> choose
          </span>
          <span className="picker-hint key-hint">
            <Keys keys="Escape" /> close
          </span>
        </div>
      </div>
    </div>
  );
}
