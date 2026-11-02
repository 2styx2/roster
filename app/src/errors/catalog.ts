// docs/app/errors.md as data: one row per way opening a Session can fail, keyed by roster's codes
// (and the app's own for a dropped Session or a lost `serve`). A row says where the problem lives,
// the fix, the actions the panel offers, and which extras it shows (near names, matching items,
// fingerprints). It's a Registry (ADR 0006), so the Config (ticket 21) and Plugins (ticket 23)
// can add rows or reword one by registering the same id.
//
// Actions either run a command line (the same command table as keys and the command line) or
// show a command to copy, when roster serve has no method for it (`roster sync`, `roster setup`).
// There is never an action that accepts a host key.
import { BackendCallError } from "../backend/types";
import { BUILTIN, Registry, type Entry } from "../registry";
import type { Problem, ProblemCode, ProblemData } from "./classify";

/** Where a problem lives (docs/app/errors.md "Where it lives"). */
export type Where =
  | "roster.yml"
  | "the vault"
  | "this Box"
  | "the network"
  | "the Host"
  | "roster"
  | "the sign-in form"
  | "the infra repo"
  | "init.lua";

export type ErrorAction =
  /** Runs a command line: `reconnect`, `check HOST`, `lock` (the lock screen), `find`. */
  | { kind: "run"; label: string; line(p: Problem): string; hostOnly?: boolean }
  /** Shows a command to run in a terminal, with a Copy button. Null: nothing to show. */
  | { kind: "copy"; label: string; text(p: Problem): string | null; hostOnly?: boolean };

/** What a row shows beyond the message: 32's near names, 33's matching items, 43's fingerprints. */
export type ErrorExtra = "near" | "matches" | "fingerprints";

export interface ErrorRow extends Entry {
  /** docs/app/errors.md's row number, if it has one. */
  row: number | null;
  codes: readonly ProblemCode[];
  where: readonly Where[];
  /** The fix when roster didn't send one. */
  fix(p: Problem): string;
  actions: readonly ErrorAction[];
  extras?: readonly ErrorExtra[];
  /** roster's message already says what to do: the lock screen leaves the Fix out. */
  fixInMessage?: boolean;
}

const retry: ErrorAction = { kind: "run", label: "Retry", line: () => "reconnect" };
const reconnect: ErrorAction = { kind: "run", label: "Reconnect", line: () => "reconnect" };
/** `hostOnly`: it names a Host in the Inventory, so a Quick Connect's Problem leaves it out. */
const check: ErrorAction = { kind: "run", label: "Run :check", line: (p) => `check ${p.host}`, hostOnly: true };
const copy = (text: (p: Problem) => string | null): ErrorAction => ({ kind: "copy", label: "Copy", text });
const sync = copy(() => "roster sync");
const setupOnly: ErrorAction = { ...copy((p) => `roster setup --only ${p.host}`), hostOnly: true };
/** The first `command` in roster's message (e.g. "run `bw login` once"). */
const quoted = (p: Problem) => /`([^`]+)`/.exec(p.message)?.[1] ?? null;

const row = (id: string, r: Omit<ErrorRow, "id" | "source">): ErrorRow => ({ id, source: BUILTIN, ...r });

export const builtinErrorRows: readonly ErrorRow[] = [
  row("inventory", {
    row: 1,
    codes: [1],
    where: ["roster.yml"],
    fix: () => "Fix roster.yml where roster's message says, then retry.",
    actions: [copy((p) => (p.data?.path ? String(p.data.path) : null)), retry],
  }),
  row("not-in-ssh-config", {
    row: 2,
    codes: [21],
    where: ["this Box"],
    fix: () => "Run `roster sync` on this Box (or `roster setup` if it isn't set up yet), then retry.",
    actions: [sync, retry],
  }),
  row("not-reviewed", {
    row: 3,
    codes: [20],
    where: ["roster.yml"],
    fix: (p) => `Review ${p.host} in roster (reviewed: true once you've checked it), then retry.`,
    actions: [retry],
  }),
  row("no-user", {
    row: 4,
    codes: [30],
    where: ["roster.yml"],
    fix: (p) => `Set user: for ${p.host} (or its group) in roster.yml.`,
    actions: [retry, check],
  }),
  row("no-provider", {
    row: 5,
    codes: [31],
    where: ["roster.yml"],
    fix: () => "See `roster providers` for the ones set up on this Box, then fix auth: in roster.yml.",
    actions: [copy(() => "roster providers"), retry],
  }),
  row("vault-cli", {
    row: 6,
    codes: [11, 12],
    where: ["this Box"],
    fix: () => "Run the command roster names once on this Box, then retry.",
    actions: [copy(quoted), retry],
  }),
  row("vault-locked", {
    row: 7,
    codes: [14],
    where: ["the vault"],
    fix: () => "Unlock the vault; the Session opens afterwards.",
    actions: [{ kind: "run", label: "Unlock", line: () => "lock" }],
  }),
  row("item-not-found", {
    row: 8,
    codes: [32],
    where: ["the vault", "roster.yml"],
    fix: (p) => `Fix the item name in ${p.host}'s auth: in roster.yml, or rename the item in the vault.`,
    actions: [retry, check],
    extras: ["near"],
  }),
  row("several-items", {
    row: 9,
    codes: [33],
    where: ["the vault"],
    fix: () => "Delete or rename the extra items in the vault, or use the item's id in auth:.",
    actions: [retry],
    extras: ["matches"],
  }),
  row("no-field", {
    row: 10,
    codes: [34],
    where: ["the vault"],
    fix: () => "Add the password (or field) to the item in the vault, or fix the #FIELD in auth:.",
    actions: [retry],
  }),
  row("lookup-failed", {
    row: null,
    codes: [35],
    where: ["the vault"],
    fix: () => "See the provider's message; `roster auth-check` tests every Login.",
    actions: [copy(() => "roster auth-check"), retry],
  }),
  row("password-refused", {
    row: 11,
    codes: [45],
    where: ["the vault", "the Host"],
    fix: () => "Check the vault item: the password may have changed on the Host, or the user is wrong.",
    actions: [retry, check],
  }),
  row("key-refused", {
    row: 12,
    codes: [46],
    where: ["this Box", "the Host"],
    fix: (p) => `Run \`roster setup --only ${p.host}\` to install this Box's key, or set enroll: false.`,
    actions: [setupOnly, check],
  }),
  row("host-key-changed", {
    row: 13,
    codes: [43],
    where: ["the Host", "the network"],
    fix: (p) =>
      `Don't accept it blindly: compare the new fingerprint with ${p.host}'s console or its owner. If the change is expected (a reinstall), delete its line in ~/.ssh/roster_known_hosts and run \`roster setup --only ${p.host}\`.`,
    actions: [check],
    extras: ["fingerprints"],
  }),
  row("host-key-unknown", {
    row: 14,
    codes: [44],
    where: ["this Box"],
    fix: (p) =>
      `Check ${p.host}'s fingerprint (its console, or its owner), then run \`roster setup --only ${p.host}\` to record it.`,
    actions: [setupOnly, check],
    extras: ["fingerprints"],
  }),
  row("host-key-changed-while-asked", {
    row: 62,
    codes: [23],
    where: ["the Host", "the network"],
    fix: () =>
      "Don't trust it blindly: compare the new fingerprint with the Host's console or its owner, then open the Session again to see it.",
    // Retry asks again, showing the new key: it never trusts one.
    actions: [retry],
  }),
  row("no-dns", {
    row: 15,
    codes: [40],
    where: ["roster.yml", "the network"],
    fix: (p) => `Fix ip: for ${p.host} in roster.yml.`,
    actions: [check, retry],
  }),
  row("refused", {
    row: 16,
    codes: [41],
    where: ["roster.yml", "the Host"],
    fix: () => "Check the port in roster.yml; is sshd running on the Host?",
    actions: [check, retry],
  }),
  row("unreachable", {
    row: 17,
    codes: [42, "closed-early"],
    where: ["the network"],
    fix: () => "Retry later: is the Host up, and the network path open?",
    actions: [retry, check],
  }),
  row("unexpected-prompt", {
    row: 18,
    codes: [36],
    where: ["the Host"],
    fix: () => "Log in by hand once to deal with it (an expired password, a one-time code), then retry.",
    actions: [copy((p) => `ssh ${p.host}`), retry],
  }),
  row("too-many-auth", {
    row: 19,
    codes: [47],
    where: ["this Box"],
    fix: () => "Run `roster sync`: roster's ssh config offers one key, or none, per Host.",
    actions: [sync, retry],
  }),
  row("dropped", {
    row: 20,
    codes: ["dropped"],
    where: ["the network", "the Host"],
    fix: () => "Reconnect.",
    actions: [reconnect],
  }),
  row("backend-lost", {
    row: 21,
    codes: ["backend-lost"],
    where: ["this Box"],
    fix: () => "Restart the roster app. Open Sessions keep running until then.",
    actions: [],
  }),
  row("token-spent", {
    row: null,
    codes: [37],
    where: ["roster"],
    fix: () => "Open the Session again: every try gets a new one-time token.",
    actions: [retry],
  }),
  row("askpass-no-serve", {
    row: null,
    codes: [38],
    where: ["this Box"],
    fix: () => "ssh's askpass helper couldn't reach roster serve. Retry; if it keeps failing, restart the roster app.",
    actions: [retry],
  }),
  row("unknown-host", {
    row: null,
    codes: [2],
    where: ["roster.yml"],
    fix: (p) => `${p.host} isn't in roster.yml (any more): it was renamed or removed. Find it again.`,
    actions: [{ kind: "run", label: "Find a Host", line: () => "find" }],
  }),
  row("login-failed", {
    row: null,
    codes: [48],
    where: ["the Host"],
    fix: () => "See the details: ssh's own message.",
    actions: [retry, check],
  }),
  // Signing the vault CLI in from the lock screen (`vault.login`, ticket 31): docs/app/errors.md rows
  // 22-33. The lock screen shows the message, where and fix; a 50 (and a 10 at the master-password
  // step) keeps the sign-in on its step.
  row("sign-in-wrong-password", {
    row: 22,
    codes: [10],
    where: ["the vault", "the sign-in form"],
    fix: () => "Check the email, the master password and the server, then try again.",
    actions: [],
  }),
  row("sign-in-no-sign-in-here", {
    row: 23,
    codes: [13],
    where: ["this Box"],
    fix: () => "Set the vault up on this Box the way roster's message says; there's nothing to sign in to here.",
    actions: [],
  }),
  row("sign-in-code-rejected", {
    row: 24,
    codes: [50],
    where: ["the sign-in form"],
    fix: () => "Type the current code: an authenticator's changes every 30 seconds, and an emailed one is the newest.",
    actions: [],
  }),
  row("sign-in-method-unsupported", {
    row: 25,
    codes: [51],
    where: ["the vault"],
    fix: () =>
      "Sign in with an API key instead, or add an authenticator app, email or YubiKey OTP as a second method in the web vault.",
    actions: [],
  }),
  row("sign-in-rate-limited", {
    row: 26,
    codes: [52],
    where: ["the vault"],
    fix: () => "Wait a few minutes before trying again.",
    fixInMessage: true,
    actions: [],
  }),
  row("sign-in-server-unreachable", {
    row: 27,
    codes: [53],
    where: ["the network", "the sign-in form"],
    fix: () => "Check the server address and this Box's network, then try again.",
    actions: [],
  }),
  row("sign-in-already-logged-in", {
    row: 28,
    codes: [54],
    where: ["this Box"],
    fix: () => "Unlock with the master password instead. To use another account, pick Use a different account under the unlock form, or run :vault signout.",
    actions: [],
  }),
  row("sign-in-expired", {
    row: 29,
    codes: [55],
    where: ["roster"],
    fix: () => "Start the sign-in again.",
    actions: [],
  }),
  row("sign-in-sso-failed", {
    row: 30,
    codes: [56],
    where: ["the vault"],
    fix: () => "Start SSO again and finish it in the browser within 5 minutes.",
    actions: [],
  }),
  row("sign-in-bad-server", {
    row: 31,
    codes: [57],
    where: ["the sign-in form"],
    fix: () => "Pick Bitwarden cloud or EU, or type your server's https:// address.",
    actions: [],
  }),
  row("sign-in-api-key-rejected", {
    row: 32,
    codes: [58],
    where: ["the sign-in form"],
    fix: () => "Copy client_id and client_secret again from the web vault (Account settings > Security > Keys); only a personal key works.",
    actions: [],
  }),
  row("sign-in-failed", {
    row: 33,
    codes: [59],
    where: ["the vault"],
    fix: () => "See Bitwarden's message under Details; `bw login` in a terminal shows the same.",
    actions: [],
  }),
  // Editing the Inventory (ticket 10): the pull before an edit, the edit itself, Q43's gate.
  row("edit-not-a-repo", {
    row: 38,
    codes: [70],
    where: ["roster.yml", "this Box"],
    fix: () => "Keep roster.yml in the infra repo (a git clone) to edit it here, or edit it by hand.",
    actions: [],
  }),
  row("edit-dirty", {
    row: 39,
    codes: [71],
    where: ["the infra repo"],
    fix: () => "Publish or discard the Pending changes; commit or stash any other changed file in a terminal.",
    actions: [{ kind: "run", label: "Show Pending changes", line: () => "changes" }],
  }),
  row("edit-diverged", {
    row: 40,
    codes: [72],
    where: ["the infra repo"],
    fix: () => "Merge or rebase in a terminal (`git pull --rebase`), then edit again.",
    actions: [],
  }),
  row("edit-pull-failed", {
    row: 41,
    codes: [73],
    where: ["the network", "the infra repo"],
    fix: () => "Check the network and your access to the infra repo, then try again.",
    actions: [],
  }),
  row("edit-invalid", {
    row: 42,
    codes: [74],
    where: ["roster.yml"],
    fix: () => "Make this edit by hand in roster.yml; nothing was written.",
    actions: [],
  }),
  row("edit-not-verified", {
    row: 43,
    codes: [75],
    where: ["roster"],
    fix: () => "Test the login with the new values, then save again.",
    actions: [],
  }),
  // Saving a typed password to the vault (ticket 13's vault.create_item, through host.add).
  row("vault-item-exists", {
    row: 34,
    codes: [60],
    where: ["the vault"],
    fix: () => "Pick the existing item as the Login, or give the new one another name (`<host> <what it opens>`).",
    actions: [],
  }),
  row("vault-cant-write", {
    row: 35,
    codes: [61],
    where: ["this Box"],
    fix: () => "Save to Bitwarden (`bw`) or KeePassXC (`kp`), or make the item in the password manager and pick it as the Login.",
    actions: [],
  }),
  row("vault-write-failed", {
    row: 36,
    codes: [62],
    where: ["the vault"],
    fix: () => "See the vault's words under Details; check your rights to the vault or collection.",
    actions: [],
  }),
  row("vault-not-created-here", {
    row: 37,
    codes: [63],
    where: ["roster"],
    fix: () => "Nothing to undo: roster only takes back the items it just saved.",
    actions: [],
  }),
  // Where it goes (ticket 35): the Save to setting or choice.
  row("vault-unknown-target", {
    row: 58,
    codes: [64],
    where: ["roster.yml", "init.lua"],
    fix: () => "Fix the save_to setting roster names, or pick another place in Save to.",
    actions: [],
  }),
  row("vault-read-only-target", {
    row: 59,
    codes: [65],
    where: ["the vault"],
    fix: () => "Pick a place you can write to in Save to, or ask an organization admin for write access.",
    actions: [],
  }),
  // "Save to vault" after a Session's own login (tickets 15, 16): roster saves only a password that
  // just logged in (Q43), and holds it only so long.
  row("save-not-logged-in", {
    row: 68,
    codes: [66],
    where: ["roster"],
    fix: () => "Wait until the Session has logged in. If the box refused the password, nothing is saved: check it and connect again.",
    actions: [],
  }),
  row("save-nothing-held", {
    row: 69,
    codes: [67],
    where: ["roster"],
    fix: () => "Connect again with Save to vault ticked: roster forgets the password once the Session ends, the vault locks, or 10 minutes pass.",
    actions: [],
  }),
  row("save-password-needed", {
    row: 70,
    codes: [39],
    where: ["roster.yml"],
    fix: () => "Type the Host's password when the pane asks; tick Save to vault to keep it in the vault once it has logged in.",
    actions: [],
  }),
  // Signing the vault CLI out (`vault.logout`, ticket 42): docs/app/errors.md rows 71-72. roster
  // forgets every secret before it runs the CLI's logout, so both leave nothing behind.
  row("sign-out-already", {
    row: 71,
    codes: [15],
    where: ["this Box"],
    fix: () => "Sign in from the lock screen; the CLI was already signed out (elsewhere, or a moment ago).",
    actions: [],
  }),
  row("sign-out-failed", {
    row: 72,
    codes: [16],
    where: ["the vault", "this Box"],
    fix: () => "See the details: the CLI's own words. `roster bw logout` in a terminal shows the same.",
    actions: [copy(() => "roster bw logout")],
  }),
  // The Mesh (`mesh.plan`, `mesh.apply`, ticket 39): docs/app/errors.md row 73. Rows 74-79 are a
  // Link's or a Host's status in the result, not errors.
  row("mesh-not-a-source", {
    row: 73,
    codes: [110],
    where: ["roster.yml"],
    fix: () => "Rotate a Host that reaches peers; the Mesh's plan lists them.",
    actions: [],
  }),
  // A Mesh job (API 17, ticket 50) still runs: docs/app/errors.md row 93.
  row("mesh-busy", {
    row: 93,
    codes: [111],
    where: ["roster"],
    fix: () => "Wait for the Mesh job (its progress is in the status bar), or stop it with `:cancel mesh`; then run it again.",
    actions: [],
  }),
  // serve answers concurrently (API 20, ticket 101): a lock held past this request's wait,
  // docs/app/errors.md row 113. Nothing was done.
  row("serve-busy", {
    row: 113,
    codes: [4],
    where: ["roster"],
    fix: () => "Try again once it has finished: nothing was done.",
    actions: [],
  }),
  // $/cancel (API 21, ticket 108): the core gave up waiting and cancelled a request that hadn't
  // started; docs/app/errors.md row 114. Nothing was done.
  row("serve-cancelled", {
    row: 114,
    codes: [5],
    where: ["roster"],
    fix: () => "Nothing was done: do it again if you still want it.",
    actions: [],
  }),
  // host.check_job (API 21, ticket 108): no such check in this serve; docs/app/errors.md row 115.
  row("check-gone", {
    row: 115,
    codes: [49],
    where: ["roster"],
    fix: () => "Check the Host again.",
    actions: [],
  }),
  // Adding a Host (ticket 11). A failed test login uses the failing step's own row.
  row("add-invalid", {
    row: 44,
    codes: [80],
    where: ["roster.yml"],
    fix: () => "Fix the field roster names, then add again; nothing was written.",
    actions: [],
  }),
  row("add-exists", {
    row: 45,
    codes: [81],
    where: ["roster.yml"],
    fix: (p) => `Pick another name, or edit that Host (\`:edit ${p.host}\`).`,
    actions: [],
  }),
  // Publishing (ticket 12, decision Q13): commit roster.yml alone, push, never force. Every
  // refusal leaves the Pending changes as they were.
  row("publish-nothing", {
    row: 46,
    codes: [90],
    where: ["roster.yml"],
    fix: () => "Edit a Host first; there's nothing to publish.",
    actions: [],
  }),
  row("publish-other-changes", {
    row: 47,
    codes: [91],
    where: ["the infra repo"],
    fix: () => "Commit, stash or undo the other changed files in a terminal (`git status` in the infra repo), then publish.",
    actions: [],
  }),
  row("publish-remote-moved", {
    row: 48,
    codes: [92],
    where: ["the infra repo"],
    fix: () => "Discard your Pending changes, :pull, and make them again; or merge in a terminal (`git stash && git pull --ff-only && git stash pop`).",
    actions: [],
  }),
  row("publish-unpushed", {
    row: 49,
    codes: [93],
    where: ["the infra repo"],
    fix: () => "Push or drop this Box's own commits in a terminal (`git log @{u}..` in the infra repo), then publish.",
    actions: [],
  }),
  row("publish-no-upstream", {
    row: 50,
    codes: [94],
    where: ["the infra repo"],
    fix: () => "Give the branch an upstream in a terminal (`git push -u origin main`), then publish.",
    actions: [],
  }),
  row("publish-commit-failed", {
    row: 51,
    codes: [95],
    where: ["the infra repo", "this Box"],
    fix: () => "See git's words under Details; often the infra repo has no git identity (`git config user.name` and `user.email`).",
    actions: [],
  }),
  row("publish-push-failed", {
    row: 52,
    codes: [96],
    where: ["the network", "the infra repo"],
    fix: () => "Publish again (it fetches first); if git's words under Details name your rights, ask whoever runs the infra repo.",
    actions: [],
  }),
  // The Live Inventory (ticket 28, decision Q45): removing, renaming and moving Hosts and groups.
  // A bad name is 80's row, an unknown Host 2's, a result that wouldn't load 74's.
  row("live-name-taken", {
    row: 53,
    codes: [100],
    where: ["roster.yml"],
    fix: () => "Pick another name; nothing was written.",
    actions: [],
  }),
  row("live-unknown-group", {
    row: 54,
    codes: [101],
    where: ["roster.yml"],
    fix: () => "Pick one of the groups roster names, or make it first (`:group new`).",
    actions: [],
  }),
  row("live-group-not-empty", {
    row: 55,
    codes: [102],
    where: ["roster.yml"],
    fix: () => "Say which group its Hosts go to (`:group delete GROUP OTHER`), or move them first.",
    actions: [],
  }),
  row("live-would-change", {
    row: 56,
    codes: [103],
    where: ["roster.yml"],
    fix: () => "Move it by hand in roster.yml, setting what it inherits on the Host itself; nothing was written.",
    actions: [],
  }),
  // Filling a password prompt (`session.fill`, ticket 119): docs/app/errors.md rows 143-144. Shown
  // on the message line when the fill key is pressed; nothing was looked up or typed.
  row("fill-refused", {
    row: 143,
    codes: [130],
    where: ["the Host"],
    fix: () => "roster fills only sudo's prompt for the Session's own Host's login user: type this password yourself, or reconnect if the Host was edited.",
    actions: [],
  }),
  row("fill-nothing-saved", {
    row: 144,
    codes: [131],
    where: ["roster.yml"],
    fix: () => "Add a sudo: {auth: VAULT-REFERENCE} to the Host in roster.yml for its own sudo password, or type it yourself.",
    actions: [],
  }),
  row("other", {
    row: null,
    codes: [3, 22],
    where: ["roster"],
    fix: () => "See roster's message.",
    actions: [retry],
  }),
];

export type ErrorRegistry = Registry<ErrorRow>;

export function builtinErrorRegistry(): ErrorRegistry {
  const registry = new Registry<ErrorRow>();
  for (const r of builtinErrorRows) registry.register(r);
  return registry;
}

/** The row for `code`: the last registered that lists it, so a Plugin's row wins; else "other". */
export function rowFor(rows: readonly ErrorRow[], code: ProblemCode): ErrorRow {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r?.codes.includes(code)) return r;
  }
  return rows.find((r) => r.id === "other") ?? (builtinErrorRows.at(-1) as ErrorRow);
}

/** The fix to show: roster's (or the classifier's) when it gave one, else the row's. */
export function fixFor(row: ErrorRow, p: Problem): string {
  return sentence(p.fix ?? row.fix(p), p.host);
}

/** roster writes messages as CLI lines ("no vault item…"); the panel shows them as sentences,
 * except that a Host's name keeps its spelling ("esxi-02 refused…"). */
export function sentence(text: string, host?: string): string {
  if (!text || (host && text.startsWith(host))) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A refusal from roster (or a failed call) as a Problem for the tab. */
export function problemFromCallError(host: string, e: unknown): Problem {
  if (e instanceof BackendCallError) {
    if (e.lost) return { code: "backend-lost", host, message: "Lost the connection to roster", details: e.message };
    const { fix, details, ...rest } = e.data ?? {};
    const data = rest as ProblemData;
    const head = e.code === null ? e.message : `[${e.code}] ${e.message}`;
    return {
      code: e.code ?? 3,
      host,
      message: e.message,
      ...(typeof fix === "string" ? { fix } : {}),
      // roster's `data.details` (API 7) is another program's own words (git's, ssh's).
      details: typeof details === "string" && details ? `${head}\n\n${details}` : head,
      ...(Object.keys(data).length ? { data } : {}),
    };
  }
  const message = e instanceof Error ? e.message : String(e);
  return { code: 3, host, message, details: message };
}

/** A failed `host.check` step as a Problem (the same row, fix and extras as a Session's). */
export function problemFromStep(
  host: string,
  step: { code?: number; message: string; fix?: string; details?: string; data?: Record<string, unknown> },
): Problem {
  return {
    code: step.code ?? 48,
    host,
    message: step.message,
    ...(step.fix ? { fix: step.fix } : {}),
    details: step.details ?? `[${step.code ?? "?"}] ${step.message}`,
    ...(step.data ? { data: step.data as ProblemData } : {}),
  };
}
