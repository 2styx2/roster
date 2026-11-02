import { describe, expect, it } from "vitest";
import { arrange, limitsPercent, limitsPx, PanelLayout, PANELS_KEY, stepped } from "./layout";

function store(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  return { data, get: (k: string) => data[k], set: (k: string, v: unknown) => void (data[k] = v) };
}

describe("a panel's limits", () => {
  it("keep the terminal usable beside a docked panel, and a sliver of it beside a floating one", () => {
    expect(limitsPx({ body: 1600, others: 300, floating: false })).toEqual({ min: 280, max: 900 });
    expect(limitsPx({ body: 1600, others: 0, floating: true })).toEqual({ min: 280, max: 1552 });
    // Too narrow for both: the panel's own minimum wins, and never more than the window.
    expect(limitsPx({ body: 600, others: 300, floating: false })).toEqual({ min: 280, max: 280 });
    expect(limitsPx({ body: 200, others: 0, floating: true })).toEqual({ min: 200, max: 200 });
    expect(limitsPercent({ body: 1000, others: 0, floating: false })).toEqual({ min: 28, max: 60 });
  });

  it("␣ < and ␣ > step five percent, within the limits", () => {
    expect(stepped(30, 1, { min: 20, max: 60 })).toBe(35);
    expect(stepped(58, 1, { min: 20, max: 60 })).toBe(60);
    expect(stepped(22, -1, { min: 20, max: 60 })).toBe(20);
  });
});

describe("PanelLayout", () => {
  it("the user's choice, then init.lua's views.ID, then panel.width, then the panel's own", () => {
    const s = store();
    const layout = new PanelLayout(s);
    expect(layout.place("help")).toBe("panel");
    expect(layout.place("view:topology", "full")).toBe("full");
    expect(layout.width("help")).toBeNull();
    layout.setDefaults({ width: 35, views: { topology: { place: "panel", width: 60 } } });
    expect(layout.width("help")).toBe(35);
    expect(layout.widthSource("help")).toBe("init.lua");
    expect(layout.place("view:topology", "full")).toBe("panel");
    expect(layout.width("view:topology")).toBe(60);
    layout.setPlace("view:topology", "full");
    layout.setWidth("help", 42.04);
    expect(layout.place("view:topology", "full")).toBe("full");
    expect(layout.width("help")).toBe(42);
    expect(layout.widthSource("help")).toBe("you");
    expect(s.data[PANELS_KEY]).toEqual({ help: { width: 42 }, "view:topology": { place: "full" } });
    layout.reset("help");
    expect(layout.width("help")).toBe(35);
  });

  it("reads only what it can from the State, and keeps widths in range", () => {
    const layout = new PanelLayout(store({ [PANELS_KEY]: { help: { width: 500, place: "sideways" }, keys: "wide", details: { place: "full" } } }));
    expect(layout.width("help")).toBe(95);
    expect(layout.place("help")).toBe("panel");
    expect(layout.place("details")).toBe("full");
    expect(layout.width("keys")).toBeNull();
  });

  it("acts on the panel with focus, else the one used last; the full one used last is on top", () => {
    const layout = new PanelLayout(store());
    const help = document.createElement("div");
    const view = document.createElement("div");
    const inside = document.createElement("button");
    help.append(inside);
    layout.mount("help", "Help", help, "panel");
    layout.mount("view:map", "Map", view, "full");
    expect(layout.target(null)?.id).toBe("view:map");
    expect(layout.target(inside)?.id).toBe("help");
    expect(layout.topFull()).toBe("view:map");
    layout.setPlace("help", "full");
    layout.use("help");
    expect(layout.topFull()).toBe("help");
    layout.unmount("help", help);
    expect(layout.target(null)?.id).toBe("view:map");
  });
});

describe("arranging the docked panels together (#176)", () => {
  const right = (id: string, want: number) => ({ id, side: "right" as const, want });
  const left = (id: string, want: number) => ({ id, side: "left" as const, want });

  it("docks them all while each keeps its minimum beside a 400 px terminal; CSS shares the room", () => {
    // 1600 - 300 (Sidebar) - 400 = 900: three at 280 fit, so all dock at their own width.
    const spots = arrange({ body: 1600, others: 300, forced: false }, [right("view:a", 600), right("check", 320), left("details", 320)]);
    expect([...spots.values()].every((s) => !s.float && s.width === null && s.at === 0)).toBe(true);
  });

  it("floats them all when their minimums don't fit, as a narrow window does", () => {
    // 1300 - 300 - 400 = 600 < 3 x 280.
    const spots = arrange({ body: 1300, others: 300, forced: false }, [right("view:a", 400), right("check", 320), left("details", 320)]);
    expect([...spots.values()].every((s) => s.float)).toBe(true);
  });

  it("floats sit side by side from their edge, in the order they'd dock in, never on top of each other", () => {
    const spots = arrange({ body: 1000, others: 0, forced: true }, [left("details", 300), right("view:a", 320), right("check", 280)]);
    // The last on the right is nearest the edge, as when docked; the first on the left is.
    expect(spots.get("check")).toEqual({ float: true, width: null, at: 0 });
    expect(spots.get("view:a")).toEqual({ float: true, width: null, at: 280 });
    expect(spots.get("details")).toEqual({ float: true, width: null, at: 0 });
  });

  it("floats too wide together share the window in proportion, leaving the 48 px sliver", () => {
    // 600 - 48 = 552 for 400 + 200 + 320 = 920 wanted: 0.6 of each.
    const spots = arrange({ body: 600, others: 0, forced: true }, [left("details", 320), right("view:a", 400), right("check", 200)]);
    expect(spots.get("check")).toEqual({ float: true, width: 120, at: 0 });
    expect(spots.get("view:a")).toEqual({ float: true, width: 240, at: 120 });
    expect(spots.get("details")).toEqual({ float: true, width: 192, at: 0 });
  });
});
