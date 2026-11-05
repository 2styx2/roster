// The status bar, one line that gives way in a fixed order when it runs out of room (round 19):
// the Inventory's path drops whole folders, form by form down to "~/…/roster.yml" (round 20,
// PathText), the hints go whole, last first, then "~/" ("…/roster.yml"), then the path, and only
// then the Backend's label, this Box's name and the Session on screen's (round 21: shortened by
// their own middle cut, then removed, where CSS had cut them a second time and the bar clipped
// them). A segment that gives way is removed (display: none, out of the
// accessibility tree), so it never keeps room it draws nothing in; round 18 let them wrap to a
// hidden second line, which left their boxes blank (98 px at 480, ~190 px at 800).
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { middleCut } from "../ui/format";
import { cutCount, showCut } from "./PathText";

function show(el: HTMLElement) {
  if (!el.hasAttribute("data-off")) return;
  el.removeAttribute("data-off");
  el.removeAttribute("aria-hidden");
}

function hide(el: HTMLElement) {
  el.setAttribute("data-off", "");
  el.setAttribute("aria-hidden", "true");
}

/** The lengths a name the status bar names (this Box, the Session on screen) is shortened to, each
 * cut in its middle: its start and its end, which tell names apart, stay. */
const NAME_FORMS = [24, 16, 10] as const;

/** A name's forms, longest first: whole up to 24 characters, then cut in its middle to 24, 16 and
 * 10 (round 21: one middle cut, never a second end cut on top, "aleksandra-w…orali…"). */
export function nameForms(name: string): string[] {
  return [...new Set(NAME_FORMS.map((n) => middleCut(name, n)))];
}

/** A name in the forms `nameForms` gives, one shown (FitBar picks it); the segment's `title` has
 * it whole. */
export function NameForms({ name }: { name: string }) {
  return (
    <span className="statusbar-cut path-text">
      {nameForms(name).map((form, i) => (
        <span key={form} className="path-cut" data-off={i === 0 ? undefined : ""}>
          {form}
        </span>
      ))}
    </span>
  );
}

/** Shows every segment that can give way at its longest, then while the bar's content is wider
 * than it takes the next step: the path's next shorter form (whole folders dropped) down to
 * "~/…/roster.yml", then each hint (last first), then "…/roster.yml", then the path; then the
 * Backend's label (its node stays, the label in its tooltip), this Box's name form by form and
 * then the name (its square stays), and the Session on screen's name the same way, last. A segment
 * is whole, shortened by its own rule or removed; nothing is ever clipped by the bar's edge
 * (round 21: "WSL:…" and "aleksandra-w…orali…" at 480). */
export function giveWay(bar: HTMLElement) {
  const hints = [...bar.querySelectorAll<HTMLElement>(".statusbar-hints > *")].reverse();
  const path = bar.querySelector<HTMLElement>(":scope > .path");
  const text = path?.querySelector<HTMLElement>(".path-text");
  const label = (cls: string) => bar.querySelector<HTMLElement>(`:scope > .${cls} > .statusbar-cut`);
  const backend = label("backend");
  const names = [label("box"), label("session-seg")].filter((n): n is HTMLElement => n !== null);
  for (const el of [...hints, ...(path ? [path] : []), ...(backend ? [backend] : []), ...names]) show(el);
  if (text) showCut(text, 0);
  for (const n of names) showCut(n, 0);
  // No layout (a hidden bar, or jsdom): nothing gives way.
  if (bar.clientWidth === 0) return;
  // Its least form, "…/roster.yml", only once the hints are gone: "~/…/roster.yml" says more.
  const forms = text ? cutCount(text) : 0;
  const steps: (() => void)[] = [];
  for (let i = 1; i < forms - 1; i++) steps.push(() => text && showCut(text, i));
  for (const el of hints) steps.push(() => hide(el));
  if (text && forms > 1) steps.push(() => showCut(text, forms - 1));
  if (path) steps.push(() => hide(path));
  if (backend) steps.push(() => hide(backend));
  for (const n of names) {
    for (let i = 1; i < cutCount(n); i++) steps.push(() => showCut(n, i));
    steps.push(() => hide(n));
  }
  const tight = () => bar.scrollWidth > bar.clientWidth;
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
