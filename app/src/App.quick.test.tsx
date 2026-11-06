// Ticket 14: Quick Connect, a Session to user@address[:port], a box that isn't in the Inventory.
// Typed in the Picker, after `:connect`, or reached from the toolbar. The pane shows the box's key
// and asks for the password in a masked field that empties as soon as it's sent; Esc connects
// nothing. Fake Backend, stub terminal.
import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_FINGERPRINT, FAKE_HOST_PASSWORD, FAKE_PASSWORD, fakeBackend, makeHosts, type FakeBackend } from "./backend/fake";

import { StubTerminal } from "./terminal/StubTerminal";
import { revealInCard } from "./session/reveal";

// Where the card scrolls is reveal.test.ts's (jsdom has no layout); here, that every way in asks
// it to bring the box's row into view, with the key above it (round 21).
vi.mock("./session/reveal", async (original) => {
  const real = await original<typeof import("./session/reveal")>();
  return { ...real, revealInCard: vi.fn(real.revealInCard) };
});
import { sinceOf } from "./backend/capabilities";

const hosts = makeHosts(12);

function backendAt(apiVersion = sinceOf("quickConnect")) {
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
    expect(q).toHaveTextContent("roster hasn't seen a key at this address before.");
    // One template with the Inventory's question (round 18): the address on its own line, as it
    // was typed plus the port, so it doesn't repeat the title's address (round 19).
    expect(within(q).getByText("root@10.0.0.5:22")).toHaveClass("connect-address-line");
    expect(within(q).getByText("ssh-ed25519")).toBeInTheDocument();
    expect(within(q).getByText(FAKE_FINGERPRINT)).toBeInTheDocument();
    const field = within(q).getByLabelText("Password for root");
    expect(field).toHaveAttribute("type", "password");
    // It opens on "I've checked this key" (round 16), so the keys follow the task: tick, then the password.
    expect(within(q).getByLabelText("I've checked this key")).toHaveFocus();
    await user.tab();
    expect(field).toHaveFocus();
    // Enter connects only once the key is marked checked (round 14): an unread key is never trusted.
    await user.keyboard(`${FAKE_HOST_PASSWORD}{Enter}`);
    expect(backend.quickConnects()).toEqual([]);
    // Nor from the card itself (a click on its text focuses it): round 15's P0.
    q.focus();
    await user.keyboard("{Enter}");
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

  it("before the tick, no way in connects: the button, Enter in the field, on the box, on the card, on the help pointer (round 18)", async () => {
    const backend = backendAt();
    const user = await ready(backend);
    await user.keyboard(`{Control>} {/Control}:connect root@10.0.0.5{Enter}`);
    const q = await question("root@10.0.0.5");
    const box = within(q).getByRole("checkbox", { name: "I've checked this key" });
    const trust = within(q).getByRole("button", { name: "Trust and connect" });
    // The Enter key on Trust keeps its room from the start, dim until the tick: ticking never
    // resizes it.
    expect(trust.querySelector(".key-enter.key-dim")).not.toBeNull();
    await user.click(trust);
    expect(within(q).getByRole("alert")).toHaveTextContent("Tick it to trust and connect.");
    box.focus();
    await user.keyboard("{Enter}");
    await user.type(within(q).getByLabelText("Password for root"), `${FAKE_HOST_PASSWORD}{Enter}`);
    q.focus();
    await user.keyboard("{Enter}");
    within(q).getByRole("button", { name: /:help host-keys/ }).focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("complementary", { name: "Help" });
    expect(backend.quickConnects()).toEqual([]);
    await user.click(box);
    expect(trust.querySelector(".key-enter.key-dim")).toBeNull();
    expect(within(q).getByRole("alert")).toHaveTextContent("");
  });

  // Round 22's P2: Enter on the ticked box connected with an empty password while no button
  // showed ↵, the field still under the footer's fade. After the tick Enter on the box or the card
  // goes on to the password field; only Enter in the field, or Trust, connects. An empty field is
  // a key login ("Leave it empty to log in with this Box's keys."), so it connects from there.
  it("after the tick, Enter on the box goes on to the password field, revealed, and connects nothing (round 22)", async () => {
    const backend = backendAt();
    const user = await ready(backend);
    await user.keyboard(`{Control>} {/Control}:connect root@10.0.0.5{Enter}`);
    const q = await question("root@10.0.0.5");
    const box = within(q).getByRole("checkbox", { name: "I've checked this key" });
    const field = within(q).getByLabelText("Password for root");
    const trust = within(q).getByRole("button", { name: "Trust and connect" });
    expect(box).toHaveFocus();
    await user.keyboard(" ");
    expect(box).toBeChecked();
    const reveal = vi.mocked(revealInCard);
    reveal.mockClear();
    await user.keyboard("{Enter}");
    expect(field).toHaveFocus();
    // Revealed with its label and the note under it as one block (round 23: the note lay under
    // the footer's fade), else the field with as much of the note as fits.
    const note = q.querySelector(".quick-keys");
    expect(note).toHaveTextContent("Leave it empty to log in with this Box's keys.");
    expect(reveal).toHaveBeenCalledWith(q, field, note, 22, [field.closest("label"), field, note]);
    expect(backend.quickConnects()).toEqual([]);
    // Now ↵ is on Trust: Enter in the field connects, empty or not.
    expect(trust.querySelector(".key-enter.on")).not.toBeNull();
    await user.keyboard("{Enter}");
    await within(pane("root@10.0.0.5")).findByText("Connected to root@10.0.0.5", { exact: false });
    expect(backend.quickConnects()).toEqual([
      { user: "root", address: "10.0.0.5", port: 22, fingerprint: FAKE_FINGERPRINT, password: false },
    ]);
  });

  it("after the tick, Enter on the card goes on to the password field too, and shows no ↵ (round 22)", async () => {
    const backend = backendAt();
    const user = await ready(backend);
    await user.keyboard(`{Control>} {/Control}:connect root@10.0.0.5{Enter}`);
    const q = await question("root@10.0.0.5");
    const field = within(q).getByLabelText("Password for root");
    const trust = within(q).getByRole("button", { name: "Trust and connect" });
    await user.click(within(q).getByRole("checkbox", { name: "I've checked this key" }));
    q.focus();
    expect(trust.querySelector(".key-enter.on")).toBeNull();
    await user.keyboard("{Enter}");
    expect(field).toHaveFocus();
    expect(backend.quickConnects()).toEqual([]);
    // With a password typed it still goes to the field first; Enter there connects.
    await user.keyboard(FAKE_HOST_PASSWORD);
    q.focus();
    await user.keyboard("{Enter}");
    expect(field).toHaveFocus();
    expect(field).toHaveValue(FAKE_HOST_PASSWORD);
    expect(backend.quickConnects()).toEqual([]);
    await user.keyboard("{Enter}");
    await within(pane("root@10.0.0.5")).findByText("Connected to root@10.0.0.5", { exact: false });
    expect(backend.quickConnects()).toEqual([
      { user: "root", address: "10.0.0.5", port: 22, fingerprint: FAKE_FINGERPRINT, password: true },
    ]);
  });

  it("after the tick, Trust connects, from a click or Enter on it, the field empty or not (round 22)", async () => {
    for (const how of ["click", "enter"] as const) {
      const backend = backendAt();
      const user = await ready(backend);
      await user.keyboard(`{Control>} {/Control}:connect root@10.0.0.5{Enter}`);
      const q = await question("root@10.0.0.5");
      await user.click(within(q).getByRole("checkbox", { name: "I've checked this key" }));
      const trust = within(q).getByRole("button", { name: "Trust and connect" });
      if (how === "click") await user.click(trust);
      else {
        trust.focus();
        await user.keyboard("{Enter}");
      }
      await within(pane("root@10.0.0.5")).findByText("Connected to root@10.0.0.5", { exact: false });
      expect(backend.quickConnects()).toEqual([
        { user: "root", address: "10.0.0.5", port: 22, fingerprint: FAKE_FINGERPRINT, password: false },
      ]);
      cleanup();
    }
  });

  it("a character typed on the box goes into the password field, not nowhere; Space still ticks it (round 22)", async () => {
    const backend = backendAt();
    const user = await ready(backend);
    await user.keyboard(`{Control>} {/Control}:connect root@10.0.0.5{Enter}`);
    const q = await question("root@10.0.0.5");
    const box = within(q).getByRole("checkbox", { name: "I've checked this key" });
    const field = within(q).getByLabelText("Password for root");
    expect(box).toHaveFocus();
    await user.keyboard("h");
    expect(field).toHaveFocus();
    expect(field).toHaveValue("h");
    await user.keyboard("unter2");
    box.focus();
    await user.keyboard("!");
    expect(field).toHaveFocus();
    expect(field).toHaveValue("hunter2!");
    box.focus();
    await user.keyboard(" ");
    expect(box).toBeChecked();
    expect(box).toHaveFocus();
    expect(field).toHaveValue("hunter2!");
    expect(backend.quickConnects()).toEqual([]);
    expect(document.body.innerHTML).not.toContain("hunter2");
  });

  it("a blocked Enter brings focus to the box and marks it until it's ticked: the button, Enter in the field, on the card (round 19)", async () => {
    const backend = backendAt();
    const user = await ready(backend);
    await user.keyboard(`{Control>} {/Control}:connect root@10.0.0.5{Enter}`);
    const q = await question("root@10.0.0.5");
    const box = within(q).getByRole("checkbox", { name: "I've checked this key" });
    // The marked row holds the box and the words together (round 20).
    const row = box.closest(".quick-checked-row");
    const field = within(q).getByLabelText("Password for root");
    const trust = within(q).getByRole("button", { name: "Trust and connect" });
    // The words are beside the box, not in the footer, and don't say where the box is.
    expect(within(q).getByRole("alert").closest(".key-actions")).toBeNull();
    expect(row).not.toHaveAttribute("data-nudged");
    for (const press of [
      () => user.click(trust),
      () => user.type(field, `${FAKE_HOST_PASSWORD}{Enter}`),
      async () => {
        q.focus();
        await user.keyboard("{Enter}");
      },
    ]) {
      await user.click(field);
      await press();
      expect(box).toHaveFocus();
      expect(row).toHaveAttribute("data-nudged");
      expect(row).toContainElement(within(q).getByRole("alert"));
      expect(within(q).getByRole("alert")).toHaveTextContent("Tick it to trust and connect.");
      expect(backend.quickConnects()).toEqual([]);
    }
    await user.keyboard(" ");
    expect(box).toBeChecked();
    expect(row).not.toHaveAttribute("data-nudged");
    expect(within(q).getByRole("alert")).toHaveTextContent("");
    expect(backend.quickConnects()).toEqual([]);
  });

  it("every blocked Enter scrolls the box's row into view, with the key: the button, Enter in the field, on the card (round 21)", async () => {
    const backend = backendAt();
    const user = await ready(backend);
    await user.keyboard(`{Control>} {/Control}:connect root@10.0.0.5{Enter}`);
    const q = await question("root@10.0.0.5");
    const row = q.querySelector(".quick-checked-row");
    const print = q.querySelector(".key-print");
    const field = within(q).getByLabelText("Password for root");
    const trust = within(q).getByRole("button", { name: "Trust and connect" });
    const reveal = vi.mocked(revealInCard);
    for (const press of [
      () => user.click(trust),
      () => user.type(field, `${FAKE_HOST_PASSWORD}{Enter}`),
      async () => {
        q.focus();
        await user.keyboard("{Enter}");
      },
    ]) {
      await user.click(field);
      reveal.mockClear();
      await press();
      expect(reveal).toHaveBeenCalledWith(q, row, print, 22);
    }
    expect(backend.quickConnects()).toEqual([]);
  });

  it("↵ shows on the button Enter acts on: Trust from the password field or Trust itself, Cancel on Cancel, neither on the box (round 21)", async () => {
    const backend = backendAt();
    const user = await ready(backend);
    await user.keyboard(`{Control>} {/Control}:connect root@10.0.0.5{Enter}`);
    const q = await question("root@10.0.0.5");
    const cancel = within(q).getByRole("button", { name: /^Cancel/ });
    const trust = within(q).getByRole("button", { name: "Trust and connect" });
    const field = within(q).getByLabelText("Password for root");
    const enter = (b: HTMLElement) => b.querySelector(".key-enter.on") !== null;
    // It opens on the box: Enter there does nothing.
    expect([enter(trust), enter(cancel)]).toEqual([false, false]);
    await user.click(field);
    expect([enter(trust), enter(cancel)]).toEqual([true, false]);
    await user.tab();
    expect(trust).toHaveFocus();
    expect([enter(trust), enter(cancel)]).toEqual([true, false]);
    await user.tab();
    expect(cancel).toHaveFocus();
    expect([enter(trust), enter(cancel)]).toEqual([false, true]);
    // Dim until the tick arms it.
    expect(trust.querySelector(".key-enter.key-dim")).not.toBeNull();
    expect(backend.quickConnects()).toEqual([]);
  });

  it("in a short window the box sits right under the key it vouches for, before the advice (round 19)", async () => {
    const real = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q.includes("max-height: 460px"),
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
    try {
      const user = await ready();
      await user.keyboard(`{Control>} {/Control}:connect root@10.0.0.5{Enter}`);
      const q = await question("root@10.0.0.5");
      const print = q.querySelector(".key-print");
      const row = q.querySelector(".quick-checked-row");
      const advice = q.querySelector(".key-advice");
      expect(print?.nextElementSibling?.contains(row ?? null) || print?.nextElementSibling === row).toBe(true);
      // In the DOM too, so Tab goes box, help pointer, password, as it reads.
      expect(row!.compareDocumentPosition(advice!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(within(q).getByLabelText("I've checked this key")).toHaveFocus();
      await user.tab();
      expect(within(q).getByRole("button", { name: /:help host-keys/ })).toHaveFocus();
      await user.tab();
      expect(within(q).getByLabelText("Password for root")).toHaveFocus();
    } finally {
      window.matchMedia = real;
    }
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
    // It says so, naming the address the key belongs to (round 21).
    expect(document.querySelector(".message-line")).toHaveTextContent("Didn't trust 10.0.0.5's key; nothing was saved.");
  });

  it("refuses a key that differs from the recorded one, without Host-only fixes", async () => {
    const user = await ready(fakeBackend({ hosts, apiVersion: sinceOf("quickConnect"), scanKeys: { "10.0.0.43": { recorded: "changed" } } }));
    await user.keyboard(`{Control>} {/Control}:connect admin@10.0.0.43{Enter}`);
    const p = within(pane("admin@10.0.0.43"));
    expect(await p.findByRole("heading", { name: /couldn't open a session/i })).toBeInTheDocument();
    expect(p.getAllByText(/host key changed - not connecting/)[0]).toBeInTheDocument();
    expect(p.queryByRole("button", { name: "Run :check" })).toBeNull();
    expect(p.queryByRole("alertdialog")).toBeNull();
  });

  it("isn't offered by a roster older than API 12", async () => {
    const user = await ready(backendAt(sinceOf("quickConnect") - 1));
    expect(within(screen.getByRole("toolbar", { name: "Commands" })).queryByRole("button", { name: "Quick Connect" })).toBeNull();
    await user.keyboard(`{Control>} {/Control}:connect root@10.0.0.5{Enter}`);
    expect(await screen.findByText(/Quick Connect needs a newer roster\. Update roster on this Box\./)).toBeInTheDocument();
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
