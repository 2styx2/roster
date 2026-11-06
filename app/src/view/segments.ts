// The status bar's own segments (decision Q39): one entry each, in their default order. The
// layout's `statusbar` lists them by id, the status bar draws them (StatusBar.tsx), and the core's
// docs of `statusbar` name the same ids (segments.test.ts checks them against the generated files).

export interface SegmentDef {
  id: string;
  /** In the bar's right end, after what Plugins are doing. */
  right?: true;
  /** Drawn from a Plugin's entry in the status registry: `hosts` is the built-in hosts Plugin's
   * count, styled as roster's own. */
  plugin?: { className: string };
}

export const SEGMENTS = [
  { id: "backend" },
  { id: "box" },
  { id: "inventory" },
  { id: "hosts", plugin: { className: "count" } },
  { id: "path" },
  { id: "changes" },
  { id: "hints", right: true },
  { id: "mode", right: true },
] as const satisfies readonly SegmentDef[];

export type SegmentId = (typeof SEGMENTS)[number]["id"];

/** The status bar's segments, in their default order. */
export const STATUS_SEGMENTS: readonly SegmentId[] = SEGMENTS.map((s) => s.id);

const BY_ID = new Map<string, SegmentDef>(SEGMENTS.map((s) => [s.id, s]));

/** roster's own segment `id`, or undefined for a Plugin's. */
export const segmentDef = (id: string): SegmentDef | undefined => BY_ID.get(id);
