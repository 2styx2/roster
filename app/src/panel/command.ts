// `:panel` (ticket 95, decision Q106): the panel with focus, else the one used last, docked or
// full window, wider or narrower, or back to its default. `␣ z` toggles full window (tmux's
// zoom), `␣ <` and `␣ >` narrow and widen it (Vim's Ctrl+W < and >). It stays in App mode, so
// `>` again widens again until Esc.
import type { CommandDef } from "../commands/table";
import type { Registries } from "../registries";
import { BUILTIN } from "../registry";
import { quiet, type Message } from "../ui/messages";
import { MAX_PERCENT, MIN_PERCENT, limitsPercent, stepped, type PanelLayout } from "./layout";
import { currentPercent, roomOf } from "./PanelFrame";

export const PANEL_WORDS = ["toggle", "full", "dock", "wider", "narrower", "width", "reset"] as const;

const LABELS: Record<string, string> = {
  toggle: "Switch the panel between docked and full window",
  full: "Make the panel full window",
  dock: "Dock the panel beside the terminal",
  wider: "Widen the docked panel",
  narrower: "Narrow the docked panel",
  width: "Set the docked panel's width (percent of the window)",
  reset: "Put the panel back to its default place and width",
};

/** What `:panel WORD` does to the target panel; returns what to tell the user: its new place or
 * width is quiet (ticket 111), shown with every message on; what it couldn't do always shows. */
export function panelAction(layout: PanelLayout, arg: string | undefined): Message {
  const [word = "toggle", value] = (arg ?? "").trim().split(/\s+/).filter(Boolean);
  if (!(PANEL_WORDS as readonly string[]).includes(word)) return `panel takes ${PANEL_WORDS.join(", ")}`;
  const t = layout.target();
  if (!t) return "No panel is open";
  const place = layout.place(t.id, t.fallback);
  const lim = limitsPercent(roomOf(t.el));
  const now = currentPercent(t.el, layout, t.id);
  switch (word) {
    case "toggle":
    case "full":
    case "dock": {
      const next = word === "toggle" ? (place === "full" ? "panel" : "full") : word === "full" ? "full" : "panel";
      layout.setPlace(t.id, next);
      return quiet(next === "full" ? `${t.title}: full window` : `${t.title}: docked`);
    }
    case "wider": {
      if (place === "full") return `${t.title} is full window already`;
      const next = stepped(now, 1, lim);
      if (next <= now) return `${t.title} is as wide as it goes beside the terminal: ␣ z makes it full window`;
      layout.setWidth(t.id, next);
      return quiet(`${t.title}: ${Math.round(next)}% of the window`);
    }
    case "narrower": {
      // From full window, narrower puts it back beside the terminal.
      if (place === "full") {
        layout.setPlace(t.id, "panel");
        return quiet(`${t.title}: docked`);
      }
      const next = stepped(now, -1, lim);
      if (next >= now) return `${t.title} is as narrow as it goes`;
      layout.setWidth(t.id, next);
      return quiet(`${t.title}: ${Math.round(next)}% of the window`);
    }
    case "width": {
      const n = Number(value);
      if (!value || !Number.isFinite(n) || n < MIN_PERCENT || n > MAX_PERCENT) return `panel width takes a percent of the window, ${MIN_PERCENT} to ${MAX_PERCENT}`;
      layout.setWidth(t.id, n);
      if (place === "full") layout.setPlace(t.id, "panel");
      return n > lim.max ? `${t.title}: ${n}% kept; this window fits ${Math.round(lim.max)}%` : quiet(`${t.title}: ${n}% of the window`);
    }
    default:
      layout.reset(t.id);
      return quiet(`${t.title}: back to its default place and width`);
  }
}

export function panelCommand(layout: PanelLayout): CommandDef {
  return {
    id: "panel",
    source: BUILTIN,
    area: "View",
    arg: "text",
    optionalArg: true,
    staysInAppMode: true,
    label: (a) => LABELS[(a ?? "").split(" ")[0] || "toggle"] ?? LABELS.toggle ?? "",
    doc: "Acts on the panel or view with focus, else the one used last: `:panel` (or `toggle`) switches it between docked beside the terminal and full window, `full` and `dock` choose one, `wider` and `narrower` step its width by 5% of the window, `width N` sets it to N% (10 to 95), and `reset` forgets your choice so [`views` and `panel.width`](options) in init.lua, or the panel's own default, apply again. Its edge drags too, and the header's button switches it. The choice is kept in the State, per panel.",
    run: (ctx, arg) => ctx.say(panelAction(layout, arg)),
    complete: (arg) => PANEL_WORDS.filter((w) => w.startsWith(arg)),
  };
}

export function registerPanel(registries: Registries, layout: PanelLayout): () => void {
  return registries.commands.register(panelCommand(layout));
}
