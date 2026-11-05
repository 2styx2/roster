// The app's first run with no Inventory (T212, decision Q182): instead of only "No Inventory", the
// three ways to get one, in a small form. roster serve makes it (`inventory.create`, serve API 28;
// ADR 0001: the app never writes roster.yml), names it after its folder and makes it the active
// Inventory, so the serve started next finds it. A roster too old to make one says what to run in a
// terminal instead, with the start problem's facts and Retry as the error screen has them.
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { BackendProblem, NewInventory, NewInventoryHow, NewInventoryParams } from "../backend/types";
import { Code, JsonRpcCode } from "../backend/serveContract";
import { BackendCallError } from "../backend/types";
import { Logo } from "../chrome/Logo";
import { CopyCommand } from "../errors/ErrorPanel";
import { withCode } from "../lock/withCode";
import { Keys } from "../ui/Keys";

const WAYS: { how: NewInventoryHow; label: string; about: string }[] = [
  { how: "blank", label: "A blank one", about: "A short roster.yml to add Hosts to." },
  { how: "file", label: "Import a roster.yml", about: "A copy of one you have, made once it loads." },
  { how: "repo", label: "Clone your team's repo", about: "Its git repo, with roster.yml at the top." },
];

/** The folder it suggests: where install.sh puts one. */
export const DEFAULT_FOLDER = "~/infra";

/** A refusal that means this roster has no `inventory.create` (before serve API 28). */
function tooOld(e: unknown): boolean {
  return e instanceof BackendCallError && (e.code === JsonRpcCode.METHOD_NOT_FOUND || e.code === Code.INVENTORY_ERROR);
}

export function FirstRun({
  problem,
  create,
  cancel,
  onMade,
  onRetry,
  copy,
}: {
  /** Why the Backend didn't start: no roster.yml (its facts stay one click away). */
  problem: BackendProblem;
  /** `inventory.create`, on a serve of its own. */
  create: (params: NewInventoryParams) => Promise<NewInventory>;
  /** Stops a create under way (a clone): it then rejects with code 5. */
  cancel: () => Promise<boolean>;
  /** It's made: connect again. */
  onMade: (made: NewInventory) => void;
  onRetry: () => void;
  copy?: ((text: string) => Promise<void>) | undefined;
}) {
  const ids = useId();
  const [how, setHow] = useState<NewInventoryHow>("blank");
  const [folder, setFolder] = useState(DEFAULT_FOLDER);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ message: string; fix: string | null } | null>(null);
  const [stopped, setStopped] = useState(false);
  const [old, setOld] = useState(false);
  // a taken name (the folder's): a Name field of its own, from then on (#417 L4)
  const [askName, setAskName] = useState(false);
  const [name, setName] = useState("");
  const status = useRef<HTMLParagraphElement>(null);
  const alert = useRef<HTMLDivElement>(null);

  const needsSource = how !== "blank";
  const ready = folder.trim() !== "" && (!needsSource || source.trim() !== "") && (!askName || name.trim() !== "");

  // Focus follows what's live (#417 L5): the status while it works, the refusal once it's refused.
  useEffect(() => {
    if (busy) status.current?.focus();
  }, [busy]);
  useEffect(() => {
    if (refusal) alert.current?.focus();
  }, [refusal]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setRefusal(null);
    setStopped(false);
    const params: NewInventoryParams = {
      how,
      folder: folder.trim(),
      ...(needsSource ? { source: source.trim() } : {}),
      ...(askName ? { name: name.trim() } : {}),
    };
    create(params).then(
      (made) => onMade(made),
      (err: unknown) => {
        setBusy(false);
        if (tooOld(err)) return setOld(true);
        if (err instanceof BackendCallError && err.code === Code.CANCELLED) return setStopped(true);
        if (err instanceof BackendCallError && err.data?.field === "name") setAskName(true);
        const message = err instanceof Error ? err.message : String(err);
        const fix = err instanceof BackendCallError && typeof err.data?.fix === "string" ? err.data.fix : null;
        setRefusal({ message, fix });
      },
    );
  };

  if (old) {
    const command = "roster init --blank";
    return (
      <div className="screen center">
        <section className="error" role="region" aria-label="No Inventory" aria-live="polite">
          <h1>No Inventory</h1>
          <p className="problem-message">
            This roster can&rsquo;t make one from the app (that needs serve API 28). Make one in a terminal, then Retry:
          </p>
          {copy && (
            <div className="problem-actions">
              <CopyCommand text={command} copy={copy} />
            </div>
          )}
          <p className="problem-message muted">{withCode(problem.hint)}</p>
          <div className="problem-actions">
            <button type="button" className="primary" onClick={onRetry} autoFocus>
              Retry
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="screen center">
      <section className="first-run" aria-labelledby={`${ids}-title`}>
        <Logo size={48} className="empty-mark" />
        <h1 id={`${ids}-title`}>Start your Inventory</h1>
        <p className="muted">
          roster keeps your Hosts in one <code>roster.yml</code>, and found none on this Box. Make one here, or in a
          terminal with <code>roster init</code>.
        </p>
        <form
          onSubmit={submit}
          aria-label="Start your Inventory"
          aria-busy={busy}
          aria-describedby={refusal ? `${ids}-refusal` : undefined}
        >
          <fieldset className="first-run-ways" disabled={busy}>
            <legend>How</legend>
            {WAYS.map((w, i) => (
              <label key={w.how} className="first-run-way">
                <input
                  type="radio"
                  name={`${ids}-how`}
                  value={w.how}
                  checked={how === w.how}
                  onChange={() => {
                    setHow(w.how);
                    setRefusal(null);
                  }}
                  aria-describedby={`${ids}-${w.how}-about`}
                  autoFocus={i === 0}
                />
                <span>
                  {w.label}
                  <span id={`${ids}-${w.how}-about`} className="muted">
                    {w.about}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          {needsSource && (
            <div className="edit-field">
              <label htmlFor={`${ids}-source`}>{how === "file" ? "Path of the roster.yml" : "Git URL of the repo"}</label>
              <input
                id={`${ids}-source`}
                className="mono"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                disabled={busy}
                spellCheck={false}
                autoComplete="off"
                placeholder={how === "file" ? "~/Downloads/roster.yml" : "git@example.com:team/infra.git"}
                aria-describedby={how === "repo" ? `${ids}-repo-note` : undefined}
              />
              {how === "repo" && (
                <span id={`${ids}-repo-note`} className="edit-note">
                  roster can&rsquo;t answer a passphrase, a password or a new host key here. If the repo needs one, run{" "}
                  <code>roster init --inventory repo:URL</code> in a terminal.
                </span>
              )}
            </div>
          )}
          <div className="edit-field">
            <label htmlFor={`${ids}-folder`}>Folder</label>
            <input
              id={`${ids}-folder`}
              className="mono"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              disabled={busy}
              spellCheck={false}
              autoComplete="off"
              aria-describedby={`${ids}-folder-note`}
            />
            <span id={`${ids}-folder-note`} className="edit-note">
              roster.yml goes in it{how === "repo" ? " (an empty or new folder)" : ""}, named after it as an Inventory.
            </span>
          </div>
          {askName && (
            <div className="edit-field">
              <label htmlFor={`${ids}-name`}>Name</label>
              <input
                id={`${ids}-name`}
                className="mono"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
                spellCheck={false}
                autoComplete="off"
                aria-describedby={`${ids}-name-note`}
              />
              <span id={`${ids}-name-note`} className="edit-note">
                What roster calls it among your named Inventories (<code>roster --inv NAME</code>).
              </span>
            </div>
          )}
          <p ref={status} className="muted first-run-status" role="status" tabIndex={-1}>
            {busy ? (how === "repo" ? "Making it: cloning the repo…" : "Making it…") : stopped ? "Stopped: nothing was kept." : ""}
          </p>
          {refusal && (
            <div ref={alert} id={`${ids}-refusal`} className="first-run-refusal" role="alert" tabIndex={-1}>
              <p className="problem-message">{withCode(refusal.message)}</p>
              {refusal.fix && <p className="problem-message muted">{withCode(refusal.fix)}</p>}
            </div>
          )}
          <div className="problem-actions">
            {/* aria-disabled, not disabled: focus never drops to the page while it works (#417 L5) */}
            <button type="submit" className="primary" aria-disabled={busy || !ready}>
              Make it
            </button>
            {busy ? (
              <button type="button" onClick={() => void cancel()}>
                Cancel
              </button>
            ) : (
              <button type="button" onClick={onRetry}>
                Retry
              </button>
            )}
            <span className="muted">
              <Keys keys="Enter" /> makes it
            </span>
          </div>
        </form>
        {problem.detail && (
          <details className="problem-details">
            <summary>Details</summary>
            <pre>{problem.detail}</pre>
          </details>
        )}
      </section>
    </div>
  );
}
