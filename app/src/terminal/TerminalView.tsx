// One Session's terminal: xterm.js with the WebGL renderer (the DOM renderer when WebGL isn't
// there or its context is lost), fit, and search. Every key goes to the shell except the Leader
// and the keymap's `terminal` chords (copy, paste, find, zoom); see docs/app/dev/xterm-setup.md.
// Nothing is added to or rewritten in what the shell prints (decision Q37). Tests substitute a
// stub for this component (App's `terminalView`).
import { useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import type { TermSize } from "../backend/types";
import { chordOf, type Action } from "../keymap";
import type { Clipboard } from "../platform/types";
import { copyIfSelected, copySelection, pasteClipboard, rightClick } from "./clipboard";
import { isLeaderKey } from "./keys";
import { deviceAdvance, lineHeightFor, roundedCellSpacing } from "./fonts";
import type { TerminalOptions, TerminalTheme, ZoomAction } from "./options";
import { SearchBar, type SearchResults } from "./SearchBar";
import { holdWhileHidden, type OutputGate } from "./hold";
import { showRenderer, type RendererInUse, type RendererMemo } from "./renderer";

/** What every terminal shares: options, keys and the machine's services. One object, so the
 * Session list only passes it through. */
export interface TerminalEnv {
  options: TerminalOptions;
  /** The colours: the Theme's, with the options' `colors` over them. */
  theme: TerminalTheme;
  /** The current (zoomed) font size. */
  fontSize: number;
  /** For xterm's ConPTY handling; null off Windows (or not known yet). */
  windowsBuild: number | null;
  /** The keymap's `terminal` table: chords caught before the shell. */
  keys: Record<string, Action>;
  clipboard: Clipboard;
  /** A zoom key or Ctrl+wheel: the app owns the font size, so every terminal follows. */
  onZoom(action: ZoomAction): void;
  /** The view mode and the pieces around the terminal: when it changes, the terminal fits
   * itself again and tells the Session (Focus mode, ticket 22). */
  layout: string;
  /** The visible terminal's renderer, each time it's shown or the renderer changes (`:info`). */
  onRenderer(renderer: RendererInUse): void;
}

export interface TerminalViewProps {
  /** The visible tab: it fits itself and takes focus. */
  active: boolean;
  /** The Leader chord, caught before the shell sees it. */
  leader: string;
  /** Routes the Session's output (from the start) here; returns detach. */
  attach(sink: (data: Uint8Array) => void): () => void;
  /** Keys and pastes for the shell. */
  onData(data: string): void;
  onResize(size: TermSize): void;
  env: TerminalEnv;
  /** Find this text up the scrollback, from the bottom, with the search bar open on it
   * (`roster.sessions.show` with a line, ticket 78). A new `nonce` finds again. */
  reveal?: { text: string; nonce: number } | null;
}

export type TerminalViewComponent = (props: TerminalViewProps) => React.ReactNode;

/** Cells as wide as Windows Terminal's: the advance rounded to the nearest device px. The DOM
 * renderer already lays text out at the font's own advance, so it gets none (measured in
 * docs/app/design/terminal-vs-wt). */
function cellSpacing(options: TerminalOptions, size: number): number {
  if (options.renderer === "dom") return 0;
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  return roundedCellSpacing(deviceAdvance(options.fontFamily, options.fontWeight, size, dpr));
}

/** The font's own line height at `size`, as xterm measures it (a span with line-height normal);
 * 0 where there's no layout. */
function naturalHeight(options: TerminalOptions, size: number): number {
  if (typeof document === "undefined") return 0;
  const span = document.createElement("span");
  span.textContent = "W";
  span.style.cssText = `position:absolute;visibility:hidden;white-space:pre;line-height:normal;font:${options.fontWeight} ${size}px ${options.fontFamily}`;
  document.body.appendChild(span);
  const h = span.getBoundingClientRect().height;
  span.remove();
  return h;
}

/** The theme without the app's own entries (search highlights), as xterm takes it. */
function xtermTheme(t: TerminalTheme): ITheme {
  const theme: Partial<TerminalTheme> = { ...t };
  delete theme.searchMatch;
  delete theme.searchActiveMatch;
  return theme;
}

export function TerminalView({ active, leader, attach, onData, onResize, env, reveal = null }: TerminalViewProps) {
  const el = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const gate = useRef<OutputGate | null>(null);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResults | null>(null);
  // Latest props, read by handlers registered once.
  const cb = useRef({ leader, onData, onResize, env, openSearch: () => {} });
  useEffect(() => {
    cb.current = { leader, onData, onResize, env, openSearch: () => setSearching(true) };
  });

  useEffect(() => {
    const host = el.current;
    if (!host) return;
    const { options } = cb.current.env;
    const t = new Terminal({
      scrollback: options.scrollback,
      allowProposedApi: true,
      fontFamily: options.fontFamily,
      fontSize: cb.current.env.fontSize,
      fontWeight: options.fontWeight,
      fontWeightBold: options.fontWeightBold,
      lineHeight: lineHeightFor(options, cb.current.env.fontSize, () => naturalHeight(options, cb.current.env.fontSize)),
      cursorStyle: options.cursorStyle,
      drawBoldTextInBrightColors: options.boldIsBright,
      letterSpacing: cellSpacing(options, cb.current.env.fontSize),
      theme: xtermTheme(cb.current.env.theme),
    });
    const f = new FitAddon();
    const s = new SearchAddon();
    t.loadAddon(f);
    t.loadAddon(s);
    t.open(host);
    // data-renderer says which one it got (devtools; `:info` hears it through env.onRenderer).
    // WebGL comes and goes with `active` (below).
    host.dataset.renderer = "dom";

    const copy = () => copySelection(t, cb.current.env.clipboard);
    const paste = () => void pasteClipboard(t, cb.current.env.clipboard);

    // The Leader never reaches the shell (Ctrl+Space would send NUL); App's keymap acts on it.
    // The keymap's terminal chords don't either; they act on keydown only.
    t.attachCustomKeyEventHandler((e) => {
      if (isLeaderKey(e, cb.current.leader)) {
        e.preventDefault();
        return false;
      }
      const action = cb.current.env.keys[chordOf(e)];
      if (!action?.startsWith("terminal.")) return true;
      if (action === "terminal.copyIfSelected") {
        // Only a keydown with a selection is ours; anything else (^C) goes to the shell.
        if (e.type !== "keydown" || !copyIfSelected(t, cb.current.env.clipboard)) return true;
        e.preventDefault();
        return false;
      }
      e.preventDefault();
      if (e.type !== "keydown") return false;
      switch (action) {
        case "terminal.copy":
          copy();
          break;
        case "terminal.paste":
          paste();
          break;
        case "terminal.search":
          cb.current.openSearch();
          break;
        case "terminal.zoomIn":
        case "terminal.zoomOut":
        case "terminal.zoomReset":
          cb.current.env.onZoom(action);
          break;
      }
      return false;
    });

    // Select to copy (xterm has no option for it).
    let copyTimer: ReturnType<typeof setTimeout> | undefined;
    const onSelection = t.onSelectionChange(() => {
      if (!cb.current.env.options.copyOnSelect) return;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(copy, 120);
    });
    // Right-click: copy the selection, or paste when there's none (as Windows Terminal).
    const onContextMenu = (e: MouseEvent) => {
      if (!cb.current.env.options.rightClickCopyPaste) return;
      e.preventDefault();
      void rightClick(t, cb.current.env.clipboard);
      t.focus();
    };
    // Ctrl+wheel zooms the terminal, not the page.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || e.deltaY === 0) return;
      e.preventDefault();
      e.stopPropagation();
      cb.current.env.onZoom(e.deltaY < 0 ? "terminal.zoomIn" : "terminal.zoomOut");
    };
    host.addEventListener("contextmenu", onContextMenu);
    host.addEventListener("wheel", onWheel, { capture: true, passive: false });

    const subs = [
      onSelection,
      t.onData((d) => cb.current.onData(d)),
      t.onResize(({ cols, rows }) => cb.current.onResize({ cols, rows })),
      s.onDidChangeResults(({ resultIndex, resultCount }) => setResults({ index: resultIndex, count: resultCount })),
    ];
    // Off screen, the Session's output waits (hold.ts): xterm would redraw the hidden rows anyway.
    const g = holdWhileHidden((d) => t.write(d));
    gate.current = g;
    const detach = attach((d) => g.write(d));
    term.current = t;
    fit.current = f;
    search.current = s;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (host.offsetParent !== null) f.fit();
      }, 30);
    });
    observer.observe(host);
    return () => {
      clearTimeout(timer);
      clearTimeout(copyTimer);
      observer.disconnect();
      host.removeEventListener("contextmenu", onContextMenu);
      host.removeEventListener("wheel", onWheel, { capture: true });
      detach();
      for (const sub of subs) sub.dispose();
      t.dispose();
      term.current = null;
      gate.current = null;
      fit.current = null;
      search.current = null;
    };
    // attach belongs to this tab for its whole life
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The WebGL renderer only while the terminal is on screen. A browser keeps about 16 WebGL
  // contexts and drops the oldest past that, so 50 open Sessions each holding one left blank,
  // lost canvases behind (ticket 27). A hidden terminal draws nothing, so it gives its context
  // back and the DOM renderer keeps its state; showing it again takes a fresh one. Where WebGL
  // can't start (WebKitGTK, WSLg, a VM: ticket 20) or its context is lost, the DOM renderer draws
  // (renderer.ts), and the visible terminal tells the app which one it has, for `:info`.
  const memo = useRef<RendererMemo>({ noWebgl: false });
  const renderer = env.options.renderer;
  useEffect(() => {
    const t = term.current;
    const host = el.current;
    if (!active || !t || !host) return;
    const load = (onLoss: () => void) => {
      const webgl = new WebglAddon();
      webgl.onContextLoss(onLoss);
      try {
        t.loadAddon(webgl);
      } catch (e) {
        try {
          webgl.dispose();
        } catch {
          // half-loaded: nothing more to give back
        }
        throw e;
      }
      return webgl;
    };
    const hide = showRenderer(renderer, memo.current, load, (r) => {
      host.dataset.renderer = r;
      cb.current.env.onRenderer(r);
    });
    return () => {
      hide();
      host.dataset.renderer = "dom";
    };
  }, [active, renderer]);

  // ConPTY sits between us and the shell on Windows (WSL included); xterm adapts its reflow to
  // the real build (>= 21376 keeps reflow on).
  const { windowsBuild, fontSize, options, theme } = env;
  useEffect(() => {
    const t = term.current;
    if (!t) return;
    t.options.windowsPty = windowsBuild === null ? {} : { backend: "conpty", buildNumber: windowsBuild };
  }, [windowsBuild]);

  useEffect(() => {
    const t = term.current;
    if (!t) return;
    t.options.theme = xtermTheme(theme);
    let live = true;
    const apply = () => {
      if (!live) return;
      t.options.fontFamily = options.fontFamily;
      t.options.fontWeight = options.fontWeight;
      t.options.fontWeightBold = options.fontWeightBold;
      t.options.lineHeight = lineHeightFor(options, fontSize, () => naturalHeight(options, fontSize));
      t.options.cursorStyle = options.cursorStyle;
      t.options.drawBoldTextInBrightColors = options.boldIsBright;
      t.options.letterSpacing = cellSpacing(options, fontSize);
      t.options.scrollback = options.scrollback;
      if (t.options.fontSize !== fontSize) t.options.fontSize = fontSize;
      if (el.current?.offsetParent !== null) fit.current?.fit();
    };
    // xterm measures its cells when the font changes, so a font (or weight) the Config just
    // picked must be loaded first; a bundled one is, and this resolves at once.
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    if (fonts && t.options.fontFamily !== options.fontFamily) {
      const spec = (w: number) => `${w} ${fontSize}px ${options.fontFamily}`;
      Promise.all([fonts.load(spec(options.fontWeight)), fonts.load(spec(options.fontWeightBold))]).then(apply, apply);
    } else {
      apply();
    }
    return () => {
      live = false;
    };
  }, [fontSize, options, theme]);

  // Moving the window to a screen with another scale changes the device px a cell rounds to.
  const [dpr, setDpr] = useState(() => (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1));
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => {
      const t = term.current;
      if (t) t.options.letterSpacing = cellSpacing(cb.current.env.options, cb.current.env.fontSize);
      setDpr(window.devicePixelRatio || 1);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [dpr]);

  // A view mode change resizes the window (OS fullscreen) after the layout does, so fit again
  // once it has settled; the ResizeObserver catches most of it, this catches the rest.
  const { layout } = env;
  const firstLayout = useRef(true);
  useEffect(() => {
    if (firstLayout.current) {
      firstLayout.current = false;
      return;
    }
    const t = term.current;
    if (!active || !t) return;
    const refit = () => {
      if (el.current?.offsetParent === null) return;
      fit.current?.fit();
      cb.current.onResize({ cols: t.cols, rows: t.rows });
    };
    const frame = requestAnimationFrame(refit);
    const late = setTimeout(refit, 300);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(late);
    };
  }, [layout, active]);

  useEffect(() => {
    const t = term.current;
    if (!active) gate.current?.hide();
    if (!active || !t) return;
    gate.current?.show();
    fit.current?.fit();
    cb.current.onResize({ cols: t.cols, rows: t.rows });
    t.focus();
  }, [active]);

  // A Plugin's "go to the line" (ticket 78): from the bottom, the latest line with the text, in the
  // search bar the user knows, so Enter goes on up and Esc closes it.
  const [seed, setSeed] = useState({ text: "", n: 0 });
  const revealed = useRef<number | null>(null);
  useEffect(() => {
    if (!active || !reveal || revealed.current === reveal.nonce) return;
    revealed.current = reveal.nonce;
    term.current?.scrollToBottom();
    term.current?.clearSelection();
    setSeed((x) => ({ text: reveal.text, n: x.n + 1 }));
    setSearching(true);
  }, [active, reveal]);

  function find(query: string, direction: "next" | "previous", incremental: boolean) {
    const s = search.current;
    if (!s) return;
    if (!query) {
      s.clearDecorations();
      setResults(null);
      return;
    }
    const { searchMatch, searchActiveMatch } = env.theme;
    const opts = {
      decorations: {
        matchBackground: searchMatch,
        matchOverviewRuler: searchMatch,
        activeMatchBackground: searchActiveMatch,
        activeMatchColorOverviewRuler: searchActiveMatch,
      },
    };
    // Scrollback is above, so "previous" walks up, as in Windows Terminal. While typing, start
    // again from the bottom: the newest match of what's typed so far.
    if (incremental) term.current?.clearSelection();
    if (direction === "previous") s.findPrevious(query, opts);
    else s.findNext(query, opts);
  }

  function closeSearch() {
    search.current?.clearDecorations();
    term.current?.clearSelection();
    setSearching(false);
    setResults(null);
    setSeed((x) => ({ text: "", n: x.n }));
    term.current?.focus();
  }

  return (
    <div className="term-wrap">
      <div className="term-host" ref={el} />
      {searching && active && <SearchBar key={seed.n} initial={seed.text} results={results} onFind={find} onClose={closeSearch} />}
    </div>
  );
}
