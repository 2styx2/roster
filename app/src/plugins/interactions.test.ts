// What ops.ts and cmd.ts make of a Plugin's interactions (ticket 78, decision Q98): a question the
// app draws, progress, toolbar controls, float buttons and links, section buttons, a command line,
// going to a Session, and a table's per-row conditions and updates of its columns and actions.
import { describe, expect, it } from "vitest";
import { lineRefused, PLUGIN_COMMANDS } from "./cmd";
import { parseOp } from "./ops";
import { BUILTIN } from "../registry";

const invalid = (raw: unknown) => (parseOp(raw) as { invalid?: string }).invalid;

describe("roster.confirm", () => {
  it("takes the question, its facts, the danger form and the word to type", () => {
    const op = parseOp({ op: "confirm", spec: { title: "Cut esx-02?", text: "Its key goes.", action: "Cut", danger: true, typed: "esx-02", run: { handler: 1 }, cancel: { handler: 2 } } });
    expect(op).toEqual({
      op: "confirm",
      confirm: { title: "Cut esx-02?", text: "Its key goes.", facts: [], action: "Cut", danger: true, typed: "esx-02", run: { handler: 1 }, cancel: { handler: 2 } },
    });
  });
  it("says Confirm when no word is given, and refuses what can't be a question", () => {
    expect(parseOp({ op: "confirm", spec: { title: "Sure?", run: { handler: 1 } } })).toMatchObject({ confirm: { action: "Confirm", danger: false } });
    expect(invalid({ op: "confirm", spec: { title: "Sure?", run: "publish" } })).toMatch(/run must be a function/);
    expect(invalid({ op: "confirm", spec: { title: "Sure?", typed: "x", run: { handler: 1 } } })).toMatch(/typed goes with danger/);
    expect(invalid({ op: "confirm", spec: { run: { handler: 1 } } })).toMatch(/title must be text/);
  });
});

describe("roster.progress", () => {
  it("is a share with done and total, or only that it's going", () => {
    expect(parseOp({ op: "progress", id: "scan", spec: { title: "Scanning", done: 300, total: 256 } })).toMatchObject({ progress: { done: 256, total: 256 } });
    expect(parseOp({ op: "progress", id: "scan", spec: { title: "Waiting" } })).toEqual({ op: "progress", id: "scan", progress: { title: "Waiting" } });
    expect(invalid({ op: "progress", id: "scan", spec: { title: "x", done: 1 } })).toMatch(/done and total go together/);
    expect(invalid({ op: "progress", id: "scan", spec: { title: "x", done: 0, total: 0 } })).toMatch(/total must be more than 0/);
  });
});

describe("roster.toolbar", () => {
  it("takes a label, a word and one of the Plugin icons", () => {
    expect(parseOp({ op: "toolbar", id: "scan", spec: { label: "Scan a network", text: "Scan", icon: "map", run: "view scan" } })).toEqual({
      op: "toolbar",
      id: "scan",
      control: { label: "Scan a network", text: "Scan", icon: "map", run: { command: "view scan" } },
    });
    expect(invalid({ op: "toolbar", id: "x", spec: { label: "x", icon: "publish", run: "x" } })).toMatch(/icon must be one of find, add, details, help, map/);
  });
});

describe("a float's buttons and links", () => {
  it("takes http and https links only, and keys that aren't q", () => {
    const op = parseOp({ op: "float", spec: { title: "t", lines: [], actions: [{ label: "Go", key: "g", run: { handler: 1 } }], links: [{ label: "Runbook", url: "https://wiki.example.com/a b" }] } });
    expect(op).toMatchObject({ spec: { actions: [{ label: "Go", key: "g" }], links: [{ label: "Runbook", url: "https://wiki.example.com/a%20b" }] } });
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "https://you:pw@example.com/", "not a url"]) {
      expect(invalid({ op: "float", spec: { links: [{ label: "x", url }] } }), url).toMatch(/https:\/\/ or http:\/\//);
    }
    expect(invalid({ op: "float", spec: { actions: [{ label: "x", key: "q", run: "x" }] } })).toMatch(/q closes/);
  });
});

describe("a section's buttons", () => {
  it("are row actions, at most four", () => {
    const op = parseOp({ op: "section", id: "alerts", spec: { rows: [], actions: [{ label: "Dismiss all", icon: "close", run: { handler: 1 } }] } });
    expect(op).toMatchObject({ actions: [{ label: "Dismiss all", icon: "close", run: { handler: 1 } }] });
    const five = Array.from({ length: 5 }, () => ({ label: "x", run: "x" }));
    expect(invalid({ op: "section", id: "a", spec: { actions: five } })).toMatch(/more than 4/);
  });
});

describe("a table's conditions and updates", () => {
  const columns = [{ id: "host", label: "Host" }];
  it("an action's when is cell = value or a list of them", () => {
    const op = parseOp({ op: "view", id: "v", spec: { table: { columns, actions: [{ label: "Cut", key: "x", when: { state: "up", ports: [22, "80"] }, run: { handler: 1 } }] } } });
    expect(op).toMatchObject({ view: { table: { actions: [{ when: { state: ["up"], ports: [22, "80"] } }] } } });
    expect(invalid({ op: "view", id: "v", spec: { table: { columns, actions: [{ label: "x", when: { state: {} }, run: "x" }] } } })).toMatch(/when.state must be/);
  });
  it("an update takes new columns, a sort among them and new actions", () => {
    const op = parseOp({ op: "view_update", id: "v", changes: { columns: [...columns, { id: "state", label: "State" }], sort: "state", desc: true, actions: [{ label: "Check", key: "c", run: { handler: 2 } }] } });
    expect(op).toMatchObject({ update: { sort: { by: "state", desc: true }, actions: [{ label: "Check" }] } });
    expect(invalid({ op: "view_update", id: "v", changes: { columns, sort: "state" } })).toMatch(/sort names no column/);
    expect(invalid({ op: "view_update", id: "v", changes: { actions: [{ label: "x", key: "j", run: "x" }] } })).toMatch(/the table uses j itself/);
  });
});

describe("roster.cmd and a Plugin's command lines", () => {
  const sources: Record<string, string> = { finder: BUILTIN, open: BUILTIN, plugins: BUILTIN, publish: BUILTIN, alerts: "recent-alerts", scan: "discover", view: BUILTIN };
  const refused = (line: string, granted: string[] = []) => lineRefused(line, "recent-alerts", granted, (n) => sources[n]);
  it("runs its own commands and the core's list, with the permission each needs", () => {
    expect(refused("finder alerts")).toBeNull();
    expect(refused("alerts clear")).toBeNull();
    expect(refused("view scan")).toBeNull();
    expect(refused("open esx-02")).toBe(":open needs the sessions.open permission");
    expect(refused("open esx-02", ["sessions.open"])).toBeNull();
  });
  it("never :plugins, :publish, another Plugin's command, or a command another source took over", () => {
    expect(refused("plugins grant recent-alerts terminal.write")).toMatch(/isn't one a Plugin may run/);
    expect(refused("publish")).toMatch(/isn't one a Plugin may run/);
    expect(refused("scan")).toMatch(/isn't one a Plugin may run/);
    expect(lineRefused("finder x", "p", [], () => "init.lua")).toMatch(/isn't one a Plugin may run/);
    expect(refused("  ")).toBe("which command?");
  });
  it("the list is the core's", () => {
    expect(PLUGIN_COMMANDS.map((c) => c.name)).toContain("finder");
    expect(PLUGIN_COMMANDS.some((c) => ["plugins", "packages", "publish", "source", "config", "vault"].includes(c.name))).toBe(false);
  });
});

describe("going to a Session", () => {
  it("names the Session and the line, or none", () => {
    expect(parseOp({ op: "session_show", session: 3, line: "ERROR disk full" })).toEqual({ op: "session_show", session: 3, line: "ERROR disk full" });
    expect(parseOp({ op: "session_show", session: 3, line: null })).toEqual({ op: "session_show", session: 3, line: null });
    expect(invalid({ op: "session_show", session: 1.5 })).toMatch(/which Session/);
  });
});
