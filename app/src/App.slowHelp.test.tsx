// Lazy `:help` when the guides' text is slow (T213, #431's review F1): the app's own chunk, held
// back until the test lets it through, read through the real global HelpText as the app has it.
// Past 150 ms the panel says it's loading, then shows the page whole when the text arrives. Its own
// file: the chunk loads once.
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import { memoryPlatform } from "./platform/memory";
import { builtinRegistries } from "./registries";
import { StubTerminal } from "./terminal/StubTerminal";

// The chunk arrives when the test opens the gate, not after a set time: typing `:help` already
// starts the load (completion prefetches it), and a slow machine types slowly.
const gate = vi.hoisted(() => {
  let open = () => {};
  const shut = new Promise<void>((done) => (open = done));
  return { shut, open: () => open() };
});
vi.mock("./help/guideText", async (original) => {
  await gate.shut;
  return original();
});

const LEADER = "{Control>} {/Control}";

describe("a slow first :help", () => {
  it("says it's loading past 150 ms, then shows the page", async () => {
    const user = userEvent.setup();
    render(<App backend={fakeBackend({ hosts: makeHosts(4) })} terminalView={StubTerminal} registries={builtinRegistries()} platform={memoryPlatform()} />);
    await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    await screen.findByRole("main", { name: /workspace/i });
    await user.keyboard(`${LEADER}:help keyboard#two-modes{Enter}`);
    const help = await screen.findByRole("complementary", { name: "Help" });
    expect(within(help).getByText("Loading this page…")).toHaveAttribute("role", "status");
    gate.open();
    expect(await within(help).findByRole("heading", { level: 2, name: "Two modes" })).toHaveClass("help-target");
    expect(within(help).getByRole("heading", { level: 1 })).toHaveTextContent("Keyboard");
    expect(within(help).queryByText("Loading this page…")).toBeNull();
  });
});
