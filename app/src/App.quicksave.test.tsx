// Ticket 15: "Save to vault" on Quick Connect. A tick under the password field asks roster to hold
// the typed password; only once the Session has logged in with it does the pane offer the save. The
// form asks for a Host name (pre-filled from what the box's shell calls itself), its group and where
// in the vault; roster then makes the Vault item and adds the Host as a Pending change. Fake Backend,
// stub terminal.
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_HOST_PASSWORD, FAKE_PASSWORD, fakeBackend, makeHosts, type FakeBackend, type FakeScenario } from "./backend/fake";
import { QUICK_CONNECT_API_VERSION, SAVE_TO_VAULT_API_VERSION } from "./backend/types";
import { StubTerminal } from "./terminal/StubTerminal";

const hosts = makeHosts(12);
const LABEL = "root@10.0.0.5";

function backendWith(extra: Partial<FakeScenario> = {}) {
  return fakeBackend({
    hosts,
    apiVersion: SAVE_TO_VAULT_API_VERSION,
    pending: { [hosts.hosts[0]!.name]: { title: "pending" } },
    quickBoxes: { "10.0.0.5": { hostname: "nas-01" } },
    vaultItems: ["dup ssh"],
    ...extra,
  });
}

async function ready(backend: FakeBackend = backendWith()) {
  const user = userEvent.setup();
  render(<App backend={backend} terminalView={StubTerminal} />);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  // The confirmations' whole text shows with every message on (ticket 111).
  await user.keyboard("{Control>} {/Control}:messages all{Enter}");
  return user;
}

const pane = () => screen.getByRole("group", { name: `Session ${LABEL}` });

async function connect(user: ReturnType<typeof userEvent.setup>, { save = true, password = FAKE_HOST_PASSWORD } = {}) {
  await user.keyboard(`{Control>} {/Control}:connect ${LABEL}{Enter}`);
  const q = await within(pane()).findByRole("alertdialog", { name: `Quick Connect to ${LABEL}` });
  if (save) await user.click(within(q).getByRole("checkbox", { name: /save to vault/i }));
  await user.click(within(q).getByLabelText("Password for root"));
  await user.keyboard(`${password}{Enter}`);
}

const offer = () => within(pane()).findByRole("status", { name: "Save to vault" });

describe('"Save to vault" on Quick Connect', () => {
  it("offers the save only after the login, then saves the Vault item and the Host", async () => {
    const backend = backendWith();
    const user = await ready(backend);
    await connect(user);
    const note = await offer();
    expect(note).toHaveTextContent(`${LABEL} logged in with the password you typed.`);
    expect(backend.held()).toEqual(["q1"]);
    await user.click(within(note).getByRole("button", { name: "Save…" }));
    const panel = await screen.findByRole("region", { name: "Save to vault" });
    const name = within(panel).getByLabelText("Host name");
    await waitFor(() => expect(name).toHaveValue("nas-01"));
    expect(within(panel).getByText("nas-01 ssh")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Saved nas-01 to .* as a Pending change; its password is in the vault as nas-01 ssh/)).toBeInTheDocument();
    expect(backend.quickSaves()).toEqual([expect.objectContaining({ quick: "q1", name: "nas-01", item: "nas-01 ssh" })]);
    expect(screen.queryByRole("region", { name: "Save to vault" })).toBeNull();
    expect(within(pane()).queryByRole("status", { name: "Save to vault" })).toBeNull();
    expect(document.body.innerHTML).not.toContain(FAKE_HOST_PASSWORD);
  });

  it("calls out a Host name the pull brought while the form was open (T72)", async () => {
    const theirs = { ...hosts.hosts[1]!, name: "nas-01" };
    // No Pending changes here, so the form pulls; the pull brings a Host named as the box calls itself.
    const backend = backendWith({ pending: {}, pullDelay: 200, pullBrings: { commits: 1, changes: {}, adds: [theirs] } });
    const user = await ready(backend);
    await connect(user);
    await user.click(within(await offer()).getByRole("button", { name: "Save…" }));
    const panel = await screen.findByRole("region", { name: "Save to vault" });
    await waitFor(() => expect(within(panel).getByLabelText("Host name")).toHaveValue("nas-01"));
    const note = await within(panel).findByText(/The pull brought a Host named/);
    expect(note).toHaveTextContent("The pull brought a Host named nas-01, so this one needs another name.");
    await user.click(within(panel).getByRole("button", { name: "Save" }));
    expect(backend.quickSaves()).toEqual([]);
  });

  it("`:save` opens the same form", async () => {
    const user = await ready();
    await connect(user);
    await offer();
    await user.keyboard(`{Control>} {/Control}:save{Enter}`);
    expect(await screen.findByRole("region", { name: "Save to vault" })).toBeInTheDocument();
  });

  it("says why when a Vault item by that name is already there, and keeps the offer", async () => {
    const backend = backendWith();
    const user = await ready(backend);
    await connect(user);
    await user.click(within(await offer()).getByRole("button", { name: "Save…" }));
    const panel = await screen.findByRole("region", { name: "Save to vault" });
    const name = within(panel).getByLabelText("Host name");
    await user.clear(name);
    await user.type(name, "dup{Enter}");
    expect(await within(panel).findByText(/a Bitwarden item named 'dup ssh' already exists/)).toBeInTheDocument();
    expect((await backend.listHosts()).hosts.some((h) => h.name === "dup")).toBe(false);
    expect(within(pane()).getByRole("status", { name: "Save to vault" })).toBeInTheDocument();
  });

  it("Not now forgets the password", async () => {
    const backend = backendWith();
    const user = await ready(backend);
    await connect(user);
    await user.click(within(await offer()).getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(backend.forgotten()).toEqual(["q1"]));
    expect(within(pane()).queryByRole("status", { name: "Save to vault" })).toBeNull();
  });

  it("offers nothing when the box refused the password", async () => {
    const backend = backendWith();
    const user = await ready(backend);
    await connect(user, { password: "nope" });
    await within(pane()).findByRole("heading", { name: /session ended/i });
    expect(within(pane()).queryByRole("status", { name: "Save to vault" })).toBeNull();
    await waitFor(() => expect(backend.forgotten()).toEqual(["q1"]));
  });

  it("holds nothing when the box isn't ticked", async () => {
    const backend = backendWith();
    const user = await ready(backend);
    await connect(user, { save: false });
    await within(pane()).findByText(`Connected to ${LABEL}`, { exact: false });
    expect(backend.held()).toEqual([]);
  });

  it("isn't offered by a roster older than API 13", async () => {
    const user = await ready(backendWith({ apiVersion: QUICK_CONNECT_API_VERSION }));
    await user.keyboard(`{Control>} {/Control}:connect ${LABEL}{Enter}`);
    const q = await within(pane()).findByRole("alertdialog", { name: `Quick Connect to ${LABEL}` });
    expect(within(q).queryByRole("checkbox", { name: /save to vault/i })).toBeNull();
  });
});
