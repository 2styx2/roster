// The question the Live Inventory asks before removing a Host (ticket 28): it names the Host and
// says what happens to its vault item (nothing). Enter (the focused button) confirms, Esc keeps it.
// It opens from a key or a row button, so it doesn't animate, like the other side panels.
import { useEffect, useRef, useState } from "react";
import { CloseGlyph } from "../ui/CloseGlyph";
import { Keys } from "../ui/Keys";

export interface ConfirmPanelProps {
  title: string;
  /** What will happen, in a sentence or two. */
  body: React.ReactNode;
  /** What else it affects, a paragraph each (`:inventory`'s Sessions and Pending changes). */
  more?: readonly string[];
  /** The confirming button's label ("Remove"); null when nothing can go ahead yet: only the
   * cancel button, which then has the focus. */
  action: string | null;
  /** The cancel button's label (default "Keep it"). */
  keep?: string;
  /** The confirming button breaks something (removing, deleting): the danger colour. Otherwise
   * it's the primary button, as switching Inventories is. */
  danger?: boolean;
  onConfirm(): Promise<void>;
  onClose(): void;
}

export function ConfirmPanel({ title, body, more = [], action, keep = "Keep it", danger = true, onConfirm, onClose }: ConfirmPanelProps) {
  const yes = useRef<HTMLButtonElement>(null);
  const no = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => (yes.current ?? no.current)?.focus(), []);
  return (
    <section
      tabIndex={-1}
      className="side-panel confirm-panel"
      role="alertdialog"
      aria-label={title}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || busy) return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button type="button" className="icon-button close" aria-label="Cancel" onClick={onClose}>
          <CloseGlyph />
        </button>
      </header>
      <div className="changes-confirm">
        <p>{body}</p>
        {more.map((line) => (
          <p key={line}>{line}</p>
        ))}
        <div className="edit-actions">
          {action !== null && (
            <button
              ref={yes}
              type="button"
              className={danger ? "danger" : "primary"}
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onConfirm().finally(() => setBusy(false));
              }}
            >
              {action}
            </button>
          )}
          <button ref={no} type="button" onClick={onClose} disabled={busy}>
            {keep}
          </button>
          <span className="edit-keys muted key-hint">
            {action !== null && (
              <>
                <Keys keys="Enter" /> {action.toLowerCase()}{" "}
              </>
            )}
            <Keys keys="Escape" /> {keep.toLowerCase()}
          </span>
        </div>
      </div>
    </section>
  );
}
