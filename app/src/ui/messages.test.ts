// The message line, as Neovim's (ticket 111, decision Q115): quiet by default, so errors,
// warnings and answers show and a routine confirmation or a tip doesn't; `ui.messages = "all"` in
// init.lua, else `:messages all|quiet|toggle` (kept in the State), brings them back. `:messages`
// alone lists the recent ones, quiet ones too.
import { describe, expect, it } from "vitest";
import { memoryPlatform } from "../platform/memory";
import { builtinRegistries } from "../registries";
import { StateStore } from "../state/store";
import { MessageLog, MessagesChoice, logView, quiet, registerMessages, shownText, spokenText, type Message } from "./messages";

async function setup(state: Record<string, unknown> = {}) {
  const platform = memoryPlatform({ state });
  const store = new StateStore(platform);
  await store.load();
  const registries = builtinRegistries();
  const choice = new MessagesChoice(store);
  const log = new MessageLog();
  let opened = 0;
  registerMessages(registries, choice, log, () => opened++);
  const said: Message[] = [];
  const run = (arg: string | undefined) => registries.commands.get("messages")?.run({ say: (m: Message) => said.push(m) } as never, arg);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { platform, choice, log, registries, run, said, flush, opened: () => opened };
}

describe("MessagesChoice", () => {
  it("is quiet by default", async () => {
    const { choice } = await setup();
    expect(choice.all()).toBe(false);
    expect(choice.stored()).toBeNull();
  });

  it(":messages all / quiet / toggle keep the choice in the State, and always say so", async () => {
    const { choice, run, platform, flush, said } = await setup({ version: 1, other: 1 });
    run("all");
    expect(choice.all()).toBe(true);
    run("toggle");
    expect(choice.all()).toBe(false);
    run("toggle");
    expect(choice.all()).toBe(true);
    run("quiet");
    expect(choice.all()).toBe(false);
    await flush();
    expect(platform.saved()).toMatchObject({ messages: "quiet", other: 1 });
    // Its own answer is plain text: going quiet must still say it did.
    expect(said).toEqual([
      "Messages: all",
      "Messages: quiet (errors, warnings and answers only; :messages lists the rest)",
      "Messages: all",
      "Messages: quiet (errors, warnings and answers only; :messages lists the rest)",
    ]);
  });

  it("refuses a word it doesn't know", async () => {
    const { choice, run, said } = await setup();
    run("maybe");
    expect(said).toEqual(["messages takes all, quiet, toggle or clear (alone, it lists the recent ones)"]);
    expect(choice.all()).toBe(false);
  });

  it("lets init.lua's ui.messages win, and says where to change it", async () => {
    const { choice, run, said } = await setup({ messages: "quiet" });
    choice.setConfig("all");
    expect(choice.all()).toBe(true);
    run("quiet");
    expect(choice.all()).toBe(true);
    expect(said).toEqual(['Messages are set in init.lua (ui.messages = "all"). Change it there.']);
  });

  it("completes its words", async () => {
    const { registries } = await setup();
    expect(registries.commands.get("messages")?.complete?.("", [])).toEqual(["all", "quiet", "toggle", "clear"]);
  });
});

describe("a quiet message", () => {
  const sidebar = quiet("Sidebar hidden", "Sidebar hidden, and kept that way. modes.standard.sidebar = false in init.lua makes it the default");

  it("shows its whole text only with every message on", () => {
    expect(shownText(sidebar, true)).toBe("Sidebar hidden, and kept that way. modes.standard.sidebar = false in init.lua makes it the default");
    expect(shownText(sidebar, false)).toBe("");
  });

  it("still has its short form said to a screen reader when quiet", () => {
    expect(spokenText(sidebar, false)).toBe("Sidebar hidden");
    expect(spokenText(sidebar, true)).toBe("");
  });

  it("leaves an error, a warning or an answer alone", () => {
    expect(shownText("Couldn't pull: offline", false)).toBe("Couldn't pull: offline");
    expect(spokenText("Couldn't pull: offline", false)).toBe("");
  });

  it("is just its short form when there's nothing more to say", () => {
    expect(shownText(quiet("Key hints hidden"), true)).toBe("Key hints hidden");
  });
});

describe(":messages, the recent ones", () => {
  it("lists every message, quiet ones too, oldest first, and clear empties it", async () => {
    const { log, run, opened, said } = await setup();
    log.push("No Host named nope", new Date(2026, 10, 1, 9, 5, 7));
    log.push(quiet("Sidebar hidden", "Sidebar hidden, and kept that way."), new Date(2026, 10, 1, 9, 6, 0));
    log.push("", new Date());
    run(undefined);
    expect(opened()).toBe(1);
    const table = logView(log.snapshot()).content.table;
    expect(table?.rows.map((r) => [r.cells.at, r.cells.text, r.tone])).toEqual([
      ["09:05:07", "No Host named nope", undefined],
      ["09:06:00", "Sidebar hidden, and kept that way.", "muted"],
    ]);
    run("clear");
    expect(log.snapshot()).toEqual([]);
    expect(said).toEqual([]);
  });

  it("keeps the last 200", () => {
    const log = new MessageLog();
    for (let i = 0; i < 205; i++) log.push(`m${i}`);
    expect(log.snapshot()).toHaveLength(200);
    expect(log.snapshot()[0]?.text).toBe("m5");
  });
});
