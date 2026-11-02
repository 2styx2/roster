// Ticket 16: "Save to vault" for a Host whose Login is still `auth: prompt`. roster has no password
// to look up, so the pane asks for it with the same masked field and tick as Quick Connect; once the
// Session logged in with it, the save makes `<host> ssh` and points the Host's Login at it, as a
// Pending change. Fake Backend, stub terminal.
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_HOST_PASSWORD, FAKE_PASSWORD, fakeBackend, makeHosts, type FakeBackend, type FakeScenario } from "./backend/fake";
import { QUICK_CONNECT_API_VERSION, SAVE_TO_VAULT_API_VERSION } from "./backend/types";
import { StubTerminal } from "./terminal/StubTerminal";

const base = makeHosts(12);
const prompted = base.hosts.find((h) => h.reviewed)!;
const HOST = prompted.name;
const hosts = {
  ...base,
  hosts: base.hosts.map((h) => (h.name === HOST ? { ...h, enroll: false, ssh: { ...h.ssh, user: "root", auth: "prompt" } } : h)),
};

function backendWith(extra: Partial<FakeScenario> = {}) {
  return fakeBackend({ hosts, apiVersion: SAVE_TO_VAULT_API_VERSION, pending: { [base.hosts[1]!.name]: { title: "x" } }, ...extra });
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

const pane = () => screen.getByRole("group", { name: `Session ${HOST}` });

async function open(user: ReturnType<typeof userEvent.setup>, { save = true, password = FAKE_HOST_PASSWORD } = {}) {
  await user.keyboard(`{Control>} {/Control}:connect ${HOST}{Enter}`);
  const q = await within(pane()).findByRole("alertdialog", { name: `Password for ${HOST}` });
  expect(q).toHaveTextContent(`${HOST}'s Login is auth: prompt`);
  const field = within(q).getByLabelText("Password for root");
  expect(field).toHaveFocus();
  if (save) {
    await user.click(within(q).getByRole("checkbox", { name: /save to vault/i }));
    await user.click(field);
  }
  await user.keyboard(`${password}{Enter}`);
  expect(field).toHaveValue("");
}

describe('"Save to vault" for an auth: prompt Host', () => {
  it("asks for the password, then saves it and points the Login at it", async () => {
    const backend = backendWith();
    const user = await ready(backend);
    await open(user);
    await within(pane()).findByText(`Connected to ${HOST}`, { exact: false });
    const note = await within(pane()).findByRole("status", { name: "Save to vault" });
    await user.click(within(note).getByRole("button", { name: "Save…" }));
    const panel = await screen.findByRole("region", { name: "Save to vault" });
    expect(within(panel).queryByLabelText("Host name")).toBeNull();
    expect(within(panel).getByText(`${HOST} ssh`)).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Save" }));
    expect(await screen.findByText(new RegExp(`Saved ${HOST}'s password to the vault as ${HOST} ssh`))).toBeInTheDocument();
    const saved = (await backend.listHosts()).hosts.find((h) => h.name === HOST)!;
    expect(saved.ssh.auth).toBe(`bw:${HOST} ssh`);
    expect(document.body.innerHTML).not.toContain(FAKE_HOST_PASSWORD);
  });

  it("logs in without saving when the box isn't ticked", async () => {
    const backend = backendWith();
    const user = await ready(backend);
    await open(user, { save: false });
    await within(pane()).findByText(`Connected to ${HOST}`, { exact: false });
    expect(within(pane()).queryByRole("status", { name: "Save to vault" })).toBeNull();
    expect(backend.held()).toEqual([]);
  });

  it("a refused password saves nothing", async () => {
    const backend = backendWith();
    const user = await ready(backend);
    await open(user, { password: "nope" });
    await within(pane()).findByRole("heading", { name: /session ended/i });
    await waitFor(() => expect(backend.forgotten()).toHaveLength(1));
    expect((await backend.listHosts()).hosts.find((h) => h.name === HOST)!.ssh.auth).toBe("prompt");
  });

  it("Esc connects nothing", async () => {
    const user = await ready();
    await user.keyboard(`{Control>} {/Control}:connect ${HOST}{Enter}`);
    await within(pane()).findByRole("alertdialog", { name: `Password for ${HOST}` });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("group", { name: `Session ${HOST}` })).toBeNull());
  });

  it("a roster older than API 13 keeps refusing it as before", async () => {
    const user = await ready(backendWith({ apiVersion: QUICK_CONNECT_API_VERSION }));
    await user.keyboard(`{Control>} {/Control}:connect ${HOST}{Enter}`);
    expect(await within(pane()).findByRole("heading", { name: /couldn't open a session/i })).toBeInTheDocument();
  });
});
