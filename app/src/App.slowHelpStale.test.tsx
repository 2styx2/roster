// A slow first `:help` already showing "Loading this page…" when you go on to something else (T213,
// #431's second review, N1): a command ran meanwhile: the page still fills in, and the focus stays where it went. The app's own chunk, held back until the
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
  it("fills in when the text arrives, after a command ran meanwhile, leaving the focus where it is", async () => {
    const { user, help } = await loadingKeyboard();
    await user.keyboard(`${LEADER}:nosuchcmd{Enter}`);
    const focused = document.activeElement;
    gate.open();
    expect(await within(help).findByRole("heading", { level: 2, name: "Two modes" })).toBeInTheDocument();
    expect(within(help).queryByText("Loading this page…")).toBeNull();
    expect(document.activeElement).toBe(focused);
  });
});
