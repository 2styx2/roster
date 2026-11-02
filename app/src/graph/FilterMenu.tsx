// One dimension of a graph's filter (T89): a button saying what's shown ("Every cluster", "lab",
// "3 clusters") that opens a menu of checkboxes, so the user picks several clusters, kinds or
// states, as a Plugin can. The menu is the WAI-ARIA menu button with menuitemcheckbox items:
// Enter, Space or ↓ open it on the first ticked item, ↑ ↓ (Ctrl+P, Ctrl+N), Home and End move,
// a letter goes to the next item starting with it, Space ticks and stays, Enter ticks and closes,
// Esc closes back to the button, and Tab or a click elsewhere closes it.
//
// No motion (the animate skill): it opens from a key as often as a click, and a key confirms
// itself.
import { forwardRef, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterMenuProps {
  /** What it filters, in the singular ("cluster"). */
  noun: string;
  /** Its plural ("clusters"). */
  nouns: string;
  options: readonly FilterOption[];
  /** The values shown; none is everything. */
  chosen: readonly string[];
  onChange(values: string[]): void;
  /** Esc on the closed button. */
  onLeave(): void;
}

export const FilterMenu = forwardRef<HTMLButtonElement, FilterMenuProps>(function FilterMenu({ noun, nouns, options, chosen, onChange, onLeave }, ref) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const button = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLDivElement | null)[]>([]);
  // A value the Plugin chose that isn't among the options is one too, so it can be taken off; it
  // stays in the menu while it's open, so the item under the focus doesn't go away.
  const [kept, setKept] = useState<readonly string[]>([]);
  const others = [...new Set([...kept, ...chosen])].filter((v) => !options.some((o) => o.value === v));
  const all: FilterOption[] = [...options, ...others.map((v) => ({ value: v, label: v }))];
  const every = `Every ${noun}`;
  const labelOf = (v: string) => all.find((o) => o.value === v)?.label ?? v;
  const summary = chosen.length === 0 ? every : chosen.length === 1 ? labelOf(chosen[0] as string) : `${chosen.length} ${nouns}`;
  // Item 0 is "Every …"; item i + 1 is all[i].
  const count = all.length + 1;

  useEffect(() => {
    if (open) items.current[at]?.focus();
  }, [open, at]);

  // A click elsewhere closes it.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const show = () => {
    const first = all.findIndex((o) => chosen.includes(o.value));
    setAt(first < 0 ? 0 : first + 1);
    setKept(chosen);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const tick = (i: number) => {
    if (i === 0) return onChange([]);
    const v = all[i - 1]?.value;
    if (v === undefined) return;
    onChange(chosen.includes(v) ? chosen.filter((x) => x !== v) : [...chosen, v]);
  };

  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      show();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onLeave();
    }
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const k = e.key;
    const go = (i: number) => setAt((i + count) % count);
    let handled = true;
    if (k === "ArrowDown" || (e.ctrlKey && k === "n")) go(at + 1);
    else if (k === "ArrowUp" || (e.ctrlKey && k === "p")) go(at - 1);
    else if (k === "Home") go(0);
    else if (k === "End") go(count - 1);
    else if (k === " ") tick(at);
    else if (k === "Enter") {
      tick(at);
      close();
    } else if (k === "Escape") close();
    else if (k === "Tab") {
      setOpen(false);
      handled = false;
    } else if ([...k].length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // Typeahead: the next item whose label starts with the letter.
      const want = k.toLocaleLowerCase();
      const labels = [every, ...all.map((o) => o.label)];
      for (let n = 1; n <= count; n++) {
        const i = (at + n) % count;
        if (labels[i]?.toLocaleLowerCase().startsWith(want)) {
          setAt(i);
          break;
        }
      }
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const item = (i: number, label: string, checked: boolean) => (
    <div
      key={i}
      ref={(el) => {
        items.current[i] = el;
      }}
      role="menuitemcheckbox"
      aria-checked={checked}
      tabIndex={-1}
      className="graph-menu-item"
      title={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        setAt(i);
        tick(i);
        items.current[i]?.focus();
      }}
    >
      <span className="graph-menu-tick" aria-hidden="true">
        {checked ? "✓" : ""}
      </span>
      <span className="graph-menu-label">{label}</span>
    </div>
  );

  return (
    <span className="graph-menu-wrap">
      <button
        ref={(el) => {
          button.current = el;
          if (typeof ref === "function") ref(el);
          else if (ref) ref.current = el;
        }}
        type="button"
        className="graph-select"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        aria-label={`Show the ${noun}: ${summary}`}
        title={summary}
        data-on={chosen.length > 0 || undefined}
        onKeyDown={onButtonKey}
        onClick={() => (open ? setOpen(false) : show())}
      >
        <span className="graph-select-text">{summary}</span>
        <span className="graph-select-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div ref={menu} id={`${id}-menu`} role="menu" aria-label={`Show the ${noun}`} className="graph-menu" onKeyDown={onMenuKey}>
          {item(0, every, chosen.length === 0)}
          {all.map((o, i) => item(i + 1, o.label, chosen.includes(o.value)))}
        </div>
      )}
    </span>
  );
});
