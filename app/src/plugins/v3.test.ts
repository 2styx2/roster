// The Plugin API's version 3 in the app (tickets 74 and 60): handlers hear which row, button,
// finder item or segment ran them and the Session on screen (with the permission to know it),
// a Plugin takes its key bindings and Themes away, and a `:check` section can be a function the
// app calls on each run, within a time limit.
import { describe, expect, it, vi } from "vitest";
import { fakeBackend, makeHosts } from "../backend/fake";
import type { FakePlugin } from "../backend/fakePlugins";
import { builtinRegistries } from "../registries";
import type { CommandContext } from "../commands/table";
import { pluginsCommand } from "./command";
import { PluginManager, STATE_KEY, type PluginUi } from "./manager";

const heard: Record<string, unknown>[] = [];

function plugin(permissions: string[] = []): FakePlugin {
  return {
    manifest: { name: "ctx", version: "1", description: "", author: null, api: 3, permissions },
    load(roster) {
      const note = (c: Record<string, unknown>) => void heard.push(c);
      roster.sidebar.set("pins", { rows: [{ id: "esx  02 {x}", label: "esx-02", run: note, actions: [{ label: "A", run: note }, { label: "B", run: note }] }] });
      roster.finders.set("pins", { items: [{ label: "first", run: note }, { id: "two", label: "second", run: note }] });
      roster.status.set("count", { text: "2", run: note });
      roster.commands.add("ctx", { run: note });
    },
  };
}

function setup(p: FakePlugin, onScreen: PluginUi["onScreen"] = () => ({ session: 7, host: "esx-02" })) {
  const backend = fakeBackend({ hosts: makeHosts(3), plugins: { "/p/ctx": p } });
  const registries = builtinRegistries();
  const state: Record<string, unknown> = { [STATE_KEY]: [{ path: "/p/ctx", name: p.manifest.name, granted: p.manifest.permissions, asked: p.manifest.permissions }] };
  const store = { get: (k: string) => state[k], set: (k: string, v: unknown) => void (state[k] = v) };
  const ui: PluginUi = { run: () => undefined, send: () => undefined, copy: async () => undefined, onScreen };
  const manager = new PluginManager(backend, registries, store, ui);
  backend.onPluginReply((r) => manager.replied(r));
  const command = pluginsCommand(manager, () => undefined);
  /** Runs a command line a Plugin's row, item or segment holds, as the app does. */
  const run = async (line: string | undefined) => {
    expect(line).toMatch(/^plugins call /);
    // As the command line hands it over: split at spaces, joined again with one.
    command.run({ say: () => undefined } as unknown as CommandContext, line!.split(/\s+/).slice(1).join(" "));
    await new Promise((r) => setTimeout(r, 0));
    return heard.pop();
  };
  return { manager, registries, run };
}

describe("a handler's context", () => {
  it("says which row, button, finder item or segment ran it, and the Session on screen", async () => {
    const { manager, registries, run } = setup(plugin(["inventory.read"]));
    await manager.start();
    const row = registries.sidebar.get("pins")!.build({} as never)!.rows[0]!;
    expect(await run(row.command)).toEqual({ section: "pins", row: "esx  02 {x}", session: 7, session_host: "esx-02" });
    expect(await run(row.actions![1]!.command)).toEqual({ section: "pins", row: "esx  02 {x}", action: 2, session: 7, session_host: "esx-02" });
    const items = registries.finders.get("pins")!.items({} as never);
    expect(await run(items[0]!.command)).toEqual({ finder: "pins", item: "1", session: 7, session_host: "esx-02" });
    expect(await run(items[1]!.command)).toEqual({ finder: "pins", item: "two", session: 7, session_host: "esx-02" });
    expect(await run(registries.status.get("count")!.command)).toEqual({ segment: "count", session: 7, session_host: "esx-02" });
  });

  it("leaves the Session out without inventory.read or terminal.read, and with none on screen", async () => {
    const { manager, registries, run } = setup(plugin([]));
    await manager.start();
    expect(await run(registries.status.get("count")!.command)).toEqual({ segment: "count" });
    const none = setup(plugin(["terminal.read"]), () => null);
    await none.manager.start();
    expect(await none.run(none.registries.status.get("count")!.command)).toEqual({ segment: "count" });
  });

  it("a command's function gets the Session too", async () => {
    const { manager, registries } = setup(plugin(["terminal.read"]), () => ({ session: 3, host: null }));
    await manager.start();
    registries.commands.get("ctx")!.run({} as CommandContext, "a b");
    await new Promise((r) => setTimeout(r, 0));
    expect(heard.pop()).toEqual({ args: "a b", words: ["a", "b"], session: 3, session_host: null });
  });
});

describe("taking things away", () => {
  it("keymap.del and themes.remove take the Plugin's binding and Theme off", async () => {
    let step = 0;
    const p: FakePlugin = {
      manifest: { name: "keys", version: "1", description: "", author: null, api: 3, permissions: [] },
      load(roster) {
        roster.keymap.set("leader", "w w", "finder pins");
        roster.keymap.set("leader", "w x", "finder pins");
        roster.themes.define("dusk", { base: "roster-dark" });
        roster.commands.add("drop", {
          run: () => {
            step++;
            roster.keymap.del("leader", "w w");
            roster.keymap.set("leader", "w x", false);
            roster.themes.remove("dusk");
          },
        });
      },
    };
    const { manager, registries } = setup(p);
    await manager.start();
    expect(registries.keymap.get("leader w w")?.source).toBe("keys");
    expect(registries.themes.get("dusk")?.source).toBe("keys");
    registries.commands.get("drop")!.run({} as CommandContext, "");
    await new Promise((r) => setTimeout(r, 0));
    expect(step).toBe(1);
    expect(registries.keymap.get("leader w w")).toBeUndefined();
    expect(registries.keymap.get("leader w x")).toBeUndefined();
    expect(registries.themes.get("dusk")).toBeUndefined();
  });
});

describe("a :check section that's a function", () => {
  const doctor = (check: (c: Record<string, unknown>) => unknown): FakePlugin => ({
    manifest: { name: "doctor", version: "1", description: "", author: null, api: 3, permissions: [] },
    load(roster) {
      roster.health.set("doctor", { title: "Doctor", check });
    },
  });

  it("is called on each run, with its id, and its lines are the section's", async () => {
    let runs = 0;
    const { manager, registries } = setup(
      doctor((c) => {
        runs++;
        return [
          { level: "ok", message: `run ${runs} of ${String(c.health)}` },
          { level: "error", message: "no alerts", fix: "open a Session" },
        ];
      }),
    );
    await manager.start();
    const section = registries.health.get("doctor")!;
    expect(section.source).toBe("doctor");
    expect(await section.checks({} as never)).toEqual([
      { section: "doctor", level: "ok", message: "run 1 of doctor" },
      { section: "doctor", level: "error", message: "no alerts", fix: "open a Session" },
    ]);
    await section.checks({} as never);
    expect(runs).toBe(2);
  });

  it("one that fails, or returns lines the app can't use, is an ERROR line of its own", async () => {
    const failing = setup(doctor(() => { throw new Error("boom"); }));
    await failing.manager.start();
    const [line] = await failing.registries.health.get("doctor")!.checks({} as never);
    expect(line).toMatchObject({ section: "doctor", level: "error" });
    expect(line!.message).toMatch(/boom/);
    const bad = setup(doctor(() => [{ level: "loud", message: "x" }]));
    await bad.manager.start();
    const [badLine] = await bad.registries.health.get("doctor")!.checks({} as never);
    expect(badLine).toMatchObject({ section: "doctor", level: "error" });
    expect(badLine!.message).toMatch(/level must be "ok", "warn" or "error"/);
  });
});

describe("a :check section that answers later (decision Q112h)", () => {
  const later = (answer: (roster: Parameters<FakePlugin["load"]>[0], c: Record<string, unknown>) => void): FakePlugin => ({
    manifest: { name: "doctor", version: "1", description: "", author: null, api: 3, permissions: ["serve:hosts.list"] },
    load(roster) {
      roster.health.set("doctor", {
        title: "Doctor",
        check: (c: Record<string, unknown>) => {
          answer(roster, c);
          return "later";
        },
      });
    },
  });

  it("returns \"later\" and answers from a request's answer, so it never waits for serve", async () => {
    const { manager, registries } = setup(
      later((roster, c) =>
        roster.serve?.request("hosts.list", {}, () => {
          roster.health.answer(c.check as number, [{ level: "ok", message: "roster serve answered" }]);
        }),
      ),
    );
    await manager.start();
    expect(await registries.health.get("doctor")!.checks({} as never)).toEqual([{ section: "doctor", level: "ok", message: "roster serve answered" }]);
  });

  it("one that never answers is an ERROR line after 30 seconds; a late answer is dropped", async () => {
    vi.useFakeTimers();
    try {
      let check = 0;
      const { manager, registries } = setup(later((_, c) => void (check = c.check as number)));
      await manager.start();
      const lines = registries.health.get("doctor")!.checks({} as never);
      await vi.advanceTimersByTimeAsync(30_000);
      const [line] = await lines;
      expect(line).toMatchObject({ section: "doctor", level: "error" });
      expect(line!.message).toMatch(/didn't within 30 seconds/);
      expect(check).toBeGreaterThan(0);
      expect(registries.health.get("doctor")!.wait).toBe(33_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe(":plugins types", () => {
  it("writes the stubs into a Plugin's folder and says where", async () => {
    const { manager } = setup(plugin());
    const said: string[] = [];
    const command = pluginsCommand(manager, () => undefined);
    command.run({ say: (m: string) => void said.push(m) } as unknown as CommandContext, "types ~/plugins/pinned");
    await new Promise((r) => setTimeout(r, 0));
    expect(said).toEqual(["Wrote ~/plugins/pinned/types/roster.lua: the Plugin API 4's types, for lua-language-server"]);
    command.run({ say: (m: string) => void said.push(m) } as unknown as CommandContext, "types");
    expect(said.at(-1)).toBe("Which Plugin folder? :plugins types PATH writes its types/roster.lua");
  });
});

// Ticket 78's handlers hear what ran them too: a section's and a float's buttons, a question's
// answer, a progress's cancel and a toolbar control. `plugins call NAME N CONTEXT` and
// `plugins run NAME LINE` both still parse.
describe("ticket 78's handlers", () => {
  const asker: FakePlugin = {
    manifest: { name: "asker", version: "1", description: "", author: null, api: 3, permissions: ["terminal.read"] },
    load(roster) {
      const note = (c: Record<string, unknown>) => void heard.push(c);
      roster.commands.add("asker", { run: () => roster.confirm({ title: "Sure?", run: note, cancel: note }) });
      roster.sidebar.set("head", { rows: [], actions: [{ label: "Add", icon: "add", run: note }] });
      roster.toolbar.set("bell", { label: "Bell", run: note });
      roster.progress.set("sync", { title: "Syncing", cancel: note });
      roster.commands.add("float", { run: () => roster.float.open({ title: "F", lines: ["a"], actions: [{ label: "One", run: note }, { label: "Two", run: note }] }) });
    },
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("each gets its context, and the Session on screen", async () => {
    const { manager, registries, run } = setup(asker);
    await manager.start();
    const head = registries.sidebar.get("head")!.build({} as never)!;
    expect(await run(head.actions![0]!.command)).toEqual({ section: "head", action: 1, session: 7, session_host: "esx-02" });
    expect(await run(registries.toolbar.get("bell")!.command)).toEqual({ toolbar: "bell", session: 7, session_host: "esx-02" });
    manager.cancelProgress("sync");
    await tick();
    expect(heard.pop()).toEqual({ progress: "sync", session: 7, session_host: "esx-02" });
    registries.commands.get("asker")!.run({} as CommandContext, "");
    await tick();
    manager.answerConfirm(true);
    await tick();
    expect(heard.pop()).toEqual({ confirm: "yes", session: 7, session_host: "esx-02" });
    registries.commands.get("asker")!.run({} as CommandContext, "");
    await tick();
    manager.answerConfirm(false);
    await tick();
    expect(heard.pop()).toEqual({ confirm: "no", session: 7, session_host: "esx-02" });
    registries.commands.get("float")!.run({} as CommandContext, "");
    await tick();
    manager.floatAction(1);
    await tick();
    expect(heard.pop()).toEqual({ action: 2, session: 7, session_host: "esx-02" });
  });

  it("`plugins run NAME LINE` still runs a line the Plugin may run, and `plugins call` with no context still calls", async () => {
    const ran: string[] = [];
    const backend = fakeBackend({ hosts: makeHosts(3), plugins: { "/p/ctx": asker } });
    const registries = builtinRegistries();
    const state: Record<string, unknown> = { [STATE_KEY]: [{ path: "/p/ctx", name: "asker", granted: ["terminal.read"], asked: ["terminal.read"] }] };
    const store = { get: (k: string) => state[k], set: (k: string, v: unknown) => void (state[k] = v) };
    const manager = new PluginManager(backend, registries, store, { run: (l) => void ran.push(l), send: () => undefined, copy: async () => undefined });
    await manager.start();
    const command = pluginsCommand(manager, () => undefined);
    command.run({ say: () => undefined } as unknown as CommandContext, "run asker finder hosts");
    expect(ran).toEqual(["finder hosts"]);
    const line = registries.toolbar.get("bell")!.command!;
    const [, , name, n] = line.split(" ");
    command.run({ say: () => undefined } as unknown as CommandContext, `call ${name} ${n}`);
    await tick();
    expect(heard.pop()).toEqual({});
  });
});

// Ticket 88 (decision Q98): a Plugin's key binding is a command line it hands over, like a button's,
// so it goes through `plugins run` and the same check. It can't run `:plugins grant`, `:packages`,
// `:source` or another Plugin's command by a key, only its own commands and the core's list.
describe("a Plugin's key bindings", () => {
  const keys: FakePlugin = {
    manifest: { name: "keys", version: "1", description: "", author: null, api: 3, permissions: [] },
    load(roster) {
      roster.commands.add("mine", { run: () => undefined });
      roster.keymap.set("leader", "k g", "plugins grant keys terminal.write");
      roster.keymap.set("leader", "k p", "packages clean");
      roster.keymap.set("leader", "k s", "source");
      roster.keymap.set("leader", "k o", "scan");
      roster.keymap.set("leader", "k m", "mine now");
      roster.keymap.set("leader", "k f", "finder hosts");
    },
  };
  const other: FakePlugin = {
    manifest: { name: "other", version: "1", description: "", author: null, api: 3, permissions: [] },
    load(roster) {
      roster.commands.add("scan", { run: () => undefined });
    },
  };

  it("run only what a button may: never :plugins, :packages, :source or another Plugin's command", async () => {
    const backend = fakeBackend({ hosts: makeHosts(3), plugins: { "/p/keys": keys, "/p/other": other } });
    const registries = builtinRegistries();
    const state: Record<string, unknown> = {
      [STATE_KEY]: [
        { path: "/p/keys", name: "keys", granted: [], asked: [] },
        { path: "/p/other", name: "other", granted: [], asked: [] },
      ],
    };
    const store = { get: (k: string) => state[k], set: (k: string, v: unknown) => void (state[k] = v) };
    // Every line that reaches the command table, as the app runs it.
    const ran: string[] = [];
    const said: string[] = [];
    const ctx = { say: (m: string) => void said.push(m) } as unknown as CommandContext;
    const dispatch = (line: string) => {
      ran.push(line);
      const [word = "", ...rest] = line.split(" ");
      if (word === "plugins") command.run(ctx, rest.join(" "));
    };
    const manager = new PluginManager(backend, registries, store, { run: dispatch, send: () => undefined, copy: async () => undefined });
    const command = pluginsCommand(manager, () => undefined);
    await manager.start();
    const press = (k: string) => dispatch(registries.keymap.get(`leader ${k}`)!.action!);
    for (const k of ["k g", "k p", "k s", "k o", "k m", "k f"]) press(k);
    await new Promise((r) => setTimeout(r, 0));
    expect(ran.filter((l) => !l.startsWith("plugins run "))).toEqual(["mine now", "finder hosts"]);
    expect(manager.snapshot().plugins.find((p) => p.name === "keys")?.granted).toEqual([]);
  });
});
