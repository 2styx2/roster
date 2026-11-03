// The Backend didn't start: the same clean error as everywhere else (decision Q44, ticket 29 S9):
// what happened, where it lives, the fix with its commands to copy, Retry, and roster's raw output
// one click away under Details.
import type { BackendProblem, BackendProblemKind } from "./backend/types";
import { CopyCommand } from "./errors/ErrorPanel";
import { withCode } from "./lock/withCode";

const HEADINGS: Record<BackendProblemKind, string> = {
  "no-wsl": "No WSL distro",
  "roster-missing": "roster wasn't found",
  "roster-too-old": "roster is too old",
  "inventory-not-found": "No Inventory",
  failed: "The backend didn't start",
};

const WHERE: Record<BackendProblemKind, string> = {
  "no-wsl": "this Box: WSL",
  "roster-missing": "this Box: the roster command",
  "roster-too-old": "this Box: the roster that's installed",
  "inventory-not-found": "roster.yml on this Box",
  failed: "this Box: roster serve",
};

/** The commands a hint puts in backticks, to copy. */
const commandsIn = (text: string) => text.split("`").filter((_, i) => i % 2 === 1);

export function ErrorScreen({
  problem,
  note,
  onRetry,
  copy,
}: {
  problem: BackendProblem;
  /** What led here, when the app knows more than the problem says (a switch of Inventory). */
  note?: string | null | undefined;
  onRetry: () => void;
  copy?: ((text: string) => Promise<void>) | undefined;
}) {
  const heading = HEADINGS[problem.kind];
  return (
    <div className="screen center">
      <section className="error" role="region" aria-label={heading} aria-live="polite">
        <h1>{heading}</h1>
        {note && <p className="problem-message">{note}</p>}
        <p className="problem-message">{withCode(problem.message)}</p>
        <dl className="problem-facts">
          <dt>Where</dt>
          <dd>{WHERE[problem.kind]}</dd>
          <dt>Fix</dt>
          <dd>{withCode(problem.hint)}</dd>
        </dl>
        {copy && commandsIn(problem.hint).length > 0 && (
          <div className="problem-actions">
            {commandsIn(problem.hint).map((c) => (
              <CopyCommand key={c} text={c} copy={copy} />
            ))}
          </div>
        )}
        <div className="problem-actions">
          <button type="button" className="primary" onClick={onRetry} autoFocus>
            Retry
          </button>
        </div>
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
