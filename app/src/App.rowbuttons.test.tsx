// A Sidebar row's buttons show on the selected row only (decision Q88, ticket 68): hovering a row
// shows nothing, a left-click selects it, and in App mode the cursor row is the selected one, so
// j/k move them. Fake Backend, stub terminal. jsdom has no stylesheet, so this checks the classes
// styles.css keys on (styles.test.ts checks those rules).
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import { memoryPlatform } from "./platform/memory";
import { StubTerminal } from "./terminal/StubTerminal";

const LEADER = "{Control>} {/Control}";

async function ready() {
  const user = userEvent.setup();
  render(<App backend={fakeBackend({ hosts: makeHosts(12), apiVersion: 9 })} platform={memoryPlatform()} terminalView={StubTerminal} />);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return { user };
}

const inventory = () => screen.getByRole("group", { name: "Inventory" });
const item = (name: string) => within(inventory()).getByRole("treeitem", { name: new RegExp(`^${name}`) });
const rowOf = (name: string) => item(name).closest("li") as HTMLElement;
const selectedRows = () => Array.from(document.querySelectorAll(".sidebar .sb-row.selected, .sidebar .sb-heading.selected"));

describe("a Sidebar row's buttons (Q88)", () => {
  it("don't show on hover; a click selects the row and shows them there", async () => {
    const { user } = await ready();
    await user.hover(item("subnet-1"));
    expect(selectedRows()).toHaveLength(0);
    await user.click(item("subnet-1"));
    expect(rowOf("subnet-1")).toHaveClass("selected");
    expect(within(rowOf("subnet-1")).getByRole("button", { name: "Rename group subnet-1" })).toBeInTheDocument();
    // Another click moves them; hovering elsewhere doesn't.
    await user.click(item("subnet-2"));
    await user.hover(item("subnet-3"));
    expect(selectedRows()).toEqual([rowOf("subnet-2")]);
  });

  it("follow the cursor in App mode, and go with it when App mode ends (round 19)", async () => {
    const { user } = await ready();
    await user.click(item("subnet-1"));
    await user.keyboard(LEADER);
    // App mode starts on the selected row.
    expect(rowOf("subnet-1")).toHaveClass("cursor", "selected");
    await user.keyboard("j");
    const next = document.querySelector(".sidebar .sb-row.cursor") as HTMLElement;
    expect(next).not.toBe(rowOf("subnet-1"));
    expect(selectedRows()).toEqual([next]);
    await user.keyboard("{Escape}");
    expect(document.querySelector(".sidebar .cursor")).toBeNull();
    // Kept selected, its name in the text colour read as another live Session (Q332): outside App
    // mode it's drawn as any row, and App mode starts on it again.
    expect(selectedRows()).toEqual([]);
    await user.keyboard(LEADER);
    expect(document.querySelector(".sidebar .sb-row.cursor")).toBe(next);
  });

  it("select a heading too, whose buttons then show", async () => {
    const { user } = await ready();
    const heading = screen.getByRole("treeitem", { name: "Inventory" });
    await user.click(heading);
    expect(heading.closest(".sb-heading")).toHaveClass("selected");
  });
});
