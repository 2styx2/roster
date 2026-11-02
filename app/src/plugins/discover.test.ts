// Ticket 44: the fake Backend's stand-in for plugins/discover does what the real Lua does.
// crates/roster-core/tests/plugin_discover.rs runs the Lua through a scripted run against a
// stand-in roster serve and records every op and every serve call with its answer
// (discover.transcript.json); this replays the same steps against the stand-in, answering its
// serve calls from the recording (and checking it makes the same ones), compares the ops, and
// checks every op the real Lua sent passes the frontend's checks (ops.ts). Each step has the call's
// own ops and then each answer's: what the Plugin did when its roster serve requests answered (Q103).
import { describe, expect, it } from "vitest";
import { makeHosts } from "../backend/fake";
import { discoverPlugin, fakeDiscoverServe, smallNet } from "../backend/fakeDiscover";
import { fakePluginHost } from "../backend/fakePlugins";
import { BackendCallError, type PluginReply } from "../backend/types";
import { parseOp } from "./ops";
import transcript from "./discover.transcript.json";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Step = { do: string; ops: Json[]; answers: Json[][] } & Record<string, Json>;
type Op = Record<string, unknown>;

const steps = transcript.steps as unknown as Step[];
const recorded = transcript.serve as unknown as Json[][];

/** As the Rust side writes them: functions as "fn", a timer's id as "N", `{}` as `[]`. */
function normal(v: unknown): Json {
  if (Array.isArray(v)) return v.map(normal);
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined);
    if (keys.length === 1 && typeof o.handler === "number") return "fn";
    if (keys.length === 0) return [];
    const timer = o.op === "timer" || (o.op === "remove" && o.kind === "timer");
    return Object.fromEntries(keys.map((k) => [k, timer && k === "id" ? "N" : normal(o[k])]));
  }
  return v as Json;
}

const handlerOf = (run: unknown) => (run as { handler: number }).handler;

describe("the discover stand-in", () => {
  it("does what the real Lua did, step by step, with the same calls to roster serve", async () => {
    let config: Record<string, unknown> = {};
    let next = 0;
    const serve = (method: string, params: Record<string, unknown>) => {
      const [m, p, result, error] = recorded[next++] ?? [];
      expect([method, normal(params)], `serve call ${next}`).toEqual([m, normal(p)]);
      if (error !== undefined) {
        const code = /\(code (-?\d+)\)$/.exec(String(error));
        throw new BackendCallError(String(error).replace(/ \(code -?\d+\)$/, ""), code ? Number(code[1]) : null);
      }
      return result;
    };
    const host = fakePluginHost({}, () => makeHosts(2).hosts, (path) => (path === "discover" ? { plugin: discoverPlugin(), config } : undefined), serve);
    const answered: PluginReply[] = [];
    host.onPluginReply((r) => answered.push(r));
    let view: Op | undefined;
    let command = -1;
    let confirm = -1;
    let timer = -1;
    for (const step of steps) {
      let reply: PluginReply;
      switch (step.do) {
        case "load":
          config = step.config as Record<string, unknown>;
          reply = (await host.pluginLoad("discover", step.grants as string[])).reply;
          break;
        case "command": {
          const args = step.args as string;
          reply = await host.pluginCall("discover", command, { args, words: args.split(/\s+/).filter(Boolean) });
          break;
        }
        case "confirm":
          reply = await host.pluginCall("discover", confirm, {});
          break;
        case "timer":
          reply = await host.pluginCall("discover", timer, {});
          break;
        case "push": {
          // serve's job.progress, as the app hands it to the Plugins (API 20).
          const payload = { kind: "discover", job: "scan-1", action: "scan", state: step.state, done: step.done, total: 254, at: null };
          const [heard] = await host.pluginEvent("job_progress", payload);
          reply = heard ?? { plugin: "discover", result: null, ops: [], error: null, disabled: null };
          break;
        }
        case "action": {
          const actions = ((view?.spec as Op).table as Op).actions as Op[];
          const action = actions.find((a) => a.label === step.label);
          reply = await host.pluginCall("discover", handlerOf(action?.run), { row: step.row, view: "discover" });
          break;
        }
        default:
          throw new Error(`no step ${step.do}`);
      }
      expect(reply.error, JSON.stringify(step)).toBeNull();
      const name = `${step.do} ${JSON.stringify(step.label ?? step.args ?? "")}`;
      expect(normal(reply.ops), name).toEqual(step.ops);
      await host.pluginSettled("discover");
      const answers = answered.splice(0);
      for (const r of [reply, ...answers]) {
        expect(r.error, `${name}: an answer`).toBeNull();
        for (const op of r.ops as Op[]) {
          if (op.op === "view") view = op;
          if (op.op === "command") command = handlerOf(op.run);
          if (op.op === "confirm") confirm = handlerOf((op.spec as Op).run);
          if (op.op === "timer") timer = handlerOf(op.run);
        }
      }
      expect(answers.map((r) => normal(r.ops)), `${name}: the answers`).toEqual(step.answers);
    }
    expect(next).toBe(recorded.length);
  });

  it("every op the real Lua sent passes the frontend's checks", () => {
    for (const step of steps) {
      for (const op of [...step.ops, ...step.answers.flat()]) {
        const raw = JSON.parse(JSON.stringify(op).replaceAll('"fn"', '{"handler":1}')) as unknown;
        expect(parseOp(raw), JSON.stringify(op)).not.toHaveProperty("invalid");
      }
    }
  });
});

describe("the stand-in roster serve", () => {
  it("scans in steps, refuses a second scan and too many addresses, and adds what was found", () => {
    const serve = fakeDiscoverServe({ found: smallNet("esx-02"), step: 127 });
    expect(() => serve("discover.plan", { targets: ["10.0.0.0/19"] })).toThrow(/8,190 addresses/);
    expect(serve("discover.plan", { targets: ["10.0.0.0/19"], force: true })).toMatchObject({ addresses: 8190 });
    const started = serve("discover.start", { targets: ["10.0.0.0/24"] }) as { scan: string };
    expect(() => serve("discover.start", { targets: ["10.0.0.0/24"] })).toThrow(/going already/);
    expect(serve("discover.status", {})).toMatchObject({ state: "running", done: 0, count: 0 });
    const half = serve("discover.status", {}) as { count: number };
    expect(half).toMatchObject({ done: 127 });
    expect(serve("discover.status", { since: half.count })).toMatchObject({ state: "done", done: 254, count: 6 });
    expect(serve("discover.add", { scan: started.scan, addresses: ["10.0.0.7"] })).toMatchObject({ added: [{ address: "10.0.0.7", name: "appliance" }] });
    expect(() => serve("discover.add", { scan: started.scan, addresses: ["10.0.0.7"] })).toThrow(/Inventory already/);
  });
});
