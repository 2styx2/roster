// Ticket 44 (#72): plugins/discover, the first-party Plugin for scanning a network, end to end in
// the app, as `?fixture=discover` has it: installed as a Package from roster's repo and granted,
// with roster serve's discover.* answered by the fake Backend (backend/fakeDiscover.ts). The fake
// runs its stand-in for the Lua, checked against the real Lua by plugins/discover.test.ts; the Lua
// itself is tested in crates/roster-core/tests/plugin_discover.rs, and serve in
// tests/test_serve_discover.py.
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { fakeBackend, fixtures } from "./backend/fake";
import { fixtureProps } from "./backend/fixtureProps";
import { memoryPlatform } from "./platform/memory";
import { StubTerminal } from "./terminal/StubTerminal";

const LEADER = "{Control>} {/Control}";
const notice = (text: string | RegExp) => screen.findByText(text, { selector: ".config-toast-title" }, { timeout: 8000 });

async function ready(name = "discover") {
  const user = userEvent.setup();
  const scenario = fixtures[name]!;
  render(<App backend={fakeBackend(scenario)} terminalView={StubTerminal} {...fixtureProps(scenario.app, memoryPlatform())} />);
  await screen.findByRole("main", { name: /workspace/i });
  await screen.findByRole("button", { name: "Scan a network for Hosts" }, { timeout: 5000 });
  return user;
}

const grid = () => screen.findByRole("grid", { name: "Discover" }, { timeout: 8000 });
const row = async (text: string) => within(await grid()).getAllByRole("row").find((r) => r.textContent?.includes(text))!;

describe("scanning from the app", () => {
  it("asks first, then shows what answered as it comes in, with the progress in the status bar", { timeout: 20000 }, async () => {
    const user = await ready();
    await user.click(screen.getByRole("button", { name: "Scan a network for Hosts" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Scan 10.0.0.0/24? (from discover)" });
    expect(dialog).toHaveTextContent("254 addresses on 47 TCP ports, with nmap");
    expect(dialog).toHaveTextContent("Scan only networks you may");
    expect(within(dialog).getByRole("button", { name: "Scan" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("progressbar", { name: "Scanning 10.0.0.0/24" }, { timeout: 5000 })).toBeInTheDocument();
    await notice("discover: Scan done: 6 Hosts answered, 5 new");
    expect(screen.queryByRole("progressbar", { name: "Scanning 10.0.0.0/24" })).toBeNull();
    const known = await row("10.0.0.5");
    expect(known).toHaveTextContent("in the Inventory as host-03");
    expect(await row("10.0.0.7")).toHaveTextContent("appliance");
  });

  it("keeps rows with m, adds the kept ones with A after asking, as Pending changes", { timeout: 20000 }, async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:discover 10.0.0.0/24{Enter}`);
    await user.click(within(await screen.findByRole("alertdialog", { name: /Scan 10\.0\.0\.0\/24/ })).getByRole("button", { name: "Scan" }));
    await notice(/Scan done/);
    await user.click(within(await row("10.0.0.7")).getAllByRole("gridcell")[0]!);
    await user.keyboard("m");
    await waitFor(async () => expect(await row("10.0.0.7")).toHaveTextContent("✓"));
    await user.keyboard("A");
    const dialog = await screen.findByRole("alertdialog", { name: "Add 1 Host to the Inventory? (from discover)" });
    expect(dialog).toHaveTextContent("appliance");
    await user.keyboard("{Enter}");
    await notice("discover: Added 1 Host to discovered-20261031 as Pending changes: review them in :changes, then Publish");
    expect(await row("10.0.0.7")).toHaveTextContent("added as appliance");
  });

  it("i (or Enter) shows a row's details in a float, with its web page", { timeout: 20000 }, async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:discover 10.0.0.0/24{Enter}`);
    await user.keyboard("{Enter}");
    await notice(/Scan done/);
    // After the question, focus is in the view's table, not on the view (ticket 91).
    const grid = screen.getByRole("grid", { name: "Discover" });
    await waitFor(() => expect(grid).toHaveFocus());
    await user.click(within(await row("10.0.0.7")).getAllByRole("gridcell")[1]!);
    await user.keyboard("i");
    const float = await screen.findByRole("complementary", { name: "appliance (from discover)" });
    expect(float).toHaveTextContent("Appliance login");
    expect(within(float).getByRole("link", { name: /Its web page/ })).toBeInTheDocument();
    // Esc closes the float, and focus goes back to the table it was opened from.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("complementary", { name: "appliance (from discover)" })).toBeNull();
    expect(screen.getByRole("grid", { name: "Discover" })).toHaveFocus();
  });

  it(":help discover is the Plugin's page, and :check has its section", { timeout: 20000 }, async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:help discover{Enter}`);
    expect(await screen.findByText(/You keep the ones you want and add them/)).toBeInTheDocument();
    await user.keyboard(`${LEADER}:check{Enter}`);
    expect(await screen.findByText(/roster serve can scan, with nmap/, undefined, { timeout: 8000 })).toBeInTheDocument();
  });

  it("a range over 4,096 addresses asks in the stronger form, with the range typed", { timeout: 20000 }, async () => {
    const user = await ready();
    await user.keyboard(`${LEADER}:discover 10.0.0.0/16{Enter}`);
    const dialog = await screen.findByRole("alertdialog", { name: /Scan 10\.0\.0\.0\/16/ });
    expect(dialog).toHaveTextContent("65,534 addresses");
    const scan = within(dialog).getByRole("button", { name: "Scan" });
    expect(scan).toBeDisabled();
    await user.keyboard("10.0.0.0/16");
    expect(scan).toBeEnabled();
  });

  it("a /16 where 12,000 answer: the view keeps 10,000 and says so", { timeout: 60000 }, async () => {
    const user = await ready("discover-worst");
    await user.keyboard(`${LEADER}:discover 10.0.0.0/16{Enter}`);
    await user.keyboard("10.0.0.0/16{Enter}");
    await notice(/Scan done: 12,000 Hosts answered/);
    expect(await screen.findByText(/it keeps the first 10,000/)).toBeInTheDocument();
    expect(screen.getByText("10,000 rows", { exact: false })).toBeInTheDocument();
  });
});
