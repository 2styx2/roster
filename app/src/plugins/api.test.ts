// The Plugin API's types (crates/roster-core/src/plugin/api.rs, ticket 70) against what the app
// really reads of them: ops.ts checks each op a Plugin sends, and this test records every field it
// reads of each table (a Proxy) and compares that with the type's documented fields. A field
// ops.ts starts reading, or one the reference lists that nothing reads, fails here: change api.rs
// and run `cargo run -p roster-core --example gen_plugin_api`.
import { describe, expect, it } from "vitest";
import api from "../../../crates/roster-core/tests/fixtures/plugin-api.json";
import { parseOp } from "./ops";

type Types = Record<string, { fields?: { name: string }[]; alias?: string }>;
const TYPES = api.types as Types;

const reads = new Map<string, Set<string>>();

/** `value`, recording each field read of it as a read of the type `type`. */
function typed<T extends object>(type: string, value: T): T {
  const seen = reads.get(type) ?? new Set<string>();
  reads.set(type, seen);
  return new Proxy(value, {
    get(target, key, receiver) {
      if (typeof key === "string" && !(key in Object.prototype)) seen.add(key);
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
}

const fields = (type: string) => (TYPES[type]?.fields ?? []).map((f) => f.name).filter((n) => !n.startsWith("["));

describe("the Plugin API reference and ops.ts agree", () => {
  const ops: unknown[] = [
    {
      op: "section",
      id: "s",
      spec: typed("Section", {
        title: "T",
        order: 1,
        empty: "none",
        actions: [{ label: "Dismiss all", icon: "close", run: { handler: 3 } }],
        rows: [
          typed("Row", {
            id: "r",
            label: "L",
            detail: "d",
            note: "n",
            host: "esx-02",
            badge: "b",
            count: 1,
            level: 1,
            title: "t",
            run: "open esx-02",
            actions: [typed("RowAction", { label: "A", icon: "copy", run: { handler: 1 } })],
          }),
        ],
      }),
    },
    { op: "status", id: "s", spec: typed("StatusSegment", { text: "x", title: "t", run: "finder x" }) },
    {
      op: "finder",
      id: "f",
      spec: typed("Finder", { title: "F", items: [typed("FinderItem", { id: "i", label: "L", detail: "d", path: "p", run: "x" })] }),
    },
    { op: "help", id: "h", spec: typed("HelpPage", { title: "H", summary: "s", markdown: "# H" }) },
    { op: "health", id: "h", spec: typed("HealthSection", { title: "H", checks: [typed("HealthCheck", { level: "warn", message: "m", fix: "f" })] }) },
    {
      op: "tutor",
      id: "t",
      spec: typed("Tutorial", {
        title: "T",
        summary: "s",
        intro: "i",
        outro: "o",
        lessons: [typed("Lesson", { title: "L", text: "t", steps: [typed("Step", { id: "a", text: "t", on: { event: "command", id: "finder" } })] })],
      }),
    },
    {
      op: "float",
      spec: typed("Float", {
        title: "F",
        lines: ["a"],
        actions: [typed("FloatAction", { label: "Go", key: "g", run: { handler: 4 } })],
        links: [typed("Link", { label: "Runbook", url: "https://wiki.example.com/disk" })],
      }),
    },
    {
      op: "confirm",
      spec: typed("Confirm", {
        title: "Cut esx-02?",
        text: "t",
        facts: [],
        action: "Cut",
        danger: true,
        typed: "esx-02",
        run: { handler: 5 },
        cancel: { handler: 6 },
      }),
    },
    { op: "progress", id: "p", spec: typed("Progress", { title: "Scanning", text: "t", done: 1, total: 4, cancel: { handler: 7 } }) },
    { op: "toolbar", id: "t", spec: typed("ToolbarControl", { label: "Scan a network", text: "Scan", icon: "map", run: "view scan" }) },
    {
      op: "view",
      id: "v",
      spec: typed("View", {
        title: "V",
        place: "full",
        actions: [typed("HeadAction", { label: "Plan", icon: "plan", key: "P", run: { handler: 9 } })],
        text: "t",
        facts: [typed("Fact", { label: "l", value: "v", data: true })],
        table: typed("Table", {
          columns: [typed("Column", { id: "a", label: "A", kind: "number", width: 6 })],
          rows: [typed("TableRow", { id: "r", cells: { a: 1 }, host: "esx-02", tone: "muted" })],
          sort: "a",
          desc: true,
          empty: "none",
          open: { handler: 1 },
          actions: [typed("TableAction", { label: "K", key: "x", icon: "add", when: { state: ["up"] }, run: { handler: 2 } })],
        }),
      }),
    },
    {
      op: "view_update",
      id: "v",
      changes: typed("ViewUpdate", {
        title: "V",
        text: "t",
        facts: [],
        rows: [{ id: "r", cells: { a: 2 } }],
        remove: ["q"],
        columns: [{ id: "a", label: "A" }],
        sort: "a",
        desc: false,
        actions: [{ label: "K", key: "x", run: { handler: 8 } }],
      }),
    },
    {
      op: "view",
      id: "g",
      spec: typed("View", {
        title: "G",
        place: "full",
        graph: typed("Graph", {
          clusters: [typed("GraphCluster", { id: "lab", title: "Lab", mesh: true, collapsed: false })],
          nodes: [
            typed("GraphNode", { id: "esx-02", label: "esx-02", kind: "esxi", shape: "ring", state: "live", mark: "warn", note: "out of date", cluster: "lab", host: "esx-02", detail: "10.0.0.5" }),
          ],
          edges: [typed("GraphEdge", { id: "e", from: "esx-02", to: "lab", dir: "both", style: "dashed", tone: "warn", cut: true, label: "Link" })],
          reach: "direct",
          filter: typed("GraphFilter", { clusters: ["lab"], kinds: ["esxi"], states: ["live"] }),
          open: { handler: 1 },
          actions: [typed("NodeAction", { label: "Check", key: "c", icon: "info", run: { handler: 2 } })],
        }),
      }),
    },
    {
      op: "view_update",
      id: "g",
      changes: typed("ViewUpdate", { nodes: [{ id: "a" }], edges: [{ from: "a", to: "b" }], clusters: [{ id: "c" }], remove_edges: ["a>b"], filter: {} }),
    },
    {
      op: "details",
      id: "d",
      host: "esx-02",
      spec: typed("DetailsSection", { title: "D", order: 1, actions: [{ label: "Cut", icon: "cut", run: { handler: 10 } }], text: "t", facts: [], table: { columns: [{ id: "a", label: "A" }] } }),
    },
  ];

  it("ops.ts takes every op with every documented field", () => {
    for (const op of ops) expect(parseOp(op)).not.toHaveProperty("invalid");
  });

  it.each(["Section", "Row", "RowAction", "HeadAction", "StatusSegment", "Finder", "FinderItem", "HelpPage", "HealthSection", "HealthCheck", "Tutorial", "Lesson", "Step", "Float", "View", "ViewUpdate", "DetailsSection", "Fact", "Table", "Column", "TableRow", "TableAction", "FloatAction", "Link", "Confirm", "Progress", "ToolbarControl", "Graph", "GraphNode", "GraphEdge", "GraphCluster", "GraphFilter", "NodeAction"])(
    "%s: ops.ts reads exactly the fields the reference lists",
    (type) => {
      for (const op of ops) parseOp(op);
      expect([...(reads.get(type) ?? [])].sort()).toEqual(fields(type).sort());
    },
  );

  it("the row icons and tutor events are the app's", async () => {
    const { TUTOR_EVENTS } = await import("../tutor/tutor");
    const literals = (alias: string | undefined) => [...(alias ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(literals(TYPES.TutorEvent?.alias)).toEqual([...TUTOR_EVENTS]);
    for (const icon of literals(TYPES.RowIcon?.alias)) {
      const op = { op: "section", id: "s", spec: { rows: [{ label: "x", actions: [{ label: "a", icon, run: "x" }] }] } };
      expect(parseOp(op), icon).not.toHaveProperty("invalid");
    }
    for (const icon of literals(TYPES.ToolbarIcon?.alias)) {
      expect(parseOp({ op: "toolbar", id: "t", spec: { label: "x", icon, run: "x" } }), icon).not.toHaveProperty("invalid");
    }
    const { PLUGIN_TOOLBAR_ICONS } = await import("./ops");
    expect(literals(TYPES.ToolbarIcon?.alias)).toEqual([...PLUGIN_TOOLBAR_ICONS]);
    const bad = { op: "section", id: "s", spec: { rows: [{ label: "x", actions: [{ label: "a", icon: "nope", run: "x" }] }] } };
    const message = (parseOp(bad) as { invalid: string }).invalid;
    expect(message.split("icon must be one of ")[1]?.split(", ")).toEqual(literals(TYPES.RowIcon?.alias));
  });
});
