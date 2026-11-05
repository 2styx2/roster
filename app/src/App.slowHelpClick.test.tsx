// A `:help` still waiting doesn't open later over where you went with no command or finder (T228,
// #438 item 3): a click into a terminal cancels it, as a command or a finder does (#431's F3). The
// app's own chunk, held back until the test lets it through, read through the real global HelpText.
// Its own file: the chunk loads once.
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import { helpText } from "./help/text";
import { memoryPlatform } from "./platform/memory";
import { builtinRegistries } from "./registries";
import { StubTerminal } from "./terminal/StubTerminal";

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

describe("a :help still waiting", () => {
  it("is dropped when you click into a terminal, so it never takes the focus from it later", async () => {
    const user = userEvent.setup();
    const hosts = makeHosts(4);
    const name = hosts.hosts[0]?.name ?? "";
    render(<App backend={fakeBackend({ hosts })} terminalView={StubTerminal} registries={builtinRegistries()} platform={memoryPlatform()} />);
    await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    await screen.findByRole("main", { name: /workspace/i });
    await user.keyboard(`${LEADER}f`);
    await user.keyboard(name);
    await user.keyboard("{Enter}");
    const output = await screen.findByLabelText("terminal output", { selector: ":not([hidden]) > pre" });
    await within(output).findByText(new RegExp(`Connected to ${name}`));
    await user.keyboard(`${LEADER}:help keyboard{Enter}`);
    const input = screen.getByLabelText("terminal input");
    await user.click(input);
    gate.open();
    await helpText.load();
    await new Promise((done) => setTimeout(done, 50));
    expect(screen.queryByRole("complementary", { name: "Help" })).toBeNull();
    expect(input).toHaveFocus();
  });
});
