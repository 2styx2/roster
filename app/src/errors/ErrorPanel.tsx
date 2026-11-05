// A clean error (docs/app/errors.md): the Host, what happened in plain words, where it lives, the fix
// as an action where the app can do it (or the command to copy where it can't), the row's extras,
// and the raw text under Details. The Session pane shows it for a refused or failed Session, and
// `:check` shows the same body for its failing step. Everything comes from the catalog row, so a
// Plugin's row renders the same way. There is never a button that accepts a host key.
import { useContext, useState } from "react";
import { fixFor, sentence, type ErrorAction, type ErrorExtra, type ErrorRow, rowFor } from "./catalog";
import type { Problem, ProblemData } from "./classify";
import { RosterApi } from "./rosterApi";
import { withCode } from "../lock/withCode";

export interface ProblemActions {
  /** Runs a command line (`reconnect`, `check HOST`, `lock`, `find`). */
  run(line: string): void;
  /** Puts a command on the clipboard. */
  copy(text: string): Promise<void>;
}

/** A command to run, with a Copy button. */
export function CopyCommand({ text, copy }: { text: string; copy: ProblemActions["copy"] }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="problem-copy">
      <code>{text}</code>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void copy(text).then(() => setCopied(true), () => {})}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

function Action({ action, problem, actions }: { action: ErrorAction; problem: Problem; actions: ProblemActions }) {
  const api = useContext(RosterApi);
  if (action.kind === "copy") {
    const text = action.text(problem, { api });
    return text ? <CopyCommand text={text} copy={actions.copy} /> : null;
  }
  return (
    <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => actions.run(action.line(problem))}>
      {action.label}
    </button>
  );
}

const VERIFY = "for k in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf \"$k\"; done";

function Fingerprints({ data }: { data: ProblemData }) {
  const recorded = Array.isArray(data.recorded) ? data.recorded : [];
  return (
    <div className="problem-extra">
      <dl className="problem-facts">
        {(recorded.length > 0 || data.recordedAt) && (
          <>
            <dt>Recorded</dt>
            <dd>
              {recorded.map((f) => (
                <code key={f}>{f}</code>
              ))}
              {data.recordedAt && (
                <span className="muted">
                  {recorded.length ? " " : ""}in <code>{data.recordedAt}</code>
                </span>
              )}
            </dd>
          </>
        )}
        {data.offered && (
          <>
            <dt>Offered</dt>
            <dd>
              <code>{data.offered}</code>
            </dd>
          </>
        )}
      </dl>
      <p className="muted">
        To verify, run <code>{VERIFY}</code> on the Host's console (or ask its owner) and compare. roster never accepts a
        host key by itself.
      </p>
    </div>
  );
}

const extras: Record<ErrorExtra, (data: ProblemData) => React.ReactNode> = {
  near: (data) =>
    data.near?.length ? (
      <div className="problem-extra">
        <span className="muted">Similar item names:</span>
        <ul aria-label="Similar item names">
          {data.near.map((n) => (
            <li key={n}>
              <code>{n}</code>
            </li>
          ))}
        </ul>
      </div>
    ) : null,
  matches: (data) =>
    data.matches?.length ? (
      <table className="problem-extra problem-matches" aria-label="Matching vault items">
        <thead>
          <tr>
            <th>Name</th>
            <th>Last edited</th>
            <th>URIs</th>
          </tr>
        </thead>
        <tbody>
          {data.matches.map((m, i) => (
            <tr key={i}>
              <td>{m.name}</td>
              <td>{m.revised ?? "?"}</td>
              <td>{(m.uris ?? []).join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : null,
  fingerprints: (data) => <Fingerprints data={data} />,
};

const WHERE_LABEL = "Where";

export interface ProblemBodyProps {
  problem: Problem;
  rows: readonly ErrorRow[];
  actions: ProblemActions;
  /** Hide actions (the check panel shows them only for its failing step). */
  noActions?: boolean;
  /** Leave out actions that act on the current tab (`reconnect`): the check panel isn't a tab. */
  notInTab?: boolean;
}

/** The message, where, fix, extras, actions and Details of one Problem. */
export function ProblemBody({ problem, rows, actions, noActions, notInTab }: ProblemBodyProps) {
  const api = useContext(RosterApi);
  const row = rowFor(rows, problem.code);
  const shown = row.actions.filter(
    (a) => !(notInTab && a.kind === "run" && a.line(problem) === "reconnect") && !(problem.quick && a.hostOnly),
  );
  const data = problem.data ?? {};
  return (
    <>
      <p className="problem-message">{withCode(sentence(problem.message, problem.host))}</p>
      <dl className="problem-facts">
        <dt>{WHERE_LABEL}</dt>
        <dd>{row.where.join(", ")}</dd>
        <dt>Fix</dt>
        <dd>{withCode(fixFor(row, problem, { api }))}</dd>
      </dl>
      {row.extras?.map((x) => (
        <div key={x}>{extras[x](data)}</div>
      ))}
      {!noActions && shown.length > 0 && (
        <div className="problem-actions">
          {shown.map((a, i) => (
            <Action key={i} action={a} problem={problem} actions={actions} />
          ))}
        </div>
      )}
      {problem.details && (
        <details className="problem-details">
          <summary>Details</summary>
          <pre>{problem.details}</pre>
        </details>
      )}
    </>
  );
}

export interface ErrorPanelProps extends ProblemBodyProps {
  /** "Couldn't open a Session" or "Session ended". */
  title: string;
}

/** The Session pane's error: the Host as the heading, then the Problem. */
export function ErrorPanel({ title, ...body }: ErrorPanelProps) {
  return (
    <section className="problem" role="alert" aria-label={`${title}: ${body.problem.host}`}>
      <h2>
        <span className="muted">{title} · </span>
        {body.problem.host}
      </h2>
      <ProblemBody {...body} />
    </section>
  );
}
