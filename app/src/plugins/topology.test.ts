// Ticket 40: the fake Backend's stand-in for plugins/topology does what the real Lua does.
// crates/roster-core/tests/plugin_topology.rs runs the Lua through a scripted run against a made-up
// network and records every op, with the roster serve answers it was given
// (topology.transcript.json); this replays the same steps against the stand-in with the same
// answers and compares, and checks every op the real Lua sent passes the frontend's checks (ops.ts).
import { describe, expect, it } from "vitest";
import { fakePluginHost } from "../backend/fakePlugins";
import { topologyPlugin } from "../backend/fakeTopology";
import type { Host, PluginEventName, PluginReply } from "../backend/types";
import { parseOp } from "./ops";
import transcript from "./topology.transcript.json";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Step = { do: string; ops: Json[] } & Record<string, Json>;

const steps = transcript.steps as unknown as Step[];
const answers = transcript.serve as unknown as Record<string, Record<string, unknown>>;

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

type Op = Record<string, unknown>;
const handlerOf = (run: unknown) => (run as { handler: number }).handler;

describe("the Topology stand-in", () => {
  it("does what the real Lua did, step by step", async () => {
    const hosts = (answers["hosts.list"] as { hosts: Host[] }).hosts;
    const serve = (method: string, params: Record<string, unknown>) => {
      if (method === "mesh.status" && params.grouped === true) return answers["mesh.status"];
      if (method === "mesh.cut" && params.background === true) return answers["mesh.cut"];
      if (method === "mesh.job") return answers["mesh.job"];
      if (method === "host.check_job") return answers["host.check_job"];
      throw new Error(`unknown method '${method}' (code -32601)`);
    };
    const host = fakePluginHost({ topology: topologyPlugin() }, () => hosts, undefined, serve);
    // What the Plugin did when its roster serve requests answered: part of the step, as the Rust
    // side records it.
    const answered: PluginReply[] = [];
    host.onPluginReply((r) => answered.push(r));
    const settle = async (r: PluginReply): Promise<PluginReply> => {
      await host.pluginSettled("topology");
      const more = answered.splice(0);
      for (const a of more) expect(a.error).toBeNull();
      return { ...r, ops: [...r.ops, ...more.flatMap((a) => a.ops)] };
    };
    let view: Op | undefined;
    const commands = new Map<string, number>();
    let confirm = -1;
    let health = -1;
    let timer = -1;
    let cutTimer = -1;
    for (const step of steps) {
      let replies: PluginReply[];
      switch (step.do) {
        case "load": {
          const loaded = (await host.pluginLoad("topology", step.grants as string[])).reply;
          // As the app's clock: the deferred first look, 50 ms later.
          const first = (loaded.ops as Op[]).find((o) => o.op === "timer" && o.every === false);
          const later = await settle(await host.pluginCall("topology", handlerOf(first?.run), {}));
          replies = [{ ...loaded, ops: [...loaded.ops, ...later.ops] }];
          timer = -1;
          break;
        }
        case "event": {
          replies = await Promise.all((await host.pluginEvent(step.name as PluginEventName, step.payload as Record<string, unknown>)).map(settle));
          // An event it only asked serve about (a job's end) has no reply of its own: its answers'.
          if (replies.length === 0) {
            const answer = await settle({ plugin: "topology", result: null, ops: [], error: null, disabled: null });
            if (answer.ops.length > 0) replies = [answer];
          }
          break;
        }
        case "sessions":
          await host.pluginSessions((step.open as [number, string | null][]).map(([session, h]) => ({ session, host: h })));
          replies = [];
          break;
        case "action": {
          const action = ((view?.spec as Op).graph as { actions: Op[] }).actions.find((a) => a.label === step.label);
          replies = [await settle(await host.pluginCall("topology", handlerOf(action?.run), { view: "topology", node: step.node, host: step.node }))];
          break;
        }
        case "confirm":
          replies = [await settle(await host.pluginCall("topology", confirm, { confirm: "yes" }))];
          break;
        case "cut-timer":
          replies = [await settle(await host.pluginCall("topology", cutTimer, {}))];
          break;
        case "command": {
          const args = step.args as string;
          replies = [await settle(await host.pluginCall("topology", commands.get(step.name as string) ?? -1, { args, words: args.split(/\s+/).filter(Boolean) }))];
          break;
        }
        case "health": {
          const r = await settle(await host.pluginCall("topology", health, {}));
          expect(normal(r.result)).toEqual(step.result);
          replies = [r];
          break;
        }
        case "timer":
          replies = [await settle(await host.pluginCall("topology", timer, {}))];
          break;
        default:
          throw new Error(`no step ${step.do}`);
      }
      const ops: unknown[] = [];
      for (const r of replies) {
        expect(r.error, JSON.stringify(step)).toBeNull();
        for (const op of r.ops as Op[]) {
          if (op.op === "view") view = op;
          if (op.op === "command") commands.set(op.name as string, handlerOf(op.run));
          if (op.op === "confirm") confirm = handlerOf((op.spec as Op).run);
          if (op.op === "health") health = handlerOf((op.spec as Op).check);
          if (op.op === "timer" && op.every === true) {
            if (timer < 0) timer = handlerOf(op.run);
            else cutTimer = handlerOf(op.run);
          }
          ops.push(op);
        }
      }
      expect(normal(ops), `${step.do} ${JSON.stringify(step.label ?? step.name ?? step.args ?? "")}`).toEqual(step.ops);
    }
  });

  it("every op the real Lua sent passes the frontend's checks", () => {
    for (const step of steps) {
      for (const op of step.ops) {
        const raw = JSON.parse(JSON.stringify(op).replaceAll('"fn"', '{"handler":1}')) as unknown;
        expect(parseOp(raw), JSON.stringify(op)).not.toHaveProperty("invalid");
      }
    }
  });
});
