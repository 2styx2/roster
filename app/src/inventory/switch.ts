// Switching named Inventories from the app (ticket 115, issue #201 items 6-8): `:inventory NAME`
// (␣ I starts the line) asks first. What it asks, or says instead, is worked out here from
// `inventories.list` and what the switch would affect; App does the switch on confirm (lock the
// vault, `inventories.use`, start serve again, whose start asks roster again which file to use).
// The app never reads roster.yml or inventories.json itself (ADR 0001): serve says it all.
import type { Inventories } from "../backend/types";
import { BUILTIN } from "../registry";
import { countOf } from "../ui/format";
import type { InventoryCommand } from "./commands";

/** What `:inventory NAME` does now: say why not, or ask. */
export type SwitchPlan =
  | { kind: "say"; message: string }
  | {
      kind: "confirm";
      to: string;
      /** The question, and what happens. */
      body: string;
      /** What it affects (or what blocks it), a line each. */
      more: string[];
      /** The confirming button's label; null when something blocks the switch. */
      action: string | null;
    };

/** What comes before the active Inventory in roster's lookup, and so keeps serve where it is. */
const EARLIER = "$ROSTER_CONFIG, a roster.yml in the folder roster starts in, or a -c in roster_command";

/** No named Inventories yet: how to name one. */
export const NONE_NAMED = "No named Inventories: roster inv add NAME PATH names one (:help :inventory)";

/** `:inventory NAME` from serve's list, the open Sessions and the Pending changes. */
export function switchPlan(list: Inventories, to: string, open: { sessions: number; pending: number }): SwitchPlan {
  const names = list.inventories.map((i) => i.name);
  if (names.length === 0) return { kind: "say", message: NONE_NAMED };
  const target = list.inventories.find((i) => i.name === to);
  if (!target) return { kind: "say", message: `No Inventory named ${to} (there's ${names.join(", ")})` };
  if (list.name === to) return { kind: "say", message: `Already on ${to} (${list.path ?? target.path})` };
  if (!target.exists) return { kind: "say", message: `${to}'s roster.yml isn't there: ${target.path}. roster inv remove ${to} forgets it` };
  const from = list.name ?? "this roster.yml";
  const fromOwn = list.name ? `${list.name}'s` : "this";
  // serve runs on another file than the active Inventory's: an earlier step of roster's lookup found
  // it ($ROSTER_CONFIG, or ./roster.yml where roster starts), and it would again after a restart.
  if (list.active !== null && list.name !== list.active) {
    return {
      kind: "confirm",
      to,
      body:
        `roster runs on ${list.path ?? "another file"}, not on the active Inventory (${list.active}): ` +
        `${EARLIER} comes first, so starting roster again ` +
        `wouldn't move it to ${to}.`,
      more: [`Unset ROSTER_CONFIG (or move that roster.yml, or take the -c out of roster_command), then run roster inv use ${to} and start the app again.`],
      action: null,
    };
  }
  const more = [
    open.sessions === 0
      ? "No open Sessions."
      : `${countOf(open.sessions, "open Session")} ${open.sessions === 1 ? "stays" : "stay"} open, marked as ${from}'s.`,
  ];
  if (open.pending > 0) {
    const one = open.pending === 1;
    more.push(
      `${countOf(open.pending, "Pending change")} in ${fromOwn} roster.yml ${one ? "isn't" : "aren't"} published: ` +
        `publish ${one ? "it" : "them"} (:publish) or discard ${one ? "it" : "them"} (:discard) first.`,
    );
  } else {
    more.push("No Pending changes.");
  }
  return {
    kind: "confirm",
    to,
    body: `Switch from ${from} to ${to}? roster restarts on ${to}'s file and locks ${fromOwn} vault.`,
    more,
    action: open.pending > 0 ? null : `Switch to ${to}`,
  };
}

/** What roster runs on after a switch to `to` and a restart, said plainly. */
export function afterSwitch(list: Inventories, to: string): string {
  if (list.name === to) return `Now on the ${to} Inventory (${list.path ?? ""}). Unlock its vault to open Sessions`;
  return (
    `roster started again but runs on ${list.path ?? "another file"}, not ${to}: ${EARLIER} comes first. ` +
    `${to} is the active Inventory`
  );
}

export const inventoryCommand: InventoryCommand = {
  id: "inventory",
  source: BUILTIN,
  area: "Inventory",
  arg: "text",
  optionalArg: true,
  seldom: true,
  label: (name) => (name ? `Switch to the ${name} Inventory (asks first)` : "Switch to another named Inventory (asks first)"),
  doc:
    "Switches roster to another named Inventory (`roster inv add NAME PATH` names one). It asks first, saying what " +
    "happens: roster starts again on that Inventory's file, and the vault locks, since only one Inventory's vault is " +
    "ever unlocked. Open Sessions stay open, marked with the Inventory they came from; roster never fills or " +
    "reconnects them until it runs on theirs again. Pending changes block it until you [:publish](:publish) or " +
    "[:discard](:discard) them. The status bar names the Inventory roster runs on.",
  run: (ctx, arg) => {
    const name = (arg ?? "").trim();
    if (/\s/.test(name)) return ctx.say("inventory takes one name");
    ctx.switchInventory(name || null);
  },
  complete: (word, _hosts, ctx) => (ctx?.inventoryNames ?? []).filter((n) => n.toLowerCase().startsWith(word.toLowerCase())),
};
