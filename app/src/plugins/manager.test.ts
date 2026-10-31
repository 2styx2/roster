// The Plugin manager (ticket 23) over the fake Backend's Plugin host: installing asks first,
// ops become registry entries with the Plugin's name as their source, revoking takes a permission
// away at once, and only Sessions' output (never what's typed) reaches terminal.read.
import { describe, expect, it, vi } from "vitest";
import { fakeBackend, makeHosts } from "../backend/fake";
import type { FakePlugin } from "../backend/fakePlugins";
import { builtinRegistries } from "../registries";
import { PluginManager, plainText, STATE_KEY, type PluginUi } from "./manager";
import { parseOp } from "./ops";

const ALERTS = "~/plugins/recent-alerts";

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
    expect(registries.keymap.get("leader a a")).toMatchObject({ source: "recent-alerts", action: "alerts" });
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

  it("gets the Sessions' output as plain text, and only with terminal.read", async () => {
    const seen: string[] = [];
    const { manager, registries } = setup({ [ALERTS]: alerts(seen) }, { ...installed });
    await manager.start();
    manager.output(1, "esx-02", new TextEncoder().encode("\x1b[31mERROR\x1b[0m disk full\r\n"));
    manager.flushOutput();
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(["esx-02: ERROR disk full"]);
    expect(registries.status.get("alerts")?.text).toBe("⚠ 1");

    await manager.setGrant("recent-alerts", "terminal.read", false);
    expect(manager.readsTerminal()).toBe(false);
    manager.output(1, "esx-02", new TextEncoder().encode("ERROR again\n"));
    manager.flushOutput();
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(1);
  });

  // Ticket 73 (#126): after a resize, ConPTY (every Windows Session) prints the whole screen again,
  // and a full-screen program redraws; recent-alerts took each repaint for new lines, so opening
  // a float beside the terminal (which narrows it) added a copy of every alert on screen.
  it("a Session's screen printed again after a resize isn't new output; what's new is", async () => {
    const seen: string[] = [];
    let t = 1_000;
    const { manager } = setup({ [ALERTS]: alerts(seen) }, { ...installed }, undefined, () => t);
    await manager.start();
    const say = async (text: string) => {
      manager.output(1, "esx-02", new TextEncoder().encode(text));
      manager.flushOutput();
      await new Promise((r) => setTimeout(r, 0));
    };
    await say("mounting\r\nERROR: disk full\r\nesx-02$ ");
    expect(seen).toEqual(["esx-02: mounting\nERROR: disk full\nesx-02$"]);
    manager.resized(1);
    t += 50;
    // ConPTY's repaint: home, each row cleared to its end, the cursor back where it was.
    await say("\x1b[?25l\x1b[H(fake, 100x30)\x1b[K\r\nmounting\x1b[K\r\nERROR: disk full   \x1b[K\r\nesx-02$ \x1b[K\x1b[3;9H\x1b[?25h");
    expect(seen).toHaveLength(1);
    // A new line in the same moment still goes through; the window closes after a second.
    t += 100;
    await say("\r\nERROR: new one\r\n");
    expect(seen.at(-1)).toMatch(/ERROR: new one/);
    t += 2_000;
    await say("ERROR: disk full\r\n");
    expect(seen).toHaveLength(3);
  });

  it("a function it handed over runs through `plugins call`, and its float shows", async () => {
    const { manager, registries } = setup({ [ALERTS]: alerts(["esx-02: ERROR"]) }, { ...installed });
    await manager.start();
    registries.commands.get("alerts")?.run({} as never, undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(manager.snapshot().float).toEqual({ plugin: "recent-alerts", title: "Alerts", lines: ["esx-02: ERROR"] });
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

  it("strips escape sequences from terminal output", () => {
    expect(plainText("\x1b]0;title\x07\x1b[1;31mERROR\x1b[0m\r\n")).toBe("ERROR\n");
  });

  it("a cursor move to a row is a line break, so rows drawn by position don't run together", () => {
    expect(plainText("\x1b[Hone\x1b[2;1Htwo\x1b[K")).toBe("\none\ntwo");
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
