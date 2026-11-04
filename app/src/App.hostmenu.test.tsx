// A Host row's menu (T166, #314, decision Q156): a Host row shows no buttons, even selected; a
// right-click, or the Menu key or Shift+F10 on the App-mode cursor, opens a menu of what the row's
// buttons did and the Host's other commands. It's an ARIA menu: arrows, Home/End, a letter, Enter,
// Esc and Tab, and focus goes back where it was. Each item runs the command line its button or
// key ran. Fake Backend, stub terminal.
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import { memoryPlatform } from "./platform/memory";
import { StubTerminal } from "./terminal/StubTerminal";

const LEADER = "{Control>} {/Control}";
const hosts = makeHosts(12);
const UNREVIEWED = hosts.hosts[3]?.name ?? "";

async function ready(apiVersion = 9) {
  const user = userEvent.setup();
  render(<App backend={fakeBackend({ hosts, apiVersion })} platform={memoryPlatform()} terminalView={StubTerminal} />);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return { user };
}

const inventory = () => screen.getByRole("group", { name: "Inventory" });
const item = (name: string) => within(inventory()).getByRole("treeitem", { name: new RegExp(`^${name}(,|$)`) });
const rowOf = (name: string) => item(name).closest("li") as HTMLElement;
const menu = () => screen.getByRole("menu");
const items = () => within(menu()).getAllByRole("menuitem").map((m) => m.querySelector(".row-menu-label")?.textContent);
const rightClick = (el: HTMLElement, at = { clientX: 40, clientY: 60 }) => fireEvent.contextMenu(el, { button: 2, ...at });

describe("a Host row's menu (T166, Q156)", () => {
  it("replaces the selected row's buttons", async () => {
    const { user } = await ready();
    await user.click(item("linux-1-000"));
    expect(rowOf("linux-1-000")).toHaveClass("selected");
    expect(within(rowOf("linux-1-000")).queryAllByRole("button")).toEqual([]);
    // A group's heading row keeps its buttons (it isn't a Host).
    await user.click(within(inventory()).getByRole("treeitem", { name: /^subnet-1/ }));
    expect(within(rowOf("subnet-1")).getByRole("button", { name: "Rename group subnet-1" })).toBeInTheDocument();
  });

  it("opens on a right-click with the Host's commands, and runs the one chosen", async () => {
    const { user } = await ready();
    rightClick(item("linux-1-000"));
    expect(menu()).toHaveAccessibleName("linux-1-000");
    expect(items()).toEqual([
      "Open",
      "New Session",
      "Details",
      "Check",
      "Edit…",
      "Rename…",
      "Move to another group…",
      "Add to a Folder…",
      "Remove from the Inventory…",
    ]);
    // The row is selected, as a left-click would.
    expect(rowOf("linux-1-000")).toHaveClass("selected");
    await user.click(within(menu()).getByRole("menuitem", { name: /^Details/ }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(await screen.findByRole("complementary", { name: "Details of linux-1-000" })).toBeInTheDocument();
  });

  it("Rename and Remove run what the ✎ and × did", async () => {
    const { user } = await ready();
    rightClick(item("linux-1-000"));
    await user.click(within(menu()).getByRole("menuitem", { name: /^Remove from the Inventory/ }));
    expect(await screen.findByRole("alertdialog", { name: "Remove linux-1-000?" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    rightClick(item("linux-1-000"));
    await user.click(within(menu()).getByRole("menuitem", { name: /^Rename/ }));
    expect(screen.getByRole("combobox", { name: "Command" })).toHaveValue("host rename linux-1-000 ");
  });

  it("offers Mark reviewed first on an unreviewed Host, and no Open", async () => {
    await ready();
    rightClick(item(UNREVIEWED));
    expect(items()[0]).toBe("Mark reviewed");
    expect(items()).not.toContain("Open");
  });

  it("leaves out what this roster can't do (no Live Inventory)", async () => {
    await ready(5);
    rightClick(item("linux-1-000"));
    expect(items()).toEqual(["Open", "New Session", "Details", "Check", "Edit…", "Add to a Folder…"]);
  });

  it("is a keyboard menu: arrows, Home/End, a letter, Esc puts focus back", async () => {
    const { user } = await ready();
    const terminal = document.activeElement;
    rightClick(item("linux-1-000"));
    // Opened by the pointer: focus is on the menu, no item yet.
    expect(menu()).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    // The click opens a Session (asynchronously), so the first item is Open or, once that Session
    // is there, "Go to its Session".
    expect(within(menu()).getByRole("menuitem", { name: /^(Open|Go to its Session)\b/ })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(within(menu()).getByRole("menuitem", { name: /^Remove/ })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(within(menu()).getByRole("menuitem", { name: /^(Open|Go to its Session)\b/ })).toHaveFocus();
    await user.keyboard("{End}");
    expect(within(menu()).getByRole("menuitem", { name: /^Remove/ })).toHaveFocus();
    await user.keyboard("c");
    expect(within(menu()).getByRole("menuitem", { name: /^Check/ })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(terminal);
  });

  it("opens from the Menu key and Shift+F10 on the App-mode cursor, on its first item", async () => {
    const { user } = await ready();
    await user.click(item("linux-1-000"));
    await user.keyboard(LEADER);
    expect(rowOf("linux-1-000")).toHaveClass("cursor");
    await user.keyboard("{ContextMenu}");
    expect(menu()).toHaveAccessibleName("linux-1-000");
    expect(within(menu()).getByRole("menuitem", { name: /^(Open|Go to its Session)\b/ })).toHaveFocus();
    // Esc goes back to the tree, still in App mode.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("tree")).toHaveFocus();
    expect(rowOf("linux-1-000")).toHaveClass("cursor");
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(menu()).toBeInTheDocument();
    // Enter runs the item and leaves App mode, as Enter on a row does.
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(await screen.findByRole("complementary", { name: "Details of linux-1-000" })).toBeInTheDocument();
  });

  it("says so on a row that isn't a Host", async () => {
    const { user } = await ready();
    await user.keyboard(LEADER);
    // The cursor starts on the first row: the Sessions heading or the Inventory's.
    await user.keyboard("{ContextMenu}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(await screen.findByText(/Only a Host's row has a menu/)).toBeInTheDocument();
  });

  it("closes on a click outside, and on Tab", async () => {
    const { user } = await ready();
    rightClick(item("linux-1-000"));
    await user.click(screen.getByRole("main", { name: /workspace/i }));
    expect(screen.queryByRole("menu")).toBeNull();
    rightClick(item("linux-1-000"));
    await user.keyboard("{ArrowDown}{Tab}");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on a scroll, but not on the late event of one from before it opened (T173)", async () => {
    await ready();
    const tree = screen.getByRole("tree");
    // The App-mode cursor scrolls its row into view at once, but the browser fires that scroll's
    // event on the next frame: a menu key pressed in between opened the menu, then that event
    // closed it.
    tree.scrollTop = 40;
    rightClick(item("linux-1-000"));
    fireEvent.scroll(tree);
    expect(menu()).toBeInTheDocument();
    // A scroll after it opened closes it.
    tree.scrollTop = 80;
    fireEvent.scroll(tree);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("stays inside the window", async () => {
    await ready();
    rightClick(item("linux-1-000"), { clientX: window.innerWidth - 2, clientY: window.innerHeight - 2 });
    // jsdom lays nothing out: give the menu a size and check where it's put.
    const m = menu();
    await waitFor(() => expect(m.style.left).not.toBe(""));
    expect(parseFloat(m.style.left)).toBeLessThanOrEqual(window.innerWidth);
    expect(parseFloat(m.style.top)).toBeLessThanOrEqual(window.innerHeight);
  });

  it("a Folder's Host row has the Folder's own action in its menu, not as a button", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:folder add linux-1-000 Lab{Enter}`);
    const folders = await screen.findByRole("group", { name: "Folders" });
    const row = await within(folders).findByRole("treeitem", { name: /^linux-1-000/ });
    await user.click(row);
    expect(within(row.closest("li") as HTMLElement).queryAllByRole("button")).toEqual([]);
    rightClick(row);
    expect(within(menu()).getByRole("menuitem", { name: /Remove linux-1-000 from Lab/ })).toBeInTheDocument();
  });
});

describe("a Host row's menu with worst-case names (break-ui)", () => {
  it("a long Plugin action keeps its whole text in its name and tooltip, cut on screen", async () => {
    const { user } = await ready();
    const folder = "Racks-in-the-second-building-north-wing-cold-aisle-טבלה-🧪";
    await user.keyboard(`${LEADER}:folder add linux-1-000 ${folder}{Enter}`);
    const folders = await screen.findByRole("group", { name: "Folders" });
    rightClick(await within(folders).findByRole("treeitem", { name: /^linux-1-000/ }));
    const action = within(menu()).getByRole("menuitem", { name: `Remove linux-1-000 from ${folder}` });
    const label = action.querySelector(".row-menu-label") as HTMLElement;
    expect(label).toHaveAttribute("title", `Remove linux-1-000 from ${folder}`);
    expect(label).toHaveAttribute("dir", "auto");
  });
});
