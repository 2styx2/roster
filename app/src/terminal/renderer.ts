// Which renderer a terminal draws with (ticket 20). xterm.js's WebGL renderer when a WebGL2
// context can be had, else its built-in DOM renderer. On WebKitGTK (Linux), WSLg and VMs the
// context can fail to start (the addon's load throws) or be lost later; either way the terminal
// keeps drawing with the DOM renderer, and `:info` says which one the visible terminal uses.

/** The renderer in use, and why it isn't WebGL. */
export type RendererInUse =
  | "webgl"
  /** The DOM renderer because `terminal.renderer = "dom"` asked for it. */
  | "dom"
  /** The DOM renderer because no WebGL2 context could be made here. */
  | "dom-unavailable"
  /** The DOM renderer because the WebGL context was lost (until the terminal is shown again). */
  | "dom-lost";

const LABELS: Record<RendererInUse, string> = {
  webgl: "WebGL",
  dom: "DOM",
  "dom-unavailable": "DOM (no WebGL here)",
  "dom-lost": "DOM (WebGL context lost)",
};

/** How `:info` names it. */
export const rendererLabel = (r: RendererInUse): string => LABELS[r];

export interface Disposable {
  dispose(): void;
}

/** Loads WebGL with `load` (which makes the addon, hands it `onLoss` and loads it into the
 * terminal) and reports what the terminal draws with. Returns stop, which gives the context back
 * without a report (the terminal is being hidden), or null when WebGL couldn't load at all. */
export function loadWebgl(load: (onLoss: () => void) => Disposable, report: (r: RendererInUse) => void): (() => void) | null {
  let addon: Disposable | null = null;
  const release = () => {
    const a = addon;
    addon = null;
    a?.dispose();
  };
  try {
    addon = load(() => {
      release();
      report("dom-lost");
    });
  } catch {
    report("dom-unavailable");
    return null;
  }
  report("webgl");
  return release;
}

/** What a terminal remembers between showings: WebGL failed to load once, so it won't again. */
export interface RendererMemo {
  noWebgl: boolean;
}

/** A terminal coming on screen: the renderer it asks for (`terminal.renderer`), WebGL loaded with
 * `load` unless it asked for DOM or WebGL already failed here. Reports what it got; returns what
 * to do when it goes off screen (give the WebGL context back: a browser keeps about 16). */
export function showRenderer(
  want: "webgl" | "dom",
  memo: RendererMemo,
  load: (onLoss: () => void) => Disposable,
  report: (r: RendererInUse) => void,
): () => void {
  if (want === "dom") {
    report("dom");
    return () => {};
  }
  if (memo.noWebgl) {
    report("dom-unavailable");
    return () => {};
  }
  const stop = loadWebgl(load, (r) => {
    if (r === "dom-unavailable") memo.noWebgl = true;
    report(r);
  });
  return stop ?? (() => {});
}
