// A stand-in Plugin with a view, a 600-row table and Host-details sections (ticket 76), for the
// `?fixture=plugin-views` and `?fixture=plugin-views-worst` dev pages: the table and sections can
// be looked at, and broken (break-ui), in a plain browser. Made-up addresses only.
import type { FakePlugin } from "./fakePlugins";

export const VIEWS_PATH = "~/plugins/demo-scan";

const TONES = [undefined, undefined, undefined, "muted", "warn", "error"] as const;

/** Worst-case cells: long and unbreakable, one letter, non-Latin, emoji, huge and missing. */
const WORST_TITLES = [
  "a",
  "Storage appliance in the far rack with a very long title that goes on and on past any column width",
  "ストレージ装置 (ラック 4)",
  "خادم النسخ الاحتياطي",
  "🔥 hot spare 🔥",
  "unbreakable-name-without-any-spaces-at-all-for-the-column-to-wrap-on.example.internal",
  "",
];

export function demoScanPlugin(worst = false, count = 600): FakePlugin {
  return {
    manifest: { name: "demo-scan", version: "1.0.0", description: "A made-up network scan, to look at views", author: "roster", api: 2, permissions: [] },
    load(roster) {
      const rows = Array.from({ length: count }, (_, i) => {
        const address = `10.${Math.floor(i / 250)}.${i % 250}.${(i * 7) % 254}`;
        const title = worst ? WORST_TITLES[i % WORST_TITLES.length] : `host-${i}`;
        const cells: Record<string, string | number> = { address, ports: worst && i % 9 === 0 ? 9_999_999 : (i * 13) % 40, state: i % 4 === 0 ? "changed" : "new" };
        if (title) cells.title = title;
        const tone = TONES[i % TONES.length];
        return { id: address, cells, ...(tone ? { tone } : {}) };
      });
      roster.views.set("demo-scan", {
        title: worst ? "Discover: a scan of 10.0.0.0/16 with a long name that keeps going" : "Discover",
        place: "full",
        text: worst
          ? "Scanning 10.0.0.0/16 gently. ".repeat(12) + "\n\nResults are kept as unreviewed Pending changes."
          : "Scanning 10.0.0.0/22 gently: 600 found so far.\n\nChoose which to keep; they're added unreviewed, as Pending changes.",
        facts: [
          { label: "range", value: "10.0.0.0/22", data: true },
          { label: "done", value: "64%" },
        ],
        table: {
          columns: [
            { id: "address", label: "Address", kind: "data", width: 16 },
            { id: "title", label: "Title" },
            { id: "ports", label: "Open ports", kind: "number", width: 11 },
            { id: "state", label: "State", width: 9 },
          ],
          rows,
          sort: "address",
          empty: "Nothing found yet.",
          open: (e: Record<string, unknown>) => roster.notify(`would open ${String(e.row)}`),
          actions: [
            { label: "Keep", key: "a", icon: "add", run: (e: Record<string, unknown>) => roster.views.update("demo-scan", { rows: [{ id: e.row, cells: { address: e.row, title: "kept", ports: 0, state: "kept" } }] }) },
            { label: "Skip", key: "x", icon: "close", run: (e: Record<string, unknown>) => roster.views.update("demo-scan", { remove: [e.row] }) },
            { label: "Copy address", key: "c", icon: "copy", run: (e: Record<string, unknown>) => roster.clipboard.copy(String(e.row)) },
            { label: "Cut", key: "u", when: { state: "changed" }, run: (e: Record<string, unknown>) => roster.notify(`would cut ${String(e.row)}`) },
          ],
        },
      });
      roster.views.set("demo-empty", {
        title: "Mesh links",
        text: "No Links yet: add one in the editor.",
        table: { columns: [{ id: "from", label: "From", kind: "data" }, { id: "to", label: "To", kind: "data" }], rows: [], empty: "No Links." },
      });
      roster.keymap.set("leader", "y v", "view demo-scan");
      // Ticket 78's pieces, to look at and break: a toolbar control, progress, a question (and its
      // stronger form), a section's buttons, a float's buttons and links.
      const long = worst ? " of 10.0.0.0/16 across every group, gently, with a title that goes on" : "";
      roster.toolbar.set("demo-scan", { label: "Scan a network", text: worst ? "Scan the whole lab" : "Scan", icon: "map", run: "view demo-scan" });
      roster.progress.set("demo-scan", { title: `Scanning 10.0.0.0/22${long}`, done: 384, total: 1024, cancel: () => roster.notify("stopping") });
      roster.progress.set("demo-wait", { title: worst ? "Waiting for roster serve to answer a very long request" : "Waiting for the mesh" });
      const ask = (danger: boolean) => () =>
        roster.confirm({
          title: worst ? "Cut storage-appliance-in-the-far-rack-with-a-long-name from the Mesh?" : "Cut esx-02 from the Mesh?",
          text: worst ? "Its key is taken off 4,812 Hosts. ".repeat(10) : "Its key is taken off the 7 Hosts it can reach. They can't reach it until you apply the Mesh again.",
          facts: [{ label: "reach", value: worst ? "4,812 Hosts across 37 groups" : "7 Hosts" }, { label: "host", value: "esx-02", data: true }],
          action: "Cut",
          danger,
          ...(danger ? { typed: worst ? "storage-appliance-in-the-far-rack-with-a-long-name" : "esx-02" } : {}),
          run: () => roster.notify("cut"),
        });
      roster.commands.add("demo-cut", { desc: "Ask before a Cut (the stronger form)", run: ask(true) });
      roster.commands.add("demo-apply", { desc: "Ask before applying", run: ask(false) });
      roster.commands.add("demo-float", {
        desc: "A float with buttons and links",
        run: () =>
          roster.float.open({
            title: "esx-02",
            lines: worst ? Array.from({ length: 40 }, (_, i) => `ERROR ${"disk full ".repeat(i % 5)}${i}`) : ["ERROR disk full", "at 10:42"],
            actions: [
              { label: "Go to the line", key: "g", run: () => roster.notify("went") },
              { label: worst ? "Dismiss this alert and every one like it" : "Dismiss", key: "d", run: () => roster.notify("dismissed") },
            ],
            links: [{ label: "Runbook", url: worst ? "https://a-very-long-wiki-host-name.example.com/runbooks/storage/disk-full-on-the-far-rack" : "https://wiki.example.com/disk-full" }],
          }),
      });
      roster.sidebar.set("demo-alerts", {
        title: "Recent alerts",
        rows: [{ id: "a", label: "ERROR disk full", detail: "esx-02", host: "linux-1-000" }],
        actions: [
          { label: "Dismiss all", icon: "close", run: () => roster.notify("dismissed all") },
          { label: "Show the alerts", icon: "info", run: "view demo-scan" },
        ],
      });
      for (const host of ["linux-1-000", "esxi-2-001", "nas-4-007"]) {
        roster.details.set("mesh", host, {
          title: "Mesh",
          facts: [{ label: "reach", value: worst ? "can reach 4,812 Hosts across 37 groups and 12 Links" : "can reach 7 Hosts" }],
          table: {
            columns: [
              { id: "peer", label: "Peer", kind: "data" },
              { id: "how", label: "How" },
            ],
            rows: Array.from({ length: worst ? 40 : 3 }, (_, i) => ({ id: String(i), cells: { peer: `web-${i}`, how: i % 2 ? "key" : "password" }, ...(i === 1 ? { tone: "warn" } : {}) })),
            actions: [{ label: "Cut", key: "x", icon: "close", run: (e: Record<string, unknown>) => roster.notify(`would cut ${String(e.host)}`) }],
          },
        });
      }
    },
  };
}
