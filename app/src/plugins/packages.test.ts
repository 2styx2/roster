// Packages (ticket 24) through the Plugin manager and the fake Backend: what init.lua names is
// cloned and asks first (its git URL shown as the unverified source); Cancel leaves nothing and is
// remembered in the State (`:packages install NAME` asks again); an
// update shows its diff and asks again for a new permission, and declining keeps the old version;
// `:plugins remove` and `:packages clean` leave the app as it was.
import { describe, expect, it } from "vitest";
import { fakeBackend, makeHosts } from "../backend/fake";
import { fakeCommit, type FakePackage, type FakePackages } from "../backend/fakePackages";
import type { FakePlugin } from "../backend/fakePlugins";
import { builtinRegistries } from "../registries";
import { PluginManager, STATE_KEY } from "./manager";

function alerts(version: string, permissions: string[]): FakePlugin {
  return {
    manifest: { name: "recent-alerts", version, description: "Lines that look like trouble", author: "A. Author", api: 2, permissions },
    load(roster) {
      const patterns = (roster.plugin.config.patterns as string[] | undefined) ?? ["ERROR"];
      roster.commands.add("alerts", { desc: "Show the alerts", run: () => null });
      roster.keymap.set("leader", "a a", "alerts");
      roster.status.set("alerts", { text: `${version} ${patterns.join(",")}` });
    },
  };
}

function repo(): FakePackage {
  return {
    name: "recent-alerts",
    source: "/srv/git/recent-alerts.git",
    config: { patterns: ["ERROR", "panic"] },
    versions: [{ commit: fakeCommit(1), subject: "First", plugin: alerts("1.0.0", ["terminal.read"]), diff: "+first" }],
  };
}

function setup(packages: FakePackages, state: Record<string, unknown> = {}) {
  const backend = fakeBackend({ hosts: makeHosts(2), packages });
  const registries = builtinRegistries();
  const store = { get: (k: string) => state[k], set: (k: string, v: unknown) => void (state[k] = v) };
  const manager = new PluginManager(backend, registries, store, { run: () => undefined, send: () => undefined, copy: async () => undefined });
  return { manager, registries, state, packages, backend };
}

/** What a Plugin could have added, to compare before and after. */
const added = (r: ReturnType<typeof builtinRegistries>) => ({
  commands: r.commands.list().map((c) => c.id),
  keys: r.keymap.list().map((k) => k.id),
  status: r.status.list().map((s) => s.id),
});

async function installed() {
  const s = setup({ named: [repo()], lock: {} });
  await s.manager.syncPackages();
  const prompt = s.manager.snapshot().prompts[0];
  if (prompt) await s.manager.answer(prompt, true);
  return s;
}

describe("installing a Package", () => {
  it("asks first, showing its git URL as unverified; Cancel installs nothing", async () => {
    const { manager, registries, state, packages } = setup({ named: [repo()], lock: {} });
    await manager.start();
    const before = added(registries);
    await manager.syncPackages();
    const [prompt] = manager.snapshot().prompts;
    expect(prompt).toMatchObject({ kind: "install", path: "package:recent-alerts", asking: ["terminal.read"], package: { url: "/srv/git/recent-alerts.git" } });
    expect(prompt?.manifest.permissions[0]?.risk).toMatch(/password/);
    expect(registries.commands.get("alerts")).toBeUndefined();
    if (prompt) await manager.answer(prompt, false);
    expect(added(registries)).toEqual(before);
    expect(state[STATE_KEY]).toBeUndefined();
    expect(packages.lock).toEqual({});
    expect(packages.clones).toEqual({});
    // Not asked again this run.
    await manager.syncPackages();
    expect(manager.snapshot().prompts).toEqual([]);
  });

  async function cancelled() {
    const s = setup({ named: [repo()], lock: {} });
    await s.manager.syncPackages();
    const [prompt] = s.manager.snapshot().prompts;
    if (prompt) await s.manager.answer(prompt, false);
    return s;
  }

  it("a cancelled install isn't asked again at the next start", async () => {
    const first = await cancelled();
    const again = setup(first.packages, first.state);
    await again.manager.syncPackages();
    expect(again.manager.snapshot().prompts).toEqual([]);
    expect(again.packages.clones).toEqual({});
    expect(again.manager.snapshot().declined).toEqual(["recent-alerts"]);
  });

  it("a cancelled install asks again once init.lua names another repo or folder for it", async () => {
    const first = await cancelled();
    const [p] = first.packages.named;
    if (p) p.dir = "plugins/recent-alerts";
    const again = setup(first.packages, first.state);
    await again.manager.syncPackages();
    expect(again.manager.snapshot().prompts).toHaveLength(1);
  });

  it("init.lua no longer naming a cancelled Package forgets it was cancelled", async () => {
    const first = await cancelled();
    const named = first.packages.named;
    first.packages.named = [];
    await first.manager.syncPackages();
    first.packages.named = named;
    await first.manager.syncPackages();
    expect(first.manager.snapshot().prompts).toHaveLength(1);
  });

  it(":packages install NAME asks again for a cancelled Package", async () => {
    const { manager, registries } = await cancelled();
    expect(await manager.installPackage("recent-alerts")).toBeNull();
    const [prompt] = manager.snapshot().prompts;
    expect(prompt).toMatchObject({ kind: "install", path: "package:recent-alerts" });
    if (prompt) await manager.answer(prompt, true);
    expect(registries.commands.get("alerts")?.source).toBe("recent-alerts");
    expect(manager.snapshot().declined).toEqual([]);
  });

  it(":packages install NAME says why when there's nothing to ask", async () => {
    const { manager } = await installed();
    expect(await manager.installPackage("recent-alerts")).toMatch(/installed already/);
    expect(await manager.installPackage("nope")).toMatch(/init.lua names no Package nope/);
  });

  it("allowed, it's pinned in roster.lock and runs with init.lua's settings", async () => {
    const { registries, state, packages } = await installed();
    expect(packages.lock).toEqual({ "recent-alerts": fakeCommit(1) });
    expect(registries.commands.get("alerts")?.source).toBe("recent-alerts");
    expect(registries.status.get("alerts")?.text).toBe("1.0.0 ERROR,panic");
    expect(state[STATE_KEY]).toEqual([{ path: "package:recent-alerts", name: "recent-alerts", granted: ["terminal.read"], asked: ["terminal.read"] }]);
  });

  it("the next start loads it from the lock without asking", async () => {
    const first = await installed();
    const again = setup(first.packages, first.state);
    await again.manager.syncPackages();
    expect(again.manager.snapshot().prompts).toEqual([]);
    expect(again.registries.commands.get("alerts")?.source).toBe("recent-alerts");
  });

  it("changed settings in init.lua load it again with them", async () => {
    const { manager, registries, packages } = await installed();
    const [p] = packages.named;
    if (p) p.config = { patterns: ["disk full"] };
    await manager.syncPackages();
    expect(registries.status.get("alerts")?.text).toBe("1.0.0 disk full");
  });
});

describe(":packages update", () => {
  function newVersion(packages: FakePackages, permissions: string[]) {
    packages.named[0]?.versions.push({ commit: fakeCommit(2), subject: "Type into Sessions", plugin: alerts("2.0.0", permissions), diff: "+-- now types too" });
  }

  it("says when everything is up to date", async () => {
    const { manager } = await installed();
    expect(await manager.checkPackages()).toBe("All Packages are up to date");
  });

  it("shows the new commit and its diff, and asks again for a new permission; declining keeps the old version", async () => {
    const { manager, registries, packages, state } = await installed();
    newVersion(packages, ["terminal.read", "terminal.write"]);
    expect(await manager.checkPackages()).toBe("An update: recent-alerts");
    const [prompt] = manager.snapshot().prompts;
    expect(prompt).toMatchObject({ kind: "update", asking: ["terminal.write"] });
    expect(prompt?.package?.update).toMatchObject({ from: fakeCommit(1), to: fakeCommit(2), diff: "+-- now types too" });
    expect(prompt?.package?.update?.log[0]).toMatch(/Type into Sessions$/);
    if (prompt) await manager.answer(prompt, false);
    expect(packages.lock["recent-alerts"]).toBe(fakeCommit(1));
    expect(registries.status.get("alerts")?.text).toMatch(/^1\.0\.0/);
    expect(state[STATE_KEY]).toEqual([{ path: "package:recent-alerts", name: "recent-alerts", granted: ["terminal.read"], asked: ["terminal.read"] }]);
  });

  it(":packages update NAME checks that one only", async () => {
    const plugin = alerts("1.0.0", []);
    const other: FakePackage = {
      name: "other",
      source: "/srv/git/other.git",
      versions: [{ commit: fakeCommit(3), subject: "First", plugin: { ...plugin, manifest: { ...plugin.manifest, name: "other" }, load: () => undefined }, diff: "+first" }],
    };
    const s = setup({ named: [repo(), other], lock: {} });
    await s.manager.syncPackages();
    for (const prompt of s.manager.snapshot().prompts) await s.manager.answer(prompt, true);
    newVersion(s.packages, ["terminal.read"]);
    const asked: (string | undefined)[] = [];
    const check = s.backend.packagesCheck.bind(s.backend);
    s.backend.packagesCheck = (name?: string) => {
      asked.push(name);
      return check(name);
    };
    expect(await s.manager.checkPackages("other")).toBe("other is up to date");
    expect(s.manager.snapshot().prompts).toEqual([]);
    expect(await s.manager.checkPackages("recent-alerts")).toBe("An update: recent-alerts");
    expect(asked).toEqual(["other", "recent-alerts"]);
  });

  it(":packages update NAME says when there's no such Package, or it isn't installed", async () => {
    const { manager } = setup({ named: [repo()], lock: {} });
    await manager.syncPackages();
    expect(await manager.checkPackages("nope")).toBe("init.lua names no Package nope");
    expect(await manager.checkPackages("recent-alerts")).toBe("recent-alerts isn't installed: :packages install recent-alerts asks to install it");
  });

  it("allowed, it moves to the new commit with the new permission", async () => {
    const { manager, registries, packages, state } = await installed();
    newVersion(packages, ["terminal.read", "terminal.write"]);
    await manager.checkPackages();
    const [prompt] = manager.snapshot().prompts;
    if (prompt) await manager.answer(prompt, true);
    expect(packages.lock["recent-alerts"]).toBe(fakeCommit(2));
    expect(registries.status.get("alerts")?.text).toMatch(/^2\.0\.0/);
    expect(state[STATE_KEY]).toEqual([
      { path: "package:recent-alerts", name: "recent-alerts", granted: ["terminal.read", "terminal.write"], asked: ["terminal.read", "terminal.write"] },
    ]);
  });
});

describe("taking a Package out", () => {
  it(":plugins remove leaves the app as it was, clone and lock entry included", async () => {
    const fresh = setup({ named: [], lock: {} });
    await fresh.manager.start();
    const before = added(fresh.registries);
    const { manager, registries, state, packages } = await installed();
    expect(await manager.remove("recent-alerts")).toMatch(/init.lua still names it/);
    expect(added(registries)).toEqual(before);
    expect(state[STATE_KEY]).toEqual([]);
    expect(packages.lock).toEqual({});
    expect(packages.clones).toEqual({});
  });

  it(":packages clean removes what init.lua no longer names, and what it added", async () => {
    const { manager, registries, state, packages } = await installed();
    packages.named = [];
    await manager.syncPackages();
    expect(registries.commands.get("alerts")).toBeUndefined();
    expect(manager.snapshot().plugins.find((p) => p.name === "recent-alerts")?.problem).toMatch(/no longer names it/);
    expect(await manager.cleanPackages()).toBe("Removed recent-alerts");
    expect(state[STATE_KEY]).toEqual([]);
    expect(packages.lock).toEqual({});
    expect(manager.snapshot().plugins.map((p) => p.name)).toEqual(["folders", "hosts"]);
    expect(await manager.cleanPackages()).toMatch(/Nothing to clean/);
  });

  it("nothing installs that init.lua doesn't name", async () => {
    const { manager } = setup({ named: [], lock: {} });
    expect(await manager.install("package:recent-alerts")).toMatch(/installs from init.lua/);
  });
});
