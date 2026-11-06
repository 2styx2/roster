// What `:info` with no Host says about this workspace: the Backend, the Box, the Inventory, the
// command that runs serve (it's the program the master password and sign-in codes go to), the
// terminal's font in use (ticket 33: the first installed one in terminal.font) and renderer (the
// visible terminal's, or with none on screen the one terminal.renderer asks for), and how long
// the Picker last took to open.
import type { BackendInfo } from "../backend/types";
import { fontInUse, type FontProbe } from "../terminal/fonts";
import type { TerminalOptions } from "../terminal/options";
import { rendererLabel, type RendererInUse } from "../terminal/renderer";

export function infoLine(o: {
  info: BackendInfo;
  terminalOptions: TerminalOptions;
  fontInstalled: FontProbe | undefined;
  fontSize: number;
  /** The renderer the terminal on screen uses; null with none on screen. */
  renderer: RendererInUse | null;
  pickerMs: number | null;
}): string {
  const { info, terminalOptions } = o;
  const font = fontInUse(terminalOptions.fonts, o.fontInstalled ?? (() => null));
  const size = `${Math.round(o.fontSize * 100) / 100} px`;
  const renderer = rendererLabel(o.renderer ?? terminalOptions.renderer);
  return (
    `Backend ${info.backend} · Box ${info.inventory.box} · Inventory ${info.inventory.path} · Command ${info.command.join(" ")} · ` +
    `Terminal ${font} ${size}, ${renderer}` +
    (o.pickerMs === null ? "" : ` · Picker opened in ${Math.round(o.pickerMs)} ms`)
  );
}
