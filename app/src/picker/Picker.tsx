// The Picker (GLOSSARY): fuzzy search over the Inventory's Hosts. Typing goes to the query.
// Arrows and Ctrl+N/P move; once you've moved, j/k move too (vim on) until you type anything
// else. Tab and Shift+Tab move too, wrapping (ticket 34); before you've moved, Tab first fills the
// query with what the matching names share, as a shell does. Enter or a click opens the selected Host, Esc closes. Unreviewed Hosts are listed but
// marked and never opened (spec story 14).
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Host, HostList } from "../backend/types";
import { chordOf, defaultKeymap, type Keymap, type KeyTable, type PickerAction } from "../keymap";
import { Announce } from "../ui/Announce";
import { countOf, formatCount } from "../ui/format";
import { Keys } from "../ui/Keys";
import { prefixFill } from "../ui/completion";
import { searchHosts } from "./match";
import { formatQuickTarget, parseQuickTarget, type QuickTarget } from "../quick/target";
import { hostDot } from "../sidebar/sections";
import { StateDot, type Light } from "../ui/StateDot";

/** An i in a ring: a Host's details (ticket 18). */
export const InfoGlyph = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
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
}

/** `text` with what the query's terms matched wrapped in <mark>: each term as one run where it
 * appears whole (case-insensitive), else its letters in order, as the ranking scatters them. */
export function marked(text: string, query: string): React.ReactNode {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0 || text === "") return text;
  const hit = new Array<boolean>(text.length).fill(false);
  const lower = text.toLowerCase();
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at >= 0) {
      for (let i = at; i < at + term.length; i++) hit[i] = true;
      continue;
    }
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
function HostNode({ host, how }: { host: Host; how: Light | "connecting" | undefined }) {
  if (!host.reviewed || how === undefined) return <StateDot dot={hostDot(host)} />;
  return how === "connecting" ? <StateDot dot="connecting" /> : <StateDot dot={hostDot(host)} lit={how} />;
}

/** The first key bound to `action`, for the footer's hints. */
const keyFor = (table: KeyTable<PickerAction>, action: PickerAction) =>
  Object.entries(table).find(([, b]) => b.action === action)?.[0] ?? null;

export function Picker({ hosts, recent, vim, keymap = defaultKeymap, onOpen, onReview, onClose, onQuick, quickFirst = false, onInfo, onHelp, live }: PickerProps) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [inList, setInList] = useState(false);
  const [notice, setNotice] = useState("");
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo(() => searchHosts(hosts, query, recent), [hosts, query, recent]);
  const shown = results.slice(0, MAX_ROWS);
  // A Quick Connect address is row 0, ahead of any Host it happens to match.
  const quick = onQuick ? parseQuickTarget(query) : null;
  const offset = quick ? 1 : 0;
  const rowCount = shown.length + offset;
  const current = Math.min(index, Math.max(0, rowCount - 1));
  /** The Host at row `i` (none for the Quick Connect row). */
  const hostAt = (i: number) => (i < offset ? undefined : shown[i - offset]?.host);

  useLayoutEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${current}"]`);
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
          : `${host.name} isn't reviewed yet, so it can't be opened. Review it in roster first.`,
      );
      return;
    }
    if (here) onOpen(host, { here: true });
    else onOpen(host);
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
        setIndex(Math.min(current + 1, rowCount - 1));
        setInList(true);
        break;
      case "picker.up":
        setIndex(Math.max(current - 1, 0));
        setInList(true);
        break;
      case "picker.next":
      case "picker.prev": {
        const fill = action === "picker.next" && !inList ? prefixFill(query, shown.map((r) => r.host.name)) : null;
        if (fill !== null) {
          setQuery(fill);
          setIndex(0);
          setNotice("");
          break;
        }
        if (rowCount === 0) break;
        setIndex((current + (action === "picker.next" ? 1 : -1) + rowCount) % rowCount);
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
        else if (host) setNotice(onReview ? `${host.name} is already reviewed.` : "");
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
  const move = [keyFor(keymap.picker, "picker.up"), keyFor(keymap.picker, "picker.down")].filter((k) => k !== null).join(" ");
  const hints: [string | null, string][] = [
    [move, "move"],
    [keyFor(keymap.picker, "picker.choose"), "open"],
    [keyFor(keymap.picker, "picker.close"), "close"],
  ];

  return (
    <div className="picker-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="picker" role="dialog" aria-label="Find a Host">
        <div className="picker-search">
          <svg className="picker-search-icon" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
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
                ? "Find a Host, or user@address to Quick Connect"
                : "Find a Host: name, address, type, product, group…"
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
        <ul className="picker-list" role="listbox" id={listId} ref={listRef} aria-label="Hosts">
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
              <HostNode host={host} how={live?.get(host.name)} />
              <span className="host-name" title={host.name}>
                {marked(host.name, query)}
                {host.reviewed && live?.has(host.name) && (
                  <span className="visually-hidden">{live.get(host.name) === "connecting" ? ", connecting" : ", has a Session"}</span>
                )}
              </span>
              <span className="host-ip" title={host.ip || undefined}>
                {marked(host.ip, query)}
              </span>
              <span className="host-group" title={host.group}>
                {host.group}
              </span>
              <span className="host-type" title={host.type}>
                {host.type}
              </span>
              {!host.reviewed && (
                <span className="badge" title="unreviewed: can't be opened until it's reviewed in roster">
                  unreviewed
                </span>
              )}
              {onInfo && (
                <button
                  type="button"
                  tabIndex={-1}
                  className="picker-info"
                  aria-label={`Show ${host.name}'s details`}
                  title={info ? `Show ${host.name}'s details (${info})` : `Show ${host.name}'s details`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onInfo(host);
                  }}
                >
                  <InfoGlyph />
                </button>
              )}
            </li>
          ))}
        </ul>
        {rowCount === 0 && (
          <p className="picker-empty">
            {query.trim() === "" && hosts.hosts.length === 0
              ? "The Inventory has no Hosts yet. Add them to roster.yml and they show up here."
              : `No Hosts match “${query}”.`}
          </p>
        )}
        <div className="picker-footer">
          <span role="status" title={notice || undefined}>
            {notice}
          </span>
          {/* The count, said once typing pauses (ticket 54); the one beside it is only seen. */}
          <Announce text={results.length ? countOf(results.length, "Host") : query.trim() ? "No Hosts match" : ""} />
          <span className="picker-count" aria-hidden="true">
            {results.length > shown.length
              ? `${formatCount(shown.length)} of ${countOf(results.length, "Host")}`
              : countOf(results.length, "Host")}
          </span>
          {hints.map(
            ([keys, what]) =>
              keys && (
                <span key={what} className="picker-hint key-hint">
                  <Keys keys={keys} /> {what}
                </span>
              ),
          )}
        </div>
      </div>
    </div>
  );
}
