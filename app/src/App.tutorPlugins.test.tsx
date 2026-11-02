// The user's Plugins inside `:tutor`'s demo (ticket 66, #113, decision Q123), through the App with
// the fake Backend: the Plugins running in your workspace load in the demo too, with the grants you
// gave them, so a Plugin's tutorial can teach the Plugin itself. There they see the demo's Hosts,
// get a refusal from roster serve for anything the demo has no stand-in for, keep their files in a
// throwaway folder, and one that fails to load leaves the tutor running.
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import { fakeCommit } from "./backend/fakePackages";
import type { FakePlugin } from "./backend/fakePlugins";
import { memoryPlatform } from "./platform/memory";
import { StubTerminal } from "./terminal/StubTerminal";

const LEADER = "{Control>} {/Control}";

/** A Plugin with a tutorial about its own command, `:coach`. */
const coach: FakePlugin = {
  manifest: { name: "coach", version: "1.0.0", description: "", author: null, api: 3, permissions: ["inventory.read", "serve:mesh.status"] },
  load(roster) {
    roster.commands.add("coach", {
      desc: "Count the Hosts",
      run: () => {
        roster.notify(`${roster.inventory?.hosts().length ?? 0} Hosts, ${roster.storage.list().length} files`);
        roster.storage.write("seen.txt", "yes");
        try {
          roster.serve?.call("mesh.status");
        } catch (e) {
          roster.notify(String(e instanceof Error ? e.message : e), "warn");
        }
      },
    });
    roster.tutor.set("coach", {
      title: "Coach",
      summary: "The coach Plugin",
      intro: "Learn **coach**.",
      lessons: [{ title: "Count", text: "Run it.", steps: [{ id: "run", text: "Run `:coach`", on: { event: "command", id: "coach" } }] }],
    });
  },
};

const broken: FakePlugin = {
  manifest: { name: "broken", version: "1.0.0", description: "", author: null, api: 3, permissions: [] },
  load(roster) {
    // Fine in your workspace, broken on the demo's six Hosts.
    if (roster.storage.read("ok") === null) throw new Error("attempt to index a nil value");
  },
};

async function ready() {
  const user = userEvent.setup();
  const backend = fakeBackend({ hosts: makeHosts(12), plugins: { "~/plugins/coach": coach, "~/plugins/broken": broken } });
  backend.pluginFiles("broken").set("ok", "1");
  const platform = memoryPlatform({
    state: {
      plugins: [
        { path: "~/plugins/coach", name: "coach", granted: ["inventory.read", "serve:mesh.status"], asked: ["inventory.read", "serve:mesh.status"] },
        { path: "~/plugins/broken", name: "broken", granted: [], asked: [] },
      ],
    },
  });
  render(<App backend={backend} terminalView={StubTerminal} platform={platform} />);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return { user, backend, platform };
}

const help = () => screen.getByRole("complementary", { name: "Help" });
const banner = () => screen.queryByRole("region", { name: "Demo Inventory" });

describe(":tutor with your Plugins", () => {
  it("a Plugin's tutorial teaches its own command, on the demo's Hosts, and your workspace's Plugin is untouched", async () => {
    const { user, backend } = await ready();
    // In your workspace: twelve Hosts.
    await user.keyboard(`${LEADER}:coach{Enter}`);
    expect(await screen.findByText("coach: 12 Hosts, 0 files")).toBeInTheDocument();

    await user.keyboard(`${LEADER}:tutor coach{Enter}`);
    await waitFor(() => expect(banner()).not.toBeNull());
    await screen.findByRole("complementary", { name: "Help" });
    expect(within(help()).getAllByRole("heading", { level: 1 })[0]).toHaveTextContent("Coach");
    const step = () => help().querySelector(".help-step") as HTMLElement;
    expect(step()).not.toHaveAttribute("data-done");

    await user.keyboard(`${LEADER}:coach{Enter}`);
    // The demo's six Hosts, and a data folder of its own that starts empty.
    expect(await screen.findByText("coach: 6 Hosts, 0 files")).toBeInTheDocument();
    expect(await screen.findByText(/coach: roster\.serve\.call mesh\.status: mesh\.status isn't on the demo Inventory/)).toBeInTheDocument();
    await waitFor(() => expect(step()).toHaveAttribute("data-done"));

    await user.keyboard(`${LEADER}:tutor quit{Enter}`);
    await waitFor(() => expect(banner()).toBeNull());
    // Your workspace's coach: its files are its own (only what it wrote itself), its Hosts yours.
    expect([...backend.pluginFiles("coach").keys()]).toEqual(["seen.txt"]);
    await user.keyboard(`${LEADER}:coach{Enter}`);
    expect(await screen.findByText("coach: 12 Hosts, 1 files")).toBeInTheDocument();
  });

  it("a Plugin that fails to load in the demo is named, and the tutor runs on", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:tutor{Enter}`);
    await waitFor(() => expect(banner()).not.toBeNull());
    expect(await screen.findByText(/broken: .*attempt to index a nil value/)).toBeInTheDocument();
    await screen.findByRole("complementary", { name: "Help" });
    expect(within(help()).getAllByRole("heading", { level: 1 })[0]).toHaveTextContent("roster tutor");
    await user.keyboard(`${LEADER}:coach{Enter}`);
    expect(await screen.findByText("coach: 6 Hosts, 0 files")).toBeInTheDocument();
  });

  it("only a Plugin running in your workspace comes along, with the grants it has there", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:plugins revoke coach inventory.read{Enter}`);
    await user.keyboard(`${LEADER}:coach{Enter}`);
    expect(await screen.findByText("coach: 0 Hosts, 0 files")).toBeInTheDocument();
    await user.keyboard(`${LEADER}:tutor coach{Enter}`);
    await waitFor(() => expect(banner()).not.toBeNull());
    await screen.findByRole("complementary", { name: "Help" });
    await user.keyboard(`${LEADER}:coach{Enter}`);
    // It ran in the demo (its step ticked), still without inventory.read.
    await waitFor(() => expect(help().querySelector(".help-step")).toHaveAttribute("data-done"));
    expect(screen.queryByText("coach: 6 Hosts, 0 files")).toBeNull();
  });

  it("a Package comes along from the clone you have, and the demo fetches nothing", async () => {
    const user = userEvent.setup();
    const commit = fakeCommit(1);
    const backend = fakeBackend({
      hosts: makeHosts(12),
      packages: {
        named: [{ name: "coach", source: "https://git.example.com/someone/coach.git", config: {}, versions: [{ commit, subject: "v1.0.0", plugin: coach, diff: "" }] }],
        lock: { coach: commit },
        clones: { coach: commit },
      },
    });
    const perms = ["inventory.read", "serve:mesh.status"];
    const platform = memoryPlatform({ state: { plugins: [{ path: "package:coach", name: "coach", granted: perms, asked: perms }] } });
    render(<App backend={backend} terminalView={StubTerminal} platform={platform} />);
    await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    await screen.findByRole("main", { name: /workspace/i });
    await user.keyboard(`${LEADER}:coach{Enter}`);
    expect(await screen.findByText("coach: 12 Hosts, 0 files")).toBeInTheDocument();
    await user.keyboard(`${LEADER}:tutor coach{Enter}`);
    await waitFor(() => expect(banner()).not.toBeNull());
    await screen.findByRole("complementary", { name: "Help" });
    await user.keyboard(`${LEADER}:coach{Enter}`);
    expect(await screen.findByText("coach: 6 Hosts, 0 files")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("if the demo can't run your Plugins, it says why once and runs with roster's own only", async () => {
    const user = userEvent.setup();
    const backend = fakeBackend({ hosts: makeHosts(12), plugins: { "~/plugins/coach": coach } });
    backend.demoPlugins = () => Promise.reject(new Error("no room in the temp folder"));
    const perms = ["inventory.read", "serve:mesh.status"];
    const platform = memoryPlatform({ state: { plugins: [{ path: "~/plugins/coach", name: "coach", granted: perms, asked: perms }] } });
    render(<App backend={backend} terminalView={StubTerminal} platform={platform} />);
    await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    await screen.findByRole("main", { name: /workspace/i });
    await user.keyboard(`${LEADER}:tutor{Enter}`);
    await waitFor(() => expect(banner()).not.toBeNull());
    expect(await screen.findAllByText(/Your Plugins aren't in the demo: no room in the temp folder/)).toHaveLength(1);
    // Not loaded on roster's own fake host either: no load error for it, no :coach.
    expect(screen.queryByText(/coach: /)).toBeNull();
    await screen.findByRole("complementary", { name: "Help" });
    await user.keyboard(`${LEADER}:coach{Enter}`);
    expect(screen.queryByText("coach: 6 Hosts, 0 files")).toBeNull();
  });

  it("leaving stops the demo's Plugins: no timer of theirs reaches the demo's host after it closed", async () => {
    const user = userEvent.setup();
    const ticker: FakePlugin = {
      manifest: { name: "ticker", version: "1", description: "", author: null, api: 3, permissions: [] },
      load(roster) {
        const tick = () => {
          roster.status.set("tick", { text: "tick" });
          roster.defer(50, tick);
        };
        roster.defer(50, tick);
      },
    };
    const backend = fakeBackend({ hosts: makeHosts(12), plugins: { "~/plugins/ticker": ticker } });
    const real = backend.demoPlugins?.bind(backend);
    let closed = false;
    let calls = 0;
    let late = 0;
    backend.demoPlugins = async (hosts) => {
      const host = await (real as NonNullable<typeof real>)(hosts);
      return {
        ...host,
        pluginCall: (...args: Parameters<typeof host.pluginCall>) => {
          calls++;
          if (closed) late++;
          return host.pluginCall(...args);
        },
        close: async () => {
          closed = true;
        },
      };
    };
    const platform = memoryPlatform({ state: { plugins: [{ path: "~/plugins/ticker", name: "ticker", granted: [], asked: [] }] } });
    render(<App backend={backend} terminalView={StubTerminal} platform={platform} />);
    await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    await screen.findByRole("main", { name: /workspace/i });
    await user.keyboard(`${LEADER}:tutor{Enter}`);
    await waitFor(() => expect(banner()).not.toBeNull());
    await waitFor(() => expect(calls).toBeGreaterThan(1));
    await user.keyboard(`${LEADER}:tutor quit{Enter}`);
    await waitFor(() => expect(banner()).toBeNull());
    expect(closed).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(late).toBe(0);
  });
});
