// A stand-in for TerminalView in UI tests (xterm needs a real browser): shows the Session's
// output as text, and its input sends keys the way xterm would, keeping the Leader back. (Copy,
// paste, find and zoom need xterm itself: they're checked by hand, see ticket 08.) Its font and
// colours are on data attributes, so tests can see the Config reach the terminal.
import { useEffect, useRef, useState } from "react";
import type { TerminalViewComponent, TerminalViewProps } from "./TerminalView";
import { showRenderer, type RendererInUse, type RendererMemo } from "./renderer";
import type { TermSize } from "../backend/types";
import type { ViewMode } from "../view/layout";
import { isLeaderKey } from "./keys";

const KEYS: Record<string, string> = { Escape: "\x1b", Enter: "\r" };

/** The size the stub "fits" to in each view mode, so tests can see a resize reach the Session. */
export const STUB_SIZES = {
  standard: { cols: 100, rows: 30 },
  focus: { cols: 132, rows: 43 },
} satisfies Record<ViewMode, TermSize>;

/** What the stub's WebGL does when it's shown (ticket 20): load, fail to start (no WebGL2
 * context, as on some WebKitGTK, WSLg and VM setups), or load and then lose its context. */
export type StubWebgl = "works" | "fails" | "lost";

/** A stub whose renderer behaves as `webgl` says, through the same code as TerminalView
 * (renderer.ts). */
export function stubTerminalWith({ webgl }: { webgl: StubWebgl }): TerminalViewComponent {
  const load = (onLoss: () => void) => {
    if (webgl === "fails") throw new Error("WebGL2 not supported");
    if (webgl === "lost") queueMicrotask(onLoss);
    return { dispose() {} };
  };
  return function StubTerminalWebgl(props: TerminalViewProps) {
    return <Stub {...props} load={load} />;
  };
}

/** The plain stub: WebGL always loads. */
export function StubTerminal(props: TerminalViewProps) {
  return <Stub {...props} load={WORKS} />;
}

const WORKS = () => ({ dispose() {} });

function Stub({
  active,
  leader,
  attach,
  onData,
  onResize,
  env,
  reveal = null,
  load,
}: TerminalViewProps & { load: (onLoss: () => void) => { dispose(): void } }) {
  // Like TerminalView: the renderer while on screen, told to the app.
  const memo = useRef<RendererMemo>({ noWebgl: false });
  const [renderer, setRenderer] = useState<RendererInUse>("dom");
  const want = env.options.renderer;
  const report = useRef(env.onRenderer);
  useEffect(() => {
    report.current = env.onRenderer;
  });
  useEffect(() => {
    if (!active) return;
    const hide = showRenderer(want, memo.current, load, (r) => {
      setRenderer(r);
      report.current(r);
    });
    return () => {
      hide();
      setRenderer("dom");
    };
  }, [active, want, load]);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => attach((d) => setText((t) => t + new TextDecoder().decode(d))), [attach]);
  // Like TerminalView: a layout change (not the first one) fits again and tells the Session.
  const mode = env.layout.split(" ")[0] ?? "";
  const seen = useRef(mode);
  useEffect(() => {
    if (!active || seen.current === mode) return;
    seen.current = mode;
    onResize(STUB_SIZES[mode as ViewMode] ?? { cols: 80, rows: 24 });
  }, [mode, active, onResize]);
  // Like TerminalView: the tab that becomes active takes focus.
  useEffect(() => {
    if (active) input.current?.focus();
  }, [active]);
  return (
    <div
      hidden={!active}
      data-font={env.options.fontFamily}
      data-weight={env.options.fontWeight}
      data-weight-bold={env.options.fontWeightBold}
      data-size={env.fontSize}
      data-background={env.theme.background}
      data-renderer={renderer}
      data-find={reveal?.text}
    >
      <pre aria-label="terminal output">{text}</pre>
      <input
        aria-label="terminal input"
        ref={input}
        onKeyDown={(e) => {
          if (isLeaderKey(e, leader)) return e.preventDefault();
          const data = KEYS[e.key] ?? (e.key.length === 1 ? e.key : "");
          if (data) {
            e.preventDefault();
            onData(data);
          }
        }}
      />
    </div>
  );
}
