// The Picker (GLOSSARY): fuzzy search over the Inventory's Hosts. Typing goes to the query.
// Arrows and Ctrl+N/P move; once you've moved, j/k move too (vim on) until you type anything
// else. Tab and Shift+Tab move too, wrapping (ticket 34); before you've moved, Tab first fills the
// query with what the matching names share, as a shell does. Enter or a click opens the selected Host, Esc closes. Unreviewed Hosts are listed but
// marked and never opened (spec story 14).
import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { Host, HostList } from "../backend/types";
import {
  chordOf,
  defaultKeymap,
  type Keymap,
  type KeyTable,
  type PickerAction,
} from "../keymap";
import { Announce } from "../ui/Announce";
import { addressCut, countOf, fitMiddle, formatCount } from "../ui/format";
import { Keys } from "../ui/Keys";
import { ToolbarIconSvg } from "../chrome/toolbar";
import { prefixFill } from "../ui/completion";
import { searchHosts } from "./match";
import {
  formatQuickTarget,
  parseQuickTarget,
  type QuickTarget,
} from "../quick/target";
import { hostDot } from "../sidebar/sections";
import { StateDot, type Light } from "../ui/StateDot";

/** Fixes a list's minimum height at its height now (a DOM write, kept out of the component). */
function holdHeight(list: HTMLElement | null) {
  // On the Picker, so the list or, with no match, its message keeps that room (styles.css).
  list?.parentElement?.style.setProperty("--list-h", `${list.offsetHeight}px`);
}

/** Marks the detail strip `data-cut` when a cell of the selected row is cut off, so the strip
 * shows the Host whole only when the row can't (a DOM write, kept out of the component). */
function markCut(list: HTMLElement | null, strip: HTMLElement | null) {
  if (!strip) return;
  const cells =
    list?.querySelectorAll<HTMLElement>(".picker-row.selected .host-name") ??
    [];
  const cut = [...cells].some((c) => c.scrollWidth > c.clientWidth + 1);
  if (cut) strip.dataset.cut = "";
  else delete strip.dataset.cut;
}

/** An address column's most characters; a longer address (IPv6) drops groups from its middle. */
const IP_CHARS = 17;

/** An i in a ring: a Host's details (ticket 18). */
export const InfoGlyph = () => (
  <svg
    viewBox="0 0 16 16"
    width="12"
    height="12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.3"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 7.25v3.5M8 5.25v.01" />
  </svg>
);

/** Rows actually rendered; the rest are counted. Keeps every keystroke cheap. */
const MAX_ROWS = 200;

export interface PickerProps {
  hosts: HostList;
  /** Host names, most recently used first. */
  recent: readonly string[];
  vim: boolean;
  keymap?: Keymap;
  /** `here`: open it in the current tab if that tab's Session has ended (else a new tab). */
  onOpen: (host: Host, how?: { here: true }) => void;
  /** Marks an unreviewed Host reviewed (`:review`, ticket 11); without it the Picker only says why
   * the Host can't be opened. */
  onReview?: (host: Host) => void;
  onClose: () => void;
  /** Quick Connect (ticket 14): a query that reads as user@address[:port] is offered first, and
   * choosing it calls this. Left out (a roster without it), the Picker only finds Hosts. */
  onQuick?: (to: QuickTarget) => void;
  /** Opened for Quick Connect (the toolbar's control): the field says what to type. */
  quickFirst?: boolean;
  /** Shows the Host's details (ticket 18): a row's info control, or Ctrl+I. */
  onInfo?: (host: Host) => void;
  /** `picker.help` (F1): help on the selected row, a topic (ticket 52). */
  onHelp?: (topic: string) => void;
  /** How each Host with a Session stands (sidebar/sections.ts `hostLights`): its node is drawn as
   * in the Sidebar (taste.md: the accent means live). */
  live?: ReadonlyMap<string, Light | "connecting">;
  /** Nine or more Sessions are open: as in the Sidebar, only the on-screen Host's node keeps its
   * edge stub, so stubs stay a signal, not a texture (Q219 a, extended to the Picker by Q235). */
  manySessions?: boolean;
  /** Add a Host (`:host add`), offered when nothing matches; left out on a roster that can't. */
  onAdd?: () => void;
  /** Its keys ("␣ +"), shown beside it, or null. */
  addKeys?: string | null;
}

/** `text` with what the query's terms matched wrapped in <mark>: each term as one run where it
 * appears whole (case-insensitive), else its letters in order, as the ranking scatters them.
 * With `whole` (prose finders, round 19) only a term found whole and two or more characters long
 * is marked, so a title isn't dotted with underlined single letters ("Ke·ep y·our"); the ranking
 * is the same either way. */
export function marked(text: string, query: string, whole = false): React.ReactNode {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0 || text === "") return text;
  const hit = new Array<boolean>(text.length).fill(false);
  const lower = text.toLowerCase();
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at >= 0) {
      if (!whole || term.length >= 2) for (let i = at; i < at + term.length; i++) hit[i] = true;
      continue;
    }
    if (whole) continue;
    const picks: number[] = [];
    let from = 0;
    for (const ch of term) {
      const i = lower.indexOf(ch, from);
      if (i < 0) break;
      picks.push(i);
      from = i + 1;
    }
    if (picks.length === term.length) for (const i of picks) hit[i] = true;
  }
  if (!hit.includes(true)) return text;
  const out: React.ReactNode[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || hit[i] !== hit[start]) {
      const part = text.slice(start, i);
      out.push(hit[start] ? <mark key={start}>{part}</mark> : part);
      start = i;
    }
  }
  return out;
}

/** A Host's node in the list, drawn as the Sidebar draws it. */
function HostNode({
  host,
  how,
  many,
}: {
  host: Host;
  how: Light | "connecting" | undefined;
  /** Nine or more Sessions are open: another live Host's node keeps its colour, not its stub. */
  many: boolean;
}) {
  if (!host.reviewed || how === undefined)
    return <StateDot dot={hostDot(host)} />;
  return how === "connecting" ? (
    <StateDot dot="connecting" />
  ) : (
    <StateDot dot={hostDot(host)} lit={how} stub={!(many && how === "live")} />
  );
}

/** How wide the group column is, and its font, as laid out now (null until measured, and in
 * a test's DOM, which lays nothing out: the cell's own end ellipsis is then the fallback). */
interface GroupFit {
  /** The group column's width; `wide`, a type-less row's group cell (group and type columns). */
  width: number;
  wide: number;
  measure: (s: string) => number;
}

let canvas: CanvasRenderingContext2D | null | undefined;
/** Measures text in `font` (a canvas: no layout per row). */
function textMeasure(font: string): ((s: string) => number) | null {
  // A test's DOM has no canvas (and says so on every call): it keeps the cell's end ellipsis.
  if (canvas === undefined)
    canvas = /jsdom/.test(navigator.userAgent) ? null : document.createElement("canvas").getContext("2d");
  if (!canvas) return null;
  const ctx = canvas;
  const cache = new Map<string, number>();
  return (s) => {
    let w = cache.get(s);
    if (w === undefined) {
      ctx.font = font;
      w = ctx.measureText(s).width;
      cache.set(s, w);
    }
    return w;
  };
}

/** Reads the group column off the hidden sizer row (a DOM read, kept out of the component). */
function readGroupFit(list: HTMLElement | null): Omit<GroupFit, "measure"> & { font: string } | null {
  const cell = list?.querySelector<HTMLElement>(".picker-sizer .host-group");
  const type = list?.querySelector<HTMLElement>(".picker-sizer .host-type");
  if (!list || !cell || !type || cell.clientWidth === 0) return null;
  const cs = getComputedStyle(cell);
  const gap = parseFloat(getComputedStyle(list).columnGap) || 0;
  return {
    width: cell.getBoundingClientRect().width,
    wide: cell.getBoundingClientRect().width + gap + type.getBoundingClientRect().width,
    font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`,
  };
}

/** A group, cut in its middle to fit its column (round 20, amends Q223 b): its start, one "…" and
 * its last whole parts, so "fieldwork-east-ridge-building-4-s1" and "…-s2" don't both read
 * "fieldwork-east-ridge-b…". One cut, measured, never the column's end cut on top. The cell's
 * tooltip has it whole, and so does a screen reader. */
function GroupText({ group, fit, wide }: { group: string; fit: GroupFit | null; wide: boolean }) {
  const shown = fit ? fitMiddle(group, (wide ? fit.wide : fit.width) - 0.5, fit.measure) : group;
  if (shown === group) return <>{group}</>;
  return (
    <>
      <span aria-hidden="true">{shown}</span>
      <span className="visually-hidden">{group}</span>
    </>
  );
}

/** The first key bound to `action`, for the footer's hints. */
const keyFor = (table: KeyTable<PickerAction>, action: PickerAction) =>
  Object.entries(table).find(([, b]) => b.action === action)?.[0] ?? null;

export function Picker({
  hosts,
  recent,
  vim,
  keymap = defaultKeymap,
  onOpen,
  onReview,
  onClose,
  onQuick,
  quickFirst = false,
  manySessions = false,
  onAdd,
  addKeys = null,
  onInfo,
  onHelp,
  live,
}: PickerProps) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [inList, setInList] = useState(false);
  const [notice, setNotice] = useState("");
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const stripRef = useRef<HTMLSpanElement>(null);
  // The strip speaks only when something in the selected row is cut (markCut, below).
  useLayoutEffect(() => markCut(listRef.current, stripRef.current));
  // The list keeps the height it opened at, so the panel never shrinks as a query narrows it.
  useLayoutEffect(() => holdHeight(listRef.current), []);
  // The group column's width and font, measured again when the Picker is resized.
  const [groupFit, setGroupFit] = useState<GroupFit | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    let font = "";
    const read = () => {
      const now = readGroupFit(list);
      if (!now) return;
      setGroupFit((was) => {
        if (was && was.width === now.width && was.wide === now.wide && now.font === font) return was;
        const measure = textMeasure(now.font);
        font = now.font;
        return measure ? { width: now.width, wide: now.wide, measure } : null;
      });
    };
    read();
    // Iosevka and Inter may still be loading: measure again once they're in.
    void document.fonts?.ready.then(() => {
      font = "";
      read();
    });
    if (typeof ResizeObserver === "undefined" || !list) return;
    const ro = new ResizeObserver(read);
    ro.observe(list);
    return () => ro.disconnect();
  }, []);

  const results = useMemo(
    () => searchHosts(hosts, query, recent),
    [hosts, query, recent],
  );
  const shown = results.slice(0, MAX_ROWS);
  // A Quick Connect address is row 0, ahead of any Host it happens to match.
  const quick = onQuick ? parseQuickTarget(query) : null;
  const offset = quick ? 1 : 0;
  const rowCount = shown.length + offset;
  const current = Math.min(index, Math.max(0, rowCount - 1));
  const selected =
    current >= offset ? shown[current - offset]?.host : undefined;
  // The widest address, group and type in the whole Inventory, in a hidden row: the columns are
  // sized by every Host, not by the ones a query leaves, so they hold still while you type.
  const widest = useMemo(() => {
    const longest = (pick: (h: Host) => string) =>
      hosts.hosts.reduce(
        (a, h) => (pick(h).length > a.length ? pick(h) : a),
        "",
      );
    return {
      ip: hosts.hosts
        .map((h) => addressCut(h.ip, IP_CHARS))
        .reduce((a, ip) => (ip.length > a.length ? ip : a), ""),
      group: longest((h) => h.group),
      type: longest((h) => h.type),
    };
  }, [hosts.hosts]);
  /** The Host at row `i` (none for the Quick Connect row). */
  const hostAt = (i: number) =>
    i < offset ? undefined : shown[i - offset]?.host;

  useLayoutEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${current}"]`,
    );
    row?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  function chooseRow(i: number, here = false) {
    if (quick && i < offset) onQuick?.(quick);
    else choose(hostAt(i), here);
  }

  function choose(host: Host | undefined, here = false) {
    if (!host) return;
    if (!host.reviewed) {
      const review = keyFor(keymap.picker, "picker.review");
      setNotice(
        onReview && review
          ? `${host.name} isn't reviewed yet, so it can't be opened. ${review} marks it reviewed.`
          : `${host.name} isn't reviewed yet, so it can't be opened. Set reviewed: true for it in roster.yml (:help adding-hosts).`,
      );
      return;
    }
    if (here) onOpen(host, { here: true });
    else onOpen(host);
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
        setIndex(Math.min(current + 1, rowCount - 1));
        setInList(true);
        break;
      case "picker.up":
        setIndex(Math.max(current - 1, 0));
        setInList(true);
        break;
      case "picker.next":
      case "picker.prev": {
        const fill =
          action === "picker.next" && !inList
            ? prefixFill(
                query,
                shown.map((r) => r.host.name),
              )
            : null;
        if (fill !== null) {
          setQuery(fill);
          setIndex(0);
          setNotice("");
          break;
        }
        if (rowCount === 0) break;
        setIndex(
          (current + (action === "picker.next" ? 1 : -1) + rowCount) % rowCount,
        );
        setInList(true);
        break;
      }
      case "picker.choose":
        chooseRow(current);
        break;
      case "picker.chooseHere":
        chooseRow(current, true);
        break;
      case "picker.review": {
        const host = hostAt(current);
        if (host && !host.reviewed && onReview) onReview(host);
        else if (host)
          setNotice(onReview ? `${host.name} is already reviewed.` : "");
        break;
      }
      case "picker.info": {
        const host = hostAt(current);
        if (host && onInfo) onInfo(host);
        break;
      }
      case "picker.help":
        // A Host opens with :connect; the Quick Connect row is :quick (ticket 52).
        onHelp?.(hostAt(current) ? ":connect" : ":quick");
        break;
      case "picker.close":
        onClose();
        break;
    }
  }

  const info = keyFor(keymap.picker, "picker.info");
  const activeId = current < rowCount ? `${listId}-${current}` : undefined;
  const move = [
    keyFor(keymap.picker, "picker.up"),
    keyFor(keymap.picker, "picker.down"),
  ]
    .filter((k) => k !== null)
    .join(" ");
  const hints: [string | null, string][] = [
    [move, "move"],
    [keyFor(keymap.picker, "picker.choose"), "open"],
    [keyFor(keymap.picker, "picker.close"), "close"],
  ];

  return (
    <div
      className="picker-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="picker" role="dialog" aria-label="Find a Host">
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
            className="picker-query"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            placeholder={
              quickFirst
                ? "Quick Connect: user@address[:port], or find a Host"
                : onQuick
                  ? // What Quick Connect wants, said as an action (round 18); fits at 480 px.
                    "Find a Host, or type user@address"
                  : "Find a Host by name, address, group…"
            }
            autoFocus
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
              setNotice("");
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <ul
          className={`picker-list${rowCount <= 1 ? " few" : ""}`}
          role="listbox"
          id={listId}
          ref={listRef}
          aria-label="Hosts"
        >
          {quick && (
            <li
              id={`${listId}-0`}
              role="option"
              aria-selected={current === 0}
              data-index={0}
              className={`picker-row quick-row${current === 0 ? " selected" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => current !== 0 && setIndex(0)}
              onClick={() => onQuick?.(quick)}
            >
              {/* Quick Connect's own glyph, as the title bar draws it (round 19: a closed ring here
                  read as a password-login Host): this Box's square, an edge and an open ring, the
                  ring where every row's node sits. */}
              <span className="quick-node" aria-hidden="true">
                <ToolbarIconSvg name="quick" />
              </span>
              <span className="quick-label">Quick Connect</span>
              <span className="host-name">{formatQuickTarget(quick)}</span>
              <span className="quick-note">not in the Inventory</span>
            </li>
          )}
          {shown.map(({ host }, n) => (
            <li
              key={host.name}
              id={`${listId}-${n + offset}`}
              role="option"
              aria-selected={n + offset === current}
              aria-disabled={!host.reviewed}
              data-host={host.name}
              data-index={n + offset}
              className={`picker-row${n + offset === current ? " selected" : ""}${host.reviewed ? "" : " unreviewed"}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => n + offset !== current && setIndex(n + offset)}
              onClick={() => {
                setIndex(n + offset);
                choose(host);
              }}
            >
              <HostNode host={host} how={live?.get(host.name)} many={manySessions} />
              {/* The name and, on an unreviewed Host, its badge beside it, as in the Sidebar (round
                  18: a column of its own kept ~100 px empty on every other row while groups were cut). */}
              <div className="host-cell">
                <span className="host-name" title={host.name}>
                  {marked(host.name, query)}
                  {host.reviewed && live?.has(host.name) && (
                    <span className="visually-hidden">
                      {live.get(host.name) === "connecting"
                        ? ", connecting"
                        : ", has a Session"}
                    </span>
                  )}
                </span>
                {!host.reviewed && (
                  <span
                    className="badge"
                    title="unreviewed: can't be opened until it's reviewed"
                  >
                    unreviewed
                  </span>
                )}
              </div>
              <span className="host-ip" title={host.ip || undefined}>
                {/* A long address drops whole groups from its middle, never cut mid-token; the
                    strip below shows the selected Host's whole address. */}
                {host.ip.length > IP_CHARS
                  ? addressCut(host.ip, IP_CHARS)
                  : marked(host.ip, query)}
              </span>
              {/* With no type, the group takes the type's cell too (round 19: cut beside an empty
                  cell); it still starts at the group column, so the columns stay shared. An empty
                  address keeps its cell: the group can't start left of its column. */}
              <span
                className={`host-group${host.type ? "" : " wide"}`}
                title={host.group}
              >
                <GroupText group={host.group} fit={groupFit} wide={!host.type} />
              </span>
              {host.type && (
                <span className="host-type" title={host.type}>
                  {host.type}
                </span>
              )}
            </li>
          ))}
          <li
            className="picker-row picker-sizer"
            aria-hidden="true"
            role="presentation"
          >
            <span />
            <span />
            <span className="host-ip">{widest.ip}</span>
            <span className="host-group">{widest.group}</span>
            <span className="host-type">{widest.type}</span>
          </li>
        </ul>
        {rowCount === 0 && (
          <p className="picker-empty">
            {query.trim() === "" && hosts.hosts.length === 0
              ? "The Inventory has no Hosts yet. Add them to roster.yml and they show up here."
              : <>No Hosts match <span className="data">{query.trim()}</span>.</>}
            {/* What you can do next (round 19: the line offered only Quick Connect, or nothing):
                add the Host, with its keys, where this roster can; reach it by user@address where
                Quick Connect is on (the form in Iosevka, something you type). */}
            {query.trim() !== "" && (
              <span className="picker-empty-next">
                {onAdd || onQuick ? (
                  <>
                    {onAdd && (
                      <>
                        <button
                          type="button"
                          tabIndex={-1}
                          className="picker-empty-add"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={onAdd}
                        >
                          Add a Host
                        </button>
                        {addKeys && (
                          <span className="key-hint">
                            {" "}
                            <Keys keys={addKeys} />
                          </span>
                        )}
                        {onQuick ? ", or type " : "."}
                      </>
                    )}
                    {onQuick && (
                      <>
                        {onAdd ? "" : "Type "}
                        <code>user@address</code> to connect to a machine that isn't in the Inventory.
                      </>
                    )}
                  </>
                ) : (
                  "Names, addresses, groups and types were searched; Backspace widens the search."
                )}
              </span>
            )}
          </p>
        )}
        <div className="picker-footer">
          <span role="status" title={notice || undefined}>
            {notice}
          </span>
          {/* The selected Host whole, in the footer's free room: shown only when its row is cut
              (Q214, round 10: a strip of its own sat empty most of the time). Rows never wrap,
              so the list never jumps; the option carries the name for screen readers. */}
          {!notice && (
            <span
              className="picker-detail"
              aria-hidden="true"
              ref={stripRef}
              title={selected?.name}
            >
              {selected && <span className="host-name">{selected.name}</span>}
            </span>
          )}
          {/* The count, said once typing pauses (ticket 54); the one beside it is only seen. */}
          <Announce
            text={
              results.length
                ? countOf(results.length, "Host")
                : query.trim()
                  ? "No Hosts match"
                  : ""
            }
          />
          <span className="picker-count" aria-hidden="true">
            {results.length > shown.length && query.trim() !== ""
              ? `${formatCount(shown.length)} of ${countOf(results.length, "Host")}`
              : results.length === 0
                ? "" /* the message (or the Quick Connect row) already says it */
                : countOf(results.length, "Host")}
          </span>
          {/* The selected Host's details: a key in the footer, also a button (round 16: a button
              over the row's end covered its data). */}
          {onInfo && selected && (
            <button
              type="button"
              tabIndex={-1}
              className="picker-hint key-hint picker-info-hint"
              aria-label={`Show ${selected.name}'s details`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onInfo(selected)}
            >
              {info ? <Keys keys={info} /> : <InfoGlyph />}{" "}
              <span className="picker-hint-word">details</span>
            </button>
          )}
          {hints.map(
            ([keys, what]) =>
              // Moving and opening need a row: with none, only the way out is offered.
              keys &&
              (rowCount > 0 || what === "close") &&
              // One row: nothing to move between.
              !(what === "move" && rowCount <= 1) &&
              // An unreviewed Host can't be opened: no "open" on it (round 16), its badge says why.
              !(what === "open" && selected && !selected.reviewed) && (
                <span key={what} className="picker-hint key-hint">
                  <Keys keys={keys} />{" "}
                  <span className="picker-hint-word">{what}</span>
                </span>
              ),
          )}
        </div>
      </div>
    </div>
  );
}
