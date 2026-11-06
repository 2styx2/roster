// Where a Host row's menu goes (T166, Q156): at the pointer, kept inside the window, flipped above
// the row when there's no room under it. jsdom lays nothing out, so the arithmetic is checked here.
import { describe, expect, it } from "vitest";
import { placeMenu } from "./RowMenu";
import { hostMenu, type HostMenuOptions } from "./hostMenu";
import type { SidebarRow } from "./model";

const view = { width: 1000, height: 700 };
const size = { width: 220, height: 300 };

describe("placeMenu", () => {
  it("opens at the point when it fits", () => {
    expect(placeMenu({ x: 100, y: 100 }, size, view)).toEqual({ left: 100, top: 100 });
  });

  it("moves left and up to stay in the window", () => {
    expect(placeMenu({ x: 990, y: 690 }, size, view)).toEqual({ left: 1000 - 4 - 220, top: 690 - 300 });
  });

  it("flips above the row when there's no room under it", () => {
    expect(placeMenu({ x: 30, y: 600, flipY: 570 }, size, view)).toEqual({ left: 30, top: 270 });
  });

  it("never goes past the top or left edge, even when the window is too small", () => {
    expect(placeMenu({ x: 50, y: 50 }, { width: 2000, height: 2000 }, view)).toEqual({ left: 4, top: 4 });
  });
});

describe("hostMenu", () => {
  const row: SidebarRow = { id: "inventory:esx-02", label: "esx-02", host: "esx-02", command: "open esx-02", menu: true };
  const all: HostMenuOptions = { reviewed: true, caps: { has: () => true }, folders: true, keys: (c: string) => (c === "host rename" ? "␣ R" : null) };
  const labels = (r: SidebarRow, o = all) => hostMenu(r, o).map((e) => ("separator" in e ? "|" : e.label));

  it("groups open, look, change and remove, with a row's own actions among the changes", () => {
    const own = { ...row, actions: [{ label: "Mark unreviewed", icon: "unreview" as const, command: "host unreview esx-02" }] };
    expect(labels(own)).toEqual([
      "Open", "New Session", "|", "Details", "Check", "Edit…", "|",
      "Mark unreviewed", "Rename…", "Move to another group…", "Add to a Folder…", "|", "Remove from the Inventory…",
    ]);
  });

  it("runs the command lines the old buttons and keys ran, with their keys", () => {
    const entries = hostMenu(row, all).filter((e) => !("separator" in e));
    expect(entries.map((e) => ("command" in e ? e.command : ""))).toEqual([
      "open esx-02", "connect esx-02", "info esx-02", "check esx-02", "edit esx-02",
      "host rename esx-02", "host move esx-02", "folder add esx-02", "host remove esx-02",
    ]);
    expect(entries.find((e) => "label" in e && e.label === "Rename…")).toMatchObject({ keys: "␣ R" });
  });

  it("a Host not in the Inventory (a Folder's entry) has only the row's own actions", () => {
    const own = { ...row, actions: [{ label: "Remove esx-02 from Lab", icon: "close" as const, command: "folder remove esx-02 Lab" }] };
    expect(labels(own, { ...all, reviewed: null })).toEqual(["Remove esx-02 from Lab"]);
  });
});
