// Ticket 50: the fake Backend's stand-in for plugins/mesh does what the real Lua does.
// crates/roster-core/tests/plugin_mesh.rs runs the Lua through a scripted run and records every op
// and every roster serve call with its answer (mesh.transcript.json); this replays the same steps
// against the stand-in, answering its serve calls from the recording (and checking it makes the
// same ones), and checks every op the real Lua sent passes the frontend's checks (ops.ts). So the
// UI tests that use the stand-in test the real Plugin's behaviour. Each step has the call's own ops
// and then each answer's: what the Plugin did when its roster serve requests answered (Q103).
import { describe, expect, it } from "vitest";
import { makeHosts } from "../backend/fake";
import { meshPlugin, words } from "../backend/fakeMesh";
import { fakePluginHost } from "../backend/fakePlugins";
import type { PluginEventName, PluginReply } from "../backend/types";
import transcript from "./mesh.transcript.json";
import { parseOp } from "./ops";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Call = { method: string; params: Json; result?: Json; error?: string };
type Step = { do: string; ops: Json[]; answers: Json[][]; serve: Call[] } & Record<string, Json>;

const steps = transcript.steps as unknown as Step[];

/** As the Rust side writes them: functions as "fn", a timer's id as "N", times as HH:MM:SS, `{}` as `[]`. */
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
  if (typeof v === "string") return v.replace(/\d{2}:\d{2}:\d{2}/g, "HH:MM:SS");
  return v as Json;
}

type Op = Record<string, unknown>;
const handlerOf = (run: unknown) => (run as { handler: number }).handler;

describe("the Mesh controls stand-in", () => {
  it("does what the real Lua did, step by step, with the same roster serve calls", async () => {
    let expected: Call[] = [];
    const serve = (method: string, params: Record<string, unknown>) => {
      const next = expected.shift();
      expect(next, `an unexpected ${method}`).toBeDefined();
      expect({ method, params }).toEqual({ method: next?.method, params: next?.params });
      if (next?.error !== undefined) throw new Error(next.error);
      return next?.result ?? null;
    };
    const host = fakePluginHost({ mesh: meshPlugin() }, () => makeHosts(2).hosts, undefined, serve);
    const answered: PluginReply[] = [];
    host.onPluginReply((r) => answered.push(r));
    const all: Op[] = [];
    const last = (f: (o: Op) => boolean) => [...all].reverse().find(f);
    for (const step of steps) {
      expected = [...step.serve];
      let replies: PluginReply[];
      switch (step.do) {
        case "load":
          replies = [(await host.pluginLoad("mesh", step.grants as string[])).reply];
          break;
        case "timer": {
          const t = last((o) => o.op === "timer");
          replies = [await host.pluginCall("mesh", handlerOf(t?.run), {})];
          break;
        }
        case "command": {
          const args = step.args as string;
          const c = last((o) => o.op === "command" && o.name === "mesh");
          replies = [await host.pluginCall("mesh", handlerOf(c?.run), { args, words: args.split(/\s+/).filter(Boolean) })];
          break;
        }
        case "action": {
          const v = last((o) => o.op === "view" && o.id === step.view);
          const table = (v?.spec as Op).table as Op;
          const action = (table.actions as Op[]).find((a) => a.label === step.label);
          const row = (table.rows as Op[]).find((r) => r.id === step.row);
          replies = [await host.pluginCall("mesh", handlerOf(action?.run), { row: step.row, host: row?.host ?? null, view: step.view })];
          break;
        }
        case "confirm": {
          const q = last((o) => o.op === "confirm");
          replies = [await host.pluginCall("mesh", handlerOf((q?.spec as Op).run), { confirm: "yes" })];
          break;
        }
        case "event":
          replies = await host.pluginEvent(step.name as PluginEventName, {});
          break;
        case "push":
          // serve's job.progress, as the app hands it to the Plugins (API 20).
          replies = await host.pluginEvent("job_progress", step.payload as Record<string, unknown>);
          break;
        default:
          throw new Error(`no step ${step.do}`);
      }
      const ops: unknown[] = [];
      for (const r of replies) {
        expect(r.error, JSON.stringify(step)).toBeNull();
        for (const op of r.ops as Op[]) {
          all.push(op);
          ops.push(op);
        }
      }
      const name = `${step.do} ${JSON.stringify(step.label ?? step.args ?? "")}`;
      expect(normal(ops), name).toEqual(step.ops);
      await host.pluginSettled("mesh");
      const answers = answered.splice(0);
      for (const r of answers) {
        expect(r.error, `${name}: an answer`).toBeNull();
        all.push(...(r.ops as Op[]));
      }
      expect(answers.map((r) => normal(r.ops)), `${name}: the answers`).toEqual(step.answers);
      expect(expected, `${name}: serve calls it didn't make`).toEqual([]);
    }
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

describe("the Mesh controls' words", () => {
  it("count with thousands, as the Lua does", () => {
    expect(words.count(249501)).toBe("249,501");
    expect(words.plural(1, "Host", "Hosts")).toBe("1 Host");
    expect(words.reach(7)).toBe("can reach 7 Hosts");
  });

  it("give a row an id that fits, or its place", () => {
    expect(words.id("esx-02", 3)).toBe("esx-02");
    expect(words.id("x".repeat(101), 3)).toBe("#3");
  });

  it("take the function's name off serve's error", () => {
    expect(words.clean(new Error("roster.serve.call mesh.job: unknown method 'mesh.job' (code -32601)"))).toBe("unknown method 'mesh.job' (code -32601)");
    expect(words.clean("roster.serve.request mesh.job: unknown method 'mesh.job' (code -32601)")).toBe("unknown method 'mesh.job' (code -32601)");
  });
});
