// The core hears of every command roster itself registers, so none is a Plugin's own to run with
// `roster.cmd` or a `run` line (issue #184). The built-ins register from many places (the table,
// the registries, App's effects such as `:plugins`, `:panel`, `:tutor`), some after the Plugins
// start; the manager sends each as it comes (manager.test.ts), and here the mounted App's reach it.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import { defaultOptions } from "./keymap";
import { manualClock } from "./lock/manualClock";
import { memoryPlatform } from "./platform/memory";
import { builtinRegistries } from "./registries";
import { BUILTIN } from "./registry";
import { StubTerminal } from "./terminal/StubTerminal";

describe("roster's own commands, to the core", () => {
  it("reach it, the ones App registers as it mounts among them", async () => {
    const user = userEvent.setup();
    const registries = builtinRegistries();
    const backend = fakeBackend({ hosts: makeHosts(3) });
    const sent = vi.spyOn(backend, "pluginBuiltins");
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
    await vi.waitFor(() => expect(builtins.filter((id) => !(sent.mock.calls.at(-1)?.[0] ?? []).includes(id))).toEqual([]));
  });
});
