// `:help` (ticket 37): Neovim-style docs inside the app, through the App with the fake Backend and
// a stub terminal. The pages come from the live registries and the guides from docs/app; this
// drives how you reach them: the topic finder (␣ ?), `:help TOPIC` with Tab completion, links,
// Ctrl+O back, search, and Esc back to where you were. user-event writes Ctrl+Space as
// {Control>} {/Control}.
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import { configWith, defaultConfig } from "./config/fixture";
import type { Config, ConfigReport } from "./config/types";
import { memoryPlatform } from "./platform/memory";
import { builtinRegistries } from "./registries";
import { StubTerminal } from "./terminal/StubTerminal";

const hosts = makeHosts(12);
const LEADER = "{Control>} {/Control}";
const report = (config: Config): ConfigReport => ({ config, error: null, path: "/home/me/.config/roster/init.lua", version: 1 });

async function ready({ config, state }: { config?: Config; state?: Record<string, unknown> } = {}) {
  const user = userEvent.setup();
  const platform = memoryPlatform({ ...(config ? { config: report(config) } : {}), ...(state ? { state } : {}) });
  render(
    <App
      backend={fakeBackend({ hosts })}
      terminalView={StubTerminal}
      registries={builtinRegistries()}
      platform={platform}
      {...(config ? { config: report(config) } : {})}
    />,
  );
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return user;
}

const help = () => screen.getByRole("complementary", { name: "Help" });
const helpOrNull = () => screen.queryByRole("complementary", { name: "Help" });
const heading = () => within(help()).getAllByRole("heading", { level: 1 })[0];
const target = () => help().querySelector(".help-target");

describe(":help", () => {
  it("␣ ? finds a topic; Enter opens it at its entry, and Esc goes back where you were", async () => {
    const user = await ready();
    const before = document.activeElement;
    await user.keyboard(`${LEADER}?`);
    const finder = await screen.findByRole("dialog", { name: /find a help topic/i });
    await user.keyboard("terminal.size");
    expect(within(finder).getAllByRole("option")[0]).toHaveTextContent("terminal.size");
    await user.keyboard("{Enter}");
    expect(heading()).toHaveTextContent("Options");
    expect(target()).toHaveTextContent(/terminal\.size/);
    expect(help()).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard("{Escape}");
    expect(helpOrNull()).toBeNull();
    expect(document.activeElement).toBe(before);
  });

  it(":help TOPIC opens it; Tab completes topics; an unknown one is said", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:help E1{Tab}`);
    expect(screen.getByRole("combobox", { name: "Command" })).toHaveValue("help E1");
    expect(within(screen.getByRole("listbox", { name: "Completions" })).getAllByRole("option")[0]).toHaveTextContent("help E1");
    await user.keyboard("3{Enter}");
    expect(heading()).toHaveTextContent("Connection errors");
    expect(target()).toHaveTextContent(/E13/);
    await user.keyboard("{Escape}");
    await user.keyboard(`${LEADER}:help zzqxj{Enter}`);
    expect(helpOrNull()).toBeNull();
    expect(document.querySelector(".message-line")).toHaveTextContent("No help for zzqxj");
  });

  it("follows links, and Ctrl+O goes back", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:help index{Enter}`);
    expect(heading()).toHaveTextContent("roster help");
    await user.click(within(help()).getByRole("link", { name: "options" }));
    expect(heading()).toHaveTextContent("Options");
    await user.keyboard("{Control>}o{/Control}");
    expect(heading()).toHaveTextContent("roster help");
    await user.keyboard("{Control>}i{/Control}");
    expect(heading()).toHaveTextContent("Options");
  });

  it("shows each option's value and where it came from", async () => {
    const config = configWith({
      terminal: { ...defaultConfig.terminal, cursorStyle: "bar" },
      set: ["terminal.cursor_style"],
      lines: { "terminal.cursor_style": { file: "init.lua", line: 9 } },
    });
    const user = await ready({ config, state: { theme: "nord" } });
    await user.keyboard(`${LEADER}:help terminal.cursor_style{Enter}`);
    expect(target()).toHaveTextContent(/"bar".*init\.lua:9/);
    await user.keyboard(`${LEADER}:help theme{Enter}`);
    expect(target()).toHaveTextContent(/"nord".*State/);
  });

  it("/ searches the page; n moves to the next match", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:help config{Enter}`);
    await user.keyboard("/");
    const search = within(help()).getByRole("searchbox", { name: /search this page/i });
    expect(search).toHaveFocus();
    await user.keyboard("require");
    const marks = help().querySelectorAll("mark");
    expect(marks.length).toBeGreaterThan(1);
    expect(within(help()).getByText(new RegExp(`^1 of ${marks.length}$`), { selector: ".help-count" })).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(within(help()).getByText(new RegExp(`^2 of ${marks.length}$`), { selector: ".help-count" })).toBeInTheDocument();
    expect(marks[1]).toHaveClass("current");
    // Esc leaves the search, then closes help.
    await user.keyboard("{Escape}");
    expect(helpOrNull()).not.toBeNull();
    await user.keyboard("n");
    expect(within(help()).getByText(new RegExp(`^3 of ${marks.length}$`), { selector: ".help-count" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(helpOrNull()).toBeNull();
  });

  it("/ again selects the last search, so what you type replaces it, from the first key on", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:help config{Enter}`);
    await user.keyboard("/require{Escape}");
    const search = within(help()).getByRole("searchbox", { name: /search this page/i });
    expect(search).toHaveValue("require");
    await user.keyboard("/theme");
    expect(search).toHaveValue("theme");
  });

  it("keeps its key tables when the key hints are hidden", async () => {
    const user = await ready({ config: configWith({ ui: { hints: false, messages: null } }) });
    await user.keyboard(`${LEADER}:help keys{Enter}`);
    const caps = help().querySelectorAll("table .keys");
    expect(caps.length).toBeGreaterThan(10);
    for (const c of caps) expect(c).toHaveClass("binding-keys");
  });

  it("the Key bindings panel moved to ␣ K", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}K`);
    expect(screen.getByRole("complementary", { name: "Key bindings" })).toBeInTheDocument();
  });

  it("the index says where to start, and the try-it link teaches the way back", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:help index{Enter}`);
    await user.click(within(help()).getByRole("link", { name: "links" }));
    expect(target()).toHaveTextContent("Links");
    await user.keyboard("{Control>}o{/Control}");
    expect(heading()).toHaveTextContent("roster help");
    await user.click(within(help()).getAllByRole("link", { name: "Getting started" })[0] as HTMLElement);
    expect(heading()).toHaveTextContent("Getting started with roster");
    // The page is a named region, so a screen reader says where it is.
    expect(within(help()).getByRole("region", { name: "Getting started with roster" })).toBeInTheDocument();
  });

  it("Ctrl+] follows the link you're on, as in Neovim", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:help index{Enter}`);
    within(help()).getByRole("link", { name: "options" }).focus();
    await user.keyboard("{Control>}]{/Control}");
    expect(heading()).toHaveTextContent("Options");
  });

  it("g O lists the page's headings; Enter goes to one", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:help config{Enter}`);
    await user.keyboard("gO");
    const outline = await screen.findByRole("dialog", { name: /outline/i });
    await user.keyboard("sandbox");
    expect(within(outline).getAllByRole("option")[0]).toHaveTextContent("The sandbox");
    await user.keyboard("{Enter}");
    expect(heading()).toHaveTextContent("The Config");
    expect(target()).toHaveTextContent("The sandbox");
  });

  it(":helpgrep searches every page's text; Enter opens it there with the word found", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:helpgrep{Enter}`);
    expect(await screen.findByText("Type words to search every help page.")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.keyboard(`${LEADER}:helpgrep bytecode{Enter}`);
    const grep = await screen.findByRole("dialog", { name: /search every help page/i });
    const first = within(grep).getAllByRole("option")[0] as HTMLElement;
    expect(first).toHaveTextContent(/bytecode/);
    expect(first).toHaveTextContent(/The sandbox/);
    await user.keyboard("{Enter}");
    expect(heading()).toHaveTextContent("The Config");
    expect(within(help()).getByRole("searchbox", { name: /search this page/i })).toHaveValue("bytecode");
    expect(help().querySelector("mark.current")).toHaveTextContent(/bytecode/i);
  });

  it(":options finds an option with its value now, its default and where it was set; Enter opens its help", async () => {
    const config = configWith({ idleLockMinutes: 30, set: ["idle_lock_minutes"], lines: { idle_lock_minutes: { file: "lua/opts.lua", line: 3 } } });
    const user = await ready({ config });
    await user.keyboard(`${LEADER}:options{Enter}`);
    const finder = await screen.findByRole("dialog", { name: /find an option/i });
    await user.keyboard("idle_lock");
    const first = within(finder).getAllByRole("option")[0] as HTMLElement;
    expect(first).toHaveTextContent("idle_lock_minutes");
    expect(first).toHaveTextContent("30");
    expect(first).toHaveTextContent("lua/opts.lua:3");
    expect(finder.querySelector(".picker-footer")).toHaveTextContent("Default 15 · integer");
    await user.keyboard("{Enter}");
    expect(heading()).toHaveTextContent("Options");
    expect(target()).toHaveTextContent("idle_lock_minutes");
  });

  it("has an entry for every name of init.lua's roster table and every item type", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:help roster.keymap.set{Enter}`);
    expect(heading()).toHaveTextContent("Options");
    expect(target()).toHaveTextContent("roster.keymap.set(context, keys, action)");
    await user.keyboard(`${LEADER}:help roster.config.Theme{Enter}`);
    expect(target()).toHaveTextContent("roster.config.Theme");
    await user.keyboard(`${LEADER}:help terminal.size{Enter}`);
    expect(target()).toHaveTextContent("6 to 72 px");
  });

  it("opens the CLI's docs too: :help roster.yml", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:help roster.yml{Enter}`);
    expect(heading()).toHaveTextContent("roster CLI reference");
    expect(target()).toHaveTextContent("roster.yml");
  });
});

describe("help from where you are", () => {
  it("Ctrl+] in the command line opens help on the command typed; Esc brings the line back", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:conn`);
    await user.keyboard("{Control>}]{/Control}");
    expect(heading()).toHaveTextContent("Commands");
    expect(target()).toHaveTextContent(":connect");
    expect(screen.queryByRole("combobox", { name: "Command" })).toBeNull();
    await user.keyboard("{Escape}");
    expect(helpOrNull()).toBeNull();
    const line = screen.getByRole("combobox", { name: "Command" });
    expect(line).toHaveValue("conn");
    expect(line).toHaveFocus();
    await user.keyboard("ect{Escape}");
    expect(screen.queryByRole("combobox", { name: "Command" })).toBeNull();
  });

  it("F1 in the command line does the same; a line that names no command says so", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:helpg{F1}`);
    expect(target()).toHaveTextContent(":helpgrep");
    await user.keyboard("{Escape}");
    await user.clear(screen.getByRole("combobox", { name: "Command" }));
    await user.keyboard("zzqxj{F1}");
    expect(helpOrNull()).toBeNull();
    expect(document.querySelector(".message-line")).toHaveTextContent("No command starts with zzqxj");
  });

  it("␣ F1 in App mode opens help on the selected Sidebar row: a Host's is :connect", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}gg`);
    for (let i = 0; i < 10 && !document.querySelector(".sidebar .cursor")?.getAttribute("data-row")?.startsWith("inventory:"); i++) {
      await user.keyboard("j");
    }
    await user.keyboard("{F1}");
    expect(heading()).toHaveTextContent("Commands");
    expect(target()).toHaveTextContent(":connect");
  });

  it("F1 in a finder opens help on the selected result: a Theme's entry", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:finder themes{Enter}`);
    await screen.findByRole("dialog", { name: /choose a theme/i });
    await user.keyboard("nord{F1}");
    expect(screen.queryByRole("dialog", { name: /choose a theme/i })).toBeNull();
    expect(heading()).toHaveTextContent("Themes");
    expect(target()).toHaveAttribute("data-tag", "themes#nord");
  });

  it("F1 in the Picker opens :connect", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}f`);
    await screen.findByRole("dialog", { name: /find a host/i });
    await user.keyboard("{F1}");
    expect(target()).toHaveTextContent(":connect");
  });

  it("F1 in the Key bindings panel opens the first binding's option; the panel lists the lookup keys", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}K`);
    const panel = screen.getByRole("complementary", { name: "Key bindings" });
    expect(within(panel).getByText("Help on the command typed").closest("tr")).toHaveTextContent(/Ctrl\+\]/);
    expect(within(panel).getByText("Help on the selected result")).toBeInTheDocument();
    expect(within(panel).getByText("Help on what's selected")).toBeInTheDocument();
    await user.keyboard("command typed{F1}");
    expect(heading()).toHaveTextContent("Options");
    expect(target()).toHaveTextContent("keys.cmdline");
  });
});

describe("what's new", () => {
  const said = () => document.querySelector(".message-line");

  it("after an upgrade the status line says once where the news is; :help news shows it", async () => {
    const platform = memoryPlatform({ state: { recentHosts: ["linux-1-000"], newsSeen: "0.0.1" } });
    const user = userEvent.setup();
    const props = { backend: fakeBackend({ hosts }), terminalView: StubTerminal, platform, appVersion: "0.2.0" };
    const { unmount } = render(<App {...props} registries={builtinRegistries()} />);
    await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    await screen.findByRole("main", { name: /workspace/i });
    await waitFor(() => expect(said()).toHaveTextContent("roster 0.2.0: what's new: :help news"));
    expect(await platform.loadState()).toMatchObject({ newsSeen: "0.2.0" });
    await user.keyboard(`${LEADER}:help news{Enter}`);
    expect(heading()).toHaveTextContent("What's new");
    unmount();

    // The next start says nothing.
    render(<App {...props} registries={builtinRegistries()} />);
    await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    await screen.findByRole("main", { name: /workspace/i });
    expect(said()).not.toHaveTextContent("what's new");
  });

  it("a first start says nothing", async () => {
    await ready();
    expect(said()).not.toHaveTextContent("what's new");
  });
});

describe("help and finders, for a screen reader", () => {
  const statuses = (el: HTMLElement) => within(el).queryAllByRole("status").map((s) => s.textContent ?? "");

  it("a finder announces how many results a query left, after typing pauses, and when nothing matches", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}?`);
    const finder = await screen.findByRole("dialog", { name: /find a help topic/i });
    await user.keyboard("zzqxj");
    expect(statuses(finder)).not.toContain("No matches");
    await waitFor(() => expect(statuses(finder)).toContain("No matches"));
    await user.clear(within(finder).getByRole("combobox"));
    await user.keyboard("terminal.size");
    await waitFor(() => expect(statuses(finder).some((s) => /^\d+ results?$/.test(s))).toBe(true));
  });

  it("help's search count is a live region there before it has anything to say", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:help config{Enter}`);
    const live = within(help()).getByRole("status");
    expect(live).toHaveTextContent(/^$/);
    await user.keyboard("/require");
    await waitFor(() => expect(within(help()).getByRole("status")).toHaveTextContent(/^1 of \d+$/));
    expect(within(help()).getByRole("status")).toBe(live);
  });

  it(":helpgrep opens a page with its count said after the region is there, not with it", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:help config /require{Enter}`);
    const live = within(help()).getByRole("status");
    expect(live).toHaveTextContent(/^$/);
    await waitFor(() => expect(live).toHaveTextContent(/^\d+ of \d+$/));
  });
});

