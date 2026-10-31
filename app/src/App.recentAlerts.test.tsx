// Ticket 56 (#90): recent-alerts, the example third-party Plugin, end to end in the app, as a Package
// from a git URL. The fake Backend runs its stand-in (backend/fakeRecentAlerts.ts, checked against
// the real Lua by plugins/recentAlerts.test.ts), and its Sessions print scripted output
// (`backend.print`). The Lua itself, the git repo and the sandbox's limits are tested in
// crates/roster-core/tests/recent_alerts.rs.
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_HOST_PASSWORD, FAKE_PASSWORD, fakeBackend, makeHosts, type FakeBackend } from "./backend/fake";
import { fakeCommit, type FakePackages } from "./backend/fakePackages";
import { recentAlerts, type RecentAlertsOptions } from "./backend/fakeRecentAlerts";
import { SAVE_TO_VAULT_API_VERSION } from "./backend/types";
import { memoryPlatform, type MemoryPlatform } from "./platform/memory";
import { StubTerminal } from "./terminal/StubTerminal";

const LEADER = "{Control>} {/Control}";
const URL = "https://git.example.com/someone/recent-alerts.git";
const base = makeHosts(4);
// A reviewed Host that logs in with a key, and one whose Login is `auth: prompt`.
const HOST = base.hosts.find((h) => h.reviewed && h.ssh.auth === "key")!.name;
const PROMPTED = base.hosts.find((h) => h.reviewed && h.name !== HOST)!.name;
const hosts = {
  ...base,
  hosts: base.hosts.map((h) => (h.name === PROMPTED ? { ...h, enroll: false, ssh: { ...h.ssh, user: "root", auth: "prompt" } } : h)),
};

const packages = (options: RecentAlertsOptions = {}): FakePackages => ({
  named: [
    {
      name: "recent-alerts",
      source: URL,
      config: { patterns: ["ERROR", "panic"], leader: "w a" },
      versions: [{ commit: fakeCommit(1), subject: "v1.0.0", plugin: recentAlerts(options), diff: "" }],
    },
  ],
  lock: {},
});

interface Ready {
  user: ReturnType<typeof userEvent.setup>;
  backend: FakeBackend;
  pk: FakePackages;
  platform: MemoryPlatform;
}

async function ready(pk = packages(), repaints = false): Promise<Ready> {
  const user = userEvent.setup();
  const backend = fakeBackend({ hosts, packages: pk, apiVersion: SAVE_TO_VAULT_API_VERSION, repaints });
  const platform = memoryPlatform();
  render(<App backend={backend} terminalView={StubTerminal} platform={platform} />);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return { user, backend, pk, platform };
}

const prompt = () => screen.findByRole("alertdialog", { name: "Install recent-alerts?" });
const section = () => screen.getByRole("group", { name: "Recent alerts" });

async function installed(pk = packages(), repaints = false): Promise<Ready> {
  const r = await ready(pk, repaints);
  await r.user.click(within(await prompt()).getByRole("button", { name: "Install" }));
  await screen.findByText("No alerts. Lines with ERROR or panic show here.");
  return r;
}

/** Opens a Session to `host` and waits for its shell. */
async function connect({ user }: Ready, host = HOST) {
  await user.keyboard(`${LEADER}:connect ${host}{Enter}`);
  await within(await screen.findByRole("group", { name: `Session ${host}` })).findByText(`Connected to ${host}`, { exact: false });
}

describe("installing recent-alerts from its git URL", () => {
  it("asks first: its author, the URL and commit as unverified, terminal.read with its risk; Cancel installs nothing", async () => {
    const { user, pk } = await ready();
    const p = await prompt();
    expect(p).toHaveTextContent("by A. N. Author");
    expect(p).toHaveTextContent(`Unverified: from ${URL} at 1111111`);
    expect(within(p).getByText("terminal.read")).toBeInTheDocument();
    expect(p).toHaveTextContent("A password you type at a prompt that echoes it would be visible too");
    // The safe choice has the keys: Install is a deliberate move (decision Q87).
    expect(within(p).getAllByRole("button", { name: "Cancel" }).at(-1)).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByText("Recent alerts")).toBeNull();
    expect(pk.lock).toEqual({});
    expect(pk.clones).toEqual({});
  });
});

describe("a stray Enter", () => {
  it("right after unlocking (the prompt came up behind the lock screen) doesn't install it", async () => {
    const { user, pk } = await ready();
    await prompt();
    await user.keyboard("{Enter}");
    expect(pk.lock).toEqual({});
    expect(screen.queryByText("Recent alerts")).toBeNull();
  });


  it("isn't where the keys go once :tutor's demo is in front: the demo's workspace has them", async () => {
    const { user } = await ready();
    await prompt();
    // Nothing may try to focus the hidden, inert workspace's prompt from the demo's.
    const real = HTMLElement.prototype.focus;
    const intoHidden: string[] = [];
    const focused: HTMLElement[] = [];
    const spy = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      focused.push(this);
      if (this.closest(".app-slot[hidden]")) intoHidden.push(this.outerHTML.slice(0, 80));
      real.call(this, options);
    });
    try {
      await user.keyboard(`${LEADER}:tutor{Enter}`);
      await screen.findByRole("region", { name: "Demo Inventory" });
      await screen.findByRole("main", { name: /workspace/i });
      await screen.findByRole("complementary", { name: "Help" });
    } finally {
      spy.mockRestore();
    }
    expect(intoHidden).toEqual([]);
    expect(focused.some((e) => e.matches("main.workspace") && !e.closest(".app-slot[hidden]"))).toBe(true);
  });
});

describe("allowed", () => {
  it("lists what Sessions print that matches, with the Host and time; badges the Host; counts it; notices it", async () => {
    const r = await installed();
    expect(r.pk.lock).toEqual({ "recent-alerts": fakeCommit(1) });
    await connect(r);
    r.backend.print(HOST, "booting\r\n\x1b[31mERROR: disk /dev/sda1 full\x1b[0m\r\nok\r\n");
    const row = await within(section()).findByText("ERROR: disk /dev/sda1 full");
    expect(row.closest('[role="treeitem"]')).toHaveAttribute("title", expect.stringMatching(new RegExp(`^${HOST} at \\d\\d:\\d\\d:\\d\\d: ERROR`)));
    // The status segment opens its finder.
    expect(screen.getByText("⚠ 1")).toHaveAttribute("title", "1 recent alert");
    // The badge sits on the Host's Inventory row: a small count chip (ticket 73), named with its
    // Plugin for screen readers, and the address stays beside it.
    const inventory = screen.getByRole("group", { name: "Inventory" });
    const hostRow = within(inventory).getByRole("treeitem", { name: new RegExp(`^${HOST}, .*recent-alerts: 1`) });
    const chip = hostRow.querySelector(".sb-tag");
    expect(chip).toHaveTextContent(/^1$/);
    expect(chip).toHaveAttribute("title", "recent-alerts: 1");
    expect(hostRow.querySelector(".sb-detail")).not.toBeNull();
    expect(await screen.findByRole("alert", { name: "From recent-alerts" })).toHaveTextContent(`recent-alerts: ${HOST}: ERROR: disk /dev/sda1 full`);
  });

  it("your own command, echoed after the shell's prompt, isn't an alert; what it prints is", async () => {
    const r = await installed();
    await connect(r);
    const pane = screen.getByRole("group", { name: `Session ${HOST}` });
    await r.user.click(within(pane).getByLabelText("terminal input"));
    await r.user.keyboard("grep ERROR /var/log/syslog{Enter}");
    await within(pane).findByText(/grep ERROR \/var\/log\/syslog/);
    r.backend.print(HOST, "ERROR: from the log\r\n");
    expect(await within(section()).findByText("ERROR: from the log")).toBeInTheDocument();
    expect(within(section()).queryByText(/grep ERROR/)).toBeNull();
    expect(screen.getByText("⚠ 1")).toBeInTheDocument();
  });

  it("its row's buttons show the details in a float (Esc closes it), copy the line and dismiss it", async () => {
    const r = await installed();
    await connect(r);
    r.backend.print(HOST, "mounting\r\nERROR: disk /dev/sda1 full\r\n");
    await within(section()).findByText("ERROR: disk /dev/sda1 full");

    await r.user.click(screen.getByRole("button", { name: "Details of ERROR: disk /dev/sda1 full" }));
    const float = await screen.findByRole("complementary", { name: `Alert on ${HOST} (from recent-alerts)` });
    expect(float).toHaveTextContent("Matched ERROR");
    expect(float).toHaveTextContent("mounting");
    await r.user.keyboard(`${LEADER}{Escape}`);
    expect(screen.queryByRole("complementary", { name: /from recent-alerts/ })).toBeNull();

    await r.user.click(screen.getByRole("button", { name: "Copy ERROR: disk /dev/sda1 full" }));
    await waitFor(() => expect(r.platform.clipboardText()).toBe("ERROR: disk /dev/sda1 full"));

    await r.user.click(screen.getByRole("button", { name: "Dismiss ERROR: disk /dev/sda1 full" }));
    await waitFor(() => expect(screen.queryByText("⚠ 1")).toBeNull());
    expect(within(section()).queryByText("ERROR: disk /dev/sda1 full")).toBeNull();
    expect(document.querySelector(".sb-tag")).toBeNull();
  });

  // Ticket 73 (#126): on Windows each Details click added a copy of the alert. The float narrowed
  // the terminal, and ConPTY prints a resized Session's whole screen again, ERROR line and all.
  it("a Session that prints its screen again after a resize (ConPTY) doesn't add its alerts again", async () => {
    const r = await installed(packages(), true);
    await connect(r);
    r.backend.print(HOST, "mounting\r\nERROR: disk /dev/sda1 full\r\n");
    await screen.findByText("⚠ 1");
    // Focus and back: two resizes, two repaints of the screen.
    await r.user.keyboard(`${LEADER}m`);
    await r.user.keyboard(`${LEADER}m`);
    await new Promise((done) => setTimeout(done, 500));
    expect(screen.getByText("⚠ 1")).toBeInTheDocument();
    expect(within(section()).getAllByText("ERROR: disk /dev/sda1 full")).toHaveLength(1);
    // What's new still counts.
    r.backend.print(HOST, "ERROR: disk /dev/sdb1 full\r\n");
    expect(await screen.findByText("⚠ 2")).toBeInTheDocument();
  });

  it("its Leader key (from init.lua's settings) opens its finder; :alerts shows them; :alerts clear dismisses them", async () => {
    const r = await installed();
    await connect(r);
    r.backend.print(HOST, "kernel panic - not syncing\r\nERROR again\r\n");
    await screen.findByText("⚠ 2");
    // ␣ w a, as its config says, and listed with the app's own keys.
    await r.user.keyboard(`${LEADER}wa`);
    const finder = await screen.findByRole("dialog", { name: "Recent alerts" });
    expect(within(finder).getAllByRole("option").map((o) => o.textContent)).toEqual([
      expect.stringContaining("ERROR again"),
      expect.stringContaining("kernel panic - not syncing"),
    ]);
    await r.user.keyboard("{Enter}");
    expect(await screen.findByRole("complementary", { name: `Alert on ${HOST} (from recent-alerts)` })).toHaveTextContent("› ERROR again");
    await r.user.keyboard(`${LEADER}{Escape}`);

    await r.user.keyboard(`${LEADER}:alerts{Enter}`);
    expect(await screen.findByRole("complementary", { name: "Recent alerts (from recent-alerts)" })).toHaveTextContent("kernel panic");
    await r.user.keyboard(`${LEADER}{Escape}`);
    await r.user.keyboard(`${LEADER}:alerts clear{Enter}`);
    expect(await screen.findByText("No alerts. Lines with ERROR or panic show here.")).toBeInTheDocument();
    expect(screen.queryByText("⚠ 2")).toBeNull();
  });

  it("its help page is in :help, under its name", async () => {
    const { user } = await installed();
    await user.keyboard(`${LEADER}:help recent-alerts{Enter}`);
    const help = await screen.findByRole("complementary", { name: "Help" });
    expect(within(help).getAllByRole("heading", { level: 1 })[0]).toHaveTextContent("Recent alerts");
    // Its `␣` is drawn as the app draws the Leader.
    expect(help).toHaveTextContent("Leader w a finds one (:finder alerts)");
  });

  it("its section looks like the app's own: the same Sidebar markup as Sessions, a count, and it folds", async () => {
    const r = await installed();
    await connect(r);
    r.backend.print(HOST, "ERROR one\r\n");
    await screen.findByText("⚠ 1");
    const mine = section();
    const sessions = screen.getByRole("group", { name: "Sessions" });
    expect(mine.className).toBe(sessions.className);
    const heading = within(mine).getByRole("treeitem", { name: "Recent alerts" });
    expect(heading.className).toBe(within(sessions).getByRole("treeitem", { name: "Sessions" }).className);
    expect(within(heading).getByText("1")).toHaveClass("sb-count");
    expect(heading).toHaveAttribute("aria-expanded", "true");
    await r.user.click(heading);
    expect(heading).toHaveAttribute("aria-expanded", "false");
    expect(within(mine).queryByText("ERROR one")).toBeNull();
  });
});

describe("trust", () => {
  it("revoked in :plugins, its alerts go and no more output reaches it, at once", async () => {
    const r = await installed();
    await connect(r);
    r.backend.print(HOST, "ERROR one\r\n");
    await screen.findByText("⚠ 1");
    const events = vi.spyOn(r.backend, "pluginEvent");
    await r.user.keyboard(`${LEADER}:plugins{Enter}`);
    const row = within(await screen.findByRole("region", { name: "Plugins" })).getByRole("listitem", { name: "recent-alerts, running" });
    await r.user.click(within(row).getByRole("switch", { name: /terminal\.read/ }));
    expect(await screen.findByText("Allow terminal.read in :plugins to see alerts.")).toBeInTheDocument();
    expect(screen.queryByText("⚠ 1")).toBeNull();
    r.backend.print(HOST, "ERROR two\r\n");
    await new Promise((done) => setTimeout(done, 400));
    expect(events.mock.calls.filter(([name]) => name === "terminal_output")).toEqual([]);
    expect(screen.queryByText("ERROR two")).toBeNull();
  });

  it("an update that asks for more asks again; Escape keeps the version it has", async () => {
    const r = await installed();
    r.pk.named[0]?.versions.push({
      commit: fakeCommit(2),
      subject: "Open the Host of an alert",
      plugin: recentAlerts({ version: "2.0.0", permissions: ["terminal.read", "sessions.open"] }),
      diff: '+  permissions = { "terminal.read", "sessions.open" },',
    });
    await r.user.keyboard(`${LEADER}:packages update{Enter}`);
    const p = await screen.findByRole("alertdialog", { name: "Update recent-alerts?" });
    expect(p).toHaveTextContent("Its new version also asks to:");
    expect(p).toHaveTextContent("sessions.open");
    await r.user.keyboard("{Escape}");
    expect(r.pk.lock["recent-alerts"]).toBe(fakeCommit(1));
    expect(screen.getByText("No alerts. Lines with ERROR or panic show here.")).toBeInTheDocument();
  });

  it("an update that asks for network can't be used yet, and the version it has keeps running", async () => {
    const r = await installed();
    r.pk.named[0]?.versions.push({
      commit: fakeCommit(2),
      subject: "Post alerts to a webhook",
      plugin: recentAlerts({ version: "2.0.0", permissions: ["terminal.read", "network"] }),
      diff: "",
    });
    await r.user.keyboard(`${LEADER}:packages update{Enter}`);
    expect(await screen.findByText(/recent-alerts: its new version can't be used: .*"network" isn't available yet/)).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(r.pk.lock["recent-alerts"]).toBe(fakeCommit(1));
    await connect(r);
    r.backend.print(HOST, "ERROR still watched\r\n");
    expect(await screen.findByText("⚠ 1")).toBeInTheDocument();
  });

  it(":plugins remove leaves the app as it was", async () => {
    const r = await ready();
    const p = await prompt();
    const regions = () => screen.getAllByRole("group").map((e) => e.getAttribute("aria-label")).filter((n) => !n?.startsWith("Session "));
    const bar = () => document.querySelector(".statusbar")?.textContent;
    const before = { regions: regions(), bar: bar() };
    await r.user.click(within(p).getByRole("button", { name: "Install" }));
    await connect(r);
    r.backend.print(HOST, "ERROR one\r\n");
    await screen.findByText("⚠ 1");
    await r.user.keyboard(`${LEADER}:plugins remove recent-alerts{Enter}`);
    await screen.findByText(/Removed recent-alerts/);
    expect(r.pk.lock).toEqual({});
    expect(r.pk.clones).toEqual({});
    expect(document.querySelector(".sb-tag")).toBeNull();
    // The Session it watched is open now; otherwise the Sidebar and status bar are as they were.
    expect(regions()).toEqual(before.regions);
    expect(bar()?.replace(/⚠ \d+/, "")).toBe(before.bar);
    await r.user.keyboard(`${LEADER}:alerts{Enter}`);
    expect(document.querySelector(".message-line")).toHaveTextContent(/alerts/);
  });

  it("a version that throws is stopped and named, its UI goes, and the app keeps working", async () => {
    const r = await installed(packages({ throwsOn: "BAD" }));
    await connect(r);
    for (const n of [1, 2, 3]) {
      r.backend.print(HOST, `BAD ${n}\r\n`);
      const said = `recent-alerts: init.lua: BAD in the output${n === 3 ? ". It's disabled." : ""}`;
      await waitFor(() => expect(screen.queryAllByRole("alert", { name: "From recent-alerts" })).toHaveLength(n));
      expect(screen.getAllByRole("alert", { name: "From recent-alerts" }).at(-1)).toHaveTextContent(said);
    }
    await waitFor(() => expect(screen.queryByRole("group", { name: "Recent alerts" })).toBeNull());
    await r.user.keyboard(`${LEADER}:plugins{Enter}`);
    expect(within(await screen.findByRole("region", { name: "Plugins" })).getByRole("listitem", { name: "recent-alerts, stopped" })).toBeInTheDocument();
    // The app carries on: the Session still prints, the Picker still opens.
    r.backend.print(HOST, "still here\r\n");
    await r.user.keyboard("{Escape}");
    await r.user.keyboard(`${LEADER}f`);
    expect(await screen.findByRole("dialog", { name: "Find a Host" })).toBeInTheDocument();
  });

  it("a password typed at the app's prompt never reaches it; what the Session prints does", async () => {
    const r = await installed();
    const events = vi.spyOn(r.backend, "pluginEvent");
    await r.user.keyboard(`${LEADER}:connect ${PROMPTED}{Enter}`);
    const pane = await screen.findByRole("group", { name: `Session ${PROMPTED}` });
    const q = await within(pane).findByRole("alertdialog", { name: `Password for ${PROMPTED}` });
    await r.user.click(within(q).getByLabelText("Password for root"));
    await r.user.keyboard(`${FAKE_HOST_PASSWORD}{Enter}`);
    await within(pane).findByText(`Connected to ${PROMPTED}`, { exact: false });
    r.backend.print(PROMPTED, "ERROR after login\r\n");
    await screen.findByText("⚠ 1");
    const sent = JSON.stringify(events.mock.calls);
    expect(sent).toContain("ERROR after login");
    expect(sent).not.toContain(FAKE_HOST_PASSWORD);
    expect(document.body.innerHTML).not.toContain(FAKE_HOST_PASSWORD);
  });
});
