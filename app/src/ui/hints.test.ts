// Hiding the keycap hints (iteration 3 feedback): `ui.hints` in init.lua, else `:hints on|off|toggle`,
// whose choice the State keeps, as `:theme`'s is (decision Q51).
import { describe, expect, it } from "vitest";
import { memoryPlatform } from "../platform/memory";
import { builtinRegistries } from "../registries";
import { StateStore } from "../state/store";
import { HintsChoice, registerHints } from "./hints";
import { quiet, type Message } from "./messages";

async function setup(state: Record<string, unknown> = {}) {
  const platform = memoryPlatform({ state });
  const store = new StateStore(platform);
  await store.load();
  const registries = builtinRegistries();
  const choice = new HintsChoice(store);
  registerHints(registries, choice);
  const said: Message[] = [];
  const run = (arg: string | undefined) => registries.commands.get("hints")?.run({ say: (m: Message) => said.push(m) } as never, arg);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { platform, choice, registries, run, said, flush };
}

describe("HintsChoice", () => {
  it("shows hints by default", async () => {
    const { choice } = await setup();
    expect(choice.shown()).toBe(true);
  });

  it(":hints off / on / toggle keep the choice in the State", async () => {
    const { choice, run, platform, flush, said } = await setup({ version: 1, other: 1 });
    run("off");
    expect(choice.shown()).toBe(false);
    run("toggle");
    expect(choice.shown()).toBe(true);
    run(undefined); // no argument toggles too
    expect(choice.shown()).toBe(false);
    run("on");
    expect(choice.shown()).toBe(true);
    await flush();
    expect(platform.saved()).toMatchObject({ hints: true, other: 1 });
    // The new state is quiet (ticket 111): shown with every message on, always said to a screen reader.
    expect(said).toEqual([quiet("Key hints hidden"), quiet("Key hints shown"), quiet("Key hints hidden"), quiet("Key hints shown")]);
  });

  it("refuses a word it doesn't know", async () => {
    const { choice, run, said } = await setup();
    run("maybe");
    expect(said).toEqual(["hints takes on, off or toggle"]);
    expect(choice.shown()).toBe(true);
  });

  it("lets init.lua's ui.hints win, and says where to change it", async () => {
    const { choice, run, said } = await setup({ hints: false });
    expect(choice.shown()).toBe(false);
    choice.setConfig(true);
    expect(choice.shown()).toBe(true);
    run("off");
    expect(choice.shown()).toBe(true);
    expect(said).toEqual(["Key hints are set in init.lua (ui.hints = true). Change them there."]);
  });

  it("completes on, off and toggle", async () => {
    const { registries } = await setup();
    const hints = registries.commands.get("hints");
    expect(hints?.complete?.("", [])).toEqual(["on", "off", "toggle"]);
    expect(hints?.complete?.("o", [])).toEqual(["on", "off"]);
  });
});
