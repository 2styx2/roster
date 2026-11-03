// Several named Inventories, one active (ticket 115, issue #201, items 6-9), through the App with the
// fake Backend: the status bar names the Inventory roster runs on; `:inventory NAME` (and ␣ I) asks
// first, saying what happens, and Pending changes or an earlier step of roster's lookup block it;
// on confirm the vault locks, `inventories.use` makes NAME active and serve starts again, which runs
// the lookup again (never the old serve's file); open Sessions stay, marked with where they came from.
import { describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, makeHosts, type FakeScenario } from "./backend/fake";
import { INVENTORIES_API_VERSION, type Backend } from "./backend/types";
import { memoryPlatform } from "./platform/memory";
import { StubTerminal } from "./terminal/StubTerminal";

const LEADER = "{Control>} {/Control}";
const WORK = "/home/you/work-infra/roster.yml";
const HOME = "/home/you/home-lab/roster.yml";

const work = makeHosts(3);
const home = {
  hosts: [{ ...work.hosts[0]!, name: "pi", ssh: { ...work.hosts[0]!.ssh, ip: "10.0.0.5" } }],
  groups: work.groups,
};

const scenario = (more: Partial<FakeScenario> = {}): FakeScenario => ({
  hosts: work,
  apiVersion: INVENTORIES_API_VERSION,
  inventories: {
    named: [
      { name: "work", path: WORK },
      { name: "home", path: HOME, hosts: home },
    ],
    active: "work",
  },
  ...more,
});

/** The fake Backend, recording the calls a switch makes, in order. */
function recorded(s: FakeScenario) {
  const backend = fakeBackend(s);
  const calls: string[] = [];
  const wrapped: Backend = {
    ...backend,
    connect: (options) => {
      calls.push(options?.restart ? "restart" : "start");
      return backend.connect(options);
    },
    vaultStatus: async () => {
      const status = await backend.vaultStatus();
      calls.push("status");
      return status;
    },
    lockVault: () => {
      calls.push("lock");
      return backend.lockVault();
    },
    useInventory: (name) => {
      calls.push(`use ${name}`);
      return backend.useInventory(name);
    },
  };
  return { backend: wrapped, calls };
}

async function ready(s: FakeScenario = scenario()) {
  const user = userEvent.setup();
  const { backend, calls } = recorded(s);
  render(<App backend={backend} terminalView={StubTerminal} platform={memoryPlatform()} />);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return { user, calls, backend };
}

const statusbar = () => document.querySelector(".statusbar") as HTMLElement;
const confirm = () => screen.findByRole("alertdialog", { name: "Switch Inventory" });

describe("the active Inventory", () => {
  it("is named in the status bar", async () => {
    await ready();
    expect(await within(statusbar()).findByTitle(`Inventory work: ${WORK}`)).toHaveTextContent("work");
  });

  it("isn't, with no named Inventories or a roster before API 27", async () => {
    await ready(scenario({ inventories: { named: [], active: null } }));
    expect(statusbar()).not.toHaveTextContent(/Inventory/);
    cleanup();
    await ready(scenario({ apiVersion: INVENTORIES_API_VERSION - 1 }));
    expect(statusbar()).not.toHaveTextContent(/Inventory/);
  });
});

describe(":inventory NAME", () => {
  it("asks first, saying what happens and what's affected; Escape keeps you where you are", async () => {
    const { user, calls } = await ready();
    await user.keyboard(`${LEADER}:connect linux-1-000{Enter}`);
    await user.keyboard(`${LEADER}:inventory home{Enter}`);
    const dialog = await confirm();
    expect(dialog).toHaveTextContent("Switch from work to home? roster restarts on home's file and locks work's vault.");
    expect(dialog).toHaveTextContent("1 open Session stays open, marked as work's.");
    expect(dialog).toHaveTextContent("No Pending changes.");
    expect(within(dialog).getByRole("button", { name: "Switch to home" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(calls.filter((c) => c !== "status")).toEqual(["start"]);
    expect(within(statusbar()).getByTitle(`Inventory work: ${WORK}`)).toBeInTheDocument();
  });

  it("on confirm locks the vault, makes it active and starts serve again, which finds the new one", async () => {
    const { user, calls } = await ready();
    await user.keyboard(`${LEADER}:connect linux-1-000{Enter}`);
    await user.keyboard(`${LEADER}:inventory home{Enter}`);
    await user.click(within(await confirm()).getByRole("button", { name: "Switch to home" }));
    // The new serve's lock screen, once the app has asked it where its vault stands (the cover
    // before it was the old serve's).
    await waitFor(() => expect(calls.slice(calls.indexOf("restart"))).toContain("status"));
    // The new serve has never been unlocked: home's vault asks for its password.
    await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    await screen.findByRole("main", { name: /workspace/i });
    expect(calls.filter((c) => c !== "status").slice(0, 4)).toEqual(["start", "lock", "use home", "restart"]);
    expect(await within(statusbar()).findByTitle(`Inventory home: ${HOME}`)).toHaveTextContent("home");
    expect(statusbar()).toHaveTextContent(HOME);
    // Announced (the message line is a status region).
    expect(await screen.findByText(/Now on the home Inventory/, { selector: ".message-line" })).toBeInTheDocument();
    // home's Hosts, and work's Session still open, marked as work's.
    expect(await screen.findByRole("treeitem", { name: /^pi/ })).toBeInTheDocument();
    expect(screen.getAllByText(/· work/).length).toBeGreaterThan(0);
  });

  it("completes the named Inventories, and ␣ I starts the line", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}I`);
    const line = await screen.findByRole("combobox");
    expect(line).toHaveValue("inventory ");
    await user.keyboard("h{Tab}");
    expect(line).toHaveValue("inventory home");
  });

  it("is blocked by Pending changes until they're published or discarded", async () => {
    const { user, calls } = await ready(scenario({ pending: { "linux-1-000": { title: "Build box" } } }));
    await within(statusbar()).findByRole("button", { name: /1 Pending change/ });
    await user.keyboard(`${LEADER}:inventory home{Enter}`);
    const dialog = await confirm();
    expect(dialog).toHaveTextContent("1 Pending change in work's roster.yml isn't published: publish it (:publish) or discard it (:discard) first.");
    expect(within(dialog).queryByRole("button", { name: "Switch to home" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(calls.filter((c) => c !== "status")).toEqual(["start"]);
  });

  it("says so plainly when an earlier step of roster's lookup wins, and doesn't switch", async () => {
    const { user, calls } = await ready(scenario({ inventories: { named: [{ name: "work", path: WORK }, { name: "home", path: HOME }], active: "home", override: "/home/you/scratch/roster.yml" } }));
    await user.keyboard(`${LEADER}:inventory work{Enter}`);
    const dialog = await confirm();
    expect(dialog).toHaveTextContent(/roster runs on \/home\/you\/scratch\/roster\.yml, not on the active Inventory \(home\)/);
    expect(dialog).toHaveTextContent(/\$ROSTER_CONFIG or a roster\.yml in the folder roster starts in comes first/);
    expect(within(dialog).queryByRole("button", { name: "Switch to work" })).not.toBeInTheDocument();
    expect(calls.filter((c) => c !== "status")).toEqual(["start"]);
  });

  it("names the ones there are for a name that isn't one, and says where you are already", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:inventory lab{Enter}`);
    expect(await screen.findByText("No Inventory named lab (there's work, home)", { selector: ".message-line" })).toBeInTheDocument();
    await user.keyboard(`${LEADER}:inventory work{Enter}`);
    expect(await screen.findByText(`Already on work (${WORK})`, { selector: ".message-line" })).toBeInTheDocument();
  });

  it("says how to name one when there are none", async () => {
    const { user } = await ready(scenario({ inventories: { named: [], active: null } }));
    await user.keyboard(`${LEADER}:inventory{Enter}`);
    expect(await screen.findByText(/No named Inventories: roster inv add NAME PATH names one/, { selector: ".message-line" })).toBeInTheDocument();
  });
});
