// A live region a screen reader hears (ticket 54, WCAG 4.1.3): always mounted and empty at first,
// so what it says later is heard (a region inserted with its text often isn't), and saying `text`
// only once it has held still for `delay` ms, so typing a query isn't read out keystroke by
// keystroke. Hidden from sight: the visible count stays where it is.
import { useEffect, useState } from "react";

export function Announce({ text, delay = 500 }: { text: string; delay?: number }) {
  const [said, setSaid] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSaid(text), text === "" ? 0 : delay);
    return () => clearTimeout(t);
  }, [text, delay]);
  return (
    <span role="status" className="visually-hidden" aria-live="polite" aria-atomic="true">
      {text === "" ? "" : said}
    </span>
  );
}
