// The Inventory tree and Folders in the Sidebar (ticket 17), through the App with the fake
// Backend, a stub terminal and an in-memory State file.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts } from "./backend/fake";
import { memoryPlatform } from "./platform/memory";
import { StubTerminal } from "./terminal/StubTerminal";

const hosts = makeHosts(12);
const LEADER = "{Control>} {/Control}";

async function ready(platform = memoryPlatform()) {
  const user = userEvent.setup();
  const view = render(<App backend={fakeBackend({ hosts })} platform={platform} terminalView={StubTerminal} />);
  await screen.findByText(/12 hosts/i);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return { user, platform, view };
}

const inventory = () => screen.getByRole("group", { name: "Inventory" });
const folders = () => screen.getByRole("group", { name: "Folders" });
const sessionList = () => screen.getByRole("group", { name: "Sessions" });
const inv = (name: string) => within(inventory()).getByRole("treeitem", { name: new RegExp(`^${name}`) });
const rowOf = (el: HTMLElement) => el.closest("li") as HTMLElement;
const cursorRow = () => document.querySelector(".sidebar .cursor");
const output = () => screen.getByLabelText("terminal output", { selector: ":not([hidden]) > pre" });
const sessionCount = () => within(sessionList()).queryAllByRole("treeitem", { name: /^(?!Sessions$)/ }).length;

describe("The Inventory section", () => {
  it("lists every Host under its roster.yml group, with counts and addresses", async () => {
    await ready();
    const group = within(inventory()).getByRole("treeitem", { name: /^subnet-2/ });
    expect(group).toHaveTextContent("3");
    const host = within(inventory()).getByRole("treeitem", { name: /^linux-1-000/ });
    expect(host).toHaveTextContent("10.19.1.2");
    expect(within(inventory()).getAllByRole("treeitem", { name: /^\w+-\d-\d{3}/ })).toHaveLength(12);
  });

  it("badges an unreviewed Host and won't connect to it", async () => {
    const { user } = await ready();
    const host = within(inventory()).getByRole("treeitem", { name: /^switch-4-003/ });
    expect(host).toHaveTextContent(/unreviewed/);
    await user.click(host);
    expect(screen.getByRole("status")).toHaveTextContent(/switch-4-003 isn't reviewed yet/);
    expect(screen.queryByLabelText("terminal output")).toBeNull();
  });
});

describe("Clicking a Host row (iteration 3 feedback: the Sidebar snapped up)", () => {
  it("keeps the Sidebar where it's scrolled: no cursor jumps to the top, and the new Session gets the keys", async () => {
    const scrolled: string[] = [];
    // jsdom has no scrollIntoView; the Sidebar calls it when its cursor moves.
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.getAttribute("data-row") ?? this.className);
    };
    try {
      const { user } = await ready();
      await user.click(inv("linux-1-000"));
      await within(output()).findByText(/Connected to linux-1-000/);
      expect(document.activeElement).toHaveAccessibleName("terminal input");
      scrolled.length = 0;
      // A Host row can be dragged, so its mousedown goes ahead and focus would move to the tree:
      // that must not count as Tab reaching the tree (App mode, cursor on the top row, scrolled to it).
      await user.click(inv("esxi-2-001"));
      await within(output()).findByText(/Connected to esxi-2-001/);
      expect(scrolled).toEqual([]);
      expect(cursorRow()).toBeNull();
      expect(document.activeElement).toHaveAccessibleName("terminal input");
      await user.click(inv("linux-1-000"));
      expect(scrolled).toEqual([]);
      expect(document.activeElement).toHaveAccessibleName("terminal input");
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });
});

describe("Moving and folding", () => {
  it("walks the tree with j/k, folds with h and unfolds with l", async () => {
    const { user } = await ready();
    // From the top: Sessions, Folders, Inventory, subnet-1, its first Host.
    await user.keyboard(`${LEADER}gg`);
    expect(cursorRow()).toHaveAttribute("data-row", "section:sessions");
    await user.keyboard("jjjj");
    expect(cursorRow()).toHaveAttribute("data-row", "inventory:linux-1-000");
    await user.keyboard("h");
    expect(cursorRow()).toHaveAttribute("data-row", "group:subnet-1");
    await user.keyboard("h");
    expect(within(inventory()).queryByRole("treeitem", { name: /^linux-1-000/ })).toBeNull();
    expect(within(inventory()).getByRole("treeitem", { name: /^subnet-1/ })).toHaveAttribute("aria-expanded", "false");
    await user.keyboard("j");
    expect(cursorRow()).toHaveAttribute("data-row", "group:subnet-2");
    await user.keyboard("kl");
    expect(inv("linux-1-000")).toBeInTheDocument();
    await user.keyboard("l");
    expect(cursorRow()).toHaveAttribute("data-row", "inventory:linux-1-000");
    // Enter on a group folds it and stays in the Sidebar.
    await user.keyboard("k{Enter}");
    expect(within(inventory()).queryByRole("treeitem", { name: /^linux-1-000/ })).toBeNull();
    expect(screen.getByText("APP")).toBeInTheDocument();
    await user.keyboard("{ArrowRight}");
    expect(inv("linux-1-000")).toBeInTheDocument();
  });

  it("folds a whole section, with the cursor moving out of it", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}G`);
    await user.keyboard(":");
    await user.keyboard("fold section:inventory{Enter}");
    expect(within(inventory()).queryAllByRole("treeitem")).toHaveLength(1);
    await user.click(within(inventory()).getByRole("treeitem", { name: "Inventory" }));
    expect(within(inventory()).getAllByRole("treeitem").length).toBeGreaterThan(12);
  });

  it("folds and unfolds a group with a click on it", async () => {
    const { user } = await ready();
    await user.click(within(inventory()).getByRole("treeitem", { name: /^subnet-3/ }));
    expect(within(inventory()).queryByRole("treeitem", { name: /^proxmox-3-010/ })).toBeNull();
    await user.click(within(inventory()).getByRole("treeitem", { name: /^subnet-3/ }));
    expect(inv("proxmox-3-010")).toBeInTheDocument();
  });

  it("remembers what's folded in State, across a restart", async () => {
    const platform = memoryPlatform();
    const { user, view } = await ready(platform);
    await user.click(within(inventory()).getByRole("treeitem", { name: /^subnet-2/ }));
    await user.click(screen.getByRole("treeitem", { name: "Sessions" }));
    await vi.waitFor(() => expect(platform.saved()).toMatchObject({ folded: ["group:subnet-2", "section:sessions"] }));
    view.unmount();
    await ready(platform);
    expect(within(inventory()).getByRole("treeitem", { name: /^subnet-2/ })).toHaveAttribute("aria-expanded", "false");
    expect(within(inventory()).queryByRole("treeitem", { name: /^linux-2-/ })).toBeNull();
    expect(screen.getByRole("treeitem", { name: "Sessions" })).toHaveAttribute("aria-expanded", "false");
  });
});

describe("Opening Hosts from the tree", () => {
  it("Enter opens a Session, and jumps to it when one is open", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}ggjjjj{Enter}`);
    await within(output()).findByText(/Connected to linux-1-000/);
    await user.click(inv("esxi-2-001"));
    await within(output()).findByText(/Connected to esxi-2-001/);
    expect(sessionCount()).toBe(2);
    await user.click(inv("linux-1-000"));
    expect(output()).toHaveTextContent("Connected to linux-1-000");
    expect(sessionCount()).toBe(2);
  });

  it("raises the Host on screen where it first appears, and only brightens it further down", async () => {
    const { user } = await ready();
    await user.click(inv("linux-1-000"));
    await within(output()).findByText(/Connected to linux-1-000/);
    expect(within(sessionList()).getByRole("treeitem", { current: true })).toHaveAccessibleName(/^linux-1-000/);
    expect(rowOf(inv("linux-1-000"))).toHaveClass("also");
    expect(rowOf(inv("linux-1-000"))).not.toHaveClass("raised");
    // With Sessions folded, the Inventory's row is the first one.
    await user.click(screen.getByRole("treeitem", { name: "Sessions" }));
    expect(rowOf(inv("linux-1-000"))).toHaveClass("raised");
  });
});

describe("Folders", () => {
  it("creates, renames and deletes Folders from the command line", async () => {
    const { user } = await ready();
    expect(within(folders()).getByText(/No Folders yet/)).toBeInTheDocument();
    await user.keyboard(`${LEADER}:folder new Lab ESXi{Enter}`);
    expect(within(folders()).getByRole("treeitem", { name: /^Lab ESXi/ })).toBeInTheDocument();
    await user.keyboard(`${LEADER}:folder rename Lab ESXi Daily{Enter}`);
    expect(within(folders()).getByRole("treeitem", { name: /^Daily/ })).toBeInTheDocument();
    await user.click(within(folders()).getByRole("button", { name: "Delete Folder Daily" }));
    expect(within(folders()).queryByRole("treeitem", { name: /^Daily/ })).toBeNull();
  });

  it("still folds a Folder by its old id (:fold folder:NAME)", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:folder new Lab{Enter}`);
    await user.keyboard(`${LEADER}:fold folder:Lab{Enter}`);
    expect(within(folders()).getByRole("treeitem", { name: /^Lab/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("adds the Host under the cursor with ␣ a, and removes it with ␣ A", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}ggjjjj`);
    await user.keyboard("a");
    const input = screen.getByRole("combobox", { name: "Command" });
    expect(input).toHaveValue("folder add linux-1-000 ");
    await user.keyboard("Lab{Enter}");
    const inFolder = within(folders()).getByRole("treeitem", { name: /^linux-1-000/ });
    expect(inFolder).toHaveTextContent("10.19.1.2");
    await user.keyboard(`${LEADER}ggjjj`);
    expect(cursorRow()).toHaveAttribute("data-row", "folders:Lab/linux-1-000");
    await user.keyboard("A");
    expect(within(folders()).queryByRole("treeitem", { name: /^linux-1-000/ })).toBeNull();
    expect(within(folders()).getByRole("treeitem", { name: /^Lab/ })).toHaveTextContent("0");
  });

  it("adds a Host by dragging it onto a Folder, and removes it by dragging it out", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:folder new Lab{Enter}`);
    fireEvent.dragStart(rowOf(inv("esxi-2-001")));
    fireEvent.dragOver(within(folders()).getByRole("treeitem", { name: /^Lab/ }));
    fireEvent.drop(within(folders()).getByRole("treeitem", { name: /^Lab/ }));
    // The Folders Plugin answers a drop (ticket 61): it comes a moment later.
    const inFolder = await within(folders()).findByRole("treeitem", { name: /^esxi-2-001/ });
    fireEvent.dragStart(rowOf(inFolder));
    fireEvent.dragOver(inv("linux-1-000"));
    fireEvent.drop(inv("linux-1-000"));
    await vi.waitFor(() => expect(within(folders()).queryByRole("treeitem", { name: /^esxi-2-001/ })).toBeNull());
    expect(inv("esxi-2-001")).toBeInTheDocument();
  });

  it("opens a Host from a Folder, and won't open an unreviewed one", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:folder add switch-4-003 Lab{Enter}`);
    await user.click(within(folders()).getByRole("treeitem", { name: /^switch-4-003/ }));
    expect(screen.getByRole("status")).toHaveTextContent(/isn't reviewed yet/);
    await user.keyboard(`${LEADER}:folder add linux-1-000 Lab{Enter}`);
    await user.click(within(folders()).getByRole("treeitem", { name: /^linux-1-000/ }));
    await within(output()).findByText(/Connected to linux-1-000/);
  });

  it("keeps Folders in the Folders Plugin's own data across a restart, never in the State or roster serve", async () => {
    const platform = memoryPlatform({ state: { version: 1, recentHosts: [], somethingNewer: { keep: true } } });
    const calls: unknown[] = [];
    const fake = fakeBackend({ hosts });
    const backend = new Proxy(fake, {
      get: (target, prop, receiver) => {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function"
          ? (...args: unknown[]) => {
              // The Plugin host is the core's, not roster serve's: Folders' own calls go there.
              if (!String(prop).startsWith("plugin")) calls.push([prop, ...args.filter((a) => typeof a !== "object" || a === null || !("output" in a))]);
              return value.apply(target, args);
            }
          : value;
      },
    });
    const user = userEvent.setup();
    const view = render(<App backend={backend} platform={platform} terminalView={StubTerminal} />);
    await screen.findByText(/12 hosts/i);
    await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    await screen.findByRole("main", { name: /workspace/i });
    await user.keyboard(`${LEADER}:folder add linux-1-000 Secret Lab{Enter}`);
    await user.click(await within(folders()).findByRole("treeitem", { name: /^linux-1-000/ }));
    await within(output()).findByText(/Connected to linux-1-000/);
    expect(fake.pluginFiles("folders").get("folders.json")).toMatch(/Secret Lab/);
    await vi.waitFor(() => expect(platform.saved()).toMatchObject({ somethingNewer: { keep: true } }));
    expect(JSON.stringify(platform.saved())).not.toMatch(/Secret Lab/);
    expect(JSON.stringify(calls)).not.toMatch(/Secret Lab/);
    view.unmount();
    render(<App backend={backend} platform={platform} terminalView={StubTerminal} />);
    await screen.findByText(/12 hosts/i);
    await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    expect(await within(folders()).findByRole("treeitem", { name: /^Secret Lab/ })).toBeInTheDocument();
  });

});
