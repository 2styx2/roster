import { describe, expect, it } from "vitest";
import { defaultConfig } from "../config/fixture";
import { HelpView, registerHelp } from "../help/command";
import { plain, type Block } from "../help/doc";
import { helpContext, pageBody, type HelpContext } from "../help/pages";
import { defaultOptions, keymapOf } from "../keymap";
import { memoryPlatform } from "../platform/memory";
import { builtinRegistries } from "../registries";
import { StateStore } from "../state/store";
import demoInventory from "../../../crates/roster-core/tests/fixtures/demo-inventory.json";
import { demoHosts } from "./demo";
import { resumeAt, rosterTutorial, stepMatches, TutorProgress, TUTOR_KEY } from "./tutor";

const ev = (name: string, data: Record<string, string | null> = {}) => ({ name, data });

describe("a step's match", () => {
  it("needs the event's name and each field, ignoring case", () => {
    expect(stepMatches({ event: "session_open", host: "demo-01" }, ev("session_open", { host: "DEMO-01" }))).toBe(true);
    expect(stepMatches({ event: "session_open", host: "demo-01" }, ev("session_open", { host: "demo-02" }))).toBe(false);
    expect(stepMatches({ event: "session_open", host: "demo-01" }, ev("host_selected", { host: "demo-01" }))).toBe(false);
  });

  it('"*" wants the field there; "" wants it missing', () => {
    expect(stepMatches({ event: "command", id: "theme", arg: "*" }, ev("command", { id: "theme", arg: "nord" }))).toBe(true);
    expect(stepMatches({ event: "command", id: "theme", arg: "*" }, ev("command", { id: "theme" }))).toBe(false);
    expect(stepMatches({ event: "command", id: "config", arg: "" }, ev("command", { id: "config", arg: null }))).toBe(true);
    expect(stepMatches({ event: "command", id: "config", arg: "" }, ev("command", { id: "config", arg: "path" }))).toBe(false);
  });
});

describe("progress", () => {
  const progress = () => {
    const store = new StateStore(memoryPlatform());
    return { store, progress: new TutorProgress(store) };
  };

  it("an event ticks the steps it matches, once, and the State keeps them", () => {
    const { store, progress: p } = progress();
    expect(p.feed(rosterTutorial, ev("command", { id: "find" }))).toEqual(["picker"]);
    expect(p.feed(rosterTutorial, ev("command", { id: "find" }))).toEqual([]);
    expect(p.done("roster").has("picker")).toBe(true);
    expect(store.get(TUTOR_KEY)).toEqual({ roster: ["picker"] });
    p.reset("roster");
    expect(p.done("roster").size).toBe(0);
  });

  it("resumes at the first lesson with a step left", () => {
    expect(resumeAt(rosterTutorial, new Set())).toBeUndefined();
    expect(resumeAt(rosterTutorial, new Set(["picker", "session"]))).toBe("tutor#lesson-2");
    const all = new Set(rosterTutorial.lessons.flatMap((l) => l.steps.map((s) => s.id)));
    expect(resumeAt(rosterTutorial, all)).toBeUndefined();
  });

  it("reads a State it didn't write leniently", () => {
    const store = new StateStore(memoryPlatform());
    store.set(TUTOR_KEY, { roster: ["picker", 3, null] });
    expect([...new TutorProgress(store).done("roster")]).toEqual(["picker"]);
    store.set(TUTOR_KEY, "nonsense");
    expect(new TutorProgress(store).done("roster").size).toBe(0);
  });
});

describe("the tutor page", () => {
  function ctx(done: string[], running: string | null = null): HelpContext {
    const r = builtinRegistries();
    registerHelp(r, new HelpView());
    return helpContext(r, {
      keymap: keymapOf(r.keymap.list()),
      options: defaultOptions,
      config: defaultConfig,
      configPath: null,
      state: {},
      activeTheme: "roster-dark",
      tutor: { done: () => new Set(done), running },
    });
  }
  const steps = (blocks: Block[]) => blocks.filter((b): b is Extract<Block, { t: "step" }> => b.t === "step");

  it("is `:help tutor`, with a lesson index and each step ticked or not", () => {
    const body = pageBody(ctx(["picker"]), "tutor");
    expect(body[0]?.t === "h" && plain(body[0].text)).toBe("roster tutor");
    const index = body.find((b) => b.t === "list");
    expect(index?.t === "list" && plain(index.items[0] ?? [])).toBe("Lesson 1: Find a Host · 1 of 2 done");
    expect(steps(body).map((s) => [s.id, s.done]).slice(0, 2)).toEqual([
      ["picker", true],
      ["session", false],
    ]);
  });

  it("shows the keys bound now", () => {
    const first = steps(pageBody(ctx([]), "tutor"))[0];
    expect(first?.text).toContainEqual({ t: "keys", keys: "␣ f" });
  });

  it("says how to start outside the demo, and where you are inside it", () => {
    expect(pageBody(ctx([]), "tutor").map((b) => (b.t === "p" ? plain(b.text) : "")).join(" ")).toMatch(/:tutor starts it on a demo Inventory/);
    expect(pageBody(ctx([], "roster"), "tutor").map((b) => (b.t === "p" ? plain(b.text) : "")).join(" ")).toMatch(/You're on the demo Inventory/);
  });
});

describe("the demo Inventory", () => {
  it("is the one the core's tests teach Plugins' tutorials on (crates/roster-core/tests/fixtures/demo-inventory.json)", () => {
    expect(demoHosts()).toEqual(demoInventory);
  });
});
