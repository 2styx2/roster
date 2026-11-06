import type { Dot } from "./dot";

const SHAPES: Record<Dot, string> = { key: "filled", password: "ring", ended: "hollow", off: "dashed", connecting: "ring" };

export function StateDot({ dot }: { dot: Dot }) {
  return (
    <svg className={`dot ${dot}`} data-shape={SHAPES[dot]} viewBox="0 0 8 8" width="8" height="8" aria-hidden="true">
      <circle cx="4" cy="4" r="3.25" />
    </svg>
  );
}
