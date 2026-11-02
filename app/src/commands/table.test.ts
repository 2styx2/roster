import { describe, expect, it } from "vitest";
import type { ViewMode } from "../view/layout";
import { builtinCommandRegistry, complete as completeIn, describeLine as describeIn, parseLine as parseIn, runLine as runIn, type CommandContext } from "./table";

const registry = builtinCommandRegistry();
const commands = registry.list();
const runLine = (ctx: CommandContext, line: string) => runIn(registry, ctx, line);
const parseLine = (line: string) => parseIn(registry, line);
const describeLine = (line: string) => describeIn(registry, line);
const complete = (input: string, hosts: readonly string[]) => completeIn(registry, input, hosts);

/** A CommandContext that writes down what it was asked to do. */
function recorder(mode: ViewMode = "standard") {
  const calls: string[] = [];
  const ctx: CommandContext = {
    openPicker: () => calls.push("picker"),
    connect: (h, here) => calls.push(`connect ${h}${here ? " here" : ""}`),
    quickConnect: (t) => calls.push(`quick ${t ?? "picker"}`),
    reconnect: () => calls.push("reconnect"),
    check: (h) => calls.push(`check ${h ?? "current"}`),
    selectRelative: (d) => calls.push(`relative ${d}`),
    selectNth: (n) => calls.push(`nth ${n}`),
    close: (n) => calls.push(`close ${n ?? "current"}`),
    toggleSidebar: () => calls.push("sidebar"),
    toggleStatusBar: () => calls.push("statusbar"),
    openCommandLine: (initial) => calls.push(initial ? `cmdline ${initial}` : "cmdline"),
    toggleKeys: () => calls.push("keys"),
    lock: () => calls.push("lock"),
    vault: (a) => calls.push(`vault ${a}`),
    toTerminal: () => calls.push("terminal"),
    closePanel: () => calls.push("hidepanel"),
    list: (m) => calls.push(`list ${m}`),
    open: (h) => calls.push(`open ${h}`),
    fold: (id, how) => calls.push(`${how} ${id ?? "cursor"}`),
    cursorRow: () => null,
    selectedHost: () => null,
    hostNames: () => hosts,
    say: (m) => calls.push(`say ${m}`),
    viewMode: () => mode,
    setViewMode: (m) => calls.push(`mode ${m ?? "other"}`),
    openFinder: (id) => calls.push(`finder ${id}`),
    showInfo: () => calls.push("info"),
    details: (h) => calls.push(`details ${h ?? "toggle"}`),
    edit: (h) => calls.push(`edit ${h ?? "selected"}`),
    showChanges: (then) => calls.push(then ? `changes ${then}` : "changes"),
    pull: () => calls.push("pull"),
    addHost: (g) => calls.push(g ? `add ${g}` : "add"),
    saveSession: () => calls.push("save"),
    fillPrompt: () => calls.push("fill"),
    integrate: () => calls.push("integrate"),
    inventory: (op) => calls.push(`inventory ${JSON.stringify(op)}`),
    groupNames: () => ["lab", "net"],
    review: (h, reviewed = true) => calls.push(`${reviewed ? "review" : "unreview"} ${h ?? "selected"}`),
    config: (what) => calls.push(`config ${what}`),
  };
  return { ctx, calls };
}

const hosts = ["esxi-02", "esxi-01", "net-sw-core-01", "orion3", "hub2", "lab-hub2"];

describe("runLine", () => {
  it("runs the Inventory commands (ticket 10)", () => {
    const { ctx, calls } = recorder();
    for (const line of ["edit esxi-02", "edit", "changes", "discard", "publish", "pull"]) runLine(ctx, line);
    expect(calls).toEqual(["edit esxi-02", "edit selected", "changes", "changes discard", "changes publish", "pull"]);
  });

  it("runs :host add and :review (ticket 11), and says what :host takes", () => {
    const { ctx, calls } = recorder();
    for (const line of ["host add", "review switch-4-003", "review", "host frob"]) runLine(ctx, line);
    expect(calls).toEqual([
      "add",
      "review switch-4-003",
      "review selected",
      "say host takes add, remove, rename, move, review, unreview (not frob)",
    ]);
    expect(complete("host ", hosts)).toEqual([
      "host add",
      "host remove ",
      "host rename ",
      "host move ",
      "host review ",
      "host unreview ",
    ]);
    expect(complete("rev", hosts)).toEqual(["review"]);
  });

  it("runs :host unreview and :unreview (issue #78), on the named Host or the selected one", () => {
    const { ctx, calls } = recorder();
    for (const line of ["host unreview switch-4-003", "host unreview", "unreview orion3", "host review orion3", "host unreview a b"]) {
      runLine(ctx, line);
    }
    expect(calls).toEqual([
      "unreview switch-4-003",
      "unreview selected",
      "unreview orion3",
      "review orion3",
      "say host unreview takes one Host",
    ]);
    expect(complete("host unreview orion", hosts)).toEqual(["host unreview orion3"]);
  });

  it("runs :host remove|rename|move and :group new|rename|delete (ticket 28), asking for what's missing", () => {
    const { ctx, calls } = recorder();
    for (const line of [
      "host remove orion3",
      "host remove",
      "host remove nope",
      "host rename orion3 orion4",
      "host rename orion3",
      "host move hub2 net",
      "host move hub2",
      "host add lab",
      "group new dmz",
      "group new",
      "group rename lab",
      "group rename lab bench",
      "group delete lab",
      "group delete lab net",
      "group delete nope",
    ]) {
      runLine(ctx, line);
    }
    expect(calls).toEqual([
      'inventory {"op":"remove","host":"orion3"}',
      "say No Host selected: move to one in the Sidebar, or use host remove HOST",
      "say No Host named nope",
      'inventory {"op":"rename","host":"orion3","to":"orion4"}',
      "cmdline host rename orion3 ",
      'inventory {"op":"move","host":"hub2","group":"net"}',
      "cmdline host move hub2 ",
      "add lab",
      'inventory {"op":"group-new","name":"dmz"}',
      "cmdline group new ",
      "cmdline group rename lab ",
      'inventory {"op":"group-rename","group":"lab","to":"bench"}',
      'inventory {"op":"group-delete","group":"lab"}',
      'inventory {"op":"group-delete","group":"lab","to":"net"}',
      "say No group named nope",
    ]);
    const more = { foldIds: [], sessions: [], groupNames: ["lab", "net"] };
    expect(completeIn(registry, "host move hub2 ", hosts, more)).toEqual(["host move hub2 lab", "host move hub2 net"]);
    expect(completeIn(registry, "host rem", hosts, more)).toEqual(["host remove "]);
    expect(completeIn(registry, "host remove or", hosts, more)).toEqual(["host remove orion3"]);
    expect(completeIn(registry, "group delete lab ", hosts, more)).toEqual(["group delete lab net"]);
    expect(completeIn(registry, "group ", hosts, more)).toEqual(["group new ", "group rename ", "group delete "]);
  });

  it("runs :info alone as the app's info, :info HOST as Host details, :details as its toggle (ticket 18)", () => {
    const { ctx, calls } = recorder();
    for (const line of ["info", "info esxi-02", "details"]) runLine(ctx, line);
    expect(calls).toEqual(["info", "details esxi-02", "details toggle"]);
    expect(complete("info esx", hosts)).toEqual(["info esxi-01", "info esxi-02"]);
    expect(describeLine("info esxi-02")).toEqual({ area: "Hosts", label: "Show esxi-02's details" });
  });

  it("runs :open with a Host, a web service, or both; the app works out which (ticket 18)", () => {
    const { ctx, calls } = recorder();
    for (const line of ["open esxi-02", "open web", "open esxi-02 admin"]) runLine(ctx, line);
    expect(calls).toEqual(["open esxi-02", "open web", "open esxi-02 admin"]);
  });

  it("runs :check for a Host, or for this Box with no argument", () => {
    const { ctx, calls } = recorder();
    runLine(ctx, "check esxi-02");
    runLine(ctx, "check");
    expect(calls).toEqual(["check esxi-02", "check current"]);
  });

  it("runs a command by its name, with its argument", () => {
    const { ctx, calls } = recorder();
    runLine(ctx, "connect esxi-02");
    runLine(ctx, " session 3 ");
    runLine(ctx, "close");
    runLine(ctx, "close 2");
    runLine(ctx, "next");
    runLine(ctx, "prev");
    runLine(ctx, "lock");
    runLine(ctx, "here hub2");
    runLine(ctx, "reconnect");
    expect(calls).toEqual([
      "connect esxi-02",
      "nth 3",
      "close current",
      "close 2",
      "relative 1",
      "relative -1",
      "lock",
      "connect hub2 here",
      "reconnect",
    ]);
  });

  it("switches the view mode: `mode` to the other one or the one named, `focus` in and out of Focus", () => {
    const { ctx, calls } = recorder();
    runLine(ctx, "mode");
    runLine(ctx, "mode focus");
    runLine(ctx, "mode standard");
    runLine(ctx, "mode zen");
    runLine(ctx, "focus");
    expect(calls).toEqual(["mode other", "mode focus", "mode standard", "say Not a view mode: zen (standard, focus)", "mode focus"]);
    const inFocus = recorder("focus");
    runLine(inFocus.ctx, "focus");
    expect(inFocus.calls).toEqual(["mode standard"]);
    expect(complete("mode ", hosts)).toEqual(["mode standard", "mode focus"]);
  });

  it("says what's wrong with a bad line, and ignores an empty one", () => {
    const { ctx, calls } = recorder();
    runLine(ctx, "conect x");
    runLine(ctx, "connect");
    runLine(ctx, "lock now");
    runLine(ctx, "session x");
    runLine(ctx, "  ");
    expect(calls).toEqual([
      "say Not a command: conect",
      "say connect needs a Host name",
      "say lock takes no argument",
      "say session needs a number",
    ]);
  });

  it("can run every command in the table", () => {
    for (const c of commands) {
      const { ctx, calls } = recorder();
      const text = c.complete?.("", hosts)[0] ?? "section:sessions";
      const arg = c.arg ? { host: " esxi-02", number: " 1", text: ` ${text}` }[c.arg] : "";
      runLine(ctx, `${c.id}${arg}`);
      expect(calls, c.id).toHaveLength(1);
      expect(calls[0], c.id).not.toMatch(/^say/);
    }
  });
});

describe("parseLine", () => {
  it("finds the command and its argument", () => {
    expect(parseLine("session 2")).toMatchObject({ kind: "ok", arg: "2", command: { id: "session", source: "builtin" } });
    expect(parseLine("")).toEqual({ kind: "empty" });
  });
});

describe("describeLine", () => {
  it("names what a line does, for the Key bindings panel", () => {
    expect(describeLine("session 1")).toEqual({ area: "Sessions", label: "Go to Session 1" });
    expect(describeLine("close")).toEqual({ area: "Sessions", label: "Close the Session" });
    expect(describeLine("nope")).toEqual({ area: "Other", label: "nope (not a command)" });
  });
});

describe("complete", () => {
  it("offers every command for an empty line", () => {
    expect(complete("", hosts)).toEqual(expect.arrayContaining(["connect ", "close", "lock"]));
  });

  it("completes a command name, with a space when it needs an argument", () => {
    // A seldom command (config) comes after the everyday ones.
    expect(complete("co", hosts)).toEqual(["connect ", "config"]);
    expect(complete("l", hosts)).toEqual(["lock"]);
    expect(complete("cl", hosts)).toEqual(["close"]);
  });

  it("completes Host names after connect: prefix matches first, then the rest that contain it", () => {
    expect(complete("connect esx", hosts)).toEqual(["connect esxi-01", "connect esxi-02"]);
    expect(complete("connect hub", hosts)).toEqual(["connect hub2", "connect lab-hub2"]);
    expect(complete("connect ", hosts)).toHaveLength(hosts.length);
  });

  it("completes :open with the current Host's web services first, then Host names, then HOST's services (ticket 18)", () => {
    const services = (h: string | null) => (h === null ? ["web", "admin"] : h === "esxi-02" ? ["web", "ui"] : []);
    const more = { foldIds: [], sessions: [], webServices: services };
    expect(completeIn(registry, "open ", hosts, more).slice(0, 3)).toEqual(["open web", "open admin", "open esxi-01"]);
    expect(completeIn(registry, "open e", hosts, more)).toEqual(["open esxi-01", "open esxi-02", "open web", "open net-sw-core-01"]);
    expect(completeIn(registry, "open esxi-02 ", hosts, more)).toEqual(["open esxi-02 web", "open esxi-02 ui"]);
    expect(completeIn(registry, "open esxi-02 u", hosts, more)).toEqual(["open esxi-02 ui"]);
    // Without what the app knows, Host names, as before.
    expect(complete("open hub", hosts)).toEqual(["open hub2", "open lab-hub2"]);
  });

  it("offers nothing for other arguments", () => {
    expect(complete("lock x", hosts)).toEqual([]);
  });

  it("completes the Sidebar's foldable rows after fold, unfold and togglefold (ticket 34)", () => {
    const more = { foldIds: ["section:sessions", "group:subnet-42", "folder:Lab ESXi"], sessions: [] };
    expect(completeIn(registry, "fold g", hosts, more)).toEqual(["fold group:subnet-42"]);
    expect(completeIn(registry, "togglefold lab", hosts, more)).toEqual(["togglefold folder:Lab ESXi"]);
    expect(completeIn(registry, "unfold ", hosts, more)).toHaveLength(3);
  });

  it("completes the open Sessions' numbers after session and close (ticket 34)", () => {
    const more = { foldIds: [], sessions: ["esxi-01", "hub2", "orion3"] };
    expect(completeIn(registry, "session ", hosts, more)).toEqual(["session 1", "session 2", "session 3"]);
    expect(completeIn(registry, "close 2", hosts, more)).toEqual(["close 2"]);
  });

  it("hands a command's own hook what the app knows, so a Plugin's command can use it", () => {
    const r = builtinCommandRegistry();
    r.register({
      id: "jump",
      source: "my-plugin",
      area: "Sidebar",
      arg: "text",
      label: () => "Jump",
      run: () => undefined,
      complete: (arg, _hosts, ctx) => (ctx?.foldIds ?? []).filter((id) => id.startsWith(arg)),
    });
    expect(completeIn(r, "jump gr", [], { foldIds: ["group:a", "section:b"], sessions: [] })).toEqual(["jump group:a"]);
  });
});

describe("the registry", () => {
  it("runs a command the Config or a Plugin registered, and lets one shadow a built-in", () => {
    const r = builtinCommandRegistry();
    const { ctx, calls } = recorder();
    r.register({ id: "home", source: "init.lua", area: "Hosts", label: () => "Home box", run: (c) => c.connect("orion3") });
    const undo = r.register({ id: "lock", source: "my-plugin", area: "App", label: () => "Lock", run: (c) => c.say("no") });
    runIn(r, ctx, "home");
    runIn(r, ctx, "lock");
    undo();
    runIn(r, ctx, "lock");
    expect(calls).toEqual(["connect orion3", "say no", "lock"]);
    expect(completeIn(r, "hom", [])).toEqual(["home"]);
  });
});
