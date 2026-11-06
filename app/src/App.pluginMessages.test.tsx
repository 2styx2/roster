// A Plugin's messages follow `ui.messages` as roster's own do (tickets 117 and 118, decision
// Q126, Neovim's model): an error, a warning or an answer shows; a routine confirmation
// (`roster.echo(text, { quiet = true })`) and an info notice are quiet by default. Quiet, a screen
// reader still hears it and `:messages` keeps it; `ui.messages = "all"` brings it back.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import type { FakePlugin } from "./backend/fakePlugins";
import { memoryPlatform } from "./platform/memory";
import { STATE_KEY } from "./plugins/manager";
import { StubTerminal } from "./terminal/StubTerminal";
import { advanceTimers, fakeTimeouts, pass } from "./test-timers";

const LEADER = "{Control>} {/Control}";
const PATH = "~/plugins/pins";

const pins: FakePlugin = {
  manifest: { name: "pins", version: "1", description: "", author: null, api: 4, permissions: [] },
  load(roster) {
    roster.commands.add("pin", {
      run: (a: Record<string, unknown>) => {
        const w = String(a.args ?? "");
        if (w === "add") roster.echo("Pinned esx-02", { quiet: true });
        else if (w === "count") roster.echo("2 pins");
        else if (w === "copy") roster.notify("Copied esx-02's address");
        else if (w === "moved") roster.notify("Moved 2 pins from pins.yml", "info", { quiet: false });
        else if (w === "plan") roster.notify("Plan ready", "info", { actions: [{ label: "Show the plan", run: "pin count" }] });
        else if (w === "broken") roster.notify("pins.json doesn't parse", "warn");
        else if (w === "later") roster.defer(400, () => roster.notify("Synced 3 pins"));
      },
    });
    roster.progress.set("sync", { title: "Syncing pins", cancel: () => undefined });
  },
};

async function ready(state: Record<string, unknown> = {}) {
  const user = userEvent.setup({ advanceTimers });
  const platform = memoryPlatform({
    state: { version: 1, recentHosts: [], folded: [], [STATE_KEY]: [{ path: PATH, name: "pins", granted: [], asked: [] }], ...state },
  });
  render(<App backend={fakeBackend({ hosts: makeHosts(3), plugins: { [PATH]: pins } })} terminalView={StubTerminal} platform={platform} />);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  await screen.findByRole("button", { name: /Syncing pins/ });
  return user;
}

const messageLine = () => document.querySelector(".message-line") as HTMLElement;
// What's shown: a quiet message is only spoken (a visually hidden span in the always-there line).
const seen = () => (messageLine().querySelector(".visually-hidden") ? "" : (messageLine().textContent ?? ""));
const tick = () => (vi.isFakeTimers() ? pass(0) : new Promise((r) => setTimeout(r, 0)));
const run = async (user: ReturnType<typeof userEvent.setup>, line: string) => {
  await user.keyboard(`${LEADER}:${line}{Enter}`);
  await tick();
};

describe("a Plugin's messages, quiet by default", () => {
  it("a confirmation marked quiet shows nothing, and a screen reader still hears it", async () => {
    const user = await ready();
    await run(user, "pin add");
    expect(seen()).toBe("");
    expect(messageLine()).toHaveTextContent(/^Pinned esx-02$/);
  });

  it("a plain echo is an answer: it shows", async () => {
    const user = await ready();
    await run(user, "pin count");
    expect(seen()).toBe("2 pins");
  });

  it("an info notice is quiet, heard, and kept by :messages", async () => {
    const user = await ready();
    await run(user, "pin copy");
    expect(screen.queryByRole("status", { name: "From pins" })).toBeNull();
    expect(messageLine()).toHaveTextContent(/^pins: Copied esx-02's address$/);
    await run(user, "messages");
    const view = await screen.findByRole("region", { name: /^Messages/ });
    expect(within(view).getByText("pins: Copied esx-02's address")).toBeInTheDocument();
  });

  it("a warning, an info notice with buttons, and one that says quiet = false still show", async () => {
    const user = await ready();
    await run(user, "pin broken");
    expect(await screen.findByRole("alert", { name: "From pins" })).toHaveTextContent("pins: pins.json doesn't parse");
    await run(user, "pin plan");
    await run(user, "pin moved");
    const shown = screen.getAllByRole("status", { name: "From pins" }).map((n) => n.textContent);
    expect(shown).toEqual([expect.stringContaining("Plan ready"), expect.stringContaining("Moved 2 pins")]);
    // :messages keeps the shown ones too.
    await run(user, "messages");
    const view = await screen.findByRole("region", { name: /^Messages/ });
    expect(within(view).getByText("pins: pins.json doesn't parse")).toBeInTheDocument();
  });

  it(":cancel's Stopping is quiet too", async () => {
    const user = await ready();
    await run(user, "cancel sync");
    expect(seen()).toBe("");
    expect(messageLine()).toHaveTextContent(/^Stopping Syncing pins$/);
  });

  it("all of them show with :messages all", async () => {
    const user = await ready({ messages: "all" });
    await run(user, "pin add");
    expect(seen()).toBe("Pinned esx-02");
    await run(user, "pin copy");
    expect(screen.getByRole("status", { name: "From pins" })).toHaveTextContent("pins: Copied esx-02's address");
    await run(user, "cancel sync");
    expect(seen()).toBe("Stopping Syncing pins");
  });
});

// The owner's ruling (2026-11-03, decision Q162): errors always show (Q115 (a)) wins over Q126 (b).
// A quiet notice from a timer, an event or a request's answer arrives when nothing was asked, so it
// never takes the place of what the line shows; `:messages` keeps it.
describe("a background quiet message keeps a visible line", () => {
  // The Plugin's `pin later` notifies after 400 ms: on fake timeouts, it comes when the test says.
  beforeEach(fakeTimeouts);
  const wait = () => pass(400);

  it("an info notice from a timer leaves an error on the line, and :messages keeps both", async () => {
    const user = await ready();
    await run(user, "pin later");
    await run(user, "connect nope");
    expect(seen()).toBe("No Host named nope");
    await wait();
    expect(seen()).toBe("No Host named nope");
    await run(user, "messages");
    const view = await screen.findByRole("region", { name: /^Messages/ });
    expect(within(view).getByText("pins: Synced 3 pins")).toBeInTheDocument();
    expect(within(view).getByText("No Host named nope")).toBeInTheDocument();
  });

  it("on an empty line it's still heard, and the user's own quiet confirmation still replaces an error", async () => {
    const user = await ready();
    await run(user, "pin later");
    await wait();
    expect(seen()).toBe("");
    expect(messageLine()).toHaveTextContent(/^pins: Synced 3 pins$/);
    await run(user, "connect nope");
    await run(user, "pin add");
    expect(seen()).toBe("");
    expect(messageLine()).toHaveTextContent(/^Pinned esx-02$/);
  });

  it("with :messages all, it shows as a notice, beside the error", async () => {
    const user = await ready({ messages: "all" });
    await run(user, "pin later");
    await run(user, "connect nope");
    await wait();
    expect(screen.getByRole("status", { name: "From pins" })).toHaveTextContent("pins: Synced 3 pins");
    expect(seen()).toBe("No Host named nope");
  });
});
