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

  it("runs its own command only once the app has said its built-ins, and none has the name, as the core does", async () => {
    const host = fakePluginHost({ probe }, () => []);
    const loaded = await host.pluginLoad("probe", []);
    const tryIt = (loaded.reply.ops as { op: string; name?: string; run?: { handler: number } }[]).find((o) => o.op === "command" && o.name === "try")?.run?.handler ?? 0;
    const said = async (line: string) => {
      const r = await host.pluginCall("probe", tryIt, { args: line, words: [line] }, true);
      return (r.ops.find((o) => (o as { op: string }).op === "notify") as { text: string } | undefined)?.text;
    };
    // Before the app has said: none of its own, and the ones that change trust or writes as ever.
    expect(await said("mine")).toBe("roster.cmd: :mine can't run yet: the app hasn't told roster its own commands");
    expect(await said("publish")).toMatch(/isn't one a Plugin may run/);
    await host.pluginBuiltins(["late"]);
    expect(await said("late")).toMatch(/isn't one a Plugin may run/);
    expect(await said("mine")).toBe("ran");
  });
});
