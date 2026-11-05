// The add-Host form's logic (ticket 11), apart from React: the draft as typed, what's wrong with
// each field, the Vault item names to suggest, and `host.add`'s params. roster checks everything
// again; this only saves a round trip. The typed password is never part of the draft: it lives in
// its input until the call (as the lock screen's master password does).
import type { AddHostParams, HostList, SaveTo, VaultItemFields } from "../backend/types";

/** How the new Host logs in: a password typed now (saved to the vault after the test login), an
 * existing Vault item, or none yet (added unreviewed, as discover adds Hosts). */
export type LoginWay = "password" | "item" | "none";

export interface AddDraft {
  name: string;
  address: string;
  group: string;
  type: string;
  title: string;
  user: string;
  port: string;
  login: LoginWay;
  /** The Vault item: the new one's name (password), or the existing one's reference (item). */
  item: string;
  enroll: boolean;
}

export type AddField = "name" | "address" | "group" | "type" | "title" | "user" | "port" | "item";

/** roster's rule for Host and group names (roster.yml's NAME_RE). */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function emptyDraft(group: string): AddDraft {
  return { name: "", address: "", group, type: "", title: "", user: "", port: "22", login: "password", item: "", enroll: false };
}

/** The Vault item a typed password is saved as when the item field is left empty: `<host> ssh`. */
export const defaultItem = (name: string) => `${name.trim() || "<host>"} ssh`;

/** The existing item a Login points at when the field is left empty: `bw:<host> ssh`. */
export const defaultRef = (name: string, provider = "bw") => `${provider}:${defaultItem(name)}`;

/** What's wrong with a field's text, or null. */
export function addProblem(field: AddField, draft: AddDraft, hosts: HostList): string | null {
  const t = draft[field].trim();
  switch (field) {
    case "name": {
      if (t === "") return "Can't be empty";
      if (!NAME_RE.test(t)) return "Letters, digits, . _ - only, starting with a letter or digit";
      const there = hosts.hosts.find((h) => h.name === t);
      return there ? `Already a Host, in ${there.group}` : null;
    }
    case "group":
      if (t === "") return "Can't be empty";
      return NAME_RE.test(t) ? null : "Letters, digits, . _ - only, starting with a letter or digit";
    case "address":
    case "user":
      return t === "" ? "Can't be empty" : /\s/.test(t) ? "Can't contain spaces" : null;
    case "port":
      return /^\d+$/.test(t) && Number(t) >= 1 && Number(t) <= 65535 ? null : "A number from 1 to 65535";
    case "item":
      if (draft.login === "item" && t !== "" && !/^[\w.-]+:\S/.test(t)) return "A vault reference, like bw:esx-02 ssh";
      if (draft.login === "password" && t.includes(":")) return "Just the item's name, without a provider:";
      return null;
    default:
      return null;
  }
}

/** Every field's problem, in the form's order (the first is where focus goes). */
export function problemsOf(draft: AddDraft, hosts: HostList): [AddField, string][] {
  const fields: AddField[] = ["name", "address", "group", "user", "port", "item"];
  return fields.flatMap((f) => {
    const p = addProblem(f, draft, hosts);
    return p ? [[f, p] as [AddField, string]] : [];
  });
}

export const isNewGroup = (draft: AddDraft, hosts: HostList) => draft.group.trim() !== "" && !(draft.group.trim() in hosts.groups);

/** Vault item names that follow `<host> <what it opens>` (docs/adding-hosts.md) for the Login
 * field: the new item's name for a typed password, or references for an existing item, then the
 * Inventory's own references that could fit (the Host's name in them, or a `shared` one). */
export function itemSuggestions(draft: AddDraft, hosts: HostList): string[] {
  const name = draft.name.trim();
  const own = name ? [`${name} ssh`, `${name} ssh+web`, `${name} root`] : [];
  if (draft.login === "password") return own;
  const refs = new Set<string>(own.map((n) => `bw:${n}`));
  for (const h of hosts.hosts) {
    const ref = h.ssh.auth;
    if (!ref.includes(":")) continue;
    const item = ref.slice(ref.indexOf(":") + 1);
    if ((name && item.startsWith(`${name} `)) || item.startsWith("shared ")) refs.add(ref);
  }
  return [...refs];
}

/** `host.add`'s params for the draft (null while a field is invalid). The password is passed in
 * at the call, never kept with the draft; `saveTo` is the "Save to" choice (ticket 35), if any. */
export function addParams(draft: AddDraft, hosts: HostList, password?: string, saveTo?: SaveTo): AddHostParams | null {
  if (problemsOf(draft, hosts).length) return null;
  const text = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");
  const name = draft.name.trim();
  const params: AddHostParams = {
    name,
    group: draft.group.trim(),
    address: draft.address.trim(),
    user: draft.user.trim(),
    port: Number(draft.port.trim()),
    enroll: draft.enroll,
    ...(text(draft.type) ? { type: text(draft.type) } : {}),
    ...(text(draft.title) ? { title: text(draft.title) } : {}),
  };
  if (draft.login === "password") {
    return {
      ...params,
      password: password ?? "",
      item: text(draft.item) || defaultItem(name),
      ...(saveTo ? { save_to: saveTo } : {}),
    };
  }
  if (draft.login === "item") return { ...params, auth: draft.item.trim() || defaultRef(name) };
  return params;
}

/** An address compared about as roster add does (decision Q190 (c)): a name without case or a final
 * dot. IPs are compared as typed (roster add parses them: `::1` is `0:0::1` there), which is enough
 * for a warning. */
const sameText = (a: string) => a.trim().toLowerCase().replace(/\.$/, "");

/** The Hosts already at the draft's address and SSH port (#437). The form only warns: two Hosts at
 * one address can be two Logins to one machine (Q190 (c)); `roster add` refuses it (184). */
export function sameAddress(draft: AddDraft, hosts: HostList): string[] {
  const address = sameText(draft.address);
  const port = draft.port.trim();
  if (address === "" || /\s/.test(address) || !/^\d+$/.test(port)) return [];
  return hosts.hosts.filter((h) => sameText(h.ip) === address && h.ssh.port === Number(port)).map((h) => h.name);
}

/** The vault item the draft's Login names (or would, left empty), as `vault.item_fields` takes it:
 * without a `#field` (the Login keeps it). Null unless it's an existing item's reference, and while
 * neither the Name nor the Vault item says which item. */
export function itemRef(draft: AddDraft): { provider: string; item: string } | null {
  if (draft.login !== "item" || (draft.item.trim() === "" && draft.name.trim() === "")) return null;
  const ref = draft.item.trim() || defaultRef(draft.name);
  const [, provider, rest] = /^([\w.-]+):(\S.*)$/.exec(ref) ?? [];
  const item = rest?.split("#")[0]?.trim();
  return provider && item ? { provider, item } : null;
}

export type FilledField = "address" | "port" | "user";

/** The draft with what the vault item says filled in, and which fields that changed. A field the
 * item doesn't have keeps what was typed. */
export function filled(draft: AddDraft, fields: VaultItemFields): { draft: AddDraft; changed: FilledField[] } {
  const from: Record<FilledField, string | undefined> = {
    address: fields.address,
    port: fields.port === undefined ? undefined : String(fields.port),
    user: fields.user,
  };
  const changed = (Object.keys(from) as FilledField[]).filter((f) => from[f] !== undefined && from[f] !== draft[f]);
  return { draft: { ...draft, ...Object.fromEntries(changed.map((f) => [f, from[f]])) }, changed };
}
