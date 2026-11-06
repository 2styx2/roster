// The panels and dialogs over the workspace, as one stack: each opens remembering where the keys
// were and closes giving them back, and Esc (`hidepanel`) closes the topmost one open. Their order
// is one list (the workspace's), from the top down, rather than a chain of ifs.
import { useCallback, useMemo, useState } from "react";
import type { FocusReturn } from "../ui/useFocusReturn";

export interface Layer {
  id: string;
  open: boolean;
  close(): void;
  /** Open, and can't be closed now (a confirmed `:inventory` switch running): Esc stops here. */
  held?: boolean;
}

/** Whether `el` (the focused element by default) is inside the layer `id`: its element carries
 * `data-panel={id}` (a PanelFrame does, and so does each layer drawn outside one). */
export function inLayer(id: string, el: Element | null = document.activeElement): boolean {
  return el?.closest(`[data-panel="${id}"]`) != null;
}

/** Closes the topmost open layer of `layers` (top first); false when none is open. */
export function closeTop(layers: readonly Layer[]): boolean {
  const top = layers.find((l) => l.open);
  if (!top) return false;
  if (!top.held) top.close();
  return true;
}

export interface PanelState<T> {
  /** What it shows, or null while it's closed. */
  value: T | null;
  /** Opens it with `value` (or shows that instead), remembering where the keys were if it was closed. */
  open(value: T): void;
  /** Changes what it shows without moving focus (null closes it the same way). */
  set(value: T | null | ((now: T | null) => T | null)): void;
  /** Closes it; the keys go back where they were. */
  close(): void;
}

/** One panel's state: what it shows, and its open and close that remember and give back focus. */
export function usePanelState<T>(focus: Pick<FocusReturn, "remember" | "restore">): PanelState<T> {
  const [value, set] = useState<T | null>(null);
  const open = useCallback(
    (next: T) => {
      if (value === null) focus.remember();
      set(next);
    },
    [value, focus],
  );
  const close = useCallback(() => {
    set(null);
    focus.restore();
  }, [focus]);
  return useMemo(() => ({ value, open, set, close }), [value, open, close]);
}
