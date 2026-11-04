// The Lock (ticket 04): the app opens locked, unlocks with the master password, and locks again on
// <leader> L or after the idle timeout. All through the fake Backend.
import { describe, expect, it } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_PASSWORD, fakeBackend, fixtures, makeHosts, type FakeScenario } from "./backend/fake";
import { defaultOptions } from "./keymap";
import { manualClock } from "./lock/manualClock";

const MIN = 60_000;

async function start(scenario: FakeScenario = { hosts: makeHosts(12) }) {
  const backend = fakeBackend(scenario);
  const clock = manualClock();
  const user = userEvent.setup();
  render(<App backend={backend} clock={clock} />);
  await screen.findByText(/12 hosts|0 hosts/i);
  return { user, backend, clock };
}

const lockScreen = () => screen.queryByRole("dialog", { name: /locked/i });
const sessions = () => screen.queryByRole("main", { name: /workspace/i });
const passwordField = () => screen.getByLabelText<HTMLInputElement>(/master password/i);

async function unlock(user: ReturnType<typeof userEvent.setup>, password = FAKE_PASSWORD) {
  await user.type(await screen.findByLabelText(/master password/i), `${password}{Enter}`);
}

describe("the Lock", () => {
  it("opens locked, with the Sessions hidden", async () => {
    await start();
    expect(await screen.findByRole("dialog", { name: /locked/i })).toBeInTheDocument();
    expect(await screen.findByLabelText("Bitwarden master password")).toBeInTheDocument();
    expect(sessions()).toBeNull();
    expect(passwordField()).toHaveFocus();
  });

  it("unlocks with the master password and clears the field", async () => {
    const { user, backend } = await start();
    const field = await screen.findByLabelText<HTMLInputElement>(/master password/i);
    await user.type(field, `${FAKE_PASSWORD}{Enter}`);
    expect(field.value).toBe("");
    await screen.findByRole("main", { name: /workspace/i });
    expect(lockScreen()).toBeNull();
    expect((await backend.vaultStatus()).status).toBe("unlocked");
  });

  it("says when the password is wrong, clears the field and stays locked", async () => {
    const { user, backend } = await start();
    await unlock(user, "hunter2");
    expect(await screen.findByRole("alert")).toHaveTextContent(/wrong master password/i);
    expect(passwordField().value).toBe("");
    expect(passwordField()).toHaveFocus();
    expect(lockScreen()).not.toBeNull();
    expect((await backend.vaultStatus()).status).toBe("locked");
    await unlock(user);
    await screen.findByRole("main", { name: /workspace/i });
  });

  it("ignores the Leader while locked", async () => {
    const { user } = await start();
    await screen.findByLabelText(/master password/i);
    await user.keyboard("{Control>} {/Control}f");
    expect(screen.queryByRole("dialog", { name: /find a host/i })).toBeNull();
  });

  it("locks serve again when an unlock times out but serve finishes it anyway", async () => {
    // roster-core gives up on a call after 60 s, but serve carries on: the UI stays locked, so serve
    // must not be left holding an unlocked vault.
    const scenario: FakeScenario = { hosts: makeHosts(12), slowUnlock: { failAfterMs: 20, completesAfterMs: 80 } };
    const { user, backend } = await start(scenario);
    await unlock(user);
    expect(await screen.findByRole("alert")).toHaveTextContent(/didn't answer in time/i);
    expect(lockScreen()).not.toBeNull();
    await new Promise((r) => setTimeout(r, 150));
    await waitFor(async () => expect((await backend.vaultStatus()).status).toBe("locked"));
    expect(lockScreen()).not.toBeNull();
    delete scenario.slowUnlock;
    await unlock(user);
    await screen.findByRole("main", { name: /workspace/i });
    expect((await backend.vaultStatus()).status).toBe("unlocked");
  });

  it("explains a vault CLI that isn't logged in, with the command to run", async () => {
    const { user } = await start(fixtures["not-logged-in"]);
    expect((await screen.findAllByText("bw login", { selector: "code" })).length).toBeGreaterThan(0);
    expect(screen.getByRole("dialog", { name: /isn't signed in on this box/i })).toHaveTextContent(/isn't logged in/i);
    expect(screen.queryByLabelText(/master password/i)).toBeNull();
    await user.click(screen.getByRole("button", { name: /check again/i }));
    expect((await screen.findAllByText("bw login", { selector: "code" })).length).toBeGreaterThan(0);
  });

  it("explains a missing vault CLI", async () => {
    await start(fixtures["missing-cli"]);
    expect(await screen.findByText(/not installed/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/master password/i)).toBeNull();
  });

  it("skips the lock screen when no Login uses a vault with a master password", async () => {
    const { user } = await start(fixtures["no-vault"]);
    await screen.findByRole("main", { name: /workspace/i });
    expect(lockScreen()).toBeNull();
    await user.keyboard("{Control>} {/Control}L");
    expect(lockScreen()).toBeNull();
    expect(screen.getByText(/nothing to lock/i)).toBeInTheDocument();
  });

  it("locks a vault that serve left unlocked, so the app always opens locked", async () => {
    const { backend } = await start({ ...fixtures["few-hosts"]!, vault: { status: "unlocked" } });
    expect(await screen.findByLabelText(/master password/i)).toBeInTheDocument();
    expect((await backend.vaultStatus()).status).toBe("locked");
  });

  it("locks on <leader> L, and the master password unlocks again", async () => {
    const { user, backend } = await start();
    await unlock(user);
    await screen.findByRole("main", { name: /workspace/i });
    await user.keyboard("{Control>} {/Control}L");
    expect(await screen.findByRole("dialog", { name: /locked/i })).toBeInTheDocument();
    expect(sessions()).toBeNull();
    expect((await backend.vaultStatus()).status).toBe("locked");
    await unlock(user);
    await screen.findByRole("main", { name: /workspace/i });
  });

  it("locks after 15 minutes without input, counting from the last input", async () => {
    const { user, clock, backend } = await start();
    await unlock(user);
    await screen.findByRole("main", { name: /workspace/i });
    act(() => clock.advance(10 * MIN));
    await user.pointer({ target: document.body, keys: "[MouseLeft]" });
    act(() => clock.advance(14 * MIN));
    expect(lockScreen()).toBeNull();
    await user.keyboard("x");
    act(() => clock.advance(14 * MIN));
    expect(lockScreen()).toBeNull();
    act(() => clock.advance(1 * MIN));
    expect(await screen.findByRole("dialog", { name: /locked/i })).toBeInTheDocument();
    expect((await backend.vaultStatus()).status).toBe("locked");
  });

  it("takes the idle timeout from the options", async () => {
    const backend = fakeBackend({ hosts: makeHosts(12) });
    const clock = manualClock();
    const user = userEvent.setup();
    render(<App backend={backend} clock={clock} options={{ ...defaultOptions, idleLockMinutes: 2 }} />);
    await unlock(user);
    await screen.findByRole("main", { name: /workspace/i });
    act(() => clock.advance(2 * MIN));
    expect(await screen.findByRole("dialog", { name: /locked/i })).toBeInTheDocument();
  });
});
