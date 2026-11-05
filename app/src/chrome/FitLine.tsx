// One line of items that drop out whole, last first, when the line runs out of room: the status
// bar's hints (round 18). They wrap to a second line the box hides (CSS), and those are also
// marked `data-off` (hidden, out of the accessibility tree), so a hint is either whole on the
// line or not there at all, never a button below the bar that a screen reader still reads.
import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Marks each child of `line` that wrapped off its first line. */
export function markOverflow(line: HTMLElement) {
  const top = line.getBoundingClientRect().top;
  for (const child of line.children) {
    const el = child as HTMLElement;
    // No layout (a hidden bar, or jsdom): nothing is off.
    const off = line.clientHeight > 0 && el.getBoundingClientRect().top - top >= line.clientHeight;
    if (off) {
      el.setAttribute("data-off", "");
      el.setAttribute("aria-hidden", "true");
    } else if (el.hasAttribute("data-off")) {
      el.removeAttribute("data-off");
      el.removeAttribute("aria-hidden");
    }
  }
}

export function FitLine({ className, children }: { className: string; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const line = ref.current;
    if (!line) return;
    markOverflow(line);
    const fit = () => markOverflow(line);
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    resize?.observe(line);
    const mutation = typeof MutationObserver === "undefined" ? null : new MutationObserver(fit);
    mutation?.observe(line, { childList: true, subtree: true, characterData: true });
    return () => {
      resize?.disconnect();
      mutation?.disconnect();
    };
  }, []);
  return (
    <span ref={ref} className={className}>
      {children}
    </span>
  );
}
