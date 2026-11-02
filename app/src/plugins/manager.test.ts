// The Plugin manager (ticket 23) over the fake Backend's Plugin host: installing asks first,
// ops become registry entries with the Plugin's name as their source, revoking takes a permission
// away at once, and only Sessions' output (never what's typed) reaches terminal.read.
import { describe, expect, it, vi } from "vitest";
import { fakeBackend, makeHosts } from "../backend/fake";
import type { FakePlugin } from "../backend/fakePlugins";
import { builtinRegistries } from "../registries";
import { PluginManager, STATE_KEY, type PluginUi } from "./manager";
import { parseOp } from "./ops";
import type { Message } from "../ui/messages";

const ALERTS = "~/plugins/recent-alerts";
const SIZE = { cols: 80, rows: 24 };

function alerts(seen: string[] = []): FakePlugin {
  return {
    manifest: { name: "recent-alerts", version: "1.0.0", description: "Lines that look like trouble", author: "A. Author", api: 2, permissions: ["terminal.read"] },
    load(roster) {
      const show = () => roster.status.set("alerts", { text: `⚠ ${seen.length}` });
      roster.commands.add("alerts", { desc: "Show the alerts", run: () => roster.float.open({ title: "Alerts", lines: seen }) });
      roster.keymap.set("leader", "a a", "alerts");
      if (roster.plugin.permissions.includes("terminal.read")) {
        roster.on("terminal_output", (e) => {
          if (String(e.text).includes("ERROR")) seen.push(`${String(e.host)}: ${String(e.text).trim()}`);
          show();
        });
      }
      show();
    },
  };
}

function setup(
  plugins: Record<string, FakePlugin> = {},
  state: Record<string, unknown> = {},
  copy: PluginUi["copy"] = async () => undefined,
  now: () => number = Date.now,
) {
  const backend = fakeBackend({ hosts: makeHosts(3), plugins });
  const registries = builtinRegistries();
  const store = { get: (k: string) => state[k], set: (k: string, v: unknown) => void (state[k] = v) };
  const ran: string[] = [];
  const sent: [number, string][] = [];
  const ui: PluginUi = { run: (l) => void ran.push(l), send: (id, t) => void sent.push([id, t]), copy };
  const manager = new PluginManager(backend, registries, store, ui, now);
  return { manager, registries, state, ran, sent, backend };
}

describe("installing", () => {
  it("asks first, with each permission's risk; cancelling installs nothing", async () => {
    const { manager, registries, state } = setup({ [ALERTS]: alerts() });
    await manager.start();
    expect(await manager.install(ALERTS)).toBeNull();
    const [prompt] = manager.snapshot().prompts;
    expect(prompt?.kind).toBe("install");
    expect(prompt?.manifest.permissions[0]?.risk).toMatch(/password/);
    expect(registries.commands.get("alerts")).toBeUndefined();
    if (prompt) await manager.answer(prompt, false);
    expect(registries.commands.get("alerts")).toBeUndefined();
    expect(state[STATE_KEY]).toBeUndefined();
  });

  it("allowed, its commands, keys and status segment carry its name as their source", async () => {
    const { manager, registries, state } = setup({ [ALERTS]: alerts() });
    await manager.install(ALERTS);
    const prompt = manager.snapshot().prompts[0];
    if (prompt) await manager.answer(prompt, true);
    expect(registries.commands.get("alerts")?.source).toBe("recent-alerts");
    expect(registries.keymap.get("leader a a")).toMatchObject({ source: "recent-alerts", action: "plugins run recent-alerts alerts" });
    expect(registries.status.get("alerts")?.text).toBe("⚠ 0");
    expect(state[STATE_KEY]).toEqual([{ path: ALERTS, name: "recent-alerts", granted: ["terminal.read"], asked: ["terminal.read"] }]);
  });

  it("an update that asks for more waits for the user; declining runs it without the new permission", async () => {
    const plugin = alerts();
    plugin.manifest.permissions = ["terminal.read", "sessions.open"];
    const state = { [STATE_KEY]: [{ path: ALERTS, name: "recent-alerts", granted: ["terminal.read"], asked: ["terminal.read"] }] };
    const { manager, registries } = setup({ [ALERTS]: plugin }, state);
    await manager.start();
    const [prompt] = manager.snapshot().prompts;
    expect(prompt).toMatchObject({ kind: "update", asking: ["sessions.open"] });
    expect(registries.commands.get("alerts")).toBeUndefined();
    if (prompt) await manager.answer(prompt, false);
    expect(registries.commands.get("alerts")).toBeDefined();
    expect(manager.snapshot().plugins.find((p) => p.name === "recent-alerts")?.granted).toEqual(["terminal.read"]);
    // Asked once: the next start doesn't ask again.
    const again = setup({ [ALERTS]: plugin }, state);
    await again.manager.start();
    expect(again.manager.snapshot().prompts).toEqual([]);
  });
});

describe("running", () => {
  const installed = { [STATE_KEY]: [{ path: ALERTS, name: "recent-alerts", granted: ["terminal.read"], asked: ["terminal.read"] }] };

  // Ticket 96: Sessions opened while no Plugin ran still reach the core, so one installed later
  // lists them (roster.sessions.list).
  it("a Plugin installed after Sessions opened lists the ones still open", async () => {
    const lister: FakePlugin = {
      manifest: { name: "lister", version: "1.0.0", description: "Lists Sessions", author: "A. Author", api: 4, permissions: ["inventory.read"] },
      load(roster) {
        const open = roster.sessions.list?.() ?? [];
        roster.status.set("open", { text: open.map((s) => `${s.session}=${s.host ?? "quick"}`).join(" ") });
      },
    };
    const { manager, registries } = setup({ "/p/lister": lister });
    await manager.start();
    manager.sessions([{ session: 1, host: "esx-02" }, { session: 3, host: "web-1" }]);
    // The webview's next list replaces it whole: session 3 ended, 2 opened.
    manager.sessions([{ session: 1, host: "esx-02" }, { session: 2, host: null }]);
    expect(await manager.install("/p/lister")).toBeNull();
    const [prompt] = manager.snapshot().prompts;
    if (prompt) await manager.answer(prompt, true);
    expect(registries.status.get("open")?.text).toBe("1=esx-02 2=quick");
  });

  it("a Session event waits for the list sent before it, so a listener's list agrees", async () => {
    const counter: FakePlugin = {
      manifest: { name: "counter", version: "1.0.0", description: "Counts Sessions", author: "A. Author", api: 4, permissions: ["terminal.read"] },
      load(roster) {
        roster.on("session_open", () => roster.status.set("n", { text: `open ${roster.sessions.list?.().length ?? 0}` }));
      },
    };
    const installed = { [STATE_KEY]: [{ path: "/p/counter", name: "counter", granted: ["terminal.read"], asked: ["terminal.read"] }] };
    const { manager, registries, backend } = setup({ "/p/counter": counter }, installed);
    await manager.start();
    const slow = backend.pluginSessions.bind(backend);
    vi.spyOn(backend, "pluginSessions").mockImplementation(async (open) => {
      await new Promise((r) => setTimeout(r, 20));
      return slow(open);
    });
    manager.sessions([{ session: 4, host: "esx-02" }]);
    await manager.event("session_open", { session: 4, host: "esx-02" });
    expect(registries.status.get("n")?.text).toBe("open 1");
  });

  it("gets the Sessions' output as plain text, and only with terminal.read", async () => {
    const seen: string[] = [];
    const { manager, registries } = setup({ [ALERTS]: alerts(seen) }, { ...installed });
    await manager.start();
    manager.output(1, "esx-02", new TextEncoder().encode("\x1b[31mERROR\x1b[0m disk full\r\n"), SIZE);
    await manager.flushOutput();
    expect(seen).toEqual(["esx-02: ERROR disk full"]);
    expect(registries.status.get("alerts")?.text).toBe("⚠ 1");

    await manager.setGrant("recent-alerts", "terminal.read", false);
    expect(manager.readsTerminal()).toBe(false);
    manager.output(1, "esx-02", new TextEncoder().encode("ERROR again\r\n"), SIZE);
    await manager.flushOutput();
    expect(seen).toHaveLength(1);
  });

  // Ticket 73 (#126), then 79 (#137): after a resize ConPTY prints the whole screen again;
  // what reaches the Plugins is the terminal's committed lines, so the repaint isn't output.
  it("a Session's screen printed again after a resize isn't new output; what's new is", async () => {
    const seen: string[] = [];
    const { manager } = setup({ [ALERTS]: alerts(seen) }, { ...installed });
    await manager.start();
    const say = async (text: string, size = SIZE) => {
      manager.output(1, "esx-02", new TextEncoder().encode(text), size);
      await manager.flushOutput();
    };
    await say("mounting\r\nERROR: disk full\r\nesx-02$ ");
    expect(seen).toEqual(["esx-02: mounting\nERROR: disk full"]);
    await say("\x1b[?25l\x1b[Hmounting\x1b[K\r\nERROR: disk full   \x1b[K\r\nesx-02$ \x1b[K\x1b[3;9H\x1b[?25h", { cols: 60, rows: 20 });
    expect(seen).toHaveLength(1);
    await say("\r\nERROR: new one\r\n", { cols: 60, rows: 20 });
    expect(seen.at(-1)).toBe("esx-02: esx-02$\nERROR: new one");
  });

  // Ticket 94 (#167): a shell's OSC 133 marks say what each run of lines is (`kind`), and each
  // command that ends is a `command_done`, after the output it printed. Nothing is held back.
  function listening() {
    const heard: [string, Record<string, unknown>][] = [];
    const listener: FakePlugin = {
      manifest: { name: "listener", version: "1.0.0", description: "Hears commands", author: "A. Author", api: 4, permissions: ["terminal.read"] },
      load(roster) {
        roster.on("terminal_output", (e) => void heard.push(["terminal_output", e]));
        roster.on("command_done", (e) => void heard.push(["command_done", e]));
      },
    };
    const state = { [STATE_KEY]: [{ path: "~/plugins/listener", name: "listener", granted: ["terminal.read"], asked: ["terminal.read"] }] };
    return { heard, ...setup({ "~/plugins/listener": listener }, state) };
  }
  const say = (manager: PluginManager, t: string, session = 4) => manager.output(session, "esx-02", new TextEncoder().encode(t), SIZE);
  const cmd = (line: string, out: string, code: number) =>
    `\x1b]133;A\x07esx-02$ \x1b]133;B\x07${line}\r\n\x1b]133;C\x07${out}\x1b]133;D;${code}\x07`;

  it("a marked shell's lines come in runs of one kind, and its commands as command_done", async () => {
    const { heard, manager } = listening();
    await manager.start();
    say(manager, `booting\r\n${cmd("df -h", "disk full\r\n", 1)}`);
    await manager.flushOutput();
    expect(heard).toEqual([
      ["terminal_output", { session: 4, host: "esx-02", text: "booting\n", kind: null }],
      ["terminal_output", { session: 4, host: "esx-02", text: "esx-02$ df -h\n", kind: "input" }],
      ["terminal_output", { session: 4, host: "esx-02", text: "disk full\n", kind: "output" }],
      ["command_done", { session: 4, host: "esx-02", command: "df -h", output: "disk full\n", code: 1 }],
    ]);
  });

  // Review 2 of #215, finding 7: a Session's flushes never interleave.
  it("two flushes in a row keep a Session's events in order", async () => {
    const { heard, manager } = listening();
    await manager.start();
    say(manager, cmd("one", "1\r\n", 0));
    const first = manager.flushOutput();
    say(manager, cmd("two", "2\r\n", 0));
    await Promise.all([first, manager.flushOutput()]);
    expect(heard.filter(([n]) => n === "command_done").map(([, e]) => e.command)).toEqual(["one", "two"]);
    const text = heard.filter(([n]) => n === "terminal_output").map(([, e]) => String(e.text)).join("");
    expect(text).toBe("esx-02$ one\n1\nesx-02$ two\n2\n");
  });

  // Review 2, finding 8: a Session that ends sends what it had first.
  it("a Session that ends sends its last lines and command_done before session_exit", async () => {
    const { heard, manager } = listening();
    await manager.start();
    say(manager, cmd("exit 3", "", 3) + cmd("df -h", "disk full\r\n", 1));
    await manager.event("session_exit", { session: 4, host: "esx-02", code: 0 });
    expect(heard.map(([n]) => n)).toEqual(["terminal_output", "terminal_output", "command_done"]);
  });

  it("a function it handed over runs through `plugins call`, and its float shows", async () => {
    const { manager, registries } = setup({ [ALERTS]: alerts(["esx-02: ERROR"]) }, { ...installed });
    await manager.start();
    registries.commands.get("alerts")?.run({} as never, undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(manager.snapshot().float).toEqual({ plugin: "recent-alerts", title: "Alerts", lines: ["esx-02: ERROR"], actions: [], links: [] });
  });

  it("can't take a command, key or segment someone else has", async () => {
    const greedy: FakePlugin = {
      manifest: { name: "greedy", version: "1", description: "", author: null, api: 2, permissions: [] },
      load(roster) {
        roster.commands.add("connect", { run: () => null });
        roster.keymap.set("terminal", "Ctrl+c", "connect");
        roster.keymap.set("leader", "d", "connect");
        roster.status.set("hosts", { text: "0 Hosts" });
      },
    };
    const { manager, registries } = setup({ "/p/greedy": greedy }, { [STATE_KEY]: [{ path: "/p/greedy", name: "greedy", granted: [], asked: [] }] });
    await manager.start();
    expect(registries.commands.get("connect")?.source).toBe("builtin");
    expect(registries.status.get("hosts")?.source).toBe("hosts");
    const said = manager.snapshot().notices.map((n) => n.text).join("\n");
    expect(said).toMatch(/:connect is taken/);
    expect(said).toMatch(/keys go after the Leader or in the Sidebar/);
    expect(said).toMatch(/d \(leader\) would hide d d, bound by builtin/);
  });

  // Ticket 79: a taken Leader key says what's free instead, so the author can pick one at once.
  it("a taken Leader key is refused naming what has it, and what's free", async () => {
    const late: FakePlugin = {
      manifest: { name: "late", version: "1", description: "", author: null, api: 2, permissions: [] },
      load(roster) {
        roster.keymap.set("leader", "f", "late");
        roster.keymap.set("leader", "d d", "late");
      },
    };
    const { manager } = setup({ "/p/late": late }, { [STATE_KEY]: [{ path: "/p/late", name: "late", granted: [], asked: [] }] });
    await manager.start();
    const said = manager.snapshot().notices.map((n) => n.text);
    expect(said).toContain("late: ␣ f is taken (by builtin: find). Free after the Leader: g, h, j. Choose another (:keys lists them all)");
    expect(said).toContain("late: ␣ d d is taken (by builtin: close). Free after the Leader: d a, d b, d c. Choose another (:keys lists them all)");
  });

  it("a Plugin that fails to load is named in a toast, disabled, and leaves nothing behind", async () => {
    const broken: FakePlugin = {
      manifest: { name: "broken", version: "1", description: "", author: null, api: 2, permissions: [] },
      load(roster) {
        roster.status.set("half", { text: "half" });
        throw new Error("attempt to index a nil value");
      },
    };
    const { manager, registries } = setup({ "/p/broken": broken }, { [STATE_KEY]: [{ path: "/p/broken", name: "broken", granted: [], asked: [] }] });
    await manager.start();
    expect(manager.snapshot().notices.at(-1)?.text).toBe("broken: init.lua: attempt to index a nil value. It's disabled.");
    expect(manager.snapshot().plugins.find((p) => p.name === "broken")?.problem).toMatch(/failed to load/);
    expect(registries.status.get("half")).toBeUndefined();
  });

  it("removing it takes everything it added away", async () => {
    const { manager, registries, state } = setup({ [ALERTS]: alerts() }, { ...installed });
    await manager.start();
    expect(await manager.remove("recent-alerts")).toBeNull();
    expect(registries.commands.get("alerts")).toBeUndefined();
    expect(registries.keymap.get("leader a a")).toBeUndefined();
    expect(state[STATE_KEY]).toEqual([]);
    expect(await manager.remove("hosts")).toMatch(/built into roster/);
  });

  it("the Host count is the built-in hosts Plugin, and revoking its permission takes it away", async () => {
    const { manager, registries } = setup();
    await manager.start();
    expect(registries.status.get("hosts")).toMatchObject({ source: "hosts", text: "3 Hosts" });
    await manager.setGrant("hosts", "inventory.read", false);
    expect(registries.status.get("hosts")).toBeUndefined();
  });
});

describe("ops from a Plugin are checked", () => {
  it("drops what isn't the right kind, and cuts text to size", () => {
    expect(parseOp({ op: "status", id: "x", spec: { text: 3 } })).toEqual({ invalid: "roster.status.set x: text must be text" });
    expect(parseOp({ op: "section", id: "s", spec: { rows: [{ label: "a", actions: [{ label: "x", icon: "<img>", run: "x" }] }] } })).toMatchObject({
      invalid: expect.stringContaining("icon must be one of") as unknown,
    });
    expect(parseOp({ op: "html", id: "x" })).toEqual({ invalid: "there's no op html" });
    const long = parseOp({ op: "notify", text: "x".repeat(10_000), level: "info" });
    expect("text" in long ? long.text?.length : 0).toBe(500);
  });

});

describe(":check sections", () => {
  it("a Plugin adds one to the health registry, as checks it sets", async () => {
    const doctor: FakePlugin = {
      manifest: { name: "doctor", version: "1", description: "", author: null, api: 2, permissions: [] },
      load(roster) {
        roster.health.set("doctor", { title: "Doctor", checks: [{ level: "warn", message: "no alerts yet", fix: "open a Session" }] });
      },
    };
    const { manager, registries } = setup({ "/p/doctor": doctor }, { [STATE_KEY]: [{ path: "/p/doctor", name: "doctor", granted: [], asked: [] }] });
    await manager.start();
    const section = registries.health.get("doctor");
    expect(section?.source).toBe("doctor");
    expect(section?.checks({} as never)).toEqual([{ section: "doctor", level: "warn", message: "no alerts yet", fix: "open a Session" }]);
  });
});

describe("tutorials", () => {
  const coach: FakePlugin = {
    manifest: { name: "coach", version: "1", description: "", author: null, api: 2, permissions: [] },
    load(roster) {
      roster.tutor.set("coach", {
        title: "Coach",
        intro: "Learn the **coach** way.",
        lessons: [{ title: "Find one", text: "The Picker.", steps: [{ id: "find", text: "Open the Picker", on: { event: "command", id: "find" } }] }],
      });
    },
  };

  it("a Plugin adds one: its page is `tutor-NAME`, and its steps tick from app events", async () => {
    const { manager, registries } = setup({ "/p/coach": coach }, { [STATE_KEY]: [{ path: "/p/coach", name: "coach", granted: [], asked: [] }] });
    await manager.start();
    const def = registries.tutorials.get("coach");
    expect(def?.source).toBe("coach");
    expect(registries.help.get("tutor-coach")?.source).toBe("coach");
    const step = def?.lessons[0]?.steps[0];
    expect(step?.on).toEqual([{ event: "command", id: "find" }]);
    await manager.remove("coach");
    expect(registries.tutorials.get("coach")).toBeUndefined();
    expect(registries.help.get("tutor-coach")).toBeUndefined();
  });

  it("refuses steps that wait for an event the app doesn't send", () => {
    const op = { op: "tutor", id: "x", spec: { lessons: [{ title: "a", steps: [{ id: "s", text: "t", on: { event: "keypress" } }] }] } };
    expect(parseOp(op)).toMatchObject({ invalid: expect.stringContaining("event must be one of command, session_open") as unknown });
    expect(parseOp({ op: "tutor", id: "x", spec: { lessons: [] } })).toEqual({ invalid: "roster.tutor.set x: lessons must have at least one lesson" });
  });
});

/** A Plugin with `:cp TEXT`, which copies TEXT and then says so (as recent-alerts' Copy does). */
const copier: FakePlugin = {
  manifest: { name: "copier", version: "1.0.0", description: "Copies", author: null, api: 2, permissions: [] },
  load(roster) {
    roster.commands.add("cp", {
      run: (a: Record<string, unknown>) => {
        roster.clipboard.copy(String(a.args));
        roster.notify("Copied it");
      },
    });
  },
};
const COPIER = "~/plugins/copier";

async function installed(copy: PluginUi["copy"]) {
  const s = setup({ [COPIER]: copier }, {}, copy);
  await s.manager.install(COPIER);
  const prompt = s.manager.snapshot().prompts[0];
  if (prompt) await s.manager.answer(prompt, true);
  return s;
}

describe("the clipboard", () => {
  it("copied: the Plugin's own words are said", async () => {
    const copied: string[] = [];
    const { manager, registries } = await installed(async (t) => void copied.push(t));
    registries.commands.get("cp")?.run({} as never, "hello");
    await vi.waitFor(() => expect(manager.snapshot().notices.map((n) => n.text)).toEqual(["copier: Copied it"]));
    expect(copied).toEqual(["hello"]);
  });

  it("a copy that fails says so, and the Plugin's \"Copied\" isn't shown (it would be a lie)", async () => {
    const { manager, registries } = await installed(() => Promise.reject(new Error("the clipboard is busy")));
    registries.commands.get("cp")?.run({} as never, "hello");
    await vi.waitFor(() => expect(manager.snapshot().notices.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 0));
    expect(manager.snapshot().notices.map((n) => [n.level, n.text])).toEqual([["error", "copier: couldn't copy to the clipboard: the clipboard is busy"]]);
  });

  it("a copy op is the core's to allow: the manager applies it as the reply has it", async () => {
    const copied: string[] = [];
    const { manager, backend } = await installed(async (t) => void copied.push(t));
    // The core makes a copy op only in a call the user started (crates/roster-core/tests/plugin.rs);
    // the manager doesn't check it again.
    vi.spyOn(backend, "pluginEvent").mockResolvedValue([{ plugin: "copier", result: null, ops: [{ op: "copy", text: "from the core" }], error: null, disabled: null }]);
    await manager.event("lock");
    expect(copied).toEqual(["from the core"]);
  });
});

describe("replies nobody asked for (an HTTP request's answer, decision Q97)", () => {
  const reply = (text: string) => ({
    plugin: "recent-alerts",
    result: null,
    ops: [{ op: "status", id: "alerts", spec: { text } }],
    error: null,
    disabled: null,
  });

  it("are applied like a call's while the Plugin runs, and dropped once it's gone", async () => {
    const { manager, registries, backend } = setup({ [ALERTS]: alerts() });
    backend.onPluginReply((r) => manager.replied(r));
    await manager.install(ALERTS);
    const prompt = manager.snapshot().prompts[0];
    if (prompt) await manager.answer(prompt, true);
    backend.pluginReplied(reply("⚠ 9"));
    expect(registries.status.get("alerts")?.text).toBe("⚠ 9");
    expect(manager.snapshot().plugins[0]?.uses.at(-1)?.what).toBe("got an answer to a request");
    await manager.remove("recent-alerts");
    backend.pluginReplied(reply("⚠ 10"));
    expect(registries.status.get("alerts")).toBeUndefined();
  });

  it("an update that asks for a new site asks first, with the site flagged", async () => {
    const plugin = alerts();
    plugin.manifest.permissions = ["terminal.read", "network:hooks.example.com", "network:*.chat.example"];
    const state = {
      [STATE_KEY]: [{ path: ALERTS, name: "recent-alerts", granted: ["terminal.read", "network:hooks.example.com"], asked: ["terminal.read", "network:hooks.example.com"] }],
    };
    const { manager } = setup({ [ALERTS]: plugin }, state);
    await manager.start();
    const [prompt] = manager.snapshot().prompts;
    expect(prompt).toMatchObject({ kind: "update", asking: ["network:*.chat.example"] });
    expect(prompt?.manifest.permissions[2]?.risk).toMatch(/^Can send data to any site under chat\.example/);
  });
});

describe("requests by site (decision Q116)", () => {
  it("come from the core when :plugins asks, for each Plugin, and nothing more", async () => {
    const plugin = alerts();
    plugin.manifest.permissions = ["terminal.read", "network:hooks.example.com"];
    const backend = fakeBackend({
      hosts: makeHosts(3),
      plugins: { [ALERTS]: plugin },
      pluginRequests: { "recent-alerts": [{ site: "hooks.example.com", requests: 12, failed: 1, last: 1_000 }] },
    });
    const store = { get: () => [{ path: ALERTS, name: "recent-alerts", granted: ["terminal.read", "network:hooks.example.com"], asked: ["terminal.read", "network:hooks.example.com"] }], set: () => undefined };
    const manager = new PluginManager(backend, builtinRegistries(), store, { run: () => undefined, send: () => undefined, copy: async () => undefined });
    await manager.start();
    expect(manager.snapshot().plugins.find((p) => p.name === "recent-alerts")?.requests).toEqual([]);
    await manager.refreshRequests();
    expect(manager.snapshot().plugins.find((p) => p.name === "recent-alerts")?.requests).toEqual([{ site: "hooks.example.com", requests: 12, failed: 1, last: 1_000 }]);
    // The same counts again change nothing: :plugins asks every few seconds while it's open.
    const heard = vi.fn();
    manager.subscribe(heard);
    await manager.refreshRequests();
    expect(heard).not.toHaveBeenCalled();
  });
});

describe("data-folder sizes (ticket 98)", () => {
  const keeper: FakePlugin = {
    manifest: { name: "keeper", version: "1", description: "", author: null, api: 3, permissions: [] },
    load(roster) {
      roster.storage.write("notes.txt", "hello");
      roster.storage.write("state.json", "é");
    },
  };

  it("come from the core when :plugins opens: files and bytes as the caps count them, none for a Plugin that wrote nothing", async () => {
    const { manager } = setup({ "~/plugins/keeper": keeper, [ALERTS]: alerts() }, {
      [STATE_KEY]: [
        { path: "~/plugins/keeper", name: "keeper", granted: [], asked: [] },
        { path: ALERTS, name: "recent-alerts", granted: [], asked: [] },
      ],
    });
    await manager.start();
    const data = (name: string) => manager.snapshot().plugins.find((p) => p.name === name)?.data;
    expect(data("keeper")).toBeNull();
    await manager.refreshData();
    // "é" is two bytes on disk.
    expect(data("keeper")).toEqual({ state: "used", files: 2, bytes: 7 });
    expect(data("recent-alerts")).toEqual({ state: "none" });
    // Asked again with nothing changed: nothing redraws.
    const heard = vi.fn();
    manager.subscribe(heard);
    await manager.refreshData();
    expect(heard).not.toHaveBeenCalled();
  });
});

// Ticket 79 (#137): timers and finders whose items come from a function.
describe("timers", () => {
  const ticker = (log: string[]): FakePlugin => ({
    manifest: { name: "ticker", version: "1", description: "", author: null, api: 2, permissions: [] },
    load(roster) {
      let n = 0;
      roster.defer(500, () => {
        log.push("once");
        roster.status.set("once", { text: "ran" });
      });
      const t = roster.every(1000, () => {
        n += 1;
        log.push(`tick ${n}`);
        roster.status.set("ticks", { text: String(n) });
        if (n === 3) roster.cancel(t);
      });
    },
  });
  const installed = { [STATE_KEY]: [{ path: "/p/ticker", name: "ticker", granted: [], asked: [] }] };

  it("stop (the demo's manager when the tutorial ends): no timer fires, no event or call reaches the core, its UI goes", async () => {
    vi.useFakeTimers();
    try {
      const log: string[] = [];
      const { manager, registries, backend } = setup({ "/p/ticker": ticker(log) }, { ...installed });
      await manager.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(log).toEqual(["once", "tick 1"]);
      const calls = vi.spyOn(backend, "pluginCall");
      const events = vi.spyOn(backend, "pluginEvent");
      manager.stop();
      expect(registries.status.get("ticks")).toBeUndefined();
      await vi.advanceTimersByTimeAsync(10_000);
      await manager.event("inventory_changed");
      expect(log).toEqual(["once", "tick 1"]);
      expect(calls).not.toHaveBeenCalled();
      expect(events).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("run in the Plugin when it's time: once, or again until cancelled", async () => {
    vi.useFakeTimers();
    try {
      const log: string[] = [];
      const { manager, registries } = setup({ "/p/ticker": ticker(log) }, { ...installed });
      await manager.start();
      expect(log).toEqual([]);
      await vi.advanceTimersByTimeAsync(500);
      expect(log).toEqual(["once"]);
      expect(registries.status.get("once")?.text).toBe("ran");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(log).toEqual(["once", "tick 1", "tick 2", "tick 3"]);
      expect(registries.status.get("ticks")?.text).toBe("3");
      // Timers aren't something the user did: :plugins' recent use doesn't fill up with them.
      expect(manager.snapshot().plugins.find((p) => p.name === "ticker")?.uses).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("end with the Plugin: removing or reloading it cancels them", async () => {
    vi.useFakeTimers();
    try {
      const log: string[] = [];
      const { manager } = setup({ "/p/ticker": ticker(log) }, { ...installed });
      await manager.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(log).toEqual(["once", "tick 1"]);
      await manager.reload("ticker");
      await vi.advanceTimersByTimeAsync(1000);
      // Only the new load's timers: its own "once" and "tick 1".
      expect(log).toEqual(["once", "tick 1", "once", "tick 1"]);
      await manager.remove("ticker");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(log).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a finder whose items come from a function", () => {
  it("asks the Plugin each time it opens, and says it's loading until then", async () => {
    let n = 0;
    const lazy: FakePlugin = {
      manifest: { name: "lazy", version: "1", description: "", author: null, api: 2, permissions: [] },
      load(roster) {
        roster.finders.set("lazy", {
          title: "Lazy",
          items: () => {
            n += 1;
            return [{ label: `item ${n}`, run: () => roster.notify(`chose ${n}`) }];
          },
        });
      },
    };
    const { manager, registries } = setup({ "/p/lazy": lazy }, { [STATE_KEY]: [{ path: "/p/lazy", name: "lazy", granted: [], asked: [] }] });
    await manager.start();
    const source = () => registries.finders.get("lazy");
    expect(source()?.items({} as never)).toEqual([]);
    expect(source()?.empty).toBe("Loading…");
    expect(n).toBe(0);
    source()?.open?.();
    await vi.waitFor(() => expect(source()?.items({} as never).map((i) => i.label)).toEqual(["item 1"]));
    expect(source()?.empty).toBeUndefined();
    expect(source()?.items({} as never)[0]?.command).toMatch(/^plugins call lazy \d+ \S+$/);
    source()?.open?.();
    await vi.waitFor(() => expect(source()?.items({} as never).map((i) => i.label)).toEqual(["item 2"]));
  });
});

describe("a finder's prompt", () => {
  it("is its own prompt when it gives one, else its title, with no › of its own (the Finder adds it)", async () => {
    const finders: FakePlugin = {
      manifest: { name: "finders", version: "1", description: "", author: null, api: 3, permissions: [] },
      load(roster) {
        roster.sidebar.set("mine", { title: "Mine", rows: [{ id: "a", label: "a" }] });
        roster.finders.set("mine", { title: "Find in Mine", prompt: "Mine", section: "mine" });
        roster.finders.set("plain", { title: "Plain", items: [{ label: "x", run: "plain" }] });
      },
    };
    const { manager, registries } = setup({ "/p/finders": finders }, { [STATE_KEY]: [{ path: "/p/finders", name: "finders", granted: [], asked: [] }] });
    await manager.start();
    expect(registries.finders.get("mine")).toMatchObject({ title: "Find in Mine", prompt: "Mine" });
    expect(registries.finders.get("plain")).toMatchObject({ title: "Plain", prompt: "Plain" });
  });
});

describe("roster's own commands, to the core (issue #184)", () => {
  it("are sent when the Plugins start and again when one registers later, never taken back", async () => {
    const { manager, registries, backend } = setup();
    const sent = vi.spyOn(backend, "pluginBuiltins");
    await manager.start();
    const first = sent.mock.calls.at(-1)?.[0] ?? [];
    expect(first).toContain("publish");
    expect(first).toContain("lock");
    expect(first).not.toContain("late");
    // A built-in that registers later (App's `:tutor`, `:panel`, …) reaches the core too.
    const remove = registries.commands.register({ id: "late", source: "builtin", area: "Other", label: () => "Late", run: () => undefined });
    await vi.waitFor(() => expect(sent.mock.calls.at(-1)?.[0]).toContain("late"));
    // Taken out again (an effect re-running), the core keeps refusing it.
    const calls = sent.mock.calls.length;
    remove();
    registries.commands.register({ id: "probe-own", source: "probe", area: "Other", label: () => "", run: () => undefined });
    expect(sent.mock.calls.length).toBe(calls);
  });

  it("a send that fails is said once, quietly, retried, and sent whole again before a Plugin loads", async () => {
    vi.useFakeTimers();
    try {
      const said: Message[] = [];
      const backend = fakeBackend({ hosts: makeHosts(3), plugins: { [ALERTS]: alerts() } });
      const state: Record<string, unknown> = { [STATE_KEY]: [{ path: ALERTS, name: "recent-alerts", granted: [], asked: ["terminal.read"] }] };
      const store = { get: (k: string) => state[k], set: (k: string, v: unknown) => void (state[k] = v) };
      const ui: PluginUi = { run: () => undefined, send: () => undefined, copy: async () => undefined, say: (m) => void said.push(m) };
      const manager = new PluginManager(backend, builtinRegistries(), store, ui);
      const real = backend.pluginBuiltins.bind(backend);
      let down = true;
      const sent = vi.spyOn(backend, "pluginBuiltins").mockImplementation((names) => (down ? Promise.reject(new Error("no such command")) : real(names)));
      const loads = vi.spyOn(backend, "pluginLoad");
      await manager.start();
      // Every load tried the whole list again first; none got through.
      expect(sent.mock.calls.length).toBeGreaterThan(loads.mock.calls.length);
      for (const [i, load] of loads.mock.invocationCallOrder.entries()) {
        expect(sent.mock.invocationCallOrder.some((c) => c < load && (i === 0 || c > (loads.mock.invocationCallOrder[i - 1] ?? 0)))).toBe(true);
      }
      expect(sent.mock.calls.every(([names]) => names.includes("publish") && names.includes("lock"))).toBe(true);
      // Said once, quietly, and without the ids.
      expect(said).toHaveLength(1);
      expect(said[0]).toMatchObject({ kind: "quiet" });
      expect(JSON.stringify(said[0])).not.toContain("publish");
      // Retried on its own, and once it's through, not again.
      down = false;
      const before = sent.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sent.mock.calls.length).toBe(before + 1);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(sent.mock.calls.length).toBe(before + 1);
      await manager.reload("recent-alerts");
      expect(sent.mock.calls.length).toBe(before + 1);
      manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
