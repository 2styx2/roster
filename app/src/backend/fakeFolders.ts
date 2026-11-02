// The built-in Folders Plugin (ticket 61, decision Q93) for the fake Backend, as
// crates/roster-core/plugins/folders/init.lua writes it: the same section, `folder` command,
// completion, keys, finder and `:check` lines, its Folders in its own data folder
// (`roster.storage`), and folders.yml's (or the State's) moved in once. The Lua is the source;
// tests/folders_plugin.rs drives that, and this mirrors it for the UI tests and the browser.
import { addToFolder, createFolder, deleteFolder, parseFolders, quote, removeFromFolder, renameFolder, splitName, type Folder, type Outcome } from "../folders/folders";
import type { FakePlugin, FakeRoster } from "./fakePlugins";

const FILE = "folders.json";
const SECTION = "folders";
const SUBCOMMANDS = ["new", "rename", "delete", "add", "remove"] as const;

const firstWord = (text: string): [string, string] => {
  const t = text.trim();
  const space = t.search(/\s/);
  return space < 0 ? [t, ""] : [t.slice(0, space), t.slice(space).trim()];
};

const unquote = (s: string) => {
  const t = s.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
};

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

type Ctx = Record<string, unknown>;

export const fakeFoldersPlugin: FakePlugin = {
  manifest: {
    name: "folders",
    version: "1.0.0",
    description: "The Sidebar's Folders: your own groupings of Hosts",
    author: "roster",
    api: 4,
    permissions: ["inventory.read"],
  },
  load(roster: FakeRoster) {
    const config = roster.plugin.config;
    const rawFixed = Array.isArray(config.fixed) ? (config.fixed as { name?: unknown; source?: unknown }[]) : [];
    const fixed = parseFolders(rawFixed).map((f) => {
      const source = rawFixed.find((g) => g.name === f.name)?.source;
      return { ...f, source: typeof source === "string" ? source : "init.lua" };
    });
    const fixedNamed = (name: string) => fixed.find((f) => f.name.toLowerCase() === name.trim().toLowerCase());
    let folders: Folder[] = [];
    let problem: string | null = null;
    let blocked: string | null = null;
    let moved: { from: string; n: number } | null = null;

    const save = () => {
      try {
        roster.storage.write_json(FILE, folders);
        problem = null;
        return true;
      } catch (e) {
        problem = `can't save the Folders: ${e instanceof Error ? e.message : String(e)}`;
        return false;
      }
    };

    try {
      const data = roster.storage.read_json(FILE);
      if (data !== null && data !== undefined) folders = parseFolders(data);
      else if (typeof config.import_error === "string") problem = blocked = config.import_error;
      else if (Array.isArray(config.import)) {
        folders = parseFolders(config.import);
        const from = typeof config.import_from === "string" ? config.import_from : "folders.yml";
        if (save()) {
          moved = { from, n: folders.length };
          if (folders.length > 0) {
            // A result that needs attention: it shows whatever ui.messages says (ticket 117).
            roster.notify(`Moved ${count(folders.length, "Folder")} from ${from} into roster's own data${from === "folders.yml" ? ": folders.yml isn't read any more (:check)" : ""}`, "info", {
              quiet: false,
            });
          }
        }
      }
    } catch (e) {
      problem = blocked = e instanceof Error ? e.message : String(e);
    }

    let names: string[] | null = null;
    const hostNames = () => {
      if (!roster.inventory) return null;
      names ??= roster.inventory.hosts().map((h) => h.name);
      return names;
    };
    const isHost = (name: string) => hostNames()?.includes(name) ?? true;

    let rowsOf = new Map<string, { folder: string; host?: string }>();
    const show = () => {
      rowsOf = new Map();
      const rows: Record<string, unknown>[] = [];
      let shown = 0;
      const folderRows = (f: Folder & { source?: string }, own: boolean) => {
        shown += 1;
        rowsOf.set(f.name, { folder: f.name });
        const head: Record<string, unknown> = { id: f.name, label: f.name, icon: "folder", fold: true };
        if (own) {
          head.count = f.hosts.length;
          head.drop = (e: Ctx) => {
            if (typeof e.dropped === "string") roster.cmd(`folder add ${e.dropped} ${f.name}`);
          };
          head.actions = [
            { label: `Rename ${f.name}`, icon: "edit", run: `folder rename ${quote(f.name)}` },
            { label: `Delete Folder ${f.name}`, icon: "close", run: `folder delete ${f.name}` },
          ];
        } else {
          head.detail = String(f.hosts.length);
          head.note = `from ${f.source}`;
          head.title = `Defined in ${f.source}: change it there`;
        }
        rows.push(head);
        for (const h of f.hosts) {
          const id = `${f.name}/${h}`;
          rowsOf.set(id, { folder: f.name, host: h });
          const row: Record<string, unknown> = { id, label: h, host: h, kind: "host", level: 1, note: "not in the Inventory" };
          if (own) {
            row.drop = head.drop;
            row.drag_out = `folder remove ${h} ${f.name}`;
            row.actions = [{ label: `Remove ${h} from ${f.name}`, icon: "close", run: `folder remove ${h} ${f.name}` }];
          }
          rows.push(row);
        }
      };
      for (const f of fixed) folderRows(f, false);
      for (const f of folders) if (!fixedNamed(f.name)) folderRows(f, true);
      roster.sidebar.set(SECTION, {
        title: "Folders",
        order: 200,
        count: shown,
        empty: problem ? `Folders can't be read: ${problem}` : "No Folders yet. Drag a Host here or press `␣ a`.",
        actions: [{ label: "New Folder", icon: "add", run: "folder new" }],
        drop: (e: Ctx) => {
          if (typeof e.dropped === "string") roster.cmdline(`folder add ${e.dropped} `);
        },
        rows,
      });
    };

    const allNames = () => [...fixed.map((f) => f.name), ...folders.map((f) => f.name)];

    const run = (a: Ctx) => {
      const say = (text: string) => roster.echo(text);
      const [sub, rest] = firstWord(typeof a.args === "string" ? a.args : "");
      const at = a.section === SECTION && typeof a.row === "string" ? rowsOf.get(a.row) : undefined;
      const apply = (o: Outcome) => {
        if ("error" in o) return say(o.error);
        const before = folders;
        folders = o.folders;
        if (!save()) {
          folders = before;
          return say(problem ?? "can't save the Folders");
        }
        show();
        // A routine confirmation: quiet, as roster's own (api 4, ticket 118).
        roster.echo(o.message, { quiet: true });
      };
      if (blocked && sub !== "") return say(`Folders can't be changed until they can be read: ${blocked}`);
      const fromConfig = (name: string) => {
        const f = fixedNamed(name);
        if (!f) return false;
        say(`${f.name} is defined in ${f.source}: change it there`);
        return true;
      };
      switch (sub) {
        case "new":
          if (!rest) return roster.cmdline("folder new ");
          if (fromConfig(unquote(rest))) return;
          return apply(createFolder(folders, unquote(rest)));
        case "rename": {
          if (!rest) return at ? roster.cmdline(`folder rename ${quote(at.folder)} `) : say("folder rename needs a Folder name and a new name");
          const [name, to] = splitName(rest, allNames());
          if (fromConfig(name)) return;
          if (!to) return roster.cmdline(`folder rename ${quote(name)} `);
          if (fromConfig(unquote(to))) return;
          return apply(renameFolder(folders, name, unquote(to)));
        }
        case "delete": {
          const name = rest ? unquote(rest) : at?.folder;
          if (!name) return say("folder delete needs a Folder name");
          if (fromConfig(name)) return;
          return apply(deleteFolder(folders, name));
        }
        case "add": {
          const [given, name] = firstWord(rest);
          const host = given || (typeof a.host === "string" ? a.host : "");
          if (!host) return say("No Host selected: move to one in the Sidebar, or use folder add HOST NAME");
          if (!isHost(host)) return say(`No Host named ${host}`);
          if (!name) return roster.cmdline(`folder add ${host} `);
          if (fromConfig(unquote(name))) return;
          return apply(addToFolder(folders, host, unquote(name)));
        }
        case "remove": {
          if (!rest) {
            if (!at?.host) return say("Move to a Host in a Folder first, or use folder remove HOST NAME");
            if (fromConfig(at.folder)) return;
            return apply(removeFromFolder(folders, at.host, at.folder));
          }
          const [host, name] = firstWord(rest);
          if (!name) return say("folder remove needs a Host and a Folder name");
          if (fromConfig(unquote(name))) return;
          return apply(removeFromFolder(folders, host, unquote(name)));
        }
        default:
          return say(`folder: say ${SUBCOMMANDS.join(", ")}`);
      }
    };

    const complete = (arg: string): string[] => {
      const space = arg.search(/\s/);
      if (space < 0) return SUBCOMMANDS.filter((s) => s.startsWith(arg)).map((s) => `${s} `);
      const sub = arg.slice(0, space);
      const rest = arg.slice(space).trimStart();
      const starts = (word: string) => (s: string) => s.toLowerCase().startsWith(word.toLowerCase());
      if (sub === "rename" || sub === "delete") {
        return folders.map((f) => f.name).filter(starts(rest)).map((n) => `${sub} ${sub === "rename" ? `${quote(n)} ` : n}`);
      }
      if (sub !== "add" && sub !== "remove") return [];
      const hostSpace = rest.search(/\s/);
      if (hostSpace < 0) {
        const pool = sub === "remove" ? [...new Set(folders.flatMap((f) => f.hosts))] : (hostNames() ?? []);
        return pool.filter(starts(rest)).slice(0, 200).map((h) => `${sub} ${h} `);
      }
      const host = rest.slice(0, hostSpace);
      const word = rest.slice(hostSpace).trimStart();
      return folders
        .filter((f) => (sub === "remove") === f.hosts.includes(host))
        .map((f) => f.name)
        .filter(starts(word))
        .map((n) => `${sub} ${host} ${n}`);
    };

    roster.commands.add("folder", { desc: "Folders: new, rename, delete, add, remove", run, complete });
    roster.keymap.set("leader", "a", "folder add");
    roster.keymap.set("leader", "A", "folder remove");
    roster.finders.set(SECTION, { title: "Find in the Folders", prompt: "Folders", section: SECTION });
    if (roster.has("inventory.read")) {
      roster.on("inventory_changed", () => {
        names = null;
      });
    }
    roster.health.set(SECTION, {
      title: "Folders",
      check: () => {
        const lines: Record<string, string>[] = [];
        if (problem) lines.push({ level: "error", message: problem, fix: "fix folders.yml (it's moved in once it reads), or see :plugins" });
        else lines.push({ level: "ok", message: `${count(folders.length, "Folder")} of yours, in roster's own data (plugin-data/folders)` });
        if (moved) lines.push({ level: "ok", message: `Moved ${count(moved.n, "Folder")} in from ${moved.from} at this start` });
        if (config.import_from === "folders.yml" && !moved && !problem) {
          lines.push({
            level: "warn",
            message: "folders.yml is still in your config folder, but it isn't read any more: your Folders moved into roster's own data",
            fix: "delete folders.yml once your Folders look right",
          });
        }
        if (!roster.has("inventory.read")) lines.push({ level: "warn", message: "inventory.read isn't granted, so Host names aren't checked or completed", fix: "allow it in :plugins" });
        return lines;
      },
    });
    show();
  },
};
