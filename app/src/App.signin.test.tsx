// Signing in from the lock screen (ticket 31): a new Box's vault CLI isn't logged in, and the lock
// screen walks `vault.login` instead of saying "run `bw login`". Keyboard-first: Tab and Enter, Esc
// goes back a step. Every secret field is empty once its step returns. Through the fake Backend.
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { BackendCallError } from "./backend/types";
import { FAKE_API_KEY, FAKE_CODE, FAKE_EMAIL, FAKE_PASSWORD, fakeBackend, fixtures, type FakeScenario } from "./backend/fake";
import { manualClock } from "./lock/manualClock";

async function start(scenario: FakeScenario = fixtures["sign-in"] as FakeScenario) {
  const backend = fakeBackend(scenario);
  const user = userEvent.setup();
  render(<App backend={backend} clock={manualClock()} />);
  await screen.findByRole("dialog", { name: /sign in/i });
  return { user, backend };
}

const dialog = () => screen.getByRole("dialog", { name: /sign in/i });
const field = (label: RegExp) => within(dialog()).getByLabelText<HTMLInputElement>(label);
const workspace = () => screen.findByRole("main", { name: /workspace/i });
const alert = () => within(dialog()).findByRole("alert");

/** Server (as preset) -> email -> master password. */
async function throughPassword(user: ReturnType<typeof userEvent.setup>, password = FAKE_PASSWORD) {
  await user.keyboard("{Enter}");
  await user.type(field(/email/i), `${FAKE_EMAIL}{Enter}`);
  await user.type(field(/master password/i), `${password}{Enter}`);
}

describe("signing in from the lock screen", () => {
  it("walks server, email, master password and the new-device code, then unlocks", async () => {
    const { user, backend } = await start();
    expect(within(dialog()).getByRole("radio", { name: /bitwarden cloud/i })).toBeChecked();
    expect(within(dialog()).getByRole("radio", { name: /bitwarden cloud/i })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(field(/email/i)).toHaveFocus();
    await user.type(field(/email/i), `${FAKE_EMAIL}{Enter}`);
    const pw = field(/master password/i);
    expect(pw).toHaveFocus();
    await user.type(pw, `${FAKE_PASSWORD}{Enter}`);
    const code = await within(dialog()).findByLabelText<HTMLInputElement>(/code/i);
    expect(within(dialog()).getByText(new RegExp(`emailed a code to ${FAKE_EMAIL}`, "i"))).toBeInTheDocument();
    expect(pw.value).toBe("");
    expect(code).toHaveFocus();
    await user.type(code, `${FAKE_CODE}{Enter}`);
    await workspace();
    expect(code.value).toBe("");
    expect((await backend.vaultStatus()).status).toBe("unlocked");
  });

  it("has the focus on a screen's first field in the same commit that shows it (no moment without it)", async () => {
    // A screen that comes from an answer (vault.status, a sign-in step) isn't a discrete event, so a
    // passive effect would focus it a task later: a key pressed in between went to <body>. Watch the
    // DOM: a MutationObserver runs right after React's commit, before any later task.
    const seen: { what: string; focused: boolean }[] = [];
    const watch = new MutationObserver(() => {
      const radio = document.querySelector<HTMLInputElement>('input[name="server"][data-autofocus]');
      const code = document.querySelector<HTMLInputElement>("input#signin-code");
      for (const [what, el] of [["server", radio], ["code", code]] as const) {
        if (el && !seen.some((s) => s.what === what)) seen.push({ what, focused: document.activeElement === el });
      }
    });
    watch.observe(document.body, { childList: true, subtree: true });
    try {
      const { user } = await start();
      await throughPassword(user);
      await within(dialog()).findByLabelText(/new-device code/i);
    } finally {
      watch.disconnect();
    }
    expect(seen).toEqual([
      { what: "server", focused: true },
      { what: "code", focused: true },
    ]);
  });

  it("offers the account's two-step methods, keeps the step after a wrong code, and clears the field", async () => {
    const { user } = await start(fixtures["sign-in-2fa"]);
    await throughPassword(user);
    const methods = await within(dialog()).findByRole("group", { name: /two-step method/i });
    const buttons = within(methods).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["1 Authenticator App", "2 Yubico OTP Security Key", "3 Email"]);
    expect(buttons[0]).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(buttons[2]).toHaveFocus();
    await user.keyboard("{Enter}");
    const code = await within(dialog()).findByLabelText<HTMLInputElement>(/email code/i);
    expect(within(dialog()).getByText(new RegExp(`emailed a code to ${FAKE_EMAIL}`, "i"))).toBeInTheDocument();
    await user.type(code, "000000{Enter}");
    const problem = await alert();
    expect(problem).toHaveTextContent(/didn't accept that code \(wrong or expired\) - a new code is on its way/i);
    expect(problem).toHaveTextContent(/type the current code/i); // the catalog's fix (row 24)
    expect(field(/email code/i).value).toBe("");
    expect(field(/email code/i)).toHaveFocus();
    await user.type(field(/email code/i), `${FAKE_CODE}{Enter}`);
    await workspace();
  });

  it("picks a method with its number key", async () => {
    const { user } = await start(fixtures["sign-in-2fa"]);
    await throughPassword(user);
    await within(dialog()).findByRole("group", { name: /two-step method/i });
    await user.keyboard("1");
    expect(await within(dialog()).findByLabelText(/authenticator app code/i)).toHaveFocus();
    expect(within(dialog()).getByText(/6-digit code from your authenticator app/i)).toBeInTheDocument();
  });

  it("asks for a code without a picker when the account has one method", async () => {
    const { user } = await start(fixtures["sign-in-totp"]);
    await throughPassword(user);
    await user.type(await within(dialog()).findByLabelText(/two-step code/i), `${FAKE_CODE}{Enter}`);
    await workspace();
  });

  it("goes back a step with Esc, and cancels a sign-in that has started", async () => {
    const { user, backend } = await start(fixtures["sign-in-2fa"]);
    const cancel = vi.spyOn(backend, "signInCancel");
    await user.keyboard("{Enter}");
    await user.type(field(/email/i), FAKE_EMAIL);
    await user.keyboard("{Escape}");
    expect(within(dialog()).getByRole("radio", { name: /bitwarden cloud/i })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(field(/email/i).value).toBe(FAKE_EMAIL); // not a secret: kept
    await user.keyboard("{Enter}");
    await user.type(field(/master password/i), "half-typed");
    await user.keyboard("{Escape}");
    expect(field(/email/i)).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(field(/master password/i).value).toBe("");
    await user.type(field(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    await within(dialog()).findByRole("group", { name: /two-step method/i });
    await user.keyboard("{Escape}");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(field(/master password/i)).toHaveFocus();
    expect(field(/master password/i).value).toBe("");
    await user.type(field(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    await user.keyboard("1");
    await user.type(await within(dialog()).findByLabelText(/authenticator app code/i), `${FAKE_CODE}{Enter}`);
    await workspace();
  });

  it("cancels a started sign-in that fails without a step to carry on from, so roster's bw login ends (review 2)", async () => {
    const { user, backend } = await start(fixtures["sign-in-totp"]);
    const cancel = vi.spyOn(backend, "signInCancel");
    await throughPassword(user);
    const code = await within(dialog()).findByLabelText<HTMLInputElement>(/two-step code/i);
    // A wrong code keeps the step: the sign-in goes on.
    await user.type(code, "000000{Enter}");
    await alert();
    expect(cancel).not.toHaveBeenCalled();
    // The call times out (roster may still be in it): nothing to carry on from.
    const answer = backend.signInAnswer.bind(backend);
    backend.signInAnswer = () => Promise.reject(new BackendCallError("The backend didn't answer in time.", null, null, true));
    await user.type(field(/two-step code/i), `${FAKE_CODE}{Enter}`);
    expect(await within(dialog()).findByLabelText(/master password/i)).toBeInTheDocument();
    expect(cancel).toHaveBeenCalledTimes(1);
    backend.signInAnswer = answer;
  });

  it("cancels a started sign-in when the lock screen goes away mid-way (review 2)", async () => {
    const backend = fakeBackend(fixtures["sign-in-totp"] as FakeScenario);
    const cancel = vi.spyOn(backend, "signInCancel");
    const user = userEvent.setup();
    const { unmount } = render(<App backend={backend} clock={manualClock()} />);
    await screen.findByRole("dialog", { name: /sign in/i });
    await throughPassword(user);
    await within(dialog()).findByLabelText(/two-step code/i);
    expect(cancel).not.toHaveBeenCalled();
    unmount();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("doesn't cancel a sign-in that's done (review 2)", async () => {
    const backend = fakeBackend(fixtures["sign-in-totp"] as FakeScenario);
    const cancel = vi.spyOn(backend, "signInCancel");
    const user = userEvent.setup();
    render(<App backend={backend} clock={manualClock()} />);
    await screen.findByRole("dialog", { name: /sign in/i });
    await throughPassword(user);
    await user.type(await within(dialog()).findByLabelText(/two-step code/i), `${FAKE_CODE}{Enter}`);
    await workspace();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("says when the email or master password is wrong, and stays on the password", async () => {
    const { user } = await start();
    await throughPassword(user, "not-it");
    expect(await alert()).toHaveTextContent(/didn't accept that email and master password/i);
    expect(await alert()).toHaveTextContent(/check the email, the master password and the server/i);
    expect(field(/master password/i).value).toBe("");
    expect(field(/master password/i)).toHaveFocus();
  });

  it("explains a two-step method the CLI can't do (FIDO2, Duo), with the way out", async () => {
    const { user } = await start(fixtures["sign-in-fido2"]);
    await throughPassword(user);
    const problem = await alert();
    expect(problem).toHaveTextContent(/FIDO2 security keys and Duo aren't supported by the CLI/i);
    expect(problem).toHaveTextContent(/sign in with an API key instead/i);
    // No Where on the lock screen: the problem is the form you're looking at (ticket 29 S10).
    expect(within(problem).queryByText(/^where$/i)).toBeNull();
  });

  it("shows a refusal from the server with the catalog's fix", async () => {
    const { user } = await start(fixtures["sign-in-rate-limited"]);
    await throughPassword(user);
    expect(await alert()).toHaveTextContent(/too many sign-in attempts/i);
    // roster's message already says to wait, so the Fix isn't repeated (ticket 29 S10).
    expect(await alert()).toHaveTextContent(/wait a few minutes/i);
    expect(within(await alert()).queryByText("Fix")).toBeNull();
  });

  it("refuses a self-hosted address that isn't one, back on the server choice", async () => {
    const { user } = await start();
    await user.click(within(dialog()).getByRole("radio", { name: /self-hosted/i }));
    await user.type(field(/server address/i), "vault example com{Enter}");
    await user.type(field(/email/i), `${FAKE_EMAIL}{Enter}`);
    await user.type(field(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    expect(await alert()).toHaveTextContent(/isn't a server address/i);
    expect(within(dialog()).getByRole("radio", { name: /self-hosted/i })).toHaveFocus();
  });

  it("starts on the server the CLI is set to", async () => {
    await start(fixtures["sign-in-eu"]);
    expect(within(dialog()).getByRole("radio", { name: /bitwarden eu/i })).toBeChecked();
  });

  it("signs in with an API key, then unlocks with the master password", async () => {
    const { user } = await start();
    await user.click(within(dialog()).getByRole("button", { name: /use an api key/i }));
    expect(field(/client_id/i)).toHaveFocus();
    await user.type(field(/client_id/i), FAKE_API_KEY.id);
    await user.type(field(/client_secret/i), `wrong{Enter}`);
    expect(await alert()).toHaveTextContent(/didn't accept that API key/i);
    expect(field(/client_secret/i).value).toBe("");
    await user.type(field(/client_id/i), FAKE_API_KEY.id);
    await user.type(field(/client_secret/i), `${FAKE_API_KEY.secret}{Enter}`);
    const pw = await within(dialog()).findByLabelText<HTMLInputElement>(/master password/i);
    expect(within(dialog()).getByText(/now unlock the vault/i)).toBeInTheDocument();
    await user.type(pw, "nope{Enter}");
    expect(await alert()).toHaveTextContent(/wrong master password/i);
    expect(field(/master password/i).value).toBe("");
    await user.type(field(/master password/i), `${FAKE_PASSWORD}{Enter}`);
    await workspace();
  });

  it("signs in with SSO: shows the link to copy, waits for the browser, then unlocks", async () => {
    const { user } = await start({ ...(fixtures["sign-in-sso"] as FakeScenario), signIn: { sso: "ok", ssoMs: 50 } });
    await user.click(within(dialog()).getByRole("button", { name: /use sso/i }));
    await user.type(field(/organization identifier/i), "yourorg{Enter}");
    expect(await within(dialog()).findByText(/finish signing in with your browser/i)).toBeInTheDocument();
    expect(within(dialog()).getByText(/^https:\/\/vault\.bitwarden\.com\/#\/sso\?/)).toBeInTheDocument();
    const pw = await within(dialog()).findByLabelText<HTMLInputElement>(/master password/i);
    await user.type(pw, `${FAKE_PASSWORD}{Enter}`);
    await workspace();
  });

  it("signs in with SSO on native Windows, where bw opens the page itself and there's no link (API 23)", async () => {
    const { user } = await start({ ...(fixtures["sign-in-sso"] as FakeScenario), signIn: { sso: "ok", ssoMs: 50, ssoLink: false } });
    await user.click(within(dialog()).getByRole("button", { name: /use sso/i }));
    await user.type(field(/organization identifier/i), "yourorg{Enter}");
    expect(await within(dialog()).findByText(/bitwarden opened the sign-in page in your browser/i)).toBeInTheDocument();
    expect(within(dialog()).queryByText(/null/)).not.toBeInTheDocument();
    expect(within(dialog()).queryByRole("button", { name: /copy link/i })).not.toBeInTheDocument();
    const pw = await within(dialog()).findByLabelText<HTMLInputElement>(/master password/i);
    await user.type(pw, `${FAKE_PASSWORD}{Enter}`);
    await workspace();
  });

  it("keeps exactly one SSO poll in flight while the App re-renders (review 2)", async () => {
    const backend = fakeBackend({ ...(fixtures["sign-in-sso"] as FakeScenario), signIn: { sso: "ok", ssoMs: 200 } });
    const answer = backend.signInAnswer.bind(backend);
    let inFlight = 0;
    let most = 0;
    let calls = 0;
    backend.signInAnswer = async (id, a) => {
      calls++;
      most = Math.max(most, ++inFlight);
      try {
        return await answer(id, a);
      } finally {
        inFlight--;
      }
    };
    const clock = manualClock();
    const user = userEvent.setup();
    const { rerender } = render(<App backend={backend} clock={clock} />);
    await screen.findByRole("dialog", { name: /sign in/i });
    await user.click(within(dialog()).getByRole("button", { name: /use sso/i }));
    await user.keyboard("{Enter}");
    await within(dialog()).findByText(/finish signing in with your browser/i);
    // The parent re-renders (any App state change does this) while the poll waits.
    for (let i = 0; i < 5; i++) rerender(<App backend={backend} clock={clock} />);
    const pw = await within(dialog()).findByLabelText<HTMLInputElement>(/master password/i);
    expect(most).toBe(1);
    expect(calls).toBe(1);
    expect(within(dialog()).queryByRole("alert")).toBeNull();
    await user.type(pw, `${FAKE_PASSWORD}{Enter}`);
    await workspace();
  });

  it("reports SSO that fails in the browser and goes back to the SSO screen", async () => {
    const { user } = await start({ ...(fixtures["sign-in-sso"] as FakeScenario), signIn: { sso: "fail", ssoMs: 20 } });
    await user.click(within(dialog()).getByRole("button", { name: /use sso/i }));
    await user.keyboard("{Enter}");
    expect(await alert()).toHaveTextContent(/failed in the browser/i);
    expect(field(/organization identifier/i)).toBeInTheDocument();
  });

  it("keeps the old message when roster can't sign in (no sign_in in vault.status)", async () => {
    const backend = fakeBackend(fixtures["not-logged-in"] as FakeScenario);
    render(<App backend={backend} clock={manualClock()} />);
    expect(await screen.findByText(/run/i)).toHaveTextContent(/bw login/);
    expect(screen.queryByRole("dialog", { name: /sign in/i })).toBeNull();
  });

  it("leaves the everyday unlock as one field", async () => {
    const backend = fakeBackend(fixtures["locked"] as FakeScenario);
    render(<App backend={backend} clock={manualClock()} />);
    const lock = await screen.findByRole("dialog", { name: /locked/i });
    await within(lock).findByLabelText(/master password/i);
    expect(lock.querySelectorAll("input")).toHaveLength(1);
  });

  it("gets to the unlock screen when the CLI turns out to be logged in already", async () => {
    const { user, backend } = await start({ ...(fixtures["sign-in"] as FakeScenario), signIn: {} });
    await backend.signIn({ method: "password", server: "cloud", email: FAKE_EMAIL, password: FAKE_PASSWORD });
    await backend.lockVault();
    await throughPassword(user);
    await waitFor(() => expect(screen.getByRole("dialog", { name: /locked/i })).toBeInTheDocument());
  });
});
