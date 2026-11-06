// `:config import-terminal` (ticket 33): what it would write into init.lua, as a diff, before
// anything is written. Enter writes it (against the file the preview read), Esc leaves init.lua
// alone. No open/close motion: it comes from a typed command, like the Finder.
import { useMemo } from "react";
import { Keys } from "../ui/Keys";
import type { DiffLine, ImportPreview } from "./types";

/** Lines of context kept around each change; the rest of the file folds to "…". */
const CONTEXT = 2;

type Shown = DiffLine | { kind: "gap"; text: string };

/** The diff's changes with a little context, as `git diff` shows it. */
export function hunks(diff: readonly DiffLine[]): Shown[] {
  const near = diff.map((_, i) =>
    diff.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((l) => l.kind !== "same"),
  );
  const out: Shown[] = [];
  diff.forEach((line, i) => {
    if (near[i]) out.push(line);
    else if (out.at(-1)?.kind !== "gap") out.push({ kind: "gap", text: "…" });
  });
  return out;
}

const SIGN: Record<Shown["kind"], string> = { same: " ", add: "+", remove: "-", gap: " " };

export function ImportPanel({
  preview,
  problem,
  writing,
  onWrite,
  onClose,
}: {
  preview: ImportPreview;
  /** Why the write failed, if it did. */
  problem: string | null;
  writing: boolean;
  onWrite(): void;
  onClose(): void;
}) {
  const shown = useMemo(() => hunks(preview.diff), [preview.diff]);
  const unchanged = preview.diff.every((l) => l.kind === "same");
  return (
    <div className="picker-backdrop" data-panel="import" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="picker import"
        role="dialog"
        aria-label="Import from Windows Terminal"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "Enter" && !writing) {
            e.preventDefault();
            onWrite();
          }
        }}
      >
        <header className="import-head">
          <h2>Windows Terminal → init.lua</h2>
          <p className="import-from" title={preview.settingsPath}>
            {preview.settingsPath}
          </p>
        </header>
        <ul className="import-summary">
          {preview.summary.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
        {unchanged && <p className="import-notes">init.lua already has this profile: there's nothing to change.</p>}
        {(preview.created || preview.overridden.length > 0 || preview.error || problem) && (
          <div className="import-notes">
            {preview.created && <p>There's no init.lua yet: it's made from the example, every line commented out, with this block at the end.</p>}
            {preview.overridden.map((o) => (
              <p key={o.option} className="warn">
                {o.by === "later" && o.at ? (
                  <>
                    <code>
                      {o.at.file}:{o.at.line}
                    </code>{" "}
                    sets <code>{o.option}</code> again after the import block, and the later line wins.
                  </>
                ) : (
                  <>
                    init.lua's returned table sets <code>{o.option}</code>, and it wins over the import.
                  </>
                )}{" "}
                Delete it there to use Windows Terminal's.
              </p>
            ))}
            {preview.error && <p className="warn">With this block, init.lua would have an error: {preview.error}</p>}
            {problem && (
              <p className="warn" role="alert">
                {problem}
              </p>
            )}
          </div>
        )}
        <pre className="import-diff" aria-label="Changes to init.lua">
          {shown.map((l, i) => (
            <span key={i} className={`diff-line ${l.kind}`} data-kind={l.kind}>
              <span className="diff-sign" aria-hidden="true">
                {SIGN[l.kind]}
              </span>
              {l.text}
              {"\n"}
            </span>
          ))}
        </pre>
        <div className="picker-footer">
          <span role="status">{writing ? "Writing…" : ""}</span>
          <button type="button" className="primary" autoFocus disabled={writing} onClick={onWrite}>
            Write to init.lua <Keys keys="Enter" />
          </button>
          <button type="button" onClick={onClose}>
            Cancel <Keys keys="Escape" />
          </button>
        </div>
      </div>
    </div>
  );
}
