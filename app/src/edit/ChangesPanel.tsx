// `:changes` (ticket 10): the Pending changes, as the Hosts they touch and roster.yml's diff
// against the last commit (`changes.diff`). `:discard` asks first, then puts roster.yml back
// (`changes.discard`; roster keeps what it held as a backup). `:publish` (ticket 12) keeps the
// diff on screen for a last look and adds roster's commit message, editable; Publish commits and
// pushes (`changes.publish`), then the panel says the commit's hash and whether this Box's ssh
// config followed. A refusal is the error catalog's row, and the Pending changes stay.
//
// It opens from a key, so it doesn't animate. Esc closes it (or backs out of a step).
import { useEffect, useRef, useState } from "react";
import type { PendingChanges, PublishResult } from "../backend/types";
import type { Problem } from "../errors/classify";
import { problemFromCallError, type ErrorRow } from "../errors/catalog";
import { CopyCommand, ProblemBody, type ProblemActions } from "../errors/ErrorPanel";
import { countOf } from "../ui/format";
import { CloseGlyph } from "../ui/CloseGlyph";
import { PanelButton } from "../panel/PanelFrame";
import { Keys } from "../ui/Keys";

export type ChangesState =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "done"; changes: PendingChanges };

export type ChangesStep = "diff" | "discard" | "publish";

export interface ChangesPanelProps {
  changes: ChangesState;
  /** Where it opens: the diff, the discard question (`:discard`) or the Publish step (`:publish`). */
  step: ChangesStep;
  /** The key that opens the edit form, for the empty state ("␣ E"). */
  editKeys: string | null;
  leader: string;
  /** roster speaks `changes.publish` (API 7). */
  canPublish: boolean;
  rows: readonly ErrorRow[];
  actions: ProblemActions;
  onDiscard(): Promise<void>;
  /** Commit and push with `message`; rejects with roster's refusal. */
  onPublish(message: string): Promise<PublishResult>;
  onClose(): void;
}

const FIELD_LABEL: Record<string, string> = { ip: "address", auth: "Login" };

/** One diff line's kind, for its colour and its sign in words. */
export function kindOf(line: string): "add" | "del" | "hunk" | "meta" | "same" {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "same";
}

export const SIGN_WORD = { add: "added: ", del: "removed: " } as const;

/** The short hash git shows. */
const short = (commit: string) => commit.slice(0, 7);

export function ChangesPanel(props: ChangesPanelProps) {
  const { changes, editKeys, leader, canPublish, rows, actions, onDiscard, onPublish, onClose } = props;
  const [step, setStep] = useState<ChangesStep>(props.step === "publish" && !canPublish ? "diff" : props.step);
  const [discarding, setDiscarding] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<PublishResult | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  /** The message as typed; null until it's touched, so roster's own shows once it arrives. */
  const [draft, setDraft] = useState<string | null>(null);
  const panel = useRef<HTMLElement>(null);
  const yes = useRef<HTMLButtonElement>(null);
  const messageBox = useRef<HTMLTextAreaElement>(null);
  const count = changes.state === "done" ? changes.changes.count : 0;
  const showing: ChangesStep = count > 0 && !published ? step : "diff";
  const message = draft ?? (changes.state === "done" ? (changes.changes.message ?? "") : "");

  useEffect(() => {
    if (showing === "discard") yes.current?.focus();
    else if (showing === "publish") messageBox.current?.focus();
    else panel.current?.focus({ preventScroll: true });
  }, [showing]);

  const publish = () => {
    if (publishing || !message.trim()) return;
    setPublishing(true);
    setProblem(null);
    onPublish(message.trim()).then(
      (r) => {
        setPublished(r);
        setPublishing(false);
        setStep("diff");
      },
      (e: unknown) => {
        setProblem(problemFromCallError("", e));
        setPublishing(false);
      },
    );
  };

  // The file is named above, so git's header lines (diff, index, ---, +++) are left out.
  const lines =
    changes.state === "done"
      ? changes.changes.diff.split("\n").filter((l, i, all) => kindOf(l) !== "meta" && (l !== "" || i < all.length - 1))
      : [];
  return (
    <section
      ref={panel}
      tabIndex={-1}
      className="side-panel changes-panel"
      role="region"
      aria-label="Pending changes"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        if (showing !== "diff" && !publishing) {
          setStep("diff");
          setProblem(null);
        } else onClose();
      }}
    >
      <header>
        <h2>
          Pending changes
          {changes.state === "done" && <span className="muted"> · {count}</span>}
        </h2>
        <span className="panel-head-buttons">
          <PanelButton />
          <button type="button" className="icon-button close" aria-label="Close Pending changes" onClick={onClose}>
            <CloseGlyph />
          </button>
        </span>
      </header>
      {changes.state === "loading" && <p className="muted">Reading the infra repo…</p>}
      {changes.state === "error" && <p className="problem-message">{changes.message}</p>}
      {published && <Published result={published} copy={actions.copy} />}
      {changes.state === "done" && count === 0 && !published && (
        <p className="muted panel-empty-line">
          No Pending changes: roster.yml is as the last commit has it.
          {editKeys && (
            <span className="key-hint">
              {" "}
              <Keys keys={editKeys} leader={leader} /> edits a Host.
            </span>
          )}
        </p>
      )}
      {changes.state === "done" && count > 0 && (
        <>
          <p className="muted changes-where">
            Edits on this Box that aren't Published yet, in <code>{changes.changes.path}</code>.
          </p>
          <ul className="changes-hosts">
            {changes.changes.hosts.map((h) => (
              <li key={h.host}>
                <span className="mono">{h.host}</span>
                <span className="muted">
                  {" "}
                  {h.change === "changed" ? h.fields.map((f) => FIELD_LABEL[f] ?? f).join(", ") : h.change}
                </span>
              </li>
            ))}
          </ul>
          <pre className="diff" aria-label="The diff of roster.yml">
            {lines.map((line, i) => {
              const kind = kindOf(line);
              return (
                <span key={i} className={`diff-line ${kind}`}>
                  {(kind === "add" || kind === "del") && <span className="visually-hidden">{SIGN_WORD[kind]}</span>}
                  {line || " "}
                  {"\n"}
                </span>
              );
            })}
          </pre>
          {showing === "discard" && (
            <div className="changes-confirm" role="alertdialog" aria-label="Discard the Pending changes?">
              <p>
                Discard {countOf(count, "Pending change")}? roster.yml goes back to the last commit. roster keeps a copy of
                it as it is now in the repo's <code>.git/roster/</code>.
              </p>
              <div className="edit-actions">
                <button
                  ref={yes}
                  type="button"
                  className="danger"
                  disabled={discarding}
                  onClick={() => {
                    setDiscarding(true);
                    void onDiscard().finally(() => {
                      setDiscarding(false);
                      setStep("diff");
                    });
                  }}
                >
                  Discard
                </button>
                <button type="button" onClick={() => setStep("diff")}>
                  Keep them
                </button>
                <span className="edit-keys muted key-hint">
                  <Keys keys="Enter" /> discard <Keys keys="Escape" /> keep
                </span>
              </div>
            </div>
          )}
          {showing === "publish" && (
            <form
              className="publish-form"
              aria-label="Publish the Pending changes"
              onSubmit={(e) => {
                e.preventDefault();
                publish();
              }}
            >
              <p className="muted publish-what">
                Commits <code>roster.yml</code> alone and pushes it to the infra repo&rsquo;s upstream, never forced. Every
                Box gets it on its next pull; this one runs <code>roster sync</code> straight after.
              </p>
              <div className="edit-field">
                <label htmlFor="publish-message">Commit message</label>
                <textarea
                  id="publish-message"
                  ref={messageBox}
                  className="mono"
                  rows={Math.min(8, Math.max(2, message.split("\n").length + 1))}
                  value={message}
                  spellCheck={false}
                  disabled={publishing}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      publish();
                    }
                  }}
                />
              </div>
              {problem && (
                <div className="edit-problem" role="alert">
                  <ProblemBody problem={problem} rows={rows} actions={actions} notInTab />
                </div>
              )}
              <div className="edit-actions">
                <button type="submit" className="primary" disabled={publishing || !message.trim()}>
                  {publishing ? "Publishing…" : "Publish"}
                </button>
                <button type="button" disabled={publishing} onClick={() => setStep("diff")}>
                  Back
                </button>
                <span className="edit-keys muted key-hint">
                  <Keys keys="Ctrl+Enter" /> publish <Keys keys="Escape" /> back
                </span>
              </div>
            </form>
          )}
          {showing === "diff" && (
            <div className="edit-actions">
              {canPublish && (
                <button type="button" className="primary" onClick={() => setStep("publish")}>
                  Publish…
                </button>
              )}
              <button type="button" onClick={() => setStep("discard")}>
                Discard…
              </button>
              {!canPublish && (
                <span className="edit-keys muted key-hint">This roster can&rsquo;t publish (it needs API 7); they stay on this Box.</span>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** What a Publish did: the commit (short hash, the full one on hover), where it went, and whether
 * this Box's ssh config followed. */
function Published({ result, copy }: { result: PublishResult; copy: ProblemActions["copy"] }) {
  const subject = result.message.split("\n")[0] ?? "";
  return (
    <div className="publish-done" role="status">
      <p>
        Published{" "}
        <code className="publish-hash" title={result.commit}>
          {short(result.commit)}
        </code>{" "}
        to <span className="mono">{result.upstream}</span>
        {result.pulled > 0 && <span className="muted"> (after {countOf(result.pulled, "new commit")} there)</span>}.
      </p>
      <p className="muted publish-subject">{subject}</p>
      {result.sync.ok ? (
        <p className="muted">This Box&rsquo;s ssh config follows it (roster sync ran). Other Boxes get it on their next pull.</p>
      ) : (
        <div className="publish-sync-failed">
          <p>
            Published, but this Box&rsquo;s ssh config didn&rsquo;t follow: {result.sync.error ?? "roster sync failed"}.
          </p>
          <CopyCommand text="roster sync" copy={copy} />
        </div>
      )}
    </div>
  );
}
