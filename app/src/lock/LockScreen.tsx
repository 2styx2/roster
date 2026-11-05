// The lock screen, and the gate that hides everything behind it. Sessions keep running under the
// gate (it never unmounts its children); while locked they're invisible, inert and out of the
// accessibility tree, and the lock screen covers the window.
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { VaultAccount } from "../backend/types";
import { Logo } from "../chrome/Logo";
import type { ErrorRow } from "../errors/catalog";
import { CopyCommand } from "../errors/ErrorPanel";
import { SignIn } from "./SignIn";
import { WRONG_PASSWORD, type Vault, type VaultView } from "./useVault";
import { withCode } from "./withCode";
import { Keys } from "../ui/Keys";

const PROVIDER_NAMES: Record<string, string> = {
  bw: "Bitwarden",
  kp: "KeePassXC",
};
const providerName = (p: string) => PROVIDER_NAMES[p] ?? p;
/** What `not-logged-in` means for a provider that has no account to sign in to (ticket 25):
 * KeePassXC is a local .kdbx, so there it's a database this Box doesn't have. */
const NOT_SET_UP: Record<string, string> = {
  kp: "KeePassXC has no database on this Box",
};

/** What the sign-in needs from the app: the errors catalog's rows and the clipboard. */
interface LockExtras {
  errorRows?: readonly ErrorRow[] | undefined;
  copy?: ((text: string) => Promise<void>) | undefined;
}

export function LockGate({
  vault,
  hint,
  box,
  children,
  errorRows,
  copy,
}: {
  vault: Vault;
  /** This Box's name, under the mark in Iosevka (taste.md: the lock screen is the mark, the Box
   * name and one field). Not a secret: the status bar shows it too. */
  box?: string | undefined;
  /** How to lock by hand, shown under the form (e.g. the Leader and the lock key). */
  hint?: ReactNode;
  children: ReactNode;
} & LockExtras) {
  return (
    <>
      <div
        className="lock-gate"
        data-locked={vault.locked || undefined}
        inert={vault.locked}
        aria-hidden={vault.locked || undefined}
      >
        {children}
      </div>
      {vault.locked && (
        <LockScreen
          vault={vault}
          hint={hint}
          box={box}
          errorRows={errorRows}
          copy={copy}
        />
      )}
    </>
  );
}

/** Where an account lives, as a person reads it: `bitwarden.com`, `vault.example.com`. */
export const serverName = (server: string | null) =>
  (server ?? "https://bitwarden.com")
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");

/** The question both ways of signing out ask (ticket 42). */
export const signOutQuestion = (account: VaultAccount) =>
  `Sign out of ${account.email} on this Box?`;
export const SIGN_OUT_WHAT =
  "The CLI's local copy of the vault is removed; signing in again syncs it.";

/** Why a provider has no sign-out (ticket 42): KeePassXC opens a file, the rest read this Box. */
export function noAccountWords(provider: string): string {
  if (provider === "kp")
    return "KeePassXC has no account to sign out of: it opens a local database file. To use another one, change vault.kp.database in init.lua.";
  return `${providerName(provider)} has no account roster can sign out of: its Logins come from this Box itself.`;
}

/** The lock screen's heading: what's actually wrong (ticket 29 S10), not "Locked" for a vault
 * that can't be unlocked here at all. */
function heading(view: VaultView): string {
  if (view.state === "signin")
    return `Sign in to ${providerName(view.provider)}`;
  if (view.state === "unavailable" && view.status === "not-logged-in")
    return (
      NOT_SET_UP[view.provider] ??
      `${providerName(view.provider)} isn't signed in on this Box`
    );
  if (view.state === "unavailable" && view.status === "missing-cli")
    return `The ${providerName(view.provider)} CLI isn't installed`;
  return "Locked";
}

/** The command in roster's message to copy: the first one in backticks that takes arguments
 * ("run `bw login` once", "install it: `npm install -g @bitwarden/cli`"). */
const commandIn = (message: string) =>
  message.split("`").find((part, i) => i % 2 === 1 && part.includes(" ")) ??
  null;

/** What a wrong master password can't be helped by here (round 18): roster never keeps it, so
 * it can't reset it, and which vault it is comes from this Box (the account line, when there is
 * one, names it and offers another). */
function forgotWords(provider: string, account: boolean): string {
  if (provider === "bw")
    return account
      ? "Forgot it? Only Bitwarden can help: roster never keeps it."
      : "Forgot it? Only Bitwarden can help: roster never keeps it. The account is the one `bw login` signed in to on this Box.";
  if (provider === "kp")
    return "Forgot it? roster never keeps it, so it can't reset it. The database is `vault.kp.database` in init.lua.";
  return `Forgot it? roster never keeps ${providerName(provider)}'s master password, so it can't reset it.`;
}

function LockScreen({
  vault,
  hint,
  box,
  errorRows,
  copy,
}: { vault: Vault; hint?: ReactNode; box?: string | undefined } & LockExtras) {
  const signingIn = vault.view.state === "signin";
  return (
    <div
      className="lock"
      role="dialog"
      aria-modal="true"
      aria-labelledby="lock-title"
      onKeyDown={(e) => {
        // Tab stays on the lock's own controls (round 18: after Unlock it fell to <body>, an
        // invisible stop, before coming back to the field).
        if (e.key !== "Tab") return;
        const all = Array.from(
          e.currentTarget.querySelectorAll<HTMLElement>(
            "button, input, select, textarea, [href], [tabindex]:not([tabindex='-1'])",
          ),
        ).filter((el) => !el.hasAttribute("disabled") && !el.closest("[hidden]"));
        const head = all[0];
        const tail = all[all.length - 1];
        if (!head || !tail) return;
        const at = document.activeElement;
        const inside = at instanceof Node && e.currentTarget.contains(at);
        if (e.shiftKey && (at === head || !inside)) {
          e.preventDefault();
          tail.focus();
        } else if (!e.shiftKey && (at === tail || !inside)) {
          e.preventDefault();
          head.focus();
        }
      }}
    >
      <section className="lock-panel">
        <Logo size={48} className="lock-mark" />
        {/* Locked, the screen is the mark, this Box and one field (taste.md "Lock screen"): the
            heading stays the dialog's name for assistive tech but isn't drawn. Every other state
            shows its heading, since there it says what's wrong. */}
        <h1
          id="lock-title"
          className={
            vault.view.state === "locked" || vault.view.state === "checking"
              ? "visually-hidden"
              : undefined
          }
        >
          {heading(vault.view)}
        </h1>
        {box && (
          <p className="lock-box">
            <span className="box-mark" aria-hidden="true" />
            <span className="visually-hidden">This Box: </span>
            {box}
          </p>
        )}
        {vault.view.state === "signin" ? (
          vault.view.signedOut !== undefined ? (
            // Just signed out (ticket 42): the full sign-in form rises into place, confirming the switch.
            <div className="lock-switch">
              <p role="status" className="lock-notice muted">
                {vault.view.signedOut
                  ? `Signed out of ${vault.view.signedOut.email}.`
                  : "Signed out."}{" "}
                Sign in to the account you want.
              </p>
              <SignIn
                vault={vault}
                info={vault.view.info}
                errorRows={errorRows}
                copy={copy}
              />
            </div>
          ) : (
            <SignIn
              vault={vault}
              info={vault.view.info}
              errorRows={errorRows}
              copy={copy}
            />
          )
        ) : (
          <Body view={vault.view} vault={vault} copy={copy} />
        )}
        {hint && !signingIn && <p className="lock-hint muted">{hint}</p>}
      </section>
    </div>
  );
}

function Body({
  view,
  vault,
  copy,
}: {
  view: VaultView;
  vault: Vault;
  copy?: LockExtras["copy"];
}) {
  switch (view.state) {
    case "checking":
      // The form is there from the first frame, so a password typed while roster checks the
      // vault isn't lost: the same input stays when the check says it's locked.
      return (
        <>
          <UnlockForm
            provider={null}
            error={null}
            onUnlock={async () => {}}
            checking
          />
        </>
      );
    case "locked":
      return (
        <>
          <UnlockForm
            provider={view.provider}
            error={view.error}
            onUnlock={vault.unlock}
          />
          {view.account && (
            <AccountLine account={view.account} onSwitch={vault.askSignOut} />
          )}
          {/* Under the block, out of its flow, so the centred lock never moves (round 18). */}
          {view.error === WRONG_PASSWORD && (
            <p className="lock-forgot muted">
              {withCode(forgotWords(view.provider, view.account !== undefined))}
            </p>
          )}
        </>
      );
    case "signout":
      return (
        <SignOutQuestion
          account={view.account}
          error={view.error}
          vault={vault}
        />
      );
    case "unavailable":
    case "failed": {
      const command =
        view.state === "unavailable" ? commandIn(view.message) : null;
      return (
        <>
          <p role="alert" className="lock-problem">
            {withCode(view.message)}
          </p>
          {command && copy && <CopyCommand text={command} copy={copy} />}
          <button type="button" onClick={() => void vault.check()} autoFocus>
            Check again
          </button>
        </>
      );
    }
    default:
      return null;
  }
}

function UnlockForm({
  provider,
  error,
  onUnlock,
  checking = false,
}: {
  /** Null while roster is still checking which vault it is. */
  provider: string | null;
  error: string | null;
  onUnlock: (password: string) => Promise<void>;
  checking?: boolean;
}) {
  // Uncontrolled on purpose: the password lives only in the input, never in React state.
  const field = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  // A password that's wrong only because Caps Lock is on: said in the error's room.
  const [caps, setCaps] = useState(false);
  const capsFrom = (e: KeyboardEvent) =>
    setCaps(e.getModifierState("CapsLock"));

  // Enter pressed while roster still checks the vault: sent as soon as the check says locked.
  const queued = useRef(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (checking) {
      queued.current = (field.current?.value ?? "") !== "";
      return;
    }
    await send();
  }

  async function send() {
    const input = field.current;
    if (!input || busy || input.value === "") return;
    setBusy(true);
    try {
      await onUnlock(input.value);
    } finally {
      input.value = "";
      setBusy(false);
      input.focus();
    }
  }

  useEffect(() => {
    if (checking || !queued.current) return;
    queued.current = false;
    // After this commit's effects: useVault's own effect (it runs after this child's) is what
    // tells `unlock` the vault is locked now; sent before it, the password was dropped.
    queueMicrotask(() => void send());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the check ends
  }, [checking]);

  return (
    <form className="lock-form" onSubmit={(e) => void submit(e)}>
      <label htmlFor="lock-password">
        {provider
          ? `${providerName(provider)} master password`
          : "Master password"}
      </label>
      <div className="lock-row">
        <input
          id="lock-password"
          ref={field}
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          readOnly={busy}
          aria-invalid={error ? true : undefined}
          aria-describedby={
            error ? "lock-error" : caps ? "lock-caps" : undefined
          }
          onKeyDown={capsFrom}
          onKeyUp={capsFrom}
        />
        {/* aria-disabled, not disabled: a disabled default button stops Enter submitting the form,
            and Enter during the check must queue the password. */}
        {/* Inside the field, as its key (round 11: a grey button beside it read as disabled, an
            apricot one as accent at rest): ↵ while it waits for you, the word while roster works. */}
        <button
          type="submit"
          className="lock-submit"
          aria-disabled={busy || checking || undefined}
        >
          {checking ? (
            "Checking…"
          ) : busy ? (
            "Unlocking…"
          ) : (
            <>
              <span className="visually-hidden">Unlock</span>
              <Keys keys="Enter" />
            </>
          )}
        </button>
      </div>
      {error ? (
        <p id="lock-error" role="alert" className="lock-error">
          {withCode(error)}
        </p>
      ) : caps ? (
        <p id="lock-caps" className="lock-error lock-caps">
          Caps Lock is on.
        </p>
      ) : (
        // The error's room, held so the block doesn't move when one appears.
        <p className="lock-error" aria-hidden="true" />
      )}
    </form>
  );
}

/** Who the CLI is signed in as, and the way to another account (ticket 42). */
function AccountLine({
  account,
  onSwitch,
}: {
  account: VaultAccount;
  onSwitch: () => void;
}) {
  return (
    <div className="lock-account">
      <p className="muted">
        Signed in as <span className="mono">{account.email}</span> on{" "}
        <span className="mono">{serverName(account.server)}</span>
      </p>
      <button type="button" className="lock-link" onClick={onSwitch}>
        Use a different account
      </button>
    </div>
  );
}

/** "Sign out of …?" in place of the unlock form. Enter (the focused button) signs out, Esc keeps it. */
function SignOutQuestion({
  account,
  error,
  vault,
}: {
  account: VaultAccount;
  error: string | null;
  vault: Vault;
}) {
  const yes = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => yes.current?.focus(), []);
  return (
    <div
      className="lock-form lock-switch"
      role="group"
      aria-labelledby="lock-signout-q"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || busy) return;
        e.preventDefault();
        e.stopPropagation();
        vault.keepAccount();
      }}
    >
      <p id="lock-signout-q" className="lock-question">
        {signOutQuestion(account)}
      </p>
      <p className="muted">
        {SIGN_OUT_WHAT} Server:{" "}
        <span className="mono">{serverName(account.server)}</span>.
      </p>
      <div className="lock-row lock-actions">
        <button
          ref={yes}
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void vault.signOut().finally(() => setBusy(false));
          }}
        >
          {busy ? "Signing out…" : "Sign out"}
        </button>
        <button type="button" onClick={vault.keepAccount} disabled={busy}>
          Keep it
        </button>
      </div>
      <p className="signin-keys muted key-hint">
        <Keys keys="Enter" /> sign out <Keys keys="Escape" /> keep
      </p>
      {error && (
        <p role="alert" className="lock-error">
          {withCode(error)}
        </p>
      )}
    </div>
  );
}
