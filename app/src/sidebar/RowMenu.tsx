// A Host row's menu (T166, #314, decision Q156): the ARIA menu pattern. Opened by the pointer,
// focus goes to the menu and the arrows start on an item; opened from the keyboard (the Menu key,
// Shift+F10), on the first item. ↑/↓ wrap, Home/End, a letter goes to the next item starting with
// it, Enter or Space runs one, Esc closes and gives focus back where it was, and Tab, a press
// outside it, a scroll, a resize or the window losing focus close it. It's kept inside the window:
// at the pointer, or under the row, flipped to the other side where there's no room.
//
// Motion (the animate skill, taste.md "motion confirms"): opened by the pointer it fades in from
// 0.97 at the pointer over 120 ms (strong ease-out), so the click visibly opened it; from a key it
// appears at once (a key confirms itself), and it always closes at once, as a native menu does.
// Reduced motion keeps the fade and drops the scale.
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { Keys } from "../ui/Keys";
import type { MenuEntry } from "./hostMenu";
import type { CommandLine } from "../keymap";

/** How far from the window's edges the menu keeps. */
const MARGIN = 4;

export interface RowMenuProps {
  /** The Host's name: the menu's name. */
  label: string;
  entries: readonly MenuEntry[];
  /** The pointer, else null: under `anchor`. */
  at: { x: number; y: number } | null;
  /** The row it's for (where a keyboard-opened menu goes). */
  anchor(): Element | null;
  leader: string;
  run(line: CommandLine): void;
  close(): void;
}

/** Where the menu goes: at the point, moved (or flipped) to stay in the window. */
export function placeMenu(
  point: { x: number; y: number; flipY?: number },
  size: { width: number; height: number },
  view: { width: number; height: number },
): { left: number; top: number } {
  let left = point.x;
  if (left + size.width > view.width - MARGIN) left = view.width - MARGIN - size.width;
  let top = point.y;
  if (top + size.height > view.height - MARGIN) top = (point.flipY ?? point.y) - size.height;
  if (top + size.height > view.height - MARGIN) top = view.height - MARGIN - size.height;
  return { left: Math.max(MARGIN, left), top: Math.max(MARGIN, top) };
}

export function RowMenu({ label, entries, at, anchor, leader, run, close }: RowMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const keyboard = at === null;
  // Where focus was (the terminal, or the tree in App mode): it goes back there however it closes,
  // before an item's command runs, so a command that moves focus moves it from there.
  const back = useRef<Element | null>(null);
  const giveBack = () => {
    const el = back.current;
    const focused = document.activeElement;
    const ours = !focused || focused === document.body || (ref.current?.contains(focused) ?? false);
    if (ours && el instanceof HTMLElement && el.isConnected) el.focus({ preventScroll: true });
  };
  const dismissRef = useRef(() => {});
  useLayoutEffect(() => {
    dismissRef.current = () => {
      giveBack();
      close();
    };
  });
  const items = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  // Where the row and what holds it were scrolled to when it opened. A scroll's event comes a frame
  // after the scroll: the App-mode cursor scrolls its row into view at once, so a menu key pressed
  // in that frame opened the menu and then the event closed it (T173). Only a scroll from here does.
  const scrolledAt = useRef(new Map<Element, readonly [number, number]>());

  // Placed before it's painted, then focused.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    back.current = document.activeElement;
    for (let e = anchor() ?? document.scrollingElement; e; e = e.parentElement) scrolledAt.current.set(e, [e.scrollTop, e.scrollLeft]);
    const rect = anchor()?.getBoundingClientRect();
    const point = at ?? (rect ? { x: rect.left + 24, y: rect.bottom, flipY: rect.top } : { x: MARGIN, y: MARGIN });
    const { left, top } = placeMenu(point, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    // Scale from the corner nearest the point it opened at.
    el.style.transformOrigin = `${Math.max(0, point.x - left)}px ${Math.max(0, point.y - top)}px`;
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
      if (!(e.target instanceof Node) || !ref.current?.contains(e.target)) dismiss();
    };
    const scrolled = (e: Event) => {
      const el = e.target instanceof Document ? e.target.scrollingElement : e.target;
      const was = el instanceof Element ? scrolledAt.current.get(el) : undefined;
      if (el instanceof Element && was?.[0] === el.scrollTop && was[1] === el.scrollLeft) return;
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
    else if (k.length === 1 && /\S/.test(k) && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // Typeahead: the next item whose label starts with the letter.
      const list = items();
      const i = list.indexOf(document.activeElement as HTMLElement);
      const starts = (el: HTMLElement) => (el.dataset.label ?? "").toLowerCase().startsWith(k.toLowerCase());
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
              if (document.activeElement !== e.currentTarget) e.currentTarget.focus({ preventScroll: true });
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
            {entry.keys && (
              <>
                <span className="visually-hidden">,</span> <Keys keys={entry.keys} leader={leader} className="row-menu-keys" />
              </>
            )}
          </button>
        ),
      )}
    </div>
  );
}
