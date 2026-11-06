// The Inventory's path, drawn whole when it fits and else cut by whole folders (round 20): each
// form pathCuts gives ("~/…/infra/roster.yml", "~/…/roster.yml", "…/roster.yml") is in the DOM and
// one is shown, so a folder name is never cut inside and there's no gap between the parts (round
// 19's rtl-ellipsized middle read "~/ …ventory/roster.yml"). The status bar picks the form as it
// gives way (FitBar); the empty Inventory's pane fits it to its own line (`fit`). The box around
// it holds the whole path in `title`.
import { useLayoutEffect, useRef } from "react";
import { pathCuts } from "./path";

/** Shows the `i`th form of a PathText (its others are removed: no room, not read). */
export function showCut(text: HTMLElement, i: number) {
  text.querySelectorAll<HTMLElement>(":scope > .path-cut").forEach((c, j) => {
    if (j === i) c.removeAttribute("data-off");
    else c.setAttribute("data-off", "");
  });
}

/** How many forms a PathText has. */
export function cutCount(text: HTMLElement): number {
  return text.querySelectorAll(":scope > .path-cut").length;
}

/** Shows the longest form that fits `box`'s width (the shortest when none does). */
export function fitPath(box: HTMLElement, text: HTMLElement) {
  const n = cutCount(text);
  showCut(text, 0);
  // No layout (a hidden box, or jsdom): the whole path.
  if (box.clientWidth === 0) return;
  for (let i = 1; i < n && box.scrollWidth > box.clientWidth; i++) showCut(text, i);
}

export function PathText({ path, fit = false }: { path: string; fit?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const text = ref.current;
    const box = text?.parentElement;
    if (!fit || !text || !box) return;
    let live = true;
    const run = () => live && fitPath(box, text);
    run();
    // The pane's width changes the line's: fit again (fitting starts from the whole path, so the
    // same width always gives the same form and this settles). The line and its column are as
    // wide as their text, so it's the column's container that's watched.
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(run);
    resize?.observe(box.parentElement?.parentElement ?? box);
    void document.fonts?.ready.then(run);
    return () => {
      live = false;
      resize?.disconnect();
    };
  }, [fit, path]);
  return (
    <span className="path-text" ref={ref}>
      {pathCuts(path).map((form, i) => (
        <span key={form} className="path-cut" data-off={i === 0 ? undefined : ""}>
          {form}
        </span>
      ))}
    </span>
  );
}
