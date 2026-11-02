// The Lock's state (GLOSSARY: Lock). The app is locked until `vault.unlock` succeeds, and locks
// again on demand or after `idleMs` without input. Unlocking the vault is what unlocks the app:
// there is no app password. A vault with no master password (`unsupported`) means no lock screen.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BackendCallError,
  VaultError,
  type Backend,
  type SignInAnswer,
  type SignInInfo,
  type SignInStart,
  type SignInStep,
  type VaultAccount,
  type VaultStatus,
} from "../backend/types";
import { idleTimer, realClock, type Clock } from "./idle";

export type VaultView =
  /** Asking `vault.status` (the lock screen is up meanwhile). */
  | { state: "checking" }
  /** `account`: who the CLI is signed in as, when roster can sign it out (API 14, ticket 42). */
  | { state: "locked"; provider: string; error: string | null; account?: VaultAccount | undefined }
  /** The lock screen's "Sign out of …?" (ticket 42): the unlock form, asking first. */
  | { state: "signout"; provider: string; account: VaultAccount; error: string | null }
  /** The vault CLI isn't logged in on this box, and roster can sign it in (`vault.login`).
   * `signedOut`: the account the app just signed out of (ticket 42), said once above the form. */
  | { state: "signin"; provider: string; info: SignInInfo; signedOut?: VaultAccount | null | undefined }
  /** The vault CLI can't unlock on this box yet; `message` says what to run or install, and
   * `status` why (`not-logged-in`, `missing-cli`, or what roster said). */
  | { state: "unavailable"; provider: string; message: string; status: string }
  /** `vault.status` itself failed. */
  | { state: "failed"; message: string }
  /** `account`: kept from the last status, so a lock (by hand or idle) still offers "Use a
   * different account". */
  | { state: "unlocked"; provider: string; account?: VaultAccount | undefined }
  /** No Host Login uses a vault with a master password: nothing to lock. */
  | { state: "none" };

export interface Vault {
  view: VaultView;
  /** True while the lock screen is up and the Sessions are hidden. */
  locked: boolean;
  /** Ask the vault where it stands again (the lock screen's "Check again"). */
  check(): Promise<void>;
  unlock(password: string): Promise<void>;
  /** Lock now. False if there's nothing to lock. */
  lock(): boolean;
  /** `vault.login` (ticket 31). A `done` step unlocks the app. */
  signInStart(start: SignInStart): Promise<SignInStep>;
  signInAnswer(login: string, answer: SignInAnswer): Promise<SignInStep>;
  signInCancel(): Promise<void>;
  /** The lock screen's "Use a different account": ask first (ticket 42). */
  askSignOut(): void;
  /** Back from the question to the unlock form. */
  keepAccount(): void;
  /** `vault.logout`: roster forgets every secret and signs the CLI out; the app locks and shows
   * the full sign-in form. Already signed out elsewhere (15) ends there too. Never rejects: a
   * failure is said on the lock screen, which still offers `account` (the one the question
   * named, else the last known) to try again. */
  signOut(account?: VaultAccount): Promise<void>;
}

const INPUT_EVENTS = ["keydown", "pointerdown", "pointermove", "wheel"] as const;

function viewOf(
  s: Pick<VaultStatus, "provider" | "status" | "message" | "sign_in" | "account" | "can_sign_out">,
): VaultView {
  if (s.provider === null || s.status === "unsupported") return { state: "none" };
  if (s.status === "unlocked") return { state: "unlocked", provider: s.provider, account: signOutAccount(s) };
  if (s.status === "locked") return { state: "locked", provider: s.provider, error: null, account: signOutAccount(s) };
  if (s.status === "not-logged-in" && s.sign_in) return { state: "signin", provider: s.provider, info: s.sign_in };
  return { state: "unavailable", provider: s.provider, message: s.message ?? `${s.provider}: ${s.status}`, status: s.status };
}

/** The account "Use a different account" names, when roster can sign this provider out. */
function signOutAccount(s: { account?: VaultAccount | undefined; can_sign_out?: boolean | undefined }) {
  return s.can_sign_out && s.account ? s.account : undefined;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function useVault(
  backend: Backend,
  active: boolean,
  { idleMs, clock = realClock }: { idleMs: number; clock?: Clock | undefined },
): Vault {
  const [view, setView] = useState<VaultView>({ state: "checking" });
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const check = useCallback(async () => {
    setView({ state: "checking" });
    try {
      let s = await backend.vaultStatus();
      // The app always opens locked, even on a serve that's still unlocked (a reloaded window).
      if (s.status === "unlocked") {
        await backend.lockVault();
        s = { ...s, status: "locked" };
      }
      setView(viewOf(s));
    } catch (e) {
      setView({ state: "failed", message: messageOf(e) });
    }
  }, [backend]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- asking the vault is the effect
    if (active) void check();
  }, [active, check]);

  /** Counts unlock attempts, so a late clean-up never locks over a newer attempt. */
  const attempts = useRef(0);

  /** After an unlock failed without a clear answer (a timeout, a lost serve), serve may still
   * have unlocked, or may do so later. `vault.status` waits for the vault's lock, which the
   * unlock holds alone (serve API 20; before, serve answered in order), so it comes back after
   * that unlock is done; if it says unlocked while the app is locked, lock it. */
  const lockIfServeUnlocked = useCallback(
    async (attempt: number) => {
      const stale = () => attempts.current !== attempt || viewRef.current.state === "unlocked";
      try {
        const s = await backend.vaultStatus();
        if (s.status !== "unlocked" || stale()) return;
      } catch {
        if (stale()) return; // status unknown: lock anyway, it's harmless on a locked vault
      }
      await backend.lockVault().catch(() => {});
    },
    [backend],
  );

  const unlock = useCallback(
    async (password: string) => {
      const v = viewRef.current;
      if (v.state !== "locked") return;
      const attempt = ++attempts.current;
      try {
        const r = await backend.unlockVault(password);
        setView({ state: "unlocked", provider: r.provider, account: v.account });
      } catch (e) {
        const code = e instanceof BackendCallError ? e.code : null;
        if (code === VaultError.wrongPassword) {
          setView({ ...v, error: "Wrong master password. Try again." });
        } else if (code === VaultError.notLoggedIn || code === VaultError.cliMissing) {
          const status = code === VaultError.notLoggedIn ? "not-logged-in" : "missing-cli";
          setView({ state: "unavailable", provider: v.provider, message: messageOf(e), status });
        } else if (code === VaultError.unsupported) {
          setView({ state: "none" });
        } else {
          setView({ ...v, error: messageOf(e) });
          void lockIfServeUnlocked(attempt);
        }
      }
    },
    [backend, lockIfServeUnlocked],
  );

  const lock = useCallback((): boolean => {
    const v = viewRef.current;
    if (v.state === "none") return false;
    // Hide first, then forget: the Sessions are covered before the call goes out.
    if (v.state === "unlocked") setView({ state: "locked", provider: v.provider, error: null, account: v.account });
    backend.lockVault().catch((e: unknown) => {
      setView((cur) => (cur.state === "locked" ? { ...cur, error: `Locking the vault failed: ${messageOf(e)}` } : cur));
    });
    return true;
  }, [backend]);

  const signedIn = useCallback(
    (step: SignInStep) => {
      if (step.step !== "done") return step;
      setView({ state: "unlocked", provider: step.provider });
      // A sign-in doesn't say who it signed in as: ask, so a later lock offers "Use a different
      // account" too. Best effort; nothing waits on it.
      backend.vaultStatus().then(
        (s) => setView((cur) => (cur.state === "unlocked" && cur.provider === s.provider ? { ...cur, account: signOutAccount(s) } : cur)),
        () => {},
      );
      return step;
    },
    [backend],
  );
  const signInStart = useCallback(
    async (start: SignInStart) => signedIn(await backend.signIn(start)),
    [backend, signedIn],
  );
  const signInAnswer = useCallback(
    async (login: string, answer: SignInAnswer) => signedIn(await backend.signInAnswer(login, answer)),
    [backend, signedIn],
  );
  const signInCancel = useCallback(() => backend.signInCancel(), [backend]);

  const askSignOut = useCallback(() => {
    const v = viewRef.current;
    if (v.state === "locked" && v.account) setView({ state: "signout", provider: v.provider, account: v.account, error: null });
  }, []);
  const keepAccount = useCallback(() => {
    const v = viewRef.current;
    if (v.state === "signout") setView({ state: "locked", provider: v.provider, error: null, account: v.account });
  }, []);

  const signOut = useCallback(async (asked?: VaultAccount) => {
    const v = viewRef.current;
    // Cover first (an unlocked app locks before the call goes out), then sign out.
    if (v.state === "unlocked") setView({ state: "checking" });
    try {
      const r = await backend.signOut();
      const after = viewOf(r);
      setView(after.state === "signin" ? { ...after, signedOut: r.signed_out } : after);
    } catch (e) {
      const code = e instanceof BackendCallError ? e.code : null;
      if (code === VaultError.alreadySignedOut) {
        await check();
        return;
      }
      const message = `Signing out failed: ${messageOf(e)}`;
      setView((cur) =>
        cur.state === "signout"
          ? { ...cur, error: message }
          : v.state === "unlocked" || v.state === "locked"
            ? { state: "locked", provider: v.provider, error: message, account: asked ?? v.account }
            : { state: "failed", message },
      );
    }
  }, [backend, check]);

  // The idle lock: any input anywhere in the window counts, captured before anything can stop it.
  const unlocked = view.state === "unlocked";
  useEffect(() => {
    if (!unlocked) return;
    const timer = idleTimer({ timeoutMs: idleMs, clock, onIdle: () => lock() });
    const onInput = () => timer.activity();
    timer.start();
    for (const ev of INPUT_EVENTS) window.addEventListener(ev, onInput, { capture: true, passive: true });
    return () => {
      timer.stop();
      for (const ev of INPUT_EVENTS) window.removeEventListener(ev, onInput, { capture: true });
    };
  }, [unlocked, idleMs, clock, lock]);

  const locked = view.state !== "unlocked" && view.state !== "none";
  return { view, locked, check, unlock, lock, signInStart, signInAnswer, signInCancel, askSignOut, keepAccount, signOut };
}
