// Packages in the app (ticket 24): a Package init.lua names asks first with its git URL as the
// unverified source; `:packages` lists it; `:packages update` shows the new commit and its diff,
// and Escape keeps the version it has.
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import { fakeCommit, type FakePackages } from "./backend/fakePackages";
import type { FakePlugin } from "./backend/fakePlugins";
import { memoryPlatform } from "./platform/memory";
import { StubTerminal } from "./terminal/StubTerminal";

const LEADER = "{Control>} {/Control}";

const alerts = (version: string, permissions: string[]): FakePlugin => ({
  manifest: { name: "recent-alerts", version, description: "Lines that look like trouble", author: "A. Author", api: 2, permissions },
  load(roster) {
    roster.status.set("alerts", { text: `⚠ ${version}` });
  },
});

async function ready(packages: FakePackages) {
  const user = userEvent.setup();
  const backend = fakeBackend({ hosts: makeHosts(4), packages });
  render(<App backend={backend} terminalView={StubTerminal} platform={memoryPlatform()} />);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return user;
}

const packages = (): FakePackages => ({
  named: [
    {
      name: "recent-alerts",
      source: "someone/recent-alerts",
      tag: "v1.0.0",
      versions: [{ commit: fakeCommit(1), subject: "First", plugin: alerts("1.0.0", ["terminal.read"]), diff: "" }],
    },
  ],
  lock: {},
});

describe("Packages", () => {
  it("asks before installing, from its git URL (unverified); `:packages` lists it", async () => {
    const pk = packages();
    const user = await ready(pk);
    const prompt = await screen.findByRole("alertdialog", { name: "Install recent-alerts?" });
    expect(prompt).toHaveTextContent("Unverified: from https://github.com/someone/recent-alerts.git at 1111111");
    await user.click(within(prompt).getByRole("button", { name: "Install" }));
    expect(await screen.findByText("⚠ 1.0.0")).toBeInTheDocument();
    expect(pk.lock).toEqual({ "recent-alerts": fakeCommit(1) });

    await user.keyboard(`${LEADER}:packages{Enter}`);
    const panel = await screen.findByRole("region", { name: "Packages" });
    expect(within(panel).getByLabelText("recent-alerts, running")).toHaveTextContent("tag v1.0.0");
  });

  it("`:packages update` shows the new commit and diff; Escape keeps the version it has", async () => {
    const pk = packages();
    pk.lock["recent-alerts"] = fakeCommit(1);
    const user = await ready(pk);
    await user.click(within(await screen.findByRole("alertdialog", { name: "Install recent-alerts?" })).getByRole("button", { name: "Install" }));
    await screen.findByText("⚠ 1.0.0");
    pk.named[0]?.versions.push({ commit: fakeCommit(2), subject: "Type into Sessions", plugin: alerts("2.0.0", ["terminal.read", "terminal.write"]), diff: "+-- types now" });

    await user.keyboard(`${LEADER}:packages update{Enter}`);
    const prompt = await screen.findByRole("alertdialog", { name: "Update recent-alerts?" });
    expect(prompt).toHaveTextContent("1111111 to 2222222");
    expect(prompt).toHaveTextContent("Type into Sessions");
    expect(within(prompt).getByLabelText(/What changes from/)).toHaveTextContent("+-- types now");
    expect(prompt).toHaveTextContent("terminal.write");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(pk.lock["recent-alerts"]).toBe(fakeCommit(1));
    expect(screen.getByText("⚠ 1.0.0")).toBeInTheDocument();
  });

  it("a cancelled install shows in `:packages` and isn't asked again; `:packages install NAME` asks", async () => {
    const pk = packages();
    const user = await ready(pk);
    await screen.findByRole("alertdialog", { name: "Install recent-alerts?" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    await user.keyboard(`${LEADER}:packages{Enter}`);
    const panel = await screen.findByRole("region", { name: "Packages" });
    expect(within(panel).getByLabelText("recent-alerts, cancelled")).toHaveTextContent(":packages install recent-alerts asks again");
    await user.keyboard("{Escape}");

    await user.keyboard(`${LEADER}:packages install recent-alerts{Enter}`);
    await user.click(within(await screen.findByRole("alertdialog", { name: "Install recent-alerts?" })).getByRole("button", { name: "Install" }));
    expect(await screen.findByText("⚠ 1.0.0")).toBeInTheDocument();
  });

  it("`:packages update NAME` checks that Package", async () => {
    const pk = packages();
    pk.lock["recent-alerts"] = fakeCommit(1);
    const user = await ready(pk);
    await user.click(within(await screen.findByRole("alertdialog", { name: "Install recent-alerts?" })).getByRole("button", { name: "Install" }));
    await screen.findByText("⚠ 1.0.0");
    pk.named[0]?.versions.push({ commit: fakeCommit(2), subject: "Faster", plugin: alerts("2.0.0", ["terminal.read"]), diff: "+fast" });
    await user.keyboard(`${LEADER}:packages update recent-alerts{Enter}`);
    expect(await screen.findByRole("alertdialog", { name: "Update recent-alerts?" })).toHaveTextContent("Faster");
  });

  it("from a folder of a repo, the prompt and `:packages` show the folder (Q94)", async () => {
    const pk = packages();
    pk.named = [{ name: "recent-alerts", source: "someone/roster", dir: "plugins/recent-alerts", versions: pk.named[0]!.versions }];
    const user = await ready(pk);
    const prompt = await screen.findByRole("alertdialog", { name: "Install recent-alerts?" });
    expect(prompt).toHaveTextContent("Unverified: from https://github.com/someone/roster.git, folder plugins/recent-alerts, at 1111111.");
    await user.click(within(prompt).getByRole("button", { name: "Install" }));
    await screen.findByText("⚠ 1.0.0");

    await user.keyboard(`${LEADER}:packages{Enter}`);
    const panel = await screen.findByRole("region", { name: "Packages" });
    expect(within(panel).getByLabelText("recent-alerts, running")).toHaveTextContent("https://github.com/someone/roster.git, folder plugins/recent-alerts");
  });
});
