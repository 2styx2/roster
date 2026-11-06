// A roster.yml path from serve's results as the app names it (T261, #529): since API 31 serve
// sends PATH_NOT_REPEATED for one in a folder (or with a name) that looks like a token, as the CLI
// has said "that path (not repeated)" since #506. Every place that shows such a path asks here.
import type { Capabilities, Feature } from "./capabilities";
import { PATH_NOT_REPEATED, RENAME_HINT } from "./serveContract";

/** What to do about it, as a sentence (serve's RENAME_HINT, the CLI's words). */
export const RENAME = `${RENAME_HINT.charAt(0).toUpperCase()}${RENAME_HINT.slice(1)}.`;

/** Which serve hides a path: the one it runs on since API 31 (`hiddenPaths`), another named
 * Inventory's since API 32 (`hiddenNamedPaths`, #538). */
type Hides = Extract<Feature, "hiddenPaths" | "hiddenNamedPaths">;

/** serve said PATH is one it won't name. An older serve never hides one, so its PATH is a path. */
export function isHidden(path: string | null | undefined, caps: Capabilities, since: Hides = "hiddenPaths"): boolean {
  return path === PATH_NOT_REPEATED && caps.has(since);
}

/** PATH as a sentence names it: `that path (not repeated)` for one serve won't name (`WHAT at …`
 * when WHAT is given: "the roster.yml"). */
export function shownPath(path: string, caps: Capabilities, what?: string, since: Hides = "hiddenPaths"): string {
  if (!isHidden(path, caps, since)) return path;
  return `${what ? `${what} at ` : ""}that path ${PATH_NOT_REPEATED}`;
}

/** The rename hint, after a message that named PATH and ended its sentence: " Rename the folder …"
 * or "". */
export function renameAfter(path: string | null | undefined, caps: Capabilities, since: Hides = "hiddenPaths"): string {
  return isHidden(path, caps, since) ? ` ${RENAME}` : "";
}

/** The rename hint after a message line that named PATH and has no full stop of its own:
 * ". Rename the folder …" or "". */
export function thenRename(path: string | null | undefined, caps: Capabilities, since: Hides = "hiddenPaths"): string {
  return isHidden(path, caps, since) ? `. ${RENAME}` : "";
}
