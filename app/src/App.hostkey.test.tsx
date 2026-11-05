// Ticket 36 (decision Q60): a Session to a Host whose host key roster hasn't recorded asks first,
// in the pane's connect card: the Host, address:port, key type and SHA256 fingerprint. Enter
// trusts and connects, Esc cancels and leaves no Session.
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_FINGERPRINT, FAKE_PASSWORD, fakeBackend, makeHosts, type FakeScenario } from "./backend/fake";
import { HOST_KEY_API_VERSION } from "./backend/types";
import { StubTerminal } from "./terminal/StubTerminal";

const hosts = makeHosts(12);
const HOST = hosts.hosts.find((h) => h.reviewed && h.enroll)!;
const OTHER = hosts.hosts.find((h) => h.reviewed && h.enroll && h.name !== HOST.name)!;

function backendWith(unknown: NonNullable<FakeScenario["unknownKeys"]>[string] = {}) {
  const backend = fakeBackend({ hosts, apiVersion: HOST_KEY_API_VERSION, unknownKeys: { [HOST.name]: unknown } });
  const trusted: string[] = [];
  const trust = backend.trustHostKey.bind(backend);
  backend.trustHostKey = (host, fp) => (trusted.push(`${host} ${fp}`), trust(host, fp));
  return { backend, trusted };
}

async function ready(backend: ReturnType<typeof fakeBackend>) {
  const user = userEvent.setup();
  render(<App backend={backend} terminalView={StubTerminal} />);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return user;
}

const sessions = () => within(screen.getByRole("group", { name: "Sessions" }));
const pane = (host = HOST.name) => screen.getByRole("group", { name: `Session ${host}` });
const question = () => within(pane()).findByRole("alertdialog", { name: `Trust ${HOST.name}'s host key?` });

describe("a Host whose host key roster hasn't seen", () => {
  it("asks first, with the key, opens on Cancel, and Tab then Enter trusts it and connects", async () => {
    const { backend, trusted } = backendWith();
    const user = await ready(backend);
    await user.keyboard(`{Control>} {/Control}:connect ${HOST.name}{Enter}`);
    const q = await question();
    expect(q).toHaveTextContent("roster hasn't seen this Host's key before.");
    expect(within(q).getByText(`${HOST.ip}:22`)).toBeInTheDocument();
    expect(within(q).getByText("ssh-ed25519")).toBeInTheDocument();
    expect(within(q).getByText(FAKE_FINGERPRINT)).toBeInTheDocument();
    // A reflexive Enter can't trust an unread key: the question opens on Cancel (Q60, round 11).
    expect(within(q).getByRole("button", { name: /^Cancel/ })).toHaveFocus();
    expect(sessions().getByRole("treeitem", { current: true })).toHaveAccessibleName(
      new RegExp(`^${HOST.name}, new host key`),
    );
    expect(trusted).toEqual([]);
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(within(q).getByRole("button", { name: "Trust and connect" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(within(pane()).queryByRole("alertdialog")).toBeNull());
    expect(trusted).toEqual([`${HOST.name} ${FAKE_FINGERPRINT}`]);
    await within(pane()).findByText(`Connected to ${HOST.name}`, { exact: false });
    expect(within(pane()).getByLabelText("terminal input")).toHaveFocus(); // back to typing
    // The next Session to it connects without asking.
    await user.keyboard(`{Control>} {/Control}:connect ${HOST.name}{Enter}`);
    await within(screen.getByRole("group", { name: `Session ${HOST.name} (2)` })).findByText(
      `Connected to ${HOST.name}`,
      { exact: false },
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("Esc records nothing and leaves no Session", async () => {
    const { backend, trusted } = backendWith();
    const user = await ready(backend);
    await user.keyboard(`{Control>} {/Control}:connect ${HOST.name}{Enter}`);
    await question();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("group", { name: `Session ${HOST.name}` })).toBeNull());
    expect(sessions().queryByRole("treeitem", { name: new RegExp(`^${HOST.name}`) })).toBeNull();
    expect(trusted).toEqual([]);
  });

  it("refuses a key that changed between the question and the trust", async () => {
    const { backend } = backendWith({ changesOnTrust: true });
    const user = await ready(backend);
    await user.keyboard(`{Control>} {/Control}:connect ${HOST.name}{Enter}`);
    await user.click(within(await question()).getByRole("button", { name: "Trust and connect" }));
    expect(await within(pane()).findByRole("heading", { name: /couldn't open a session/i })).toBeInTheDocument();
    expect(within(pane()).getAllByText(/host key changed while roster was asking/)[0]).toBeInTheDocument();
    expect(within(pane()).queryByRole("alertdialog")).toBeNull();
  });

  it("doesn't ask through a roster older than API 11", async () => {
    const backend = fakeBackend({ hosts, apiVersion: HOST_KEY_API_VERSION - 1, unknownKeys: { [HOST.name]: {} } });
    const user = await ready(backend);
    await user.keyboard(`{Control>} {/Control}:connect ${HOST.name}{Enter}`);
    expect(await within(pane()).findByRole("heading", { name: /couldn't open a session/i })).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("never asks about a Host whose key is recorded", async () => {
    const { backend } = backendWith();
    const user = await ready(backend);
    await user.keyboard(`{Control>} {/Control}:connect ${OTHER.name}{Enter}`);
    await within(pane(OTHER.name)).findByText(`Connected to ${OTHER.name}`, { exact: false });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
