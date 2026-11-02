// `:edit HOST` (ticket 10): a side panel with the Host's fields. It opens at once from the Inventory
// the app has; when the last pull of the infra repo is older than `pull_fresh_minutes` it pulls
// (fast-forward only) in the background meanwhile (decision Q88). A pull that changed this Host
// updates the fields you hadn't touched and says so; a pull that can't happen says why and blocks
// the save, never the form. Saving waits for that pull (and pulls again if the form sat open past
// the window), then writes roster.yml through roster as a Pending change. A change
// to the address, port, user or Login first runs one test login (`host.verify_login`, decision
// Q43) and only saves if it passed; its steps show like `:check`'s.
//
// Keyboard first: the first field has focus, Tab moves, Enter saves, Esc closes. It opens from a
// key, so it doesn't animate (emil-design-eng: never animate keyboard-initiated actions).
import { useEffect, useRef, useState } from "react";
import type { Backend, Host, HostCheck, HostUpdate } from "../backend/types";
import { problemFromCallError, type ErrorRow } from "../errors/catalog";
import type { Problem } from "../errors/classify";
import { CheckSteps } from "../errors/CheckPanel";
import { ProblemBody, type ProblemActions } from "../errors/ErrorPanel";
import { CloseGlyph } from "../ui/CloseGlyph";
import { PanelButton } from "../panel/PanelFrame";
import { Keys } from "../ui/Keys";
import { changesOf, draftOf, FIELDS, fieldProblem, needsVerify, rebaseDraft, touchesLogin, type Draft, type FieldName } from "./form";
import { useFormPull, type PullGate, type PullOutcome } from "./pull";
import { PullStatus } from "./PullStatus";

type Phase =
  | { at: "ready" }
  | { at: "waiting" }
  | { at: "verifying" }
  | { at: "verify-failed"; result: HostCheck }
  | { at: "saving" }
  | { at: "save-failed"; problem: Problem };

export interface EditPanelProps {
  backend: Backend;
  host: Host;
  /** Pending changes already on this Box: the repo was pulled before the first one (and a pull
   * now would refuse them), so the form doesn't pull. */
  pendingCount: number;
  rows: readonly ErrorRow[];
  actions: ProblemActions;
  /** The edit is a Pending change now. */
  onSaved(update: HostUpdate): void;
  /** The pull before a write (decision Q88), shared with the other forms and `:pull`. */
  pull: PullGate;
  onClose(): void;
  /** Marks the Host reviewed (`:review`, ticket 11): offered while it's unreviewed. */
  onReview?(host: string): void;
  /** Marks the Host unreviewed again (`:host unreview`, API 9): offered while it's reviewed. */
  onUnreview?(host: string): void;
}

const label = (name: FieldName) => FIELDS.find((f) => f.name === name)?.label ?? name;
const listOf = (names: readonly FieldName[]) => names.map(label).join(", ");

/** What a pull that changed the Host did to the form (decision Q88). */
function changedLine(host: string, r: { theirs: FieldName[]; both: FieldName[] }): string {
  const parts = [
    ...(r.theirs.length ? [`${listOf(r.theirs)} now ${r.theirs.length === 1 ? "shows the new value" : "show the new values"}`] : []),
    ...(r.both.length ? [`${listOf(r.both)} changed there too, and yours ${r.both.length === 1 ? "is" : "are"} kept`] : []),
  ];
  return `The pull changed ${host}: ${parts.join("; ")}.`;
}

export function EditPanel({ backend, host, pendingCount, rows, actions, onSaved, pull, onClose, onReview, onUnreview }: EditPanelProps) {
  const [current, setCurrent] = useState(host);
  const [draft, setDraft] = useState<Draft>(() => draftOf(host));
  const [phase, setPhase] = useState<Phase>({ at: "ready" });
  /** The pull changed this Host under the form: what that did (decision Q88). */
  const [changedThere, setChangedThere] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // The Host as the form last read it, and the draft as typed, for a rebase that lands later.
  const currentRef = useRef(current);
  const draftRef = useRef(draft);
  useEffect(() => {
    currentRef.current = current;
    draftRef.current = draft;
  });
  /** A pull brought commits: read the Host again and rebase the draft on it. True when it changed. */
  const rebased = useRef(new WeakMap<object, Promise<boolean>>());
  const rebase = (outcome: PullOutcome): Promise<boolean> => {
    if (outcome.fresh || !outcome.result.updated) return Promise.resolve(false);
    const known = rebased.current.get(outcome.result);
    if (known) return known;
    const done = backend.getHost(host.name).then(
      (fresh) => {
        if (!live.current) return false;
        const r = rebaseDraft(currentRef.current, fresh, draftRef.current);
        setCurrent(fresh);
        setDraft(r.draft);
        if (r.theirs.length === 0 && r.both.length === 0) return false;
        setChangedThere(changedLine(host.name, r));
        return true;
      },
      // Gone from the Inventory after the pull: App closes the form.
      () => false,
    );
    rebased.current.set(outcome.result, done);
    return done;
  };
  const formPull = useFormPull(pull, pendingCount > 0, host.name, (outcome) => void rebase(outcome));

  useEffect(() => {
    first.current?.focus();
  }, []);

  const busy = phase.at === "waiting" || phase.at === "verifying" || phase.at === "saving";
  const changes = changesOf(current, draft);
  const verify = changes !== null ? needsVerify(changes) : touchesLogin(current, draft);
  const nothing = changes !== null && Object.keys(changes).length === 0;

  const save = async () => {
    if (busy || changes === null || nothing) return;
    // The pull first (decision Q88): the one running, or a new one if the last is stale.
    setPhase({ at: "waiting" });
    const outcome = await formPull.ready();
    if (!live.current) return;
    // A pull that failed says why (above); one that changed this Host shows how, and the next
    // Save is on the new values.
    if (outcome === null || (outcome !== "skipped" && (await rebase(outcome)))) return setPhase({ at: "ready" });
    try {
      if (verify) {
        setPhase({ at: "verifying" });
        const result = await backend.verifyLogin(current.name, changes);
        if (!live.current) return;
        if (!result.ok) return setPhase({ at: "verify-failed", result });
      }
      setPhase({ at: "saving" });
      const update = await backend.updateHost(current.name, changes);
      if (live.current) onSaved(update);
    } catch (e) {
      if (live.current) setPhase({ at: "save-failed", problem: problemFromCallError(current.name, e) });
    }
  };

  const original = draftOf(current);
  return (
    <section
      className="side-panel edit-panel"
      role="region"
      aria-label={`Edit ${host.name}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        <h2>
          <span className="muted">Edit · </span>
          <span className="mono">{host.name}</span>
        </h2>
        <span className="panel-head-buttons">
          <PanelButton />
          <button type="button" className="icon-button close" aria-label="Close the edit" onClick={onClose}>
            <CloseGlyph />
          </button>
        </span>
      </header>
      <form
        className="edit-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <PullStatus pull={formPull} rows={rows} actions={actions} />
        {changedThere && (
          <p className="edit-note" role="status">
            {changedThere}
          </p>
        )}
        <div className="edit-fields">
          {FIELDS.map((f, i) => {
            const problem = fieldProblem(f.name, draft[f.name]);
            const changed = draft[f.name].trim() !== original[f.name];
            const id = `edit-${f.name}`;
            return (
              <div key={f.name} className="edit-field" data-changed={changed || undefined}>
                <label htmlFor={id}>
                  {f.label}
                  {changed && <span className="edit-changed"> · changed</span>}
                </label>
                <input
                  id={id}
                  ref={i === 0 ? first : undefined}
                  className={f.mono ? "mono" : undefined}
                  value={draft[f.name]}
                  placeholder={f.placeholder}
                  spellCheck={false}
                  autoComplete="off"
                  inputMode={f.name === "port" ? "numeric" : undefined}
                  disabled={busy}
                  aria-invalid={problem ? true : undefined}
                  aria-describedby={problem ? `${id}-problem` : undefined}
                  onChange={(e) => {
                    const value = e.target.value;
                    setDraft((d) => ({ ...d, [f.name]: value }));
                    if (phase.at === "verify-failed" || phase.at === "save-failed") setPhase({ at: "ready" });
                  }}
                />
                {problem && (
                  <span id={`${id}-problem`} className="edit-field-problem">
                    {problem}
                  </span>
                )}
              </div>
            );
          })}
        </div>
        {verify && (
          <p className="edit-note">
            The address, user or Login changed, so roster tests the login first: one attempt, and the host key must
            match the recorded one.
          </p>
        )}
        {phase.at === "verifying" && <p className="muted edit-status">Testing the login to {draft.ip.trim()}…</p>}
        {phase.at === "waiting" && <p className="muted edit-status">Waiting for the pull to finish…</p>}
        {phase.at === "saving" && <p className="muted edit-status">Saving…</p>}
        {phase.at === "verify-failed" && (
          <div className="edit-problem" role="alert">
            <p className="edit-status">The test login failed, so nothing was saved.</p>
            <CheckSteps host={current.name} steps={phase.result.steps} rows={rows} actions={actions} />
          </div>
        )}
        {phase.at === "save-failed" && (
          <div className="edit-problem" role="alert">
            <ProblemBody problem={phase.problem} rows={rows} actions={actions} notInTab />
          </div>
        )}
        <div className="edit-actions">
          <button type="submit" className="primary" disabled={busy || changes === null || nothing}>
            {verify ? "Test login and save" : "Save"}
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          {!current.reviewed && onReview && (
            <button type="button" onClick={() => onReview(current.name)} disabled={busy}>
              Mark reviewed
            </button>
          )}
          {current.reviewed && onUnreview && (
            <button type="button" onClick={() => onUnreview(current.name)} disabled={busy}>
              Mark unreviewed
            </button>
          )}
          <span className="edit-keys muted key-hint">
            <Keys keys="Enter" /> save <Keys keys="Escape" /> close
          </span>
        </div>
      </form>
    </section>
  );
}
