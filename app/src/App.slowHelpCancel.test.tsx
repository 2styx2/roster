// A `:help` still waiting for the guides' text doesn't open later over what you went on to (T213,
// #431's review F3): another command, or a finder, cancels it. The app's own chunk, held back 400 ms,
// through the real global HelpText. Its own file: the chunk loads once.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import { helpText } from "./help/text";
import { memoryPlatform } from "./platform/memory";
import { builtinRegistries } from "./registries";
import { StubTerminal } from "./terminal/StubTerminal";

vi.mock("./help/guideText", async (original) => {
  await new Promise((done) => setTimeout(done, 400));
  return original();
});

const LEADER = "{Control>} {/Control}";

describe("a :help still waiting", () => {
  it("is dropped when a finder opens, so it never takes the focus later", async () => {
    const user = userEvent.setup();
    render(<App backend={fakeBackend({ hosts: makeHosts(4) })} terminalView={StubTerminal} registries={builtinRegistries()} platform={memoryPlatform()} />);
    await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    await screen.findByRole("main", { name: /workspace/i });
    await user.keyboard(`${LEADER}:help keyboard{Enter}`);
    await user.keyboard(`${LEADER}:finder hosts{Enter}`);
    const finder = await screen.findByRole("dialog", { name: /find a host/i });
    await helpText.load();
    await new Promise((done) => setTimeout(done, 50));
    expect(screen.queryByRole("complementary", { name: "Help" })).toBeNull();
    expect(finder).toContainElement(document.activeElement as HTMLElement);
  });
});
