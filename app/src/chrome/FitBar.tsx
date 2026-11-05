// The status bar, one line that gives way in a fixed order when it runs out of room (round 19):
// the hints go whole, last first, then the Inventory's path (once it's cut down to its least,
// "~/…/roster.yml"), and only then do the Backend's label, this Box and the Session on screen get
// cut (CSS, shrink factors). A segment that gives way is removed (display: none, out of the
// accessibility tree), so it never keeps room it draws nothing in; round 18 let them wrap to a
// hidden second line, which left their boxes blank (98 px at 480, ~190 px at 800).
import { useLayoutEffect, useRef, type ReactNode } from "react";

/** The segments that are cut rather than removed: when one of them is cut, the bar is tight. */
const KEPT = ":scope > :is(.backend, .box, .session-seg) .statusbar-cut";

function show(el: HTMLElement) {
  if (!el.hasAttribute("data-off")) return;
  el.removeAttribute("data-off");
  el.removeAttribute("aria-hidden");
}

function hide(el: HTMLElement) {
  el.setAttribute("data-off", "");
  el.setAttribute("aria-hidden", "true");
}

/** Shows every segment that can give way, then removes them in order (the hints last first, then
 * the path) while the bar is tight: its content wider than it, or a kept segment cut. */
export function giveWay(bar: HTMLElement) {
  const hints = [...bar.querySelectorAll<HTMLElement>(".statusbar-hints > *")].reverse();
  const path = bar.querySelector<HTMLElement>(":scope > .path");
  const order = path ? [...hints, path] : hints;
  for (const el of order) show(el);
  // No layout (a hidden bar, or jsdom): nothing gives way.
  if (bar.clientWidth === 0) return;
  const tight = () =>
    bar.scrollWidth > bar.clientWidth || [...bar.querySelectorAll<HTMLElement>(KEPT)].some((c) => c.scrollWidth > c.clientWidth);
  for (const el of order) {
    if (!tight()) break;
    hide(el);
  }
}

export function FitBar({ className, children }: { className: string; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    let live = true;
    const fit = () => live && giveWay(bar);
    fit();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    resize?.observe(bar);
    // What it shows changed (a Session opened, a hint came): fit again. Only children and text
    // are watched, so giveWay's own attributes don't set it off again.
    const mutation = typeof MutationObserver === "undefined" ? null : new MutationObserver(fit);
    mutation?.observe(bar, { childList: true, subtree: true, characterData: true });
    void document.fonts?.ready.then(fit);
    return () => {
      live = false;
      resize?.disconnect();
      mutation?.disconnect();
    };
  }, []);
  return (
    <footer ref={ref} className={className}>
      {children}
    </footer>
  );
}
