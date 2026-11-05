// Signing the vault CLI out to use a different account (ticket 42): the lock screen's "Use a
// different account" and `:vault signout` both ask first, naming the account, then roster's
// `vault.logout` signs the CLI out and the lock screen shows the full sign-in form (Q52). Hidden or
// explained for providers without an account. Through the typed client and the fake Backend.
import { describe, expect, it } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { FAKE_EMAIL, FAKE_PASSWORD, fakeBackend, fixtures, type FakeScenario } from "./backend/fake";
import { BackendCallError, VaultError } from "./backend/types";
import { onMessageLine } from "./test-messageLine";
import { manualClock } from "./lock/manualClock";

async function start(scenario: FakeScenario = fixtures["sign-out"]!) {
  const backend = fakeBackend(scenario);
  const user = userEvent.setup();
  const clock = manualClock();
  render(<App backend={backend} clock={clock} />);
  await screen.findByRole("dialog", { name: /locked/i });
  await screen.findByLabelText(/^\S+ master password$/i);
  return { user, backend, clock };
}

const lockScreen = () => screen.getByRole("dialog", { name: /locked|sign in/i });
const QUESTION = new RegExp(`sign out of ${FAKE_EMAIL} on this box\\?`, "i");
const differentAccount = () => within(lockScreen()).queryByRole("button", { name: /use a different account/i });

describe("signing out from the lock screen", () => {
  it("names the account it would sign out of, with its server", async () => {
    await start();
    expect(differentAccount()).toBeInTheDocument();
    expect(lockScreen()).toHaveTextContent(`Signed in as ${FAKE_EMAIL} on bitwarden.com`);
  });

  it("asks first; Esc keeps the account and goes back to the unlock form", async () => {
    const { user, backend } = await start();
    await user.click(differentAccount()!);
    expect(within(lockScreen()).getByText(QUESTION)).toBeInTheDocument();
    expect(lockScreen()).toHaveTextContent("The CLI's local copy of the vault is removed; signing in again syncs it.");
    expect(within(lockScreen()).getByRole("button", { name: /^sign out$/i })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(within(lockScreen()).queryByText(QUESTION)).toBeNull();
    expect(screen.getByLabelText(/master password/i)).toBeInTheDocument();
    expect((await backend.vaultStatus()).status).toBe("locked");
  });

  it("Enter signs out and shows the full sign-in form, and an account signs in", async () => {
    const { user, backend } = await start();
    await user.click(differentAccount()!);
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: /sign in to bitwarden/i });
    expect((await backend.vaultStatus()).status).toBe("not-logged-in");
    expect(within(dialog).getByRole("radio", { name: /bitwarden cloud/i })).toHaveFocus();
    expect(within(dialog).getByRole("status")).toHaveTextContent(`Signed out of ${FAKE_EMAIL}.`);
    await user.keyboard("{Enter}");
    await user.type(within(dialog).getByLabelText(/email/i), `${FAKE_EMAIL}{Enter}`);
    await user.type(within(dialog).getByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    await screen.findByRole("main", { name: /workspace/i });
  });

  it("goes to the sign-in form when the CLI was already signed out elsewhere", async () => {
    const { user, backend } = await start();
    await backend.signOut(); // `bw logout` in a terminal meanwhile
    await user.click(differentAccount()!);
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog", { name: /sign in to bitwarden/i });
  });

  it("is still offered after a lock: by hand and when idle", async () => {
    const { user, clock } = await start();
    await user.type(screen.getByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    await screen.findByRole("main", { name: /workspace/i });
    await user.keyboard("{Control>} {/Control}:lock{Enter}");
    await screen.findByLabelText(/^\S+ master password$/i);
    expect(differentAccount()).toBeInTheDocument();
    expect(lockScreen()).toHaveTextContent(`Signed in as ${FAKE_EMAIL} on bitwarden.com`);
    await user.type(screen.getByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    await screen.findByRole("main", { name: /workspace/i });
    act(() => clock.advance(60 * 60_000));
    await screen.findByLabelText(/^\S+ master password$/i);
    expect(differentAccount()).toBeInTheDocument();
  });

  it("is offered after a lock that follows a sign-in from the lock screen", async () => {
    const { user } = await start();
    await user.click(differentAccount()!);
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: /sign in to bitwarden/i });
    await user.keyboard("{Enter}");
    await user.type(within(dialog).getByLabelText(/email/i), `${FAKE_EMAIL}{Enter}`);
    await user.type(within(dialog).getByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    await screen.findByRole("main", { name: /workspace/i });
    await user.keyboard("{Control>} {/Control}:lock{Enter}");
    await screen.findByLabelText(/^\S+ master password$/i);
    expect(await within(lockScreen()).findByRole("button", { name: /use a different account/i })).toBeInTheDocument();
  });

  it("isn't offered for KeePassXC, which has no account", async () => {
    await start({ ...fixtures["sign-out"]!, vault: { status: "locked", provider: "kp" } });
    expect(differentAccount()).toBeNull();
  });

  it("isn't offered by a roster older than API 14", async () => {
    await start({ ...fixtures["sign-out"]!, apiVersion: 13 });
    expect(differentAccount()).toBeNull();
  });
});

describe(":vault signout", () => {
  async function unlocked(scenario?: FakeScenario) {
    const s = await start(scenario);
    await s.user.type(screen.getByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    await screen.findByRole("main", { name: /workspace/i });
    return s;
  }
  async function command(user: ReturnType<typeof userEvent.setup>, line: string) {
    await user.keyboard("{Control>} {/Control}:");
    await user.keyboard(`${line}{Enter}`);
  }

  it("asks, naming the account, then locks onto the full sign-in form", async () => {
    const { user, backend } = await unlocked();
    await command(user, "vault signout");
    const ask = await screen.findByRole("alertdialog", { name: QUESTION });
    expect(ask).toHaveTextContent("The CLI's local copy of the vault is removed; signing in again syncs it.");
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog", { name: /sign in to bitwarden/i });
    expect((await backend.vaultStatus()).status).toBe("not-logged-in");
  });

  it("a failed sign-out locks with the reason, and the account can be tried again", async () => {
    const { user, backend } = await unlocked();
    backend.signOut = () => Promise.reject(new BackendCallError("`bw logout` failed: the server said no", VaultError.signOutFailed));
    await command(user, "vault signout");
    await screen.findByRole("alertdialog", { name: QUESTION });
    await user.keyboard("{Enter}");
    await within(lockScreen()).findByText(/the server said no/);
    expect(lockScreen()).toHaveTextContent("Signing out failed: bw logout failed: the server said no");
    expect(differentAccount()).toBeInTheDocument();
  });

  it("Esc keeps the account and the app unlocked", async () => {
    const { user, backend } = await unlocked();
    await command(user, "vault signout");
    await screen.findByRole("alertdialog", { name: QUESTION });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("main", { name: /workspace/i })).toBeInTheDocument();
    expect((await backend.vaultStatus()).status).toBe("unlocked");
  });

  it("says why for KeePassXC: change vault.kp.database in init.lua", async () => {
    const { user } = await unlocked({ ...fixtures["sign-out"]!, vault: { status: "locked", provider: "kp" } });
    await command(user, "vault signout");
    expect(await screen.findByText(/KeePassXC has no account to sign out of.*vault\.kp\.database in init\.lua/)).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("needs API 14", async () => {
    const { user } = await unlocked({ ...fixtures["sign-out"]!, apiVersion: 13 });
    await command(user, "vault signout");
    expect(await screen.findByText(onMessageLine(/:vault signout needs a newer roster\. Update roster on this Box\./))).toBeInTheDocument();
  });

  it("says what its subcommand is", async () => {
    const { user } = await unlocked();
    await command(user, "vault dance");
    expect(await screen.findByText("vault takes signout")).toBeInTheDocument();
  });
});
