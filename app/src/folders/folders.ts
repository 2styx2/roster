// Folders (GLOSSARY): the user's own groupings of Hosts. Never sent to `roster serve`, never in
// roster.yml (decision Q34).
//
// Folders is a built-in Plugin on the public API (ticket 61, decision Q93):
// crates/roster-core/plugins/folders/init.lua draws the section, runs the `folder` command and
// its keys, and keeps the Folders you make in its own data folder (`roster.storage`). This module
// is what's left on the app's side: the Folder model the fake Backend's copy of that Plugin
// (backend/fakeFolders.ts) shares, the State's old `folders` key (parseFolders, for moving them
// in once), and the `folders` registry init.lua's Folders go into (config/apply.ts), which the
// app hands the Plugin as its settings.
//
//   folder new NAME            folder rename NAME NEW     folder delete NAME
//   folder add [HOST [NAME]]   folder remove [HOST NAME]
import { Registry, type Entry } from "../registry";

export interface Folder {
  name: string;
  /** Host names, in the order they were added. */
  hosts: string[];
}

/** A Folder from the Config or a Plugin (read-only in the app). Its id is the name, lower case. */
export interface FolderEntry extends Entry {
  name: string;
  hosts: string[];
}

export type FolderRegistry = Registry<FolderEntry>;

/** The State key Folders were kept under before folders.yml (moved in once, ticket 61). */
export const STATE_KEY = "folders";

/** The Folders from the State (untrusted); anything malformed is dropped. */
export function parseFolders(json: unknown): Folder[] {
  if (!Array.isArray(json)) return [];
  const seen = new Set<string>();
  const out: Folder[] = [];
  for (const f of json) {
    if (typeof f !== "object" || f === null) continue;
    const { name, hosts } = f as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim() || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const list = Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === "string") : [];
    out.push({ name, hosts: [...new Set(list)] });
  }
  return out;
}

/** What a change did: the new Folders and what to tell the user, or why it can't. */
export type Outcome = { folders: Folder[]; message: string } | { error: string };

const find = (folders: readonly Folder[], name: string) =>
  folders.find((f) => f.name.toLowerCase() === name.trim().toLowerCase());

function badName(name: string): string | null {
  if (!name.trim()) return "A Folder needs a name";
  if (name.includes('"')) return "A Folder name can't contain a double quote";
  return null;
}

export function createFolder(folders: readonly Folder[], name: string): Outcome {
  const bad = badName(name);
  if (bad) return { error: bad };
  if (find(folders, name)) return { error: `There's already a Folder named ${name.trim()}` };
  return { folders: [...folders, { name: name.trim(), hosts: [] }], message: `Created Folder ${name.trim()}` };
}

export function renameFolder(folders: readonly Folder[], name: string, to: string): Outcome {
  const folder = find(folders, name);
  if (!folder) return { error: `No Folder named ${name}` };
  const bad = badName(to);
  if (bad) return { error: bad };
  const clash = find(folders, to);
  if (clash && clash !== folder) return { error: `There's already a Folder named ${to.trim()}` };
  return {
    folders: folders.map((f) => (f === folder ? { ...f, name: to.trim() } : f)),
    message: `Renamed Folder ${folder.name} to ${to.trim()}`,
  };
}

export function deleteFolder(folders: readonly Folder[], name: string): Outcome {
  const folder = find(folders, name);
  if (!folder) return { error: `No Folder named ${name}` };
  return { folders: folders.filter((f) => f !== folder), message: `Deleted Folder ${folder.name}` };
}

/** Adds a Host to a Folder, creating the Folder if there isn't one by that name. */
export function addToFolder(folders: readonly Folder[], host: string, name: string): Outcome {
  const folder = find(folders, name);
  if (!folder) {
    const created = createFolder(folders, name);
    if ("error" in created) return created;
    return addToFolder(created.folders, host, name);
  }
  if (folder.hosts.includes(host)) return { error: `${host} is already in ${folder.name}` };
  return {
    folders: folders.map((f) => (f === folder ? { ...f, hosts: [...f.hosts, host] } : f)),
    message: `Added ${host} to ${folder.name}`,
  };
}

export function removeFromFolder(folders: readonly Folder[], host: string, name: string): Outcome {
  const folder = find(folders, name);
  if (!folder) return { error: `No Folder named ${name}` };
  if (!folder.hosts.includes(host)) return { error: `${host} isn't in ${folder.name}` };
  return {
    folders: folders.map((f) => (f === folder ? { ...f, hosts: f.hosts.filter((h) => h !== host) } : f)),
    message: `Removed ${host} from ${folder.name}`,
  };
}

/** Quotes a name that has spaces, for a command line that names it before something else. */
export const quote = (name: string) => (/\s/.test(name) ? `"${name}"` : name);

/** Splits "NAME REST" where NAME may be quoted, or an existing Folder's name with spaces. */
export function splitName(text: string, names: readonly string[]): [string, string] {
  const t = text.trim();
  if (t.startsWith('"')) {
    const end = t.indexOf('"', 1);
    if (end > 0) return [t.slice(1, end), t.slice(end + 1).trim()];
  }
  const lower = t.toLowerCase();
  const known = [...names]
    .sort((a, b) => b.length - a.length)
    .find((n) => lower === n.toLowerCase() || lower.startsWith(`${n.toLowerCase()} `));
  if (known) return [t.slice(0, known.length), t.slice(known.length).trim()];
  const space = t.search(/\s/);
  return space < 0 ? [t, ""] : [t.slice(0, space), t.slice(space).trim()];
}

/** An empty `folders` registry: init.lua's Folders go into it, for the Folders Plugin. */
export const folderRegistry = (): FolderRegistry => new Registry<FolderEntry>();
