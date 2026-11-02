// What Folders needed from the Plugin API (ticket 61, api 3), through the manager over the fake
// Backend's Plugin host, with the built-in Folders Plugin: rows drawn as the Inventory's Hosts,
// folding, drag and drop, the Sidebar's cursor in a command's context, completion that answers a
// moment later, roster.echo and roster.cmdline, settings for a built-in Plugin, and a removed
// Plugin's data folder going with it.
import { describe, expect, it, vi } from "vitest";
import { fakeBackend, makeHosts } from "../backend/fake";
import type { FakePlugin } from "../backend/fakePlugins";
import type { CommandContext } from "../commands/table";
import { builtinRegistries } from "../registries";
import type { SidebarContext } from "../sidebar/sections";
import { quiet, type Message } from "../ui/messages";
import { BUILTINS_HELD_MAX, BUILTINS_WAIT_MS, PluginManager, STATE_KEY, type PluginUi } from "./manager";

const hosts = makeHosts(3);
const [h1, h2] = hosts.hosts.map((h) => h.name) as [string, string];
const hostByName = new Map(hosts.hosts.map((h) => [h.name, h]));

function setup(settings: Record<string, unknown> | null = {}, plugins: Record<string, FakePlugin> = {}, state: Record<string, unknown> = {}, dispatch = false, onScreen?: PluginUi["onScreen"]) {
  const backend = fakeBackend({ hosts, plugins });
  const registries = builtinRegistries();
  const store = { get: (k: string) => state[k], set: (k: string, v: unknown) => void (state[k] = v) };
  const said: Message[] = [];
  const lines: string[] = [];
  const ran: string[] = [];
  const ui: PluginUi = {
    run: (l) => {
      ran.push(l);
      // As the app's, when asked: a line runs its command there and then.
      const [word = "", ...rest] = l.split(/\s+/);
      if (dispatch) registries.commands.get(word)?.run(ctx(), rest.join(" "));
    },
    send: () => undefined,
    copy: async () => undefined,
    say: (t) => void said.push(t),
    openCommandLine: (t) => void lines.push(t),
    builtinSettings: async (name) => (name === "folders" ? settings : null),
    ...(onScreen ? { onScreen } : {}),
  };
  const manager = new PluginManager(backend, registries, store, ui);
  return { manager, registries, backend, said, lines, ran, state };
}

function section(registries: ReturnType<typeof builtinRegistries>) {
  const s = registries.sidebar.get("folders")!.build({ hostByName } as unknown as SidebarContext);
  if (!s) throw new Error("no Folders section");
  return s;
}

/** Runs a `plugins call …` line the way the app's `:plugins call` does. */
async function call(manager: PluginManager, line: string) {
  const [, , plugin, handler, ctx] = line.split(" ");
  await manager.call(plugin!, Number(handler), JSON.parse(decodeURIComponent(ctx!)));
}

function ctx(row: string | null = null, host: string | null = null): CommandContext {
  return { cursorRow: () => (row ? { id: row, label: "", command: "" } : null), selectedHost: () => host } as unknown as CommandContext;
}

describe("the Folders Plugin in the app", () => {
  it("draws its Hosts as the Inventory does, folds its Folders, and keeps its own buttons", async () => {
    const { manager, registries } = setup({ import: [{ name: "Lab", hosts: [h1, "gone-01"] }], import_from: "folders.yml" });
    await manager.start();
    const s = section(registries);
    expect(s.count).toBe(1);
    const [head, host, gone] = s.rows;
    expect(head).toMatchObject({ id: "folders:Lab", foldable: true, icon: "folder", count: 2, command: "togglefold folders:Lab" });
    expect(host).toMatchObject({ id: `folders:Lab/${h1}`, label: h1, host: h1, detail: hostByName.get(h1)!.ip, drag: h1, level: 1 });
    expect(host!.actions!.map((a) => a.label)).toEqual([`Show ${h1}'s details`, `Remove ${h1} from Lab`]);
    expect(gone).toMatchObject({ label: "gone-01", note: "not in the Inventory", dot: "off" });
    expect(host!.dragOut).toBe(`plugins run folders folder remove ${h1} Lab`);
  });

  it("a drop runs the Plugin with the Host dropped, and its answer adds it", async () => {
    const { manager, registries, lines } = setup();
    await manager.start();
    const drop = section(registries).drop!(h2);
    expect(drop).toMatch(/^plugins call folders \d+ /);
    expect(JSON.parse(decodeURIComponent(drop!.split(" ")[4]!))).toEqual({ section: "folders", dropped: h2 });
    await call(manager, drop!);
    // On the section: the command line asks which Folder.
    expect(lines).toEqual([`folder add ${h2} `]);
  });

  it("a Host dropped on a Folder goes into it, and the Plugin says so (issue #183)", async () => {
    const { manager, registries, said, ran } = setup({}, {}, {}, true);
    await manager.start();
    registries.commands.get("folder")!.run(ctx(), "new Lab");
    await vi.waitFor(() => expect(section(registries).rows[0]).toMatchObject({ label: "Lab" }));
    const drop = section(registries).rows[0]!.drop!(h2);
    await call(manager, drop!);
    // The drop's `roster.cmd("folder add …")` runs `:folder` as the user's call carried one hop.
    // A routine confirmation: quiet, as roster's own (ticket 118).
    await vi.waitFor(() => expect(said.at(-1)).toEqual(quiet(`Added ${h2} to Lab`)));
    expect(ran).toEqual([`folder add ${h2} Lab`]);
    expect(section(registries).rows.map((r) => r.label)).toEqual(["Lab", h2]);
  });

  it("a command hears the Host and row under the Sidebar's cursor, and answers on the message line", async () => {
    const { manager, registries, said, lines } = setup();
    await manager.start();
    const folder = registries.commands.get("folder")!;
    folder.run(ctx(null, h1), "add");
    await vi.waitFor(() => expect(lines).toEqual([`folder add ${h1} `]));
    folder.run(ctx(), `add ${h1} Lab`);
    await vi.waitFor(() => expect(said).toEqual([quiet(`Added ${h1} to Lab`)]));
    folder.run(ctx(`folders:Lab/${h1}`), "remove");
    await vi.waitFor(() => expect(said.at(-1)).toEqual(quiet(`Removed ${h1} from Lab`)));
    // What went wrong shows.
    folder.run(ctx(), "add nope-01 Lab");
    await vi.waitFor(() => expect(said.at(-1)).toBe("No Host named nope-01"));
  });

  it("completes a moment later, from what the Plugin answers", async () => {
    const { manager, registries } = setup();
    await manager.start();
    const folder = registries.commands.get("folder")!;
    expect(folder.complete!("re", [])).toEqual([]);
    await vi.waitFor(() => expect(folder.complete!("re", [])).toEqual(["rename ", "remove "]));
    // While the next answer comes, the last list, kept to what still matches.
    expect(folder.complete!("ren", [])).toEqual(["rename "]);
  });

  it("init.lua's Folders are its settings: a change loads it again", async () => {
    const settings: Record<string, unknown> = { fixed: [] };
    const { manager, registries } = setup(settings);
    await manager.start();
    expect(section(registries).rows).toEqual([]);
    settings.fixed = [{ name: "Core", hosts: [h1], source: "init.lua" }];
    await manager.reloadBuiltin("folders");
    expect(section(registries).rows[0]).toMatchObject({ label: "Core", note: "from init.lua" });
  });

  it("can't be removed, only have its permission revoked", async () => {
    const { manager } = setup();
    await manager.start();
    expect(await manager.remove("folders")).toMatch(/built into roster/);
  });
});

describe("a Plugin's data folder", () => {
  const keeper: FakePlugin = {
    manifest: { name: "keeper", version: "1", description: "", author: null, api: 3, permissions: [] },
    load(roster) {
      roster.storage.write("seen.txt", "x");
    },
  };

  it("goes when the Plugin is removed, and only then", async () => {
    const state = { [STATE_KEY]: [{ path: "/p/keeper", name: "keeper", granted: [], asked: [] }] };
    const { manager, backend } = setup({}, { "/p/keeper": keeper }, state);
    await manager.start();
    expect(backend.pluginFiles("keeper").get("seen.txt")).toBe("x");
    await manager.reload("keeper");
    expect(backend.pluginFiles("keeper").size).toBe(1);
    expect(await manager.remove("keeper")).toBeNull();
    expect(backend.pluginFiles("keeper").size).toBe(0);
  });
});

describe("a Folders drop before the core has roster's own commands (issue #241)", () => {
  /** Folders with a Folder "Lab", and the core not taking the built-in command list until `up`
   * (a send that never answers while `hang`). */
  async function down(plugins: Record<string, FakePlugin> = {}, state: Record<string, unknown> = {}, onScreen?: PluginUi["onScreen"]) {
    const { manager, registries, backend, said, ran } = setup({ import: [{ name: "Lab", hosts: [h1] }], import_from: "folders.yml" }, plugins, state, true, onScreen);
    const real = backend.pluginBuiltins.bind(backend);
    const link = { up: false, hang: false };
    const sent = vi
      .spyOn(backend, "pluginBuiltins")
      .mockImplementation((names) => (link.hang ? new Promise<void>(() => undefined) : link.up ? real(names) : Promise.reject(new Error("no such command"))));
    await manager.start();
    const drop = section(registries).rows[0]!.drop!(h2)!;
    const dropOf = (host: string) => section(registries).rows[0]!.drop!(host)!;
    const errors = () => manager.snapshot().notices.filter((n) => n.level === "error").map((n) => n.text);
    return { manager, registries, backend, said, ran, link, drop, dropOf, errors, sent };
  }

  it("waits for the list while a send is failing and retrying, then runs", async () => {
    vi.useFakeTimers();
    try {
      const { manager, registries, said, ran, link, drop, errors } = await down();
      let done = false;
      const dropping = call(manager, drop).then(() => void (done = true));
      await vi.advanceTimersByTimeAsync(500);
      // Held, not refused: nothing ran yet and nothing went wrong.
      expect(done).toBe(false);
      expect(ran).toEqual([]);
      expect(errors()).toEqual([]);
      // The next try gets through, and the drop runs as the user's.
      link.up = true;
      await vi.advanceTimersByTimeAsync(1_000);
      await dropping;
      expect(errors()).toEqual([]);
      expect(ran).toEqual([`folder add ${h2} Lab`]);
      expect(said.at(-1)).toEqual(quiet(`Added ${h2} to Lab`));
      expect(section(registries).rows.map((r) => r.label)).toEqual(["Lab", h1, h2]);
      manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails clearly, still refused, once the list hasn't come in the time allowed", async () => {
    vi.useFakeTimers();
    try {
      const { manager, ran, drop, errors } = await down();
      let done = false;
      const dropping = call(manager, drop).then(() => void (done = true));
      await vi.advanceTimersByTimeAsync(BUILTINS_WAIT_MS - 100);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      await dropping;
      expect(ran).toEqual([]);
      expect(errors()).toEqual([expect.stringContaining(":folder can't run yet: the app hasn't told roster its own commands")]);
      manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds only so many calls at once; the next is refused at once, and the held ones each run once", async () => {
    vi.useFakeTimers();
    try {
      const { manager, ran, link, drop, errors } = await down();
      const done = Array.from({ length: BUILTINS_HELD_MAX }, () => false);
      const held = done.map((_, i) => call(manager, drop).then(() => void (done[i] = true)));
      await vi.advanceTimersByTimeAsync(100);
      // All held, none refused.
      expect(done).toEqual(Array.from({ length: BUILTINS_HELD_MAX }, () => false));
      expect(ran).toEqual([]);
      expect(errors()).toEqual([]);
      // One more doesn't wait: it's refused there and then.
      await call(manager, drop);
      expect(ran).toEqual([]);
      expect(errors()).toEqual([expect.stringContaining(":folder can't run yet: the app hasn't told roster its own commands")]);
      expect(done.every((d) => !d)).toBe(true);
      // The list gets through: each held call runs, once.
      link.up = true;
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.all(held);
      expect(ran).toEqual(Array.from({ length: BUILTINS_HELD_MAX }, () => `folder add ${h2} Lab`));
      manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the held calls in the order they were made, before one made after the list got through", async () => {
    vi.useFakeTimers();
    try {
      const { manager, ran, link, dropOf } = await down();
      const first = call(manager, dropOf(h2));
      await vi.advanceTimersByTimeAsync(300);
      const second = call(manager, dropOf(hosts.hosts[2]!.name));
      await vi.advanceTimersByTimeAsync(300);
      link.up = true;
      const third = call(manager, dropOf(h1));
      await vi.advanceTimersByTimeAsync(BUILTINS_WAIT_MS);
      await Promise.all([first, second, third]);
      expect(ran).toEqual([`folder add ${h2} Lab`, `folder add ${hosts.hosts[2]!.name} Lab`, `folder add ${h1} Lab`]);
      manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a send that never answers holds a call no longer than the time allowed", async () => {
    vi.useFakeTimers();
    try {
      const { manager, ran, link, drop, errors } = await down();
      link.hang = true;
      let done = false;
      const dropping = call(manager, drop).then(() => void (done = true));
      await vi.advanceTimersByTimeAsync(BUILTINS_WAIT_MS + 100);
      expect(done).toBe(true);
      await dropping;
      expect(ran).toEqual([]);
      expect(errors()).toEqual([expect.stringContaining(":folder can't run yet")]);
      manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("held calls share one send at a time, and their failures don't slow the app's own retries", async () => {
    vi.useFakeTimers();
    try {
      /** Sends from 6 s to 120 s after the start, with three calls held at first or none. */
      const later = async (hold: boolean) => {
        const { manager, drop, sent } = await down();
        const before = sent.mock.calls.length;
        const held = hold ? [call(manager, drop), call(manager, drop), call(manager, drop)] : [];
        await vi.advanceTimersByTimeAsync(BUILTINS_WAIT_MS + 100);
        await Promise.all(held);
        const during = sent.mock.calls.length - before;
        const at6 = sent.mock.calls.length;
        await vi.advanceTimersByTimeAsync(120_000 - BUILTINS_WAIT_MS - 100);
        manager.stop();
        return { during, after: sent.mock.calls.length - at6 };
      };
      const quiet = await later(false);
      const busy = await later(true);
      // About one try a second for all three, not three.
      expect(busy.during).toBeLessThanOrEqual(quiet.during + Math.ceil(BUILTINS_WAIT_MS / 1000) + 1);
      expect(busy.after).toBe(quiet.after);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a call carried one hop doesn't wait (only the user's own call does)", async () => {
    vi.useFakeTimers();
    try {
      const { manager, drop } = await down();
      const [, , plugin, handler, ctx] = drop.split(" ");
      let done = false;
      const carried = manager.call(plugin!, Number(handler), JSON.parse(decodeURIComponent(ctx!)), "ran an action", "carried").then(() => void (done = true));
      await vi.advanceTimersByTimeAsync(10);
      expect(done).toBe(true);
      await carried;
      manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an empty list counts as sent: a call doesn't wait for it", async () => {
    vi.useFakeTimers();
    try {
      const { manager, registries, backend, ran } = setup({ import: [{ name: "Lab", hosts: [h1] }], import_from: "folders.yml" }, {}, {}, true);
      const all = registries.commands.list.bind(registries.commands);
      vi.spyOn(registries.commands, "list").mockImplementation(() => all().filter((c) => c.source !== "builtin"));
      const sent = vi.spyOn(backend, "pluginBuiltins");
      await manager.start();
      expect(sent.mock.calls[0]?.[0]).toEqual([]);
      let done = false;
      const dropping = call(manager, section(registries).rows[0]!.drop!(h2)!).then(() => void (done = true));
      await vi.advanceTimersByTimeAsync(10);
      expect(done).toBe(true);
      await dropping;
      expect(ran).toEqual([`folder add ${h2} Lab`]);
      manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a core that lost the list (built anew) is sent it again, so the next drop runs", async () => {
    const { manager, registries, backend, ran, errors } = (() => {
      const r = setup({ import: [{ name: "Lab", hosts: [h1] }], import_from: "folders.yml" }, {}, {}, true);
      return { ...r, errors: () => r.manager.snapshot().notices.filter((n) => n.level === "error").map((n) => n.text) };
    })();
    await manager.start();
    const sent = vi.spyOn(backend, "pluginBuiltins");
    backend.pluginForgetBuiltins();
    await call(manager, section(registries).rows[0]!.drop!(h2)!);
    expect(errors()).toEqual([expect.stringContaining(":folder can't run yet")]);
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
    expect(sent.mock.calls[0]?.[0]).toContain("publish");
    await call(manager, section(registries).rows[0]!.drop!(h2)!);
    expect(ran).toEqual([`folder add ${h2} Lab`]);
    manager.stop();
  });

  it("a held call keeps the Session the user acted on, not the one on screen when it runs", async () => {
    vi.useFakeTimers();
    try {
      const heard: Record<string, unknown>[] = [];
      const ctxPlugin: FakePlugin = {
        manifest: { name: "ctx", version: "1", description: "", author: null, api: 3, permissions: ["terminal.read"] },
        load(roster) {
          roster.sidebar.set("pins", { rows: [{ id: "a", label: "a", run: (c: Record<string, unknown>) => void heard.push(c) }] });
        },
      };
      let onScreen = { session: 7, host: "esx-02" };
      const { manager, registries, link } = await down(
        { "/p/ctx": ctxPlugin },
        { [STATE_KEY]: [{ path: "/p/ctx", name: "ctx", granted: ["terminal.read"], asked: ["terminal.read"] }] },
        () => onScreen,
      );
      const line = registries.sidebar.get("pins")!.build({} as never)!.rows[0]!.command!;
      const [, , plugin, handler, ctx] = line.split(" ");
      const running = manager.callWith(plugin!, Number(handler), JSON.parse(decodeURIComponent(ctx!)));
      await vi.advanceTimersByTimeAsync(300);
      expect(heard).toEqual([]);
      onScreen = { session: 9, host: "esx-03" };
      link.up = true;
      await vi.advanceTimersByTimeAsync(BUILTINS_WAIT_MS);
      await running;
      expect(heard).toEqual([expect.objectContaining({ session: 7, session_host: "esx-02" })]);
      manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
