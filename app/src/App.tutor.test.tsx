// `:tutor` (ticket 55, decision Q76): Neovim's `:Tutor` on a demo Inventory, through the App with the
// fake Backend and a stub terminal. Every step of roster's tutorial is done here the way a person
// would, and each ticks itself from what the app saw; the real workspace's Session, vault and State
// are untouched behind the demo, and only the progress is kept. user-event writes Ctrl+Space as
// {Control>} {/Control}.
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import { defaultConfig } from "./config/fixture";
import type { ConfigReport } from "./config/types";
import { memoryPlatform } from "./platform/memory";
import { builtinRegistries } from "./registries";
import { StubTerminal } from "./terminal/StubTerminal";
import { rosterTutorial } from "./tutor/tutor";

const hosts = makeHosts(12);
/** A Host of the real Inventory whose Login is a key (so its Session needs no vault). */
const REAL = hosts.hosts[1]?.name as string;
const LEADER = "{Control>} {/Control}";
const ALL_STEPS = rosterTutorial.lessons.flatMap((l) => l.steps.map((s) => s.id));
const report: ConfigReport = { config: defaultConfig, error: null, path: "/home/you/.config/roster/init.lua", version: 1 };

async function ready(state: Record<string, unknown> = {}) {
  const user = userEvent.setup();
  const platform = memoryPlatform({ config: report, state });
  render(
    <App
      backend={fakeBackend({ hosts })}
      terminalView={StubTerminal}
      registries={builtinRegistries()}
      platform={platform}
      config={report}
      openAtStart={[REAL]}
    />,
  );
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  await waitFor(() => expect(pane(REAL)).not.toBeNull());
  return { user, platform };
}

const help = () => screen.getByRole("complementary", { name: "Help" });
const banner = () => screen.queryByRole("region", { name: "Demo Inventory" });
const step = (id: string) => {
  const i = ALL_STEPS.indexOf(id);
  return help().querySelectorAll(".help-step")[i] as HTMLElement;
};
/** A Session's pane, on screen or not. */
const pane = (host: string) => screen.queryByRole("group", { name: `Session ${host}`, hidden: true });
const isDone = (id: string) => waitFor(() => expect(step(id)).toHaveAttribute("data-done"));

async function openPicked(user: ReturnType<typeof userEvent.setup>, host: string) {
  await user.keyboard(`${LEADER}f`);
  await screen.findByRole("dialog", { name: "Find a Host" });
  await user.keyboard(`${host}{Enter}`);
  await waitFor(() => expect(pane(host)).not.toBeNull());
}

describe(":tutor", () => {
  it("runs on a demo Inventory, every step ticks itself, and leaving brings your workspace back untouched", async () => {
    const { user, platform } = await ready();
    await user.keyboard(`${LEADER}:tutor{Enter}`);
    expect(await screen.findByRole("region", { name: "Demo Inventory" })).toHaveTextContent(/nothing here reaches your network/);
    await screen.findByRole("complementary", { name: "Help" });
    expect(within(help()).getAllByRole("heading", { level: 1 })[0]).toHaveTextContent("roster tutor");
    // The real workspace is behind it, out of reach: its Session isn't among the demo's.
    expect(screen.queryByRole("group", { name: `Session ${REAL}` })).toBeNull();
    expect(screen.getAllByRole("main", { name: /workspace/i })).toHaveLength(1);

    // Lesson 1: the Picker, and a Session to demo-01.
    await openPicked(user, "demo-01");
    await isDone("picker");
    await isDone("session");
    // Lesson 2: a second Session, and back to the first.
    await openPicked(user, "demo-02");
    await isDone("second");
    expect(step("switch")).not.toHaveAttribute("data-done");
    await user.keyboard(`${LEADER}[[`);
    await isDone("switch");
    // Lesson 3: a link, Ctrl+O back, and terminal.size.
    await user.click(within(step("link")).getByRole("link", { name: "quickref" }));
    expect(within(help()).getAllByRole("heading", { level: 1 })[0]).toHaveTextContent("Quick reference");
    await user.keyboard("{Control>}o{/Control}");
    expect(within(help()).getAllByRole("heading", { level: 1 })[0]).toHaveTextContent("roster tutor");
    await isDone("link");
    await isDone("back");
    await user.keyboard(`${LEADER}:help terminal.size{Enter}`);
    await user.keyboard("{Control>}o{/Control}");
    await isDone("option");
    // Lesson 4: a Theme, and init.lua.
    await user.keyboard(`${LEADER}:theme nord{Enter}`);
    await isDone("theme");
    await user.keyboard(`${LEADER}:config{Enter}`);
    await isDone("config");
    expect(platform.opened()).toEqual([report.path]);
    expect(banner()).toHaveTextContent("every step done");

    // Only the progress reached the real State; the demo's Theme didn't.
    await waitFor(() => expect((platform.saved() as Record<string, unknown>).tutor).toEqual({ roster: ALL_STEPS }));
    expect((platform.saved() as Record<string, unknown>).theme).toBeUndefined();
    expect((platform.saved() as { recentHosts: string[] }).recentHosts).not.toContain("demo-01");

    await user.keyboard(`${LEADER}:tutor quit{Enter}`);
    await waitFor(() => expect(banner()).toBeNull());
    expect(await screen.findByRole("group", { name: `Session ${REAL}` })).toBeInTheDocument();
    expect(pane("demo-01")).toBeNull();
    expect(document.documentElement.dataset.theme).not.toBe("nord");
    // It opens :help terminal.size, on the long :help options page (see below).
  }, 15_000);

  it("comes back where you left off, and reset starts it over", async () => {
    const { user } = await ready({ tutor: { roster: ["picker", "session"] } });
    await user.keyboard(`${LEADER}:tutor{Enter}`);
    await screen.findByRole("complementary", { name: "Help" });
    await waitFor(() => expect(help().querySelector(".help-target")).toHaveTextContent("Lesson 2: More than one Session"));
    expect(within(help()).getByRole("link", { name: "Lesson 1: Find a Host" }).parentElement).toHaveTextContent("Lesson 1: Find a Host · done");
    expect(step("picker")).toHaveAttribute("data-done");
    await user.keyboard(`${LEADER}:tutor reset{Enter}`);
    await waitFor(() => expect(step("picker")).not.toHaveAttribute("data-done"));
  });

  it("searching :help options for terminal.size finds it too", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:tutor{Enter}`);
    await screen.findByRole("complementary", { name: "Help" });
    await user.keyboard(`${LEADER}:help options{Enter}`);
    await user.keyboard("/");
    await user.keyboard("terminal.size");
    await user.keyboard("{Escape}");
    await user.keyboard("{Control>}o{/Control}");
    await isDone("option");
    // :help options is a long page (every option, the roster table and roster.o's methods), and
    // jsdom searches it once per key typed: slow on a shared CI runner.
  }, 15_000);

  it("outside the demo, :tutor quit says nothing runs, and :help tutor is a page you can read", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:tutor quit{Enter}`);
    expect(document.querySelector(".message-line")).toHaveTextContent("No tutorial is running");
    await user.keyboard(`${LEADER}:help tutor{Enter}`);
    expect(within(help()).getAllByRole("heading", { level: 1 })[0]).toHaveTextContent("roster tutor");
    expect(banner()).toBeNull();
    await user.keyboard(`{Escape}${LEADER}:tutor nope{Enter}`);
    expect(document.querySelector(".message-line")).toHaveTextContent("No tutorial named nope (roster)");
  });
});
