// The view mode's commands (decision Q36): `:mode`, `:focus`.
import type { AppContext, CommandDef } from "../commands/table";
import { BUILTIN } from "../registry";
import { VIEW_MODES, type ViewMode } from "./layout";

/** What the view mode's commands ask of the app. */
export interface ViewContext {
  viewMode(): ViewMode;
  /** Switches to `mode`, or to the other one. */
  setViewMode(mode: ViewMode | null): void;
}

type ViewCommand = CommandDef<ViewContext & AppContext>;

export const viewCommands: readonly ViewCommand[] = [
  {
    id: "mode",
    source: BUILTIN,
    area: "View",
    arg: "text",
    optionalArg: true,
    label: (m) => (m ? `Switch to ${m} mode` : "Switch the view mode"),
    run: (ctx, m) => {
      if (m === undefined) return ctx.setViewMode(null);
      const mode = VIEW_MODES.find((v) => v === m.toLowerCase());
      if (!mode) return ctx.say(`Not a view mode: ${m} (${VIEW_MODES.join(", ")})`);
      ctx.setViewMode(mode);
    },
    complete: (m) => VIEW_MODES.filter((v) => v.startsWith(m.toLowerCase())),
  },
  {
    id: "focus",
    source: BUILTIN,
    area: "View",
    label: () => "Focus mode on or off",
    run: (ctx) => ctx.setViewMode(ctx.viewMode() === "focus" ? "standard" : "focus"),
  },
];
