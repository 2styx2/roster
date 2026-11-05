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
import { chooseInMenu, inventoryRow, menuLabels } from "./test-menu";
import { onMessageLine } from "./test-messageLine";

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

  it("isn't offered on a roster too old to add Hosts, here or in the title bar (round 19)", async () => {
    const { user } = await ready({ ...(fixtures.add as FakeScenario), apiVersion: 5 });
    // A live + that only refused contradicted the screen: neither + is there.
    expect(within(heading()).queryByRole("button", { name: "Add a Host" })).toBeNull();
    expect(document.querySelector('[data-control="add"]')).toBeNull();
    // Its keys still answer, in plain words and the text colour (a slip, not a warning).
    await user.keyboard(`${LEADER}+`);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Adding Hosts here needs a newer roster. Update roster on this Box, or add them to roster.yml.");
    expect(status).not.toHaveTextContent(/API/);
    expect(status).toHaveClass("slip");
    expect(within(status).getByText("roster.yml", { selector: "code" })).toBeInTheDocument();
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

  it("empties a typed password that wasn't sent when the app locks", async () => {
    const { user, calls } = await ready();
    const panel = await openForm(user);
    await fill(user, panel, { Name: "nas-01", Address: "10.19.1.50", User: "root", Type: "nas" });
    await user.type(within(panel).getByLabelText("Password"), FAKE_HOST_PASSWORD);
    await user.keyboard(`${LEADER}:lock{Enter}`);
    await screen.findByRole("dialog", { name: /locked/i });
    await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    await screen.findByRole("main", { name: /workspace/i });
    expect(within(await form()).getByLabelText("Password")).toHaveValue("");
    expect(JSON.stringify(calls)).not.toContain(FAKE_HOST_PASSWORD);
  });

  it("a lock while the host key waits to be confirmed goes back to the form, so nothing is sent without a password", async () => {
    const { user, calls } = await ready();
    const panel = await openForm(user);
    await fill(user, panel, { Name: "nas-01", Address: "10.19.1.50", User: "root", Type: "nas" });
    await user.type(within(panel).getByLabelText("Password"), FAKE_HOST_PASSWORD);
    await user.keyboard("{Enter}");
    await within(panel).findByRole("group", { name: "Confirm the host key" });
    await user.keyboard(`${LEADER}:lock{Enter}`);
    await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    await screen.findByRole("main", { name: /workspace/i });
    const again = await form();
    expect(within(again).queryByRole("group", { name: "Confirm the host key" })).toBeNull();
    expect(within(again).getByLabelText("Password")).toHaveValue("");
    expect(calls.some((c) => c.method === "addHost")).toBe(false);
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
    expect(await screen.findByRole("status")).toHaveTextContent("Adding Hosts here needs a newer roster.");
  });
});

describe("marking a Host reviewed", () => {
  it(":review flips only that Host, and it can be opened then", async () => {
    const { user, backend } = await ready();
    // The confirmation's whole text shows with every message on (ticket 111).
    await user.keyboard(`${LEADER}:messages all{Enter}`);
    await user.keyboard(`${LEADER}:connect ${UNREVIEWED}{Enter}`);
    expect(await screen.findByText(onMessageLine(`${UNREVIEWED} isn't reviewed yet, so it can't be opened. :review ${UNREVIEWED} marks it reviewed.`))).toBeInTheDocument();
    const before = await backend.getHost(UNREVIEWED);
    await user.keyboard(`${LEADER}:review ${UNREVIEWED}{Enter}`);
    expect(await screen.findByText(`Marked ${UNREVIEWED} reviewed, as a Pending change. It can be opened now.`)).toBeInTheDocument();
    expect(await backend.getHost(UNREVIEWED)).toEqual({ ...before, reviewed: true });
    expect((await backend.pendingChanges()).hosts).toEqual([{ host: UNREVIEWED, change: "changed", fields: ["reviewed"] }]);
  });

  it("from the Sidebar row's button", async () => {
    const { user, backend } = await ready();
    await chooseInMenu(user, await inventoryRow(UNREVIEWED), /^Mark reviewed/);
    expect(await screen.findByText(/Marked switch-4-003 reviewed/)).toBeInTheDocument();
    expect((await backend.getHost(UNREVIEWED)).reviewed).toBe(true);
    expect(menuLabels(await inventoryRow(UNREVIEWED))).not.toContain("Mark reviewed");
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

  it("the Host's menu takes back a review that's still a Pending change", async () => {
    const { user, backend } = await ready(current);
    await chooseInMenu(user, await inventoryRow(UNREVIEWED), /^Mark reviewed/);
    await screen.findByText(/Marked switch-4-003 reviewed/);
    await chooseInMenu(user, await inventoryRow(UNREVIEWED), /^Mark unreviewed/);
    expect(await screen.findByText(/Marked switch-4-003 unreviewed/)).toBeInTheDocument();
    expect((await backend.getHost(UNREVIEWED)).reviewed).toBe(false);
    expect((await backend.pendingChanges()).count).toBe(0);
    expect(menuLabels(await inventoryRow(UNREVIEWED))).toContain("Mark reviewed");
    // A Host reviewed in roster.yml already (published) has no such item: the command and the edit form reach it.
    expect(menuLabels(await inventoryRow(REVIEWED))).not.toContain("Mark unreviewed");
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
    expect(await screen.findByText(onMessageLine(/:host unreview needs a newer roster \(API version 9; this one speaks 8\)/))).toBeInTheDocument();
    expect((await backend.getHost(REVIEWED)).reviewed).toBe(true);
  });
});

describe("another Host at the same address and port (#437)", () => {
  it("warns on the Address field, naming that Host, and still adds", async () => {
    const { user, backend } = await ready();
    const panel = await openForm(user);
    await fill(user, panel, { Name: "printer-9", Address: "10.19.1.2", User: "admin" });   // linux-1-000's
    const warning = within(panel).getByText(/linux-1-000 is at 10\.19\.1\.2:22 too/);
    expect(warning).toHaveClass("edit-field-warn");
    expect(within(panel).getByLabelText("Address")).toHaveAccessibleDescription(/linux-1-000 is at 10\.19\.1\.2:22 too/);
    expect(within(panel).getByLabelText("Address")).not.toHaveAttribute("aria-invalid");
    await user.click(within(panel).getByLabelText("No Login yet"));
    await user.click(within(panel).getByRole("button", { name: "Add unreviewed" }));
    expect(await screen.findByText(/Added printer-9 to subnet-1 unreviewed/)).toBeInTheDocument();
    expect((await backend.getHost("printer-9")).ip).toBe("10.19.1.2");
  });

  it("says the port as a number (review of #458, L5)", async () => {
    const { user } = await ready();
    const panel = await openForm(user);
    await fill(user, panel, { Name: "printer-9", Address: "10.19.1.2", Port: "022", User: "admin" });
    expect(within(panel).getByText(/linux-1-000 is at 10\.19\.1\.2:22 too/)).toBeInTheDocument();
  });

  it("says nothing on another port: a second sshd on one machine", async () => {
    const { user } = await ready();
    const panel = await openForm(user);
    await fill(user, panel, { Name: "printer-9", Address: "10.19.1.2", Port: "2222" });
    expect(within(panel).queryByText(/is at 10\.19\.1\.2/)).toBeNull();
  });
});

describe("Fill from this item (#437, vault.item_fields, API 29)", () => {
  const vault = () => fixtures["add-vault"] as FakeScenario;

  it("fills the address, port and user from the item the Login names, never its password", async () => {
    const { user, calls } = await ready(vault());
    const panel = await openForm(user);
    await fill(user, panel, { Name: "nas-01" });
    await user.click(within(panel).getByLabelText("An existing vault item"));
    await user.click(within(panel).getByRole("button", { name: "Fill from this item" }));
    await within(panel).findByDisplayValue("10.19.9.50");
    const said = within(panel).getAllByRole("status").find((s) => s.textContent?.startsWith("Filled"));
    expect(said).toHaveTextContent("Filled the address, port and user from bw:nas-01 ssh.");
    expect(within(panel).getByLabelText("Address")).toHaveValue("10.19.9.50");
    expect(within(panel).getByLabelText("Port")).toHaveValue("2222");
    expect(within(panel).getByLabelText("User")).toHaveValue("root");
    expect(calls.filter((c) => c.method === "vaultItemFields").map((c) => c.args)).toEqual([["nas-01 ssh", "bw"]]);
  });

  it("warns at once when the item's address and port are another Host's (review of #458, M1)", async () => {
    const { user } = await ready(vault());
    const panel = await openForm(user);
    await fill(user, panel, { Name: "nas-01" });
    await user.click(within(panel).getByLabelText("An existing vault item"));
    await fill(user, panel, { "Vault item": "bw:old box ssh" });
    await user.click(within(panel).getByRole("button", { name: "Fill from this item" }));
    expect(await within(panel).findByText(/linux-1-000 is at 10\.19\.1\.2:22 too/)).toBeInTheDocument();
  });

  it("drops a reply that comes after the item changed (M2)", async () => {
    const { user } = await ready({ ...vault(), delay: 300 });
    const panel = await openForm(user);
    await fill(user, panel, { Name: "nas-01", Address: "10.19.9.9" });
    await user.click(within(panel).getByLabelText("An existing vault item"));
    await user.click(within(panel).getByRole("button", { name: "Fill from this item" }));
    await user.type(within(panel).getByLabelText("Vault item"), "bw:nas-01 web");
    await new Promise((r) => setTimeout(r, 500));
    expect(within(panel).getByLabelText("Address")).toHaveValue("10.19.9.9");
    expect(within(panel).queryByText(/^Filled/)).toBeNull();
  });

  it("holds the address, port and user while it reads, and keeps focus on the button (M2, L1)", async () => {
    const { user } = await ready({ ...vault(), delay: 300 });
    const panel = await openForm(user);
    await fill(user, panel, { Name: "nas-01" });
    await user.click(within(panel).getByLabelText("An existing vault item"));
    const button = within(panel).getByRole("button", { name: "Fill from this item" });
    button.focus();
    await user.keyboard("{Enter}");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveFocus();
    for (const label of ["Address", "Port", "User"]) expect(within(panel).getByLabelText(label)).toHaveAttribute("readonly");
    await user.keyboard("{Enter}");                               // a second press while it reads asks nothing more
    await within(panel).findByDisplayValue("10.19.9.50");
    expect(within(panel).getByLabelText("Address")).not.toHaveAttribute("readonly");
  });

  it("says why an item gave no address, and keeps what was typed", async () => {
    const { user } = await ready(vault());
    const panel = await openForm(user);
    await fill(user, panel, { Name: "nas-01", Address: "10.19.9.9" });
    await user.click(within(panel).getByLabelText("An existing vault item"));
    await fill(user, panel, { "Vault item": "bw:nas-01 web" });
    await user.click(within(panel).getByRole("button", { name: "Fill from this item" }));
    const said = () => within(panel).getAllByRole("status").find((s) => s.textContent?.startsWith("Nothing new"));
    await expect.poll(() => said()?.textContent).toBe(
      "Nothing new in bw:nas-01 web: its URI isn't a network address (androidapp:), so it gives no address.",
    );
    expect(within(panel).getByLabelText("Address")).toHaveValue("10.19.9.9");
  });

  it("shows roster's refusal under the item, and adds nothing", async () => {
    const { user, calls } = await ready(vault());
    const panel = await openForm(user);
    await user.click(within(panel).getByLabelText("An existing vault item"));
    await fill(user, panel, { "Vault item": "bw:nope" });
    await user.click(within(panel).getByRole("button", { name: "Fill from this item" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("no vault item matches 'nope'");
    expect(within(panel).getByLabelText("Address")).toHaveValue("");
    expect(calls.some((c) => c.method === "addHost" || c.method === "scanKey")).toBe(false);
  });

  it("isn't offered for a typed password, and waits for an item that's a reference", async () => {
    const { user } = await ready(vault());
    const panel = await openForm(user);
    expect(within(panel).queryByRole("button", { name: "Fill from this item" })).toBeNull();     // Type its password
    await user.click(within(panel).getByLabelText("An existing vault item"));
    await fill(user, panel, { "Vault item": "nas ssh" });
    expect(within(panel).getByRole("button", { name: "Fill from this item" })).toBeDisabled();
    await fill(user, panel, { "Vault item": "", Name: "" });          // L4: no item to read
    expect(within(panel).getByRole("button", { name: "Fill from this item" })).toBeDisabled();
    await user.keyboard("{Escape}");
  });

  it("isn't there on a roster too old for vault.item_fields", async () => {
    const { user } = await ready({ ...vault(), apiVersion: 28 });
    const panel = await openForm(user);
    await user.click(within(panel).getByLabelText("An existing vault item"));
    expect(within(panel).queryByRole("button", { name: "Fill from this item" })).toBeNull();
  });
});

describe("the Picker with nothing matching (round 19)", () => {
  it("offers Add a Host with its keys, and those keys open the form from there", async () => {
    const { user } = await ready();
    await user.keyboard(`${LEADER}f`);
    await user.keyboard("zzzz");
    const next = document.querySelector(".picker-empty-next") as HTMLElement;
    expect(next).toHaveTextContent(/Add a Host/);
    expect(next.querySelector(".keycap")).not.toBeNull();
    await user.keyboard(`${LEADER}+`);
    expect(await form()).toBeInTheDocument();
  });

  it("isn't offered on a roster too old to add Hosts", async () => {
    const { user } = await ready({ ...(fixtures.add as FakeScenario), apiVersion: 5 });
    await user.keyboard(`${LEADER}f`);
    await user.keyboard("zzzz");
    expect(screen.queryByRole("button", { name: "Add a Host" })).toBeNull();
  });
});
