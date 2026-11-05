// The Finder (ticket 22): a Telescope-style fuzzy finder over one finder source (sources.ts),
// as an overlay over the terminal. Typing goes to the query; the Picker's keys move (arrows,
// Ctrl+N/P, then j/k with vim on once you've moved, and Tab / Shift+Tab, Tab first filling the
// query with what the matching labels share, ticket 34); Enter or a click runs the item's command
// line, Esc closes. It's the same in every view mode; Focus leans on it to reach what the Sidebar
// shows in Standard (decision Q36).
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { chordOf, type Keymap } from "../keymap";
import {
  finderResults,
  type FinderContext,
  type FinderItem,
  type FinderSourceDef,
} from "./sources";
import { prefixFill } from "../ui/completion";
import { Announce } from "../ui/Announce";
import { countOf, formatCount } from "../ui/format";
import { Keys } from "../ui/Keys";
import { marked } from "../picker/Picker";
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

/** A label that is data, not prose (an option such as keys.picker, a tag): set in Iosevka. */
const DATA_NAME = /^[\w-]*[.:#/_][\w.:#/-]*$/;

/** The footer's count: before a query, how many there are ("1,360 topics"); once a query narrows
 * them, how many it left ("200 of 1,322 results" when only the first 200 are listed). */
export function footerCount(total: number, shown: number, query: string, noun?: string): string {
  if (total === 0) return "";
  if (query.trim() === "" && noun) return countOf(total, noun);
  return total > shown ? `${formatCount(shown)} of ${countOf(total, "result")}` : countOf(total, "result");
}

/** Where each row's path starts (round 18): at the first tab stop past its name, the stops 8ch
 * apart as a terminal's are, so names of a like length line up their paths at one x (the tree's
 * Hosts all at one stop) and a short name ("E31") never leaves a wide empty column beside a cut
 * description, as round 17's shared grid column did. Sets --finder-name-basis on each row; the
 * name's box still gives that room back (CSS) before its path would be cut. */
export function layOutNames(list: HTMLElement) {
  const rows = [...list.querySelectorAll<HTMLElement>(".finder-row")];
  const first = rows[0];
  if (!first) return;
  const style = getComputedStyle(first);
  // Iosevka's advance is half an em, so 8ch is 4em of the row's font.
  const stop = 4 * (parseFloat(style.fontSize) || 16);
  const gap = parseFloat(style.columnGap) || 0;
  const names = rows.map((row) => {
    let name = 0;
    for (const part of row.querySelector(".finder-label")?.children ?? []) name += (part as HTMLElement).scrollWidth;
    return name;
  });
  rows.forEach((row, i) => {
    const at = Math.ceil(((names[i] ?? 0) + gap) / stop) * stop;
    row.style.setProperty("--finder-name-basis", `${at - gap}px`);
  });
}

/** Where a prose finder's middle column starts (round 19): one x for the whole list, the widest
 * title among the rows in view (CSS caps it at 42% of the row, and a title past it is cut, whole
 * in its tooltip), so every description starts at the same place. Round 18's per-row tab stops
 * put it at three to eight places once a query mixed titles. Sets --finder-title-w on the list. */
export function layOutTitles(list: HTMLElement) {
  const bottom = list.getBoundingClientRect().bottom;
  let inView = 0;
  let all = 0;
  for (const row of list.querySelectorAll<HTMLElement>(".finder-row")) {
    if (!row.querySelector(":scope > .finder-path")) continue;
    let name = 0;
    for (const part of row.querySelector(".finder-label")?.children ?? []) name += (part as HTMLElement).scrollWidth;
    all = Math.max(all, name);
    // In view (jsdom has no layout: every row is); with none in view, the whole list counts.
    if (list.clientHeight === 0 || row.getBoundingClientRect().top < bottom) inView = Math.max(inView, name);
  }
  list.style.setProperty("--finder-title-w", `${Math.ceil(inView || all)}px`);
}

/** `text` with each of `codes` (in order, each where it's next found) in an Iosevka span. */
export function withData(text: string, codes: readonly string[] | undefined): ReactNode {
  if (!codes?.length) return text;
  const out: ReactNode[] = [];
  let at = 0;
  for (const code of codes) {
    const i = code ? text.indexOf(code, at) : -1;
    if (i < 0) continue;
    if (i > at) out.push(text.slice(at, i));
    out.push(<span key={i} className="data">{code}</span>);
    at = i + code.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

export function Finder({
  source,
  ctx,
  keymap,
  vim,
  initialQuery = "",
  onChoose,
  onClose,
  onHelp,
}: FinderProps) {
  const [query, setQuery] = useState(initialQuery);
  const [moved, setMoved] = useState<number | null>(null);
  const [inList, setInList] = useState(false);
  const [notice, setNotice] = useState("");
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);

  // A source's own news (`subscribe`), counted, so its matches are asked for again.
  const [changes, setChanges] = useState(0);
  useEffect(() => source.subscribe?.(() => setChanges((n) => n + 1)), [source]);
  const results = useMemo(() => {
    void changes;
    return finderResults(source, ctx, query);
  }, [source, ctx, query, changes]);
  const shown = results.items.slice(0, MAX_ROWS);
  const current = Math.max(
    0,
    Math.min(moved ?? results.selected, shown.length - 1),
  );

  // A source may preview the selected item (the `themes` finder), and undo it when the Finder
  // closes, however it closes.
  const selectedItem = shown[current];
  useEffect(() => source.move?.(selectedItem), [source, selectedItem]);
  useEffect(() => () => source.close?.(), [source]);
  // Once per opening (the Finder is keyed by the source's id), not each time it registers again.
  const opened = useRef(source.open);
  useEffect(() => opened.current?.(), []);

  useLayoutEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${current}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  // The tab stops (round 18, layOutNames), measured again once the fonts have loaded.
  const [fontsReady, setFontsReady] = useState(0);
  useEffect(() => {
    let live = true;
    void document.fonts?.ready.then(() => live && setFontsReady((n) => n + 1));
    return () => {
      live = false;
    };
  }, []);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list) (source.prose ? layOutTitles : layOutNames)(list);
  }, [shown, fontsReady, source.prose]);


  function choose(item: FinderItem | undefined) {
    if (!item) return;
    if (item.disabled) return setNotice(item.disabled);
    onChoose(item);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const chord = chordOf(e);
    const action = (
      keymap.picker[chord] ??
      (vim && inList ? keymap.pickerVim[chord] : undefined)
    )?.action;
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
        const fill =
          action === "picker.next" && !inList
            ? prefixFill(
                query,
                shown.map((i) => i.label),
              )
            : null;
        if (fill !== null) {
          setQuery(fill);
          setMoved(null);
          setNotice("");
          break;
        }
        if (shown.length === 0) break;
        setMoved(
          (current + (action === "picker.next" ? 1 : -1) + shown.length) %
            shown.length,
        );
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
    <div
      className="picker-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className={`picker finder${source.prose ? " prose" : ""}`}
        role="dialog"
        aria-label={source.title}
      >
        {/* The Picker's sibling (round 16): its search line, placeholder, row and footer. */}
        <div className="picker-search">
          <svg
            className="picker-search-icon"
            viewBox="0 0 16 16"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            aria-hidden="true"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" strokeLinecap="round" />
          </svg>
          <input
            className="picker-query finder-input"
            placeholder={source.title}
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
        </div>
        <ul
          className="picker-list finder-list"
          role="listbox"
          id={listId}
          ref={listRef}
          aria-label={source.prompt}
        >
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
              {item.dot && <StateDot dot={item.dot} lit={item.lit} />}
              <span className="finder-label" title={item.label}>
                <span className={`finder-name${source.prose && (item.dataLabel || DATA_NAME.test(item.label)) ? " data" : ""}`} dir="auto">
                  {marked(item.label, query, source.prose)}
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
                <span
                  className={`finder-path${source.prose && DATA_NAME.test(item.path) ? " data" : ""}`}
                  title={item.path}
                  dir="auto"
                >
                  {source.prose ? withData(item.path, item.pathData) : item.path}
                </span>
              )}
              {item.detail && (
                <span className="finder-detail" title={item.detail}>
                  {item.detail}
                </span>
              )}
            </li>
          ))}
        </ul>
        {/* How many results the query left, said once typing pauses (the count above is only seen). */}
        <Announce
          text={
            results.items.length
              ? countOf(results.items.length, "result")
              : query
                ? "No matches"
                : ""
          }
        />
        {shown.length === 0 && (
          <p className="picker-empty">
            {query
              ? `Nothing matches “${query}”.`
              : (source.empty ?? "Nothing here yet.")}
          </p>
        )}
        <div className="picker-footer">
          <span
            role="status"
            title={notice || source.note?.(shown[current]) || undefined}
          >
            {notice || source.note?.(shown[current])}
          </span>
          {shown.some((i) => i.mark) && (
            <span className="finder-legend" aria-hidden="true">
              * current · - previous
            </span>
          )}
          <span className="picker-count" aria-hidden="true">
            {footerCount(results.items.length, shown.length, query, source.noun)}
          </span>
          {shown.length > 1 && (
            <span className="picker-hint key-hint">
              <Keys keys="ArrowUp ArrowDown" />{" "}
              <span className="picker-hint-word">move</span>
            </span>
          )}
          {shown.length > 0 && (
            <span className="picker-hint key-hint">
              <Keys keys="Enter" />{" "}
              <span className="picker-hint-word">choose</span>
            </span>
          )}
          <span className="picker-hint key-hint">
            <Keys keys="Escape" />{" "}
            <span className="picker-hint-word">close</span>
          </span>
        </div>
      </div>
    </div>
  );
}
