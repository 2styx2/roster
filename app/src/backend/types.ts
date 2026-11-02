// The ONE typed client between the UI and the Backend. Every component talks to the Backend
// through this interface; tests and the plain-browser dev page use the fake (fake.ts), the app
// uses the Tauri one (tauri.ts). Shapes follow roster's `roster serve` API, version 1 or newer
// (2 adds `host.check` and the Login/askpass/network codes 30-48: `:check` needs it).
import type { QuickTarget } from "../quick/target";

/** A Host as `hosts.list` returns it (roster's own object; only the fields the UI reads). */
export interface Host {
  name: string;
  group: string;
  ip: string;
  type: string;
  product: string;
  title: string;
  description: string;
  reviewed: boolean;
  enroll: boolean;
  ssh: { user: string; port: number; auth: string };
  web: string | null;
  /** Service entries roster left out of the Host because it can't use them (a bad port, url or
   * `login:` type in roster.yml); the rest of the Host loads. Absent from rosters before it. */
  problems?: ServiceProblem[];
  /** The Host's services by name (Host details, ticket 18). roster has always sent them; older
   * fixtures leave them out. */
  services?: Record<string, Service>;
  /** The Host's default Login for its services (`login:` in roster.yml). */
  login?: { user: string | null; auth: string | null };
  mac?: string | null;
  /** `shell_hooks:` in roster.yml (ticket 121): roster sends the Session's shell the hook line
   * that turns on its prompt marks. Passed through as written; absent when it isn't set. */
  shell_hooks?: boolean | null;
}

/** One of a Host's services, as roster resolves it. `auth` is a vault reference such as
 * `bw:esx-02 web` (the Vault item's name), never a secret. `url` is set for http and https ones. */
export interface Service {
  port: number;
  url: string | null;
  scheme: string | null;
  user: string | null;
  auth: string | null;
  verify: boolean;
  login: string;
  /** The service has a Login of its own; false: it uses the Host's default. */
  override: boolean;
}

/** One service entry roster left out: `message` names the service, `fix` says what to change. */
export interface ServiceProblem {
  service: string;
  message: string;
  fix: string;
}

export interface Group {
  title: string;
  description: string;
}

export interface HostList {
  hosts: Host[];
  groups: Record<string, Group>;
  /** roster.yml as it is now doesn't load (an outside edit): these are the last good Hosts, and
   * this says why (API 8; catalog row 1). Null or absent when it loads. */
  error?: InventoryFileError | null;
}

/** Why roster.yml doesn't load right now, with the line when roster knows it. */
export interface InventoryFileError {
  message: string;
  path: string | null;
  line?: number;
  fix?: string | null;
}

/** `inventory.info`. */
export interface InventoryInfo {
  path: string;
  box: string;
  host_count: number;
  providers: string[];
  roster_version: string;
  api_version: number;
}

export interface BackendInfo {
  /** "Local" or "WSL: <distro>". */
  backend: string;
  /** The command line that runs `roster serve`. */
  command: string[];
  inventory: InventoryInfo;
}

export type BackendProblemKind = "no-wsl" | "roster-missing" | "roster-too-old" | "inventory-not-found" | "failed";

/** Why the Backend couldn't start: shown as is on the error screen. */
export interface BackendProblem {
  kind: BackendProblemKind;
  message: string;
  hint: string;
  detail: string | null;
}

/** Thrown by `connect()`. */
export class BackendStartError extends Error {
  readonly problem: BackendProblem;
  constructor(problem: BackendProblem) {
    super(problem.message);
    this.name = "BackendStartError";
    this.problem = problem;
  }
}

/** A JSON-RPC error's `data` (docs/serve-api.md): `fix` in a sentence, plus what the code's row needs
 * (`near`, `matches`, `path`/`line`, `provider`, `field`). Names, dates and URIs; never a secret. */
export type CallErrorData = Record<string, unknown> & { fix?: string };

/** Thrown by a call once the Backend is up: roster's error code and message (ready to show). */
export class BackendCallError extends Error {
  readonly code: number | null;
  readonly data: CallErrorData | null;
  /** True when `roster serve` itself went away (exited, or stopped answering). */
  readonly lost: boolean;
  /** True when the app stopped waiting for this call: serve may still be finishing it, so what it did
   * is unknown until asked (`afterTimeout.ts`). */
  readonly timedOut: boolean;
  constructor(message: string, code: number | null = null, data: CallErrorData | null = null, lost = false, timedOut = false) {
    super(message);
    this.name = "BackendCallError";
    this.code = code;
    this.data = data;
    this.lost = lost;
    this.timedOut = timedOut;
  }
}

/** The first `api_version` with `host.check`. */
export const CHECK_API_VERSION = 2;

/** `host.check`'s steps, in the order roster runs them. */
export const CHECK_STEPS = ["inventory", "ssh-config", "provider", "vault-item", "dns", "tcp", "host-key", "auth"] as const;
export type CheckStepName = (typeof CHECK_STEPS)[number];

export interface CheckStep {
  step: CheckStepName | string;
  status: "ok" | "fail" | "skipped";
  message: string;
  code?: number;
  fix?: string;
  /** Raw text: ssh's stderr, the resolver's error. */
  details?: string;
  data?: Record<string, unknown>;
}

/** `host.check {host}`: every step, stopping (the rest `skipped`) at the first failure. */
export interface HostCheck {
  host: string;
  ok: boolean;
  steps: CheckStep[];
}

/** The first `api_version` with `box.check`: `:check` with no Host (ticket 49). */
export const BOX_CHECK_API_VERSION = 16;

/** How a health check came out (`box.check`), as Neovim's `:checkhealth` says them. */
export type HealthLevel = "ok" | "warn" | "error";

/** One of `box.check`'s checks. `section` is `roster`, `inventory`, `ssh`, `vault`, `askpass` or
 * `repo` (a newer roster may send others); `topic` is a `:help` topic (`E6`, `:publish`). */
export interface HealthCheck {
  section: string;
  level: HealthLevel;
  message: string;
  fix?: string;
  topic?: string;
}

/** `box.check`: this Box's health, every check local (nothing connects to a Host). */
export interface BoxCheck {
  checks: HealthCheck[];
  ok: boolean;
  roster_version: string;
  api_version: number;
}

/** The first `api_version` with `inventory.pull`, `host.verify_login`, `host.update` and `changes.*` (ticket 10). */
export const EDIT_API_VERSION = 5;

/** The first `api_version` with `changes.publish` and `changes.diff`'s `message` (ticket 12). */
export const PUBLISH_API_VERSION = 7;

/** The Host fields the edit form changes (`host.update`'s `changes`). */
export interface HostFields {
  title: string;
  description: string;
  type: string;
  ip: string;
  user: string;
  port: number;
  auth: string;
}

export type HostChanges = Partial<HostFields>;

/** Changing these needs a test login that just succeeded (`host.verify_login`, decision Q43). */
export const LOGIN_FIELDS = ["ip", "user", "port", "auth"] as const satisfies readonly (keyof HostFields)[];

/** `host.verify_login`'s steps, in order. */
export const VERIFY_STEPS = ["user", "provider", "vault-item", "dns", "tcp", "host-key", "auth"] as const;

/** `inventory.pull`: the infra repo fast-forwarded (or already up to date, or no upstream). */
export interface PullResult {
  updated: boolean;
  upstream: string | null;
  commits: number;
  ahead: number;
  message?: string;
}

/** `host.update`. */
export interface HostUpdate {
  changed: boolean;
  host: Host;
  /** Where roster kept the file as it was before (in the repo's git dir). */
  backup: string | null;
  /** `host.update`: what failed after the edit was written (recording a moved Host's key). */
  warnings?: string[];
}

/** One Host the Pending changes touch. */
export interface HostChange {
  host: string;
  change: "changed" | "added" | "removed";
  fields: string[];
}

/** `changes.diff`: roster.yml's uncommitted diff in the infra repo. */
export interface PendingChanges {
  path: string;
  repo: string;
  /** git's unified diff of roster.yml against the last commit ("" when there are none). */
  diff: string;
  hosts: HostChange[];
  /** Groups added, removed, or retitled (API 7). */
  groups?: GroupChange[];
  /** How many Pending changes: changed Hosts (1 for an edit that touches none, such as a comment). */
  count: number;
  /** The commit message `changes.publish` would write, naming what changed (API 7; "" when none). */
  message?: string;
  /** The branch's last commit, and whether its upstream has it (as this Box last fetched). */
  last_commit?: LastCommit | null;
}

export interface LastCommit {
  commit: string;
  subject: string;
  upstream: string | null;
  pushed: boolean;
}

/** One group the Pending changes touch. */
export interface GroupChange {
  group: string;
  change: "changed" | "added" | "removed";
}

/** `changes.publish`: the commit made and pushed, and whether `roster sync` followed. */
export interface PublishResult {
  /** The full hash of the commit, now on the upstream. */
  commit: string;
  upstream: string;
  message: string;
  hosts: HostChange[];
  groups: GroupChange[];
  /** Upstream commits that left roster.yml alone, fast-forwarded over first. */
  pulled: number;
  /** `roster sync` after the push: this Box's ssh config. A failure doesn't undo the Publish. */
  sync: { ok: boolean; error?: string; fix?: string };
}

/** The first `api_version` with the Live Inventory (ticket 28): `host.remove`, `host.rename`,
 * `host.move`, `group.new|rename|delete`, `inventory.reload` (`:source`), `inventory.watch` and the
 * `inventory.changed` notification, and `hosts.list`'s `error`. */
export const LIVE_API_VERSION = 8;

/** roster's codes for the Live Inventory (ticket 28). A bad name is 80, an unknown Host 2. */
export const LiveError = {
  nameTaken: 100,
  unknownGroup: 101,
  groupNotEmpty: 102,
  wouldChange: 103,
} as const;

/** `inventory.reload` (`:source`): roster.yml read again now; `error` while it doesn't load (the
 * last good Inventory stays). */
export interface InventoryReload {
  changed: boolean;
  host_count: number;
  error: InventoryFileError | null;
}

/** serve's `inventory.changed` notification: an outside edit of roster.yml. `applied`: it was
 * loaded (auto_reload on), with `error` if it doesn't load; else only noticed, for `:source`. */
export interface InventoryChanged {
  applied: boolean;
  error: InventoryFileError | null;
}

/** roster's codes for publishing (ticket 12; docs/app/errors.md rows 46-52). A failed fetch is 73. */
export const PublishError = {
  nothingPending: 90,
  otherChanges: 91,
  remoteMoved: 92,
  unpushed: 93,
  noUpstream: 94,
  commitFailed: 95,
  pushFailed: 96,
} as const;

/** roster's codes for editing the Inventory (ticket 10; docs/app/errors.md rows 38-43). */
export const EditError = {
  notARepo: 70,
  dirty: 71,
  diverged: 72,
  pullFailed: 73,
  invalidEdit: 74,
  notVerified: 75,
} as const;

/** The first `api_version` with `host.add`, `host.scan_key` and `host.review` (ticket 11). */
export const ADD_API_VERSION = 6;

/** The first `api_version` whose `host.review` takes `reviewed: false` (un-review; issue #78). */
export const UNREVIEW_API_VERSION = 9;

/** `host.add`'s params. A Login is either `auth` (an existing vault item, `bw:<host> ssh`) or
 * `password` (typed into the form, saved as `item` after the test login). Without one the Host
 * goes in unreviewed. `host_key` is the fingerprint the user confirmed for a new address. */
export interface AddHostParams {
  name: string;
  group: string;
  address: string;
  user?: string;
  port?: number;
  type?: string;
  title?: string;
  enroll?: boolean;
  auth?: string;
  password?: string;
  item?: string;
  host_key?: string;
  /** Which vault a typed password is saved in (roster's default vault when left out). */
  provider?: string;
  /** Where in it (ticket 35, API 10): the "Save to" choice; the setting's when left out. */
  save_to?: SaveTo;
}

/** `host.add`: the Host as roster.yml has it now, the test login (null without a Login) and the
 * Vault item it made (null unless a password was typed). */
export interface HostAdd {
  added: true;
  host: Host;
  backup: string;
  verify: HostCheck | null;
  item: { provider: string; id: string; name: string; target?: Omit<SaveTarget, "save_to"> } | null;
  /** What went wrong after the Host was written (recording its host key): it's added all the same. */
  warnings?: string[];
}

/** `host.scan_key`: the key the address offers, and how it compares with the recorded one. */
export interface ScannedKey {
  address: string;
  port: number;
  key_type: string;
  fingerprint: string;
  recorded: "none" | "match" | "changed";
}

/** roster's codes for adding a Host (ticket 11). A failed test login answers with its step's own
 * code (40-48, 30-35) and `data.steps`. */
export const AddError = {
  invalidHost: 80,
  hostExists: 81,
} as const;

/** The first `api_version` with `vault.configure`: init.lua's vault settings reach roster (tickets 35, 41). */
export const VAULT_CONFIG_API_VERSION = 10;

/** `vault.configure`'s params: this Box's vault settings from init.lua, as roster takes them.
 * Paths and choices only, never a secret. A key left out is roster.yml's again. */
export interface VaultSettings {
  save_to?: SaveTo;
  kp?: { database?: string; key_file?: string };
}

/** What `vault.configure` did. */
export interface VaultConfigured {
  configured: true;
  locked: string[];
  /** Settings whose value roster can't use (`kp.key_file`, `save_to`), and why: each is left out
   * while the rest apply. An older roster leaves this out. */
  refused?: { setting: string; message: string }[];
}

/** Where "Save to vault" puts a new Vault item (ticket 35): the personal vault (KeePassXC: the
 * top level), an organization's collection (Bitwarden; names or ids), or a group (KeePassXC). */
export type SaveTo = "personal" | { organization: string; collection: string } | { group: string };

/** One place `vault.targets` offers. `save_to` (ids, not names) is what to send back. */
export interface SaveTarget {
  id: string;
  kind: "personal" | "collection" | "group";
  /** "Personal vault", "My Team / Infra logins", "Top level", "Hosts". */
  label: string;
  organization?: string;
  collection?: string;
  save_to: SaveTo;
}

/** `vault.targets`: where the vault can save, and the default. `default` is null when the setting
 * names a place that isn't there; `problem` (code 64 or 65) then says which setting to fix. */
export interface SaveTargets {
  provider: string;
  targets: SaveTarget[];
  default: string | null;
  /** Where the default is set: init.lua's `vault.save_to`, roster.yml's `save_to`, or neither. */
  from: "init.lua" | "roster.yml" | null;
  problem: { code: number; message: string; fix: string } | null;
}

/** roster's codes for where to save (ticket 35). */
export const SaveToError = {
  unknownTarget: 64,
  readOnlyTarget: 65,
} as const;

/** Where a vault provider stands (`vault.status`). */
export type VaultStatusWord = "locked" | "unlocked" | "not-logged-in" | "missing-cli" | "unsupported";

export interface ProviderStatus {
  provider: string;
  status: VaultStatusWord;
  /** For not-logged-in and missing-cli: what to run or install (backticks around commands). */
  message?: string;
  /** For not-logged-in, when the app can sign the CLI in (`vault.login`, api 3): the ways in,
   * and the server the CLI is set to (null: Bitwarden's US cloud). */
  sign_in?: SignInInfo;
  /** For locked and unlocked (API 14): the account the CLI is signed in to, when it says. */
  account?: VaultAccount;
  /** Whether `vault.logout` can sign this provider's CLI out (API 14; Bitwarden only). */
  can_sign_out?: boolean;
}

/** The account a vault CLI is signed in to (API 14): `server` null is Bitwarden's US cloud. */
export interface VaultAccount {
  email: string;
  server: string | null;
}

/** The first `api_version` with `vault.logout` and `vault.status`'s `account` (ticket 42). */
export const SIGN_OUT_API_VERSION = 14;

/** The first `api_version` with the Mesh's methods (ticket 39): `mesh.plan`, `mesh.apply`,
 * `mesh.cut`, `mesh.status`, and a Host's `mesh`. The app's controls for them are T50's Plugin. */
export const MESH_API_VERSION = 15;

/** serve API 20 (ticket 101, decision Q112): serve answers requests concurrently, its jobs push
 * `job.progress`, and `host.get` takes `settled`. */
export const JOBS_API_VERSION = 20;

/** serve's `job.progress` notification: a job started, moved on or ended. Never its result. */
export type JobProgress = {
  kind: string;
  job: number | string;
  action: string;
  state: "running" | "stopping" | "done" | "stopped" | "failed";
  done: number;
  total: number;
  at: string | null;
  host?: string;
  error?: { code: number; message: string; data?: unknown };
};

/** roster's code for the Mesh (ticket 39): `rotate` names a Host that isn't a Mesh source. */
export const MeshError = { notASource: 110, busy: 111 } as const;

/** One Link of the Mesh: `from` reaches `to` (as `to`'s own user). `status` only in a plan or apply. */
export interface MeshLink {
  from: string;
  to: string;
  /** `password`: the peer takes no key, so ssh asks the person. */
  kind: "key" | "password";
  status?: "ok" | "untested" | "unreachable" | "no-host-key" | "pending" | "skipped";
  why?: string;
  skip?: "password-source";
}

/** What `mesh.plan` or `mesh.apply` found or did on one Host. */
export interface MeshHost {
  host: string;
  status: "same" | "would-change" | "changed" | "pending";
  /** Short phrases: "make key", "add key from orion-2", "write ssh config", ... */
  changes: string[];
  error?: string;
}

/** `mesh.plan` (`applied: false`) and `mesh.apply`. */
export interface MeshResult {
  applied: boolean;
  links: MeshLink[];
  hosts: MeshHost[];
  excluded: Record<string, string>;
  reach: Record<string, number>;
  pending: Record<string, string>;
  /** Nothing to change and nothing pending: "already in the mesh". */
  already: boolean;
  warnings: string[];
  cut_pending: Record<string, string[]>;
}

/** `mesh.cut`: confirmed Hosts, the ones that didn't answer, and the `mesh: false` Pending change. */
export interface MeshCut {
  host: string;
  confirmed: string[];
  pending: Record<string, string>;
  change: { written: boolean; backup?: string | null; note?: string; error?: string; fix?: string };
}

/** `mesh.status`: no connections. */
export interface MeshStatus {
  links: MeshLink[];
  excluded: Record<string, string>;
  reach: Record<string, number>;
  members: string[];
  pending: Record<string, string>;
  cut_pending: Record<string, string[]>;
  out_of_date: boolean;
}

/** `vault.logout`: where the vault stands now (not-logged-in, with `sign_in`), and the account it
 * signed out of (null when the CLI didn't name one). */
export type SignedOut = ProviderStatus & { signed_out: VaultAccount | null };

/** How the vault CLI can be signed in from the app (roster's docs/serve-api.md "Signing in: vault.login"). */
export type SignInWay = "password" | "apikey" | "sso";

export interface SignInInfo {
  methods: SignInWay[];
  server: string | null;
}

/** `vault.status`: the vault the lock screen unlocks (`provider` is null when none has a master password). */
export interface VaultStatus {
  provider: string | null;
  status: VaultStatusWord;
  message?: string;
  sign_in?: SignInInfo;
  account?: VaultAccount;
  can_sign_out?: boolean;
  /** Where "Save to vault" goes by default, as set (API 10): `from` "default" means the personal vault. */
  save_to?: { setting: SaveTo; from: "init.lua" | "roster.yml" | "default" };
  providers: ProviderStatus[];
}

/** Where `vault.login` starts: email + master password, an API key, or SSO in a browser.
 * `server` is "cloud", "eu" or a self-hosted https:// URL. */
export type SignInStart =
  | { method: "password"; server: string; email: string; password: string }
  | { method: "apikey"; server: string; client_id: string; client_secret: string }
  | { method: "sso"; server: string; identifier?: string };

/** A two-step method bw offers, in its order (FIDO2 and Duo never appear: the CLI can't do them). */
export interface TwoFactorMethod {
  index: number;
  /** bw's number for it: 0 authenticator, 1 email, 3 YubiKey OTP. */
  id: number | null;
  kind: "authenticator" | "email" | "yubikey" | "other";
  name: string;
}

/** What `vault.login` asks for next. `login` is the sign-in's id, sent back with the answer. */
export type SignInStep = { login: string } & (
  | { step: "two_factor_method"; methods: TwoFactorMethod[] }
  /** `method` is null when the account has one method and bw picked it; `sent`: emailed just now. */
  | { step: "two_factor_code"; method: TwoFactorMethod | null; sent: boolean }
  | { step: "new_device_code"; email: string | null }
  /** Open `url` in a browser; answer `{}` to wait for it (roster waits up to 20 s per call). `url` is null on
   * native Windows (API 23), where bw opened the page itself and there's no link to hand over. */
  | { step: "sso"; url: string | null; expires_in: number }
  /** After an API key or SSO, which only log in: the vault still needs the master password. */
  | { step: "master_password"; email: string | null }
  | { step: "done"; provider: string; status: "unlocked" }
);

export type SignInAnswer = { method: number } | { code: string } | { password: string } | Record<string, never>;

/** roster's `vault.login` error codes (10, 12 and 13 are VaultError's). A 50 (and a 10 at the
 * master-password step) carries `data.step`: the sign-in goes on there. */
export const SignInError = {
  codeRejected: 50,
  methodUnsupported: 51,
  rateLimited: 52,
  serverUnreachable: 53,
  alreadyLoggedIn: 54,
  noSignIn: 55,
  ssoFailed: 56,
  badServer: 57,
  apiKeyRejected: 58,
  failed: 59,
} as const;

/** roster's `vault.*` error codes (BackendCallError.code). */
export const VaultError = {
  wrongPassword: 10,
  notLoggedIn: 11,
  cliMissing: 12,
  unsupported: 13,
  locked: 14,
  /** `vault.logout` (API 14): the CLI isn't signed in, so there's no account to sign out of. */
  alreadySignedOut: 15,
  /** `vault.logout`: the CLI refused to log out (its words in the message); secrets were forgotten anyway. */
  signOutFailed: 16,
} as const;

/** A terminal size in character cells. */
export interface TermSize {
  cols: number;
  rows: number;
}

/** How a Session ended. */
export interface SessionExit {
  /** The exit code (ssh's 255 when it couldn't connect); null when a signal ended it. */
  code: number | null;
  /** True when the app closed it; the code then means nothing. */
  closed: boolean;
}

/** Where a Session's output goes: bytes in order, then exactly one exit. */
export interface SessionEvents {
  output(data: Uint8Array): void;
  exit(exit: SessionExit): void;
}

/** How a Session logs in (`session.prepare`'s `auth`). A password Session's password goes from
 * roster to ssh over roster's askpass channel; the app never sees it. */
export type SessionAuth = "key" | "password";

/** A running Session (a PTY with ssh in it), as the core names it. */
export interface SessionHandle {
  readonly id: number;
  readonly auth: SessionAuth;
  /** serve's id for a Quick Connect (ticket 14); absent otherwise. */
  readonly quick?: string;
  /** The id serve holds the typed password under for "Save to vault" (API 13, tickets 15 and 16),
   * when it was asked to; `onLoggedIn` names it once the Session has logged in with it. */
  readonly held?: string;
  /** Keystrokes or pasted text, as xterm's onData gives them. */
  write(data: string): Promise<void>;
  resize(size: TermSize): Promise<void>;
  /** Ends it (kills ssh). The exit event still follows, with `closed: true`. */
  close(): Promise<void>;
  /** Fills the password prompt the Session shows from the vault (serve API 25, ticket 119,
   * decision Q129), for the line at its cursor (`prompt`, the Host's text). The core asks serve for
   * the password of the Host the Session was opened to and types it only if the prompt doesn't
   * echo; nothing of it comes back here, only the Host's name. Rejects with serve's code (130 a
   * prompt roster won't fill, 131 no saved password, the vault's 11, 12, 14, 31-35) or the core's
   * refusal (it echoes, a key was typed meanwhile). Absent on a Quick Connect: no Login to fill.
   * `hop` (serve API 26, ticket 120): a nested ssh's Inventory Host, as roster resolved it from the
   * command line; serve answers for that Host, and the core types it only if the Session printed
   * `prompt` itself. */
  fill?(prompt: string, hop?: NestedHost): Promise<{ host: string }>;
}

/** `session.prepare`'s error codes (docs/serve-api.md): the message is roster's, ready to show.
 * Every code has its row in src/errors/catalog.ts (docs/app/errors.md). */
export const SessionRefusal = {
  inventory: 1,
  unknownHost: 2,
  notReviewed: 20,
  notSetUp: 21,
  noAskpass: 22,
  noUser: 30,
  noProvider: 31,
  itemNotFound: 32,
  severalItems: 33,
  noField: 34,
  lookupFailed: 35,
  /** A password Host's vault: CLI not logged in, not installed, or locked (the VaultError codes). */
  vaultNotLoggedIn: VaultError.notLoggedIn,
  vaultCliMissing: VaultError.cliMissing,
  vaultLocked: VaultError.locked,
  /** No host key recorded for the Host (API 11, ticket 36): the app asks before it connects.
   * `data`: its `address` and `port`. */
  hostKeyUnknown: 44,
  /** The Host's Login is `auth: prompt` (API 13, ticket 16): the app asks for the password.
   * `data`: its `user`, `address` and `port`. */
  passwordNeeded: 39,
} as const;

/** The first `api_version` whose Sessions check host keys strictly and ask first (ticket 36, Q60):
 * `session.prepare`'s 44, `host.scan_key {host}`, `host.trust_key`. */
export const HOST_KEY_API_VERSION = 11;

/** `host.scan_key {host}` (API 11, ticket 36): the key a Host offers, to ask about. */
export interface HostKeyScan extends ScannedKey {
  host: string;
}

/** `host.trust_key`: the key it recorded (`recorded: false` when it already was). */
export interface HostKeyTrust extends Omit<HostKeyScan, "recorded"> {
  recorded: boolean;
}

/** The first `api_version` with Quick Connect (ticket 14): `quick.prepare`. */
export const QUICK_CONNECT_API_VERSION = 12;

/** A Quick Connect's box and the fingerprint the user was shown (`scanKey`): what `quick.prepare`
 * takes besides the password. */
export interface QuickConnect extends QuickTarget {
  fingerprint: string;
}

/** Login references with no password behind them: roster's providers.NO_PASSWORD, kept in step by
 * tests/test_prompt_fill.py. (`prompt` has none saved either, but it's a provider of its own.) */
export const NO_PASSWORD_AUTHS = ["agent", "key", "none"] as const;

/** The first `api_version` with `session.fill` (ticket 119): filling a password prompt. */
export const FILL_API_VERSION = 25;

/** The first `api_version` with `session.fill`'s `hop` (ticket 120): filling a nested ssh's
 * prompt, or that Host's sudo, with that Host's Login. */
export const NESTED_FILL_API_VERSION = 26;

/** The Inventory Host a nested ssh went to and what roster resolved it to (`session.fill`'s
 * `hop`). Never a password. */
export interface NestedHost {
  host: string;
  address: string;
  port: number;
  user: string;
}

/** `session.fill`'s codes (docs/serve-api.md): rows 143 and 144 in docs/app/errors.md. */
export const FillRefusal = {
  /** The prompt isn't one roster fills, or asks for another Host or account. */
  refused: 130,
  /** The Login that would answer has no saved password. */
  nothingToFill: 131,
} as const;

/** The first `api_version` with "Save to vault" after a Session's own login (tickets 15, 16):
 * `quick.prepare`'s `save`, `quick.save`, `vault.forget_typed` and `session.logged_in`. */
export const SAVE_TO_VAULT_API_VERSION = 13;

/** `quick.save`'s params: the Quick Connect (serve's id) and the Host it becomes. The password
 * isn't here: serve holds it, and saves it only after that Session logged in with it (Q43). */
export interface QuickSaveParams {
  quick: string;
  name: string;
  group: string;
  title?: string;
  /** The Vault item's name (`<name> ssh` when left out). */
  item?: string;
  /** Where in the vault (ticket 35): the "Save to" choice; the setting's when left out. */
  save_to?: SaveTo;
}

/** `quick.save`: the Host as roster.yml has it now and the Vault item it made. */
export type QuickSave = Omit<HostAdd, "verify" | "item"> & { item: NonNullable<HostAdd["item"]> };

/** A password the user typed for an `auth: prompt` Host's Session (ticket 16), and whether roster
 * should hold it for "Save to vault". It goes once to serve; the caller keeps no copy. */
export interface TypedPassword {
  password: string;
  save?: boolean;
}

/** `host.save_login`'s params: the held id; the password itself stays with serve. */
export interface SaveLoginParams {
  held: string;
  item?: string;
  save_to?: SaveTo;
}

/** `host.save_login`: the Host as roster.yml has it now (its Login the new item's). */
export interface SaveLogin {
  changed: true;
  host: Host;
  backup: string;
  item: NonNullable<HostAdd["item"]>;
  warnings?: string[];
}

/** roster's codes for "Save to vault" after a Session's login, besides vault.create_item's (60-65)
 * and host.add's (80, 81). */
export const SaveLoginError = {
  /** The Session hasn't logged in with the typed password (yet, or the box refused it). */
  notLoggedIn: 66,
  /** No typed password held for it: saved already, or forgotten (ended, locked, 10 minutes). */
  nothingHeld: 67,
} as const;

/** `host.trust_key`'s refusals besides 40-42 (couldn't fetch the key): nothing is recorded. */
export const HostKeyError = {
  /** Another key is recorded for the address (Q44): never trusted from the app. */
  changed: 43,
  /** The Host offers another key than the one the user was asked about. */
  changedWhileAsked: 23,
} as const;

export interface Backend {
  /** Find and start the Backend, or return the running one. Rejects with BackendStartError. */
  connect(options?: { restart?: boolean }): Promise<BackendInfo>;
  /** Every Host and group, in roster.yml order. */
  listHosts(): Promise<HostList>;
  /** One Host by exact name. `settled` (serve API 20) waits for a write to roster.yml under way
   * first: serve answers concurrently, so a check after a timed-out `host.add` needs it. An older
   * serve answers in order, which settles it anyway. */
  getHost(name: string, options?: { settled?: boolean }): Promise<Host>;
  /** Where the vault stands. */
  vaultStatus(): Promise<VaultStatus>;
  /** Unlock the vault with its master password. Rejects with BackendCallError (VaultError codes). */
  unlockVault(password: string): Promise<ProviderStatus>;
  /** Forget every secret and lock the vault. Never rejects for a vault reason. */
  lockVault(): Promise<{ locked: string[] }>;
  /** `vault.configure` (API 10): this Box's vault settings from init.lua, replacing the last ones.
   * `locked`: providers that were unlocked and aren't now (a KeePassXC database that changed). */
  configureVault(settings: VaultSettings): Promise<VaultConfigured>;
  /** `vault.targets` (API 10): where "Save to vault" can put an item, and the default. Needs the
   * vault unlocked (14). */
  saveTargets(): Promise<SaveTargets>;
  /** Start signing the vault CLI in (`vault.login`). Rejects with BackendCallError (SignInError
   * and VaultError codes); `data.step` says where a sign-in carries on after a failure. */
  signIn(start: SignInStart): Promise<SignInStep>;
  /** Answer the sign-in's current step. */
  signInAnswer(login: string, answer: SignInAnswer): Promise<SignInStep>;
  /** Stop the sign-in in progress (and forget what roster held for it). Never rejects. */
  signInCancel(): Promise<void>;
  /** `vault.logout` (API 14, ticket 42): roster forgets every secret, then signs the vault CLI out.
   * Rejects with BackendCallError (VaultError: 13 no account, 15 already signed out, 16 failed). */
  signOut(): Promise<SignedOut>;
  /** Open a Session to a Host in a PTY of `size`. Rejects with BackendCallError (a
   * `SessionRefusal` code) when roster won't open it; a failed login is ssh's own output.
   * Every call asks roster afresh (`session.prepare` right before the spawn), so a password
   * Session always gets a new one-time askpass token: call it again to reconnect. */
  openSession(host: string, size: TermSize, events: SessionEvents, typed?: TypedPassword): Promise<SessionHandle>;
  /** `quick.prepare` (API 12, ticket 14), then the command in a PTY: a Session to a box that isn't
   * in the Inventory. roster fetches the key again and refuses (23) one that isn't `to.fingerprint`,
   * or (43) one that differs from a key it recorded. A typed `password` goes once to serve, which
   * hands it to ssh through an askpass token; null logs in with this Box's keys. The caller keeps
   * no copy of it. */
  openQuickSession(
    to: QuickConnect,
    password: string | null,
    size: TermSize,
    events: SessionEvents,
    options?: { save?: boolean },
  ): Promise<SessionHandle>;
  /** `quick.save` (API 13, ticket 15): the Vault item, then the Host as a Pending change, from a
   * Quick Connect that logged in with its typed password (Q43). Rejects with SaveLoginError,
   * vault.create_item's 60-65 or AddError; the item is taken back out if the Host can't be added. */
  saveQuick(params: QuickSaveParams): Promise<QuickSave>;
  /** `host.save_login` (API 13, ticket 16): the Vault item, then the `auth: prompt` Host's Login
   * pointed at it as a Pending change, once its Session logged in with the typed password (Q43).
   * Rejects with SaveLoginError, 60-65, or 75 (the Host changed since that Session logged in). */
  saveLogin(params: SaveLoginParams): Promise<SaveLogin>;
  /** `vault.forget_typed` (API 13): serve forgets the typed password it held for "Save to vault".
   * Never rejects for a roster reason. */
  forgetTyped(held: string): Promise<{ forgotten: boolean }>;
  /** Calls `onLogin` with the held id each time a Session that holds a typed password for "Save to
   * vault" logs in with it (serve's `session.logged_in`); returns stop. */
  onLoggedIn(onLogin: (held: string) => void): () => void;
  /** `host.check`: roster's diagnostics for one Host (at most one connection and one login). */
  checkHost(host: string): Promise<HostCheck>;
  /** `box.check` (API 16, ticket 49): this Box's health, a section at a time. Every check is
   * local; nothing connects to a Host. */
  checkBox(): Promise<BoxCheck>;
  /** `inventory.pull`: fast-forward the infra repo before an edit. Rejects with an EditError code
   * (71 Pending or other uncommitted changes, 72 diverged, 73 fetch failed, 70 not a git repo). */
  pullInventory(): Promise<PullResult>;
  /** `host.verify_login`: one test login with the Host's new address, user or Login (same shape
   * as `host.check`, steps VERIFY_STEPS). Success lets `updateHost` make exactly that change. */
  verifyLogin(host: string, changes: HostChanges): Promise<HostCheck>;
  /** `host.update`: the edit, written into roster.yml as a Pending change (comments kept). */
  updateHost(host: string, changes: HostChanges): Promise<HostUpdate>;
  /** `changes.diff`: the Pending changes. */
  pendingChanges(): Promise<PendingChanges>;
  /** `changes.discard`: roster.yml back as the last commit has it. */
  discardChanges(): Promise<{ discarded: boolean; backup: string | null }>;
  /** `changes.publish`: commit roster.yml with `message` and push it (never forced), then
   * `roster sync`. Rejects with a PublishError code (or 73 fetch failed, 1 roster.yml broken). */
  publishChanges(message: string): Promise<PublishResult>;
  /** `host.remove`: take the Host out of roster.yml as a Pending change. Never touches the vault. */
  removeHost(host: string): Promise<{ removed: string; group: string; backup: string }>;
  /** `host.rename`: the Host's name in roster.yml, nothing else. Rejects with 100 (taken) or 80. */
  renameHost(host: string, to: string): Promise<HostUpdate>;
  /** `host.move`: to the end of another group; what it inherited and wouldn't there is written on
   * it (`pinned`). Rejects with 101 (no such group) or 103 (it would come out different). */
  moveHost(host: string, group: string): Promise<HostUpdate & { pinned: string[] }>;
  /** `group.new`: an empty group after the last one. */
  newGroup(name: string, title?: string): Promise<{ group: string; backup: string }>;
  /** `group.rename`: its Hosts go with it. */
  renameGroup(group: string, to: string): Promise<{ changed: boolean; group: string; backup: string | null }>;
  /** `group.delete`: refuses (102, `data.hosts`) a group that still has Hosts unless `to` says
   * where they go. */
  deleteGroup(group: string, to?: string): Promise<{ deleted: string; moved: string[]; to: string | null; backup: string }>;
  /** `inventory.reload`: `:source` for roster.yml. */
  reloadInventory(): Promise<InventoryReload>;
  /** `inventory.watch`: notice outside edits of roster.yml; `auto` applies them (auto_reload). */
  watchInventory(auto: boolean): Promise<{ watching: boolean; auto: boolean }>;
  /** Calls `onChange` for each `inventory.changed`; returns stop. */
  onInventoryChanged(onChange: (change: InventoryChanged) => void): () => void;
  /** Calls `onProgress` for each `job.progress` (serve API 20): a Mesh run's or a scan's progress,
   * for the Plugins' `job_progress` event. Returns stop. */
  onJobProgress(onProgress: (job: JobProgress) => void): () => void;
  /** `host.scan_key`: the host key an address offers, for the user to confirm before a first login. */
  scanKey(address: string, port: number): Promise<ScannedKey>;
  /** `host.scan_key {host}`: the key a Host offers, for the question before a Session to a Host
   * roster has no key for (ticket 36). One connection, key exchange only; records nothing. */
  scanHostKey(host: string): Promise<HostKeyScan>;
  /** `host.trust_key`: record the key the user was shown and trusted. roster fetches it again and
   * refuses (HostKeyError) if it changed; rejects with 40-42 when it can't get there. */
  trustHostKey(host: string, fingerprint: string): Promise<HostKeyTrust>;
  /** `host.add`: test the Login, save a typed password to the vault, add the Host as a Pending
   * change (decision Q43). Rejects with the failed step's code and `data.steps`, or AddError. */
  addHost(params: AddHostParams): Promise<HostAdd>;
  /** `host.review`: mark a Host reviewed (only that flag), as a Pending change; `reviewed: false`
   * (API 9) marks it unreviewed again, for a review made by mistake. */
  reviewHost(host: string, reviewed?: boolean): Promise<HostUpdate>;
  /** Plugins (ticket 23, docs/plugins.md): the manifest of the Plugin folder at `path` (`~/…`,
   * absolute, or under the config folder), for the permission prompt. Runs none of its code. */
  pluginManifest(path: string): Promise<{ manifest: PluginManifest; dir: string }>;
  /** `:plugins types PATH` (ticket 74): writes the Plugin API's stubs for this app's version as
   * `types/roster.lua` in the Plugin folder at `path`; resolves to the file's path. */
  pluginTypes(path: string): Promise<string>;
  /** Loads (or reloads) a Plugin with what the user granted (`builtin:NAME` for a built-in one).
   * Rejects when its manifest can't be used; an error in its code comes back in `reply`. */
  pluginLoad(path: string, grants: readonly string[], settings?: Record<string, unknown> | null): Promise<{ manifest: PluginManifest; dir: string; reply: PluginReply }>;
  /** Calls a function the Plugin handed over (`{handler}` in its ops). `user` (default true): the
   * user chose it; `"carried"` for the Plugin's own command its `roster.cmd` ran from the user's
   * call (that call carried one hop: nothing made in it carries it further, issue #183); false for
   * what the app runs on its own (a finder's items, a `:check`, a timer, a question's cancel
   * because another took its place, a command a carried run's `roster.cmd` named), which is never
   * the user's call. */
  pluginCall(plugin: string, handler: number, args: unknown, user?: PluginCaller): Promise<PluginReply>;
  /** Tells every Plugin that listens and may hear it; the ones that changed something or failed answer. */
  pluginEvent(name: PluginEventName, payload: Record<string, unknown>): Promise<PluginReply[]>;
  /** The Sessions open now, in the order the app saw them open: the whole list, which replaces
   * the core's (`roster.sessions.list()`, ticket 96, decision Q127). */
  pluginSessions(open: OpenSession[]): Promise<void>;
  /** Takes a Plugin out of the core. */
  pluginUnload(plugin: string): Promise<boolean>;
  /** Removes a Plugin's data folder with everything in it (decision Q93), when the Plugin is
   * removed: `:plugins remove`, `:packages clean`. True if it had one. */
  pluginForget(plugin: string): Promise<boolean>;
  /** The app's built-in commands (issue #184), at the start and when one registers later: none is
   * a Plugin's own to run with `roster.cmd` or a `run` line, whatever it named its commands. */
  pluginBuiltins(names: readonly string[]): Promise<void>;
  /** Each loaded Plugin's network requests by site since the app started, by its name (decision
   * Q116), for `:plugins`. */
  pluginRequests(): Promise<Record<string, SiteRequests[]>>;
  /** How full each named Plugin's data folder is, loaded or not (ticket 98), for `:plugins`. */
  pluginData(names: readonly string[]): Promise<Record<string, PluginData>>;
  /** The replies nobody asked for: what a Plugin did when one of its HTTP requests answered
   * (the `network` permission, decision Q97). The core sends them as they come. */
  onPluginReply(onReply: (reply: PluginReply) => void): () => void;
  /** `:tutor`'s demo (ticket 66, decision Q123): a Plugin host of its own, beside this one, over
   * the demo Inventory's `hosts`. Its Plugins run with the grants they have here, but roster serve
   * answers only `hosts.list` and `host.get` from `hosts` (any other method is refused), no
   * request reaches the network, and each Plugin's files are a throwaway folder, empty at the
   * start. `close` stops them all and throws the folder away. Absent: the demo has only its own
   * built-in Plugins. */
  demoPlugins?(hosts: HostList): Promise<DemoPluginHost>;
  /** Packages (ticket 24, docs/plugins.md): clones what init.lua names and isn't cloned yet, and
   * checks out what roster.lock pins. A Package loads as the Plugin `package:NAME`. */
  packagesSync(): Promise<PackageStatus[]>;
  /** Pins a Package's commit in roster.lock: the user allowed its install prompt. */
  packagesPin(name: string): Promise<PackageStatus>;
  /** Removes a Package's clone, the lock as it is: its install prompt was cancelled. */
  packagesDiscard(name: string): Promise<void>;
  /** Removes a Package's clone and its roster.lock entry (`:plugins remove`). */
  packagesRemove(name: string): Promise<void>;
  /** `:packages update`, step 1: fetches and describes each new commit. Changes nothing. With a
   * name (`:packages update NAME`), only that Package; rejects when init.lua names no such
   * Package or it isn't installed. */
  packagesCheck(name?: string): Promise<PackageChecked[]>;
  /** Step 2: moves a Package to a commit the user saw and allowed, and pins it. */
  packagesApply(name: string, commit: string): Promise<PackageStatus>;
  /** `:packages clean`: removes what init.lua no longer names; gives their names. */
  packagesClean(): Promise<string[]>;
}

/** A Package as roster-core's `package::Status` describes it. */
export interface PackageStatus {
  name: string;
  /** As init.lua writes it (`owner/repo`). */
  source: string;
  /** The git URL that means. */
  url: string;
  /** The folder in the repo the Plugin loads from (`plugins/topology`); null for the repo's top (Q94). */
  dir: string | null;
  /** `tag v1.0.0`, `branch main`, `commit 1a2b3c4` or `default branch`. */
  wants: string;
  /** The commit its clone is at. */
  commit: string | null;
  /** The commit roster.lock pins. */
  locked: string | null;
  /** Installed: the lock pins the commit the clone is at. */
  pinned: boolean;
  /** init.lua's settings for it (`roster.plugin.config`). */
  config: Record<string, unknown>;
  note: string | null;
  error: string | null;
}

/** The demo's Plugin host (`Backend.demoPlugins`): the Plugin methods, on the demo's own host. */
export type DemoPluginHost = Pick<Backend, "pluginManifest" | "pluginTypes" | "pluginLoad" | "pluginCall" | "pluginEvent" | "pluginSessions" | "pluginUnload" | "pluginForget" | "pluginBuiltins" | "onPluginReply"> & {
  close(): Promise<void>;
};

/** The words a Plugin on the demo gets for a serve method the demo has no stand-in for (errors.md
 * row 135; the core's plugin/demo.rs says the same). */
export function notOnDemo(method: string): string {
  return `${method} isn't on the demo Inventory: the tutorial's demo answers only hosts.list and host.get`;
}

/** A newer commit, shown before it's applied. */
export interface PackageUpdate {
  from: string;
  to: string;
  /** `1a2b3c4 Subject`, newest first. */
  log: string[];
  stat: string;
  diff: string;
  truncated: boolean;
  manifest: PluginManifest | null;
  manifestError: string | null;
}

/** One Package's answer to `packagesCheck`: an update, an error, or neither (up to date). */
export interface PackageChecked {
  name: string;
  update: PackageUpdate | null;
  error: string | null;
}

/** A permission as the manifest asks for it, with what it allows and why it's risky (decision Q81). */
export interface PluginPermission {
  name: string;
  summary: string;
  risk: string | null;
}

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author: string | null;
  /** The `roster.api_version` it was written for. */
  api: number;
  permissions: PluginPermission[];
}

/** An error in a Plugin: `recent-alerts: init.lua:12: message`. */
export interface PluginErrorInfo {
  plugin: string;
  file: string | null;
  line: number | null;
  message: string;
}

/** What a Plugin answered: its function's result, the UI changes it asked for (untrusted data:
 * plugins/ops.ts checks them), an error, and whether it's now disabled. */
/** Whose call a Plugin's run is: the user's (true), the user's carried one hop (a command the
 * Plugin's `roster.cmd` ran from the user's call), or the app's (false). Decision Q98, issue #183. */
export type PluginCaller = boolean | "carried";

/** How a Plugin used one network site since the app started, as the core counts it (decision
 * Q116): counts and a time only, never a path, a query, a header or a body. */
export interface SiteRequests {
  /** The site as its permission names it, after `network:`. */
  site: string;
  requests: number;
  /** Of those, the ones that got no answer (an HTTP error status is an answer). */
  failed: number;
  /** When the last one was sent, in ms since 1970. */
  last: number;
}

/** How full a Plugin's data folder is, as the core counts it (ticket 98): files and bytes as
 * the caps (1,000 files, 10 MB) count them, never what they hold. `none`: nothing written yet;
 * `problem`: it can't be counted (it's a link, or it can't be read). */
export type PluginData = { state: "none" } | { state: "used"; files: number; bytes: number } | { state: "problem"; message: string };

export interface PluginReply {
  plugin: string;
  result: unknown;
  ops: unknown[];
  error: PluginErrorInfo | null;
  disabled: string | null;
}

/** The events a Plugin can listen for (roster-core's plugin::EVENTS). */
export const PLUGIN_EVENTS = [
  "lock",
  "unlock",
  "host_selected",
  "session_open",
  "session_exit",
  "inventory_changed",
  "terminal_output",
  "command_done",
  "job_progress",
] as const;
/** An open Session as the core's `roster.sessions.list()` gets it: a Quick Connect Session's host is null. */
export interface OpenSession {
  session: number;
  host: string | null;
}

export type PluginEventName = (typeof PLUGIN_EVENTS)[number];
