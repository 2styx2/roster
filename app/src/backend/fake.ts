// The fake Backend: same interface as the real one, answering from fixtures. Used by the UI tests
// and by `npm run dev` in a plain browser, where `?fixture=<name>` picks a scenario.
import {
  AddError,
  type AddHostParams,
  BackendCallError,
  BackendStartError,
  type Backend,
  type BackendInfo,
  type BackendProblem,
  type BoxCheck,
  BOX_CHECK_API_VERSION,
  type HealthCheck,
  type CallErrorData,
  CHECK_STEPS,
  EditError,
  type Host,
  type HostChange,
  type HostChanges,
  type HostCheck,
  type HostFields,
  type HostList,
  type GroupChange,
  type InventoryChanged,
  type InventoryFileError,
  LiveError,
  LOGIN_FIELDS,
  type PendingChanges,
  type ScannedKey,
  VERIFY_STEPS,
  type ProviderStatus,
  type SignInAnswer,
  SignInError,
  type SignInStart,
  type SignInStep,
  type TwoFactorMethod,
  type VaultStatus,
  type VaultStatusWord,
  VaultError,
  VAULT_CONFIG_API_VERSION,
  type VaultSettings,
  type SaveTarget,
  type SaveTargets,
  type SaveTo,
  SaveToError,
  type Service,
  type SessionAuth,
  type SessionEvents,
  type SessionHandle,
  type TermSize,
  SessionRefusal,
  HostKeyError,
  type QuickConnect,
  type QuickSave,
  type QuickSaveParams,
  type SaveLogin,
  type SaveLoginParams,
  PublishError,
  SAVE_TO_VAULT_API_VERSION,
  SaveLoginError,
  SIGN_OUT_API_VERSION,
  type SignedOut,
} from "./types";
import type { KeymapOverrides } from "../keymap";
import { fakePackageHost, type FakePackages } from "./fakePackages";
import { described, fakePluginHost, type FakePlugin } from "./fakePlugins";
import { formatQuickTarget } from "../quick/target";
import {
  HOST_KEY_CHANGED_OUTPUT,
  ITEM_NOT_FOUND,
  LONG_BOX,
  LONG_NAME_OPEN,
  LONG_PATH,
  WORST_BINDINGS,
  WORST_START_PROBLEM,
  WORST_VAULT_MESSAGE,
  hostKeyCheck,
  oneHost,
  worstCaseFolders,
  worstCaseHosts,
  worstCaseSessions,
} from "./worstCase";

export interface FakeScenario {
  hosts: HostList;
  /** connect() fails with this (every time, unless `failOnce`). */
  startProblem?: BackendProblem;
  failOnce?: boolean;
  /** Milliseconds every call waits, to see loading states. */
  delay?: number;
  /** How long `openSession` takes (session.prepare and starting ssh), in ms; else `delay`. */
  sessionDelay?: number;
  /** How long a Session takes to log in (its shell's first output), in ms (issue #78). */
  loginMs?: number;
  /** Where the vault starts (default: locked, like a fresh `roster serve`). `database`: KeePassXC's
   * .kdbx is at this path on the Box and roster.yml names none, so the vault is usable only once
   * `vault.configure` names it (init.lua, ticket 41). */
  vault?: { status: VaultStatusWord; provider?: "bw" | "kp"; database?: string };
  /** Every openSession() is refused with this (like a box roster hasn't set up: code 21). */
  sessionRefusal?: Refusal;
  /** Sessions to password-only Hosts are refused with this (their vault: 11, 12 or 14). */
  passwordRefusal?: Refusal;
  /** Per Host: `session.prepare` refuses with this (a Login's codes 30-35, roster.yml's 1). */
  refusals?: Record<string, Refusal>;
  /** Per Host: ssh prints this into the PTY and exits 255 (a refused port, a changed key…). */
  sshFailures?: Record<string, string>;
  /** Per Host: what `host.check` answers (default: every step ok). */
  checks?: Record<string, HostCheck>;
  /** `box.check`'s checks (default: HEALTHY_BOX, every one ok). */
  boxChecks?: HealthCheck[];
  /** `inventory.info`'s api_version (default 2; editing needs 5). */
  apiVersion?: number;
  /** Ticket 10: `inventory.pull` refuses with this (62 diverged, 63 offline…). */
  pullRefusal?: Refusal;
  /** Decision Q88: how long `inventory.pull` takes, in ms (else `delay`). */
  pullDelay?: number;
  /** Decision Q88: someone published meanwhile. The next pull brings `commits` commits that
   * change these Hosts' fields, once. */
  pullBrings?: { commits: number; changes: Record<string, HostChanges> };
  /** Per Host: what `host.verify_login` answers (default: every step ok). */
  verifyResults?: Record<string, HostCheck>;
  /** Ticket 36: Hosts whose host key roster hasn't recorded: `session.prepare` refuses with 44 until
   * `host.trust_key` records it. `changesOnTrust`: the Host offers another key by then (23);
   * `unreachable`: fetching the key times out (42); `recordedAs`: a key got recorded meanwhile
   * ("changed": another one, so ssh then refuses it as row 13). */
  unknownKeys?: Record<string, { changesOnTrust?: boolean; unreachable?: boolean; recordedAs?: "match" | "changed" }>;
  /** Ticket 14: Quick Connect boxes by address. Any address answers `host.scan_key` with an
   * unrecorded ed25519 key (`scanKeys` changes that, e.g. `recorded: "changed"`, which
   * `quick.prepare` then refuses with 43) and takes FAKE_HOST_PASSWORD for any user, or no password
   * (this Box's keys). `changesOnConnect`: the box offers another key by `quick.prepare` (23);
   * `unreachable`: it doesn't answer (42). */
  quickBoxes?: Record<string, { changesOnConnect?: boolean; unreachable?: boolean; hostname?: string }>;
  /** Vault item names already there ("Save to vault" refuses them: 60). */
  vaultItems?: string[];
  /** Ticket 11: per address, what `host.scan_key` answers (default: an unrecorded ed25519 key). */
  scanKeys?: Record<string, Partial<ScannedKey>>;
  /** Per new Host name: what `host.add`'s test login answers (default: ok when the typed password
   * is FAKE_HOST_PASSWORD, or an existing item is named). */
  addVerify?: Record<string, HostCheck>;
  /** host.add and changes.publish do their work, then answer like a call the app stopped waiting for. */
  lateAnswers?: boolean;
  /** host.add's `warnings` by Host name: what failed after the Host was written. */
  addWarnings?: Record<string, string[]>;
  /** Edits already made on this Box when the app starts (Pending changes), per Host. */
  pending?: Record<string, HostChanges>;
  /** Ticket 12: `changes.publish` refuses with this (82 someone else published, 86 push rejected…). */
  publishRefusal?: Refusal;
  /** Ticket 12: the Publish works, but the `roster sync` after it fails with this. */
  publishSyncError?: string;
  /** The vault locks itself again this many ms after each unlock (bw's own timeout, another
   * roster command), so the next password Session meets code 14. */
  relockAfterMs?: number;
  /** `vault.unlock` with the right password takes `completesAfterMs`, but the call gives up
   * after `failAfterMs` (roster-core's timeout) while serve carries on and unlocks anyway. Like
   * serve, the fake then answers vault calls in order, so later ones wait for that unlock. */
  slowUnlock?: { failAfterMs: number; completesAfterMs: number };
  /** The account `vault.login` signs in to, when the vault is `not-logged-in` (ticket 31). Without
   * it, `vault.status` has no `sign_in` (a roster older than api 3). */
  signIn?: FakeAccount;
  /** Ticket 35 (API 10): where the vault can save (default: the personal vault only), and roster.yml's
   * `save_to` (default: none, so the personal vault). init.lua's, sent with vault.configure, wins. */
  saveTo?: { targets: SaveTarget[]; setting?: SaveTo };
  /** `connect()`'s answer, where it differs from the default (a long Box name, path, distro). */
  info?: { backend?: string; box?: string; path?: string; command?: string[] };
  /** The not-logged-in or missing-cli message, where it differs from roster's usual one. */
  vaultMessage?: string;
  /** Every Session's shell prints a busy log at this many lines a second once it has logged in, like
   * app/scripts/perf/serve.py's: the perf fixture (docs/app/performance.md). */
  stream?: number;
  /** Each Session repaints its screen when resized, as ConPTY does on Windows (ticket 73): home,
   * its last rows again, each cleared to its end. */
  repaints?: boolean;
  /** Plugin folders by path (ticket 23): `:plugins install PATH` finds them here. */
  plugins?: Record<string, FakePlugin>;
  /** Packages (ticket 24): what init.lua names, the repos' versions and roster.lock. */
  packages?: FakePackages;
  /** What the app shows at start beyond the Backend (the dev page reads these; tests pass them
   * as props): the State file's contents, and Hosts to open Sessions to once connected. */
  app?: {
    state?: Record<string, unknown>;
    openAtStart?: readonly string[];
    /** Key bindings a Plugin or init.lua would add (the Key bindings panel's worst case). */
    bindings?: { source: string; tables: KeymapOverrides };
  };
}

/** Two-step methods an account can have; bw's CLI can't do webauthn (FIDO2) or duo. */
export type FakeMethodKind = "authenticator" | "email" | "yubikey" | "webauthn" | "duo";

export interface FakeAccount {
  methods?: FakeMethodKind[];
  /** Bitwarden asks for the new-device email code (accounts without two-step login). */
  newDevice?: boolean;
  /** How SSO ends in the browser, after `ssoMs` (default ok, 300 ms). */
  sso?: "ok" | "fail";
  ssoMs?: number;
  /** Every start is refused with this (52 rate limited, 53 unreachable…). */
  refuse?: Refusal;
  /** What `bw config server` says (null: bitwarden.com). */
  server?: string | null;
}

/** The fake account's email, two-step / new-device code and API key (type them in a plain browser). */
export const FAKE_EMAIL = "you@example.com";
export const FAKE_CODE = "123456";
export const FAKE_API_KEY = { id: "user.fake-client", secret: "fake-client-secret" };

export interface Refusal {
  code: number;
  message: string;
  data?: CallErrorData;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const refuse = (r: Refusal) => new BackendCallError(r.message, r.code, r.data ?? null);

/** A `host.check` answer with every step ok (a key Host's provider and vault-item skipped). */
export function passingCheck(host: Host): HostCheck {
  const password = authOf(host) === "password";
  return {
    host: host.name,
    ok: true,
    steps: CHECK_STEPS.map((step) =>
      !password && (step === "provider" || step === "vault-item")
        ? { step, status: "skipped" as const, message: "key login" }
        : { step, status: "ok" as const, message: `${step} is fine` },
    ),
  };
}

/** `box.check` on a Box with nothing wrong. */
export const HEALTHY_BOX: readonly HealthCheck[] = [
  { section: "roster", level: "ok", message: "roster 0.1.0, serve API 16, Python 3.12.7" },
  { section: "inventory", level: "ok", message: "roster.yml loads: /home/you/infra/roster.yml (12 Hosts, 3 groups)" },
  { section: "ssh", level: "ok", message: "ssh found: /usr/bin/ssh" },
  { section: "ssh", level: "ok", message: "roster's ssh config has every Host: /home/you/.ssh/config.d/roster" },
  { section: "ssh", level: "ok", message: "roster's known hosts has every Host's key: /home/you/.ssh/roster_known_hosts" },
  { section: "vault", level: "ok", message: "bw (12 Logins): logged in as you@example.com, locked; it asks for the master password when a Login needs it" },
  { section: "askpass", level: "ok", message: "the askpass channel is open" },
  { section: "repo", level: "ok", message: "clean: /home/you/infra" },
];

/** `box.check` with a vault CLI that isn't logged in, a Host since the last sync, and Pending changes. */
export const UNHEALTHY_BOX: readonly HealthCheck[] = [
  ...HEALTHY_BOX.slice(0, 3),
  { section: "ssh", level: "warn", message: "1 Host not in roster's ssh config yet: nas-01", fix: "run `roster sync`", topic: "E2" },
  HEALTHY_BOX[4] as HealthCheck,
  {
    section: "vault",
    level: "error",
    message: "bw (12 Logins): Bitwarden CLI isn't logged in on this box - run `bw login` once",
    fix: "sign in from the app's lock screen, or in a terminal",
    topic: "E6",
  },
  HEALTHY_BOX[6] as HealthCheck,
  {
    section: "repo",
    level: "warn",
    message: "2 Pending changes to roster.yml, not published yet",
    fix: "`:publish` in the app sends them, `:discard` drops them",
    topic: ":publish",
  },
];

/** ssh failing: its message in the PTY, then exit 255 (as a refused port or a changed key do). */
function failingSession(id: number, auth: SessionAuth, output: string, events: SessionEvents): SessionHandle {
  setTimeout(() => {
    events.output(encode(output));
    events.exit({ code: 255, closed: false });
  }, 0);
  const done = async () => {};
  return { id, auth, write: done, resize: done, close: done };
}

/** The fake vault's master password (type it on the lock screen in a plain browser). */
export const FAKE_PASSWORD = "correct horse";

// roster's own wording (roster/src/roster/providers).
const NOT_LOGGED_IN = "Bitwarden CLI isn't logged in on this box - run `bw login` once";
const MISSING_CLI = "`bw` is not installed on this box (install the Bitwarden CLI, e.g. `npm install -g @bitwarden/cli`)";
const WRONG_PASSWORD = "Bitwarden unlock failed (wrong master password?)";
const VAULT_LOCKED = "Bitwarden vault is locked - unlock it first";
/** The same, from the KeePassXC provider (ticket 25): a local .kdbx, so "not logged in" is a missing database. */
const KP_WORDS = {
  notLoggedIn: "KeePassXC database /home/you/roster.kdbx isn't there - create it in KeePassXC, or fix providers: kp: database: in roster.yml",
  missingCli: "`keepassxc-cli` is not installed on this box (KeePassXC, a local .kdbx: … Install: https://keepassxc.org/download/)",
  wrongPassword: "KeePassXC unlock failed (wrong master password?)",
};

/** Like roster: a Host that doesn't enroll a key and whose ssh Login is a vault reference. */
export function authOf(h: Host): SessionAuth {
  return !h.enroll && !["agent", "key", "none"].includes(h.ssh.auth) ? "password" : "key";
}

/** `list` with its first reviewed Host's Login turned into `auth: prompt` (ticket 16). */
export function withPromptHost(list: HostList): HostList {
  const first = list.hosts.find((h) => h.reviewed)?.name;
  return {
    ...list,
    hosts: list.hosts.map((h) => (h.name === first ? { ...h, enroll: false, ssh: { ...h.ssh, user: "root", auth: "prompt" } } : h)),
  };
}

const TYPES = ["linux", "esxi", "proxmox", "switch", "router", "windows", "printer", "nas"];
const PRODUCTS = ["", "", "ALPHA", "HUB", "BRAVO", "UniFi"];

/** A service as roster resolves it (Host details, ticket 18): the Host's default Login unless
 * `own` gives it one of its own. */
export function service(ip: string, port: number, scheme: "http" | "https" | null, login: Host["login"], own?: { user: string; auth: string }): Service {
  const url = scheme ? `${scheme}://${ip}${port === (scheme === "https" ? 443 : 80) ? "" : `:${port}`}` : null;
  return {
    port,
    url,
    scheme,
    user: own?.user ?? login?.user ?? null,
    auth: own?.auth ?? login?.auth ?? null,
    verify: true,
    login: "basic",
    override: own !== undefined,
  };
}

/** Made-up services by type, as a discover scan and a team would give them: none on a plain
 * Linux box, a web UI on most others, and a NAS with a web UI, an admin UI of its own and SMB. */
function servicesFor(type: string, name: string, ip: string): Pick<Host, "services" | "login" | "web"> {
  const login = { user: "admin", auth: `bw:${name} web` };
  const svc = (port: number, scheme: "http" | "https" | null, own?: { user: string; auth: string }) => service(ip, port, scheme, login, own);
  const services: Record<string, Service> =
    type === "esxi" || type === "router" || type === "switch"
      ? { web: svc(443, "https") }
      : type === "proxmox"
        ? { web: svc(8006, "https") }
        : type === "printer"
          ? { web: svc(80, "http") }
          : type === "nas"
            ? { web: svc(443, "https"), admin: svc(5001, "https", { user: "nasadmin", auth: `bw:${name} admin` }), smb: svc(445, null) }
            : {};
  const web = services.web?.url ?? null;
  return { services, login: Object.keys(services).length ? login : { user: null, auth: null }, web };
}

/** `n` made-up Hosts across a few subnets; every seventh one unreviewed (like a discover scan). */
export function makeHosts(n: number): HostList {
  const hosts: Host[] = Array.from({ length: n }, (_, i) => {
    const subnet = (i % 4) + 1;
    const type = TYPES[i % TYPES.length] ?? "linux";
    return {
      name: `${type}-${subnet}-${String(i).padStart(3, "0")}`,
      group: `subnet-${subnet}`,
      ip: `10.19.${subnet}.${(i % 250) + 2}`,
      type,
      product: PRODUCTS[i % PRODUCTS.length] ?? "",
      title: i % 5 === 0 ? `${type} box ${i} in rack ${subnet}` : "",
      description: "",
      reviewed: i % 7 !== 3,
      enroll: i % 3 !== 0,
      ssh: { user: "admin", port: 22, auth: i % 3 === 0 ? `bw:${type}-${i} ssh` : "key" },
      ...servicesFor(type, `${type}-${subnet}-${String(i).padStart(3, "0")}`, `10.19.${subnet}.${(i % 250) + 2}`),
    };
  });
  const groups = Object.fromEntries(
    [1, 2, 3, 4].map((s) => [`subnet-${s}`, { title: `10.19.${s}.0/24`, description: "" }]),
  );
  return { hosts, groups };
}

/** Every Host's key unrecorded (ticket 36's fixtures). */
function unknownKeysOf(list: HostList, how: NonNullable<FakeScenario["unknownKeys"]>[string] = {}) {
  return Object.fromEntries(list.hosts.map((h) => [h.name, how]));
}

const problem = (kind: BackendProblem["kind"], message: string, hint: string, detail: string | null = null) => ({
  kind,
  message,
  hint,
  detail,
});

const signingIn = (signIn: FakeAccount): FakeScenario => ({
  hosts: makeHosts(12),
  vault: { status: "not-logged-in" },
  signIn,
});

export const fixtures: Record<string, FakeScenario> = {
  "many-hosts": { hosts: makeHosts(300) },
  "few-hosts": { hosts: makeHosts(12) },
  /** Ticket 10: a roster that can edit and publish (api 7), no Pending changes yet. */
  edit: { hosts: makeHosts(12), apiVersion: 7 },
  /** Ticket 12: the same, under the name the Publish tests use. */
  publish: { hosts: makeHosts(12), apiVersion: 7 },
  /** Ticket 11: a roster that can add Hosts (api 6). The new Host's password is FAKE_HOST_PASSWORD. */
  add: { hosts: makeHosts(12), apiVersion: 6 },
  /** Issue #78: today's roster (api 9), which can also un-review a Host. */
  review: { hosts: makeHosts(12), apiVersion: 9 },
  /** Two Pending changes already made on this Box. */
  "edit-pending": {
    hosts: makeHosts(12),
    apiVersion: 7,
    pending: { "linux-1-000": { title: "Build box", description: "rack 1, top" }, "esxi-2-001": { type: "esxi8" } },
  },
  /** Ticket 12: two Pending changes, and someone else published roster.yml meanwhile. */
  "publish-moved": {
    hosts: makeHosts(12),
    apiVersion: 7,
    pending: { "linux-1-000": { title: "Build box" }, "esxi-2-001": { type: "esxi8" } },
    publishRefusal: {
      code: PublishError.remoteMoved,
      message: "someone published roster.yml to origin/main since this box pulled (1 new commit), so roster won't publish over it",
      data: {
        fix: "discard your Pending changes, :pull, and make them again; or merge in a terminal: git -C /home/you/infra stash && git pull --ff-only && git stash pop",
        upstream: "origin/main",
        behind: 1,
      },
    },
  },
  /** The pull before an edit fails: the branch has diverged. */
  "edit-diverged": {
    hosts: makeHosts(12),
    apiVersion: 7,
    pullRefusal: {
      code: EditError.diverged,
      message: "this box's infra repo and origin/main have diverged (1 local and 2 new commits there), so roster won't pull",
      data: { fix: "merge or rebase in a terminal: git -C /home/you/infra pull --rebase", upstream: "origin/main", ahead: 1, behind: 2 },
    },
  },
  /** As many Hosts as the real Inventory (ticket 17's tree check). */
  "91-hosts": { hosts: makeHosts(91) },
  slow: { hosts: makeHosts(300), delay: 1500 },
  /** Issue #78: Sessions take 1.2 s to start and 2.5 s more to log in, so the connecting state shows. */
  "slow-login": { hosts: makeHosts(12), apiVersion: 9, sessionDelay: 1200, loginMs: 2500 },
  /** Ticket 36: no Host's key is recorded yet, so every first Session asks (fetching takes 0.8 s). */
  "host-key": { hosts: makeHosts(12), apiVersion: 11, delay: 800, unknownKeys: unknownKeysOf(makeHosts(12)) },
  /** Ticket 36: the same, but each Host offers another key by the time it's trusted (row 62). */
  "host-key-changed": {
    hosts: makeHosts(12),
    apiVersion: 11,
    unknownKeys: unknownKeysOf(makeHosts(12), { changesOnTrust: true }),
  },
  /** Ticket 14: Quick Connect (API 12). Any user@address answers with an unrecorded key and takes
   * FAKE_HOST_PASSWORD ("host pass"), or no password; 10.0.0.66 doesn't answer, 10.0.0.43's key
   * differs from the one recorded, 10.0.0.23's changes before the connect. */
  quick: {
    hosts: makeHosts(12),
    apiVersion: 12,
    delay: 600,
    quickBoxes: { "10.0.0.66": { unreachable: true }, "10.0.0.23": { changesOnConnect: true } },
    scanKeys: { "10.0.0.43": { recorded: "changed" } },
  },
  /** Ticket 15: Quick Connect with "Save to vault" (API 13). 10.0.0.5's shell names it nas-01 (its
   * window title, which pre-fills the Host's name); a vault item "dup ssh" is already there. */
  "quick-save": {
    hosts: makeHosts(12),
    apiVersion: 13,
    delay: 300,
    loginMs: 800,
    quickBoxes: { "10.0.0.5": { hostname: "nas-01" }, "10.0.0.66": { unreachable: true } },
    vaultItems: ["dup ssh"],
  },
  /** Ticket 16: the first Host's Login is still `auth: prompt` (API 13): its Session asks for the
   * password (`host pass`) with the Save to vault tick. */
  "prompt-save": { hosts: withPromptHost(makeHosts(12)), apiVersion: 13, delay: 300, loginMs: 800 },
  "roster-too-old": {
    hosts: makeHosts(0),
    startProblem: problem(
      "roster-too-old",
      "This roster has no `serve` command (it predates the roster app).",
      "Upgrade roster (`uv tool install --force --reinstall .` in the roster repo), or point ROSTER_APP_ROSTER at a newer one, e.g. `uv run --project /home/you/work/roster roster`.",
      "roster: error: argument cmd: invalid choice: 'serve' (choose from init, setup, sync, ...)",
    ),
  },
  "roster-missing": {
    hosts: makeHosts(0),
    startProblem: problem(
      "roster-missing",
      "`roster` wasn't found in any WSL distro (searched: FedoraLinux-44, OracleLinux_9).",
      "Install roster so it's on PATH, or set ROSTER_APP_ROSTER to the command that runs it.",
    ),
  },
  "inventory-missing": {
    hosts: makeHosts(0),
    startProblem: problem(
      "inventory-not-found",
      "roster couldn't load the Inventory: no roster.yml found here or in ~/.config/roster/",
      "Clone the infra repo to ~/infra (or set ROSTER_CONFIG in ~/.profile), then retry.",
    ),
  },
  locked: { hosts: makeHosts(12) },
  "not-logged-in": { hosts: makeHosts(12), vault: { status: "not-logged-in" } },
  "missing-cli": { hosts: makeHosts(12), vault: { status: "missing-cli" } },
  "no-vault": { hosts: makeHosts(12), vault: { status: "unsupported" } },
  /** KeePassXC (ticket 25): a local .kdbx instead of Bitwarden. */
  keepassxc: { hosts: makeHosts(12), vault: { status: "locked", provider: "kp" } },
  "keepassxc-no-database": { hosts: makeHosts(12), vault: { status: "not-logged-in", provider: "kp" } },
  "not-set-up": {
    hosts: makeHosts(12),
    sessionRefusal: {
      code: SessionRefusal.notSetUp,
      message:
        "linux-1-000 isn't in this box's ssh config (~/.ssh/config.d/roster) - run `roster sync`, or `roster setup` if this box isn't set up yet",
    },
  },
  "vault-relocks": { hosts: makeHosts(12), relockAfterMs: 5000 },
  /** Sign-in (ticket 31): a new Box, so Bitwarden asks for the new-device code. */
  "sign-in": signingIn({ newDevice: true }),
  "sign-in-2fa": signingIn({ methods: ["authenticator", "email", "yubikey", "webauthn"] }),
  "sign-in-totp": signingIn({ methods: ["authenticator"] }),
  "sign-in-fido2": signingIn({ methods: ["webauthn"] }),
  "sign-in-sso": signingIn({ sso: "ok", ssoMs: 2500 }),
  "sign-in-eu": signingIn({ server: "https://vault.bitwarden.eu" }),
  /** Ticket 42 (API 14): a locked Bitwarden signed in as you@example.com; "Use a different account"
   * and `:vault signout` sign it out, and the sign-in form takes the same fake account. */
  "sign-out": { hosts: makeHosts(12), apiVersion: SIGN_OUT_API_VERSION },
  /** Ticket 49 (API 16): `:check` with no Host shows this Box's health, with an error and two warnings. */
  health: { hosts: makeHosts(12), apiVersion: BOX_CHECK_API_VERSION, boxChecks: [...UNHEALTHY_BOX] },
  "sign-in-rate-limited": signingIn({
    refuse: {
      code: SignInError.rateLimited,
      message: "bitwarden.com refused: too many sign-in attempts - wait a few minutes, then try again",
    },
  }),
  "worst-case": worstCase(),
  /** Measuring (docs/app/performance.md): the worst case's 1,284 Hosts, no vault, and `&sessions=N`
   * Sessions (default 12) whose shells print `&rate=R` log lines a second (default 100). */
  perf: perfCase(),
  /** No Hosts at all: every empty state. */
  "worst-case-empty": { hosts: { hosts: [], groups: {} }, info: { box: LONG_BOX, path: LONG_PATH } },
  /** One Host, one Session, one Folder: every count at 1. */
  "worst-case-one": {
    hosts: oneHost(),
    app: { state: { folders: [{ name: "x", hosts: [LONG_NAME_OPEN] }] }, openAtStart: [LONG_NAME_OPEN] },
  },
  /** The Backend couldn't start, with a long message, hint and detail. */
  "worst-case-start": { hosts: makeHosts(0), startProblem: WORST_START_PROBLEM },
  /** The lock screen's longest message: the vault CLI isn't logged in. */
  "worst-case-vault": { ...worstCase(), vault: { status: "not-logged-in" }, vaultMessage: WORST_VAULT_MESSAGE },
  "no-wsl": {
    hosts: makeHosts(0),
    startProblem: problem("no-wsl", "No WSL distro was found.", "Install WSL and a Linux distro with roster in it."),
  },
};

/** The worst case (ticket 27): every long, short, odd, missing and huge value at once. */
function worstCase(): FakeScenario {
  const hosts = worstCaseHosts();
  return {
    hosts,
    info: {
      backend: "WSL: FedoraLinux-44",
      box: LONG_BOX,
      path: LONG_PATH,
      command: ["wsl.exe", "-d", "FedoraLinux-44", "--exec", "/home/aleksandra.wisniewska-kowalczyk/.local/bin/roster", "-c", LONG_PATH, "serve"],
    },
    refusals: { "vault-item-missing": ITEM_NOT_FOUND },
    sshFailures: { "host-key-changed-esxi-rack-b-u42-management-interface": HOST_KEY_CHANGED_OUTPUT },
    checks: Object.fromEntries(
      [LONG_NAME_OPEN, "host-key-changed-esxi-rack-b-u42-management-interface"].map((h) => [h, hostKeyCheck(h)]),
    ),
    app: {
      state: {
        folders: worstCaseFolders(hosts),
        recentHosts: [LONG_NAME_OPEN, "x", "🦊-fox-lab", "خادم-الإنتاج-٠١"],
      },
      openAtStart: worstCaseSessions(hosts),
      bindings: WORST_BINDINGS,
    },
  };
}

/** The perf fixture: see `fixtures.perf`. */
function perfCase(search: string = globalThis.location?.search ?? ""): FakeScenario {
  const params = new URLSearchParams(search);
  const hosts = worstCaseHosts();
  const count = Number(params.get("sessions") ?? 12);
  const open = hosts.hosts.filter((h) => h.reviewed && authOf(h) === "key").slice(0, count).map((h) => h.name);
  return {
    hosts,
    vault: { status: "unsupported" },
    stream: Number(params.get("rate") ?? 100),
    app: { state: {}, openAtStart: open },
  };
}

export function fixtureFromUrl(search: string = globalThis.location?.search ?? ""): FakeScenario {
  const name = new URLSearchParams(search).get("fixture") ?? "many-hosts";
  return fixtures[name] ?? { hosts: makeHosts(300) };
}

const encode = (s: string) => new TextEncoder().encode(s);

/** A busy log, `rate` lines a second in bursts every 50 ms (app/scripts/perf/serve.py's, for the
 * perf fixture). Returns the interval. */
function streamLog(rate: number, write: (text: string) => void): ReturnType<typeof setInterval> {
  let n = 0;
  const perTick = Math.max(1, Math.round(rate / 20));
  return setInterval(() => {
    let text = "";
    for (let i = 0; i < perTick; i++) {
      n++;
      text += `\x1b[2m${String(n).padStart(8, "0")}\x1b[0m \x1b[32mINFO\x1b[0m worker-${String(n % 16).padStart(2, "0")} handled request ${n} in ${n % 97} ms path=/api/v1/items/${n % 5000} status=200 bytes=${(n * 7) % 65536}\r\n`;
    }
    write(text);
  }, 50);
}

/** The logged-in fake Sessions a test can make print (`FakeBackend.print`). */
type Printers = Set<{ host: string; say(text: string): void }>;

/** A pretend shell: a banner and a prompt, echoes what you type (Esc as `^[`), `exit` ends it. */
function fakeSession(
  id: number,
  host: string,
  auth: SessionAuth,
  size: TermSize,
  events: SessionEvents,
  loginMs = 0,
  extra: { onLogin?: () => void; title?: string; stream?: number | undefined; printers?: Printers; repaints?: boolean | undefined } = {},
): SessionHandle {
  // What it printed, without escapes, for a ConPTY-style repaint.
  let screen = "";
  const out = (bytes: Uint8Array) => {
    // eslint-disable-next-line no-control-regex
    if (extra.repaints) screen = (screen + new TextDecoder().decode(bytes).replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\r/g, "")).slice(-8000);
    events.output(bytes);
  };
  const repaint = (s: TermSize) => {
    const rows = screen.split("\n").slice(-s.rows);
    events.output(encode(`\x1b[?25l\x1b[H${rows.map((r) => `${r}\x1b[K`).join("\r\n")}\x1b[?25h`));
  };
  let line = "";
  let ended = false;
  let streaming: ReturnType<typeof setInterval> | undefined;
  // Whether the cursor sits right after the prompt: what the box prints then (a log, `wall`)
  // starts on a line of its own, and the prompt comes back after it, as in a real shell.
  let atPrompt = false;
  const printer = {
    host,
    say: (text: string) => {
      out(encode(atPrompt ? `\r\n${text}` : text));
      atPrompt = text.endsWith("\n");
      if (atPrompt) out(encode(prompt));
    },
  };
  const end = (code: number | null, closed: boolean) => {
    if (ended) return;
    ended = true;
    extra.printers?.delete(printer);
    clearInterval(streaming);
    setTimeout(() => events.exit({ code, closed }), 0);
  };
  const prompt = `${host}$ `;
  // Like ssh, nothing is printed until the Host answers (the login takes `loginMs`).
  let loggedIn = false;
  let resized: TermSize | null = null;
  const sayResized = (s: TermSize) => out(encode(`[resized to ${s.cols}x${s.rows}]`));
  setTimeout(() => {
    loggedIn = true;
    extra.onLogin?.();
    // A shell that names its box in the window title, as most Linux prompts do (OSC 0).
    if (extra.title) out(encode(`\x1b]0;${extra.title}\x07`));
    out(encode(`Connected to ${host} (fake, ${size.cols}x${size.rows})\r\n${prompt}`));
    atPrompt = true;
    if (resized && !ended) sayResized(resized);
    if (extra.stream && !ended) streaming = streamLog(extra.stream, (text) => out(encode(text)));
    if (!ended) extra.printers?.add(printer);
  }, loginMs);
  return {
    id,
    auth,
    async write(data) {
      if (ended) throw new BackendCallError(`session ${id} isn't open`);
      for (const ch of data) {
        if (ch === "\r") {
          out(encode("\r\n"));
          if (line.trim() === "exit") return end(0, false);
          line = "";
          out(encode(prompt));
          atPrompt = true;
        } else {
          line += ch;
          atPrompt = false;
          out(encode(ch === "\x1b" ? "^[" : ch));
        }
      }
    },
    async resize(s) {
      if (ended) return;
      if (loggedIn && extra.repaints) repaint(s);
      else if (loggedIn) sayResized(s);
      else resized = s;
    },
    async close() {
      end(null, true);
    },
  };
}

const BACKUP = "~/infra/.git/roster/roster.yml.bak";

function unknownGroup(group: string, groups: Record<string, unknown>) {
  return new BackendCallError(`no group named '${group}' in roster.yml (groups: ${Object.keys(groups).join(", ")})`, LiveError.unknownGroup, {
    group,
    fix: "pick one of the groups, or make it first (group.new)",
  });
}

/** A `host.verify_login` answer with every step ok. */
export function passingVerify(host: string): HostCheck {
  return { host, ok: true, steps: VERIFY_STEPS.map((step) => ({ step, status: "ok" as const, message: `${step} is fine` })) };
}

/** The password the fake's new Hosts take (`host.add` with a typed password). */
export const FAKE_HOST_PASSWORD = "host pass";
export const FAKE_FINGERPRINT = "SHA256:q0Wn8mHc6Yb2kZf1lJx7vQeT4rA9sD3uG5hP2wE8cNo";
/** The key a Host offers after it changed (ticket 36's `changesOnTrust`). */
export const FAKE_OTHER_FINGERPRINT = "SHA256:Zk3pLx9qWe7Rt5Yu1Io8Pa2Sd6Fg4Hj0Kl3Zx7Cv9Bn";

/** A failed `host.verify_login`-shaped answer: `step` fails with `code`, the rest are skipped. */
export function failingVerify(host: string, step: string, code: number, message: string, fix?: string): HostCheck {
  const at = VERIFY_STEPS.indexOf(step as (typeof VERIFY_STEPS)[number]);
  return {
    host,
    ok: false,
    steps: VERIFY_STEPS.map((s, i) =>
      i < at
        ? { step: s, status: "ok" as const, message: `${s} is fine` }
        : i === at
          ? { step: s, status: "fail" as const, code, message, ...(fix ? { fix } : {}) }
          : { step: s, status: "skipped" as const, message: "an earlier step failed" },
    ),
  };
}

export const fieldsOf = (h: Host): HostFields => ({
  title: h.title,
  description: h.description,
  type: h.type,
  ip: h.ip,
  user: h.ssh.user,
  port: h.ssh.port,
  auth: h.ssh.auth,
});

const withFields = (h: Host, c: HostChanges): Host => {
  const f = { ...fieldsOf(h), ...c };
  return { ...h, title: f.title, description: f.description, type: f.type, ip: f.ip, ssh: { user: f.user, port: f.port, auth: f.auth } };
};

/** A unified diff of the fields that differ, as git would show a block-style Host in roster.yml. */
function fakeDiff(before: Host[], after: Host[]): string {
  const old = new Map(before.map((h) => [h.name, fieldsOf(h)]));
  const hunks: string[] = [];
  after.forEach((h, i) => {
    const a = old.get(h.name);
    const b = fieldsOf(h);
    if (!a) {
      const body = [`+      ${h.name}:`, `+        ip: ${h.ip}`, `+        user: ${h.ssh.user}`, `+        auth: ${h.ssh.auth}`,
        ...(h.reviewed ? [] : ["+        reviewed: false"])];
      const start = 10 + i * 6;
      hunks.push(`@@ -${start},0 +${start},${body.length} @@ ${h.group}:`, ...body);
      return;
    }
    const keys = (Object.keys(b) as (keyof HostFields)[]).filter((k) => a[k] !== b[k]);
    if (keys.length === 0) return;
    const line = (k: keyof HostFields, v: string | number) => `        ${k}: ${v === "" ? '""' : v}`;
    const body = [
      `       ${h.name}:`,
      ...keys.flatMap((k) => [...(a[k] === "" ? [] : [`-${line(k, a[k])}`]), ...(b[k] === "" ? [] : [`+${line(k, b[k])}`])]),
    ];
    const start = 10 + i * 6;
    hunks.push(`@@ -${start},${body.length} +${start},${body.length} @@ ${h.group}:`, ...body);
  });
  return hunks.length ? ["diff --git a/roster.yml b/roster.yml", "--- a/roster.yml", "+++ b/roster.yml", ...hunks, ""].join("\n") : "";
}

/** The hash of every commit the fake Publishes. */
export const FAKE_COMMIT = "3f9c2a7d41e8b05c6a9f12d3e4b5a6c7d8e9f012";

/** roster's generated message (changes.commit_message): a subject naming each change, or, past 72
 * characters, the count with one line per change below. */
export function commitMessage(hosts: readonly HostChange[]): string {
  const items = hosts.map((h) =>
    h.change === "changed" ? `change ${h.host} (${h.fields.join(", ")})` : `${h.change === "added" ? "add" : "remove"} ${h.host}`,
  );
  if (items.length === 0) return "roster: edit roster.yml";
  const subject = `roster: ${items.join(", ")}`;
  if (subject.length <= 72) return subject;
  return `roster: change ${hosts.length} Host${hosts.length === 1 ? "" : "s"}\n\n${items.map((i) => `- ${i}`).join("\n")}`;
}

/** The fake, plus what a test does from outside the app: edit roster.yml as an editor would. */
export interface FakeBackend extends Backend {
  /** roster.yml saved outside the app: new Hosts and groups, or a file that doesn't load. serve's
   * watcher then applies it (auto) or only reports it, as `inventory.changed`. */
  outsideEdit(next: HostList | { error: InventoryFileError }): void;
  /** Whether `inventory.watch` asked to apply outside edits (null: not watching). */
  watching(): boolean | null;
  /** What `vault.configure` was last sent (null: never). */
  vaultSettings(): VaultSettings | null;
  /** Every `host.add` so far, without its password. */
  adds(): Omit<AddHostParams, "password">[];
  /** Every `quick.prepare` so far (ticket 14): where, and whether a password came with it (never
   * the password itself). */
  quickConnects(): (QuickConnect & { password: boolean })[];
  /** Every `quick.prepare` that asked to save (ticket 15), by held id, and every `quick.save` and
   * `vault.forget_typed` so far. */
  held(): string[];
  quickSaves(): QuickSaveParams[];
  forgotten(): string[];
  /** Every logged-in Session to `host` prints `text`, as its server would (ticket 56: scripted
   * output for the Plugins that read the terminal). Gives how many printed it. */
  print(host: string, text: string): number;
}

const NAME = /^[A-Za-z0-9._-]+$/;

export function fakeBackend(scenario: FakeScenario): FakeBackend {
  let failures = 0;
  const printers: Printers = new Set();
  const { plugin: packagePlugin, ...packageHost } = fakePackageHost(scenario.packages ?? { named: [], lock: {} }, described);
  // ---- the Inventory as committed, and as edited on this Box (ticket 10)
  let committed = scenario.hosts.hosts;
  let hosts = committed.map((h) => (scenario.pending?.[h.name] ? withFields(h, scenario.pending[h.name] ?? {}) : h));
  const verified = new Set<string>();
  /** `pullBrings` came in already. */
  let pulledIn = false;
  const loginKey = (name: string, f: HostFields) => JSON.stringify([name, f.ip, f.user, f.port, f.auth]);
  let groups = scenario.hosts.groups;
  let committedGroups = groups;
  // ---- the Live Inventory (ticket 28): the watch, and an outside edit not applied yet
  let watchAuto: boolean | null = null;
  let onDisk: HostList | { error: InventoryFileError } | null = null;
  let broken: InventoryFileError | null = null;
  const changeWatchers = new Set<(c: InventoryChanged) => void>();
  const applyDisk = () => {
    if (!onDisk) return;
    if ("error" in onDisk) broken = onDisk.error;
    else {
      broken = null;
      hosts = onDisk.hosts;
      groups = onDisk.groups;
    }
    onDisk = null;
  };
  const pending = (): PendingChanges => {
    const diff = fakeDiff(committed, hosts);
    const before = new Map(committed.map((h) => [h.name, h]));
    const changed = hosts.flatMap((h): HostChange[] => {
      const old = before.get(h.name);
      if (!old) return [{ host: h.name, change: "added", fields: [] }];
      const a = { ...fieldsOf(old), reviewed: old.reviewed };
      const b = { ...fieldsOf(h), reviewed: h.reviewed };
      const fields = (Object.keys(b) as (keyof typeof b)[]).filter((k) => a[k] !== b[k]);
      return fields.length ? [{ host: h.name, change: "changed", fields }] : [];
    });
    const now = new Set(hosts.map((h) => h.name));
    for (const h of committed) if (!now.has(h.name)) changed.push({ host: h.name, change: "removed", fields: [] });
    const groupChanges: GroupChange[] = [
      ...Object.keys(groups).filter((g) => !(g in committedGroups)).map((group) => ({ group, change: "added" as const })),
      ...Object.keys(committedGroups).filter((g) => !(g in groups)).map((group) => ({ group, change: "removed" as const })),
    ];
    const removedDiff = changed
      .filter((c) => c.change === "removed")
      .map((c) => `@@ -1,1 +0,0 @@\n-      ${c.host}:`)
      .join("\n");
    return {
      path: scenario.info?.path ?? "~/infra/roster.yml",
      repo: "~/infra",
      diff: diff || removedDiff || (groupChanges.length ? groupChanges.map((g) => `${g.change === "added" ? "+" : "-"}  ${g.group}:`).join("\n") : ""),
      hosts: changed,
      groups: groupChanges,
      count: changed.length || (groupChanges.length ? 1 : 0),
      message: commitMessage(changed),
      last_commit: { commit: publishedOnce ? FAKE_COMMIT : "0000000000000000000000000000000000000000", subject: "inventory", upstream: "origin/main", pushed: true },
    };
  };
  let publishedOnce = false;
  /** What the Tauri shell answers for a call it stopped waiting for. */
  const late = () => new BackendCallError("The backend didn't answer in time.", null, null, true, true);
  let vaultWord: VaultStatusWord = scenario.vault?.status ?? "locked";
  const vaultName = scenario.vault?.provider ?? "bw";
  const kp = vaultName === "kp";
  // ---- vault.configure (ticket 41): the KeePassXC database init.lua names, if any
  let settings: VaultSettings | null = null;
  const onBox = scenario.vault?.database;
  const named = () => settings?.kp?.database;
  /** No usable database: roster.yml names none, and init.lua names none or another path. */
  const noDatabase = () => onBox !== undefined && named() !== onBox;
  const noDatabaseWords = () =>
    named()
      ? `KeePassXC database ${named()} isn't there - create it in KeePassXC, or fix vault.kp.database in init.lua`
      : "KeePassXC has no database set on this box - add  providers: {kp: {database: ~/roster.kdbx}}  to roster.yml, or  vault = { kp = { database = \"~/roster.kdbx\" } }  to the app's init.lua";
  /** The vault as roster sees it now. Writes go to `vaultWord`. */
  const vaultNow = (): VaultStatusWord => (noDatabase() && vaultWord !== "missing-cli" ? "not-logged-in" : vaultWord);
  const vaultMessage = () => {
    const vault = vaultNow();
    if (vault === "not-logged-in" && noDatabase()) return noDatabaseWords();
    return vault === "not-logged-in"
      ? (scenario.vaultMessage ?? (kp ? KP_WORDS.notLoggedIn : NOT_LOGGED_IN))
      : vault === "missing-cli"
        ? (scenario.vaultMessage ?? (kp ? KP_WORDS.missingCli : MISSING_CLI))
        : undefined;
  };
  /** Ticket 42: signed out through `vault.logout`; the sign-in form then takes the fake account. */
  let signedOut = false;
  const accountApi = (scenario.apiVersion ?? 2) >= SIGN_OUT_API_VERSION;
  const signInAccount = (): FakeAccount | undefined => scenario.signIn ?? (signedOut ? {} : undefined);
  const vaultStatus = (): VaultStatus => {
    const vault = vaultNow();
    const provider = vault === "unsupported" ? null : vaultName;
    const message = vaultMessage();
    const account = signInAccount();
    const signIn = vault === "not-logged-in" && account
      ? { sign_in: { methods: ["password", "apikey", "sso"] as SignInStart["method"][], server: account.server ?? null } }
      : {};
    const who = accountApi && !kp && (vault === "locked" || vault === "unlocked")
      ? { account: { email: FAKE_EMAIL, server: scenario.signIn?.server ?? null } }
      : {};
    const can = accountApi ? { can_sign_out: !kp && provider !== null } : {};
    const main = { provider, status: vault, ...(message ? { message } : {}), ...signIn, ...who, ...can };
    return { ...main, providers: provider ? [{ ...main, provider }] : [] };
  };
  // ---- vault.targets (ticket 35)
  const PERSONAL: SaveTarget = { id: "personal", kind: "personal", label: "Personal vault", save_to: "personal" };
  const targets = () => scenario.saveTo?.targets ?? [PERSONAL];
  const fits = (want: SaveTo, t: SaveTarget) => {
    if (want === "personal" || t.save_to === "personal") return want === t.save_to;
    if ("group" in want) return t.kind === "group" && t.label === want.group;
    if ("group" in t.save_to) return false;
    const ids = t.save_to;
    return (
      [t.organization, ids.organization].includes(want.organization) && [t.collection, ids.collection].includes(want.collection)
    );
  };
  const targetFor = (want: SaveTo) => targets().find((t) => fits(want, t)) ?? null;
  const defaultSetting = (): { setting: SaveTo; from: SaveTargets["from"] } =>
    settings?.save_to
      ? { setting: settings.save_to, from: "init.lua" }
      : scenario.saveTo?.setting
        ? { setting: scenario.saveTo.setting, from: "roster.yml" }
        : { setting: "personal", from: null };
  const unknownTarget = (field: string) =>
    new BackendCallError(`no Bitwarden collection like that you can save to - fix ${field}`, SaveToError.unknownTarget, {
      fix: "fix the setting the message names, or pick where to save it",
    });
  const added: Omit<AddHostParams, "password">[] = [];
  let sessions = 0;
  const quick: (QuickConnect & { password: boolean })[] = [];
  // ---- "Save to vault" after a Session's own login (tickets 15, 16)
  /** Typed passwords serve holds, by id: whether that Session logged in with it, and for what. */
  const holding = new Map<string, { loggedIn: boolean; to?: QuickConnect; host?: string }>();
  const heldIds: string[] = [];
  const saves: QuickSaveParams[] = [];
  const forgets: string[] = [];
  const loginWatchers = new Set<(held: string) => void>();
  let items = [...(scenario.vaultItems ?? [])];
  const loggedIn = (held: string) => {
    const h = holding.get(held);
    if (!h) return;
    h.loggedIn = true;
    for (const w of loginWatchers) w(held);
  };
  /** Hosts whose key `host.trust_key` recorded (ticket 36). */
  const keysTrusted = new Set<string>();
  const knownHost = (host: string) => {
    const h = hosts.find((x) => x.name === host);
    if (!h) throw new BackendCallError(`unknown host '${host}'`, SessionRefusal.unknownHost);
    return h;
  };
  /** host.scan_key / host.trust_key at an address that doesn't answer (roster's 42). */
  const unanswered = (h: Host) =>
    new BackendCallError(`${h.name} (${h.ip}:${h.ssh.port}) didn't answer within 5 s`, 42, {
      fix: "retry later; is the Host up and the network path open? On 10.19.x the SSH rate limiter stops answering for about 4 minutes after many connections: wait a few minutes, don't retry in a loop",
      details: "timed out",
    });
  const wait = () => new Promise((r) => setTimeout(r, scenario.delay ?? 0));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** serve answers one request at a time: vault calls queue behind a slow unlock. */
  let serveBusy: Promise<unknown> = Promise.resolve();
  const inOrder = <T>(job: () => Promise<T>): Promise<T> => {
    const run = serveBusy.then(job, job);
    serveBusy = run.catch(() => {});
    return run;
  };
  const unlock = async (password: string): Promise<ProviderStatus> => {
    await wait();
    const vault = vaultNow();
    if (vault === "not-logged-in") throw new BackendCallError(vaultMessage() ?? NOT_LOGGED_IN, VaultError.notLoggedIn);
    if (vault === "missing-cli") throw new BackendCallError(vaultMessage() ?? MISSING_CLI, VaultError.cliMissing);
    if (vault === "unsupported")
      throw new BackendCallError("no Host Login uses a vault with a master password", VaultError.unsupported);
    if (password !== FAKE_PASSWORD)
      throw new BackendCallError(kp ? KP_WORDS.wrongPassword : WRONG_PASSWORD, VaultError.wrongPassword);
    vaultWord = "unlocked";
    if (scenario.relockAfterMs !== undefined) {
      setTimeout(() => {
        if (vaultWord === "unlocked") vaultWord = "locked";
      }, scenario.relockAfterMs);
    }
    return { provider: vaultName, status: vaultWord };
  };
  // ---- vault.login, as roster answers it (docs/serve-api.md "Signing in: vault.login")
  let login: { id: string; step: SignInStep } | null = null;
  let logins = 0;
  const stepOf = (id: string, step: DistributiveOmit<SignInStep, "login">): SignInStep => {
    const s = { ...step, login: id } as SignInStep;
    if (s.step === "done") {
      vaultWord = "unlocked";
      login = null;
    } else {
      login = { id, step: s };
    }
    return s;
  };
  /** A failure; with `again`, the sign-in carries on at that step (data.step), else it's over. */
  const signInFailure = (code: number, message: string, again?: SignInStep) => {
    if (!again) login = null;
    return new BackendCallError(message, code, again ? { step: again, login: again.login } : null);
  };
  const ORDER: FakeMethodKind[] = ["authenticator", "yubikey", "email"];
  const NAMES: Record<string, [number, string]> = {
    authenticator: [0, "Authenticator App"],
    yubikey: [3, "Yubico OTP Security Key"],
    email: [1, "Email"],
  };
  const afterPassword = (id: string, account: FakeAccount): SignInStep => {
    const usable = ORDER.filter((m) => account.methods?.includes(m));
    if (account.methods?.length && usable.length === 0) {
      throw signInFailure(
        SignInError.methodUnsupported,
        "the Bitwarden CLI can't do this account's two-step login: FIDO2 security keys and Duo aren't supported by the CLI - sign in with an API key instead, or add an authenticator app, email or YubiKey OTP as a second method in the web vault",
      );
    }
    if (usable.length > 1) {
      const methods: TwoFactorMethod[] = usable.map((m, index) => {
        const [mid, name] = NAMES[m] ?? [null, m];
        return { index, id: mid, kind: m as TwoFactorMethod["kind"], name };
      });
      return stepOf(id, { step: "two_factor_method", methods });
    }
    if (usable.length === 1) return stepOf(id, { step: "two_factor_code", method: null, sent: usable[0] === "email" });
    if (account.newDevice) return stepOf(id, { step: "new_device_code", email: FAKE_EMAIL });
    return stepOf(id, { step: "done", provider: "bw", status: "unlocked" });
  };
  const signIn = async (start: SignInStart): Promise<SignInStep> => {
    await wait();
    login = null;
    if (vaultNow() !== "not-logged-in") {
      throw signInFailure(
        SignInError.alreadyLoggedIn,
        "the Bitwarden CLI is already logged in on this box - unlock it instead (to sign in as someone else, run `bw logout` first)",
      );
    }
    const account = signInAccount() ?? {};
    if (!["cloud", "eu"].includes(start.server) && !/^https?:\/\/[^\s/]+\S*$/.test(start.server)) {
      throw signInFailure(
        SignInError.badServer,
        `'${start.server}' isn't a server address - use cloud, eu, or your server's https:// URL, e.g. https://vault.example.com`,
      );
    }
    if (account.refuse) throw signInFailure(account.refuse.code, account.refuse.message);
    const id = `fake-login-${++logins}`;
    if (start.method === "password") {
      if (start.email !== FAKE_EMAIL || start.password !== FAKE_PASSWORD) {
        throw signInFailure(
          VaultError.wrongPassword,
          "Bitwarden didn't accept that email and master password (on bitwarden.com)",
        );
      }
      return afterPassword(id, account);
    }
    if (start.method === "apikey") {
      if (start.client_id !== FAKE_API_KEY.id || start.client_secret !== FAKE_API_KEY.secret) {
        throw signInFailure(SignInError.apiKeyRejected, "Bitwarden didn't accept that API key (client_id or client_secret)");
      }
      return stepOf(id, { step: "master_password", email: null });
    }
    return stepOf(id, {
      step: "sso",
      url: "https://vault.bitwarden.com/#/sso?clientId=cli&redirectUri=http%3A%2F%2Flocalhost%3A8065&state=fake",
      expires_in: 300,
    });
  };
  const signInAnswer = async (id: string, answer: SignInAnswer): Promise<SignInStep> => {
    await wait();
    const cur = login;
    if (!cur || cur.id !== id) {
      throw signInFailure(SignInError.noSignIn, "no sign-in in progress (it finished, was cancelled or timed out) - start again");
    }
    const step = cur.step;
    switch (step.step) {
      case "two_factor_method": {
        const m = "method" in answer ? step.methods[answer.method] : undefined;
        if (!m) throw new BackendCallError("vault.login: params.method must be one of the listed methods' index", -32602);
        return stepOf(id, { step: "two_factor_code", method: m, sent: m.kind === "email" });
      }
      case "two_factor_code":
      case "new_device_code": {
        if ("code" in answer && answer.code === FAKE_CODE) return stepOf(id, { step: "done", provider: "bw", status: "unlocked" });
        const emailed = step.step === "new_device_code" || step.sent;
        throw signInFailure(
          SignInError.codeRejected,
          `Bitwarden didn't accept that code (wrong or expired)${emailed ? " - a new code is on its way to your email" : ""}`,
          step,
        );
      }
      case "sso": {
        await sleep(scenario.signIn?.ssoMs ?? 300);
        if (login?.id !== id) throw signInFailure(SignInError.noSignIn, "no sign-in in progress - start again");
        if (scenario.signIn?.sso === "fail") throw signInFailure(SignInError.ssoFailed, "the SSO sign-in failed in the browser - try again");
        return stepOf(id, { step: "master_password", email: null });
      }
      case "master_password": {
        if ("password" in answer && answer.password === FAKE_PASSWORD) {
          return stepOf(id, { step: "done", provider: "bw", status: "unlocked" });
        }
        throw signInFailure(VaultError.wrongPassword, WRONG_PASSWORD, step);
      }
      default:
        throw signInFailure(SignInError.noSignIn, "no sign-in in progress - start again");
    }
  };

  return {
    async connect(): Promise<BackendInfo> {
      await wait();
      if (scenario.startProblem && !(scenario.failOnce && failures > 0)) {
        failures++;
        throw new BackendStartError(scenario.startProblem);
      }
      const info = scenario.info ?? {};
      return {
        backend: info.backend ?? "Fake",
        command: info.command ?? ["roster", "serve"],
        inventory: {
          path: info.path ?? "~/infra/roster.yml",
          box: info.box ?? "browser",
          host_count: scenario.hosts.hosts.length,
          providers: ["bw"],
          roster_version: "0.1.0",
          api_version: scenario.apiVersion ?? 2,
        },
      };
    },
    async listHosts() {
      await wait();
      return { hosts, groups, error: broken };
    },
    async getHost(name: string) {
      await wait();
      const h = hosts.find((x) => x.name === name);
      if (!h) throw new BackendCallError(`unknown host '${name}'`, 2);
      return h;
    },
    vaultStatus: () =>
      inOrder(async () => {
        await wait();
        return vaultStatus();
      }),
    unlockVault(password: string) {
      const slow = scenario.slowUnlock;
      const unlocking = inOrder(async () => {
        if (slow && password === FAKE_PASSWORD) await sleep(slow.completesAfterMs);
        return unlock(password);
      });
      if (!slow) return unlocking;
      return Promise.race([
        unlocking,
        sleep(slow.failAfterMs).then(() => {
          throw new BackendCallError("The backend didn't answer in time.", null, null, true);
        }),
      ]);
    },
    lockVault: () =>
      inOrder(async () => {
        await wait();
        if (vaultNow() !== "locked" && vaultNow() !== "unlocked") return { locked: [] };
        vaultWord = "locked";
        holding.clear(); // serve forgets every typed password it held (vault.lock)
        return { locked: [vaultName] };
      }),
    configureVault: (next) =>
      inOrder(async () => {
        await wait();
        if ((scenario.apiVersion ?? 2) < VAULT_CONFIG_API_VERSION) {
          throw new BackendCallError("unknown method 'vault.configure'", -32601);
        }
        const before = named();
        settings = structuredClone(next);
        // Another KeePassXC database: the master password held for the old one is forgotten.
        const relocked = kp && named() !== before && vaultWord === "unlocked";
        if (relocked) vaultWord = "locked";
        return { configured: true as const, locked: relocked ? [vaultName] : [], refused: [] };
      }),
    saveTargets: () =>
      inOrder(async () => {
        await wait();
        if ((scenario.apiVersion ?? 2) < VAULT_CONFIG_API_VERSION) {
          throw new BackendCallError("unknown method 'vault.targets'", -32601);
        }
        if (vaultNow() !== "unlocked") throw new BackendCallError(VAULT_LOCKED, VaultError.locked);
        const { setting, from } = defaultSetting();
        const found = targetFor(setting);
        const field = from === "init.lua" ? "vault.save_to in init.lua" : `providers: ${vaultName}: save_to: in roster.yml`;
        const problem = found ? null : unknownTarget(field);
        return {
          provider: vaultName,
          targets: targets(),
          default: found?.id ?? null,
          from,
          problem: problem && { code: SaveToError.unknownTarget, message: problem.message, fix: "fix the setting the message names" },
        };
      }),
    signOut: () =>
      inOrder(async (): Promise<SignedOut> => {
        await wait();
        if (!accountApi) throw new BackendCallError("unknown method 'vault.logout'", -32601);
        if (kp) {
          throw new BackendCallError(
            "KeePassXC has no account to sign out of: it opens a local database file. To use another one, change vault.kp.database in init.lua",
            VaultError.unsupported,
          );
        }
        const was = vaultNow();
        // serve forgets every secret first: askpass tokens, typed passwords held, session keys
        holding.clear();
        login = null;
        if (was === "not-logged-in") {
          throw new BackendCallError(
            "the Bitwarden CLI isn't signed in on this box - there's no account to sign out of",
            VaultError.alreadySignedOut,
            { fix: "sign in from the lock screen" },
          );
        }
        const signed_out = vaultStatus().account ?? null;
        vaultWord = "not-logged-in";
        signedOut = true;
        const now = vaultStatus();
        return {
          provider: vaultName,
          status: now.status,
          ...(now.message ? { message: now.message } : {}),
          ...(now.sign_in ? { sign_in: now.sign_in } : {}),
          can_sign_out: true,
          signed_out,
        };
      }),
    signIn: (start) => inOrder(() => signIn(start)),
    signInAnswer: (id, answer) => inOrder(() => signInAnswer(id, answer)),
    signInCancel: () =>
      inOrder(async () => {
        login = null;
      }),
    async openSession(host, size, events, typed) {
      await (scenario.sessionDelay === undefined ? wait() : new Promise((r) => setTimeout(r, scenario.sessionDelay)));
      const h = hosts.find((x) => x.name === host);
      if (!h) throw new BackendCallError(`unknown host '${host}'`, SessionRefusal.unknownHost);
      if (!h.reviewed) {
        throw new BackendCallError(
          `${host} is not reviewed yet (reviewed: false in roster.yml) - not logging in`,
          SessionRefusal.notReviewed,
        );
      }
      if (scenario.sessionRefusal) throw refuse(scenario.sessionRefusal);
      const refusal = scenario.refusals?.[host];
      if (refusal) throw refuse(refusal);
      const auth = authOf(h);
      // Ticket 16: an `auth: prompt` Host's password is the one the user types (API 13).
      const prompted = auth === "password" && h.ssh.auth === "prompt" && (scenario.apiVersion ?? 2) >= SAVE_TO_VAULT_API_VERSION;
      if (auth === "password" && h.ssh.auth === "prompt" && !prompted) {
        // An older roster can't ask: its prompt provider has no terminal under serve.
        throw new BackendCallError(`needs input (password for group '${h.group}') but there's no terminal to ask in (ssh Login of ${host})`, 35);
      }
      if (prompted) {
        if (!typed) {
          throw new BackendCallError(`${host}'s Login is auth: prompt - type its password`, SessionRefusal.passwordNeeded, {
            user: h.ssh.user,
            address: h.ip,
            port: h.ssh.port,
            fix: "type the password when the app asks; tick Save to vault to keep it in the vault once it has logged in",
          });
        }
        const id = ++sessions;
        const held = typed.save ? `h${id}` : null;
        if (held) {
          holding.set(held, { loggedIn: false, host });
          heldIds.push(held);
        }
        const handle =
          typed.password === FAKE_HOST_PASSWORD
            ? fakeSession(id, host, auth, size, events, scenario.loginMs, held ? { onLogin: () => loggedIn(held), printers } : { printers })
            : failingSession(id, auth, `${h.ssh.user}@${h.ip}: Permission denied (publickey,password).\r\n`, events);
        return { ...handle, ...(held ? { held } : {}) };
      }
      if (auth === "password") {
        if (scenario.passwordRefusal) throw refuse(scenario.passwordRefusal);
        if (vaultNow() === "locked") throw new BackendCallError(VAULT_LOCKED, SessionRefusal.vaultLocked);
      }
      if (scenario.unknownKeys?.[host] && !keysTrusted.has(host)) {
        throw new BackendCallError(`roster hasn't seen ${host}'s host key before`, SessionRefusal.hostKeyUnknown, {
          address: h.ip,
          port: h.ssh.port,
          fix: `compare its fingerprint with the Host's console or owner, then trust it when the app asks, or run \`roster setup --only ${host}\``,
        });
      }
      const failure = scenario.sshFailures?.[host];
      if (failure !== undefined) return failingSession(++sessions, auth, failure, events);
      return fakeSession(++sessions, host, auth, size, events, scenario.loginMs, { stream: scenario.stream, printers, repaints: scenario.repaints });
    },
    async openQuickSession(to, password, size, events, options = {}) {
      await (scenario.sessionDelay === undefined ? wait() : new Promise((r) => setTimeout(r, scenario.sessionDelay)));
      quick.push({ ...to, password: password !== null });
      const label = formatQuickTarget(to);
      const box = scenario.quickBoxes?.[to.address];
      const where = `${to.address}:${to.port}`;
      if (box?.unreachable) {
        throw new BackendCallError(`${label} (${where}) didn't answer within 5 s`, 42, {
          fix: "retry later; is the Host up and the network path open?",
          details: "timed out",
        });
      }
      const scanned = scenario.scanKeys?.[to.address];
      if (scanned?.recorded === "changed") {
        throw new BackendCallError(`${label}'s host key changed - not connecting`, HostKeyError.changed, {
          recorded: [FAKE_OTHER_FINGERPRINT],
          offered: scanned.fingerprint ?? FAKE_FINGERPRINT,
          fix: "don't accept it blindly: compare the new fingerprint with the box's console or owner",
        });
      }
      const offered = box?.changesOnConnect ? FAKE_OTHER_FINGERPRINT : (scanned?.fingerprint ?? FAKE_FINGERPRINT);
      if (to.fingerprint !== offered) {
        throw new BackendCallError(`${label}'s host key changed while roster was asking - not connecting`, HostKeyError.changedWhileAsked, {
          asked: to.fingerprint,
          offered,
          fix: "don't trust it blindly: compare the new fingerprint with the box's console or owner, then Quick Connect again to see it",
          details: `asked about ${to.fingerprint}; now offered ssh-ed25519 ${offered}`,
        });
      }
      const id = ++sessions;
      const auth: SessionAuth = password === null ? "key" : "password";
      const qid = `q${quick.length}`;
      const saving = options.save === true && password !== null && (scenario.apiVersion ?? 2) >= SAVE_TO_VAULT_API_VERSION;
      if (saving) {
        holding.set(qid, { loggedIn: false, to });
        heldIds.push(qid);
      }
      const hostname = box?.hostname;
      // Like ssh: a password the box doesn't take, or no key it does, ends the Session at once.
      const handle =
        password === null || password === FAKE_HOST_PASSWORD
          ? fakeSession(id, label, auth, size, events, scenario.loginMs, {
              ...(saving ? { onLogin: () => loggedIn(qid) } : {}),
              ...(hostname ? { title: `${to.user}@${hostname}: ~` } : {}),
            })
          : failingSession(id, auth, `${to.user}@${to.address}: Permission denied (publickey,password).\r\n`, events);
      return { ...handle, quick: qid, ...(saving ? { held: qid } : {}) };
    },
    async saveQuick(p: QuickSaveParams): Promise<QuickSave> {
      await wait();
      saves.push(p);
      const fail = (code: number, message: string, data: CallErrorData = {}) => new BackendCallError(message, code, data);
      const h = holding.get(p.quick);
      if (!h?.to) {
        throw fail(SaveLoginError.nothingHeld, "there's no typed password to save for that Session: it was saved already, or forgotten (the Session ended, the vault was locked, or 10 minutes passed)", {
          fix: "connect again with Save to vault ticked",
        });
      }
      const to = h.to;
      if (!h.loggedIn) {
        throw fail(SaveLoginError.notLoggedIn, `${formatQuickTarget(to)} hasn't logged in with that password - roster saves it only after the login succeeded`, {
          fix: "wait until the Session has logged in; if the box refused the password, nothing is saved",
        });
      }
      for (const [field, v] of [["name", p.name], ["group", p.group]] as const) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v)) {
          throw fail(AddError.invalidHost, `bad ${field === "name" ? "host" : "group"} name '${v}' (use letters, digits, . _ -)`, { field });
        }
      }
      const there = hosts.find((x) => x.name === p.name);
      if (there) {
        throw fail(AddError.hostExists, `host '${p.name}' is already in the Inventory (group ${there.group})`, {
          group: there.group,
          fix: "pick another name, or edit that Host",
        });
      }
      const item = p.item ?? `${p.name} ssh`;
      if (vaultNow() !== "unlocked") throw new BackendCallError(VAULT_LOCKED, VaultError.locked);
      if (items.includes(item)) {
        throw fail(60, `a Bitwarden item named '${item}' already exists - pick another name, or point the Login at that item`, {
          matches: [{ name: item, revised: "2026-10-01", uris: [] }],
          fix: "pick another name for the Host or the item",
        });
      }
      const target = targetFor(p.save_to ?? defaultSetting().setting);
      if (!target) throw unknownTarget(p.save_to ? "save_to" : "vault.save_to in init.lua");
      items = [...items, item];
      holding.delete(p.quick);
      const host: Host = {
        name: p.name,
        group: p.group,
        ip: to.address,
        type: "",
        product: "",
        title: p.title ?? "",
        description: "",
        reviewed: true,
        enroll: false,
        ssh: { user: to.user, port: to.port, auth: `bw:${item}` },
        web: null,
      };
      hosts = [...hosts, host];
      if (!(p.group in groups)) groups = { ...groups, [p.group]: { title: "", description: "" } };
      const { save_to: _s, ...shown } = target;
      void _s;
      return { added: true, host, backup: "/home/you/infra/.git/roster/roster.yml.bak", item: { provider: "bw", id: `fake-${item}`, name: item, target: shown }, warnings: [] };
    },
    async saveLogin(p: SaveLoginParams): Promise<SaveLogin> {
      await wait();
      const h = holding.get(p.held);
      const fail = (code: number, message: string, data: CallErrorData = {}) => new BackendCallError(message, code, data);
      if (!h?.host) {
        throw fail(SaveLoginError.nothingHeld, "there's no typed password to save for that Session: it was saved already, or forgotten (the Session ended, the vault was locked, or 10 minutes passed)", {
          fix: "connect again with Save to vault ticked",
        });
      }
      const name = h.host;
      if (!h.loggedIn) throw fail(SaveLoginError.notLoggedIn, `${name} hasn't logged in with that password - roster saves it only after the login succeeded`);
      const item = p.item ?? `${name} ssh`;
      if (vaultNow() !== "unlocked") throw new BackendCallError(VAULT_LOCKED, VaultError.locked);
      if (items.includes(item)) {
        throw fail(60, `a Bitwarden item named '${item}' already exists - pick another name, or point the Login at that item`, {
          fix: "pick another name for the item",
        });
      }
      const target = targetFor(p.save_to ?? defaultSetting().setting);
      if (!target) throw unknownTarget(p.save_to ? "save_to" : "vault.save_to in init.lua");
      items = [...items, item];
      holding.delete(p.held);
      const before = knownHost(name);
      const host: Host = { ...before, ssh: { ...before.ssh, auth: `bw:${item}` } };
      hosts = hosts.map((x) => (x.name === name ? host : x));
      const { save_to: _s, ...shown } = target;
      void _s;
      return { changed: true, host, backup: "/home/you/infra/.git/roster/roster.yml.bak", item: { provider: "bw", id: `fake-${item}`, name: item, target: shown }, warnings: [] };
    },
    async forgetTyped(held: string) {
      forgets.push(held);
      return { forgotten: holding.delete(held) };
    },
    onLoggedIn(onLogin) {
      loginWatchers.add(onLogin);
      return () => loginWatchers.delete(onLogin);
    },
    async checkBox(): Promise<BoxCheck> {
      await wait();
      const checks = scenario.boxChecks ?? [...HEALTHY_BOX];
      return { checks, ok: !checks.some((c) => c.level === "error"), roster_version: "0.1.0", api_version: scenario.apiVersion ?? 2 };
    },
    async checkHost(host) {
      await wait();
      const given = scenario.checks?.[host];
      if (given) return given;
      const h = hosts.find((x) => x.name === host);
      if (!h) {
        const steps = CHECK_STEPS.map((step, i) =>
          i === 0
            ? { step, status: "fail" as const, code: 2, message: `unknown host '${host}'`, fix: "check the name" }
            : { step, status: "skipped" as const, message: "an earlier step failed" },
        );
        return { host, ok: false, steps };
      }
      return passingCheck(h);
    },
    async pullInventory() {
      await new Promise((r) => setTimeout(r, scenario.pullDelay ?? scenario.delay ?? 0));
      if (scenario.pullRefusal) throw refuse(scenario.pullRefusal);
      if (pending().count > 0) {
        throw new BackendCallError("roster.yml has Pending changes, so roster won't pull over them", EditError.dirty, {
          files: ["roster.yml"],
          fix: "Publish or discard the Pending changes first",
        });
      }
      const brings = scenario.pullBrings;
      if (brings && !pulledIn) {
        pulledIn = true;
        const change = (h: Host) => (brings.changes[h.name] ? withFields(h, brings.changes[h.name] ?? {}) : h);
        committed = committed.map(change);
        hosts = hosts.map(change);
        return { updated: true, upstream: "origin/main", commits: brings.commits, ahead: 0 };
      }
      return { updated: false, upstream: "origin/main", commits: 0, ahead: 0 };
    },
    async verifyLogin(host, changes) {
      await wait();
      const h = hosts.find((x) => x.name === host);
      if (!h) throw new BackendCallError(`unknown host '${host}'`, 2);
      const result = scenario.verifyResults?.[host] ?? passingVerify(host);
      if (result.ok) verified.add(loginKey(host, { ...fieldsOf(h), ...changes }));
      return result;
    },
    async updateHost(host, changes) {
      await wait();
      const h = hosts.find((x) => x.name === host);
      if (!h) throw new BackendCallError(`unknown host '${host}'`, 2);
      const now = fieldsOf(h);
      const wanted = Object.fromEntries(Object.entries(changes).filter(([k, v]) => now[k as keyof HostFields] !== v));
      if (Object.keys(wanted).length === 0) return { changed: false, host: h, backup: null };
      const key = loginKey(host, { ...now, ...wanted });
      if (LOGIN_FIELDS.some((k) => k in wanted)) {
        if (!verified.has(key)) {
          throw new BackendCallError(`${host}'s new address, user or Login hasn't passed a test login`, EditError.notVerified, {
            fix: "test the login (host.verify_login) with these values, then save again",
          });
        }
        verified.delete(key);
      }
      const updated = withFields(h, wanted);
      hosts = hosts.map((x) => (x.name === host ? updated : x));
      return { changed: true, host: updated, backup: "~/infra/.git/roster/roster.yml.bak" };
    },
    async pendingChanges() {
      await wait();
      return pending();
    },
    async discardChanges() {
      await wait();
      if (pending().count === 0) return { discarded: false, backup: null };
      hosts = committed;
      groups = committedGroups;
      return { discarded: true, backup: "~/infra/.git/roster/roster.yml.bak" };
    },
    async publishChanges(message) {
      await wait();
      if (scenario.publishRefusal) throw refuse(scenario.publishRefusal);
      const now = pending();
      if (now.count === 0) {
        throw new BackendCallError("roster.yml has no Pending changes, so there's nothing to publish", PublishError.nothingPending, {
          fix: "edit a Host first",
        });
      }
      committed = hosts;
      committedGroups = groups;
      publishedOnce = true;
      const sync = scenario.publishSyncError
        ? { ok: false, error: scenario.publishSyncError, fix: "run `roster sync` on this box" }
        : { ok: true };
      if (scenario.lateAnswers) throw late();
      return { commit: FAKE_COMMIT, upstream: "origin/main", message, hosts: now.hosts, groups: [], pulled: 0, sync };
    },
    async scanHostKey(host) {
      await wait();
      const h = knownHost(host);
      const u = scenario.unknownKeys?.[host];
      if (u?.unreachable) throw unanswered(h);
      if (u?.recordedAs === "changed") {
        keysTrusted.add(host);
        scenario.sshFailures = { ...scenario.sshFailures, [host]: HOST_KEY_CHANGED_OUTPUT };
      }
      const recorded = keysTrusted.has(host) || !u ? "match" : (u.recordedAs ?? "none");
      return { host, address: h.ip, port: h.ssh.port, key_type: "ssh-ed25519", fingerprint: FAKE_FINGERPRINT, recorded };
    },
    async trustHostKey(host, fingerprint) {
      await wait();
      const h = knownHost(host);
      const u = scenario.unknownKeys?.[host];
      if (u?.unreachable) throw unanswered(h);
      const offered = u?.changesOnTrust ? FAKE_OTHER_FINGERPRINT : FAKE_FINGERPRINT;
      if (fingerprint !== offered) {
        throw new BackendCallError(`${host}'s host key changed while roster was asking - nothing was recorded`, HostKeyError.changedWhileAsked, {
          asked: fingerprint,
          offered,
          fix: "don't trust it blindly: compare the new fingerprint with the Host's console or owner, then open the Session again to see it",
          details: `asked about ${fingerprint}; now offered ssh-ed25519 ${offered}`,
        });
      }
      const recorded = !keysTrusted.has(host);
      keysTrusted.add(host);
      return { host, address: h.ip, port: h.ssh.port, key_type: "ssh-ed25519", fingerprint, recorded };
    },
    async scanKey(address, port) {
      await wait();
      if (scenario.quickBoxes?.[address]?.unreachable) {
        throw new BackendCallError(`${address} (${address}:${port}) didn't answer within 5 s`, 42, {
          fix: "retry later; is the Host up and the network path open?",
          details: "timed out",
        });
      }
      return { address, port, key_type: "ssh-ed25519", fingerprint: FAKE_FINGERPRINT, recorded: "none", ...scenario.scanKeys?.[address] };
    },
    async addHost(p: AddHostParams) {
      await wait();
      const fail = (code: number, message: string, data: CallErrorData = {}) => new BackendCallError(message, code, data);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p.name)) {
        throw fail(AddError.invalidHost, `bad host name '${p.name}' (use letters, digits, . _ -)`, { field: "name" });
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p.group)) {
        throw fail(AddError.invalidHost, `bad group name '${p.group}' (use letters, digits, . _ -)`, { field: "group" });
      }
      const there = hosts.find((h) => h.name === p.name);
      if (there) {
        throw fail(AddError.hostExists, `host '${p.name}' is already in the Inventory (group ${there.group})`, {
          group: there.group,
          fix: "pick another name, or edit that Host",
        });
      }
      const { password: _typed, ...seen } = p;
      void _typed;
      added.push(seen);
      const port = p.port ?? 22;
      const login = p.password !== undefined || (p.auth ?? "").includes(":");
      const item = p.password !== undefined ? (p.item ?? `${p.name} ssh`) : null;
      if (login) {
        const key = { recorded: "none", fingerprint: FAKE_FINGERPRINT, ...scenario.scanKeys?.[p.address] };
        const typedLocked = p.password !== undefined && vaultNow() !== "unlocked";
        const result =
          scenario.addVerify?.[p.name] ??
          (typedLocked
            ? failingVerify(p.name, "provider", VaultError.locked, VAULT_LOCKED, "unlock the vault")
            : key.recorded === "none" && p.host_key === undefined
              ? failingVerify(p.name, "host-key", 44, `no recorded host key for ${p.name} at ${p.address}`, "scan the host key and confirm it")
              : key.recorded === "changed" || (p.host_key !== undefined && p.host_key !== key.fingerprint)
                ? failingVerify(p.name, "host-key", 43, `${p.name}'s host key at ${p.address} isn't the one you confirmed - not logging in`)
                : p.password !== undefined && p.password !== FAKE_HOST_PASSWORD
                  ? failingVerify(p.name, "auth", 45, `${p.name} refused the password for user ${p.user ?? "admin"}`,
                      "check the user and the vault item: the password may have changed on the Host")
                  : passingVerify(p.name));
        const failed = result.steps.find((s) => s.status === "fail");
        if (failed) {
          throw fail(failed.code ?? 48, `${p.name} wasn't added: ${failed.message} - nothing was saved`, {
            step: failed.step,
            steps: result.steps,
            ...(failed.fix ? { fix: failed.fix } : {}),
          });
        }
      }
      const choosing = (scenario.apiVersion ?? 2) >= VAULT_CONFIG_API_VERSION;
      const target = p.password === undefined || !choosing ? null : targetFor(p.save_to ?? defaultSetting().setting);
      if (p.password !== undefined && choosing && !target) throw unknownTarget(p.save_to ? "save_to" : "vault.save_to in init.lua");
      const host: Host = {
        name: p.name,
        group: p.group,
        ip: p.address,
        type: p.type ?? "",
        product: "",
        title: p.title ?? "",
        description: "",
        reviewed: login,
        enroll: p.enroll ?? true,
        ssh: { user: p.user ?? "admin", port, auth: item ? `bw:${item}` : (p.auth ?? "prompt") },
        web: null,
      };
      hosts = [...hosts, host];
      if (!(p.group in groups)) groups = { ...groups, [p.group]: { title: "", description: "" } };
      if (scenario.lateAnswers) throw late();
      return {
        added: true,
        host,
        backup: "~/infra/.git/roster/roster.yml.bak",
        verify: login ? passingVerify(p.name) : null,
        item: item
          ? { provider: "bw", id: `fake-${p.name}`, name: item, ...(target ? { target: { id: target.id, kind: target.kind, label: target.label } } : {}) }
          : null,
        warnings: scenario.addWarnings?.[p.name] ?? [],
      };
    },
    async reviewHost(host, reviewed = true) {
      await wait();
      const h = hosts.find((x) => x.name === host);
      if (!h) throw new BackendCallError(`unknown host '${host}'`, 2);
      if (h.reviewed === reviewed) return { changed: false, host: h, backup: null };
      const updated = { ...h, reviewed };
      hosts = hosts.map((x) => (x.name === host ? updated : x));
      return { changed: true, host: updated, backup: "~/infra/.git/roster/roster.yml.bak" };
    },
    async removeHost(host) {
      await wait();
      const h = hosts.find((x) => x.name === host);
      if (!h) throw new BackendCallError(`unknown host '${host}'`, 2);
      hosts = hosts.filter((x) => x.name !== host);
      return { removed: host, group: h.group, backup: BACKUP };
    },
    async renameHost(host, to) {
      await wait();
      const h = hosts.find((x) => x.name === host);
      if (!h) throw new BackendCallError(`unknown host '${host}'`, 2);
      if (!NAME.test(to)) throw new BackendCallError(`bad host name '${to}' (use letters, digits, . _ -)`, AddError.invalidHost, { field: "name" });
      if (to === host) return { changed: false, host: h, backup: null };
      const there = hosts.find((x) => x.name === to);
      if (there) {
        throw new BackendCallError(`host '${to}' is already in the Inventory (group ${there.group})`, LiveError.nameTaken, {
          kind: "host",
          group: there.group,
          fix: "pick another name",
        });
      }
      const renamed = { ...h, name: to };
      hosts = hosts.map((x) => (x.name === host ? renamed : x));
      return { changed: true, host: renamed, backup: BACKUP };
    },
    async moveHost(host, group) {
      await wait();
      const h = hosts.find((x) => x.name === host);
      if (!h) throw new BackendCallError(`unknown host '${host}'`, 2);
      if (!(group in groups)) throw unknownGroup(group, groups);
      if (h.group === group) return { changed: false, host: h, backup: null, pinned: [] };
      const moved = { ...h, group };
      hosts = [...hosts.filter((x) => x.name !== host), moved];
      return { changed: true, host: moved, backup: BACKUP, pinned: [] };
    },
    async newGroup(name, title) {
      await wait();
      if (!NAME.test(name)) throw new BackendCallError(`bad group name '${name}' (use letters, digits, . _ -)`, AddError.invalidHost, { field: "group" });
      if (name in groups) {
        throw new BackendCallError(`group '${name}' is already in roster.yml`, LiveError.nameTaken, { kind: "group", group: name, fix: "pick another name, or use that group" });
      }
      groups = { ...groups, [name]: { title: title ?? "", description: "" } };
      return { group: name, backup: BACKUP };
    },
    async renameGroup(group, to) {
      await wait();
      if (!(group in groups)) throw unknownGroup(group, groups);
      if (!NAME.test(to)) throw new BackendCallError(`bad group name '${to}' (use letters, digits, . _ -)`, AddError.invalidHost, { field: "group" });
      if (to === group) return { changed: false, group: to, backup: null };
      if (to in groups) throw new BackendCallError(`group '${to}' is already in roster.yml`, LiveError.nameTaken, { kind: "group", group: to });
      groups = Object.fromEntries(Object.entries(groups).map(([g, v]) => [g === group ? to : g, v]));
      hosts = hosts.map((h) => (h.group === group ? { ...h, group: to } : h));
      return { changed: true, group: to, backup: BACKUP };
    },
    async deleteGroup(group, to) {
      await wait();
      if (!(group in groups)) throw unknownGroup(group, groups);
      const members = hosts.filter((h) => h.group === group).map((h) => h.name);
      if (members.length && to === undefined) {
        throw new BackendCallError(
          `group ${group} still has ${members.length} Host${members.length > 1 ? "s" : ""} (${members.join(", ")}) - say which group they go to, or move them first`,
          LiveError.groupNotEmpty,
          { group, hosts: members, fix: "pick the group its Hosts move to" },
        );
      }
      if (to !== undefined && members.length && !(to in groups)) throw unknownGroup(to, groups);
      hosts = [...hosts.filter((h) => h.group !== group), ...hosts.filter((h) => h.group === group).map((h) => ({ ...h, group: to ?? h.group }))];
      groups = Object.fromEntries(Object.entries(groups).filter(([g]) => g !== group));
      return { deleted: group, moved: members, to: members.length ? (to ?? null) : null, backup: BACKUP };
    },
    async reloadInventory() {
      await wait();
      const changed = onDisk !== null;
      applyDisk();
      return { changed, host_count: hosts.length, error: broken };
    },
    async watchInventory(auto) {
      await wait();
      watchAuto = auto;
      return { watching: true, auto };
    },
    onInventoryChanged(onChange) {
      changeWatchers.add(onChange);
      return () => changeWatchers.delete(onChange);
    },
    outsideEdit(next) {
      onDisk = next;
      if (watchAuto === null) return;
      if (watchAuto) applyDisk();
      const change: InventoryChanged = watchAuto ? { applied: true, error: broken } : { applied: false, error: null };
      for (const w of changeWatchers) w(change);
    },
    ...fakePluginHost(scenario.plugins ?? {}, () => hosts, packagePlugin),
    ...packageHost,
    watching: () => watchAuto,
    vaultSettings: () => settings,
    adds: () => added,
    quickConnects: () => [...quick],
    held: () => [...heldIds],
    quickSaves: () => [...saves],
    forgotten: () => [...forgets],
    print(host, text) {
      const to = [...printers].filter((p) => p.host === host);
      for (const p of to) p.say(text);
      return to.length;
    },
  };
}
