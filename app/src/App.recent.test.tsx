// The idle pane's Recent Hosts (decision Q218): with no Session open, the pane lists the Hosts you
// opened last (still in the Inventory and reviewed), each one click away; with no history it's the
// plain empty state.
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import { memoryPlatform } from "./platform/memory";
import { builtinRegistries } from "./registries";
import { StubTerminal } from "./terminal/StubTerminal";

const hosts = makeHosts(12);
const reviewed = hosts.hosts.filter((h) => h.reviewed).map((h) => h.name);
const unreviewed = hosts.hosts.find((h) => !h.reviewed)?.name ?? "";

async function ready(recentHosts: string[]) {
  const user = userEvent.setup();
  const platform = memoryPlatform({ state: { version: 1, recentHosts, folded: [] } });
  render(<App backend={fakeBackend({ hosts })} terminalView={StubTerminal} registries={builtinRegistries()} platform={platform} />);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return user;
}

describe("the idle pane's Recent Hosts", () => {
  it("lists the Hosts opened last, leaving out unreviewed and unknown ones", async () => {
    await ready([reviewed[2] ?? "", "gone-from-roster", unreviewed, reviewed[0] ?? ""]);
    const recent = screen.getByRole("region", { name: "Recent" });
    expect(Array.from(recent.querySelectorAll(".recent-name")).map((n) => n.textContent)).toEqual([reviewed[2], reviewed[0]]);
  });

  it("opens a Host with a click", async () => {
    const user = await ready([reviewed[1] ?? ""]);
    await user.click(within(screen.getByRole("region", { name: "Recent" })).getByRole("button"));
    expect(await screen.findByRole("group", { name: `Session ${reviewed[1]}` })).toBeInTheDocument();
  });

  it("with no history yet, starts from the Inventory's first reviewed Hosts", async () => {
    await ready([]);
    expect(screen.queryByRole("region", { name: "Recent" })).toBeNull();
    const first = screen.getByRole("region", { name: "In the Inventory" });
    expect(Array.from(first.querySelectorAll(".recent-name")).map((n) => n.textContent)).toEqual(reviewed.slice(0, 6));
    // The Sidebar shows its own Find field, so the pane's Find is a quiet line, not a filled button.
    const find = within(screen.getByRole("main", { name: /workspace/i })).getByRole("button", { name: /^Find a Host/ });
    expect(find).not.toHaveClass("primary");
  });
});
