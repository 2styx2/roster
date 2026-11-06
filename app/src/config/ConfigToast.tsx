// The Config's problems (ticket 21): a Lua or schema error in init.lua, shown with the file and
// line while the last good Config stays in effect, and warnings about values the app couldn't use
// (an unknown command in `keys`). It stays until the next save fixes it, or until it's closed.
import { CloseGlyph } from "../ui/CloseGlyph";
import { describeProblem, type ConfigWarning } from "./apply";
import type { ConfigError } from "./types";

export function ConfigToast({
  error,
  warnings,
  onClose,
}: {
  error: ConfigError | null;
  warnings: readonly ConfigWarning[];
  onClose: () => void;
}) {
  if (!error && warnings.length === 0) return null;
  const title = error ? "init.lua has an error. The last good Config is still in use." : "Some of init.lua couldn't be used";
  const lines = error ? [error] : warnings;
  return (
    <div className={`config-toast${error ? " error" : ""}`} role="alert" aria-label="Config problem">
      <div className="config-toast-head">
        <span className="notice-node" aria-hidden="true" />
        <span className="config-toast-title">{title}</span>
        <button type="button" className="config-toast-close" aria-label="Close" onClick={onClose}>
          <CloseGlyph />
        </button>
      </div>
      <ul className="config-toast-lines">
        {lines.map((p) => (
          <li key={describeProblem(p)}>{describeProblem(p)}</li>
        ))}
      </ul>
    </div>
  );
}
