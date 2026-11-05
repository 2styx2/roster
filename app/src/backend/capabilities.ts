// What the connected roster serve can do, from its `api_version`: one place that knows which
// feature needs which version, and the one way the app says a feature needs a newer roster.
import {
  ADD_API_VERSION,
  BOX_CHECK_API_VERSION,
  CHECK_API_VERSION,
  CHECK_JOBS_API_VERSION,
  EDIT_API_VERSION,
  FILL_API_VERSION,
  HOST_KEY_API_VERSION,
  INVENTORIES_API_VERSION,
  ITEM_FIELDS_API_VERSION,
  JOBS_API_VERSION,
  LIVE_API_VERSION,
  NESTED_FILL_API_VERSION,
  PUBLISH_API_VERSION,
  QUICK_CONNECT_API_VERSION,
  SAVE_TO_VAULT_API_VERSION,
  SIGN_OUT_API_VERSION,
  UNREVIEW_API_VERSION,
  VAULT_CONFIG_API_VERSION,
  type InventoryInfo,
} from "./types";

/** Each feature: the first API version with it, and what the user tried, as the refusal names it. */
const FEATURES = {
  check: { since: CHECK_API_VERSION, what: ":check" },
  boxCheck: { since: BOX_CHECK_API_VERSION, what: ":check" },
  checkJobs: { since: CHECK_JOBS_API_VERSION, what: "Stopping a check" },
  edit: { since: EDIT_API_VERSION, what: ":edit" },
  changes: { since: EDIT_API_VERSION, what: ":changes" },
  pull: { since: EDIT_API_VERSION, what: ":pull" },
  publish: { since: PUBLISH_API_VERSION, what: ":publish" },
  add: { since: ADD_API_VERSION, what: "Adding a Host" },
  review: { since: ADD_API_VERSION, what: ":review" },
  unreview: { since: UNREVIEW_API_VERSION, what: ":host unreview" },
  live: { since: LIVE_API_VERSION, what: "Changing the Inventory here" },
  vaultConfig: { since: VAULT_CONFIG_API_VERSION, what: "init.lua's vault settings" },
  hostKey: { since: HOST_KEY_API_VERSION, what: "Asking about a new Host's host key" },
  quickConnect: { since: QUICK_CONNECT_API_VERSION, what: "Quick Connect" },
  saveToVault: { since: SAVE_TO_VAULT_API_VERSION, what: "Save to vault" },
  signOut: { since: SIGN_OUT_API_VERSION, what: ":vault signout" },
  jobs: { since: JOBS_API_VERSION, what: "Plugins' job progress" },
  inventories: { since: INVENTORIES_API_VERSION, what: ":inventory" },
  fill: { since: FILL_API_VERSION, what: "Filling a password prompt" },
  nestedFill: { since: NESTED_FILL_API_VERSION, what: "Filling a nested ssh's prompt" },
  itemFields: { since: ITEM_FIELDS_API_VERSION, what: "Fill from this item" },
} as const satisfies Record<string, { since: number; what: string }>;

export type Feature = keyof typeof FEATURES;

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
