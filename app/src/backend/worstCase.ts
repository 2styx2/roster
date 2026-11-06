// The worst-case fixture (ticket 27, decision Q47): data a real Inventory, Box and user can
// produce that the demo fixtures never do. Long and unbreakable names, one-letter, unicode, emoji
// and RTL names, missing fields, 1,284 Hosts, 50 open Sessions, 100 Folders, long errors and
// SHA256 fingerprints. It enters through the fake Backend (`?fixture=worst-case`) and the State
// it seeds, like any other fixture; the UI tests render the same data (App.worst.test.tsx).
//
// Spread the failures across the first rows: that's what's on screen.
import { CHECK_STEPS, SessionRefusal, type Group, type Host, type HostCheck, type HostList, type Service } from "./types";
import { Code } from "./serveContract";

/** The name the ticket names: a `roster discover` result nobody has renamed yet. */
export const LONG_NAME = "server-10-0-0-202-very-long-discovered-name";
/** Same as LONG_NAME up to the last few characters, but reviewed (so it can be opened). */
export const LONG_NAME_OPEN = "server-10-0-0-203-very-long-discovered-name";
export const LONG_GROUP = "contoso-east-ridge-building-4-servers-and-storage";
export const UNICODE_GROUP = "Ünïcödé-группа-東京";
export const EMPTY_GROUP = "decommissioned-2019";
export const UNDECLARED_GROUP = "discovered-not-yet-sorted";
export const LONG_BOX = "aleksandra-wisniewska-thinkpad-p16-gen2-fedoralinux-44";
export const LONG_PATH = "/home/aleksandra.wisniewska-kowalczyk/work/yourteam/infra-checkouts/contoso-east-ridge/roster.yml";
export const LONG_FOLDER = "Building 4 — lab jump boxes, file servers and the consoles they reach";
export const MISSING_HOST = "decommissioned-old-archive-2019-not-in-inventory";
export const SHA_OFFERED = "SHA256:mX0xg1jn8T8p0bq2Wl3c7c4pQe0b7aR6E2wV8iY0fUk";
export const SHA_RECORDED = [
  "SHA256:Zq7r0Lw3bN9yX2cV5tU8sR1pQ4oM6nK0jH3gF7eD9cB",
  "SHA256:a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V",
];
/** The worst-case Inventory's size: four digits, so every count needs a separator. */
export const WORST_HOST_COUNT = 1284;

const base = (name: string, over: Partial<Host> = {}): Host => ({
  name,
  group: LONG_GROUP,
  ip: "10.0.0.10",
  type: "linux",
  product: "",
  title: "",
  description: "",
  reviewed: true,
  enroll: true,
  ssh: { user: "admin", port: 22, auth: "key" },
  web: null,
  ...over,
});

const web = (url: string | null, port: number, own?: { user: string; auth: string }): Service => ({
  port,
  url,
  scheme: url ? (url.startsWith("https") ? "https" : "http") : null,
  user: own?.user ?? "administrator",
  auth: own?.auth ?? "bw:server-10-0-0-203 ssh",
  verify: true,
  login: "basic",
  override: own !== undefined,
});

/** Host details at its worst (ticket 18): 40 services, long names, a long URL with a path and a
 * query, Logins of their own with long vault item names, services with no URL, and one URL that
 * carries a password (never opened). */
export const WORST_SERVICES: Record<string, Service> = {
  web: web("https://10.0.0.203", 443),
  "integrated-lights-out-management-console-for-the-rack-b-u42-chassis": web(
    "https://10.0.0.203:8443/ui/management/console/index.html?view=summary&tab=hardware-health-and-sensors",
    8443,
    { user: "ilo-administrator-account-with-a-long-name", auth: "bw:server-10-0-0-203 integrated lights out management console" },
  ),
  "with-a-password-in-the-url": web("https://admin:not-a-real-secret@10.0.0.203:9443", 9443),
  postgres: web(null, 5432),
  ...Object.fromEntries(Array.from({ length: 36 }, (_, i) => [`svc-${String(i + 1).padStart(2, "0")}`, web(i % 3 === 2 ? null : `http://10.0.0.203:${8000 + i}`, 8000 + i)])),
};

/** The odd ones, first in the tree, the Picker and the Sessions. */
export const oddHosts: Host[] = [
  base(LONG_NAME, { ip: "10.0.0.202", reviewed: false, enroll: false, ssh: { user: "admin", port: 22, auth: "bw:server-10-0-0-202 ssh" } }),
  base(LONG_NAME_OPEN, {
    ip: "10.0.0.203",
    enroll: false,
    ssh: { user: "administrator", port: 2222, auth: "bw:server-10-0-0-203 ssh" },
    title: "The long-named server in rack B, unit 42, that everyone reaches from the jump box first",
    description:
      "Discovered by a scan and never renamed: it runs the lab's build agents, the nightly backups and a database nobody remembers creating. Ask before rebooting it.",
    product: "BRAVO",
    mac: "00:1a:2b:3c:4d:5e",
    login: { user: "administrator", auth: "bw:server-10-0-0-203 ssh" },
    services: WORST_SERVICES,
    web: "https://10.0.0.203",
  }),
  base("x", { ip: "10.0.0.1", type: "router" }),
  base("🦊-fox-lab", { ip: "10.0.0.31", type: "proxmox", product: "BRAVO" }),
  base("خادم-الإنتاج-٠١", { ip: "10.0.0.32", type: "windows" }),
  base("東京サーバー01", { ip: "10.0.0.33" }),
  base("đặng-thị-ngọc-hân-vm", { ip: "10.0.0.34" }),
  // Missing fields: no address, no type, no title, no product.
  base("no-address", { ip: "", type: "" }),
  base("ipv6-only-archive", { ip: "fe80::1ff:fe23:4567:890a%eth0", type: "nas" }),
  base("Benachrichtigungseinstellungsverwaltungsserver", { ip: "10.0.0.40", type: "windows" }),
  base("lab-hub2-ops-console-workstation-server-room-b", { ip: "10.0.0.41", type: "windows", product: "HUB" }),
  base("host-key-changed-esxi-rack-b-u42-management-interface", { ip: "10.0.0.42", type: "esxi" }),
  base("vault-item-missing", { ip: "10.0.0.43", enroll: false, ssh: { user: "root", port: 22, auth: "bw:vault-item-missing ssh" } }),
  base("j", { group: UNICODE_GROUP, ip: "10.19.88.2" }),
  base("ñandú-01", { group: UNICODE_GROUP, ip: "10.19.88.3", reviewed: false }),
  base("cisco-c9300-48p-access-switch-building-7-floor-3-idf-closet-a", { group: UNDECLARED_GROUP, ip: "10.19.99.250", type: "switch", reviewed: false }),
];

const TYPES = ["linux", "esxi", "proxmox", "switch", "router", "windows", "printer", "nas"];

/** The rest: ordinary discovered Hosts across a few subnets, every seventh one unreviewed. */
function bulkHosts(n: number): Host[] {
  return Array.from({ length: n }, (_, i) => {
    const subnet = (i % 5) + 1;
    const type = TYPES[i % TYPES.length] ?? "linux";
    return base(`${type}-${subnet}-${String(i).padStart(4, "0")}`, {
      group: `subnet-${subnet}`,
      ip: `10.19.${subnet}.${(i % 250) + 2}`,
      type,
      reviewed: i % 7 !== 3,
      enroll: i % 3 !== 0,
      ssh: { user: "admin", port: 22, auth: i % 3 === 0 ? `bw:${type}-${i} ssh` : "key" },
    });
  });
}

const groups: Record<string, Group> = {
  [LONG_GROUP]: {
    title: "Building 4 — servers, switches, storage and the jump boxes that reach them (10.0.0.0/24)",
    description: "",
  },
  [UNICODE_GROUP]: { title: "", description: "" },
  [EMPTY_GROUP]: { title: "Nothing left in here", description: "" },
  ...Object.fromEntries([1, 2, 3, 4, 5].map((s) => [`subnet-${s}`, { title: `10.19.${s}.0/24`, description: "" }])),
};

export function worstCaseHosts(): HostList {
  return { hosts: [...oddHosts, ...bulkHosts(WORST_HOST_COUNT - oddHosts.length)], groups };
}

/** An Inventory of exactly one Host (every count at 1). */
export function oneHost(): HostList {
  return { hosts: [base(LONG_NAME_OPEN, { ip: "10.0.0.203" })], groups: { [LONG_GROUP]: groups[LONG_GROUP] as Group } };
}

/** 50 open Sessions: the odd names first (one opened three times), then ordinary ones. */
export function worstCaseSessions(hosts: HostList): string[] {
  const open = hosts.hosts.filter((h) => h.reviewed);
  const odd = [LONG_NAME_OPEN, LONG_NAME_OPEN, LONG_NAME_OPEN, "x", "🦊-fox-lab", "خادم-الإنتاج-٠١", "東京サーバー01",
    "host-key-changed-esxi-rack-b-u42-management-interface", "vault-item-missing", "Benachrichtigungseinstellungsverwaltungsserver"];
  const rest = open.filter((h) => !odd.includes(h.name)).slice(0, 50 - odd.length).map((h) => h.name);
  return [...odd, ...rest];
}

/** 100 Folders: long, short, emoji, RTL and unbreakable names; one with 40 Hosts and one holding
 * a Host that's gone from the Inventory; most of them empty. */
export function worstCaseFolders(hosts: HostList): { name: string; hosts: string[] }[] {
  const names = hosts.hosts.map((h) => h.name);
  const special = [
    { name: LONG_FOLDER, hosts: names.slice(0, 40) },
    { name: "x", hosts: ["x"] },
    { name: "🔥 on fire right now", hosts: [LONG_NAME_OPEN, MISSING_HOST] },
    { name: "مجلد العمل", hosts: ["خادم-الإنتاج-٠١"] },
    { name: "Benachrichtigungseinstellungen", hosts: [] },
    { name: "Ünïcödé", hosts: [] },
  ];
  const rest = Array.from({ length: 100 - special.length }, (_, i) => ({
    name: `Folder ${String(i + 1).padStart(3, "0")}`,
    hosts: i % 9 === 0 ? names.slice(100 + i, 103 + i) : [],
  }));
  return [...special, ...rest];
}

/** What ssh prints when a Host's key changed (OpenSSH 9), with a long Host name and path. */
export const HOST_KEY_CHANGED_OUTPUT = [
  "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
  "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @",
  "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
  "IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!",
  "Someone could be eavesdropping on you right now (man-in-the-middle attack)!",
  "It is also possible that a host key has just been changed.",
  "The fingerprint for the ED25519 key sent by the remote host is",
  `${SHA_OFFERED}.`,
  "Please contact your system administrator.",
  "Add correct host key in /home/aleksandra.wisniewska-kowalczyk/.ssh/roster_known_hosts to get rid of this message.",
  "Offending ED25519 key in /home/aleksandra.wisniewska-kowalczyk/.ssh/roster_known_hosts:1284",
  "Host key for host-key-changed-esxi-rack-b-u42-management-interface has changed and you have requested strict checking.",
  "Host key verification failed.",
  "",
].join("\r\n");

/** session.prepare's 32 with many near names (the error panel's "Similar item names"). */
export const ITEM_NOT_FOUND = {
  code: SessionRefusal.itemNotFound,
  message:
    "vault-item-missing: no Bitwarden item named 'vault-item-missing ssh' (searched the whole vault, including the 'Contoso East Ridge / Building 4 / Servers and Storage' collection)",
  data: {
    fix: "Create the item in the vault, or fix ssh.auth in roster.yml so it names the item that exists.",
    near: [
      "vault-item-missing-ssh-old-do-not-use-2019",
      "vault item missing (ssh, root, rotated 2026-03-14 by the night shift)",
      "server-10-0-0-202-very-long-discovered-name ssh",
    ],
  },
};

/** `host.check` for the long-named Host: stops at the host key with long fingerprints. */
export function hostKeyCheck(host: string): HostCheck {
  const failAt = CHECK_STEPS.indexOf("host-key");
  return {
    host,
    ok: false,
    steps: CHECK_STEPS.map((step, i) =>
      i < failAt
        ? {
            step,
            status: "ok" as const,
            message:
              step === "dns"
                ? `${host}.east-ridge.contoso-corp.example.com resolves to 10.0.0.203, fe80::1ff:fe23:4567:890a`
                : `${step} is fine for ${host}`,
          }
        : i === failAt
          ? {
              step,
              status: "fail" as const,
              code: Code.HOST_KEY_CHANGED,
              message: `${host}'s host key changed since roster recorded it`,
              details: HOST_KEY_CHANGED_OUTPUT,
              data: { recorded: SHA_RECORDED, offered: SHA_OFFERED },
            }
          : { step, status: "skipped" as const, message: "an earlier step failed" },
    ),
  };
}

/** The backend couldn't start: a long message, an unbreakable path in the hint and a long detail. */
export const WORST_START_PROBLEM = {
  kind: "inventory-not-found" as const,
  message: `roster couldn't load the Inventory: ${LONG_PATH} has an error on line 1284 (mapping values are not allowed here; the key 'server-10-0-0-202-very-long-discovered-name' is indented under 'contoso-east-ridge-building-4-servers-and-storage' but its value starts on the same line)`,
  hint: `Fix line 1284 of ${LONG_PATH} (or set ROSTER_CONFIG=/home/aleksandra.wisniewska-kowalczyk/work/yourteam/infra-checkouts/contoso-east-ridge/roster.yml in ~/.profile), then retry.`,
  detail: [
    "Traceback (most recent call last):",
    '  File "/home/aleksandra.wisniewska-kowalczyk/.local/share/uv/tools/roster/lib/python3.13/site-packages/roster/inventory.py", line 212, in load',
    "    data = yaml.safe_load(handle)",
    "yaml.scanner.ScannerError: mapping values are not allowed here",
    `  in "${LONG_PATH}", line 1284, column 61`,
    ...Array.from({ length: 30 }, (_, i) => `    frame ${i + 1}: roster.inventory._resolve_group_with_inherited_defaults_and_overrides(depth=${i})`),
  ].join("\n"),
};

/** Bindings from a Plugin with a long name: long chords, sequences, and keys already taken. */
export const WORST_BINDINGS = {
  source: "roster-telescope-extras-for-the-server-room.nvim",
  tables: {
    leader: { "g h": "find", "Ctrl+Shift+Alt+PageDown": "next", "Ctrl+Shift+Alt+PageUp": "prev", "Space Space": "finder sessions" },
    global: { "Ctrl+Alt+Shift+F12": "focus" },
  },
};

/** The vault CLI isn't logged in, in roster's words, with a long server URL and command. */
export const WORST_VAULT_MESSAGE =
  "Bitwarden CLI isn't logged in on this box (aleksandra-wisniewska-thinkpad-p16-gen2-fedoralinux-44) - run `bw config server https://vault.east-ridge.contoso-corp.example.com && bw login bartholomew.fitzgerald@northwind-industries-holdings.example.com --method 0` once, then `roster sync`";
