// Ticket 36 (decision Q60): a Session to a Host whose host key roster hasn't recorded asks first,
// in the pane's connect card: the Host, address:port, key type and SHA256 fingerprint. Enter
// trusts and connects, Esc cancels and leaves no Session.
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_FINGERPRINT, FAKE_PASSWORD, fakeBackend, makeHosts, type FakeScenario } from "./backend/fake";

import { StubTerminal } from "./terminal/StubTerminal";
import { memoryPlatform } from "./platform/memory";
import { revealInCard } from "./session/reveal";

// Where the card scrolls is reveal.test.ts's (jsdom has no layout); here, what it's asked to show.
vi.mock("./session/reveal", async (original) => {
  const real = await original<typeof import("./session/reveal")>();
  return { ...real, revealInCard: vi.fn(real.revealInCard) };
});
import { sinceOf } from "./backend/capabilities";

const hosts = makeHosts(12);
const HOST = hosts.hosts.find((h) => h.reviewed && h.enroll)!;
const OTHER = hosts.hosts.find((h) => h.reviewed && h.enroll && h.name !== HOST.name)!;

function backendWith(unknown: NonNullable<FakeScenario["unknownKeys"]>[string] = {}) {
  const backend = fakeBackend({ hosts, apiVersion: sinceOf("hostKey"), unknownKeys: { [HOST.name]: unknown } });
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
    // Enter on the card itself never trusts (Q234).
    q.focus();
    await user.keyboard("{Enter}");
    expect(trusted).toEqual([]);
    within(q).getByRole("button", { name: /^Cancel/ }).focus();
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

  it("points to :help host-keys, and Enter on that pointer never trusts (round 18)", async () => {
    const { backend, trusted } = backendWith();
    const user = await ready(backend);
    await user.keyboard(`{Control>} {/Control}:connect ${HOST.name}{Enter}`);
    const q = await question();
    const link = within(q).getByRole("button", { name: /:help host-keys/ });
    expect(link).toHaveTextContent(":help host-keys");
    // Enter on the pointer (Tab reaches it) opens help; it never trusts or connects.
    link.focus();
    await user.keyboard("{Enter}");
    const help = await screen.findByRole("complementary", { name: "Help" });
    expect(await within(help).findByRole("heading", { name: "Checking a host key" })).toBeInTheDocument();
    expect(trusted).toEqual([]);
    expect(within(pane()).getByRole("alertdialog")).toBeInTheDocument();
    // Nor does Enter on the card itself, or a click on the dim key on Trust's side: only Trust.
    q.focus();
    await user.keyboard("{Enter}");
    expect(trusted).toEqual([]);
  });

  it("opens at its top: focusing Cancel in the pinned footer doesn't scroll the card (round 18)", async () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      const { backend, trusted } = backendWith();
      const user = await ready(backend);
      await user.keyboard(`{Control>} {/Control}:connect ${HOST.name}{Enter}`);
      const q = await question();
      const cancel = within(q).getByRole("button", { name: /^Cancel/ });
      expect(cancel).toHaveFocus();
      expect(scrolled.filter((el) => q.contains(el))).toEqual([]);
      // Trust keeps its Enter key's room, shown only once it has focus (rounds 18, 21).
      const trust = within(q).getByRole("button", { name: "Trust and connect" });
      expect(trust.querySelector(".key-enter")).not.toBeNull();
      expect(trust.querySelector(".key-enter.on")).toBeNull();
      expect(trusted).toEqual([]);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("Tab and Shift+Tab to the pinned buttons never scroll the card, and Enter still only trusts from Trust (round 20)", async () => {
    const calls: { el: Element; options: FocusOptions | undefined }[] = [];
    const original = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
      calls.push({ el: this, options });
      original.call(this, options);
    };
    try {
      const { backend, trusted } = backendWith();
      const user = await ready(backend);
      await user.keyboard(`{Control>} {/Control}:connect ${HOST.name}{Enter}`);
      const q = await question();
      const cancel = within(q).getByRole("button", { name: /^Cancel/ });
      const trust = within(q).getByRole("button", { name: "Trust and connect" });
      const link = within(q).getByRole("button", { name: /:help host-keys/ });
      expect(cancel).toHaveFocus();
      const focused = (el: Element) => calls.filter((c) => c.el === el).at(-1)?.options;
      // Shift+Tab: Cancel to Trust, both in the pinned footer: focus without a scroll.
      await user.keyboard("{Shift>}{Tab}{/Shift}");
      expect(trust).toHaveFocus();
      expect(focused(trust)?.preventScroll).toBe(true);
      // On to the pointer (in the scrolling body): focus doesn't scroll on its own; the card
      // brings it whole into view, no line cut at an edge (round 21; reveal.test.ts).
      vi.mocked(revealInCard).mockClear();
      await user.keyboard("{Shift>}{Tab}{/Shift}");
      expect(link).toHaveFocus();
      expect(focused(link)?.preventScroll).toBe(true);
      expect(revealInCard).toHaveBeenCalledWith(q, link, null, 22);
      // Round the cycle to Cancel (wraps), then Tab back to the pointer and to Trust.
      await user.keyboard("{Shift>}{Tab}{/Shift}");
      expect(cancel).toHaveFocus();
      expect(focused(cancel)?.preventScroll).toBe(true);
      await user.tab();
      expect(link).toHaveFocus();
      await user.tab();
      expect(trust).toHaveFocus();
      expect(focused(trust)?.preventScroll).toBe(true);
      expect(trusted).toEqual([]);
      // Enter on the card itself still never trusts; Enter on Trust does.
      q.focus();
      await user.keyboard("{Enter}");
      expect(trusted).toEqual([]);
      trust.focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(trusted).toEqual([`${HOST.name} ${FAKE_FINGERPRINT}`]));
    } finally {
      HTMLElement.prototype.focus = original;
    }
  });

  it("↵ shows on the button Enter acts on: Cancel as it opens, Trust only once it has focus (round 21)", async () => {
    const { backend, trusted } = backendWith();
    const user = await ready(backend);
    await user.keyboard(`{Control>} {/Control}:connect ${HOST.name}{Enter}`);
    const q = await question();
    const cancel = within(q).getByRole("button", { name: /^Cancel/ });
    const trust = within(q).getByRole("button", { name: "Trust and connect" });
    const enter = (b: HTMLElement) => b.querySelector(".key-enter.on") !== null;
    // Both keep the ↵'s room, so focus never resizes either.
    expect(cancel.querySelector(".key-enter")).not.toBeNull();
    expect(trust.querySelector(".key-enter")).not.toBeNull();
    expect(cancel).toHaveFocus();
    expect([enter(cancel), enter(trust)]).toEqual([true, false]);
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(trust).toHaveFocus();
    expect([enter(cancel), enter(trust)]).toEqual([false, true]);
    // On the help pointer Enter opens help: neither button shows it.
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect([enter(cancel), enter(trust)]).toEqual([false, false]);
    // Clicking the card's text focuses the card: Enter there never trusts, so no ↵.
    await user.click(within(q).getByText("roster hasn't seen this Host's key before."));
    expect([enter(cancel), enter(trust)]).toEqual([false, false]);
    expect(trusted).toEqual([]);
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

  it("lists a Host under Recent only once its Session reaches a shell, not when its question is cancelled (round 21)", async () => {
    const { backend } = backendWith();
    const user = userEvent.setup();
    const platform = memoryPlatform({ state: { version: 1, recentHosts: [], folded: [] } });
    render(<App backend={backend} terminalView={StubTerminal} platform={platform} />);
    await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    await screen.findByRole("main", { name: /workspace/i });
    await user.keyboard(`{Control>} {/Control}:connect ${HOST.name}{Enter}`);
    await question();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("group", { name: `Session ${HOST.name}` })).toBeNull());
    // Never logged in: no history, so the idle pane still starts from the Inventory.
    expect(screen.queryByRole("region", { name: "Recent" })).toBeNull();
    await user.keyboard(`{Control>} {/Control}:connect ${OTHER.name}{Enter}`);
    await within(pane(OTHER.name)).findByText(`Connected to ${OTHER.name}`, { exact: false });
    await user.keyboard(`{Control>} {/Control}:close{Enter}`);
    const recent = await screen.findByRole("region", { name: "Recent" });
    expect(Array.from(recent.querySelectorAll(".recent-name")).map((n) => n.textContent)).toEqual([OTHER.name]);
  });

  it("Cancel says the key wasn't trusted and nothing was saved, calmly (round 21)", async () => {
    const { backend, trusted } = backendWith();
    const user = await ready(backend);
    await user.keyboard(`{Control>} {/Control}:connect ${HOST.name}{Enter}`);
    const q = await question();
    await user.click(within(q).getByRole("button", { name: /^Cancel/ }));
    await waitFor(() => expect(screen.queryByRole("group", { name: `Session ${HOST.name}` })).toBeNull());
    const line = document.querySelector(".message-line") as HTMLElement;
    expect(line).toHaveTextContent(`Didn't trust ${HOST.name}'s key; nothing was saved.`);
    expect(line).toHaveClass("slip");
    // It's true: nothing reached roster's known_hosts.
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
    const backend = fakeBackend({ hosts, apiVersion: sinceOf("hostKey") - 1, unknownKeys: { [HOST.name]: {} } });
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
