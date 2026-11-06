// Where the keys go back to when an overlay or panel closes: where focus was when it opened (the
// terminal, usually), else the workspace. The Sidebar's tree takes focus in App mode (ticket 29
// M4), so focus "before the tree" is what's remembered while it has it.
import { useCallback, useMemo, useRef } from "react";

export interface FocusReturn {
  /** The Sidebar's tree, while it's shown. */
  tree(): HTMLDivElement | null;
  /** Where focus was before the tree took it (the terminal), and goes back to. */
  setBeforeTree(el: Element | null): void;
  /** Where focus was before the tree, forgotten as it's read. */
  takeBeforeTree(): Element | null;
  /** Where the keys go back to if something takes them now: where focus is, or before the tree. */
  whereNow(): Element | null;
  /** Remembers `whereNow()`, for `restore`. */
  remember(): void;
  /** Focus back where `remember` found it, else the workspace. */
  restore(): void;
  /** Focus back to `el` (a `whereNow()`), else the workspace. */
  restoreTo(el: Element | null): void;
  /** Focus to `el` if there is one, else the workspace. */
  toMain(el?: HTMLElement | null): void;
}

/** `mainRef` goes on the workspace (`<main>`), where keys go when nothing else has them;
 * `treeRef` on the Sidebar's tree. */
export function useFocusReturn(): { focus: FocusReturn; mainRef: React.RefObject<HTMLElement | null>; treeRef(el: HTMLDivElement | null): void } {
  const main = useRef<HTMLElement | null>(null);
  const tree = useRef<HTMLDivElement | null>(null);
  const treeRef = useCallback((el: HTMLDivElement | null) => {
    tree.current = el;
  }, []);
  const beforeTree = useRef<Element | null>(null);
  const returnTo = useRef<Element | null>(null);
  const focus = useMemo<FocusReturn>(() => {
    const whereNow = () => ((tree.current?.contains(document.activeElement) ?? false) ? beforeTree.current : document.activeElement);
    const restoreTo = (el: Element | null) => {
      if (el instanceof HTMLElement && el.isConnected) el.focus();
      else main.current?.focus();
    };
    return {
      tree: () => tree.current,
      setBeforeTree: (el) => {
        beforeTree.current = el;
      },
      takeBeforeTree: () => {
        const el = beforeTree.current;
        beforeTree.current = null;
        return el;
      },
      whereNow,
      remember: () => {
        returnTo.current = whereNow();
      },
      restore: () => restoreTo(returnTo.current),
      restoreTo,
      toMain: (el) => (el ?? main.current)?.focus(),
    };
  }, []);
  return { focus, mainRef: main, treeRef };
}
