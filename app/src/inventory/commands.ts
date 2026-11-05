// The Live Inventory's commands (ticket 28, decision Q45): `:host add|remove|rename|move|review|unreview` and
// `:group new|rename|delete`. Every Sidebar action for Hosts and groups (`+` on a group heading,
// the row buttons, dragging a Host to another group, the `␣` keys) runs one of these lines, so
// they work the same in Standard and Focus. What's left out comes from the Sidebar's cursor (or the
// Session on screen), and a line that still needs a name opens the command line with the rest
// typed in. Each change is a Pending change in roster.yml, made by `roster serve`.
import type { CommandContext, CommandDef } from "../commands/table";
import { BUILTIN } from "../registry";

/** What the app does for these commands (App's CommandContext). */
export type InventoryOp =
  | { op: "remove"; host: string }
  | { op: "rename"; host: string; to: string }
  | { op: "move"; host: string; group: string }
  | { op: "group-new"; name: string }
  | { op: "group-rename"; group: string; to: string }
  | { op: "group-delete"; group: string; to?: string };

export const HOST_SUBCOMMANDS = ["add", "remove", "rename", "move", "review", "unreview"] as const;
export const GROUP_SUBCOMMANDS = ["new", "rename", "delete"] as const;

const words = (text: string | undefined) => (text ?? "").trim().split(/\s+/).filter(Boolean);

/** The group under the Sidebar's cursor: a group heading, or a Host row in a group. */
const cursorGroup = (ctx: CommandContext) => ctx.cursorRow()?.data?.group ?? null;

function runHost(ctx: CommandContext, arg: string | undefined) {
  const [sub, a, b, ...rest] = words(arg);
  const what = sub?.toLowerCase();
  if (what === "add") return ctx.addHost(a ?? cursorGroup(ctx) ?? undefined);
  if (what === "review" || what === "unreview") {
    if (b) return ctx.say(`host ${what} takes one Host`);
    return ctx.review(a ?? null, what === "review");
  }
  if (what !== "remove" && what !== "rename" && what !== "move") {
    return ctx.say(`host takes ${HOST_SUBCOMMANDS.join(", ")} (not ${sub ?? "nothing"})`);
  }
  if (rest.length) return ctx.say(`host ${what} takes a Host and ${what === "move" ? "a group" : "a name"}, no more`);
  const host = a ?? ctx.selectedHost();
  if (!host) return ctx.say(`No Host selected: move to one in the Sidebar, or use host ${what} HOST`);
  if (!ctx.hostNames().includes(host)) return ctx.say(`No Host named ${host}`);
  if (what === "remove") return b ? ctx.say("host remove takes one Host") : ctx.inventory({ op: "remove", host });
  if (!b) return ctx.openCommandLine(`host ${what} ${host} `);
  if (what === "rename") return ctx.inventory({ op: "rename", host, to: b });
  ctx.inventory({ op: "move", host, group: b });
}

function runGroup(ctx: CommandContext, arg: string | undefined) {
  const [sub, a, b, ...rest] = words(arg);
  const what = sub?.toLowerCase();
  if (what !== "new" && what !== "rename" && what !== "delete") {
    return ctx.say(`group takes ${GROUP_SUBCOMMANDS.join(", ")} (not ${sub ?? "nothing"})`);
  }
  if (rest.length || (what === "new" && b)) return ctx.say("Group names have no spaces (letters, digits, . _ -)");
  if (what === "new") return a ? ctx.inventory({ op: "group-new", name: a }) : ctx.openCommandLine("group new ");
  const group = a ?? cursorGroup(ctx);
  if (!group) return ctx.say(`No group selected: move to one in the Sidebar, or use group ${what} GROUP`);
  if (!ctx.groupNames().includes(group)) return ctx.say(`No group named ${group}`);
  if (what === "rename") return b ? ctx.inventory({ op: "group-rename", group, to: b }) : ctx.openCommandLine(`group rename ${group} `);
  ctx.inventory(b ? { op: "group-delete", group, to: b } : { op: "group-delete", group });
}

const startsWith = (word: string) => (s: string) => s.toLowerCase().startsWith(word.toLowerCase());

function completeHost(arg: string, hostNames: readonly string[], groupNames: readonly string[]): string[] {
  const parts = arg.split(/\s+/);
  const [sub = "", host = "", group = ""] = parts;
  if (parts.length === 1) return HOST_SUBCOMMANDS.filter(startsWith(sub)).map((s) => (s === "add" ? s : `${s} `));
  if (sub === "add") return parts.length === 2 ? groupNames.filter(startsWith(host)).map((g) => `add ${g}`) : [];
  if (parts.length === 2 && (HOST_SUBCOMMANDS as readonly string[]).includes(sub)) {
    const last = sub === "remove" || sub === "review" || sub === "unreview";
    return [...hostNames].sort().filter(startsWith(host)).map((h) => `${sub} ${h}${last ? "" : " "}`);
  }
  if (parts.length === 3 && sub === "move") return groupNames.filter(startsWith(group)).map((g) => `move ${host} ${g}`);
  return [];
}

function completeGroup(arg: string, groupNames: readonly string[]): string[] {
  const parts = arg.split(/\s+/);
  const [sub = "", group = "", to = ""] = parts;
  if (parts.length === 1) return GROUP_SUBCOMMANDS.filter(startsWith(sub)).map((s) => `${s} `);
  if (sub === "new") return [];
  if (parts.length === 2) return groupNames.filter(startsWith(group)).map((g) => `${sub} ${g}${sub === "rename" ? " " : ""}`);
  if (parts.length === 3 && sub === "delete") {
    return groupNames.filter((g) => g !== group).filter(startsWith(to)).map((g) => `delete ${group} ${g}`);
  }
  return [];
}

export const hostCommand: CommandDef = {
  id: "host",
  source: BUILTIN,
  area: "Inventory",
  arg: "text",
  label: (arg) => {
    const [sub, host] = words(arg);
    if (sub === "add") return host ? `Add a Host to ${host}` : "Add a Host";
    if (sub === "remove") return host ? `Remove ${host} from the Inventory (asks first)` : "Remove a Host from the Inventory (asks first)";
    if (sub === "rename") return host ? `Rename ${host}` : "Rename a Host";
    if (sub === "move") return host ? `Move ${host} to another group` : "Move a Host to another group";
    if (sub === "review") return host ? `Mark ${host} reviewed` : "Mark a Host reviewed, so it can be opened";
    if (sub === "unreview") return host ? `Mark ${host} unreviewed` : "Mark a Host unreviewed again";
    return "Hosts: add, remove, rename, move, review, unreview";
  },
  run: runHost,
  complete: (arg, hosts, ctx) => completeHost(arg, hosts, ctx?.groupNames ?? []),
};

export const groupCommand: CommandDef = {
  id: "group",
  source: BUILTIN,
  area: "Inventory",
  arg: "text",
  label: (arg) => {
    const [sub, group] = words(arg);
    if (sub === "new") return "New group";
    if (sub === "rename") return group ? `Rename group ${group}` : "Rename a group";
    if (sub === "delete") return group ? `Delete group ${group}` : "Delete a group (asks where its Hosts go)";
    return "Groups: new, rename, delete";
  },
  run: runGroup,
  complete: (arg, _hosts, ctx) => completeGroup(arg, ctx?.groupNames ?? []),
};

/** `:review` and `:unreview`: `:host review` and `:host unreview`, for short. */
const review = (reviewed: boolean): CommandDef => ({
  id: reviewed ? "review" : "unreview",
  source: BUILTIN,
  area: "Inventory",
  arg: "host",
  optionalArg: true,
  label: (h) =>
    reviewed
      ? h ? `Mark ${h} reviewed` : "Mark a Host reviewed, so it can be opened"
      : h ? `Mark ${h} unreviewed` : "Mark a Host unreviewed again (a review made by mistake)",
  run: (ctx, h) => runHost(ctx, `${reviewed ? "review" : "unreview"} ${h ?? ""}`),
});

export const reviewCommand = review(true);
export const unreviewCommand = review(false);
