// A Plugin's graph in a view (ticket 77, decision Q99) through the App, with the fake Backend's
// Plugin host: the graph opens with focus, vim keys move between nodes and say where they are,
// selecting lights up its reach both ways with counts, / searches, o collapses a cluster to its
// count, Enter and action keys run the graph's functions with the node, t lists every node and
// edge, an update changes a node in place, and positions and folds are kept in the State.
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import type { FakePlugin } from "./backend/fakePlugins";
import { memoryPlatform } from "./platform/memory";
import { StubTerminal } from "./terminal/StubTerminal";
import { GRAPHS_KEY } from "./graph/memory";

const LEADER = "{Control>} {/Control}";
const PATH = "~/plugins/topo";

/** A Topology-like Plugin: this Box, two clusters (one meshed), a Link and a password peer. */
function topoPlugin(extra: Record<string, unknown> = {}): FakePlugin {
  return {
    manifest: { name: "topo", version: "1.0.0", description: "A map", author: "A. Author", api: 2, permissions: [] },
    load(roster) {
      roster.views.set("topo", {
        title: "Topology",
        place: "full",
        graph: {
          clusters: [
            { id: "lab", title: "lab", mesh: true },
            { id: "web", title: "web" },
          ],
          nodes: [
            { id: "box", label: "devbox", shape: "square" },
            { id: "esx-01", cluster: "lab", host: "esx-01", detail: "10.0.0.5", kind: "esxi" },
            { id: "esx-02", cluster: "lab", host: "esx-02", shape: "ring", mark: "warn", note: "out of date" },
            { id: "web-1", cluster: "web", host: "web-1" },
            { id: "appliance", cluster: "web", shape: "ring", state: "down" },
          ],
          edges: [
            { from: "box", to: "lab" },
            { from: "box", to: "web" },
            { from: "esx-01", to: "web-1", style: "solid" },
            { from: "esx-02", to: "appliance", style: "dashed", cut: true },
          ],
          ...extra,
          open: (e: Record<string, unknown>) => roster.notify(`opened ${String(e.node)} on ${String(e.host)}`),
          actions: [
            { label: "Check", key: "c", run: (e: Record<string, unknown>) => roster.notify(`checked ${String(e.node)}`) },
            { label: "Connect", key: "w", run: (e: Record<string, unknown>) => roster.views.update("topo", { nodes: [{ id: e.node, cluster: "web", host: e.node, state: "live" }] }) },
            { label: "Disconnect", key: "d", when: { state: "live" }, run: (e: Record<string, unknown>) => roster.notify(`disconnected ${String(e.node)}`) },
          ],
        },
      });
      roster.keymap.set("leader", "y t", "view topo");
      // As a Host-details section's action would (T99): open the graph at a node.
      roster.commands.add("topo-add", { desc: "Add", run: (a: Record<string, unknown>) => roster.views.update("topo", { nodes: [{ id: String(a.args), cluster: "web", host: String(a.args) }] }) });
      roster.commands.add("topo-at", { desc: "Open at", run: (a: Record<string, unknown>) => roster.views.open("topo", { select: String(a.args) }) });
    },
  };
}

async function ready(platform = memoryPlatform(), plugin: FakePlugin = topoPlugin()) {
  const user = userEvent.setup();
  const backend = fakeBackend({ hosts: makeHosts(12), plugins: { [PATH]: plugin } });
  const view = render(<App backend={backend} terminalView={StubTerminal} platform={platform} />);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  await user.keyboard(`${LEADER}:plugins install ${PATH}{Enter}`);
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Install" }));
  await screen.findByText("12 Hosts");
  return { user, view, platform };
}

const graph = () => screen.getByRole("application", { name: "Topology" });
const said = async (text: string | RegExp) => waitFor(() => expect(screen.getAllByRole("status").some((s) => (typeof text === "string" ? s.textContent?.includes(text) : text.test(s.textContent ?? "")))).toBe(true));
const foot = () => document.querySelector(".graph-about")?.textContent ?? "";

describe("a Plugin's graph", () => {
  it("opens with focus on the first node, and says what it reaches both ways", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:view topo{Enter}`);
    await screen.findByRole("region", { name: "Topology (from topo)" });
    expect(graph()).toHaveFocus();
    expect(foot()).toBe("devbox, square. Reaches 4 nodes; reached by 0");
    await said("devbox, square. Reaches 4 nodes");
  });

  it("vim keys move to the nearest node; a node in a meshed cluster reaches its peers and onward", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:view topo{Enter}`);
    await screen.findByRole("application", { name: "Topology" });
    // The Box is alone at the top left; the clusters are to its right.
    await user.keyboard("l");
    expect(foot()).toMatch(/^esx-0[12]/);
    // Find esx-02 by search: it reaches esx-01 (mesh), web-1 (via esx-01) and appliance.
    await user.keyboard("/esx-02{Enter}");
    expect(graph()).toHaveFocus();
    expect(foot()).toBe("esx-02, ring, warning, out of date. Reaches 3 nodes; reached by 2");
  });

  it("/ searches, n goes through the matches, Esc clears the search and a second Esc closes the view", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:view topo{Enter}`);
    await screen.findByRole("application", { name: "Topology" });
    await user.keyboard("/esx");
    expect(screen.getByRole("searchbox", { name: "Search Topology" })).toHaveFocus();
    expect(screen.getByText("2 matches for esx")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    const first = foot();
    await user.keyboard("n");
    expect(foot()).not.toBe(first);
    expect(foot()).toMatch(/^esx-0/);
    await user.keyboard("{Escape}");
    expect(screen.queryByText(/matches for/)).toBeNull();
    expect(screen.getByRole("region", { name: "Topology (from topo)" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Topology (from topo)" })).toBeNull();
  });

  it("Enter and an action's key run the graph's functions with the node and its Host", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:view topo{Enter}`);
    await screen.findByRole("application", { name: "Topology" });
    await user.keyboard("/esx-01{Enter}");
    await user.keyboard("{Enter}");
    expect(await screen.findByText(/opened esx-01 on esx-01/)).toBeInTheDocument();
    await user.keyboard("c");
    expect(await screen.findByText(/checked esx-01/)).toBeInTheDocument();
  });

  it("an action with when runs only on the nodes it names, and its key shows only there (T89)", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:view topo{Enter}`);
    await screen.findByRole("application", { name: "Topology" });
    const keys = () => document.querySelector(".graph-foot .dt-keys")?.textContent ?? "";
    await user.keyboard("/web-1{Enter}");
    expect(keys()).not.toContain("disconnect");
    await user.keyboard("d");
    await user.keyboard("w");
    await waitFor(() => expect(foot()).toMatch(/^web-1, filled, live/));
    expect(screen.queryByText(/disconnected/)).toBeNull();
    expect(keys()).toContain("disconnect");
    await user.keyboard("d");
    expect(await screen.findByText(/disconnected web-1/)).toBeInTheDocument();
    // The nodes' list asks the same of each row.
    await user.keyboard("t");
    const nodes = screen.getByRole("grid", { name: "Topology: nodes" });
    expect(within(nodes).getByRole("row", { selected: true })).toHaveTextContent("web-1");
    expect(within(nodes).getByRole("button", { name: /Disconnect/ })).toBeInTheDocument();
    await user.keyboard("k");
    expect(within(nodes).queryByRole("button", { name: /Disconnect/ })).toBeNull();
  });

  it("roster.views.open with select opens the graph at that node, opening its cluster, and again while it's open (T99)", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:topo-at web-1{Enter}`);
    await screen.findByRole("application", { name: "Topology" });
    expect(foot()).toMatch(/^web-1/);
    await user.keyboard("o");
    expect(foot()).toMatch(/^web: 2 nodes, collapsed/);
    await user.keyboard(`${LEADER}:topo-at appliance{Enter}`);
    await waitFor(() => expect(foot()).toMatch(/^appliance/));
    expect(graph()).toHaveFocus();
    // An id the graph doesn't have selects as an ordinary opening does.
    await user.keyboard(`${LEADER}:topo-at nowhere{Enter}`);
    await waitFor(() => expect(foot()).toMatch(/^devbox/));
  });

  it("opened at a node that isn't there yet, it goes to it when it arrives, unless the user has moved on (T99)", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:topo-at late-1{Enter}`);
    await screen.findByRole("application", { name: "Topology" });
    expect(foot()).toMatch(/^devbox/);
    await user.keyboard(`${LEADER}:topo-add late-1{Enter}`);
    await waitFor(() => expect(foot()).toMatch(/^late-1/));
    // Asked for another that isn't there; the user picks a node meanwhile: that one stays.
    await user.keyboard(`${LEADER}:topo-at late-2{Enter}`);
    await waitFor(() => expect(foot()).toMatch(/^devbox/));
    graph().focus();
    await user.keyboard("/esx-02{Enter}");
    expect(foot()).toMatch(/^esx-02/);
    await user.keyboard(`${LEADER}:topo-add late-2{Enter}`);
    await new Promise((r) => setTimeout(r, 50));
    expect(foot()).toMatch(/^esx-02/);
    // One that comes into a collapsed cluster opens it.
    await user.keyboard(`${LEADER}:topo-at web-1{Enter}`);
    await waitFor(() => expect(foot()).toMatch(/^web-1/));
    await user.keyboard("o");
    expect(foot()).toMatch(/^web: \d nodes, collapsed/);
    await user.keyboard(`${LEADER}:topo-at late-3{Enter}`);
    await user.keyboard(`${LEADER}:topo-add late-3{Enter}`);
    await waitFor(() => expect(foot()).toMatch(/^late-3/));
  });

  it("o collapses the selected node's cluster to its count and opens it again", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:view topo{Enter}`);
    await screen.findByRole("application", { name: "Topology" });
    await user.keyboard("/web-1{Enter}o");
    expect(foot()).toBe("web: 2 nodes, collapsed. Reaches 0 nodes; reached by 3");
    await user.keyboard("{Enter}");
    expect(foot()).toMatch(/^web-1/);
  });

  it("t lists every node with its reach, then every edge; Enter on an edge goes to its start in the graph", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:view topo{Enter}`);
    await screen.findByRole("application", { name: "Topology" });
    await user.keyboard("t");
    const nodes = screen.getByRole("grid", { name: "Topology: nodes" });
    expect(nodes).toHaveFocus();
    const rows = within(nodes).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(5);
    expect(rows[2]).toHaveTextContent("esx-02");
    expect(rows[2]).toHaveTextContent("warning, out of date");
    expect(rows[4]).toHaveTextContent("appliance");
    expect(rows[4]).toHaveTextContent("down");
    await user.keyboard("t");
    const edges = screen.getByRole("grid", { name: "Topology: edges" });
    const lines = within(edges).getAllByRole("row").slice(1).map((r) => r.textContent);
    expect(lines).toEqual([
      expect.stringContaining("devboxevery node in lab"),
      expect.stringContaining("devboxevery node in web"),
      expect.stringContaining("esx-01web-1"),
      expect.stringContaining("cut pending"),
      expect.stringContaining("every node in labeach otherboth ways"),
    ]);
    await user.keyboard("jjj{Enter}");
    expect(graph()).toHaveFocus();
    expect(foot()).toMatch(/^esx-02/);
  });

  it("an update changes a node in place and keeps the selection", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:view topo{Enter}`);
    await screen.findByRole("application", { name: "Topology" });
    await user.keyboard("/web-1{Enter}");
    await user.keyboard("w");
    await waitFor(() => expect(foot()).toBe("web-1, filled, live. Reaches 0 nodes; reached by 3"));
  });

  it("keeps where each node was placed and which clusters are collapsed in the State", async () => {
    const { user, platform } = await ready();
    await user.keyboard(`${LEADER}:view topo{Enter}`);
    await screen.findByRole("application", { name: "Topology" });
    await user.keyboard("/web-1{Enter}o");
    await waitFor(async () => {
      const state = (await platform.loadState()) as Record<string, unknown>;
      const graphs = state[GRAPHS_KEY] as { key: string; nodes: Record<string, unknown>; folds: Record<string, boolean> }[];
      expect(graphs[0]?.key).toBe("topo/topo");
      expect(Object.keys(graphs[0]?.nodes ?? {}).sort()).toEqual(["appliance", "box", "esx-01", "esx-02", "web-1"]);
      expect(graphs[0]?.folds).toEqual({ web: true });
    });
  });

  it("m on a collapsed cluster says how to move one of its nodes, and moves nothing (T99)", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:view topo{Enter}`);
    await screen.findByRole("application", { name: "Topology" });
    await user.keyboard("/web-1{Enter}o");
    expect(foot()).toMatch(/^web: 2 nodes, collapsed/);
    await user.keyboard("m");
    await said("web is collapsed: o opens it, then m moves one of its nodes");
    expect(foot()).toBe("web is collapsed: o opens it, then m moves one of its nodes");
    // Any key clears it, even one the graph doesn't use, and the cluster's own words come back.
    await user.keyboard("z");
    expect(foot()).toMatch(/^web: 2 nodes, collapsed/);
    await user.keyboard("m");
    expect(foot()).toBe("web is collapsed: o opens it, then m moves one of its nodes");
    // So does a click on the map.
    await user.pointer({ keys: "[MouseLeft]", target: document.querySelector(".graph-canvas canvas, canvas") as Element });
    expect(foot()).not.toMatch(/is collapsed: o opens it/);
    // Not placing (h j k l still go between nodes).
    await user.keyboard("k");
    expect(foot()).not.toMatch(/is collapsed: o opens it|^Moving/);
    expect(document.querySelector(".graph-foot .dt-keys")?.textContent).not.toMatch(/put back/);
  });

  it("m moves the selected node from the keyboard: Enter keeps the place, Esc puts it back (T89)", async () => {
    const { user, platform } = await ready();
    await user.keyboard(`${LEADER}:view topo{Enter}`);
    await screen.findByRole("application", { name: "Topology" });
    const at = async (id: string) => {
      const state = (await platform.loadState()) as Record<string, unknown>;
      const graphs = state[GRAPHS_KEY] as { nodes: Record<string, [number, number]> }[] | undefined;
      return graphs?.[0]?.nodes[id];
    };
    await user.keyboard("/esx-01{Enter}");
    await waitFor(async () => expect(await at("esx-01")).toBeDefined());
    const [x0, y0] = (await at("esx-01")) as [number, number];
    await user.keyboard("m");
    await said(/Moving esx-01/);
    expect(document.querySelector(".graph-foot .dt-keys")?.textContent).toMatch(/move it.*keep.*put back/);
    await user.keyboard("llj");
    // h j k l move the node now, not the selection.
    expect(foot()).toMatch(/^esx-01/);
    await waitFor(async () => {
      const [x, y] = (await at("esx-01")) as [number, number];
      expect(x).toBeGreaterThan(x0);
      expect(y).toBeGreaterThan(y0);
    });
    await user.keyboard("{Enter}");
    await said(/esx-01 placed/);
    const [x1, y1] = (await at("esx-01")) as [number, number];
    // Moving again and Esc puts it back where it was, and the view stays open.
    await user.keyboard("mLL{Escape}");
    await said(/esx-01 put back/);
    await waitFor(async () => expect(await at("esx-01")).toEqual([x1, y1]));
    expect(screen.getByRole("region", { name: "Topology (from topo)" })).toBeInTheDocument();
    // Out of moving, l goes to another node again.
    await user.keyboard("h");
    expect(foot()).not.toMatch(/^esx-01/);
  });

  it("an empty graph says so, and one node counts in the singular", async () => {
    const tiny = (nodes: Record<string, unknown>[]): FakePlugin => ({
      manifest: { name: "topo", version: "1.0.0", description: "A map", author: "A. Author", api: 2, permissions: [] },
      load(roster) {
        roster.views.set("topo", { title: "Topology", place: "full", graph: { nodes, clusters: [{ id: "lab" }] } });
      },
    });
    const { user, view } = await ready(memoryPlatform(), tiny([]));
    await user.keyboard(`${LEADER}:view topo{Enter}`);
    await screen.findByRole("application", { name: "Topology" });
    expect(screen.getByText("No nodes yet.")).toBeInTheDocument();
    expect(foot()).toBe("0 nodes, 0 edges, 1 cluster");
    await user.keyboard("jhkl/x{Enter}tt");
    expect(screen.getByText("No edges yet.")).toBeInTheDocument();
    view.unmount();
    const again = await ready(memoryPlatform(), tiny([{ id: "a", cluster: "lab" }]));
    await again.user.keyboard(`${LEADER}:view topo{Enter}`);
    await screen.findByRole("application", { name: "Topology" });
    expect(foot()).toBe("a, filled. Reaches 0 nodes; reached by 0");
    await again.user.keyboard("o");
    expect(foot()).toBe("lab: 1 node, collapsed. Reaches 0 nodes; reached by 0");
  });

  it("an empty node or edge list keeps the focus, so t still goes on (T89)", async () => {
    const empty: FakePlugin = {
      manifest: { name: "topo", version: "1.0.0", description: "A map", author: "A. Author", api: 2, permissions: [] },
      load(roster) {
        roster.views.set("topo", { title: "Topology", place: "full", graph: { nodes: [] } });
      },
    };
    const { user } = await ready(memoryPlatform(), empty);
    await user.keyboard(`${LEADER}:view topo{Enter}`);
    await screen.findByRole("application", { name: "Topology" });
    const list = () => screen.getByRole("group", { name: /^Topology: (nodes|edges)$/ });
    await user.keyboard("t");
    expect(list()).toHaveAccessibleName("Topology: nodes");
    expect(list()).toHaveFocus();
    expect(within(list()).getByText("No nodes yet.")).toBeInTheDocument();
    await user.keyboard("t");
    expect(list()).toHaveAccessibleName("Topology: edges");
    expect(list()).toHaveFocus();
    await user.keyboard("t");
    expect(graph()).toHaveFocus();
  });

  it("f goes to the filter; a cluster, kind or state chosen there hides the rest, and Esc clears it", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:view topo{Enter}`);
    await screen.findByRole("application", { name: "Topology" });
    await user.keyboard("f");
    const cluster = screen.getByRole("button", { name: /^Show the cluster/ });
    expect(cluster).toHaveFocus();
    expect(cluster).toHaveAttribute("aria-expanded", "false");
    await user.keyboard("{Enter}");
    const menu = screen.getByRole("menu", { name: "Show the cluster" });
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Every cluster" })).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(cluster).toHaveFocus();
    expect(cluster).toHaveTextContent("web");
    expect(screen.getByText("Showing 2 of 5 nodes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Show the state/ }));
    await user.click(within(screen.getByRole("menu", { name: "Show the state" })).getByRole("menuitemcheckbox", { name: "down" }));
    expect(screen.getByText("Showing 1 of 5 nodes")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    await user.keyboard("{Escape}");
    expect(graph()).toHaveFocus();
    expect(foot()).toMatch(/^appliance/);
    // The list shows what the graph shows.
    await user.keyboard("t");
    expect(within(screen.getByRole("grid", { name: "Topology: nodes" })).getAllByRole("row")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Graph" }));
    expect(graph()).toHaveFocus();
    // Esc clears the filter before it closes the view.
    await user.keyboard("{Escape}");
    expect(screen.queryByText(/^Showing/)).toBeNull();
    expect(screen.getByRole("region", { name: "Topology (from topo)" })).toBeInTheDocument();
  });

  it("a Plugin's filter shows only what it names, and the kinds and states are choices too", async () => {
    const { user } = await ready(memoryPlatform(), topoPlugin({ filter: { kinds: ["esxi"] } }));
    await user.keyboard(`${LEADER}:view topo{Enter}`);
    await screen.findByRole("application", { name: "Topology" });
    expect(screen.getByText("Showing 1 of 5 nodes")).toBeInTheDocument();
    expect(foot()).toMatch(/^esx-01/);
    expect(screen.getByRole("button", { name: /^Show the kind/ })).toHaveTextContent("esxi");
  });

  it("the filter takes several values of a dimension: Space ticks each, and the button counts them (T89)", async () => {
    const { user } = await ready(memoryPlatform(), topoPlugin({ filter: { clusters: ["lab", "web", "gone"] } }));
    await user.keyboard(`${LEADER}:view topo{Enter}`);
    await screen.findByRole("application", { name: "Topology" });
    const cluster = screen.getByRole("button", { name: /^Show the cluster/ });
    // A Plugin's filter may name what isn't there: it's a choice too, so it can be taken off.
    expect(cluster).toHaveTextContent("3 clusters");
    expect(screen.getByText("Showing 4 of 5 nodes")).toBeInTheDocument();
    await user.keyboard("f{Enter}");
    const menu = screen.getByRole("menu", { name: "Show the cluster" });
    const item = (name: string) => within(menu).getByRole("menuitemcheckbox", { name });
    expect(item("lab")).toHaveAttribute("aria-checked", "true");
    expect(item("gone")).toHaveAttribute("aria-checked", "true");
    expect(item("Every cluster")).toHaveAttribute("aria-checked", "false");
    // The focus starts on the first ticked one; Space ticks and the menu stays open.
    expect(item("lab")).toHaveFocus();
    await user.keyboard(" ");
    expect(item("lab")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Showing 2 of 5 nodes")).toBeInTheDocument();
    // Typing a letter goes to the next item that starts with it.
    await user.keyboard("g ");
    expect(item("gone")).toHaveAttribute("aria-checked", "false");
    expect(cluster).toHaveTextContent("web");
    await user.keyboard("{Home} ");
    expect(item("Every cluster")).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByText(/^Showing/)).toBeNull();
    await user.keyboard("{Escape}");
    expect(cluster).toHaveFocus();
    expect(cluster).toHaveTextContent("Every cluster");
  });

  it("reach = \"direct\" counts one hop", async () => {
    const { user } = await ready(memoryPlatform(), topoPlugin({ reach: "direct" }));
    await user.keyboard(`${LEADER}:view topo{Enter}`);
    await screen.findByRole("application", { name: "Topology" });
    await user.keyboard("/esx-02{Enter}");
    expect(foot()).toBe("esx-02, ring, warning, out of date. Reaches 2 nodes directly; reached directly by 2");
  });
});
