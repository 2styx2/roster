// Where a nested ssh took a Session (ticket 120, decision Q131): the model the tab, the Sidebar
// row and HopCrumb.tsx share. Plain data and words, no view.

/** The Host a nested ssh took the Session to: an Inventory Host, or a target roster can't resolve
 * (`known: false`). */
export interface Breadcrumb {
  to: string;
  known: boolean;
}

/** "now on esx-02 through ssh": what the breadcrumb says, for an accessible name or a tooltip. */
export function hopWords(hop: Breadcrumb): string {
  return `now on ${hop.to} through ssh${hop.known ? "" : " (not a Host roster can resolve)"}`;
}
