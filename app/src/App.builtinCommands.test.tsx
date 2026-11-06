// The core hears of every command roster itself registers, so none is a Plugin's own to run with
// `roster.cmd` or a `run` line (issue #184). The built-ins register from many places (the table,
// the registries, App's effects such as `:plugins`, `:panel`, `:tutor`), some after the Plugins
// start; every load, call and event carries them (manager.test.ts), and here the mounted App's do.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import { defaultOptions } from "./keymap";
import { manualClock } from "./ui/manualClock";
import { memoryPlatform } from "./platform/memory";
import { builtinRegistries } from "./registries";
import { BUILTIN } from "./registry";
import { StubTerminal } from "./terminal/StubTerminal";

const LEADER = "{Control>} {/Control}";

describe("roster's own commands, to the core", () => {
  it("reach it, the ones App registers as it mounts among them", async () => {
    const user = userEvent.setup();
    const registries = builtinRegistries();
    const backend = fakeBackend({ hosts: makeHosts(3) });
    // The list goes with each load, call and event; App's late ones with the next event.
    const sent = vi.spyOn(backend, "pluginEvent");
    render(
      <App backend={backend} terminalView={StubTerminal} options={defaultOptions} registries={registries} platform={memoryPlatform()} clock={manualClock()} />,
    );
    await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    await screen.findByRole("main", { name: /workspace/i });
    const builtins = registries.commands
      .list()
      .filter((c) => c.source === BUILTIN)
      .map((c) => c.id);
    expect(builtins).toEqual(expect.arrayContaining(["plugins", "packages", "panel", "messages", "help", "theme", "tutor"]));
    // Locking tells the Plugins (`lock`), with the list as it is now.
    await user.keyboard(`${LEADER}:lock{Enter}`);
    await vi.waitFor(() => expect(builtins.filter((id) => !(sent.mock.calls.at(-1)?.[2] ?? []).includes(id))).toEqual([]));
  });
});
