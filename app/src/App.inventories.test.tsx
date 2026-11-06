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
import { BackendCallError, BackendStartError, type Backend } from "./backend/types";
import { memoryPlatform } from "./platform/memory";
import { StubTerminal } from "./terminal/StubTerminal";
import { sinceOf } from "./backend/capabilities";

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
  apiVersion: sinceOf("inventories"),
  inventories: {
    named: [
      { name: "work", path: WORK },
      { name: "home", path: HOME, hosts: home },
    ],
    active: "work",
  },
  ...more,
});

/** How a switch's calls go wrong, for the tests that need it. */
interface Faults {
  lockFails?: boolean;
  /** `inventories.use` waits for this before answering. */
  useWaits?: Promise<void>;
  /** After `inventories.use`, the restart fails, or `inventories.list` does. */
  restartFails?: boolean;
  listFailsAfterUse?: boolean;
}

/** The fake Backend, recording the calls a switch makes, in order. */
function recorded(s: FakeScenario, faults: Faults = {}) {
  const backend = fakeBackend(s);
  const calls: string[] = [];
  let used = false;
  const wrapped: Backend = {
    ...backend,
    connect: async (options) => {
      calls.push(options?.restart ? "restart" : "start");
      if (used && faults.restartFails) {
        throw new BackendStartError({ kind: "failed", message: "roster serve exited at start", hint: "Run roster serve in a terminal to see why.", detail: null });
      }
      return backend.connect(options);
    },
    listInventories: async () => {
      if (used && faults.listFailsAfterUse) throw new BackendCallError("roster's list of named Inventories doesn't load", 143);
      return backend.listInventories();
    },
    vaultStatus: async () => {
      const status = await backend.vaultStatus();
      calls.push("status");
      return status;
    },
    lockVault: async () => {
      calls.push("lock");
      if (faults.lockFails) throw new BackendCallError("bw lock failed");
      return backend.lockVault();
    },
    useInventory: async (name) => {
      calls.push(`use ${name}`);
      await faults.useWaits;
      const r = await backend.useInventory(name);
      used = true;
      return r;
    },
  };
  return { backend: wrapped, calls };
}

async function ready(s: FakeScenario = scenario(), faults: Faults = {}) {
  const user = userEvent.setup();
  const { backend, calls } = recorded(s, faults);
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
    await ready(scenario({ apiVersion: sinceOf("inventories") - 1 }));
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
    expect(dialog).toHaveTextContent(/\$ROSTER_CONFIG, a roster\.yml in the folder roster starts in, or a -c in roster_command comes first/);
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

  it("reads its consequences to a screen reader, and says when roster restarts", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:inventory home{Enter}`);
    const dialog = await confirm();
    expect(dialog).toHaveAccessibleDescription(/roster restarts on home's file and locks work's vault\. No open Sessions\. No Pending changes\./);
    await user.click(within(dialog).getByRole("button", { name: "Switch to home" }));
    expect(await screen.findByText("Restarting roster on home…", { selector: ".message-line" })).toBeInTheDocument();
  });

  it("won't switch when the vault doesn't lock, and says so", async () => {
    const { user, calls } = await ready(scenario(), { lockFails: true });
    await user.keyboard(`${LEADER}:inventory home{Enter}`);
    await user.click(within(await confirm()).getByRole("button", { name: "Switch to home" }));
    expect(await screen.findByText(/Couldn't lock the vault \(bw lock failed\): nothing switched/, { selector: ".message-line" })).toBeInTheDocument();
    expect(calls.filter((c) => c !== "status")).toEqual(["start", "lock"]);
  });

  it("can't be closed or started twice while it runs", async () => {
    // A vault with nothing to unlock (env, cmd): no lock screen covers the step while it runs.
    let release = () => {};
    const useWaits = new Promise<void>((r) => (release = r));
    const user = userEvent.setup();
    const { backend, calls } = recorded(scenario({ vault: { status: "unsupported" } }), { useWaits });
    render(<App backend={backend} terminalView={StubTerminal} platform={memoryPlatform()} />);
    await screen.findByRole("main", { name: /workspace/i });
    await user.keyboard(`${LEADER}:inventory home{Enter}`);
    const dialog = await confirm();
    await user.click(within(dialog).getByRole("button", { name: "Switch to home" }));
    await waitFor(() => expect(calls).toContain("use home"));
    expect(dialog).toHaveAttribute("aria-busy", "true");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    await user.keyboard(`${LEADER}{Escape}`);
    expect(screen.getByRole("alertdialog", { name: "Switch Inventory" })).toBeInTheDocument();
    await user.keyboard(`${LEADER}:inventory work{Enter}`);
    expect(await screen.findByText("A switch to home is already running", { selector: ".message-line" })).toBeInTheDocument();
    release();
    await waitFor(() => expect(calls).toContain("restart"));
    expect(calls.filter((c) => c.startsWith("use "))).toEqual(["use home"]);
    await waitFor(() => expect(within(statusbar()).getByTitle(`Inventory home: ${HOME}`)).toBeInTheDocument());
  });

  it("says where roster stands when it doesn't start again after the switch", async () => {
    const { user } = await ready(scenario(), { restartFails: true });
    await user.keyboard(`${LEADER}:inventory home{Enter}`);
    await user.click(within(await confirm()).getByRole("button", { name: "Switch to home" }));
    expect(await screen.findByText(/home is the active Inventory now, but roster didn't start again on it/)).toBeInTheDocument();
  });

  it("says it can't tell when the new serve doesn't say where it runs", async () => {
    const { user, calls } = await ready(scenario(), { listFailsAfterUse: true });
    await user.keyboard(`${LEADER}:inventory home{Enter}`);
    await user.click(within(await confirm()).getByRole("button", { name: "Switch to home" }));
    await waitFor(() => expect(calls.slice(calls.indexOf("restart"))).toContain("status"));
    await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    expect(
      await screen.findByText(/home is the active Inventory now, but roster couldn't say which Inventory it started on/, { selector: ".message-line" }),
    ).toBeInTheDocument();
  });
});
