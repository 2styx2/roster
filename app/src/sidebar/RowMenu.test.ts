// Where a Host row's menu goes (T166, Q156): at the pointer, kept inside the window, flipped above
// the row when there's no room under it. jsdom lays nothing out, so the arithmetic is checked here.
import { describe, expect, it } from "vitest";
import { commandHint, fitHints, menuHint, placeMenu } from "./RowMenu";
import { hostMenu, type HostMenuOptions } from "./hostMenu";
import type { SidebarRow } from "./Sidebar";

const view = { left: 0, top: 0, right: 1000, bottom: 700 };
const size = { width: 220, height: 300 };

describe("placeMenu", () => {
  it("opens at the point when it fits", () => {
    expect(placeMenu({ x: 100, y: 100 }, size, view)).toEqual({ left: 100, top: 100 });
  });

  it("moves left and up to stay in the window", () => {
    expect(placeMenu({ x: 990, y: 690 }, size, view)).toEqual({ left: 1000 - 220, top: 690 - 300 });
  });

  it("flips above the row when there's no room under it", () => {
    expect(placeMenu({ x: 30, y: 600, flipY: 570 }, size, view)).toEqual({ left: 30, top: 270 });
  });

  it("never goes past the top or left edge, even when the window is too small", () => {
    expect(placeMenu({ x: 50, y: 50 }, { width: 2000, height: 2000 }, view)).toEqual({ left: 0, top: 4 });
  });

  it("stays in the Sidebar pane: inside its edges and 4 px clear of its top and foot (round 21)", () => {
    const pane = { left: 0, top: 32, right: 285, bottom: 776 };
    // Under a row whose foot is 656: 140 tall would end at 796, over the status bar (776–800).
    expect(placeMenu({ x: 6, y: 656, flipY: 626 }, { width: 272, height: 140 }, pane)).toEqual({ left: 6, top: 486 });
    // At the pointer near the pane's right edge: moved in so its right edge is the pane's.
    expect(placeMenu({ x: 200, y: 100 }, { width: 272, height: 140 }, pane)).toEqual({ left: 13, top: 100 });
    // Too tall for the pane: its top 4 px under the pane's.
    expect(placeMenu({ x: 6, y: 300, flipY: 270 }, { width: 272, height: 900 }, pane).top).toBe(36);
  });
});

describe("hostMenu", () => {
  const row: SidebarRow = { id: "inventory:esx-02", label: "esx-02", host: "esx-02", command: "open esx-02", menu: true };
  const all: HostMenuOptions = { reviewed: true, live: true, edit: true, folders: true, keys: (c: string) => (c === "host rename" ? "␣ R" : null) };
  const labels = (r: SidebarRow, o = all) => hostMenu(r, o).map((e) => ("separator" in e ? "|" : e.label));

  it("says Open goes to the Host's Session when it has one, and shows the open key", () => {
    expect(labels(row, { ...all, hasSession: true })[0]).toBe("Go to its Session");
    expect(labels(row, { ...all, hasSession: false })[0]).toBe("Open");
    const first = hostMenu(row, { ...all, openKeys: "Enter" })[0];
    expect(first && "keys" in first ? first.keys : null).toBe("Enter");
  });

  it("groups open, look, change and remove, with a row's own actions among the changes", () => {
    const own = { ...row, actions: [{ label: "Mark unreviewed", icon: "unreview" as const, command: "host unreview esx-02" }] };
    expect(labels(own)).toEqual([
      "Open", "|", "Details", "Check", "Edit…", "|",
      "Mark unreviewed", "Rename…", "Move to another group…", "Add to a Folder…", "|", "Remove from the Inventory…",
    ]);
  });

  it("runs the command lines the old buttons and keys ran, with their keys", () => {
    const entries = hostMenu(row, all).filter((e) => !("separator" in e));
    expect(entries.map((e) => ("command" in e ? e.command : ""))).toEqual([
      "open esx-02", "info esx-02", "check esx-02", "edit esx-02",
      "host rename esx-02", "host move esx-02", "folder add esx-02", "host remove esx-02",
    ]);
    expect(entries.find((e) => "label" in e && e.label === "Rename…")).toMatchObject({ keys: "␣ R" });
  });

  it("a Host not in the Inventory (a Folder's entry) has only the row's own actions", () => {
    const own = { ...row, actions: [{ label: "Remove esx-02 from Lab", icon: "close" as const, command: "folder remove esx-02 Lab" }] };
    expect(labels(own, { ...all, reviewed: null })).toEqual(["Remove esx-02 from Lab"]);
  });

  it("an action's short words are its item's label, its whole label the item's description (round 22)", () => {
    const own = { ...row, actions: [{ label: "Remove esx-02 from Lab", short: "Remove from Folder", icon: "close" as const, command: "folder remove esx-02 Lab" }] };
    expect(hostMenu(own, { ...all, reviewed: null })).toEqual([
      { label: "Remove from Folder", full: "Remove esx-02 from Lab", command: "folder remove esx-02 Lab" },
    ]);
  });
});

describe("commandHint (round 18, round 19)", () => {
  it("shows a command's words up to the row's own name, then the argument's shape, not a cut-looking …", () => {
    expect(commandHint("group rename lab", "lab", "GROUP")).toBe(":group rename GROUP");
    expect(commandHint("group delete lab", "lab")).toBe(":group delete NAME");
    expect(commandHint("folder add esx-02", "esx-02", "HOST")).toBe(":folder add HOST");
    expect(commandHint("folder remove esx-02 Lab", "esx-02", "HOST")).toBe(":folder remove HOST NAME");
    expect(commandHint("check esx-02", "esx-02", "HOST")).toBe(":check HOST");
  });

  it("shows the whole command when the name isn't in it, and never matches part of a word", () => {
    expect(commandHint("host add", "Inventory")).toBe(":host add");
    expect(commandHint("group new", "")).toBe(":group new NAME");
    expect(commandHint("check esx-02b", "esx-02", "HOST")).toBe(":check esx-02b");
    // A name with a space is quoted on the command line (round 22: it showed whole in the hint).
    expect(commandHint('folder rename "Rack 4 lab"', "Rack 4 lab")).toBe(":folder rename NAME");
  });
});

describe("menuHint (round 21)", () => {
  it("shows a Plugin's command line as it would be typed, with a new thing's NAME", () => {
    expect(menuHint("plugins run folders folder new", "Folders")).toBe(":folder new NAME");
    expect(menuHint("plugins run folders folder remove esx-02 Lab", "esx-02", "HOST")).toBe(":folder remove HOST NAME");
  });

  it("shows nothing for a Plugin's function, and roster's own commands as before", () => {
    expect(menuHint("plugins call folders 3 %7B%7D", "Folders")).toBeNull();
    expect(menuHint("plugins reload folders", "Folders")).toBeNull();
    expect(menuHint("check esx-02", "esx-02", "HOST")).toBe(":check HOST");
  });
});

describe("fitHints (round 22)", () => {
  /** A menu item whose label and hint have the given widths: [shown, natural]. */
  function item(label: [number, number], hint: [number, number]) {
    const menu = document.createElement("div");
    menu.innerHTML = `<button class="row-menu-item"><span class="row-menu-label">Remove from Folder</span><span class="row-menu-cmd">:folder remove HOST NAME</span></button>`;
    const size = (el: Element | null, [shown, natural]: [number, number]) => {
      Object.defineProperty(el, "clientWidth", { value: shown });
      Object.defineProperty(el, "scrollWidth", { value: natural });
    };
    size(menu.querySelector(".row-menu-label"), label);
    size(menu.querySelector(".row-menu-cmd"), hint);
    fitHints(menu);
    return (menu.querySelector(".row-menu-cmd") as HTMLElement).hidden;
  }

  it("keeps a hint that fits, or one cut that still shows some of it", () => {
    expect(item([120, 120], [168, 168])).toBe(false);
    expect(item([120, 120], [99, 168])).toBe(false);
  });

  it("drops the hint before the label is cut, and a hint cut to its ellipsis", () => {
    expect(item([100, 130], [0, 168])).toBe(true);
    expect(item([120, 120], [12, 168])).toBe(true);
  });
});
