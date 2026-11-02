import { describe, expect, it } from "vitest";
import { makeHosts } from "../backend/fake";
import type { Tab, TabsSnapshot } from "../session/tabs";
import { builtinSidebarRegistry, hostRow, type SidebarSectionDef } from "../sidebar/sections";
import { builtinFinderRegistry, finderResults, searchItems, type FinderContext, type FinderItem } from "./sources";

const hosts = makeHosts(12);
const byName = new Map(hosts.hosts.map((h) => [h.name, h]));
const [a, b, c] = hosts.hosts.filter((h) => h.reviewed).map((h) => h.name) as [string, string, string];
const unreviewed = hosts.hosts.find((h) => !h.reviewed)!.name;

const tab = (id: number, host: string, status: Tab["status"] = { state: "open" }): Tab => ({
  id,
  host,
  label: host,
  status,
  auth: "key",
  shell: true,
  attempt: 1,
  quick: null,
  save: null,
  prompt: null,
});

function context(sessions: TabsSnapshot = { tabs: [], active: null, previous: null }, state: Record<string, unknown> = {}): FinderContext {
  const sidebar = builtinSidebarRegistry();
  sidebar.register(foldersLike);
  return {
    sessions,
    hosts,
    hostByName: byName,
    sessionsIn: "sidebar",
    state,
    folded: new Set(["group:subnet-1", "section:inventory"]),
    recent: [],
    sidebar: sidebar.list(),
  };
}

/** A section shaped as the Folders Plugin's (ticket 61): a Folder, then its Hosts. */
const foldersLike: SidebarSectionDef = {
  id: "folders",
  source: "folders",
  order: 200,
  build: ({ state, hostByName }) => {
    const list = (state.folders ?? []) as { name: string; hosts: string[] }[];
    return {
      id: "folders",
      title: "Folders",
      rows: list.flatMap((f) => [
        { id: `folders:${f.name}`, label: f.name, level: 0, foldable: true, command: `togglefold folders:${f.name}` },
        ...f.hosts.map((h) => hostRow(hostByName.get(h)!, `folders:${f.name}/${h}`, 1)),
      ]),
    };
  },
};

const registry = builtinFinderRegistry();
const source = (id: string) => registry.get(id)!;
const labels = (items: readonly FinderItem[]) => items.map((i) => i.label);

describe("the Sessions finder (␣ b)", () => {
  const sessions: TabsSnapshot = {
    tabs: [tab(1, a), tab(2, b), tab(3, c, { state: "ended", exit: { code: 0, closed: false }, problem: null })],
    active: 2,
    previous: 1,
  };

  it("lists open Sessions in order; Enter goes to that Session; the previous one starts selected", () => {
    const ctx = context(sessions);
    const r = finderResults(source("sessions"), ctx, "");
    expect(labels(r.items)).toEqual([a, b, c]);
    expect(r.items.map((i) => i.command)).toEqual(["session 1", "session 2", "session 3"]);
    expect(r.items.map((i) => i.mark)).toEqual(["previous", "current", undefined]);
    expect(r.items[2]?.detail).toMatch(/ended/);
    expect(r.selected).toBe(0);
  });

  it("fuzzy-matches a Session by its Host", () => {
    const r = finderResults(source("sessions"), context(sessions), b.slice(0, 4) + b.slice(-3));
    expect(labels(r.items)[0]).toBe(b);
  });
});

describe("the Hosts finder", () => {
  it("ranks with the Picker's matcher, and lists unreviewed Hosts as not openable", () => {
    const r = finderResults(source("hosts"), context(), unreviewed);
    expect(r.items[0]).toMatchObject({ label: unreviewed, command: `open ${unreviewed}` });
    expect(r.items[0]?.disabled).toMatch(/isn't reviewed/);
    expect(labels(finderResults(source("hosts"), context(), "").items)).toHaveLength(12);
  });
});

describe("the tree finder (␣ e in Focus)", () => {
  const folders = { folders: [{ name: "Lab ESXi", hosts: [b] }] };

  it("offers every Host row the Sidebar's other sections have, folded or not, with its path", () => {
    const items = finderResults(source("tree"), context(undefined, folders), "").items;
    expect(items[0]).toMatchObject({ label: b, path: "Folders › Lab ESXi", command: `open ${b}` });
    const inventory = items.filter((i) => i.path?.startsWith("Inventory"));
    expect(inventory).toHaveLength(12);
    expect(inventory[0]).toMatchObject({ path: "Inventory › subnet-1", detail: hosts.hosts[0]!.ip });
    expect(items.some((i) => i.command.startsWith("session"))).toBe(false);
  });

  it("matches the path too: a Folder's name finds its Hosts", () => {
    const items = finderResults(source("tree"), context(undefined, folders), "lab esxi").items;
    expect(labels(items)).toEqual([b]);
  });

  it("the Inventory and Folders each have a finder of their own", () => {
    expect(finderResults(source("inventory"), context(undefined, folders), "").items).toHaveLength(12);
  });
});

describe("searchItems", () => {
  const items: FinderItem[] = [
    { id: "1", label: "net-sw-core-01", detail: "10.19.77.2", command: "x" },
    { id: "2", label: "esxi-02", detail: "10.19.77.237", command: "x" },
    { id: "3", label: "orion3", path: "Folders › esxi lab", command: "x" },
  ];
  it("needs every word to match, ranks the name above the path, and keeps order on ties", () => {
    expect(labels(searchItems(items, "esxi"))).toEqual(["esxi-02", "orion3"]);
    expect(labels(searchItems(items, "77 core"))).toEqual(["net-sw-core-01"]);
    expect(labels(searchItems(items, ""))).toEqual(["net-sw-core-01", "esxi-02", "orion3"]);
    expect(searchItems(items, "zzz")).toEqual([]);
  });
});
