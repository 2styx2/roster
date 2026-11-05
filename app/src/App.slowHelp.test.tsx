// A slow first `:help` (T213, #431's reviews, T228): the app's own guides' text, held back until the
// test lets it through (helpText.restart gives each case a first load of its own), and the 150 ms
// before help says it's loading on fake timers, so what runs before or after it is the test's call,
// not the machine's speed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts, type FakeScenario } from "./backend/fake";
import { LOADING_AFTER } from "./help/command";
import { helpText } from "./help/text";
import { memoryPlatform } from "./platform/memory";
import { builtinRegistries } from "./registries";
import { StubTerminal } from "./terminal/StubTerminal";

const LEADER = "{Control>} {/Control}";

/** The guides' text, held back: `open` lets it through, `fail` makes the load fail. */
let gate: { open(): void; fail(): void };
beforeEach(() => {
  let open = () => {};
  let fail = () => {};
  const shut = new Promise<void>((done, refuse) => {
    open = done;
    fail = () => refuse(new Error("no chunk"));
  });
  gate = { open: () => open(), fail: () => fail() };
  helpText.restart(() => shut.then(() => import("./help/guideText")).then((m) => m.guideTexts));
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { jest?: unknown }).jest;
});

/** The app, unlocked, with the 150 ms on fake timers from here on. */
async function unlocked(hosts: FakeScenario["hosts"] = makeHosts(4)) {
  const user = userEvent.setup({ delay: null });
  render(<App backend={fakeBackend({ hosts })} terminalView={StubTerminal} registries={builtinRegistries()} platform={memoryPlatform()} />);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // Testing Library drains its updates on a setTimeout(0), which it moves on by itself only when it
  // sees Jest's fake timers: these are Vitest's, so it's told how.
  (globalThis as { jest?: unknown }).jest = { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) };
  return user;
}

const helpPanel = () => screen.queryByRole("complementary", { name: "Help" });
/** Past LOADING_AFTER. */
const pastLoadingAfter = () => act(() => vi.advanceTimersByTime(LOADING_AFTER));
/** The text arrives (or fails), and whatever waited on it has run. */
async function arrives(how: "open" | "fail" = "open") {
  await act(async () => {
    gate[how]();
    await helpText.load().catch(() => {});
  });
}

/** `:help keyboard`, showing it's loading. */
async function loadingKeyboard() {
  const user = await unlocked();
  await user.keyboard(`${LEADER}:help keyboard{Enter}`);
  await pastLoadingAfter();
  const help = screen.getByRole("complementary", { name: "Help" });
  expect(within(help).getByText("Loading this page…")).toBeInTheDocument();
  return { user, help };
}

describe("a slow first :help", () => {
  it("shows nothing until 150 ms, then says it's loading, then shows the page", async () => {
    const user = await unlocked();
    await user.keyboard(`${LEADER}:help keyboard#two-modes{Enter}`);
    await act(() => vi.advanceTimersByTime(LOADING_AFTER - 1));
    expect(helpPanel()).toBeNull();
    await act(() => vi.advanceTimersByTime(1));
    const help = screen.getByRole("complementary", { name: "Help" });
    expect(within(help).getByText("Loading this page…")).toHaveAttribute("role", "status");
    await arrives();
    expect(within(help).getByRole("heading", { level: 2, name: "Two modes" })).toHaveClass("help-target");
    expect(within(help).getByRole("heading", { level: 1 })).toHaveTextContent("Keyboard");
    expect(within(help).queryByText("Loading this page…")).toBeNull();
  });
});

describe("a :help still waiting", () => {
  it("is dropped when a finder opens, so it never takes the focus later", async () => {
    const user = await unlocked();
    await user.keyboard(`${LEADER}:help keyboard{Enter}`);
    await user.keyboard(`${LEADER}:finder hosts{Enter}`);
    const finder = await screen.findByRole("dialog", { name: /find a host/i });
    await pastLoadingAfter();
    await arrives();
    expect(helpPanel()).toBeNull();
    expect(finder).toContainElement(document.activeElement as HTMLElement);
  });

  it("is dropped when you click into a terminal, so it never takes the focus from it later", async () => {
    const hosts = makeHosts(4);
    const name = hosts.hosts[0]?.name ?? "";
    const user = await unlocked(hosts);
    await user.keyboard(`${LEADER}f`);
    await user.keyboard(name);
    await user.keyboard("{Enter}");
    const output = await screen.findByLabelText("terminal output", { selector: ":not([hidden]) > pre" });
    await within(output).findByText(new RegExp(`Connected to ${name}`));
    await user.keyboard(`${LEADER}:help keyboard{Enter}`);
    const input = screen.getByLabelText("terminal input");
    await user.click(input);
    await pastLoadingAfter();
    await arrives();
    expect(helpPanel()).toBeNull();
    expect(input).toHaveFocus();
  });
});

describe("a :help showing it's loading, then something else", () => {
  it("fills in when the text arrives, after a command ran meanwhile, leaving the focus where it is", async () => {
    const { user, help } = await loadingKeyboard();
    await user.keyboard(`${LEADER}:nosuchcmd{Enter}`);
    const focused = document.activeElement;
    await arrives();
    expect(within(help).getByRole("heading", { level: 2, name: "Two modes" })).toBeInTheDocument();
    expect(within(help).queryByText("Loading this page…")).toBeNull();
    expect(document.activeElement).toBe(focused);
  });

  it("fills in behind a finder opened meanwhile, which keeps the focus", async () => {
    const { user, help } = await loadingKeyboard();
    await user.keyboard(`${LEADER}:finder hosts{Enter}`);
    const finder = await screen.findByRole("dialog", { name: /find a host/i });
    await arrives();
    expect(within(help).getByRole("heading", { level: 2, name: "Two modes" })).toBeInTheDocument();
    expect(finder).toContainElement(document.activeElement as HTMLElement);
  });

  it("says the guides couldn't load when that load fails, after a command ran meanwhile", async () => {
    const { user, help } = await loadingKeyboard();
    await user.keyboard(`${LEADER}:nosuchcmd{Enter}`);
    await arrives("fail");
    expect(within(help).getByRole("alert")).toHaveTextContent("Couldn't load help's guides: no chunk. :help keyboard tries again.");
    expect(within(help).queryByText("Loading this page…")).toBeNull();
  });
});
