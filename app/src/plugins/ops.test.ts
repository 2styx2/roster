// What ops.ts makes of a Plugin's views and Host-details sections (ticket 76): checked, cut, and
// a reason when it can't be used.
import { describe, expect, it } from "vitest";
import { parseOp, type PluginOp } from "./ops";

const view = (table: Record<string, unknown>) => parseOp({ op: "view", id: "scan", spec: { title: "Scan", table } });
const columns = [{ id: "name", label: "Host", kind: "data" }];

describe("a view's table", () => {
  it("takes columns, rows as plain data, a sort and actions with keys", () => {
    const op = view({ columns, rows: [{ id: "a", cells: { name: "esx-02" } }], sort: "name", desc: true, actions: [{ label: "Keep", key: "a", run: { handler: 3 } }] });
    expect(op).toEqual({
      op: "view",
      id: "scan",
      view: {
        title: "Scan",
        place: "panel",
        actions: [],
        facts: [],
        table: {
          columns: [{ id: "name", label: "Host", kind: "data" }],
          rows: [{ id: "a", cells: { name: "esx-02" } }],
          sort: { by: "name", desc: true },
          actions: [{ label: "Keep", key: "a", run: { handler: 3 } }],
        },
      },
    } satisfies PluginOp);
  });

  it("takes an empty Lua table as no cells or no rows", () => {
    expect(view({ columns, rows: {} })).not.toHaveProperty("invalid");
    expect(view({ columns, rows: [{ id: "a", cells: [] }] })).not.toHaveProperty("invalid");
  });

  it.each([
    [{ columns: [] }, "columns must have at least one column"],
    [{ columns, rows: [{ cells: {} }] }, "row 1: id must be text"],
    [{ columns, rows: [{ id: "a" }, { id: "a" }] }, "row id a is used twice"],
    [{ columns, rows: [{ id: "a", cells: { name: true } }] }, "cells.name must be text or a number"],
    [{ columns, sort: "ports" }, "sort names no column (ports)"],
    [{ columns, actions: [{ label: "Down", key: "j", run: "x" }] }, "the table uses j itself"],
    [{ columns, actions: [{ label: "A", key: "ab", run: "x" }] }, "key must be one character"],
    [{ columns: [{ id: "x", label: "X", kind: "date" }] }, 'kind must be "text", "data" or "number"'],
  ])("refuses %j: %s", (t, why) => {
    expect((view(t) as { invalid: string }).invalid).toContain(why);
  });
});

describe("a view update and a Host-details section", () => {
  it("an update has rows to add or replace and ids to remove", () => {
    expect(parseOp({ op: "view_update", id: "scan", changes: { rows: [{ id: "b", cells: { name: "10.0.0.7" } }], remove: ["a"] } })).toEqual({
      op: "view_update",
      id: "scan",
      update: { rows: [{ id: "b", cells: { name: "10.0.0.7" } }], remove: ["a"] },
    });
  });

  it("a section is per Host, and nil takes it away", () => {
    const op = parseOp({ op: "details", id: "mesh", host: "esx-02", spec: { facts: [{ label: "reach", value: "can reach 7 Hosts" }] } });
    expect(op).toEqual({ op: "details", id: "mesh", host: "esx-02", section: { title: "mesh", order: 500, actions: [], facts: [{ label: "reach", value: "can reach 7 Hosts" }] } });
    expect(parseOp({ op: "details", id: "mesh", host: "esx-02", spec: null })).toEqual({ op: "details", id: "mesh", host: "esx-02", section: null });
  });

  it("a view and a section take buttons for their heading, at most 4, with plan, apply and cut icons (ticket 91)", () => {
    const op = parseOp({ op: "view", id: "mesh", spec: { actions: [{ label: "Plan", icon: "plan", run: { handler: 1 } }, { label: "Apply", icon: "apply", run: "mesh apply" }] } });
    expect(op).toMatchObject({ view: { actions: [{ label: "Plan", icon: "plan", run: { handler: 1 } }, { label: "Apply", icon: "apply", run: { command: "mesh apply" } }] } });
    const section = parseOp({ op: "details", id: "mesh", host: "esx-02", spec: { actions: [{ label: "Cut esx-02", icon: "cut", run: { handler: 2 } }] } });
    expect(section).toMatchObject({ section: { actions: [{ label: "Cut esx-02", icon: "cut" }] } });
    const five = Array.from({ length: 5 }, (_, i) => ({ label: `A${i}`, run: "x" }));
    expect((parseOp({ op: "view", id: "v", spec: { actions: five } }) as { invalid: string }).invalid).toContain("actions has more than 4");
  });

  it("a heading's button takes a key of its own: one character, not the table's or graph's, not a table action's (#176)", () => {
    const invalid = (spec: Record<string, unknown>) => (parseOp({ op: "view", id: "mesh", spec }) as { invalid?: string }).invalid;
    const op = parseOp({ op: "view", id: "mesh", spec: { actions: [{ label: "Plan", key: "P", icon: "plan", run: { handler: 1 } }, { label: "Apply", run: "x" }] } });
    expect(op).toMatchObject({ view: { actions: [{ label: "Plan", key: "P" }, { label: "Apply" }] } });
    expect((op as { view: { actions: object[] } }).view.actions[1]).not.toHaveProperty("key");
    const section = parseOp({ op: "details", id: "mesh", host: "esx-02", spec: { actions: [{ label: "Cut", key: "X", run: "x" }] } });
    expect(section).toMatchObject({ section: { actions: [{ label: "Cut", key: "X" }] } });
    expect(invalid({ actions: [{ label: "A", key: "ab", run: "x" }] })).toContain("key must be one character");
    expect(invalid({ actions: [{ label: "A", key: "j", run: "x" }] })).toContain("the table or graph uses j itself");
    expect(invalid({ actions: [{ label: "A", key: "h", run: "x" }] })).toContain("the table or graph uses h itself");
    expect(invalid({ actions: [{ label: "A", key: "A", run: "x" }, { label: "B", key: "A", run: "y" }] })).toContain("key A is used twice");
    expect(invalid({ actions: [{ label: "A", key: "p", run: "x" }], table: { columns, rows: [], actions: [{ label: "Plan", key: "p", run: "y" }] } })).toContain("key p is used twice");
  });

  it("a view's place is a panel or full", () => {
    expect((parseOp({ op: "view", id: "v", spec: { place: "left" } }) as { invalid: string }).invalid).toContain('place must be "panel" or "full"');
  });
});
