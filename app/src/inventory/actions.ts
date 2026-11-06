// The Inventory commands in the workspace (tickets 10, 11, 28): edit or add a Host, review it,
// the Live Inventory's changes, the Pending changes and the pull. The forms open in the one form
// slot (Form); a remove asks first.
import type { Capabilities } from "../backend/capabilities";
import type { Backend, BackendInfo, Host, HostList } from "../backend/types";
import type { ChangesStep } from "../edit/ChangesPanel";
import { afterPull } from "../edit/pull";
import { countOf, errorText } from "../ui/format";
import { quiet, type Message } from "../ui/messages";
import type { InventoryContext } from "./commands";
import { afterChange, reviewedMessage } from "./said";
import { nothingPending } from "./store";
import type { InventoryState } from "./useInventory";

/** The open form: one at a time (ticket 10's edit, 11's add, 15's save, the Pending changes). */
export type Form = { kind: "edit"; host: string } | { kind: "add"; group: string } | { kind: "save"; tab: number } | { kind: "changes"; step: ChangesStep };

export type InventoryActions = Pick<InventoryContext, "inventory" | "review" | "showChanges" | "pull" | "edit" | "addHost">;

export function inventoryActions(o: {
  backend: Backend;
  info: BackendInfo | null;
  caps: Capabilities;
  hosts: HostList | null;
  hostByName: ReadonlyMap<string, Host>;
  groupNames: readonly string[];
  inventory: InventoryState;
  reloadHosts(): void;
  say(m: Message): void;
  selectedHost(): string | null;
  openForm(form: Form): void;
  askRemove(host: Host): void;
  openCommandLine(text: string): void;
}): InventoryActions {
  const { backend, caps, hostByName, inventory, say } = o;
  return {
    inventory: (op) => {
      if (!caps.has("live")) return say(caps.needsNewer("live"));
      if (op.op === "remove") {
        const h = hostByName.get(op.host);
        return h ? o.askRemove(h) : say(`No Host named ${op.host}`);
      }
      if (op.op === "group-delete" && op.to === undefined) {
        const members = o.hosts?.hosts.filter((h) => h.group === op.group) ?? [];
        if (members.length > 0) {
          // Where should they go? The command line asks, with the groups to complete.
          if (o.groupNames.every((g) => g === op.group)) {
            return say(`${op.group} has ${countOf(members.length, "Host")} and there's no other group for them: make one first (:group new)`);
          }
          o.openCommandLine(`group delete ${op.group} `);
          return say(`${op.group} has ${countOf(members.length, "Host")}: name the group they move to (Tab completes), or Esc to keep it`);
        }
      }
      void inventory.run(op);
    },
    edit: (name) => {
      const host = name ?? o.selectedHost();
      if (!host) return say("edit needs a Host name (no Host is selected)");
      if (!hostByName.has(host)) return say(`No Host named ${host}`);
      if (!caps.has("edit")) return say(caps.needsNewer("edit"));
      o.openForm({ kind: "edit", host });
    },
    addHost: (inGroup) => {
      if (!caps.has("add")) return say(caps.needsNewer("add"));
      const at = o.selectedHost();
      o.openForm({ kind: "add", group: inGroup ?? (at && hostByName.get(at)?.group) ?? Object.keys(o.hosts?.groups ?? {})[0] ?? "" });
    },
    review: (name, reviewed = true) => {
      const verb = reviewed ? "review" : "unreview";
      const host = name ?? o.selectedHost();
      if (!host) return say(`${verb} needs a Host name (no Host is selected)`);
      const h = hostByName.get(host);
      if (!h) return say(`No Host named ${host}`);
      if (!caps.has("add")) return say(caps.needsNewer("review", `:${verb}`));
      if (!reviewed && !caps.has("unreview")) return say(caps.needsNewer("unreview"));
      const already = reviewed ? `${host} is already reviewed.` : `${host} isn't reviewed.`;
      if (h.reviewed === reviewed) return say(already);
      backend.reviewHost(host, reviewed).then(
        (r) => {
          o.reloadHosts();
          inventory.refreshPending();
          say(r.changed ? reviewedMessage(host, reviewed, inventory.plain, inventory.kept, afterChange(r)) : already);
        },
        (e: unknown) => say(`Couldn't mark ${host} ${reviewed ? "reviewed" : "unreviewed"}: ${errorText(e)}`),
      );
    },
    showChanges: (then) => {
      if (!caps.has("edit")) return say(caps.needsNewer("changes"));
      if (inventory.plain && o.info) return say(nothingPending(o.info.inventory));
      if (then === "publish" && !caps.has("publish")) return say(caps.needsNewer("publish"));
      inventory.refreshPending();
      o.openForm({ kind: "changes", step: then ?? "diff" });
    },
    pull: () => {
      if (!caps.has("edit")) return say(caps.needsNewer("pull"));
      say(quiet("Pulling the infra repo…"));
      inventory.gate.pull().then(
        (r) =>
          say(
            !r.upstream
              ? "This branch has no upstream: nothing to pull."
              : r.updated
                ? `Pulled ${countOf(r.commits, "commit")} from ${r.upstream}${afterPull(r)}.`
                : `Up to date with ${r.upstream}.`,
          ),
        (e: unknown) => say(`Couldn't pull: ${errorText(e)}`),
      );
    },
  };
}
