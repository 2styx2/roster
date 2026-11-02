// Plugin interactions (ticket 78, decision Q98) through the App, with the fake Backend's Plugin
// host: a toolbar control, a question the app draws (and its stronger form), progress with
// :cancel, a section's button, a float's buttons and links, roster.cmd and what it refuses, a
// line a Plugin hands over that it may not run, going to a Session and a line in it, and a table's
// filter, per-row actions and an update of its columns.
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import type { FakePlugin, FakeRoster } from "./backend/fakePlugins";
import { memoryPlatform, type MemoryPlatform } from "./platform/memory";
import { StubTerminal } from "./terminal/StubTerminal";

const LEADER = "{Control>} {/Control}";
const PATH = "~/plugins/mesh";

function meshPlugin(permissions: string[] = []): FakePlugin {
  return {
    manifest: { name: "mesh", version: "1.0.0", description: "Mesh controls", author: "A. Author", api: 2, permissions },
    load(roster: FakeRoster) {
      const say = (text: string) => () => roster.notify(text);
      roster.toolbar.set("mesh-scan", { label: "Scan a network", text: "Scan", icon: "map", run: say("scanning") });
      roster.sidebar.set("alerts", {
        title: "Alerts",
        rows: [{ id: "a", label: "ERROR disk full", actions: [{ label: "Sneaky", icon: "info", run: "plugins grant mesh terminal.write" }] }],
        actions: [{ label: "Dismiss all", icon: "close", run: say("dismissed") }],
      });
      roster.finders.set("alerts", { title: "Alerts", items: [{ label: "ERROR disk full", run: say("picked") }] });
      roster.progress.set("scan", { title: "Scanning 10.0.0.0/24", done: 64, total: 256, cancel: say("stopping") });
      roster.commands.add("cut", {
        run: () =>
          roster.confirm({
            title: "Cut esx-02 from the Mesh?",
            text: "Its key is taken off 7 Hosts.",
            facts: [{ label: "reach", value: "7 Hosts" }],
            action: "Cut",
            danger: true,
            typed: "esx-02",
            run: say("cut"),
            cancel: say("kept"),
          }),
      });
      roster.commands.add("apply", { run: () => roster.confirm({ title: "Apply the Mesh?", action: "Apply", run: say("applied") }) });
      roster.commands.add("go", { run: () => roster.cmd("finder alerts") });
      roster.commands.add("sneak", { run: () => roster.cmd("plugins grant mesh terminal.write") });
      roster.commands.add("show", { run: (a: Record<string, unknown>) => roster.sessions.show(Number((a.words as string[])[0]), "ERROR") });
      roster.commands.add("pop", {
        run: () =>
          roster.float.open({
            title: "esx-02",
            lines: ["ERROR disk full"],
            actions: [{ label: "Go to the line", key: "g", run: say("went") }],
            links: [{ label: "Runbook", url: "https://wiki.example.com/disk-full" }],
          }),
      });
      roster.views.set("peers", {
        title: "Peers",
        table: {
          columns: [{ id: "host", label: "Host", kind: "data" }],
          rows: [
            { id: "a", cells: { host: "esx-02", state: "up" } },
            { id: "b", cells: { host: "pve-1", state: "down" } },
            { id: "c", cells: { host: "nas-4", state: "up" } },
          ],
          actions: [{ label: "Cut", key: "x", when: { state: "up" }, run: (e: Record<string, unknown>) => roster.notify(`cut ${String(e.row)}`) }],
        },
      });
      roster.commands.add("more", {
        run: () =>
          roster.views.update("peers", {
            columns: [
              { id: "host", label: "Host", kind: "data" },
              { id: "state", label: "State" },
            ],
            sort: "state",
          }),
      });
    },
  };
}

// Every message on (ticket 117): the Plugin here says what ran with an info notice, which is quiet
// by default.
const everyMessage = () => memoryPlatform({ state: { version: 1, recentHosts: [], folded: [], messages: "all" } });

async function ready(permissions: string[] = [], platform: MemoryPlatform = everyMessage()) {
  const user = userEvent.setup();
  const backend = fakeBackend({ hosts: makeHosts(12), plugins: { [PATH]: meshPlugin(permissions) } });
  render(<App backend={backend} terminalView={StubTerminal} platform={platform} />);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  await user.keyboard(`${LEADER}:plugins install ${PATH}{Enter}`);
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Install" }));
  await screen.findByText("12 Hosts");
  return user;
}

const notice = (text: string | RegExp) => screen.findByText(text, { selector: ".config-toast-title" });

describe("a Plugin's toolbar control and section button", () => {
  it("sit with roster's own and run the Plugin's function", async () => {
    const user = await ready();
    const control = await screen.findByRole("button", { name: "Scan a network" });
    expect(control).toHaveTextContent("Scan");
    await user.click(control);
    await notice("mesh: scanning");
    await user.click(screen.getByRole("treeitem", { name: "Alerts" }));
    await user.click(screen.getByRole("button", { name: "Dismiss all" }));
    await notice("mesh: dismissed");
  });
});

describe("roster.confirm", () => {
  it("the stronger form starts on Cancel and confirms only once the word is typed", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:cut{Enter}`);
    const dialog = await screen.findByRole("alertdialog", { name: "Cut esx-02 from the Mesh? (from mesh)" });
    expect(dialog).toHaveTextContent("Its key is taken off 7 Hosts.");
    expect(dialog).toHaveTextContent("Asked by mesh");
    const cut = within(dialog).getByRole("button", { name: "Cut" });
    expect(cut).toBeDisabled();
    expect(cut).toHaveClass("danger");
    const field = within(dialog).getByRole("textbox");
    expect(field).toHaveFocus();
    await user.keyboard("esx-0{Enter}");
    expect(screen.getByRole("alertdialog", { name: /Cut esx-02/ })).toBeInTheDocument();
    await user.keyboard("2");
    expect(cut).toBeEnabled();
    await user.keyboard("{Enter}");
    await notice("mesh: cut");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("Esc cancels, and the Plugin hears it", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:cut{Enter}`);
    await screen.findByRole("alertdialog", { name: /Cut esx-02/ });
    await user.keyboard("{Escape}");
    await notice("mesh: kept");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("the plain form confirms with Enter", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:apply{Enter}`);
    const dialog = await screen.findByRole("alertdialog", { name: /Apply the Mesh/ });
    expect(within(dialog).getByRole("button", { name: "Apply" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await notice("mesh: applied");
  });
});

describe("roster.progress", () => {
  it("shows in the status bar, and :cancel calls its cancel once", async () => {
    const user = await ready();
    const bar = await screen.findByRole("progressbar", { name: "Scanning 10.0.0.0/24" });
    expect(bar).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByText("25%")).toBeInTheDocument();
    await user.keyboard(`${LEADER}:cancel scan{Enter}`);
    await notice("mesh: stopping");
    expect(screen.getByText("Scanning 10.0.0.0/24: stopping…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop Scanning 10.0.0.0/24" })).toBeNull();
  });
});

describe("roster.progress without the status bar", () => {
  // Ticket 85: Focus hides the status bar, so progress has a corner of its own there.
  it("shows in a corner in Focus, with its stop button, and goes back to the status bar after", async () => {
    const user = await ready();
    await screen.findByRole("progressbar", { name: "Scanning 10.0.0.0/24" });
    expect(document.querySelector(".statusbar .statusbar-progress")).not.toBeNull();
    await user.keyboard(`${LEADER}:focus{Enter}`);
    await waitFor(() => expect(document.querySelector(".screen.app")?.getAttribute("data-view")).toBe("focus"));
    const corner = await screen.findByRole("group", { name: "What Plugins are doing" });
    expect(within(corner).getByRole("progressbar", { name: "Scanning 10.0.0.0/24" })).toHaveAttribute("aria-valuenow", "25");
    await user.click(within(corner).getByRole("button", { name: "Stop Scanning 10.0.0.0/24" }));
    await notice("mesh: stopping");
    await user.keyboard(`${LEADER}:focus{Enter}`);
    await waitFor(() => expect(screen.queryByRole("group", { name: "What Plugins are doing" })).toBeNull());
    expect(document.querySelector(".statusbar .statusbar-progress")).not.toBeNull();
  });
});

describe("roster.cmd and a Plugin's command lines", () => {
  it("runs the Plugin's own finder, and refuses :plugins", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:go{Enter}`);
    expect(await screen.findByRole("dialog", { name: /Alerts/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.keyboard(`${LEADER}:sneak{Enter}`);
    expect(await screen.findByRole("alert", { name: "From mesh" })).toHaveTextContent(/roster.cmd: :plugins isn't one a Plugin may run/);
  });

  it("a button whose line the Plugin may not run says so and grants nothing", async () => {
    const user = await ready();
    await user.click(screen.getByRole("treeitem", { name: /ERROR disk full/ }));
    await user.click(screen.getByRole("button", { name: "Sneaky" }));
    await notice("mesh: :plugins isn't one a Plugin may run");
    await user.keyboard(`${LEADER}:plugins{Enter}`);
    const row = within(await screen.findByRole("region", { name: "Plugins" })).getByRole("listitem", { name: "mesh, running" });
    expect(within(row).queryByRole("switch", { name: /terminal\.write/ })).toBeNull();
  });
});

describe("a float's buttons and links", () => {
  it("run the Plugin's function by click or key, and open the link in the browser", async () => {
    const platform = everyMessage();
    const user = await ready([], platform);
    await user.keyboard(`${LEADER}:pop{Enter}`);
    const float = await screen.findByRole("complementary", { name: "esx-02 (from mesh)" });
    await user.keyboard("g");
    await notice("mesh: went");
    const link = within(float).getByRole("link", { name: /Runbook/ });
    expect(link).toHaveTextContent("wiki.example.com");
    await user.click(link);
    expect(platform.urlsOpened()).toEqual(["https://wiki.example.com/disk-full"]);
  });
});

describe("roster.sessions.show", () => {
  it("goes to the Session by its id and finds the line in it", async () => {
    const user = await ready();
    for (const name of ["linux-1-000", "esxi-2-001"]) {
      await user.keyboard(`${LEADER}f`);
      await user.keyboard(name);
      await user.keyboard("{Enter}");
      await screen.findByText(new RegExp(`Connected to ${name}`));
    }
    await user.keyboard(`${LEADER}:show 1{Enter}`);
    await waitFor(() => expect(screen.getByRole("group", { name: "Session linux-1-000" })).not.toHaveAttribute("hidden"));
    const shown = screen.getByRole("group", { name: "Session linux-1-000" });
    expect(shown.querySelector("[data-find]")).toHaveAttribute("data-find", "ERROR");
    await user.keyboard(`${LEADER}:show 9{Enter}`);
    await notice("mesh: there's no Session 9 now: it has ended");
  });
});

describe("a table's filter, per-row actions and an update of its columns", () => {
  it("/ filters by what the rows say; an action shows only where its when holds", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:view peers{Enter}`);
    const grid = await screen.findByRole("grid", { name: "Peers" });
    const selected = () => within(grid).getAllByRole("row").find((r) => r.getAttribute("aria-selected") === "true");
    expect(selected()).toHaveTextContent("esx-02");
    expect(within(selected() as HTMLElement).getByRole("button", { name: "Cut" })).toBeInTheDocument();
    await user.keyboard("j");
    expect(selected()).toHaveTextContent("pve-1");
    expect(within(selected() as HTMLElement).queryByRole("button", { name: "Cut" })).toBeNull();
    await user.keyboard("x");
    await user.keyboard("/nas{Enter}");
    expect(screen.getByText("1 of 3 rows", { exact: false })).toBeInTheDocument();
    expect(within(screen.getByRole("grid", { name: "Peers" })).getAllByRole("row")).toHaveLength(2);
    await user.keyboard("x");
    await notice("mesh: cut c");
    expect(screen.queryByText("mesh: cut b")).toBeNull();
    // Esc clears the filter first; the view stays open.
    await user.keyboard("{Escape}");
    expect(screen.getByText("3 rows", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("grid", { name: "Peers" })).toBeInTheDocument();
  });

  it("an update adds a column and sorts by it", async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:more{Enter}`);
    await user.keyboard(`${LEADER}:view peers{Enter}`);
    const grid = await screen.findByRole("grid", { name: "Peers" });
    expect(within(grid).getByRole("columnheader", { name: /State/ })).toHaveAttribute("aria-sort", "ascending");
    const rows = within(grid).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("pve-1");
  });
});
