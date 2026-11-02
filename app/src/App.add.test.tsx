// Ticket 11 through the App with the fake Backend: `:host add` pulls and opens the add form, a Host
// with a Login is tested first (host key confirmed, one login; decision Q43) and nothing is written
// when that fails, a Host without one goes in unreviewed, the typed password never stays in the app,
// and an unreviewed Host can be marked reviewed from the Sidebar, the Picker, `:review` and the
// edit form.
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_FINGERPRINT, FAKE_HOST_PASSWORD, FAKE_PASSWORD, fakeBackend, fixtures, type FakeScenario } from "./backend/fake";
import type { Backend } from "./backend/types";
import { memoryPlatform } from "./platform/memory";
import { StubTerminal } from "./terminal/StubTerminal";

const LEADER = "{Control>} {/Control}";
const UNREVIEWED = "switch-4-003";

/** The fake Backend, recording every call's params (to check where a password went). */
function recording(scenario: FakeScenario) {
  const backend = fakeBackend(scenario);
  const calls: { method: string; args: unknown[] }[] = [];
  const wrapped = new Proxy(backend, {
    get(target, prop: keyof Backend) {
      const v = target[prop];
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        calls.push({ method: String(prop), args });
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { backend: wrapped, calls };
}

async function ready(scenario: FakeScenario = fixtures.add as FakeScenario) {
  const user = userEvent.setup();
  const { backend, calls } = recording(scenario);
  const platform = memoryPlatform();
  render(<App backend={backend} terminalView={StubTerminal} platform={platform} />);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return { user, backend, calls, platform };
}

const form = () => screen.findByRole("region", { name: "Add a Host" });

async function openForm(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard(`${LEADER}:host add{Enter}`);
  const panel = await form();
  await within(panel).findByLabelText("Name");
  return panel;
}

async function fill(user: ReturnType<typeof userEvent.setup>, panel: HTMLElement, fields: Record<string, string>) {
  for (const [label, value] of Object.entries(fields)) {
    const input = within(panel).getByLabelText(label);
    await user.clear(input);
    if (value) await user.type(input, value);
  }
}

describe("The Inventory heading's + (iteration 3 feedback: add-Host was hard to find)", () => {
  const heading = () => screen.getByRole("group", { name: "Inventory" });
  const plus = () => within(heading()).getByRole("button", { name: "Add a Host" });

  it("is always there (not only on hover), says its keys, and opens the add form", async () => {
    const { user } = await ready();
    expect(plus()).toHaveClass("pinned");
    expect(plus()).toHaveAttribute("title", "Add a Host (Ctrl+Space +)");
    await user.click(plus());
    expect(await form()).toBeInTheDocument();
  });

  it("leaves the keys out of its tooltip when the hints are hidden", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}:hints off{Enter}`);
    expect(plus()).toHaveAttribute("title", "Add a Host");
  });

  it("stays on a roster too old to add Hosts, and says so instead of opening a form", async () => {
    const { user } = await ready({ ...(fixtures.add as FakeScenario), apiVersion: 5 });
    const why = "Adding a Host needs a newer roster (API version 6; this one speaks 5)";
    expect(plus()).toHaveAttribute("title", why);
    await user.click(plus());
    expect(screen.getByRole("status")).toHaveTextContent(why);
    expect(screen.queryByRole("region", { name: "Add a Host" })).toBeNull();
  });
});

describe("the add form", () => {
  it("opens from :host add and from Leader +, pulled, with Name focused and the selected group", async () => {
    const { user, calls } = await ready();
    const panel = await openForm(user);
    expect(within(panel).getByLabelText("Name")).toHaveFocus();
    expect(within(panel).getByLabelText("Group")).toHaveValue("subnet-1");
    expect(calls.some((c) => c.method === "pullInventory")).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Add a Host" })).toBeNull();
    await user.keyboard(`${LEADER}+`);
    expect(await form()).toBeInTheDocument();
  });

  it("says what's wrong with each field, in roster's terms, before calling roster", async () => {
    const { user, calls } = await ready();
    const panel = await openForm(user);
    await fill(user, panel, { Name: "linux-1-000", Address: "10.0.0.1 x", Port: "0" });
    await user.click(within(panel).getByRole("button", { name: "Test login and add" }));
    expect(within(panel).getByText("Already a Host, in subnet-1")).toBeInTheDocument();
    expect(within(panel).getByText("Can't contain spaces")).toBeInTheDocument();
    expect(within(panel).getByText("A number from 1 to 65535")).toBeInTheDocument();
    expect(within(panel).getByText(/Type the password/)).toBeInTheDocument();
    expect(within(panel).getByLabelText("Name")).toHaveFocus();
    await fill(user, panel, { Name: "nas 1" });
    expect(within(panel).getByText(/Letters, digits, \. _ - only/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "addHost" || c.method === "scanKey")).toBe(false);
  });

  it("suggests vault item names that follow <host> <what it opens>", async () => {
    const { user } = await ready();
    const panel = await openForm(user);
    await fill(user, panel, { Name: "nas-01" });
    const saveAs = within(panel).getByLabelText("Save it as");
    expect(saveAs).toHaveAttribute("placeholder", "nas-01 ssh");
    const options = () => [...panel.querySelectorAll("[data-testid=item-suggestions] option")].map((o) => o.getAttribute("value"));
    expect(options()).toEqual(["nas-01 ssh", "nas-01 ssh+web", "nas-01 root"]);
    await user.click(within(panel).getByLabelText("An existing vault item"));
    expect(within(panel).getByLabelText("Vault item")).toHaveAttribute("placeholder", "bw:nas-01 ssh");
    expect(options()[0]).toBe("bw:nas-01 ssh");
    await user.type(within(panel).getByLabelText("Vault item"), "nas-01 ssh");
    await user.tab();
    expect(within(panel).getByText("A vault reference, like bw:esx-02 ssh")).toBeInTheDocument();
  });

  it("shows the host key to confirm, then tests the login, saves the password and adds the Host", async () => {
    const { user, backend, calls } = await ready();
    // The confirmation's whole text shows with every message on (ticket 111).
    await user.keyboard(`${LEADER}:messages all{Enter}`);
    const panel = await openForm(user);
    await fill(user, panel, { Name: "nas-01", Address: "10.19.1.50", User: "root", Type: "nas" });
    await user.type(within(panel).getByLabelText("Password"), FAKE_HOST_PASSWORD);
    await user.keyboard("{Enter}");
    const confirm = await within(panel).findByRole("group", { name: "Confirm the host key" });
    expect(confirm).toHaveTextContent(FAKE_FINGERPRINT);
    expect(within(confirm).getByRole("button", { name: "Trust it and add" })).toHaveFocus();
    expect(calls.some((c) => c.method === "addHost")).toBe(false);          // nothing before the key is trusted
    await user.keyboard("{Enter}");
    expect(await screen.findByText(/Added nas-01 to subnet-1 as a Pending change; its password is in the vault as nas-01 ssh\./)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Add a Host" })).toBeNull();
    const added = await backend.getHost("nas-01");
    expect(added.reviewed).toBe(true);
    expect(added.ssh.auth).toBe("bw:nas-01 ssh");
    const call = calls.find((c) => c.method === "addHost");
    expect(call?.args[0]).toMatchObject({ name: "nas-01", password: FAKE_HOST_PASSWORD, item: "nas-01 ssh", host_key: FAKE_FINGERPRINT });
    expect(await screen.findByRole("treeitem", { name: /^nas-01, / })).toBeInTheDocument();
    expect(document.querySelector(".statusbar")).toHaveTextContent(/1 Pending change/);
  });

  it("says so when the Host was added but something after it failed", async () => {
    const scenario = { ...(fixtures.add as FakeScenario), addWarnings: { "nas-01": ["its host key couldn't be recorded (disk full)"] } };
    const { user } = await ready(scenario);
    const panel = await openForm(user);
    await fill(user, panel, { Name: "nas-01", Address: "10.19.1.50", User: "root" });
    await user.type(within(panel).getByLabelText("Password"), FAKE_HOST_PASSWORD);
    await user.keyboard("{Enter}");
    await user.click(await within(panel).findByRole("button", { name: "Trust it and add" }));
    expect(await screen.findByText(/Added nas-01 to subnet-1 as a Pending change.* But its host key couldn't be recorded \(disk full\)\./)).toBeInTheDocument();
  });

  it("after an add roster answered too late for, checks and says the Host went in", async () => {
    const { user } = await ready({ ...(fixtures.add as FakeScenario), lateAnswers: true });
    const panel = await openForm(user);
    await fill(user, panel, { Name: "nas-01", Address: "10.19.1.50", User: "root" });
    await user.type(within(panel).getByLabelText("Password"), FAKE_HOST_PASSWORD);
    await user.keyboard("{Enter}");
    await user.click(await within(panel).findByRole("button", { name: "Trust it and add" }));
    expect(await screen.findByText(/Added nas-01 to subnet-1 as a Pending change; its password is in the vault as nas-01 ssh\. But roster answered late/)).toBeInTheDocument();
  });

  it("writes nothing when the test login fails, shows why, and forgets the password", async () => {
    const { user, backend } = await ready();
    const panel = await openForm(user);
    await fill(user, panel, { Name: "nas-01", Address: "10.19.1.50", User: "root" });
    const pw = within(panel).getByLabelText("Password");
    await user.type(pw, "wrong-password");
    await user.keyboard("{Enter}");
    await user.click(await within(panel).findByRole("button", { name: "Trust it and add" }));
    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveTextContent("The test login failed, so nothing was saved");
    expect(alert).toHaveTextContent("refused the password for user root");
    expect(within(panel).getByLabelText("Password")).toHaveValue("");
    expect(document.body.innerHTML).not.toContain("wrong-password");
    expect(within(panel).queryByText(/Type the password/)).toBeNull();
    expect((await backend.pendingChanges()).count).toBe(0);
    await expect(backend.getHost("nas-01")).rejects.toThrow();
  });

  it("adds nothing when the host key isn't trusted", async () => {
    const { user, calls } = await ready();
    const panel = await openForm(user);
    await fill(user, panel, { Name: "nas-01", Address: "10.19.1.50", User: "root" });
    await user.type(within(panel).getByLabelText("Password"), FAKE_HOST_PASSWORD);
    await user.keyboard("{Enter}");
    await user.click(await within(panel).findByRole("button", { name: "Don't trust it" }));
    expect(within(panel).getByRole("alert")).toHaveTextContent("Not added: you didn't trust the host key at 10.19.1.50. Nothing was written.");
    expect(within(panel).getByLabelText("Password")).toHaveValue("");
    expect(calls.some((c) => c.method === "addHost")).toBe(false);
  });

  it("refuses an address whose key differs from the recorded one, without a login", async () => {
    const { user, calls } = await ready({ ...(fixtures.add as FakeScenario), scanKeys: { "10.19.1.50": { recorded: "changed" } } });
    const panel = await openForm(user);
    await fill(user, panel, { Name: "nas-01", Address: "10.19.1.50", User: "root" });
    await user.type(within(panel).getByLabelText("Password"), FAKE_HOST_PASSWORD);
    await user.keyboard("{Enter}");
    expect(await within(panel).findByRole("alert")).toHaveTextContent("isn't the one roster recorded");
    expect(calls.some((c) => c.method === "addHost")).toBe(false);
  });

  it("adds a Host with no Login unreviewed, without a test login", async () => {
    const { user, backend, calls } = await ready();
    const panel = await openForm(user);
    await fill(user, panel, { Name: "printer-9", Address: "10.19.1.60", User: "admin", Group: "dmz" });
    expect(within(panel).getByText(/new group/)).toBeInTheDocument();
    await user.click(within(panel).getByLabelText("No Login yet"));
    expect(within(panel).getByText(/goes in unreviewed/)).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Add unreviewed" }));
    expect(await screen.findByText(/Added printer-9 to dmz unreviewed/)).toBeInTheDocument();
    expect((await backend.getHost("printer-9")).reviewed).toBe(false);
    expect(calls.some((c) => c.method === "scanKey")).toBe(false);
  });

  it("shows roster's refusal on the field it names", async () => {
    const { user, backend } = await ready();
    const panel = await openForm(user);
    // Someone else's add lands after the form opened: only roster knows the name is taken now.
    await backend.addHost({ name: "printer-9", group: "subnet-2", address: "10.19.2.60", user: "admin" });
    await fill(user, panel, { Name: "printer-9", Address: "10.19.1.60", User: "admin" });
    await user.click(within(panel).getByLabelText("No Login yet"));
    await user.keyboard("{Enter}");
    expect(await within(panel).findByText("host 'printer-9' is already in the Inventory (group subnet-2)", { selector: ".edit-field-problem" })).toBeInTheDocument();
    expect(within(panel).getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");
  });

  it("needs a roster that can add Hosts", async () => {
    const { user } = await ready({ ...(fixtures.edit as FakeScenario), apiVersion: 5 });
    await user.keyboard(`${LEADER}:host add{Enter}`);
    expect(await screen.findByText(/Adding a Host needs a newer roster \(API version 6; this one speaks 5\)/)).toBeInTheDocument();
  });
});

describe("marking a Host reviewed", () => {
  it(":review flips only that Host, and it can be opened then", async () => {
    const { user, backend } = await ready();
    // The confirmation's whole text shows with every message on (ticket 111).
    await user.keyboard(`${LEADER}:messages all{Enter}`);
    await user.keyboard(`${LEADER}:connect ${UNREVIEWED}{Enter}`);
    expect(await screen.findByText(`${UNREVIEWED} isn't reviewed yet, so it can't be opened. :review ${UNREVIEWED} marks it reviewed.`)).toBeInTheDocument();
    const before = await backend.getHost(UNREVIEWED);
    await user.keyboard(`${LEADER}:review ${UNREVIEWED}{Enter}`);
    expect(await screen.findByText(`Marked ${UNREVIEWED} reviewed, as a Pending change. It can be opened now.`)).toBeInTheDocument();
    expect(await backend.getHost(UNREVIEWED)).toEqual({ ...before, reviewed: true });
    expect((await backend.pendingChanges()).hosts).toEqual([{ host: UNREVIEWED, change: "changed", fields: ["reviewed"] }]);
  });

  it("from the Sidebar row's button", async () => {
    const { user, backend } = await ready();
    await user.click(await screen.findByRole("button", { name: `Mark ${UNREVIEWED} reviewed` }));
    expect(await screen.findByText(/Marked switch-4-003 reviewed/)).toBeInTheDocument();
    expect((await backend.getHost(UNREVIEWED)).reviewed).toBe(true);
    expect(screen.queryByRole("button", { name: `Mark ${UNREVIEWED} reviewed` })).toBeNull();
  });

  it("from the Picker, with Ctrl+R on an unreviewed Host", async () => {
    const { user, backend } = await ready();
    await user.keyboard(`${LEADER}f`);
    await user.keyboard(UNREVIEWED);
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Find a Host" })).toHaveTextContent("Ctrl+r marks it reviewed.");
    await user.keyboard("{Control>}r{/Control}");
    expect(await screen.findByText(/Marked switch-4-003 reviewed/)).toBeInTheDocument();
    expect((await backend.getHost(UNREVIEWED)).reviewed).toBe(true);
  });

  it("from the edit form", async () => {
    const { user, backend } = await ready();
    await user.keyboard(`${LEADER}:edit ${UNREVIEWED}{Enter}`);
    const panel = await screen.findByRole("region", { name: `Edit ${UNREVIEWED}` });
    await user.click(await within(panel).findByRole("button", { name: "Mark reviewed" }));
    expect(await screen.findByText(/Marked switch-4-003 reviewed/)).toBeInTheDocument();
    expect((await backend.getHost(UNREVIEWED)).reviewed).toBe(true);
  });
});

describe("un-reviewing a Host (issue #78, item 5)", () => {
  const current = { ...(fixtures.add as FakeScenario), apiVersion: 9 };
  const REVIEWED = "linux-1-000";

  it(":host unreview sets reviewed: false again, as a Pending change", async () => {
    const { user, backend } = await ready(current);
    // The confirmation's whole text shows with every message on (ticket 111).
    await user.keyboard(`${LEADER}:messages all{Enter}`);
    const before = await backend.getHost(REVIEWED);
    await user.keyboard(`${LEADER}:host unreview ${REVIEWED}{Enter}`);
    expect(
      await screen.findByText(`Marked ${REVIEWED} unreviewed, as a Pending change. It can't be opened until it's reviewed again.`),
    ).toBeInTheDocument();
    expect(await backend.getHost(REVIEWED)).toEqual({ ...before, reviewed: false });
    expect((await backend.pendingChanges()).hosts).toEqual([{ host: REVIEWED, change: "changed", fields: ["reviewed"] }]);
    // and back
    await user.keyboard(`${LEADER}:host review ${REVIEWED}{Enter}`);
    expect(await screen.findByText(/Marked linux-1-000 reviewed/)).toBeInTheDocument();
    expect((await backend.pendingChanges()).count).toBe(0);
  });

  it("the Sidebar's ✓ takes back a review that's still a Pending change", async () => {
    const { user, backend } = await ready(current);
    await user.click(await screen.findByRole("button", { name: `Mark ${UNREVIEWED} reviewed` }));
    const undo = await screen.findByRole("button", { name: `Mark ${UNREVIEWED} unreviewed` });
    await user.click(undo);
    expect(await screen.findByText(/Marked switch-4-003 unreviewed/)).toBeInTheDocument();
    expect((await backend.getHost(UNREVIEWED)).reviewed).toBe(false);
    expect((await backend.pendingChanges()).count).toBe(0);
    expect(await screen.findByRole("button", { name: `Mark ${UNREVIEWED} reviewed` })).toBeInTheDocument();
    // A Host reviewed in roster.yml already (published) has no such button: the command and the edit form reach it.
    expect(screen.queryByRole("button", { name: `Mark ${REVIEWED} unreviewed` })).toBeNull();
  });

  it("from the edit form", async () => {
    const { user, backend } = await ready(current);
    await user.keyboard(`${LEADER}:edit ${REVIEWED}{Enter}`);
    const panel = await screen.findByRole("region", { name: `Edit ${REVIEWED}` });
    await user.click(await within(panel).findByRole("button", { name: "Mark unreviewed" }));
    expect(await screen.findByText(/Marked linux-1-000 unreviewed/)).toBeInTheDocument();
    expect((await backend.getHost(REVIEWED)).reviewed).toBe(false);
  });

  it("says when roster is too old to un-review (API 9)", async () => {
    const { user, backend } = await ready({ ...current, apiVersion: 8 });
    await user.keyboard(`${LEADER}:host unreview ${REVIEWED}{Enter}`);
    expect(await screen.findByText(/:host unreview needs a newer roster \(API version 9; this one speaks 8\)/)).toBeInTheDocument();
    expect((await backend.getHost(REVIEWED)).reviewed).toBe(true);
  });
});
