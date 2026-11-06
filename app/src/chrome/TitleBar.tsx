// The custom title bar (decision Q32, "bare"): the mark and the name on the left, then minimize,
// maximize and close on the right, drawn as thin line glyphs; close turns red under the pointer.
// The bar is a Tauri drag region: drag moves the window (and snaps it to screen edges on
// Windows), double-click maximizes. The buttons never take focus from the terminal.
import { useEffect, useState } from "react";
import type { WindowControls } from "../platform/types";
import { Logo } from "./Logo";
import { keepFocus } from "../ui/keepFocus";


const GLYPHS = {
  minimize: <path d="M0.5 5.5h9" />,
  maximize: <rect x="0.5" y="0.5" width="9" height="9" />,
  restore: (
    <>
      <rect x="0.5" y="2.5" width="7" height="7" />
      <path d="M2.5 2.5v-2h7v7h-2" />
    </>
  ),
  close: <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />,
};

function Glyph({ name }: { name: keyof typeof GLYPHS }) {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
      {GLYPHS[name]}
    </svg>
  );
}

export function TitleBar({
  controls,
  title = "Roster",
  start,
  end,
}: {
  controls?: WindowControls | undefined;
  title?: string;
  /** The toolbar's controls by the mark (the Sidebar's toggle). */
  start?: React.ReactNode;
  /** The toolbar's controls by the window's buttons (decision Q65). */
  end?: React.ReactNode;
}) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => controls?.watchMaximized(setMaximized), [controls]);

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-mark" data-tauri-drag-region>
        <Logo size={16} />
        <span className="wordmark" data-tauri-drag-region>
          {title}
        </span>
      </div>
      {start}
      <div className="titlebar-fill" data-tauri-drag-region />
      {end}
      {controls && (
        <div className="window-controls">
          <button type="button" tabIndex={-1} aria-label="Minimize" onMouseDown={keepFocus} onClick={controls.minimize}>
            <Glyph name="minimize" />
          </button>
          <button
            type="button"
            tabIndex={-1}
            aria-label={maximized ? "Restore" : "Maximize"}
            onMouseDown={keepFocus}
            onClick={controls.toggleMaximize}
          >
            <Glyph name={maximized ? "restore" : "maximize"} />
          </button>
          <button type="button" tabIndex={-1} className="close" aria-label="Close" onMouseDown={keepFocus} onClick={controls.close}>
            <Glyph name="close" />
          </button>
        </div>
      )}
    </header>
  );
}
