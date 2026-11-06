// What the app says after roster changed (or wouldn't change) the Inventory: one line each, with
// what roster warned about.
import {
  BackendCallError,
  LiveError,
  type BoxSync,
  type HostAdd,
  type HostList,
  type HostUpdate,
  type InventoryFileError,
  type PublishResult,
  type QuickSave,
  type SaveLogin,
  type SaveTarget,
} from "../backend/types";
import { syncFailed } from "../edit/pull";
import { errorText } from "../ui/format";
import { quiet, type Message } from "../ui/messages";

/** What roster warned about after a change it wrote, with a `roster sync` that failed after it
 * (T150): the change stands, but this Box's ssh config didn't follow. */
export function afterChange(r: { warnings?: readonly string[]; sync?: BoxSync }): string[] {
  const warnings = [...(r.warnings ?? [])];
  if (r.sync && !r.sync.ok) warnings.push(syncFailed(r.sync));
  return warnings;
}

/** " But WARNING; WARNING." after a result, or nothing. */
export function butWarnings(warnings: readonly string[] | undefined): string {
  return warnings?.length ? ` But ${warnings.join("; ")}.` : "";
}

/** A routine action's confirmation: quiet (ticket 111), unless roster warned about something, which
 * always shows. */
export function routine(said: string, text: string, warnings: readonly string[] | undefined): Message {
  return warnings?.length ? text + butWarnings(warnings) : quiet(said, text);
}

/** Where a saved password went, for the add message: said unless it's the personal vault (ticket 35). */
function savedIn(target: Omit<SaveTarget, "save_to"> | undefined): string {
  return target && target.kind !== "personal" ? `, in ${target.label}` : "";
}

/** roster.yml doesn't load (an outside edit): its line, and that the last good Inventory stays. */
export function inventoryBroken(e: InventoryFileError): string {
  const at = `roster.yml${e.line ? `:${e.line}` : ""}`;
  return `${at} has an error (${e.message}): the last good Inventory is still in use`;
}

/** A refused Live Inventory change, said whole: roster's message and its fix. */
export function inventoryRefusal(e: unknown): string {
  if (!(e instanceof BackendCallError)) return `Couldn't change the Inventory: ${errorText(e)}`;
  if (e.code === LiveError.groupNotEmpty) return `${e.message}.`;
  const fix = e.data?.fix ? ` (${e.data.fix})` : "";
  return `Couldn't change the Inventory: ${e.message}${fix}`;
}

/** How a form's change was kept, with `,` before it when more follows in the sentence. */
const keptAfter = (plain: boolean, kept: string) => (plain ? kept : `,${kept}`);

/** After `:edit` saved (or found nothing to save). */
export function savedMessage(update: HostUpdate, plain: boolean): Message {
  const name = update.host.name;
  return update.changed
    ? routine(`Saved ${name}`, `Saved ${name}${plain ? " to roster.yml" : " as a Pending change"}.`, afterChange(update))
    : `Nothing changed on ${name}.` + butWarnings(update.warnings);
}

/** After `:host add`: unreviewed, it can't be opened yet, which is worth saying whatever the setting. */
export function addedMessage(r: HostAdd, plain: boolean, kept: string): Message {
  const where = `${r.host.name} to ${r.host.group}`;
  return r.host.reviewed
    ? routine(`Added ${where}`, `Added ${where}${kept}${r.item ? `; its password is in the vault as ${r.item.name}${savedIn(r.item.target)}` : ""}.`, afterChange(r))
    : `Added ${where} unreviewed${keptAfter(plain, kept)}. :review ${r.host.name} marks it reviewed.` + butWarnings(afterChange(r));
}

/** After "Save to vault" (tickets 15, 16): a Quick Connect saved as a new Host, or a Host's typed password. */
export function savedToVaultMessage(r: QuickSave | SaveLogin, plain: boolean, kept: string): Message {
  return "added" in r
    ? routine(`Saved ${r.host.name}`, `Saved ${r.host.name} to ${r.host.group}${kept}; its password is in the vault as ${r.item.name}${savedIn(r.item.target)}.`, afterChange(r))
    : routine(
        `Saved ${r.host.name}'s password`,
        `Saved ${r.host.name}'s password to the vault as ${r.item.name}${savedIn(r.item.target)}; its Login points at it now${keptAfter(plain, kept)}.`,
        afterChange(r),
      );
}

/** After `:discard`. */
export function discardedMessage(r: { discarded: boolean; sync?: BoxSync }): Message {
  return r.discarded
    ? routine("Discarded the Pending changes", "Discarded the Pending changes: roster.yml is as the last commit has it.", afterChange(r))
    : "Nothing to discard.";
}

/** After `:publish`. */
export function publishedMessage(r: PublishResult): string {
  return `Published ${r.commit.slice(0, 7)} to ${r.upstream}.` + (r.sync.ok ? "" : " This Box's ssh config didn't follow: run roster sync.");
}

/** After `:review` or `:unreview` changed it. */
export function reviewedMessage(host: string, reviewed: boolean, plain: boolean, kept: string, warnings: readonly string[]): Message {
  const done = reviewed
    ? `Marked ${host} reviewed${keptAfter(plain, kept)}. It can be opened now.`
    : `Marked ${host} unreviewed${keptAfter(plain, kept)}. It can't be opened until it's reviewed again.`;
  return routine(`Marked ${host} ${reviewed ? "reviewed" : "unreviewed"}`, done, warnings);
}

/** Service entries roster left out of their Hosts (a bad port, url or login type in roster.yml):
 * the file still loaded, so this is said once, not shown as an error. Null when there are none. */
export function servicesLeftOut(list: HostList): string | null {
  const all = list.hosts.flatMap((h) => (h.problems ?? []).map((p) => ({ host: h.name, ...p })));
  const [first] = all;
  if (!first) return null;
  if (all.length === 1) {
    const why = first.message.replace(/^service '[^']*': /, "");
    return `roster.yml loaded, but left out ${first.host}'s service ${first.service}: ${why} (roster hosts ${first.host} says how to fix it)`;
  }
  const names = all.slice(0, 3).map((p) => `${p.host}'s ${p.service}`);
  const more = all.length > 3 ? `, and ${all.length - 3} more` : "";
  return `roster.yml loaded, but left out ${all.length} services it can't use (${names.join(", ")}${more}): roster hosts says why and how to fix them`;
}
