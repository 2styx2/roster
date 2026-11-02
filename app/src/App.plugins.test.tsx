// Plugins in the app (ticket 23): `:plugins install` asks with each permission's risk, an
// installed Plugin's section, status segment, command, key, finder and help page look like the
// app's own, `:plugins` revokes at once, and a broken Plugin is named in a toast.
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import type { FakePlugin } from "./backend/fakePlugins";
import { memoryPlatform } from "./platform/memory";
import { StubTerminal } from "./terminal/StubTerminal";

const LEADER = "{Control>} {/Control}";
const PATH = "~/plugins/recent-alerts";

const alerts: FakePlugin = {
  manifest: { name: "recent-alerts", version: "1.0.0", description: "Lines that look like trouble", author: "A. Author", api: 2, permissions: ["terminal.read"] },
  load(roster) {
    const list = ["ERROR disk full"];
    const show = () => {
      roster.sidebar.set("alerts", {
        title: "Recent alerts",
        rows: list.map((text, i) => ({
          id: String(i),
          label: text,
          detail: "linux-1-000",
          actions: [{ label: `Dismiss ${text}`, icon: "close", run: () => (list.splice(i, 1), show()) }],
        })),
      });
      roster.status.set("alerts", { text: `⚠ ${list.length}`, title: "Recent alerts" });
      roster.finders.set("alerts", { title: "Alerts", items: list.map((text) => ({ label: text, run: "alerts" })) });
      roster.badges.set("linux-1-000", list.length ? `${list.length} alert` : null);
    };
    roster.commands.add("alerts", { desc: "Show the alerts", run: () => roster.float.open({ title: "Alerts", lines: list }) });
    roster.keymap.set("leader", "y y", "alerts");
    roster.help.set("recent-alerts", { title: "Recent alerts", markdown: "# Recent alerts\n\nLines your Sessions print that look like trouble." });
    show();
  },
};

const broken: FakePlugin = {
  manifest: { name: "broken", version: "1.0.0", description: "", author: null, api: 2, permissions: [] },
  load() {
    throw new Error("attempt to index a nil value");
  },
};

async function ready(platform = memoryPlatform()) {
  const user = userEvent.setup();
  const backend = fakeBackend({ hosts: makeHosts(12), plugins: { [PATH]: alerts, "~/plugins/broken": broken } });
  render(<App backend={backend} terminalView={StubTerminal} platform={platform} />);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return user;
}

async function install(user: ReturnType<typeof userEvent.setup>, path = PATH) {
  await user.keyboard(`${LEADER}:plugins install ${path}{Enter}`);
}

describe(":plugins install", () => {
  it("asks first: who, from where (unverified), each permission with its risk; Cancel installs nothing", async () => {
    const user = await ready();
    await install(user);
    const prompt = await screen.findByRole("alertdialog", { name: "Install recent-alerts?" });
    expect(prompt).toHaveTextContent("Unverified: from ~/plugins/recent-alerts");
    expect(prompt).toHaveTextContent("terminal.read");
    expect(prompt).toHaveTextContent(/A password you type at a prompt that echoes it would be visible too/);
    expect(within(prompt).getAllByRole("button", { name: "Cancel" }).at(-1)).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByText("Recent alerts")).toBeNull();
  });

  it("Install: its section, badge, status segment, command, key, finder and help page appear", async () => {
    const user = await ready();
    await install(user);
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Install" }));
    expect(await screen.findByText("Recent alerts", { selector: "*" })).toBeInTheDocument();
    expect(screen.getByText("ERROR disk full")).toBeInTheDocument();
    expect(screen.getByText("⚠ 1")).toHaveAttribute("title", "Recent alerts");
    expect(screen.getByText("12 Hosts")).toBeInTheDocument();
    // Its Leader key runs its command, which opens its float.
    await user.keyboard(`${LEADER}yy`);
    const float = await screen.findByRole("complementary", { name: "Alerts (from recent-alerts)" });
    expect(float).toHaveTextContent("ERROR disk full");
    await user.keyboard(`${LEADER}{Escape}`);
    expect(screen.queryByRole("complementary", { name: /from recent-alerts/ })).toBeNull();
    // Its row action is a button like the app's own.
    await user.click(screen.getByRole("button", { name: "Dismiss ERROR disk full" }));
    expect(await screen.findByText("⚠ 0")).toBeInTheDocument();
  });

  it("a Plugin that throws is named in a toast with its file, and :plugins says it's stopped", async () => {
    const user = await ready();
    await install(user, "~/plugins/broken");
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Install" }));
    expect(await screen.findByRole("alert", { name: "From broken" })).toHaveTextContent(
      "broken: init.lua: attempt to index a nil value. It's disabled.",
    );
    await user.keyboard(`${LEADER}:plugins{Enter}`);
    const panel = await screen.findByRole("region", { name: "Plugins" });
    expect(within(panel).getByRole("listitem", { name: "broken, stopped" })).toBeInTheDocument();
    expect(within(panel).getByRole("listitem", { name: "hosts, running" })).toHaveTextContent("built into roster");
  });
});

describe(":plugins", () => {
  it("lists each Plugin's permissions as switches; turning one off applies at once", async () => {
    const platform = memoryPlatform();
    const user = await ready(platform);
    await install(user);
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Install" }));
    await screen.findByText("⚠ 1");
    await user.keyboard(`${LEADER}:plugins{Enter}`);
    const row = within(await screen.findByRole("region", { name: "Plugins" })).getByRole("listitem", { name: "recent-alerts, running" });
    const toggle = within(row).getByRole("switch", { name: /terminal\.read/ });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(await within(row).findByRole("switch", { name: /terminal\.read/ })).not.toBeChecked();
  });

  it("remove takes its UI away", async () => {
    const user = await ready();
    await install(user);
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Install" }));
    await screen.findByText("⚠ 1");
    await user.keyboard(`${LEADER}:plugins remove recent-alerts{Enter}`);
    await screen.findByText("Removed recent-alerts");
    expect(screen.queryByText("⚠ 1")).toBeNull();
    expect(screen.queryByText("ERROR disk full")).toBeNull();
  });
});

describe("the Host count", () => {
  it("is the built-in hosts Plugin, and follows the Inventory", async () => {
    const user = userEvent.setup();
    const backend = fakeBackend({ hosts: makeHosts(12), apiVersion: 8 });
    render(<App backend={backend} terminalView={StubTerminal} platform={memoryPlatform()} />);
    await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    expect(await screen.findByText("12 Hosts")).toHaveAttribute("title", "From hosts");
    await backend.watchInventory(true);
    backend.outsideEdit(makeHosts(13));
    expect(await screen.findByText("13 Hosts")).toBeInTheDocument();
  });
});

// Ticket 74: a tab closed while its Session ran still names its Host in session_exit.
describe("session_exit", () => {
  it("names the Host of a tab closed while its Session ran", async () => {
    const heard: unknown[] = [];
    const watcher: FakePlugin = {
      manifest: { name: "watcher", version: "1.0.0", description: "", author: null, api: 3, permissions: ["inventory.read"] },
      load(roster) {
        roster.on("session_open", (e) => void heard.push({ open: e.host }));
        roster.on("session_exit", (e) => void heard.push({ host: e.host, code: e.code }));
      },
    };
    const user = userEvent.setup();
    const backend = fakeBackend({ hosts: makeHosts(12), plugins: { "~/plugins/watcher": watcher } });
    render(<App backend={backend} terminalView={StubTerminal} platform={memoryPlatform()} />);
    await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    await screen.findByRole("main", { name: /workspace/i });
    await install(user, "~/plugins/watcher");
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Install" }));
    const host = makeHosts(12).hosts[0]!.name;
    await user.keyboard(`${LEADER}:connect ${host}{Enter}`);
    await waitFor(() => expect(heard).toEqual([{ open: host }]));
    await user.keyboard(`${LEADER}:close{Enter}`);
    await waitFor(() => expect(heard).toEqual([{ open: host }, { host, code: null }]));
  });
});

// Ticket 101 (decision Q112): serve's jobs push their progress (API 20), and the app hands each
// to the Plugins as `job_progress`, a Mesh job only to one that may ask `mesh.job`.
describe("job_progress", () => {
  async function watching(apiVersion: number) {
    const heard: unknown[] = [];
    const follower: FakePlugin = {
      manifest: { name: "follower", version: "1.0.0", description: "", author: null, api: 3, permissions: ["serve:mesh.job"] },
      load(roster) {
        roster.on("job_progress", (e) => void heard.push({ kind: e.kind, job: e.job, state: e.state, done: e.done }));
      },
    };
    const user = userEvent.setup();
    const backend = fakeBackend({ hosts: makeHosts(3), apiVersion, plugins: { "~/plugins/follower": follower } });
    render(<App backend={backend} terminalView={StubTerminal} platform={memoryPlatform()} />);
    await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    await screen.findByRole("main", { name: /workspace/i });
    await install(user, "~/plugins/follower");
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    return { heard, backend };
  }
  const job = { action: "apply", total: 4, at: null } as const;

  it("reaches a Plugin that may ask about that kind of job, and only that kind", async () => {
    const { heard, backend } = await watching(20);
    backend.jobProgress({ kind: "discover", job: "scan-1", state: "running", done: 0, ...job, action: "scan" });
    backend.jobProgress({ kind: "mesh", job: 3, state: "running", done: 1, ...job });
    backend.jobProgress({ kind: "mesh", job: 3, state: "done", done: 4, ...job });
    await waitFor(() =>
      expect(heard).toEqual([
        { kind: "mesh", job: 3, state: "running", done: 1 },
        { kind: "mesh", job: 3, state: "done", done: 4 },
      ]),
    );
  });

  it("isn't listened for from a serve before API 20", async () => {
    const { heard, backend } = await watching(19);
    backend.jobProgress({ kind: "mesh", job: 3, state: "running", done: 1, ...job });
    await new Promise((r) => setTimeout(r, 50));
    expect(heard).toEqual([]);
  });
});
