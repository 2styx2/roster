// The Key bindings panel's rows, generated from the resolved keymap, the command table and the
// options: grouped by area, one row per command line and source, with the keys as the user types
// them (␣ is the Leader).
import { describeLine, type Commands } from "../commands/table";
import { defaultOptions, type Keymap, type KeymapContext, type Options } from "../keymap";
import { BUILTIN, CONFIG, type Source } from "../registry";

export interface BindingRow {
  area: string;
  label: string;
  keys: string[];
  source: Source;
  /** Where init.lua changes it (ticket 32): `keys.leader`, `keys.list_vim`, or `leader`. */
  options: string[];
}

/** A keymap context's name in init.lua (`keys.<name>`, docs/app/config.md). */
export const CONTEXT_OPTION: Record<KeymapContext, string> = {
  leader: "keys.leader",
  global: "keys.global",
  list: "keys.list",
  listVim: "keys.list_vim",
  picker: "keys.picker",
  pickerVim: "keys.picker_vim",
  cmdline: "keys.cmdline",
  terminal: "keys.terminal",
};

const NAMES: Record<string, string> = { ArrowDown: "↓", ArrowUp: "↑", Escape: "Esc" };

/** The Picker's, the command line's and the terminal's own actions (not commands). */
const LOCAL: Record<string, { area: string; label: string }> = {
  "picker.down": { area: "Picker", label: "Move down" },
  "picker.up": { area: "Picker", label: "Move up" },
  "picker.next": { area: "Picker", label: "Complete, then next result" },
  "picker.prev": { area: "Picker", label: "Previous result" },
  "picker.choose": { area: "Picker", label: "Open the Host" },
  "picker.chooseHere": { area: "Picker", label: "Reopen here, if its Session ended" },
  "picker.review": { area: "Picker", label: "Mark a Host reviewed" },
  "picker.info": { area: "Picker", label: "Show the Host's details" },
  "picker.help": { area: "Picker", label: "Help on the selected result" },
  "picker.close": { area: "Picker", label: "Close the Picker" },
  "cmdline.next": { area: "Command line", label: "Complete, then cycle" },
  "cmdline.prev": { area: "Command line", label: "Previous completion" },
  "cmdline.accept": { area: "Command line", label: "Accept the completion" },
  "cmdline.run": { area: "Command line", label: "Run, or take the completion" },
  "cmdline.cancel": { area: "Command line", label: "Cancel the completion, then close" },
  "cmdline.help": { area: "Command line", label: "Help on the command typed" },
  "terminal.copy": { area: "Terminal", label: "Copy" },
  "terminal.copyIfSelected": { area: "Terminal", label: "Copy, else send to the shell" },
  "terminal.paste": { area: "Terminal", label: "Paste" },
  "terminal.pasteIfText": { area: "Terminal", label: "Paste text (no text: to the program, Ctrl+V as ^V)" },
  "terminal.search": { area: "Terminal", label: "Find" },
  "terminal.zoomIn": { area: "Terminal", label: "Zoom in" },
  "terminal.zoomOut": { area: "Terminal", label: "Zoom out" },
  "terminal.zoomReset": { area: "Terminal", label: "Reset zoom" },
};

const AREAS = ["Leader", "Hosts", "Sessions", "View", "Sidebar", "App", "Terminal"];

function display(context: KeymapContext, seq: string): string {
  const keys = seq
    .split(" ")
    .map((k) => NAMES[k] ?? k)
    .join(" ");
  // App-mode keys are typed after the Leader, except Esc, which leaves App mode.
  return context === "leader" && seq !== "Escape" ? `␣ ${keys}` : keys;
}

export function bindingRows(keymap: Keymap, options: Options, commands: Commands): BindingRow[] {
  const contexts: KeymapContext[] = options.vim
    ? ["leader", "global", "list", "listVim", "picker", "pickerVim", "cmdline", "terminal"]
    : ["leader", "global", "list", "picker", "cmdline", "terminal"];
  const rows = new Map<string, BindingRow & { rank: number }>();
  const ids = commands.list().map((c) => c.id);
  for (const context of contexts) {
    for (const [seq, { action, source }] of Object.entries(keymap[context])) {
      const local = context === "picker" || context === "pickerVim" || context === "cmdline" || context === "terminal";
      const { area, label } = local ? (LOCAL[action] ?? { area: "Other", label: action }) : describeLine(commands, action);
      const key = `${area}\0${label}\0${source}`;
      const rank = local ? 1000 + Object.keys(LOCAL).indexOf(action) : ids.indexOf(action.split(" ")[0] ?? "");
      const row = rows.get(key) ?? { area, label, keys: [], source, rank, options: [] };
      row.keys.push(display(context, seq));
      if (!row.options.includes(CONTEXT_OPTION[context])) row.options.push(CONTEXT_OPTION[context]);
      rows.set(key, row);
    }
  }
  const areaRank = (a: string) => (a === "Picker" ? 99 : a === "Command line" ? 98 : AREAS.includes(a) ? AREAS.indexOf(a) : 50);
  const sorted = [...rows.values()].sort(
    (a, b) =>
      areaRank(a.area) - areaRank(b.area) ||
      a.rank - b.rank ||
      a.label.localeCompare(b.label, undefined, { numeric: true }) ||
      (a.source === BUILTIN ? -1 : b.source === BUILTIN ? 1 : a.source.localeCompare(b.source)),
  );
  const leader: BindingRow = {
    area: "Leader",
    label: "Leader: leave the terminal",
    keys: [options.leader],
    source: options.leader === defaultOptions.leader ? BUILTIN : CONFIG,
    options: ["leader"],
  };
  return [
    leader,
    ...foldSessionDigits(sorted.map(({ area, label, keys, source, options }) => ({ area, label, keys, source, options }))),
  ];
}

/** The built-in "Go to Session 1" … "9" rows as one: "Go to Session 1–9", "␣ 1…9". */
function foldSessionDigits(rows: BindingRow[]): BindingRow[] {
  const digit = (r: BindingRow) => {
    const m = /^Go to Session (\d)$/.exec(r.label);
    return m && r.source === BUILTIN && r.keys.length === 1 && r.keys[0] === `␣ ${m[1]}` ? Number(m[1]) : null;
  };
  const digits = rows.map(digit).filter((d): d is number => d !== null);
  if (digits.length < 2) return rows;
  const [lo, hi] = [Math.min(...digits), Math.max(...digits)];
  const at = rows.findIndex((r) => digit(r) !== null);
  const folded: BindingRow = { ...(rows[at] as BindingRow), label: `Go to Session ${lo}–${hi}`, keys: [`␣ ${lo}…${hi}`] };
  return rows.flatMap((r, i) => (i === at ? [folded] : digit(r) === null ? [r] : []));
}

export function filterRows(rows: readonly BindingRow[], query: string): BindingRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter((r) => [r.area, r.label, r.source, ...r.keys, ...r.options].some((t) => t.toLowerCase().includes(q)));
}
