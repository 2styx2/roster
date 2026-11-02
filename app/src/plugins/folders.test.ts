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

function setup(settings: Record<string, unknown> | null = {}, plugins: Record<string, FakePlugin> = {}, state: Record<string, unknown> = {}, dispatch = false) {
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
  /** Folders with a Folder "Lab", and the core not taking the built-in command list until `up`. */
  async function down() {
    const { manager, registries, backend, said, ran } = setup({ import: [{ name: "Lab", hosts: [h1] }], import_from: "folders.yml" }, {}, {}, true);
    const real = backend.pluginBuiltins.bind(backend);
    const link = { up: false };
    vi.spyOn(backend, "pluginBuiltins").mockImplementation((names) => (link.up ? real(names) : Promise.reject(new Error("no such command"))));
    await manager.start();
    const drop = section(registries).rows[0]!.drop!(h2)!;
    const errors = () => manager.snapshot().notices.filter((n) => n.level === "error").map((n) => n.text);
    return { manager, registries, said, ran, link, drop, errors };
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

  it("holds only so many calls at once; the rest are refused at once", async () => {
    vi.useFakeTimers();
    try {
      const { manager, ran, drop, errors } = await down();
      const held = Array.from({ length: BUILTINS_HELD_MAX }, () => call(manager, drop));
      await vi.advanceTimersByTimeAsync(100);
      expect(errors()).toEqual([]);
      await call(manager, drop);
      expect(errors()).toEqual([expect.stringContaining(":folder can't run yet")]);
      await vi.advanceTimersByTimeAsync(BUILTINS_WAIT_MS);
      await Promise.all(held);
      expect(ran).toEqual([]);
      manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
