// The glyphs of a row's or a table's actions (16-unit paths, drawn at 12 px).

const ICONS = {
  close: "M4 4l8 8M12 4l-8 8",
  edit: "M3 13l1-3.5L10.5 3 13 5.5 6.5 12z",
  add: "M8 3v10M3 8h10",
  // A group (two stacked rows, as the group rows' icon) with a + beside it.
  addGroup: "M2 3.5h7v3.5H2zM2 9h7v3.5H2zM13 5.5v5M10.5 8h5",
  review: "M3.5 8.5l3 3 6-7",
  // Take a review back: an arrow turning back over the line (undo).
  unreview: "M5.5 3.5L2.5 6.5l3 3M2.5 6.5h7a3.5 3.5 0 010 7H7",
  // An i in a ring: the Host's details (ticket 18).
  info: "M8 2.25a5.75 5.75 0 110 11.5 5.75 5.75 0 010-11.5zM8 7.25v3.5M8 5.25v.01",
  // Two sheets, one over the other: copy (a Plugin's row, ticket 56).
  copy: "M5.5 5.5h7v7h-7zM3.5 10.5v-7h7",
  // A dashed arrow: what would change, not changed yet (a Mesh plan, ticket 91).
  plan: "M2 8h2.5M6.5 8H9M11 8h2.5M10.5 5l3 3-3 3",
  // A solid arrow into a bar: carry it out (a Mesh apply).
  apply: "M2 8h9M8 5l3 3-3 3M13.5 3.5v9",
  // An edge broken by a cross, as a cut edge is drawn in a graph (a Mesh cut).
  cut: "M1.5 8h3.5M11 8h3.5M6.5 5.5l3 5M9.5 5.5l-3 5",
  // An arrow coming round to start again: reconnect an ended Session (round 20).
  reconnect: "M12.75 8a4.75 4.75 0 11-1.4-3.36M12.5 2.5v2.75H9.75",
  // Three nodes joined, as the toolbar's map: show it on a graph (Topology's section, T99).
  map: "M3.75 9.75a1.75 1.75 0 110 3.5 1.75 1.75 0 010-3.5zM12.25 9.75a1.75 1.75 0 110 3.5 1.75 1.75 0 010-3.5zM8 2.25a1.75 1.75 0 110 3.5 1.75 1.75 0 010-3.5zM5.5 11.5h5M4.7 10L7.1 5.6M11.3 10L8.9 5.6",
} as const;

export type ActionIcon = keyof typeof ICONS;

/** A row action's icon (a Sidebar row's, a table's action). */
export const RowActionGlyph = ({ name }: { name: ActionIcon }) => (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <path d={ICONS[name]} />
  </svg>
);

