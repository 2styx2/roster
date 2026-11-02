// sectionBuilder keeps a section, and so its row objects, while what it read is unchanged: the
// memoized Sidebar rows then skip re-rendering when only the Sessions change (#62).
import { describe, expect, it } from "vitest";
import { makeHosts } from "../backend/fake";
import type { Tab, TabsSnapshot } from "../session/tabs";
import { inventorySection, sectionBuilder, sessionsSection, type SidebarContext } from "./sections";
import { rowName } from "./Sidebar";

const hosts = makeHosts(5);
const hostByName = new Map(hosts.hosts.map((h) => [h.name, h]));
const first = hosts.hosts[0]?.name ?? "";

function tab(id: number, host: string, status: Tab["status"] = { state: "connecting" }): Tab {
  return { id, host, label: host, status, auth: null, shell: false, attempt: 1, quick: null, save: null, prompt: null };
}

// The App memoizes these, so they're the same between builds unless they change.
const state = {};
const noFolds = new Set<string>();

function ctx(sessions: TabsSnapshot, over: Partial<SidebarContext> = {}): SidebarContext {
  return { sessions, hosts, hostByName, sessionsIn: "sidebar", state, folded: noFolds, ...over };
}

const defs = [sessionsSection, inventorySection];
const none: TabsSnapshot = { tabs: [], active: null, previous: null };
const one: TabsSnapshot = { tabs: [tab(1, "nowhere")], active: 1, previous: null };
const inventory = (s: ReturnType<ReturnType<typeof sectionBuilder>>) => s.find((x) => x.id === "inventory");

describe("sectionBuilder", () => {
  it("keeps the Inventory's rows when only the Sessions change", () => {
    const build = sectionBuilder();
    const before = inventory(build(defs, ctx(none)));
    const after = build(defs, ctx(one));
    const rows = inventory(after)?.rows ?? [];
    expect(rows.length).toBeGreaterThan(5);
    rows.forEach((r, i) => expect(r).toBe(before?.rows[i]));
    expect(after.find((s) => s.id === "sessions")?.rows).toHaveLength(1);
  });

  it("builds again what changed: the Hosts, the folds, the on-screen Host", () => {
    const build = sectionBuilder();
    const base = ctx(none);
    const before = inventory(build(defs, base));

    const fewer = makeHosts(3);
    const rebuilt = inventory(build(defs, { ...base, hosts: fewer, hostByName: new Map(fewer.hosts.map((h) => [h.name, h])) }));
    expect(rebuilt?.rows.filter((r) => r.host)).toHaveLength(3);

    const group = before?.rows.find((r) => r.foldable)?.id ?? "";
    const folded = inventory(build(defs, { ...base, folded: new Set([group]) }));
    expect(folded?.rows.find((r) => r.id === group)?.folded).toBe(true);
    expect(folded?.rows.some((r) => r.parent === group)).toBe(false);

    // The on-screen Host's row is marked (its Session's row is raised, so this one is "also");
    // every other row is the very same object as before.
    const onScreen = inventory(build(defs, { ...base, sessions: { tabs: [tab(1, first)], active: 1, previous: null } }));
    expect(onScreen?.rows.find((r) => r.host === first)?.also).toBe(true);
    const unfolded = inventory(build(defs, base));
    const others = (s: typeof unfolded) => s?.rows.filter((r) => r.host !== first) ?? [];
    expect(others(onScreen)).toEqual(others(unfolded));
    others(onScreen).forEach((r, i) => expect(r).toBe(others(unfolded)[i]));
  });
});

describe("a Session row's folder (OSC 7, ticket 121)", () => {
  const rowOf = (t: Tab) => sectionBuilder()(defs, ctx({ tabs: [t], active: null, previous: null })).find((s) => s.id === "sessions")?.rows[0];

  it("shows the last folder of the path the shell said, and the whole path in its tooltip", () => {
    const row = rowOf({ ...tab(1, first, { state: "open" }), auth: "key", cwd: "/srv/app/releases" });
    expect(row).toMatchObject({ detail: "releases", title: "key login\nin /srv/app/releases" });
    expect(rowOf({ ...tab(1, first), cwd: "/" })).toMatchObject({ detail: "/", title: "in /" });
  });

  it("shows nothing while the shell hasn't said", () => {
    const row = rowOf(tab(1, first));
    expect(row?.detail).toBeUndefined();
    expect(row?.title).toBeUndefined();
  });
});

describe("a Session row's breadcrumb (ticket 120)", () => {
  const rowOf = (t: Tab) => sectionBuilder()(defs, ctx({ tabs: [t], active: null, previous: null })).find((s) => s.id === "sessions")?.rows[0];

  it("carries the Host a nested ssh took it to, in its name and tooltip", () => {
    const row = rowOf({ ...tab(1, first, { state: "open" }), auth: "key", hop: { to: "esx-02", known: true } });
    expect(row).toMatchObject({ hop: { to: "esx-02", known: true }, title: "key login\nnow on esx-02 through ssh" });
    expect(rowName(row!)).toMatch(/now on esx-02 through ssh/);
    expect(rowOf({ ...tab(1, first), hop: { to: "10.0.0.99", known: false } })?.title).toMatch(/not a Host roster can resolve/);
  });

  it("has none on the Session's own Host", () => {
    expect(rowOf(tab(1, first))?.hop).toBeUndefined();
  });
});
