import type { Dot, Light } from "./dot";

export type { Light } from "./dot";

const SHAPES: Record<Dot, string> = { key: "filled", password: "ring", ended: "hollow", off: "dashed", connecting: "ring" };

/** `stub: false` draws a lit node without its edge stub (nine or more Sessions: other live Hosts'
 * rows keep their colour but drop it, so stubs stay a signal, Q229 a, Q245). */
export function StateDot({ dot, lit, stub = true }: { dot: Dot; lit?: Light | false | undefined; stub?: boolean }) {
  return (
    <svg className={`dot ${dot}${lit === "current" ? " lit" : lit === "live" ? " on" : ""}`} data-shape={SHAPES[dot]} viewBox="0 0 8 8" width="8" height="8" aria-hidden="true">
      <circle cx="4" cy="4" r="3.25" />
      {/* Has a Session: a short edge leaving the node toward this Box, the map's own way of
          saying "connected" (Q223), so it's a shape as well as a colour. */}
      {lit && stub && <line className="stub" x1="-3.5" y1="4" x2="0.4" y2="4" />}
    </svg>
  );
}
