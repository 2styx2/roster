// The window's controls inside Tauri: the title bar's buttons, and its geometry for the State.
// While maximized, the geometry kept is the last un-maximized one plus `maximized: true`, so the
// next start opens maximized and un-maximizing goes back to the size you had.
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { WindowControls, WindowGeometry } from "./types";

/** How long the window must stay still before its geometry is saved. */
const SETTLE_MS = 400;

export function tauriWindow(): WindowControls {
  const w = getCurrentWindow();

  async function geometry(): Promise<Omit<WindowGeometry, "maximized">> {
    const [pos, size] = await Promise.all([w.outerPosition(), w.innerSize()]);
    return { x: pos.x, y: pos.y, width: size.width, height: size.height };
  }

  /** Listens to moves and resizes; returns stop (safe to call before the listeners are set). */
  function onMoveOrResize(handler: () => void): () => void {
    let stopped = false;
    const unlisten: (() => void)[] = [];
    for (const listen of [w.onResized.bind(w), w.onMoved.bind(w)]) {
      void listen(handler).then((u) => (stopped ? u() : unlisten.push(u)));
    }
    return () => {
      stopped = true;
      unlisten.forEach((u) => u());
    };
  }

  return {
    minimize: () => void w.minimize(),
    toggleMaximize: () => void w.toggleMaximize(),
    close: () => void w.close(),
    watchMaximized(onChange) {
      let last: boolean | null = null;
      const check = () =>
        void w.isMaximized().then((m) => {
          if (m !== last) onChange((last = m));
        });
      check();
      return onMoveOrResize(check);
    },
    watchGeometry(onSettle) {
      let normal: Omit<WindowGeometry, "maximized"> | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = async () => {
        const [minimized, maximized] = await Promise.all([w.isMinimized(), w.isMaximized()]);
        if (minimized) return;
        if (!maximized) normal = await geometry();
        const g = normal ?? (await geometry());
        onSettle({ ...g, maximized });
      };
      // What it is at the start, so a window that opens maximized still knows its normal size.
      void Promise.all([w.isMaximized(), geometry()]).then(([m, g]) => {
        if (!m) normal = g;
      });
      const stop = onMoveOrResize(() => {
        clearTimeout(timer);
        // The window's geometry can't be read while it closes; the next move or resize saves it again.
        timer = setTimeout(() => void settle().catch(() => {}), SETTLE_MS);
      });
      return () => {
        clearTimeout(timer);
        stop();
      };
    },
  };
}
