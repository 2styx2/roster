// The Sidebar for assistive tech and the keyboard (ticket 29: M3, M4, M6, S11), through the App
// with the fake Backend and a stub terminal. Fixture Hosts (backend/fake.ts makeHosts): linux-1-000
// logs in with a vault password, esxi-2-001 with this Box's key, switch-4-003 is unreviewed.
import { describe, expect, it } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "../backend/fake";
import { StubTerminal } from "../terminal/StubTerminal";

const hosts = makeHosts(12);
const LEADER = "{Control>} {/Control}";

async function ready() {
  const user = userEvent.setup();
  render(<App backend={fakeBackend({ hosts })} terminalView={StubTerminal} />);
  await screen.findByText(/12 hosts/i);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return user;
}

const tree = () => screen.getByRole("tree", { name: "Sessions and Hosts" });
const inventory = () => within(tree()).getByRole("group", { name: "Inventory" });
const item = (name: RegExp) => within(tree()).getByRole("treeitem", { name });
const output = () => screen.getByLabelText("terminal output", { selector: ":not([hidden]) > pre" });
/** The tree item the tree's aria-activedescendant points at. */
const active = () => {
  const id = tree().getAttribute("aria-activedescendant");
  return id ? document.getElementById(id) : null;
};

describe("The Sidebar as a tree (M4)", () => {
  it("is a named tree of sections, with each row's level and folding", async () => {
    await ready();
    expect(within(tree()).getByRole("treeitem", { name: "Inventory" })).toHaveAttribute("aria-level", "1");
    const group = within(inventory()).getByRole("treeitem", { name: /^subnet-1/ });
    expect(group).toHaveAttribute("aria-level", "2");
    expect(group).toHaveAttribute("aria-expanded", "true");
    expect(within(inventory()).getByRole("treeitem", { name: /^linux-1-000/ })).toHaveAttribute("aria-level", "3");
  });

  it("takes focus in App mode, with the cursor row as its active descendant", async () => {
    const user = await ready();
    await user.click(item(/^linux-1-000/));
    await within(output()).findByText(/Connected to linux-1-000/);
    const terminal = document.activeElement;
    await user.keyboard(LEADER);
    expect(tree()).toHaveFocus();
    // It starts on the row that was clicked, the selected one (decision Q88): the Inventory's.
    expect(active()).toHaveAccessibleName(/^linux-1-000/);
    expect(active()).toHaveAttribute("aria-level", "3");
    expect(active()).toHaveAttribute("aria-selected", "true");
    await user.keyboard("j");
    expect(active()).toHaveAccessibleName(/^router-1-004/);
    // Esc goes back to the terminal, focus too.
    await user.keyboard("{Escape}");
    expect(tree()).not.toHaveAttribute("aria-activedescendant");
    expect(document.activeElement).toBe(terminal);
  });

  it("is a Tab stop after Find a Host; focusing it enters App mode, and arrows move its cursor", async () => {
    const user = await ready();
    const find = within(screen.getByRole("navigation", { name: "Sidebar" })).getByRole("button", { name: /^Find a Host/ });
    act(() => find.focus());
    await user.tab();
    expect(tree()).toHaveFocus();
    expect(screen.getByText("APP")).toBeInTheDocument();
    // Its first stop is the first Host, not a section heading (round 18).
    expect(active()).toHaveAccessibleName(/^linux-1-000/);
    await user.keyboard("{ArrowDown}");
    expect(active()).toHaveAccessibleName(/^router-1-004/);
  });

  it("starts App mode on the Session on screen, else on the first Host (round 18)", async () => {
    const user = await ready();
    await user.keyboard(LEADER);
    // No Session open: the first Host, never a heading (it was the Sessions heading, then FOLDERS).
    expect(active()).toHaveAccessibleName(/^linux-1-000/);
    await user.keyboard("{Escape}");
    await user.keyboard(`${LEADER}:open esxi-2-001{Enter}`);
    await within(output()).findByText(/Connected to esxi-2-001/);
    await user.keyboard(LEADER);
    // A Session open: its own row in Sessions.
    expect(active()).toHaveAccessibleName(/^esxi-2-001/);
    expect(active()?.closest('[role="group"]')).toHaveAccessibleName("Sessions");
  });
});

describe("Row state in words, not only colour (M3)", () => {
  it("names how each Host logs in, and that an unreviewed one can't be opened", async () => {
    await ready();
    expect(item(/^linux-1-000/)).toHaveAccessibleName("linux-1-000, password login, 10.19.1.2");
    expect(item(/^esxi-2-001/)).toHaveAccessibleName(/^esxi-2-001, key login, /);
    expect(item(/^switch-4-003/)).toHaveAccessibleName(/^switch-4-003, unreviewed, can't be opened, /);
  });

  it("names an ended Session as ended", async () => {
    const user = await ready();
    await user.click(item(/^linux-1-000/));
    await within(output()).findByText(/Connected to linux-1-000/);
    await user.keyboard("exit{Enter}");
    const sessions = within(tree()).getByRole("group", { name: "Sessions" });
    expect(await within(sessions).findByRole("treeitem", { name: "linux-1-000, ended" })).toBeInTheDocument();
  });

  it("draws each state as a node of its own shape", async () => {
    await ready();
    const node = (name: RegExp) => item(name).querySelector(".dot");
    expect(node(/^esxi-2-001/)).toHaveAttribute("data-shape", "filled");
    expect(node(/^linux-1-000/)).toHaveAttribute("data-shape", "ring");
    expect(node(/^switch-4-003/)).toHaveAttribute("data-shape", "dashed");
  });
});

describe("The live Session (S11)", () => {
  it("marks the on-screen Session's row live, and not once it has ended", async () => {
    const user = await ready();
    await user.click(item(/^linux-1-000/));
    await within(output()).findByText(/Connected to linux-1-000/);
    const sessions = within(tree()).getByRole("group", { name: "Sessions" });
    const row = () => within(sessions).getByRole("treeitem", { current: true }).closest("li");
    expect(row()).toHaveClass("live");
    await user.keyboard("exit{Enter}");
    await within(sessions).findByRole("treeitem", { name: /ended/ });
    expect(row()).not.toHaveClass("live");
  });
});

describe("Whole names from the keyboard (M6)", () => {
  it("App mode shows the cursor row's whole name, state and address below the tree", async () => {
    const user = await ready();
    expect(screen.queryByTestId("sidebar-details")).toBeNull();
    await user.keyboard(`${LEADER}ggjjjj`);
    const details = screen.getByTestId("sidebar-details");
    expect(details).toHaveTextContent("linux-1-000");
    expect(details).toHaveTextContent("password login");
    expect(details).toHaveTextContent("10.19.1.2");
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("sidebar-details")).toBeNull();
  });
});
