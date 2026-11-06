import { describe, expect, it } from "vitest";
import { defaultKeymap, defaultOptions, resolveKeymap } from "../keymap";
import { press, terminalMode, type KeyState } from "./mode";

const stays = new Set(["down", "up", "top", "bottom"]);
const ctx = { keymap: defaultKeymap, leader: defaultOptions.leader, vim: true, staysInAppMode: (l: string) => stays.has(l) };

/** Presses each chord in turn; returns the final state and every action that fired. */
function run(chords: string[], c = ctx, start: KeyState = terminalMode) {
  let state = start;
  const actions: string[] = [];
  const consumed: boolean[] = [];
  for (const chord of chords) {
    const r = press(state, chord, c);
    state = r.state;
    if (r.action) actions.push(r.action);
    consumed.push(r.consumed);
  }
  return { state, actions, consumed };
}

describe("press (Terminal mode / App mode)", () => {
  it("lets an unbound Tab or Shift+Tab move focus in App mode, as everywhere else", () => {
    const app = press(terminalMode, ctx.leader, ctx).state;
    expect(press(app, "Tab", ctx).consumed).toBe(false);
    expect(press(app, "Shift+Tab", ctx).consumed).toBe(false);
  });

  it("catches a global key (F11) in Terminal mode too, and stays in Terminal mode", () => {
    const r = run(["F11", "x"]);
    expect(r.actions).toEqual(["focus"]);
    expect(r.consumed).toEqual([true, false]);
    expect(r.state.mode).toBe("terminal");
    const fromApp = run(["Ctrl+Space", "F11"]);
    expect(fromApp.actions).toEqual(["focus"]);
    expect(fromApp.state.mode).toBe("terminal");
  });

  it("leaves every key to the terminal in Terminal mode, except the Leader", () => {
    const r = run(["f", "Escape", "Ctrl+c"]);
    expect(r.consumed).toEqual([false, false, false]);
    expect(r.state.mode).toBe("terminal");
    expect(run(["Ctrl+Space"]).state.mode).toBe("app");
  });

  it("runs a Leader binding and goes back to the terminal", () => {
    const r = run(["Ctrl+Space", "]"]);
    expect(r.actions).toEqual(["next"]);
    expect(r.consumed).toEqual([true, true]);
    expect(r.state.mode).toBe("terminal");
  });

  it("waits for the rest of a sequence", () => {
    const half = run(["Ctrl+Space", "d"]);
    expect(half.actions).toEqual([]);
    expect(half.state).toEqual({ mode: "app", pending: ["d"] });
    expect(run(["Ctrl+Space", "d", "d"]).actions).toEqual(["close"]);
  });

  it("stays in App mode while moving in a list, until Esc", () => {
    const r = run(["Ctrl+Space", "j", "j", "k", "g", "g", "G"]);
    expect(r.actions).toEqual(["down", "down", "up", "top", "bottom"]);
    expect(r.state.mode).toBe("app");
    const back = run(["Escape"], ctx, r.state);
    expect(back.actions).toEqual(["terminal"]);
    expect(back.state.mode).toBe("terminal");
  });

  it("with vim off, j and k do nothing, but arrows still move", () => {
    const r = run(["Ctrl+Space", "j", "k", "ArrowDown"], { ...ctx, vim: false });
    expect(r.actions).toEqual(["down"]);
    expect(r.state.mode).toBe("app");
  });

  it("swallows an unbound key in App mode and forgets a half-typed sequence", () => {
    const r = run(["Ctrl+Space", "d", "x"]);
    expect(r.actions).toEqual([]);
    expect(r.consumed).toEqual([true, true, true]);
    expect(r.state).toEqual({ mode: "app", pending: [] });
  });

  it("uses whatever Leader and bindings it's given", () => {
    const c = { ...ctx, leader: "Ctrl+b", keymap: resolveKeymap({ leader: { n: "next" } }) };
    expect(run(["Ctrl+Space"], c).state.mode).toBe("terminal");
    expect(run(["Ctrl+b", "n"], c).actions).toEqual(["next"]);
  });
});
