// The fake Backend's Plugin host refuses exactly what the core refuses in a manifest: both are
// tested on one table (crates/roster-core/tests/fixtures/plugin-permissions.json, which
// crates/roster-core/src/plugin/permission.rs checks its own tables and cases against).
import { describe, expect, it } from "vitest";
import table from "../../../crates/roster-core/tests/fixtures/plugin-permissions.json";
import { described, fakePluginHost, manifestProblem, type FakePlugin } from "./fakePlugins";
import { BackendCallError, type Host, type PluginReply } from "./types";

const manifest = (permissions: string[]): FakePlugin["manifest"] => ({
  name: "example",
  version: "1.0.0",
  description: "",
  author: null,
  api: 2,
  permissions,
});

describe("a fake Plugin's manifest", () => {
  it.each(table.grant)("grants %j, as the core does", (p) => {
    expect(manifestProblem(manifest([p]))).toBeNull();
  });

  it.each(table.refuse)("refuses %j, as the core does", (p) => {
    expect(manifestProblem(manifest([p]))).toMatch(/^roster-plugin\.lua: permissions: /);
  });

  it("flags every serve method that isn't a read, as the core does", () => {
    const methods = table.grant.filter((p) => p.startsWith("serve:"));
    const flagged = described(manifest(methods)).permissions.filter((p) => p.risk).map((p) => p.name.slice(6));
    expect(flagged).toEqual(methods.map((m) => m.slice(6)).filter((m) => !table.serve_reads.includes(m)));
  });

  it.each(Object.entries(table.network))("sums up and flags %j as the core does", (p, want) => {
    expect(described(manifest([p])).permissions[0]).toEqual({ name: p, ...want });
  });

  it("flags every network site", () => {
    const sites = table.grant.filter((p) => p.startsWith("network:"));
    expect(sites.every((p) => described(manifest([p])).permissions[0]?.risk?.startsWith("Can send data to "))).toBe(true);
  });

  it.each(table.refuse_together)("refuses %j in one manifest, as the core does", (...sites) => {
    expect(manifestProblem(manifest(sites))).toMatch(/^roster-plugin\.lua: permissions: "network:/);
  });

  it.each(table.grant_together)("grants %j in one manifest, as the core does", (...sites) => {
    expect(manifestProblem(manifest(sites))).toBeNull();
  });
});

describe("a fake Plugin's roster.serve.request (decision Q103)", () => {
  const asker: FakePlugin = {
    manifest: { ...manifest(["serve:hosts.list", "serve:discover.start"]), name: "asker" },
    load(roster) {
      roster.commands.add("ask", {
        run: () => {
          roster.serve?.request("hosts.list", {}, (r, err) => {
            roster.notify(r ? `hosts ${(r as { hosts: unknown[] }).hosts.length}` : `failed: ${err}`);
            // The answer to the user's call is part of it, once.
            roster.confirm({ title: "Scan?", run: () => undefined });
            roster.serve?.request("discover.start", {}, () => {
              let asked = true;
              try {
                roster.confirm({ title: "Again?", run: () => undefined });
              } catch {
                asked = false;
              }
              roster.notify(asked ? "asked again" : "didn't ask again");
            });
          });
          roster.serve?.request("discover.plan" as string, {}, () => undefined);
        },
      });
    },
  };

  it("answers later, through the replies nobody asked for, as the core does", async () => {
    const serve = (method: string) => {
      if (method === "hosts.list") return { hosts: [{ name: "esx-02" }] };
      if (method === "discover.start") return { scan: "scan-1" };
      throw new BackendCallError(`unknown method '${method}'`, -32601);
    };
    const host = fakePluginHost({ asker }, () => [], undefined, serve);
    const loaded = await host.pluginLoad("asker", ["serve:hosts.list", "serve:discover.start"]);
    const run = (loaded.reply.ops[0] as { run: { handler: number } }).run.handler;
    const replies: PluginReply[] = [];
    host.onPluginReply((r) => replies.push(r));
    const asked = await host.pluginCall("asker", run, { args: "", words: [] });
    // Not granted: refused at once, as the core does.
    expect(asked.error?.message).toBe("roster.serve.request: not granted (serve:discover.plan)");
    await host.pluginSettled("asker");
    expect(replies.map((r) => r.ops.map((o) => (o as { op: string }).op))).toEqual([["notify", "confirm"], ["notify"]]);
    expect(replies[1]?.ops[0]).toMatchObject({ text: "didn't ask again" });
  });
});

describe("what a fake Plugin gets has its cmd:/env: Login references cut (decision Q92)", () => {
  // Everything the Plugin sees goes into one notice, so a reference that leaks shows up in it.
  const seen: string[] = [];
  const watcher: FakePlugin = {
    manifest: {
      ...manifest(["inventory.read", "serve:changes.diff", "serve:host.check", "serve:host.check_job", "serve:mesh.status"]),
      name: "watcher",
    },
    load(roster) {
      roster.on("job_progress", (job) => seen.push(JSON.stringify(job)));
      roster.commands.add("look", {
        run: () => {
          seen.push(JSON.stringify(roster.inventory?.hosts()), JSON.stringify(roster.inventory?.host("esx-02")));
          roster.inventory?.request((list) => seen.push(JSON.stringify(list)));
          seen.push(JSON.stringify(roster.serve?.call("changes.diff")));
          try {
            roster.serve?.call("host.check", { host: "esx-02" });
          } catch (e) {
            // All of it: the message, a cause, any other field.
            const err = e as Error;
            seen.push(err.message, String(err.cause), JSON.stringify(err, Object.getOwnPropertyNames(err)));
          }
          roster.serve?.request("changes.diff", {}, (r) => seen.push(JSON.stringify(r)));
          roster.serve?.request("host.check", { host: "esx-02" }, (_r, err) => seen.push(String(err)));
        },
      });
    },
  };
  const host: Host = {
    name: "esx-02",
    group: "lab",
    ip: "10.0.0.5",
    type: "esxi",
    product: "",
    title: "",
    description: "",
    reviewed: true,
    enroll: false,
    ssh: { user: "root", port: 22, auth: "cmd:pass show lab/esx-02" },
    web: null,
    login: { user: "admin", auth: "env:LAB_PW" },
    services: {
      web: { port: 443, url: "https://10.0.0.5", scheme: "https", user: null, auth: "bw:esx-02 web", verify: true, login: "cmd:printf hunter2", override: true },
    },
  };
  const serve = (method: string) => {
    if (method === "changes.diff") return { diff: '-    auth: "cmd:pass show old"\n+    auth: env:NEW_PW\n' };
    throw new BackendCallError("cmd:pass show lab/esx-02 resolves to no item", 31);
  };

  it("in Hosts, serve's answers and errors, and serve's job_progress", async () => {
    seen.length = 0;
    const plugins = fakePluginHost({ watcher }, () => [host], undefined, serve);
    const loaded = await plugins.pluginLoad("watcher", watcher.manifest.permissions);
    const look = (loaded.reply.ops.find((o) => (o as { op: string }).op === "command") as { run: { handler: number } }).run.handler;
    const r = await plugins.pluginCall("watcher", look, { args: "", words: [] }, true);
    expect(r.error).toBeNull();
    await plugins.pluginSettled("watcher");
    await plugins.pluginEvent("job_progress", { kind: "check", job: "check-1", state: "failed", error: "auth env:LAB_PW is unset" });
    const all = seen.join("\n");
    expect(all).not.toMatch(/pass show|LAB_PW|NEW_PW|hunter2/);
    // Cut to their kind, the rest kept.
    expect(all).toContain('"auth":"cmd:"');
    expect(all).toContain('"auth":"env:"');
    expect(all).toContain("bw:esx-02 web");
    expect(all).toContain("roster.serve.call host.check: cmd: (code 31)");
    expect(all).toContain("roster.serve.request host.check: cmd: (code 31)");
    expect(seen).toHaveLength(10);
  });
});

describe("a fake Plugin's roster.cmd and roster's own commands (issue #184)", () => {
  const probe: FakePlugin = {
    manifest: { ...manifest([]), name: "probe" },
    load(roster) {
      for (const name of ["late", "publish", "mine"]) roster.commands.add(name, { run: () => undefined });
      roster.commands.add("try", {
        run: (a: { args: string }) => {
          try {
            roster.cmd(a.args);
            roster.notify("ran");
          } catch (e) {
            roster.notify((e as Error).message);
          }
        },
      });
    },
  };

  it("runs its own command unless a built-in the call carries has the name, as the core does", async () => {
    const host = fakePluginHost({ probe }, () => []);
    const loaded = await host.pluginLoad("probe", [], null, []);
    const tryIt = (loaded.reply.ops as { op: string; name?: string; run?: { handler: number } }[]).find((o) => o.op === "command" && o.name === "try")?.run?.handler ?? 0;
    const said = async (line: string, builtins: string[]) => {
      const r = await host.pluginCall("probe", tryIt, { args: line, words: [line] }, true, builtins);
      return (r.ops.find((o) => (o as { op: string }).op === "notify") as { text: string } | undefined)?.text;
    };
    expect(await said("mine", [])).toBe("ran");
    expect(await said("publish", [])).toMatch(/isn't one a Plugin may run/);
    expect(await said("late", ["late"])).toMatch(/isn't one a Plugin may run/);
    expect(await said("mine", ["late"])).toBe("ran");
  });
});

describe("a fake Plugin's collections on api 5, as the core's (decision Q134, #262)", () => {
  /** Loads `body` as a Plugin written for `api`; gives its reply. */
  const load = async (api: number, body: (roster: Parameters<FakePlugin["load"]>[0]) => void) => {
    const p: FakePlugin = { manifest: { ...manifest([]), name: "t", api }, load: body };
    return (await fakePluginHost({ t: p }, () => []).pluginLoad("t", [])).reply;
  };

  it.each([
    ["commands", "command"],
    ["sidebar", "Sidebar section"],
    ["status", "status segment"],
    ["finders", "finder"],
    ["help", "help page"],
    ["health", "`:check` section"],
    ["tutor", "tutorial"],
    ["toolbar", "toolbar control"],
    ["progress", "progress"],
    ["views", "view"],
    ["details", "Host-details section"],
  ] as const)("roster.%s.remove of what it never added is an error", async (module, noun) => {
    const reply = await load(5, (roster) => (roster[module] as { remove(id: string): void }).remove("x"));
    expect(reply.error?.message).toBe(`roster.${module}.remove: the Plugin has no ${noun} "x" (roster.${module}.list() names its own)`);
    expect(reply.ops).toEqual([]);
  });

  it("errors on a missing Theme, binding, view, badge and key context as the core does", async () => {
    const cases: [(r: Parameters<FakePlugin["load"]>[0]) => void, string][] = [
      [(r) => r.themes.remove("dusk"), 'roster.themes.remove: the Plugin has no Theme "dusk" (roster.themes.list() names its own; roster.themes.define adds one)'],
      [(r) => r.keymap.del("leader", "w w"), 'roster.keymap.del: the Plugin binds no "w w" in leader (a Plugin takes off only its own bindings)'],
      [(r) => r.keymap.set("leader", "w w", false), 'roster.keymap.set: the Plugin binds no "w w" in leader (a Plugin takes off only its own bindings)'],
      [(r) => r.keymap.set("leadr", "w w", "alerts"), 'roster.keymap.set: "leadr" isn\'t a key context (a Plugin binds keys in leader, list or list_vim)'],
      [(r) => r.views.update("x", { title: "X" }), 'roster.views.update: the Plugin has no view "x" (roster.views.list() names its own)'],
      [(r) => r.views.close("x"), 'roster.views.close: the Plugin has no view "x" (roster.views.list() names its own)'],
      [(r) => r.badges.remove("esx-02"), 'roster.badges.remove: the Plugin has no badge on "esx-02" (roster.badges.list() names its Hosts)'],
      [(r) => r.badges.set("esx-02", null), 'roster.badges.set: the Plugin has no badge on "esx-02" (roster.badges.list() names its Hosts)'],
    ];
    for (const [body, message] of cases) expect((await load(5, body)).error?.message).toBe(message);
  });

  it("keeps the quiet removals for a Plugin written for api 4", async () => {
    const reply = await load(4, (roster) => {
      roster.themes.remove("dusk");
      roster.keymap.del("leader", "w w");
      roster.status.remove("x");
      roster.views.close("x");
      roster.badges.remove("esx-02");
    });
    expect(reply.error).toBeNull();
    expect(reply.ops).toEqual([
      { op: "remove", kind: "theme", id: "dusk" },
      { op: "key", context: "leader", keys: "w w", action: false },
      { op: "remove", kind: "status", id: "x" },
      { op: "view_close", id: "x" },
      { op: "badge", host: "esx-02", text: null },
    ]);
  });

  it("says what the Plugin has, as copies", async () => {
    let out: unknown[] = [];
    const reply = await load(5, (roster) => {
      const spec = { text: "3 alerts" };
      roster.status.set("alerts", spec);
      spec.text = "changed after";
      (roster.status.get("alerts") as { text: string }).text = "changed the copy";
      roster.sidebar.set("b", { title: "B" });
      roster.sidebar.set("a", { title: "A" });
      roster.themes.define("dusk", { appearance: "dark" });
      roster.keymap.set("leader", "w w", "alerts");
      const run = () => undefined;
      roster.commands.add("alerts", { desc: "Alerts", run });
      roster.views.set("v", { title: "V" });
      roster.details.set("d", "esx-02", { title: "D" });
      roster.details.set("d", "esx-03", { title: "E" });
      roster.badges.set("esx-02", "2");
      roster.keymap.list("leader")["w w"] = "changed";
      out = [
        (roster.status.get("alerts") as { text: string }).text,
        roster.status.has("alerts"),
        roster.status.get("nope"),
        roster.sidebar.list(),
        roster.themes.list(),
        roster.themes.has("dusk"),
        roster.keymap.get("leader", "w w"),
        roster.keymap.has("leader", "x"),
        roster.keymap.list("leader"),
        (roster.commands.get("alerts") as { run: unknown }).run === run,
        roster.commands.list(),
        roster.views.list(),
        roster.views.has("v"),
        roster.details.list(),
        roster.details.list("d"),
        (roster.details.get("d", "esx-03") as { title: string }).title,
        roster.details.has("d"),
        roster.details.has("d", "esx-09"),
        roster.badges.list(),
        roster.badges.get("esx-02"),
        roster.badges.has("esx-03"),
      ];
    });
    expect(reply.error).toBeNull();
    expect(out).toEqual([
      "3 alerts", true, null, ["a", "b"], ["dusk"], true, "alerts", false, { "w w": "alerts" }, true, ["alerts"], ["v"], true,
      ["d"], ["esx-02", "esx-03"], "E", true, false, ["esx-02"], "2", false,
    ]);
  });

  it("a failed call adds nothing", async () => {
    const p: FakePlugin = {
      manifest: { ...manifest([]), name: "t", api: 5 },
      load(roster) {
        roster.status.set("kept", { text: "x" });
        roster.commands.add("boom", {
          run: () => {
            roster.status.set("gone", { text: "x" });
            roster.status.remove("kept");
            throw new Error("no");
          },
        });
        roster.commands.add("check", { run: () => `${roster.status.has("gone")} ${roster.status.has("kept")}` });
      },
    };
    const host = fakePluginHost({ t: p }, () => []);
    const { reply } = await host.pluginLoad("t", []);
    const handler = (name: string) => (reply.ops.find((o) => (o as { name?: string }).name === name) as { run: { handler: number } }).run.handler;
    expect((await host.pluginCall("t", handler("boom"), {})).error).not.toBeNull();
    expect((await host.pluginCall("t", handler("check"), {})).result).toBe("false true");
  });
});
