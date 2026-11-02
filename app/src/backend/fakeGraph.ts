// A stand-in Topology-like Plugin with a graph view (ticket 77), for the `?fixture=plugin-graph`
// (640 Hosts) and `?fixture=plugin-graph-worst` (2,000 Hosts, worst-case names) dev pages: the
// graph can be looked at, moved through and broken (break-ui) in a plain browser. It isn't the
// Topology Plugin (T40): only data shaped like it. Made-up names and addresses only.
import type { FakePlugin } from "./fakePlugins";

export const GRAPH_PATH = "~/plugins/demo-map";

const WORST_NAMES = [
  "a",
  "storage-appliance-in-the-far-rack-with-a-very-long-name-that-goes-on-and-on.example.internal",
  "ストレージ装置-4",
  "خادم-النسخ",
  "🔥-hot-spare",
  "x",
];
const SHAPES = ["dot", "dot", "dot", "ring", "dashed", "hollow"] as const;

export function demoMapPlugin(count = 640, groups = 16, worst = false): FakePlugin {
  return {
    manifest: { name: "demo-map", version: "1.0.0", description: "A made-up network map, to look at graphs", author: "roster", api: 2, permissions: [] },
    load(roster) {
      const clusters = Array.from({ length: groups }, (_, g) => ({
        id: `subnet-${g + 1}`,
        title: worst && g % 5 === 2 ? `subnet-${g + 1}-with-a-group-name-much-too-long-for-its-circle` : `subnet-${g + 1}`,
        ...(g % 3 === 0 ? { mesh: true } : {}),
      }));
      const nodes: Record<string, unknown>[] = [{ id: "box", label: "devbox", shape: "square", kind: "box" }];
      for (let i = 0; i < count; i++) {
        const g = i % groups;
        const name = worst && i % 37 === 0 ? `${WORST_NAMES[(i / 37) % WORST_NAMES.length]}-${i}` : `host-${g + 1}-${String(i).padStart(3, "0")}`;
        nodes.push({
          id: `h${i}`,
          label: name,
          cluster: `subnet-${g + 1}`,
          host: name,
          kind: ["linux", "esxi", "nas", "switch"][i % 4],
          detail: `10.${g}.${Math.floor(i / 250)}.${(i % 250) + 1}`,
          shape: SHAPES[i % SHAPES.length],
          ...(i % 29 === 3 ? { state: "live" } : i % 23 === 5 ? { state: "down" } : {}),
          ...(i % 41 === 7 ? { mark: "warn", note: "out of date" } : i % 53 === 9 ? { mark: "error", note: "cut pending" } : {}),
        });
      }
      const edges: Record<string, unknown>[] = clusters.map((c) => ({ from: "box", to: c.id, tone: "muted" }));
      // Live Sessions: an edge from this Box in the accent.
      for (let i = 3; i < count; i += 29) edges.push({ from: "box", to: `h${i}`, tone: "live" });
      // Links across groups, some both ways; password peers dashed; some out of date or being cut.
      for (let g = 0; g + 1 < groups; g += 2) edges.push({ from: `subnet-${g + 1}`, to: `subnet-${g + 2}`, dir: g % 4 === 0 ? "both" : "one", label: "Link" });
      for (let i = 0; i + groups < count; i += 7) {
        const e: Record<string, unknown> = { from: `h${i}`, to: `h${i + groups + 1}`, style: i % 3 === 0 ? "dashed" : "solid" };
        if (i % 5 === 0) e.tone = "warn";
        if (i % 11 === 0) e.cut = true;
        edges.push(e);
      }
      const live = new Set<string>();
      roster.views.set("demo-map", {
        title: worst ? "Topology of every network we have ever had, with a title that keeps on going" : "Topology",
        place: "full",
        graph: {
          clusters,
          nodes,
          edges,
          open: (e: Record<string, unknown>) => roster.notify(`would open a Session to ${String(e.host ?? e.node)}`),
          actions: [
            { label: "Check", key: "c", run: (e: Record<string, unknown>) => roster.notify(`would check ${String(e.host ?? e.node)}`) },
            {
              label: "Connect",
              key: "w",
              run: (e: Record<string, unknown>) => {
                const id = String(e.node);
                const on = !live.has(id);
                if (on) live.add(id);
                else live.delete(id);
                roster.views.update("demo-map", on ? { edges: [{ id: `live:${id}`, from: "box", to: id, tone: "live" }] } : { remove_edges: [`live:${id}`] });
              },
            },
            { label: "Cut", key: "x", run: (e: Record<string, unknown>) => roster.notify(`would cut ${String(e.host ?? e.node)}`) },
          ],
        },
      });
      roster.keymap.set("leader", "y m", "view demo-map");
    },
  };
}
