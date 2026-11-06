// The hint on entering a view mode that has one: how to leave it.
import { Fragment } from "react";
import { keyHint, keysFor, type Keymap } from "../keymap";
import { Keys } from "../ui/Keys";
import type { ViewMode } from "./layout";

export function ModeHint({ keymap, leader, viewMode }: { keymap: Keymap; leader: string; viewMode: ViewMode }) {
  const keys = [keyHint(keymap, "mode"), keyHint(keymap, "focus"), ...keysFor(keymap, "mode", { leader: false }), ...keysFor(keymap, "focus", { leader: false })].filter(
    (k): k is string => k !== null,
  );
  if (keys.length === 0) return null;
  const what = viewMode === "focus" ? "Focus" : "this mode";
  return (
    <div className="mode-hint key-hint" role="status" aria-label={`How to leave ${what}`}>
      {/* Two ways out, not one sequence: "␣ m or F11", never "␣ m F11". */}
      {keys.map((k, i) => (
        <Fragment key={k}>
          {i > 0 && <span className="muted"> or </span>}
          <Keys keys={k} leader={leader} />
        </Fragment>
      ))}{" "}
      leave {what}
    </div>
  );
}
