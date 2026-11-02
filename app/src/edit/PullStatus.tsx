// A form's line about the pull before a write (decision Q88): it ran, wasn't needed, is running in
// the background, or failed. A failure is the one thing that blocks the save, so it's an alert with
// roster's own error and Try again; the form stays open and keeps what was typed.
import type { ErrorRow } from "../errors/catalog";
import { ProblemBody, type ProblemActions } from "../errors/ErrorPanel";
import { pullLine, type FormPull } from "./pull";

export function PullStatus({
  pull,
  rows,
  actions,
}: {
  pull: { state: FormPull; retry(): void };
  rows: readonly ErrorRow[];
  actions: ProblemActions;
}) {
  const { state } = pull;
  // A sync that failed after the pull (T153) isn't routine, so its line isn't muted.
  const synced = state.at !== "pulled" || state.result.sync?.ok !== false;
  if (state.at !== "failed") return <p className={synced ? "muted edit-status" : "edit-status"}>{pullLine(state)}</p>;
  return (
    <div className="edit-problem" role="alert">
      <p className="edit-status">{pullLine(state)}</p>
      <ProblemBody problem={state.problem} rows={rows} actions={actions} notInTab />
      <div className="edit-actions">
        <button type="button" onClick={pull.retry}>
          Try again
        </button>
      </div>
    </div>
  );
}
