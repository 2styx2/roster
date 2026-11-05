// A Host row's menu (T166, #314, decision Q156): the ARIA menu pattern. Opened by the pointer,
// focus goes to the menu and the arrows start on an item; opened from the keyboard (the Menu key,
// Shift+F10), on the first item. ↑/↓ wrap, Home/End, a letter goes to the next item starting with
// it, Enter or Space runs one, Esc closes and gives focus back where it was, and Tab, a press
// outside it, a scroll, a resize or the window losing focus close it. It's kept inside the Sidebar
// pane (round 21: near the foot it lay over the status bar): at the pointer, or under the row, the
// tree scrolled up for it or the menu flipped above the row where there's no room. It's at least
// as wide as its row and never wider than the Sidebar.
//
// Motion (the animate skill, taste.md "motion confirms"): opened by the pointer it fades in from
// 0.97 at the pointer over 120 ms (strong ease-out), so the click visibly opened it; from a key it
// appears at once (a key confirms itself), and it always closes at once, as a native menu does.
// Reduced motion keeps the fade and drops the scale.
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { Keys } from "../ui/Keys";
import type { MenuEntry } from "./hostMenu";
import type { CommandLine } from "../keymap";

/** How far from the pane's top and foot the menu keeps. */
const MARGIN = 4;

/** A box in the window's coordinates: where a menu may go. */
export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface RowMenuProps {
  /** The Host's name: the menu's name. */
  label: string;
  /** What the row's name is, as its commands' hints write it in its place: HOST, GROUP or NAME. */
  what?: string;
  entries: readonly MenuEntry[];
  /** The pointer, else null: under `anchor`. */
  at: { x: number; y: number } | null;
  /** The row it's for (where a keyboard-opened menu goes). */
  anchor(): Element | null;
  leader: string;
  run(line: CommandLine): void;
  close(): void;
}

/** An item's command as a hint: its words up to the row's own name, then the argument's shape in
 * its place (`:check HOST`, `:group rename NAME`, `:folder remove HOST NAME`, `:host add`). Round
 * 18: the first word alone gave ":group" for both Rename and Delete; round 19: a closing "…" read
 * as cut text. `what` names the row's kind: HOST on a Host's row, GROUP on a group's, else NAME. */
export function commandHint(command: string, subject: string, what = "NAME"): string {
  const at = subject === "" ? -1 : command.indexOf(` ${subject}`);
  const end = at + subject.length + 1;
  const ends = at >= 0 && (command.length === end || command[end] === " ");
  // A `new` asks for the new thing's name (round 21: "New Folder" showed no shape at all).
  if (!ends) return `:${command}${/(^| )new$/.test(command) ? " NAME" : ""}`;
  const more = command.slice(end).trim() === "" ? "" : " NAME";
  return `:${command.slice(0, at)} ${what}${more}`;
}

/** The hint a menu item shows when no key is bound, or null. A Plugin's item that runs one of its
 * command lines (`plugins run folders folder new`) shows that line, as it would be typed (round 21:
 * the Folders heading's lone "New Folder" showed nothing); one that calls a function has no `:`
 * form. */
export function menuHint(command: string, subject: string, what = "NAME"): string | null {
  const own = /^plugins run \S+ (.+)$/.exec(command);
  if (own?.[1]) return commandHint(own[1], subject, what);
  if (command === "plugins" || command.startsWith("plugins ")) return null;
  return commandHint(command, subject, what);
}

/** Where the menu goes: at the point, moved (or flipped) to stay in `area` (the Sidebar pane):
 * inside its left and right edges, and `MARGIN` clear of its top and foot. */
export function placeMenu(
  point: { x: number; y: number; flipY?: number },
  size: { width: number; height: number },
  area: Bounds,
): { left: number; top: number } {
  let left = point.x;
  if (left + size.width > area.right) left = area.right - size.width;
  const foot = area.bottom - MARGIN;
  let top = point.y;
  if (top + size.height > foot) top = (point.flipY ?? point.y) - size.height;
  if (top + size.height > foot) top = foot - size.height;
  return {
    left: Math.max(area.left, left),
    top: Math.max(area.top + MARGIN, top),
  };
}

/** The Sidebar pane `row` is in, else the window. */
function paneOf(row: Element | null): Bounds {
  const pane = row?.closest(".sidebar")?.getBoundingClientRect();
  return pane && pane.height > 0
    ? { left: pane.left, top: pane.top, right: pane.right, bottom: pane.bottom }
    : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
}

/** The nearest ancestor of `el` that scrolls vertically. */
function scrollerOf(el: Element | null): HTMLElement | null {
  for (let e = el?.parentElement; e; e = e.parentElement) {
    const y = getComputedStyle(e).overflowY;
    if ((y === "auto" || y === "scroll") && e.scrollHeight > e.clientHeight)
      return e;
  }
  return null;
}

/** How far a row's scroller should scroll (up to `room`, what's left below) so a menu `height`
 * tall fits under the row above `view` (the pane's foot), or 0 when it fits, can't be made to, or
 * would push the row out of the scroller's top (`rowTop` - the scroll < `scrollerTop`, which is
 * below the scroller's top fade). */
export function scrollForMenu(
  row: { top: number; bottom: number },
  height: number,
  view: number,
  room: number,
  scrollerTop: number,
): number {
  const need = Math.ceil(row.bottom + height + MARGIN - view);
  if (need <= 0 || need > room || row.top - need < scrollerTop) return 0;
  return need;
}

/** Scrolls `row`'s scroller so a menu `height` tall opens under it, above `foot`, where that can
 * be done. */
function roomBelow(row: Element | null, height: number, foot: number) {
  const scroller = scrollerOf(row);
  if (!row || !scroller) return;
  // The scroller's top fade (its scroll padding): the row stays clear of it.
  const fade = parseFloat(getComputedStyle(scroller).scrollPaddingTop) || 0;
  const by = scrollForMenu(
    row.getBoundingClientRect(),
    height,
    foot,
    scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
    scroller.getBoundingClientRect().top + fade,
  );
  if (by > 0) scroller.scrollTop += by;
}

/** Where a menu that opens upward goes so neither of its edges cuts a tree row (round 20: a flipped
 * menu sliced the row above it mid-glyph): its bottom on the last row edge at or above `bottom`,
 * its top on the nearest row edge that leaves it at least `height`, and the room that adds, to
 * share out as padding. `edges` are the rows' tops and bottoms; with none near, it's as it was. */
export function snapUp(
  bottom: number,
  height: number,
  edges: readonly number[],
): { top: number; bottom: number; extra: number } {
  const below = edges.filter((e) => e <= bottom + 0.5);
  const end = below.length ? Math.max(...below) : bottom;
  // Only a top that lands on the rows needs moving: above them (a heading area) it cuts nothing.
  const above = edges.filter((e) => e <= end - height + 0.5);
  if (above.length === 0 || end - height < Math.min(...edges) - 0.5)
    return { top: bottom - height, bottom, extra: 0 };
  const top = Math.max(...above);
  return { top, bottom: end, extra: Math.max(0, end - top - height) };
}

/** The tops and bottoms of the rows in `row`'s tree that are in view (a row its scroller has
 * scrolled out of sight, under the details foot, has no edge to keep clear). */
function rowEdges(row: Element | null): number[] {
  const tree = row?.closest('[role="tree"]');
  if (!tree) return [];
  const scroller = scrollerOf(row);
  const clip = scroller?.getBoundingClientRect();
  const out: number[] = [];
  for (const r of tree.querySelectorAll(".sb-row, .sb-heading, .sb-empty, .sb-slot")) {
    const b = r.getBoundingClientRect();
    if (b.height === 0) continue;
    if (clip && scroller?.contains(r) && (b.bottom <= clip.top || b.top >= clip.bottom)) continue;
    out.push(b.top, b.bottom);
  }
  return out;
}

export function RowMenu({
  label,
  what = "NAME",
  entries,
  at,
  anchor,
  leader,
  run,
  close,
}: RowMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const keyboard = at === null;
  // Where focus was (the terminal, or the tree in App mode): it goes back there however it closes,
  // before an item's command runs, so a command that moves focus moves it from there.
  const back = useRef<Element | null>(null);
  const giveBack = () => {
    const el = back.current;
    const focused = document.activeElement;
    const ours =
      !focused ||
      focused === document.body ||
      (ref.current?.contains(focused) ?? false);
    if (ours && el instanceof HTMLElement && el.isConnected)
      el.focus({ preventScroll: true });
  };
  const dismissRef = useRef(() => {});
  useLayoutEffect(() => {
    dismissRef.current = () => {
      giveBack();
      close();
    };
  });
  const items = () =>
    Array.from(
      ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
  // Where the row and what holds it were scrolled to when it opened. A scroll's event comes a frame
  // after the scroll: the App-mode cursor scrolls its row into view at once, so a menu key pressed
  // in that frame opened the menu and then the event closed it (T173). Only a scroll from here does.
  const scrolledAt = useRef(new Map<Element, readonly [number, number]>());

  // Placed before it's painted, then focused.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    back.current = document.activeElement;
    // The Sidebar pane bounds it (round 21: near the foot it lay over the status bar and the
    // details strip). Its width: at least its row's, so no sliver of the row under it shows beside
    // it, and never past the Sidebar's edge (round 21: a Host's menu overhung it by 16 px, a
    // heading's was narrower than its row).
    const area = paneOf(anchor());
    const row0 = anchor()?.getBoundingClientRect();
    if (row0 && row0.width > 0) {
      el.style.minWidth = `${Math.round(row0.width)}px`;
      el.style.maxWidth = `${Math.floor(area.right - row0.left)}px`;
    }
    el.style.maxHeight = `${Math.max(0, Math.floor(area.bottom - area.top - 2 * MARGIN))}px`;
    // From a key, a row too near the pane's foot scrolls up just enough for the menu to open under
    // it (round 20: flipped above, its edge sliced a row mid-glyph). Only from a key: under the
    // pointer the tree never moves (Q216).
    if (keyboard) roomBelow(anchor(), el.offsetHeight, area.bottom);
    for (let e = anchor() ?? document.scrollingElement; e; e = e.parentElement)
      scrolledAt.current.set(e, [e.scrollTop, e.scrollLeft]);
    const rect = anchor()?.getBoundingClientRect();
    // It lines up with its row's edges (as wide as the row, it would otherwise be pushed in from
    // the Sidebar's edge to sit 7 px off them); from the pointer it opens at the pointer's height.
    const point = at
      ? { x: rect ? rect.left : at.x, y: at.y }
      : rect
        ? { x: rect.left, y: rect.bottom, flipY: rect.top }
        : { x: area.left, y: area.top + MARGIN };
    const placed = placeMenu(
      point,
      { width: el.offsetWidth, height: el.offsetHeight },
      area,
    );
    const { left } = placed;
    let { top } = placed;
    // Moved up (flipped, or kept in the window): both its edges go to row edges, so no row shows
    // sliced above or under it; the room that takes is shared as padding, top and bottom.
    // Opened downward, its foot goes down to the next row edge, as long as that's in the window.
    const height = el.offsetHeight;
    const edges = rowEdges(anchor());
    let extra = 0;
    if (top < point.y) {
      const snap = snapUp(top + height, height, edges);
      if (snap.top >= area.top + MARGIN) {
        top = snap.top;
        extra = snap.extra;
      }
    } else {
      const foot = edges.filter((e) => e >= top + height - 0.5);
      const next = foot.length ? Math.min(...foot) : null;
      if (next !== null && next <= area.bottom - MARGIN)
        extra = next - top - height;
    }
    if (extra > 0.5) {
      const pad = parseFloat(getComputedStyle(el).paddingTop) || 0;
      el.style.paddingTop = `${pad + Math.floor(extra / 2)}px`;
      el.style.paddingBottom = `${pad + Math.ceil(extra / 2)}px`;
    }
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    // Scale from the corner nearest the point it opened at.
    const from = at ?? point;
    el.style.transformOrigin = `${Math.max(0, from.x - left)}px ${Math.max(0, from.y - top)}px`;
    if (keyboard) items()[0]?.focus();
    else el.focus();
    // Gone with its row (a Host removed elsewhere): focus goes back too.
    return giveBack;
    // Placed once, where it opened: a changed list doesn't move it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A press outside it, a scroll, a resize or the window losing focus closes it.
  useEffect(() => {
    const dismiss = () => dismissRef.current();
    const outside = (e: Event) => {
      if (!(e.target instanceof Node) || !ref.current?.contains(e.target))
        dismiss();
    };
    const scrolled = (e: Event) => {
      const el =
        e.target instanceof Document ? e.target.scrollingElement : e.target;
      const was =
        el instanceof Element ? scrolledAt.current.get(el) : undefined;
      if (
        el instanceof Element &&
        was?.[0] === el.scrollTop &&
        was[1] === el.scrollLeft
      )
        return;
      outside(e);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("mousedown", outside, true);
      document.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, []);

  const move = (to: (i: number, n: number) => number) => {
    const list = items();
    if (list.length === 0) return;
    const i = list.indexOf(document.activeElement as HTMLElement);
    list[to(i, list.length)]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const k = e.key;
    let handled = true;
    if (k === "ArrowDown") move((i, n) => (i + 1) % n);
    else if (k === "ArrowUp") move((i, n) => (i < 0 ? n - 1 : (i - 1 + n) % n));
    else if (k === "Home" || k === "PageUp") move(() => 0);
    else if (k === "End" || k === "PageDown") move((_, n) => n - 1);
    else if (k === "Escape" || k === "Tab") dismissRef.current();
    else if (
      k.length === 1 &&
      /\S/.test(k) &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey
    ) {
      // Typeahead: the next item whose label starts with the letter.
      const list = items();
      const i = list.indexOf(document.activeElement as HTMLElement);
      const starts = (el: HTMLElement) =>
        (el.dataset.label ?? "").toLowerCase().startsWith(k.toLowerCase());
      const next = [...list.slice(i + 1), ...list.slice(0, i + 1)].find(starts);
      next?.focus();
    } else handled = false;
    // The menu's keys are its own: not the terminal's, nor the App's.
    e.stopPropagation();
    if (handled) e.preventDefault();
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      className={`row-menu${keyboard ? " instant" : ""}`}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((entry, i) =>
        "separator" in entry ? (
          <div key={`sep-${i}`} role="separator" className="row-menu-sep" />
        ) : (
          <button
            key={entry.command}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="row-menu-item"
            data-label={entry.label}
            onPointerMove={(e) => {
              // The item under the pointer is the active one, as in a native menu.
              if (document.activeElement !== e.currentTarget)
                e.currentTarget.focus({ preventScroll: true });
            }}
            onClick={() => {
              dismissRef.current();
              run(entry.command);
            }}
          >
            {/* A long label (a Plugin's, naming a long Host) is cut; its tooltip has it whole. */}
            <span className="row-menu-label" dir="auto" title={entry.label}>
              {entry.label}
            </span>
            {entry.keys ? (
              <>
                <span className="visually-hidden">,</span>{" "}
                <Keys
                  keys={entry.keys}
                  leader={leader}
                  className="row-menu-keys"
                />
              </>
            ) : (
              // No key bound: its command line, so the item still says how to reach it from the
              // keyboard (taste.md: every action has a key, or at least a `:` form).
              // A Plugin's function has no `:` form worth showing; its command line has.
              menuHint(entry.command, label, what) !== null && (
                <span className="row-menu-cmd key-hint" aria-hidden="true">
                  {menuHint(entry.command, label, what)}
                </span>
              )
            )}
          </button>
        ),
      )}
    </div>
  );
}
