// The status bar, one line that gives way in a fixed order when it runs out of room (round 19):
// the Inventory's path drops whole folders, form by form down to "~/…/roster.yml" (round 20,
// PathText), the hints go whole, last first, then "~/" ("…/roster.yml"), then the path, and only then do the Backend's label, this Box and the Session on screen get
// cut (CSS, shrink factors). A segment that gives way is removed (display: none, out of the
// accessibility tree), so it never keeps room it draws nothing in; round 18 let them wrap to a
// hidden second line, which left their boxes blank (98 px at 480, ~190 px at 800).
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { cutCount, showCut } from "./PathText";

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

/** Shows every segment that can give way, the path whole, then while the bar is tight (its
 * content wider than it, or a kept segment cut) takes the next step: the path's next shorter form
 * (whole folders dropped) down to "~/…/roster.yml", then each hint (last first), then
 * "…/roster.yml", then the path. */
export function giveWay(bar: HTMLElement) {
  const hints = [...bar.querySelectorAll<HTMLElement>(".statusbar-hints > *")].reverse();
  const path = bar.querySelector<HTMLElement>(":scope > .path");
  const text = path?.querySelector<HTMLElement>(".path-text");
  for (const el of path ? [...hints, path] : hints) show(el);
  if (text) showCut(text, 0);
  // No layout (a hidden bar, or jsdom): nothing gives way.
  if (bar.clientWidth === 0) return;
  // Its least form, "…/roster.yml", only once the hints are gone: "~/…/roster.yml" says more.
  const forms = text ? cutCount(text) : 0;
  const steps: (() => void)[] = [];
  for (let i = 1; i < forms - 1; i++) steps.push(() => text && showCut(text, i));
  for (const el of hints) steps.push(() => hide(el));
  if (text && forms > 1) steps.push(() => showCut(text, forms - 1));
  if (path) steps.push(() => hide(path));
  const tight = () =>
    bar.scrollWidth > bar.clientWidth || [...bar.querySelectorAll<HTMLElement>(KEPT)].some((c) => c.scrollWidth > c.clientWidth);
  for (const step of steps) {
    if (!tight()) break;
    step();
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
