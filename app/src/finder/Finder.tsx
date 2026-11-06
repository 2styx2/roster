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
  layOutHosts(list);
}

/** Where a Host row's address starts (round 22): the Picker's name column, one x for the whole
 * list, the widest name in view (CSS caps it at 45% of the row; a longer name is cut there, whole
 * in its tooltip). Round 21 put the address one tab stop past each name, so with names of unlike
 * lengths (the worst case) the address and group started at nine x positions and a long name cut
 * the group to "Fo…". The address is a column as wide as the list's widest, so the group after it
 * starts at one x too (name · address · group · type, the Picker's order), and the type is one as
 * wide as the widest, so every group ends at one x. Sets --finder-host-w, --finder-addr-w and
 * --finder-type-w on the list. */
export function layOutHosts(list: HTMLElement) {
  const bottom = list.getBoundingClientRect().bottom;
  let inView = 0;
  let all = 0;
  let addr = 0;
  let type = 0;
  for (const row of list.querySelectorAll<HTMLElement>(".finder-row.host-row")) {
    let name = 0;
    for (const part of row.querySelector(".finder-label")?.children ?? []) name += (part as HTMLElement).scrollWidth;
    all = Math.max(all, name);
    // In view (jsdom has no layout: every row is); with none in view, the whole list counts.
    if (list.clientHeight === 0 || row.getBoundingClientRect().top < bottom) inView = Math.max(inView, name);
    addr = Math.max(addr, row.querySelector<HTMLElement>(":scope > .finder-addr")?.scrollWidth ?? 0);
    type = Math.max(type, row.querySelector<HTMLElement>(":scope > .finder-type")?.scrollWidth ?? 0);
  }
  list.style.setProperty("--finder-host-w", `${Math.ceil(inView || all)}px`);
  list.style.setProperty("--finder-addr-w", `${Math.ceil(addr)}px`);
  list.style.setProperty("--finder-type-w", `${Math.ceil(type)}px`);
  // Each Host row's path in the longest of its forms that fits (pathForms).
  for (const path of list.querySelectorAll<HTMLElement>(".finder-row.host-row > .finder-path")) {
    const forms = [...path.querySelectorAll<HTMLElement>(":scope > .finder-cut")];
    forms.forEach((f, i) => (i === 0 ? f.removeAttribute("data-off") : f.setAttribute("data-off", "")));
    // No layout (jsdom), or it fits whole: the whole path.
    if (path.clientWidth === 0) continue;
    for (let i = 1; i < forms.length && path.scrollWidth > path.clientWidth + 1; i++) {
      forms[i - 1]?.setAttribute("data-off", "");
      forms[i]?.removeAttribute("data-off");
    }
  }
}

/** A Host's place in the tree, cut from the front (round 22: an end cut left "Folders › Buil…",
 * which says nothing): the whole path, then its first parts given way one by one for "… › ", down
 * to "… › LAST", then the last part alone (the "… › " is room its own name needs more), which CSS
 * cuts at its end only if even that doesn't fit. The tooltip has it whole. */
export function pathForms(path: string): string[] {
  const parts = path.split(" › ");
  if (parts.length < 2) return [path];
  return [path, ...parts.slice(1).map((_, i) => `… › ${parts.slice(i + 1).join(" › ")}`), parts[parts.length - 1] as string];
}

/** Where a prose finder's middle column starts (round 19): one x for the whole list, the widest
 * title among the rows in view, so every page or section starts at the same place (round 18's
 * per-row tab stops put it at three to eight places once a query mixed titles). Round 22: no tag
 * column follows it any more (the footer names the selected row's `:help TAG`), so a title may
 * take everything but the widest page in view (CSS: never less than half the row), where round 20
 * capped it at 42% and cut descriptions beside empty room; a title past that is cut, whole in its
 * tooltip. Sets --finder-title-w and --finder-page-w on the list. */
export function layOutTitles(list: HTMLElement) {
  const bottom = list.getBoundingClientRect().bottom;
  const widest = { title: 0, page: 0 };
  const all = { title: 0, page: 0 };
  for (const row of list.querySelectorAll<HTMLElement>(".finder-row")) {
    const path = row.querySelector<HTMLElement>(":scope > .finder-path");
    if (!path) continue;
    let name = 0;
    for (const part of row.querySelector(".finder-label")?.children ?? []) name += (part as HTMLElement).scrollWidth;
    all.title = Math.max(all.title, name);
    all.page = Math.max(all.page, path.scrollWidth);
    // In view (jsdom has no layout: every row is); with none in view, the whole list counts.
    if (list.clientHeight === 0 || row.getBoundingClientRect().top < bottom) {
      widest.title = Math.max(widest.title, name);
      widest.page = Math.max(widest.page, path.scrollWidth);
    }
  }
  const use = widest.title ? widest : all;
  list.style.setProperty("--finder-title-w", `${Math.ceil(use.title)}px`);
  list.style.setProperty("--finder-page-w", `${Math.ceil(use.page)}px`);
}

/** Whether the footer's `:help TAG` (`code` in its `box`) fits whole on the box's one line
 * (round 23: broken after its `#` at 480 px, both halves were still cut and the footer grew to
 * 47 px). Measured fractionally: the tag is drawn whole or not at all, never cut. */
export function tagFits(box: Element, code: Element): boolean {
  return code.getBoundingClientRect().width <= box.getBoundingClientRect().width + 0.05;
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
    if (!list) return;
    const lay = () => (source.prose ? layOutTitles : layOutNames)(list);
    lay();
    // The window's width changes what fits (a tag drawn or dropped): lay out again.
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(lay);
    resize?.observe(list);
    return () => resize?.disconnect();
  }, [shown, fontsReady, source.prose]);


  // The selected row's `:help TAG` in the footer: whole on its one line, or not drawn (its row's
  // tooltip names it too). Measured again as the selection, the fonts or the width change.
  const tagRef = useRef<HTMLSpanElement>(null);
  const tagCommand = source.prose && selectedItem?.detail ? selectedItem.command : null;
  useLayoutEffect(() => {
    const box = tagRef.current;
    const code = box?.firstElementChild;
    if (!box || !code) return;
    const fit = () => {
      if (tagFits(box, code)) delete box.dataset.cut;
      else box.dataset.cut = "";
    };
    fit();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    resize?.observe(box);
    return () => resize?.disconnect();
  }, [tagCommand, fontsReady]);

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
          {shown.map((item, i) => [
            // A group's quiet heading over its first row (help's pages under the index's parts).
            item.group !== undefined && item.group !== shown[i - 1]?.group && (
              <li key={`group:${item.group}`} role="presentation" className="finder-group">
                {item.group}
              </li>
            ),
            <li
              key={item.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === current}
              aria-disabled={item.disabled ? true : undefined}
              data-label={item.label}
              data-index={i}
              className={`finder-row${i === current ? " selected" : ""}${item.disabled ? " unreviewed" : ""}${item.host !== undefined ? " host-row" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => i !== current && setMoved(i)}
              onClick={() => choose(item)}
            >
              {item.dot && <StateDot dot={item.dot} lit={item.lit} {...(item.stub === false ? { stub: false } : {})} />}
              <span
                className="finder-label"
                // A help row names its `:help TAG` too: the footer drops it when it can't be whole.
                title={`${item.note ? `${item.label} · ${item.note}` : item.label}${source.prose && item.detail ? `\n:${item.command}` : ""}`}
              >
                <span className={`finder-name${source.prose && (item.dataLabel || DATA_NAME.test(item.label)) ? " data" : ""}`} dir="auto">
                  {marked(item.label, query, source.prose)}
                </span>
                {item.note && (
                  // What the entry is, after its name (round 20): the middle column stays its page.
                  <span className="finder-note" dir="auto">
                    {" · "}
                    {source.prose ? withData(item.note, item.noteData) : item.note}
                  </span>
                )}
                {item.mark && (
                  <>
                    <span className="finder-mark" aria-hidden="true">
                      {MARKS[item.mark]}
                    </span>
                    <span className="visually-hidden">, {item.mark}</span>
                  </>
                )}
              </span>
              {/* A Host's address comes before its group and type, as in the Picker (round 21). */}
              {/* Drawn with no address too, empty, so the group after it keeps its column. */}
              {item.host !== undefined && (
                <span className="finder-detail finder-addr" title={item.detail || undefined}>
                  {item.detail}
                </span>
              )}
              {item.path && item.host !== undefined && (
                <span className="finder-path" title={item.path} dir="auto">
                  {pathForms(item.path).map((form, i) => (
                    <span key={form} className="finder-cut" data-off={i === 0 ? undefined : ""}>
                      {form}
                    </span>
                  ))}
                </span>
              )}
              {item.path && item.host === undefined && (
                <span
                  className={`finder-path${source.prose && DATA_NAME.test(item.path) ? " data" : ""}`}
                  title={item.path}
                  dir="auto"
                >
                  {item.path}
                </span>
              )}
              {/* A Host row draws its type cell empty too, so every path ends at one x. */}
              {(item.type || item.host !== undefined) && (
                <span className="finder-type" title={item.type || undefined}>
                  {item.type}
                </span>
              )}
              {/* A help topic's tag isn't drawn on its row (round 22: dropped whenever its title was
                  cut, it flickered on and off down the list); the footer names the selected row's,
                  and the query still matches it. */}
              {item.host === undefined && item.detail && !source.prose && (
                <span className="finder-detail" title={item.detail}>
                  {item.detail}
                </span>
              )}
            </li>,
          ])}
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
            {/* What was typed is data: Iosevka, no quote marks (round 19). */}
            {query ? (
              <>
                Nothing matches <span className="data">{query.trim()}</span>.
              </>
            ) : (
              (source.empty ?? "Nothing here yet.")
            )}
          </p>
        )}
        <div className="picker-footer">
          <span
            role="status"
            title={notice || source.note?.(shown[current]) || undefined}
          >
            {notice || source.note?.(shown[current])}
          </span>
          {/* The selected row's tag, which no row draws (round 22): what Enter runs, ":help TAG"
              (round 21), as the Picker names a cut Host. */}
          {source.prose && selectedItem?.detail && (
            <span className="finder-foot-tag" ref={tagRef} title={`:${selectedItem.command}`}>
              <code>:{selectedItem.command}</code>
            </span>
          )}
          {shown.some((i) => i.mark) && (
            <span className="finder-legend" aria-hidden="true">
              * current · - previous
            </span>
          )}
          <span className="picker-count" aria-hidden="true">
            {footerCount(
              results.items.length,
              shown.length,
              query,
              typeof source.noun === "function" ? source.noun(results.items) : source.noun,
            )}
          </span>
          {shown.length > 1 && (
            <span className="picker-hint key-hint" data-what="move">
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
