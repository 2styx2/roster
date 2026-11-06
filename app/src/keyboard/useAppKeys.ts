// The workspace's keys: the focus-mode machine (mode.ts) decides whether a key is the terminal's
// or the app's, caught before anything else sees it (capture phase on window), the terminal
// included. App mode with the Sidebar shown puts focus on its tree; back in Terminal mode, focus
// goes back where it was.
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { chordOf, type CommandLine, type Keymap, type Options } from "../keymap";
import { inAnyLayer, inLayer } from "../panel/stack";
import { isLeaderKey } from "../terminal/keys";
import type { FocusReturn } from "../ui/useFocusReturn";
import { press, terminalMode, type KeyState } from "./mode";

const MODIFIERS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock"]);

export interface AppKeys {
  keyState: KeyState;
  setMode(next: KeyState): void;
  /** The mode now, for an event handler (it may have changed since the last render). */
  mode(): KeyState["mode"];
  /** The Sidebar's tree took focus (Tab, a screen reader) from `from`: App mode, as after the Leader. */
  treeFocused(from: Element | null): void;
  /** Focus left the tree for `to` (Tab on, a click): the keys are the terminal's again, unless it
   * went to what App mode opened over it (a Host row's menu, the command line, a finder). */
  treeBlurred(to: Element | null): void;
}

/** The layers App mode opens over the Sidebar's tree: focus going to one keeps App mode. */
const OVER_THE_TREE = ["picker", "finder", "cmdline", "import", "row-menu"];

export function useAppKeys(opts: {
  keymap: Keymap;
  options: Options;
  /** Keys reach the app: serve is up, it's unlocked, and the workspace isn't behind the demo. */
  listening: boolean;
  /** No overlay has the keys (App mode then focuses the Sidebar's tree). */
  noOverlay: boolean;
  focus: FocusReturn;
  staysInAppMode(line: CommandLine): boolean;
  /** App mode began: the Sidebar's cursor goes where it should. */
  onAppMode(): void;
  run(line: CommandLine): void;
}): AppKeys {
  const [keyState, setKeyState] = useState<KeyState>(terminalMode);
  const keyRef = useRef<KeyState>(terminalMode);
  const setMode = useCallback((next: KeyState) => {
    keyRef.current = next;
    setKeyState(next);
  }, []);

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (MODIFIERS.has(e.key)) return;
    // A Host row's menu takes its own keys (arrows, letters, Esc), in App mode too.
    if (e.target instanceof Element && inLayer("row-menu", e.target)) return;
    // An overlay (the Picker, the command line, the bindings filter) opens in Terminal mode, so its
    // input gets the keys as a terminal would, until the Leader.
    const { options, keymap } = opts;
    const chord = isLeaderKey(e, options.leader) ? options.leader : chordOf(e);
    // A key the IME is composing with (chordOf names none) is the IME's.
    if (chord === "") return;
    const before = keyRef.current;
    const r = press(before, chord, { keymap, leader: options.leader, vim: options.vim, staysInAppMode: opts.staysInAppMode });
    if (!r.consumed) return;
    e.preventDefault();
    e.stopPropagation();
    if (before.mode === "terminal" && r.state.mode === "app") opts.onAppMode();
    setMode(r.state);
    if (r.action) opts.run(r.action);
  });
  const { listening, focus } = opts;
  // In place in the commit that shows the workspace: a Leader typed right after the unlock's Enter
  // reaches the app, not the page behind it.
  useLayoutEffect(() => {
    if (!listening) return;
    const handler = (e: KeyboardEvent) => onKey(e);
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [listening]);

  // An overlay or panel that took focus keeps it, and a Session that became active has taken it
  // already.
  const treeMode = keyState.mode === "app" && opts.noOverlay;
  useEffect(() => {
    const tree = focus.tree();
    if (treeMode) {
      if (tree && !tree.contains(document.activeElement)) {
        focus.setBeforeTree(document.activeElement);
        tree.focus({ preventScroll: true });
      }
      return;
    }
    if (keyState.mode !== "terminal") return;
    const back = focus.takeBeforeTree();
    if (back === null) return;
    // Focus is still on the tree, or was lost with it (the Sidebar hid with the view mode).
    const focused = document.activeElement;
    const lost = !focused || focused === document.body || (tree?.contains(focused) ?? false);
    if (!lost) return;
    if (back instanceof HTMLElement && back.isConnected) back.focus();
    if (document.activeElement === focused) focus.toMain();
  }, [treeMode, keyState.mode, focus]);

  const treeFocused = (from: Element | null) => {
    if (keyRef.current.mode !== "terminal") return;
    opts.focus.setBeforeTree(from);
    opts.onAppMode();
    setMode({ mode: "app", pending: [] });
  };
  const treeBlurred = (to: Element | null) => {
    if (keyRef.current.mode === "app" && to !== null && !inAnyLayer(OVER_THE_TREE, to)) {
      // Focus is already on its way to `to` (Tab on): nothing to put back, or the restore that
      // follows Terminal mode, running before it lands, would pull it back to where it came from.
      opts.focus.setBeforeTree(null);
      setMode(terminalMode);
    }
  };
  return { keyState, setMode, mode: () => keyRef.current.mode, treeFocused, treeBlurred };
}
