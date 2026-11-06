// How roster.yml is kept (T212, decision Q182): a team repo, where edits are Pending changes until
// Publish, or a plain file, where every edit is saved straight to it. roster serve says which
// (`inventory.info`'s `store`, API 28); an older serve is always a team repo, as it always was.
import { capabilities } from "../backend/capabilities";
import { renameAfter, shownPath } from "../backend/shown";
import type { InventoryInfo } from "../backend/types";

/** roster.yml is a plain file: there are no Pending changes, and nothing to publish. */
export function isPlainFile(info: InventoryInfo | null | undefined): boolean {
  return !!info && capabilities(info).has("store") && info.store?.kind === "file";
}

/** How an edit was kept, said after what it did: "Removed web from lab, saved to roster.yml." or
 * "Removed web from lab as a Pending change." */
export function keptAs(plain: boolean): string {
  return plain ? ", saved to roster.yml" : " as a Pending change";
}

/** What `:changes`, `:discard` and `:publish` say for a plain file. */
export function nothingPending(info: InventoryInfo): string {
  const caps = capabilities(info);
  return `roster.yml is a plain file (${shownPath(info.path, caps)}): every edit is saved straight to it, so there are no Pending changes to show, discard or publish.${renameAfter(info.path, caps)}`;
}
