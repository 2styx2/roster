// What counts as the user's call, and the manager's own guards (the iteration 8 review): only what
// the user chose (a command, a row or button, a finder item, a toolbar control, a key, a
// question's answer) is the user's call. A finder's items, a `:check` section's lines, and a
// question's `cancel` run because another Plugin's question took its place are the app's doing.
import { describe, expect, it } from "vitest";
import { fakeBackend, makeHosts } from "../backend/fake";
import type { FakePlugin, FakeRoster } from "../backend/fakePlugins";
import { builtinRegistries } from "../registries";
import { PluginManager, STATE_KEY, type PluginUi } from "./manager";

/** What only the user's call may do, tried: "copy ok" or "copy refused". */
function tried(roster: FakeRoster): string {
  try {
    roster.clipboard.copy("10.0.0.5");
    return "copy ok";
  } catch {
    return "copy refused";
  }
}

function plugin(name: string, load: FakePlugin["load"], permissions: string[] = []): FakePlugin {
  return { manifest: { name, version: "1.0.0", description: "", author: null, api: 3, permissions }, load };
}

/** The manager over the fake Backend, every Plugin installed and granted what it asks. With
 * `slowLoad`, a load's reply reaches the app only after the answers to what it asked meanwhile, as
 * the core's `plugin-reply` events can overtake the load's own reply. */
function setup(plugins: Record<string, FakePlugin>, slowLoad = false) {
  const backend = fakeBackend({ hosts: makeHosts(2), plugins });
  if (slowLoad) {
    const load = backend.pluginLoad.bind(backend);
    backend.pluginLoad = async (...args) => {
      const r = await load(...args);
      await new Promise((done) => setTimeout(done, 5));
      return r;
    };
  }
  const registries = builtinRegistries();
  const state: Record<string, unknown> = {
    [STATE_KEY]: Object.values(plugins).map((p) => ({ path: p.manifest.name, name: p.manifest.name, granted: p.manifest.permissions, asked: p.manifest.permissions })),
  };
  const store = { get: (k: string) => state[k], set: (k: string, v: unknown) => void (state[k] = v) };
  const ran: string[] = [];
  // As the app's: a line runs its command there and then.
  const ui: PluginUi = {
    run: (l) => {
      ran.push(l);
      const [word = "", ...rest] = l.split(/\s+/);
      if (ran.length < 200) registries.commands.get(word)?.run({} as never, rest.join(" "));
    },
    send: () => undefined,
    copy: async () => undefined,
  };
  const manager = new PluginManager(backend, registries, store, ui);
  backend.onPluginReply((r) => manager.replied(r));
  return { manager, registries, ran };
}

const settle = () => new Promise((done) => setTimeout(done, 5));

describe("the user's call", () => {
  it("a finder's items and a :check section's lines are never it", async () => {
    const said: string[] = [];
    const lists = plugin("lists", (roster) => {
      roster.finders.set("picks", { title: "Picks", items: () => [{ id: "a", label: tried(roster), run: () => said.push(`item ${tried(roster)}`) }] });
      roster.health.set("lab", { title: "Lab", check: () => [{ level: "ok", message: tried(roster) }] });
    });
    const { manager, registries } = setup({ lists });
    await manager.start();
    registries.finders.get("picks")?.open?.();
    await settle();
    const items = registries.finders.get("picks")?.items({} as never) ?? [];
    expect(items.map((i) => i.label)).toEqual(["copy refused"]);
    const lines = await registries.health.get("lab")?.checks({} as never);
    expect(lines?.map((l) => l.message)).toEqual(["copy refused"]);
  });

  it("a question's cancel, run because another Plugin's question took its place, isn't it", async () => {
    const said: string[] = [];
    const asker = (name: string) =>
      plugin(name, (roster) => {
        roster.commands.add(`ask-${name}`, {
          run: () => roster.confirm({ title: `${name}?`, run: () => said.push(`${name} yes ${tried(roster)}`), cancel: () => said.push(`${name} no ${tried(roster)}`) }),
        });
      });
    const { manager, registries } = setup({ a: asker("a"), b: asker("b") });
    await manager.start();
    registries.commands.get("ask-a")?.run({} as never, "");
    await settle();
    registries.commands.get("ask-b")?.run({} as never, "");
    await settle();
    // b's question took a's place: a hears its cancel, but the user chose nothing of a's.
    expect(said).toEqual(["a no copy refused"]);
    manager.answerConfirm(false);
    await settle();
    expect(said).toEqual(["a no copy refused", "b no copy ok"]);
  });
});

describe("loading", () => {
  it("an answer to what init.lua asked, arriving before the load's reply, is applied after it", async () => {
    let loads = 0;
    const asker = plugin(
      "asker",
      (roster) => {
        const load = ++loads;
        roster.status.set("state", { text: `loading ${load}` });
        roster.serve?.request("mesh.status", {}, (_r, why) => roster.status.set("state", { text: `answered ${load}: ${why ? "no Mesh" : "Mesh"}` }));
      },
      ["serve:mesh.status"],
    );
    const { manager, registries } = setup({ asker }, true);
    await manager.start();
    await settle();
    expect(registries.status.get("state")?.text).toBe("answered 1: no Mesh");
    // A reload: the new load's answer is the new load's, not put on the old one and then lost.
    await manager.reload("asker");
    await settle();
    expect(registries.status.get("state")?.text).toBe("answered 2: no Mesh");
  });
});

/** Everything only the user's call may do, tried in turn (issue #183). */
function triedAll(roster: FakeRoster): string {
  const said: string[] = [];
  const attempt = (name: string, f: () => void) => {
    try {
      f();
      said.push(`${name} ok`);
    } catch {
      said.push(`${name} refused`);
    }
  };
  attempt("copy", () => roster.clipboard.copy("10.0.0.5"));
  attempt("confirm", () => roster.confirm({ title: "Sure?", run: () => undefined }));
  attempt("scan", () => roster.serve?.request("discover.start", {}, () => undefined));
  attempt("cut", () => roster.serve?.request("mesh.cut", {}, () => undefined));
  return said.join(", ");
}

describe("a Plugin's command lines", () => {
  it("a chain of its own commands carries the user's call one hop, no further (issue #183)", async () => {
    const said: string[] = [];
    const chain = plugin(
      "chain",
      (roster) => {
        const link = (name: string, next: string) =>
          roster.commands.add(name, {
            run: () => {
              said.push(`${name}: ${triedAll(roster)}`);
              try {
                roster.cmd(next);
              } catch {
                said.push(`${name}: cmd refused`);
              }
            },
          });
        link("a", "b");
        link("b", "c");
        link("c", "a");
      },
      ["serve:discover.start", "serve:mesh.cut"],
    );
    const { manager, registries } = setup({ chain });
    await manager.start();
    registries.commands.get("a")?.run({} as never, "");
    for (let i = 0; i < 5; i++) await settle();
    const allowed = "copy ok, confirm ok, scan ok, cut ok";
    expect(said).toEqual([`a: ${allowed}`, `b: ${allowed}`, "c: copy refused, confirm refused, scan refused, cut refused", "c: cmd refused"]);
  });

  it("a request's answer carrying the user's call runs its command line as the app's call", async () => {
    const said: string[] = [];
    const hops = plugin(
      "hops",
      (roster) => {
        roster.commands.add("ask", {
          run: () =>
            roster.serve?.request("mesh.status", {}, () => {
              said.push(`answer: ${triedAll(roster)}`);
              roster.cmd("then");
            }),
        });
        roster.commands.add("then", { run: () => void said.push(`then: ${triedAll(roster)}`) });
      },
      ["serve:mesh.status", "serve:discover.start", "serve:mesh.cut"],
    );
    const { manager, registries } = setup({ hops });
    await manager.start();
    registries.commands.get("ask")?.run({} as never, "");
    for (let i = 0; i < 5; i++) await settle();
    expect(said).toEqual(["answer: copy ok, confirm ok, scan ok, cut ok", "then: copy refused, confirm refused, scan refused, cut refused"]);
  });

  it("a command whose line runs itself, or two that run each other, stop with a notice", async () => {
    const loops = plugin("loops", (roster) => {
      roster.commands.add("again", { run: "again" });
      roster.commands.add("ping", { run: "pong" });
      roster.commands.add("pong", { run: "ping" });
      roster.commands.add("hello", { run: "pong-free" });
      roster.commands.add("pong-free", { run: () => undefined });
    });
    const { manager, registries, ran } = setup({ loops });
    await manager.start();
    registries.commands.get("again")?.run({} as never, "");
    expect(ran).toEqual([]);
    registries.commands.get("ping")?.run({} as never, "");
    expect(ran).toEqual(["pong"]);
    // A line that runs another command is fine.
    registries.commands.get("hello")?.run({} as never, "");
    expect(ran).toEqual(["pong", "pong-free"]);
    expect(manager.snapshot().notices.map((n) => n.text)).toEqual([
      "loops: :again runs itself (its line runs again)",
      "loops: :ping runs itself (its line runs again)",
    ]);
  });
});
