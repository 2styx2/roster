// What the connected roster serve can do, from its `api_version`: one place that knows which
// feature needs which version, and the one way the app says a feature needs a newer roster.
import { FORMS, SINCE } from "./serveContract";
import type { InventoryInfo } from "./types";

/** Each feature: the first API version with it (the serve method's, from serveContract.ts), and
 * what the user tried, as the refusal names it. */
const FEATURES = {
  check: { since: SINCE["host.check"], what: ":check" },
  boxCheck: { since: SINCE["box.check"], what: ":check" },
  checkJobs: { since: SINCE["host.check_job"], what: "Stopping a check" },
  edit: { since: SINCE["host.update"], what: ":edit" },
  changes: { since: SINCE["host.update"], what: ":changes" },
  pull: { since: SINCE["host.update"], what: ":pull" },
  publish: { since: SINCE["changes.publish"], what: ":publish" },
  add: { since: SINCE["host.add"], what: "Adding a Host" },
  review: { since: SINCE["host.add"], what: ":review" },
  unreview: { since: FORMS["host.review"][1], what: ":host unreview" },
  live: { since: SINCE["inventory.watch"], what: "Changing the Inventory here" },
  vaultConfig: { since: SINCE["vault.configure"], what: "init.lua's vault settings" },
  hostKey: { since: SINCE["host.trust_key"], what: "Asking about a new Host's host key" },
  quickConnect: { since: SINCE["quick.prepare"], what: "Quick Connect" },
  saveToVault: { since: SINCE["quick.save"], what: "Save to vault" },
  signOut: { since: SINCE["vault.logout"], what: ":vault signout" },
  /** serve answers concurrently and its jobs push `job.progress` (decision Q112). */
  jobs: { since: SINCE["jobs.list"], what: "Plugins' job progress" },
  inventories: { since: SINCE["inventories.list"], what: ":inventory" },
  fill: { since: SINCE["session.fill"], what: "Filling a password prompt" },
  nestedFill: { since: FORMS["session.fill"][1], what: "Filling a nested ssh's prompt" },
  itemFields: { since: SINCE["vault.item_fields"], what: "Fill from this item" },
  /** `inventory.info`'s `store` (a plain file or a team repo) came with `inventory.create`. */
  store: { since: SINCE["inventory.create"], what: "A plain roster.yml" },
  /** `roster setup --host NAME`, that Host alone (#437, Q198): a CLI option, not a serve method.
   * T227 added it with no API bump of its own, at 29, and v0.6.0 is the first release with API 29,
   * so every roster speaking 29 has it; an older one has only `--only NAME` (#461). */
  setupHost: { since: 29, what: "roster setup --host" },
  /** A roster.yml in a folder (or with a name) that looks like a token: serve's results say
   * `PATH_NOT_REPEATED` for its path (#529), and the app says so (`backend/shown.ts`). */
  hiddenPaths: { since: FORMS["inventory.info"][2], what: "A roster.yml roster won't name" },
} as const satisfies Record<string, { since: number; what: string }>;

export type Feature = keyof typeof FEATURES;

/** The first API version with `feature`: for a fake Backend or a test that speaks just enough. */
export const sinceOf = (feature: Feature): number => FEATURES[feature].since;

export interface Capabilities {
  /** serve's API version; 0 while it isn't up. */
  readonly api: number;
  has(feature: Feature): boolean;
  /** Why `feature` can't run here: "`what` needs a newer roster (API version N; this one speaks M)".
   * `as` names it otherwise (`:unreview` refused for want of `review`). */
  needsNewer(feature: Feature, as?: string): string;
}

export function capabilities(info: Pick<InventoryInfo, "api_version"> | null | undefined): Capabilities {
  const api = info?.api_version ?? 0;
  return {
    api,
    has: (f) => api >= FEATURES[f].since,
    needsNewer: (f, as) => `${as ?? FEATURES[f].what} needs a newer roster (API version ${FEATURES[f].since}; this one speaks ${api})`,
  };
}
