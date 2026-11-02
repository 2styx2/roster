// folders.yml (decision Q46, retired by Q93): where the Folders made in the app lived, next to
// init.lua, before Folders became a built-in Plugin with its own data folder (ticket 61). The app
// still reads it, never writes it: at start it parses it here and hands the Folders to the
// Folders Plugin, which moves them in once, when it has none of its own yet. A file that doesn't
// parse moves nothing (the Plugin says the line in :check), so nothing is lost while it's fixed.
//
//   Lab ESXi:
//     - esxi-02
//     - esxi-03
//   Night shift: []
import { isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";
import { parseFolders, STATE_KEY, type Folder } from "./folders";

export const FOLDERS_FILE = "folders.yml";

/** Why the text isn't Folders, at a line (from 1) when there's one to point at. */
export interface FoldersError {
  line: number | null;
  message: string;
}

export type Parsed = { folders: Folder[] } | { error: FoldersError };

/** folders.yml's text as Folders, or what's wrong with it (the first problem). */
export function parseFoldersYml(text: string): Parsed {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, uniqueKeys: false });
  const err = doc.errors[0];
  if (err) return { error: { line: err.linePos?.[0].line ?? null, message: (err.message.split("\n")[0] ?? err.message).replace(/ at line \d+, column \d+:?$/, "") } };
  const at = (node: unknown) => {
    const range = (node as { range?: [number, number, number] } | null)?.range;
    return range ? lines.linePos(range[0]).line : null;
  };
  const contents = doc.contents;
  if (contents === null || (isScalar(contents) && contents.value === null)) return { folders: [] };
  if (!isMap(contents)) return { error: { line: at(contents), message: "folders.yml should be Folder names, each with its list of Hosts" } };
  const seen = new Set<string>();
  const folders: Folder[] = [];
  for (const pair of contents.items) {
    const key = pair.key;
    const name = isScalar(key) ? String(key.value ?? "").trim() : "";
    if (!name) return { error: { line: at(key), message: "a Folder needs a name" } };
    if (name.includes('"')) return { error: { line: at(key), message: `the Folder name ${name} can't contain a double quote` } };
    if (seen.has(name.toLowerCase())) return { error: { line: at(key), message: `there are two Folders named ${name}` } };
    seen.add(name.toLowerCase());
    const value = pair.value;
    let hosts: string[] = [];
    if (isSeq(value)) {
      for (const item of value.items) {
        if (!isScalar(item) || typeof item.value !== "string" || !item.value.trim()) {
          return { error: { line: at(item), message: `${name}: each Host is a name (a line like "- esxi-02")` } };
        }
        hosts.push(item.value.trim());
      }
    } else if (!(value === null || (isScalar(value) && value.value === null))) {
      return { error: { line: at(value), message: `${name}: its Hosts should be a list ("- esxi-02" lines, or [] for none)` } };
    }
    hosts = [...new Set(hosts)];
    folders.push({ name, hosts });
  }
  return { folders };
}

/** What the Folders Plugin is handed as `roster.plugin.config` at each load (ticket 61):
 * init.lua's Folders (`fixed`), and the Folders to move in once when it has none of its own
 * yet (`import`, from folders.yml, else from the State of before folders.yml), or why folders.yml
 * can't be read (`import_error`: then nothing moves, so nothing is lost). */
export async function foldersSettings(
  fixed: { list(): readonly { name: string; hosts: readonly string[]; source: string }[] },
  source: { read(): Promise<{ path: string; text: string | null }> } | undefined,
  state: { load(): Promise<void>; get(key: string): unknown },
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { fixed: fixed.list().map((f) => ({ name: f.name, hosts: [...f.hosts], source: f.source })) };
  const file = source ? await source.read().catch(() => null) : null;
  if (file?.text != null) {
    const parsed = parseFoldersYml(file.text);
    out.import_from = FOLDERS_FILE;
    if ("error" in parsed) {
      const { line, message } = parsed.error;
      out.import_error = `${FOLDERS_FILE}${line ? `:${line}` : ""} has an error (${message}): fix it and they move in at the next start`;
    } else out.import = parsed.folders;
    return out;
  }
  await state.load();
  const old = parseFolders(state.get(STATE_KEY));
  if (old.length > 0) {
    out.import = old;
    out.import_from = "the State";
  }
  return out;
}
