import { describe, expect, it } from "vitest";
import { parseOp } from "./ops";

const view = (graph: unknown, extra: Record<string, unknown> = {}) => parseOp({ op: "view", id: "topo", spec: { title: "Topology", place: "full", graph, ...extra } });

describe("a view's graph, checked", () => {
  it("takes nodes, edges and clusters with their defaults filled in", () => {
    const op = view({
      clusters: [{ id: "lab", title: "Lab", mesh: true }],
      nodes: [
        { id: "box", label: "devbox", shape: "square" },
        { id: "esx-02", cluster: "lab", state: "live", shape: "ring", kind: "esxi", host: "esx-02", detail: "10.0.0.5", mark: "warn", note: "out of date" },
      ],
      edges: [{ from: "box", to: "lab" }, { from: "esx-02", to: "box", dir: "both", style: "dashed", tone: "warn", cut: true }],
      open: { handler: 3 },
      actions: [{ label: "Check", key: "c", run: "check" }],
    });
    expect(op).toEqual({
      op: "view",
      id: "topo",
      view: {
        title: "Topology",
        place: "full",
        actions: [],
        facts: [],
        graph: {
          data: {
            clusters: [{ id: "lab", title: "Lab", mesh: true }],
            nodes: [
              { id: "box", label: "devbox", shape: "square" },
              { id: "esx-02", label: "esx-02", cluster: "lab", state: "live", shape: "ring", kind: "esxi", host: "esx-02", detail: "10.0.0.5", mark: "warn", note: "out of date" },
            ],
            edges: [
              { id: "box>lab", from: "box", to: "lab", dir: "one", style: "solid" },
              { id: "esx-02>box", from: "esx-02", to: "box", dir: "both", style: "dashed", tone: "warn", cut: true },
            ],
          },
          open: { handler: 3 },
          actions: [{ label: "Check", key: "c", run: { command: "check" } }],
        },
      },
    });
  });

  it("an empty Lua table is an empty list", () => {
    expect(view({ nodes: {}, edges: {}, clusters: {} })).toMatchObject({ view: { graph: { data: { nodes: [], edges: [], clusters: [] } } } });
  });

  it.each([
    [{ nodes: [{ id: "a", shape: "star" }] }, "roster.views.set topo graph node 1: shape must be"],
    [{ nodes: [{ id: "a" }, { id: "a" }] }, "id a is used twice"],
    [{ nodes: [{ id: "a" }], clusters: [{ id: "a" }] }, "id a is used twice"],
    [{ edges: [{ from: "a" }] }, "graph edge 1: to must be text"],
    [{ edges: [{ from: "a", to: "b", dir: "up" }] }, "dir must be"],
    [{ edges: [{ from: "a", to: "b" }, { from: "a", to: "b" }] }, "edge id a>b is used twice"],
    [{ actions: [{ label: "Hop", key: "h", run: "x" }] }, "the graph uses h itself"],
    [{ nodes: Array.from({ length: 5001 }, (_, i) => ({ id: `n${i}` })) }, "more than 5,000"],
  ])("refuses %j", (graph, message) => {
    const op = view(graph);
    expect(op).toHaveProperty("invalid");
    expect((op as { invalid: string }).invalid).toContain(message);
  });

  it("a view has a table or a graph, not both", () => {
    expect(view({}, { table: { columns: [{ id: "a", label: "A" }] } })).toEqual({ invalid: "roster.views.set topo: a view has a table or a graph, not both" });
  });

  it("an update takes nodes, edges, clusters and what to take away", () => {
    const op = parseOp({ op: "view_update", id: "topo", changes: { nodes: [{ id: "a", state: "down" }], edges: [{ from: "a", to: "b" }], remove: ["c"], remove_edges: ["x>y"] } });
    expect(op).toMatchObject({
      op: "view_update",
      update: { remove: ["c"], graph: { nodes: [{ id: "a", label: "a", shape: "dot", state: "down" }], edges: [{ id: "a>b" }], clusters: [], removeEdges: ["x>y"] } },
    });
  });

  it("an update without graph fields has no graph part", () => {
    expect(parseOp({ op: "view_update", id: "topo", changes: { text: "hi" } })).not.toHaveProperty("update.graph");
  });

  it("takes how far reach goes and a filter that hides", () => {
    const op = view({ nodes: [{ id: "a" }], reach: "direct", filter: { clusters: ["lab"], kinds: {}, states: ["live", "warn"] } });
    expect(op).toMatchObject({ view: { graph: { reach: "direct", filter: { clusters: ["lab"], states: ["live", "warn"] } } } });
    expect(view({ nodes: [{ id: "a" }] })).not.toHaveProperty("view.graph.reach");
  });

  it.each([
    [{ reach: "far" }, 'reach must be "all", "direct"'],
    [{ filter: { states: ["asleep"] } }, "filter states 1 must be"],
    [{ filter: { kinds: [3] } }, "filter kinds 1 must be text"],
    [{ filter: "lab" }, "filter must be a table"],
  ])("refuses %j", (graph, message) => {
    expect((view(graph) as { invalid: string }).invalid).toContain(message);
  });

  it("an update can change the filter, and an empty one shows everything again", () => {
    expect(parseOp({ op: "view_update", id: "topo", changes: { filter: { clusters: ["web"] } } })).toMatchObject({ update: { graph: { filter: { clusters: ["web"] } } } });
    expect(parseOp({ op: "view_update", id: "topo", changes: { filter: {} } })).toMatchObject({ update: { graph: { filter: {} } } });
  });

  it("an action's when names a node's fields: one value or a list of them (T89)", () => {
    const op = view({ actions: [{ label: "Cut", key: "x", when: { kind: ["esxi", "linux"], state: "live" }, run: "x" }] });
    expect(op).toMatchObject({ view: { graph: { actions: [{ label: "Cut", when: { kind: ["esxi", "linux"], state: ["live"] } }] } } });
    expect(view({ actions: [{ label: "Cut", run: "x" }] })).not.toHaveProperty("view.graph.actions.0.when");
  });

  it.each([
    [{ colour: "red" }, "when.colour: a node has no colour (id, label, kind, shape, state, mark, note, cluster, host, detail)"],
    [{ state: {} }, "when.state must be"],
    ["live", "when must be a table"],
  ])("refuses an action's when %j", (when, message) => {
    expect((view({ actions: [{ label: "Cut", when, run: "x" }] }) as { invalid: string }).invalid).toContain(message);
  });

  it("the graph keeps m for moving a node from the keyboard (T89)", () => {
    expect((view({ actions: [{ label: "Mark", key: "m", run: "x" }] }) as { invalid: string }).invalid).toContain("the graph uses m itself");
  });

  it("the graph keeps f for its filter", () => {
    expect((view({ actions: [{ label: "Find", key: "f", run: "x" }] }) as { invalid: string }).invalid).toContain("the graph uses f itself");
  });
});
