// What every screen sits in, the lock and error screens too: the custom title bar (decision Q32),
// so the window can always be moved and closed, with the toolbar (decision Q65) in it once the app
// is ready and unlocked (else a bar of its own); the tutor's banner; the Config's toast; Plugins'
// notices. The view mode's layout says whether the title bar shows at all.
import type { ReactNode } from "react";
import type { Keymap } from "../keymap";
import { keyHint } from "../keymap";
import type { Platform } from "../platform/types";
import { isShown, type ModeLayout } from "../view/layout";
import { TitleBar } from "./TitleBar";
import { Toolbar, type ToolbarContext, type ToolbarControlDef } from "./toolbar";

export interface WindowFrameProps {
  layout: ModeLayout;
  controls: Platform["window"];
  toolbar: { controls: readonly ToolbarControlDef[]; ctx: ToolbarContext; keymap: Keymap; leader: string; run(line: string): void };
  /** Drawn under the title bar (the tutor's banner). */
  banner: ReactNode;
  /** Drawn over the body (the Config's toast, Plugins' notices). */
  over: ReactNode;
  children: ReactNode;
}

export function WindowFrame({ layout, controls, toolbar: t, banner, over, children }: WindowFrameProps) {
  const toolbar = (side: "start" | "end") => (
    <Toolbar controls={t.controls} ctx={t.ctx} keysFor={(command) => keyHint(t.keymap, command)} leader={t.leader} run={t.run} side={side} />
  );
  const titlebar = isShown(layout, "titlebar");
  return (
    <div className="window">
      {titlebar && <TitleBar controls={controls} start={toolbar("start")} end={toolbar("end")} />}
      {!titlebar && t.controls.length > 0 && (
        <div className="toolbar-bar" data-tauri-drag-region>
          {toolbar("start")}
          <div className="titlebar-fill" />
          {toolbar("end")}
        </div>
      )}
      {banner}
      <div className="window-body">{children}</div>
      {over}
    </div>
  );
}
