// Ticket 14: Quick Connect, a Session to user@address[:port], a box that isn't in the Inventory.
// Typed in the Picker, after `:connect`, or reached from the toolbar. The pane shows the box's key
// and asks for the password in a masked field that empties as soon as it's sent; Esc connects
// nothing. Fake Backend, stub terminal.
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_FINGERPRINT, FAKE_HOST_PASSWORD, FAKE_PASSWORD, fakeBackend, makeHosts, type FakeBackend } from "./backend/fake";
import { QUICK_CONNECT_API_VERSION } from "./backend/types";
import { StubTerminal } from "./terminal/StubTerminal";

const hosts = makeHosts(12);

function backendAt(apiVersion = QUICK_CONNECT_API_VERSION) {
  return fakeBackend({ hosts, apiVersion });
}

async function ready(backend: FakeBackend = backendAt()) {
  const user = userEvent.setup();
  render(<App backend={backend} terminalView={StubTerminal} />);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return user;
}

const pane = (label: string) => screen.getByRole("group", { name: `Session ${label}` });
const question = (label: string) => within(pane(label)).findByRole("alertdialog", { name: `Quick Connect to ${label}` });

describe("Quick Connect", () => {
  it("`:connect user@address` shows the box's key, takes the password and connects", async () => {
    const backend = backendAt();
    const user = await ready(backend);
    await user.keyboard(`{Control>} {/Control}:connect root@10.0.0.5{Enter}`);
    const q = await question("root@10.0.0.5");
    expect(q).toHaveTextContent("roster hasn't seen a key at 10.0.0.5:22 before.");
    expect(within(q).getByText("ssh-ed25519")).toBeInTheDocument();
    expect(within(q).getByText(FAKE_FINGERPRINT)).toBeInTheDocument();
    const field = within(q).getByLabelText("Password for root");
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveFocus();
    // Enter connects only once the key is marked checked (round 14): an unread key is never trusted.
    await user.keyboard(`${FAKE_HOST_PASSWORD}{Enter}`);
    expect(backend.quickConnects()).toEqual([]);
    await user.click(within(q).getByRole("checkbox", { name: "I've checked this key" }));
    await user.click(field);
    await user.keyboard("{Enter}");
    expect(field).toHaveValue("");
    await within(pane("root@10.0.0.5")).findByText("Connected to root@10.0.0.5", { exact: false });
    expect(backend.quickConnects()).toEqual([
      { user: "root", address: "10.0.0.5", port: 22, fingerprint: FAKE_FINGERPRINT, password: true },
    ]);
    expect(within(pane("root@10.0.0.5")).getByLabelText("terminal input")).toHaveFocus();
    expect(document.body.innerHTML).not.toContain(FAKE_HOST_PASSWORD);
  });

  it("opens from the Picker: typing user@address:port offers it first", async () => {
    const user = await ready();
    await user.click(within(screen.getByRole("toolbar", { name: "Commands" })).getByRole("button", { name: "Quick Connect" }));
    const picker = screen.getByRole("dialog", { name: "Find a Host" });
    await user.keyboard("admin@sw-core.lab:2222");
    const offer = within(picker).getByRole("option", { selected: true });
    expect(offer).toHaveTextContent("Quick Connect");
    expect(offer).toHaveTextContent("admin@sw-core.lab:2222");
    await user.keyboard("{Enter}");
    expect(await question("admin@sw-core.lab:2222")).toHaveTextContent("sw-core.lab:2222");
  });

  it("Esc connects nothing and leaves no Session", async () => {
    const backend = backendAt();
    const user = await ready(backend);
    await user.keyboard(`{Control>} {/Control}:connect root@10.0.0.5{Enter}`);
    await question("root@10.0.0.5");
    await user.keyboard("typed{Escape}");
    await waitFor(() => expect(screen.queryByRole("group", { name: "Session root@10.0.0.5" })).toBeNull());
    expect(backend.quickConnects()).toEqual([]);
  });

  it("refuses a key that differs from the recorded one, without Host-only fixes", async () => {
    const user = await ready(fakeBackend({ hosts, apiVersion: QUICK_CONNECT_API_VERSION, scanKeys: { "10.0.0.43": { recorded: "changed" } } }));
    await user.keyboard(`{Control>} {/Control}:connect admin@10.0.0.43{Enter}`);
    const p = within(pane("admin@10.0.0.43"));
    expect(await p.findByRole("heading", { name: /couldn't open a session/i })).toBeInTheDocument();
    expect(p.getAllByText(/host key changed - not connecting/)[0]).toBeInTheDocument();
    expect(p.queryByRole("button", { name: "Run :check" })).toBeNull();
    expect(p.queryByRole("alertdialog")).toBeNull();
  });

  it("isn't offered by a roster older than API 12", async () => {
    const user = await ready(backendAt(QUICK_CONNECT_API_VERSION - 1));
    expect(within(screen.getByRole("toolbar", { name: "Commands" })).queryByRole("button", { name: "Quick Connect" })).toBeNull();
    await user.keyboard(`{Control>} {/Control}:connect root@10.0.0.5{Enter}`);
    expect(await screen.findByText(/Quick Connect needs a newer roster \(API version 12/)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Session root@10.0.0.5" })).toBeNull();
  });

  it("`:open user@address` connects through Quick Connect, and goes back to that Session once it's open", async () => {
    const backend = backendAt();
    const user = await ready(backend);
    await user.keyboard(`{Control>} {/Control}:open root@10.0.0.5{Enter}`);
    const q = await question("root@10.0.0.5");
    await user.click(within(q).getByRole("checkbox", { name: "I've checked this key" }));
    await user.click(within(q).getByLabelText("Password for root"));
    await user.keyboard(`${FAKE_HOST_PASSWORD}{Enter}`);
    await within(pane("root@10.0.0.5")).findByText("Connected to root@10.0.0.5", { exact: false });
    const host = hosts.hosts.find((h) => h.reviewed)!.name;
    await user.keyboard(`{Control>} {/Control}:open ${host}{Enter}`);
    await within(pane(host)).findByText(`Connected to ${host}`, { exact: false });
    await user.keyboard(`{Control>} {/Control}:open root@10.0.0.5{Enter}`);
    expect(screen.queryByText(/No Host named/)).toBeNull();
    expect(screen.getAllByRole("group", { name: "Session root@10.0.0.5" })).toHaveLength(1);
    expect(backend.quickConnects()).toHaveLength(1);
    await waitFor(() => expect(within(pane("root@10.0.0.5")).getByLabelText("terminal input")).toHaveFocus());
  });

  it("still opens a Host by its name", async () => {
    const user = await ready();
    const host = hosts.hosts.find((h) => h.reviewed)!.name;
    await user.keyboard(`{Control>} {/Control}:connect ${host}{Enter}`);
    await within(pane(host)).findByText(`Connected to ${host}`, { exact: false });
  });
});
