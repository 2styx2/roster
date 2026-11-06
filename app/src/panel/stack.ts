// The panels and dialogs over the workspace, as one stack: each opens remembering where the keys
// were and closes giving them back, and Esc (`hidepanel`) closes the topmost one open. Their order
// is one list (the workspace's), from the top down, rather than a chain of ifs. A layer is known
// by its id: its element carries `data-panel={id}`, never a class name.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FocusReturn } from "../ui/useFocusReturn";

export interface Layer {
  id: string;
  open: boolean;
  close(): void;
  /** Open, and can't be closed now (a confirmed `:inventory` switch running): Esc stops here. */
  held?(): boolean;
}

/** Whether `el` (the focused element by default) is inside the layer `id`: its element carries
 * `data-panel={id}` (a PanelFrame does, and so does each layer drawn outside one). */
export function inLayer(id: string, el: Element | null = document.activeElement): boolean {
  return el?.closest(`[data-panel="${id}"]`) != null;
}

/** Whether `el` is inside any of the layers `ids`. */
export const inAnyLayer = (ids: readonly string[], el: Element | null = document.activeElement): boolean => ids.some((id) => inLayer(id, el));

/** Closes the topmost open layer of `layers` (top first); false when none is open. */
export function closeTop(layers: readonly Layer[]): boolean {
  const top = layers.find((l) => l.open);
  if (!top) return false;
  if (!top.held?.()) top.close();
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
  /** Its place in the stack. */
  layer: Layer;
}

/** One panel's state: what it shows, and its open and close that remember and give back focus.
 * `fromInside`: a close gives the keys back only when they're in it (a panel a key toggles from
 * anywhere, like the Key bindings). */
export function usePanelState<T>(focus: Pick<FocusReturn, "remember" | "restore">, id: string, { fromInside = false } = {}): PanelState<T> {
  const [value, set] = useState<T | null>(null);
  const open = useCallback(
    (next: T) => {
      if (value === null) focus.remember();
      set(next);
    },
    [value, focus],
  );
  const close = useCallback(() => {
    const inside = inLayer(id);
    set(null);
    if (!fromInside || inside) focus.restore();
  }, [focus, id, fromInside]);
  return useMemo(() => ({ value, open, set, close, layer: { id, open: value !== null, close } }), [value, open, close, id]);
}

/** A layer whose open state is kept outside React (`:help`'s HelpView, a Plugin's question or
 * float), as `key()` says it (null: closed; a new key is a new one). As the store changes, before
 * the panel draws and takes the keys, it remembers where they were (unless they're in it already);
 * as it closes, it gives them back if they were in it or nowhere. Esc (the layer's `close`) gives
 * them back either way, as a panel's does. */
export function useStoreLayer(
  focus: Pick<FocusReturn, "whereNow" | "restoreTo">,
  id: string,
  store: { subscribe(listener: () => void): () => void },
  key: () => string | null,
  closeStore: () => void,
): Layer {
  const [back] = useState(() => ({ to: null as Element | null }));
  useEffect(() => {
    let was = key();
    return store.subscribe(() => {
      const now = key();
      if (now === was) return;
      const at = document.activeElement;
      if (now !== null && !inLayer(id)) back.to = focus.whereNow();
      else if (now === null && (inLayer(id) || at === null || at === document.body)) focus.restoreTo(back.to);
      was = now;
    });
  }, [focus, id, store, key, back]);
  const open = key() !== null;
  return useMemo(
    () => ({
      id,
      open,
      close: () => {
        closeStore();
        focus.restoreTo(back.to);
      },
    }),
    [id, open, closeStore, focus, back],
  );
}
