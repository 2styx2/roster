// Ticket 28 through the App with the fake Backend: the Live Inventory. Hosts and groups are added,
// removed, renamed and moved from the Sidebar (row buttons, `+`, drag between groups), by key and
// by `:` command, each a Pending change; removing asks first and names the Host. Outside edits to
// roster.yml update the Sidebar in place with auto_reload, else wait for `:source` behind a quiet
// hint; a broken one keeps the last good Inventory and says the line. folders.yml's Folders move into
// the Folders Plugin once.
import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App, servicesLeftOut } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts, type FakeBackend } from "./backend/fake";
import { configWith, defaultConfig } from "./config/fixture";
import type { Config, ConfigReport } from "./config/types";
import { memoryPlatform } from "./platform/memory";
import { builtinRegistries } from "./registries";
import { StubTerminal } from "./terminal/StubTerminal";

const LEADER = "{Control>} {/Control}";
const hosts = makeHosts(6);

async function ready(opts: { config?: Config; folders?: string | null; apiVersion?: number } = {}) {
  const user = userEvent.setup();
  const backend: FakeBackend = fakeBackend({ hosts, apiVersion: opts.apiVersion ?? 8 });
  const report: ConfigReport = { config: opts.config ?? defaultConfig, error: null, path: "/home/me/.config/roster/init.lua", version: 1 };
  const platform = memoryPlatform({ config: report, ...(opts.folders !== undefined ? { folders: opts.folders } : {}) });
  render(<App backend={backend} terminalView={StubTerminal} registries={builtinRegistries()} platform={platform} config={report} />);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return { user, backend, platform };
}

const inventory = () => screen.getByRole("group", { name: "Inventory" });
const item = (name: string) => within(inventory()).queryByRole("treeitem", { name: new RegExp(`^${name}(,|$)`) });
const rowOf = (el: HTMLElement) => el.closest("li") as HTMLElement;
const message = () => screen.getByRole("status", { name: "" });
const said = async (text: RegExp) => expect(await screen.findByText(text)).toBeInTheDocument();
const statusbar = () => document.querySelector(".statusbar") as HTMLElement;

describe("removing a Host", () => {
  it("asks first, naming the Host and saying the vault is left alone; Esc keeps it", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:host remove linux-1-000{Enter}`);
    const ask = await screen.findByRole("alertdialog", { name: "Remove linux-1-000?" });
    expect(ask).toHaveTextContent(/vault item, if it has one, stays in the vault/);
    expect(within(ask).getByRole("button", { name: "Remove" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(item("linux-1-000")).not.toBeNull();
  });

  it("removes it on Enter, as a Pending change", async () => {
    const { user } = await ready();
    // The confirmation's whole text shows with every message on (ticket 111).
    await user.keyboard(`${LEADER}:messages all{Enter}`);
    await user.keyboard(`${LEADER}:host remove linux-1-000{Enter}`);
    await screen.findByRole("alertdialog", { name: "Remove linux-1-000?" });
    await user.keyboard("{Enter}");
    await said(/Removed linux-1-000 from subnet-1 as a Pending change/);
    expect(item("linux-1-000")).toBeNull();
    expect(within(statusbar()).getByRole("button", { name: /1 Pending change/ })).toBeInTheDocument();
  });

  it("works from the row's button with the mouse; with no Host given or selected it says so", async () => {
    const { user } = await ready();
    await user.click(within(rowOf(item("esxi-2-001") as HTMLElement)).getByRole("button", { name: "Remove esxi-2-001 from the Inventory" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: "Remove esxi-2-001?" })).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(item("esxi-2-001")).toBeNull());
    // the cursor on a Host row, then ␣ D
    await user.keyboard(`${LEADER}:host remove{Enter}`);
    await said(/No Host selected/);
  });
});

describe("renaming and moving Hosts", () => {
  it("renames by command, and asks for the new name when it's left out", async () => {
    const { user } = await ready();
    // The confirmation's whole text shows with every message on (ticket 111).
    await user.keyboard(`${LEADER}:messages all{Enter}`);
    await user.keyboard(`${LEADER}:host rename linux-1-000 web-1{Enter}`);
    await said(/Renamed linux-1-000 to web-1 as a Pending change/);
    expect(item("web-1")).not.toBeNull();
    // the rename button opens the command line with the rest to type
    await user.click(within(rowOf(item("web-1") as HTMLElement)).getByRole("button", { name: "Rename web-1" }));
    expect(screen.getByRole("combobox", { name: "Command" })).toHaveValue("host rename web-1 ");
  });

  it("refuses a taken name with roster's words, writing nothing", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:host rename linux-1-000 esxi-2-001{Enter}`);
    await said(/Couldn't change the Inventory: host 'esxi-2-001' is already in the Inventory \(group subnet-2\)/);
    expect(item("linux-1-000")).not.toBeNull();
  });

  it("moves a Host dragged onto another group's heading, and by :host move", async () => {
    const { user } = await ready();
    // The confirmation's whole text shows with every message on (ticket 111).
    await user.keyboard(`${LEADER}:messages all{Enter}`);
    const target = within(inventory()).getByRole("treeitem", { name: /^subnet-3/ });
    fireEvent.dragStart(rowOf(item("linux-1-000") as HTMLElement));
    fireEvent.dragOver(rowOf(target));
    fireEvent.drop(rowOf(target));
    await said(/Moved linux-1-000 to subnet-3 as a Pending change/);
    expect(within(inventory()).getByRole("treeitem", { name: /^subnet-3/ })).toHaveTextContent("3");
    await user.keyboard(`${LEADER}:host move linux-1-000 subnet-4{Enter}`);
    await said(/Moved linux-1-000 to subnet-4/);
  });
});

describe("groups", () => {
  it("adds a group from the heading's button, shown dimmed with a dot until it's Published", async () => {
    const { user } = await ready();
    // The confirmation's whole text shows with every message on (ticket 111).
    await user.keyboard(`${LEADER}:messages all{Enter}`);
    await user.click(within(inventory()).getByRole("button", { name: "New group" }));
    expect(screen.getByRole("combobox", { name: "Command" })).toHaveValue("group new ");
    await user.keyboard("dmz{Enter}");
    await said(/Added group dmz as a Pending change/);
    const dmz = await within(inventory()).findByRole("treeitem", { name: /^dmz, 0 Hosts, not Published yet/ });
    expect(rowOf(dmz)).toHaveClass("pending");
    expect(rowOf(dmz).querySelector(".sb-pending-dot")).not.toBeNull();
  });

  it("+ on a group heading opens the add form in that group", async () => {
    const { user } = await ready();
    const heading = rowOf(within(inventory()).getByRole("treeitem", { name: /^subnet-3/ }));
    await user.click(within(heading).getByRole("button", { name: "Add a Host to subnet-3" }));
    const form = await screen.findByRole("region", { name: "Add a Host" });
    expect(within(form).getByLabelText("Group")).toHaveValue("subnet-3");
  });

  it("deleting a group with Hosts asks where they go, then moves them", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:group delete subnet-1{Enter}`);
    expect(screen.getByRole("combobox", { name: "Command" })).toHaveValue("group delete subnet-1 ");
    await said(/subnet-1 has 2 Hosts: name the group they move to/);
    await user.keyboard("subnet-2{Enter}");
    await said(/Deleted group subnet-1; 2 Hosts moved to subnet-2/);
    expect(within(inventory()).queryByRole("treeitem", { name: /^subnet-1/ })).toBeNull();
  });

  it("renames a group; its Hosts follow", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:group rename subnet-4 lab{Enter}`);
    await said(/Renamed group subnet-4 to lab/);
    expect(within(inventory()).getByRole("treeitem", { name: /^lab/ })).toHaveTextContent("1");
  });

  it("works the same in Focus mode", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:focus{Enter}`);
    await user.keyboard(`${LEADER}:group new bench{Enter}`);
    await said(/Added group bench/);
  });

  it("an older roster says it needs API 8", async () => {
    const { user } = await ready({ apiVersion: 7 });
    expect(within(inventory()).queryByRole("button", { name: "New group" })).toBeNull();
    await user.keyboard(`${LEADER}:group new x{Enter}`);
    await said(/needs a newer roster \(API version 8; this one speaks 7\)/);
  });
});

describe("outside edits to roster.yml", () => {
  const edited = () => ({ ...hosts, hosts: hosts.hosts.map((h) => (h.name === "linux-1-000" ? { ...h, name: "linux-renamed" } : h)) });

  it("with auto_reload, the Sidebar follows in place, keeping folds", async () => {
    const { user, backend } = await ready({ config: configWith({ autoReload: true }) });
    await waitFor(() => expect(backend.watching()).toBe(true));
    await user.click(within(inventory()).getByRole("treeitem", { name: /^subnet-3/ }));       // fold subnet-3
    act(() => backend.outsideEdit(edited()));
    await waitFor(() => expect(item("linux-renamed")).not.toBeNull());
    expect(within(inventory()).getByRole("treeitem", { name: /^subnet-3/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("a broken edit keeps the last good Inventory and says the line", async () => {
    const { backend } = await ready({ config: configWith({ autoReload: true }) });
    await waitFor(() => expect(backend.watching()).toBe(true));
    act(() => backend.outsideEdit({ error: { message: "mapping values are not allowed here", path: "~/infra/roster.yml", line: 12 } }));
    await said(/roster\.yml:12 has an error \(mapping values are not allowed here\): the last good Inventory is still in use/);
    expect(item("linux-1-000")).not.toBeNull();
  });

  it("a service roster left out is said, and the Host stays", async () => {
    const { backend } = await ready({ config: configWith({ autoReload: true }) });
    await waitFor(() => expect(backend.watching()).toBe(true));
    const problem = { service: "web", message: "service 'web': login: 'appliance' isn't a login type roster knows", fix: "set login: to one of …" };
    const withProblem = { ...hosts, hosts: hosts.hosts.map((h) => (h.name === "linux-1-000" ? { ...h, problems: [problem] } : h)) };
    act(() => backend.outsideEdit(withProblem));
    await said(/roster\.yml loaded, but left out linux-1-000's service web: login: 'appliance' isn't a login type roster knows \(roster info linux-1-000 says how to fix it\)/);
    expect(item("linux-1-000")).not.toBeNull();
  });

  it("without auto_reload, a quiet hint until :source applies it", async () => {
    const { user, backend } = await ready();
    await waitFor(() => expect(backend.watching()).toBe(false));
    act(() => backend.outsideEdit(edited()));
    await waitFor(() => expect(statusbar()).toHaveTextContent(/roster\.yml changed/));
    expect(item("linux-1-000")).not.toBeNull();
    await user.keyboard(`${LEADER}:source roster.yml{Enter}`);
    await waitFor(() => expect(item("linux-renamed")).not.toBeNull());
    expect(statusbar()).not.toHaveTextContent(/roster\.yml changed/);
    expect(message()).toHaveTextContent(/Reloaded roster\.yml/);
  });
});

describe("services roster left out", () => {
  const bad = (service: string) => ({ service, message: `service '${service}': bad port 0`, fix: "use a number from 1 to 65535" });
  it("says nothing when there are none, and counts several", () => {
    expect(servicesLeftOut(hosts)).toBeNull();
    const list = { ...hosts, hosts: hosts.hosts.map((h, i) => (i < 5 ? { ...h, problems: [bad("api")] } : h)) };
    expect(servicesLeftOut(list)).toBe(
      "roster.yml loaded, but left out 5 services it can't use (linux-1-000's api, esxi-2-001's api, proxmox-3-002's api, and 2 more): roster hosts says why and how to fix them",
    );
  });
});

// Ticket 61 (decision Q93): Folders is a built-in Plugin with its own data folder. folders.yml's
// Folders move in once, without losing any; after that the app never writes or watches it.
describe("folders.yml", () => {
  it("its Folders move into the Folders Plugin once, and it's never written or read again", async () => {
    const yml = "# mine\nLab:\n  - esxi-2-001\n  - gone-01\nNights: []\n";
    const { user, platform, backend } = await ready({ folders: yml });
    const folders = () => screen.getByRole("group", { name: "Folders" });
    expect(await within(folders()).findByRole("treeitem", { name: /^Lab/ })).toBeInTheDocument();
    expect(within(folders()).getByRole("treeitem", { name: /^Nights/ })).toBeInTheDocument();
    // A Host that isn't in the Inventory is kept, and says so.
    expect(within(folders()).getByRole("treeitem", { name: /^gone-01/ })).toHaveTextContent(/not in the Inventory/);
    await waitFor(() => expect(JSON.parse(backend.pluginFiles("folders").get("folders.json") ?? "null")).toEqual([
      { name: "Lab", hosts: ["esxi-2-001", "gone-01"] },
      { name: "Nights", hosts: [] },
    ]));
    await user.keyboard(`${LEADER}:folder new Days{Enter}`);
    expect(await within(folders()).findByRole("treeitem", { name: /^Days/ })).toBeInTheDocument();
    expect(platform.foldersFile()).toBe(yml);
    // Edited later, it isn't read: loaded again, the Plugin keeps its own.
    act(() => platform.editFolders("Other: []\n"));
    await user.keyboard(`${LEADER}:plugins reload folders{Enter}`);
    await waitFor(() => expect(within(folders()).getByRole("treeitem", { name: /^Days/ })).toBeInTheDocument());
    expect(within(folders()).queryByRole("treeitem", { name: /^Other/ })).toBeNull();
  });

  it("a folders.yml that doesn't parse moves nothing, so nothing is lost", async () => {
    const { user, backend } = await ready({ folders: "Lab:\n  - a\nNight: x: y\n" });
    const folders = () => screen.getByRole("group", { name: "Folders" });
    expect(await within(folders()).findByText(/folders\.yml:3 has an error/)).toBeInTheDocument();
    await user.keyboard(`${LEADER}:folder new Days{Enter}`);
    await said(/Folders can't be changed until they can be read/);
    expect(backend.pluginFiles("folders").has("folders.json")).toBe(false);
  });

  it("init.lua's Folders stay read-only beside your own", async () => {
    const config = configWith({ folders: [{ name: "Core", hosts: ["esxi-2-001"] }] });
    const { user } = await ready({ config, folders: "Lab: []\n" });
    const folders = screen.getByRole("group", { name: "Folders" });
    expect(await within(folders).findByRole("treeitem", { name: /^Core/ })).toBeInTheDocument();
    await user.keyboard(`${LEADER}:folder delete Core{Enter}`);
    await said(/Core is defined in init\.lua: change it there/);
  });
});
