// A slow first `:help` already showing "Loading this page…" when you go on to something else (T213,
// #431's second review, N1): the text then fails to load: the panel says so. The app's own chunk, held back until the
// test lets it through, read through the real global HelpText. Its own file: the chunk loads once.
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import { LOADING_AFTER } from "./help/command";
import { memoryPlatform } from "./platform/memory";
import { builtinRegistries } from "./registries";
import { StubTerminal } from "./terminal/StubTerminal";

const gate = vi.hoisted(() => {
  let open = () => {};
  let fail = () => {};
  const shut = new Promise<void>((done, refuse) => {
    open = done;
    fail = () => refuse(new Error("no chunk"));
  });
  return { shut, open: () => open(), fail: () => fail() };
});
vi.mock("./help/guideText", async (original) => {
  await gate.shut;
  return original();
});

const LEADER = "{Control>} {/Control}";

async function loadingKeyboard() {
  const user = userEvent.setup();
  render(<App backend={fakeBackend({ hosts: makeHosts(4) })} terminalView={StubTerminal} registries={builtinRegistries()} platform={memoryPlatform()} />);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  await user.keyboard(`${LEADER}:help keyboard{Enter}`);
  await new Promise((done) => setTimeout(done, LOADING_AFTER + 50));
  const help = screen.getByRole("complementary", { name: "Help" });
  expect(within(help).getByText("Loading this page…")).toBeInTheDocument();
  return { user, help };
}

describe("a :help showing it's loading, then something else", () => {
  it("says the guides couldn't load when that load fails, after a command ran meanwhile", async () => {
    const { user, help } = await loadingKeyboard();
    await user.keyboard(`${LEADER}:nosuchcmd{Enter}`);
    gate.fail();
    // Vitest wraps the mock's own error in a message of its own, so only the line's shape is checked.
    expect(await within(help).findByRole("alert")).toHaveTextContent(/^Couldn't load help's guides: .+:help keyboard tries again\.$/s);
    expect(within(help).queryByText("Loading this page…")).toBeNull();
  });
});
