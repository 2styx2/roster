import { describe, expect, it } from "vitest";
import { actionApplies, filterRows, mergeRows, nextSort, sortRows, splitMiddle, windowOf, type TableColumn, type TableRow } from "./table";

const columns: TableColumn[] = [
  { id: "name", label: "Host", kind: "data" },
  { id: "ports", label: "Ports", kind: "number" },
  { id: "note", label: "Note", kind: "text" },
];
const row = (id: string, cells: TableRow["cells"]): TableRow => ({ id, cells });

describe("sortRows", () => {
  const rows = [row("a", { name: "10.0.0.10", ports: 3 }), row("b", { name: "10.0.0.9", ports: 12 }), row("c", { ports: 1 }), row("d", { name: "esx-02" })];

  it("keeps the given order with no sort", () => {
    expect(sortRows(rows, columns, null).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("sorts data with its numbers as numbers, and a missing value last either way", () => {
    expect(sortRows(rows, columns, { by: "name", desc: false }).map((r) => r.id)).toEqual(["b", "a", "d", "c"]);
    expect(sortRows(rows, columns, { by: "name", desc: true }).map((r) => r.id)).toEqual(["d", "a", "b", "c"]);
  });

  it("sorts a number column as numbers, and is stable", () => {
    expect(sortRows(rows, columns, { by: "ports", desc: true }).map((r) => r.id)).toEqual(["b", "a", "c", "d"]);
    const ties = [row("x", { ports: 1 }), row("y", { ports: 1 }), row("z", { ports: 0 })];
    expect(sortRows(ties, columns, { by: "ports", desc: false }).map((r) => r.id)).toEqual(["z", "x", "y"]);
  });
});

describe("mergeRows", () => {
  it("replaces a row in place, adds new ones at the end and takes removed ones away", () => {
    const rows = [row("a", { ports: 1 }), row("b", { ports: 2 }), row("c", { ports: 3 })];
    const merged = mergeRows(rows, [row("b", { ports: 20 }), row("d", { ports: 4 })], ["a"]);
    expect(merged.map((r) => [r.id, r.cells.ports])).toEqual([
      ["b", 20],
      ["c", 3],
      ["d", 4],
    ]);
  });

  it("takes 5,000 updates into 5,000 rows quickly", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => row(String(i), { ports: i }));
    const updates = Array.from({ length: 5000 }, (_, i) => row(String(i * 2), { ports: -i }));
    const start = performance.now();
    const merged = mergeRows(rows, updates, []);
    expect(performance.now() - start).toBeLessThan(100);
    expect(merged).toHaveLength(7500);
  });
});

describe("nextSort", () => {
  it("goes to the next column, then back to none", () => {
    expect(nextSort(columns, null)).toEqual({ by: "name", desc: false });
    expect(nextSort(columns, { by: "name", desc: true })).toEqual({ by: "ports", desc: false });
    expect(nextSort(columns, { by: "note", desc: false })).toBeNull();
  });
});

describe("windowOf", () => {
  it("draws the rows on screen and a few more, never past the ends", () => {
    expect(windowOf({ count: 1000, rowHeight: 24, scrollTop: 2400, height: 240, overscan: 5 })).toEqual({ start: 95, end: 115 });
    expect(windowOf({ count: 3, rowHeight: 24, scrollTop: 0, height: 240, overscan: 5 })).toEqual({ start: 0, end: 3 });
  });

  it("draws a first screenful when it can't measure (a hidden panel, tests)", () => {
    expect(windowOf({ count: 1000, rowHeight: 24, scrollTop: 0, height: 0, overscan: 5 })).toEqual({ start: 0, end: 45 });
  });
});

describe("actionApplies (ticket 78)", () => {
  const row: TableRow = { id: "a", cells: { state: "up", ports: 3 } };
  it("applies with no condition, and when every named cell holds one of its values", () => {
    expect(actionApplies(undefined, row)).toBe(true);
    expect(actionApplies({ state: ["up"] }, row)).toBe(true);
    expect(actionApplies({ state: ["down", "up"], ports: ["3"] }, row)).toBe(true);
  });
  it("doesn't when a cell differs or is missing", () => {
    expect(actionApplies({ state: ["down"] }, row)).toBe(false);
    expect(actionApplies({ group: ["lab"] }, row)).toBe(false);
  });
});

describe("filterRows (ticket 78)", () => {
  const columns: TableColumn[] = [
    { id: "name", label: "Name", kind: "data" },
    { id: "title", label: "Title", kind: "text" },
  ];
  const rows: TableRow[] = [
    { id: "1", cells: { name: "esx-02", title: "Storage appliance" } },
    { id: "2", cells: { name: "pve-1", title: "Lab" }, host: "esx-02" },
    { id: "3", cells: { name: "nas-4", title: "ストレージ" } },
  ];
  it("keeps the rows that say every word, in any column, ignoring case", () => {
    expect(filterRows(rows, columns, "ESX storage").map((r) => r.id)).toEqual(["1"]);
    expect(filterRows(rows, columns, "ストレージ").map((r) => r.id)).toEqual(["3"]);
  });
  it("looks only at what the columns show, and keeps everything for an empty query", () => {
    expect(filterRows(rows, columns, "esx").map((r) => r.id)).toEqual(["1"]);
    expect(filterRows(rows, columns, "  ")).toBe(rows);
  });
});

describe("middle truncation (ticket 91)", () => {
  it("keeps a long value's end, so names that differ only at the end still differ", () => {
    expect(splitMiddle("server-10-19-77-203")).toEqual(["server-10-19", "-77-203"]);
    expect(splitMiddle("server-10-19-77-203-long-and-longer")).toEqual(["server-10-19-77-203-long-an", "d-longer"]);
    expect(splitMiddle("esx-02")).toEqual(["esx-02", ""]);
    expect(splitMiddle("🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂")).toEqual(["🙂".repeat(8), "🙂".repeat(5)]);
  });
});
