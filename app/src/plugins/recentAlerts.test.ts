// Ticket 56: the fake Backend's stand-in for examples/plugins/recent-alerts does what the real Lua
// does. crates/roster-core/tests/recent_alerts.rs runs the Lua through a scripted run and records
// every op (recent-alerts.transcript.json); this replays the same steps against the stand-in and
// compares, and checks every op the real Lua sent passes the frontend's checks (ops.ts). So the UI
// tests that use the stand-in test the real Plugin's behaviour.
import { describe, expect, it } from "vitest";
import { makeHosts } from "../backend/fake";
import { fakePluginHost } from "../backend/fakePlugins";
import { recentAlerts } from "../backend/fakeRecentAlerts";
import type { PluginEventName, PluginReply } from "../backend/types";
import { parseOp } from "./ops";
import transcript from "./recent-alerts.transcript.json";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Step = { do: string; ops: Json[] } & Record<string, Json>;

const steps = transcript.steps as unknown as Step[];

/** As the Rust side writes them: functions as "fn", times and dates as placeholders, `{}` as `[]`. */
function normal(v: unknown): Json {
  if (Array.isArray(v)) return v.map(normal);
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && typeof o.handler === "number") return "fn";
    if (keys.length === 0) return [];
    // A timer's id is a handler's number, which the two sides count their own ways.
    const timer = o.op === "timer" || (o.op === "remove" && o.kind === "timer");
    return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, timer && k === "id" ? "N" : normal(o[k])]));
  }
  if (typeof v === "string") return v.replace(/\d{4}-\d{2}-\d{2}/g, "YYYY-MM-DD").replace(/\d{2}:\d{2}:\d{2}/g, "HH:MM:SS");
  return v as Json;
}

type Op = Record<string, unknown>;
const handlerOf = (run: unknown) => (run as { handler: number }).handler;

describe("the recent-alerts stand-in", () => {
  it("does what the real Lua did, step by step", async () => {
    let config: Record<string, unknown> = {};
    const host = fakePluginHost({}, () => makeHosts(2).hosts, (path) => (path === "recent-alerts" ? { plugin: recentAlerts(), config } : undefined));
    let section: Op | undefined;
    const commands = new Map<string, number>();
    const finders = new Map<string, Op>();
    let timer = -1;
    for (const step of steps) {
      let replies: PluginReply[];
      switch (step.do) {
        case "load":
          config = step.config as Record<string, unknown>;
          replies = [(await host.pluginLoad("recent-alerts", step.grants as string[])).reply];
          break;
        case "event":
          replies = await host.pluginEvent(step.name as PluginEventName, step.payload as Record<string, unknown>);
          break;
        case "action": {
          const rows = ((section?.spec as Op).rows ?? []) as Op[];
          const action = rows.flatMap((r) => r.actions as Op[]).find((a) => a.label === step.label);
          replies = [await host.pluginCall("recent-alerts", handlerOf(action?.run), {})];
          break;
        }
        case "command": {
          const args = step.args as string;
          replies = [await host.pluginCall("recent-alerts", commands.get(step.name as string) ?? -1, { args, words: args.split(/\s+/).filter(Boolean) })];
          break;
        }
        case "finder": {
          const items = (finders.get(step.id as string)?.spec as Op).items as Op[];
          replies = [await host.pluginCall("recent-alerts", handlerOf(items.find((i) => i.label === step.label)?.run), {})];
          break;
        }
        case "timer":
          replies = [await host.pluginCall("recent-alerts", timer, {})];
          break;
        default:
          throw new Error(`no step ${step.do}`);
      }
      const ops: unknown[] = [];
      for (const r of replies) {
        expect(r.error, JSON.stringify(step)).toBeNull();
        for (const op of r.ops as Op[]) {
          if (op.op === "section") section = op;
          if (op.op === "command") commands.set(op.name as string, handlerOf(op.run));
          if (op.op === "finder") finders.set(op.id as string, op);
          if (op.op === "timer") timer = handlerOf(op.run);
          ops.push(op);
        }
      }
      expect(normal(ops), `${step.do} ${JSON.stringify(step.label ?? step.name ?? step.args ?? "")}`).toEqual(step.ops);
    }
  });

  it("every op the real Lua sent passes the frontend's checks", () => {
    for (const step of steps) {
      for (const op of step.ops) {
        // The transcript writes functions as "fn": put a handler back for the check.
        const raw = JSON.parse(JSON.stringify(op).replaceAll('"fn"', '{"handler":1}')) as unknown;
        expect(parseOp(raw), JSON.stringify(op)).not.toHaveProperty("invalid");
      }
    }
  });
});
