// `:check HOST`: roster's `host.check` steps as a list, each ok, failed or skipped, with the
// failing one expanded into the same clean error a Session shows (where, fix, extras, Details).
// roster runs the steps; this only shows them. A check makes at most one connection and one login.
// While it runs (ticket 110) every step has its row from the start, so nothing moves as steps come
// in: the one under way is the accent (live), drawn to as it starts, the rest muted until the answer.
import { useEffect, useState } from "react";
import type { CheckStep } from "../backend/types";
import { problemFromStep, type ErrorRow } from "./catalog";
import { ProblemBody, type ProblemActions } from "./ErrorPanel";
import { CloseGlyph } from "../ui/CloseGlyph";
import { PanelButton } from "../panel/PanelFrame";
import { liveSteps, stoppedStep, type CheckState, type LiveStatus } from "./checkProgress";

export type { CheckState } from "./checkProgress";

const STEP_LABEL: Record<string, string> = {
  inventory: "Inventory entry",
  user: "User",
  "ssh-config": "ssh config",
  provider: "Provider ready",
  "vault-item": "Vault item",
  dns: "DNS",
  tcp: "TCP port",
  "host-key": "Host key",
  auth: "Login",
};

const MARK = { ok: "✓", fail: "✗", skipped: "–" } as const;
/** The mark in words: an aria-label on a plain span is ignored, so it's hidden text. */
const RESULT = { ok: "passed", fail: "failed", skipped: "skipped" } as const;
const LIVE_WORDS: Record<LiveStatus, string> = { pending: "to come", running: "under way", done: "done", stopped: "stopped here" };
/** Where a stopped check stopped: a square, as a stopped job's. */
const STOP_MARK = "■";
/** A step under way this long shows how long it's taken, so a step that hangs to its timeout
 * doesn't look frozen. */
const ELAPSED_FROM_S = 3;
/** A screen reader hears the step under way once it has run this long: the local steps take
 * milliseconds, and hearing each would be a flood. */
const SAY_AFTER_MS = 600;

const label = (step: string) => STEP_LABEL[step] ?? step;

export interface CheckPanelProps {
  check: CheckState;
  rows: readonly ErrorRow[];
  actions: ProblemActions;
  onClose(): void;
}

export function CheckPanel({ check, rows, actions, onClose }: CheckPanelProps) {
  const { host } = check;
  const stopped = check.state === "done" ? stoppedStep(check.result, check.at) : null;
  const failed = check.state === "done" ? check.result.steps.find((s) => s.status === "fail") : undefined;
  const summary =
    check.state !== "done"
      ? null
      : check.result.ok
        ? "All checks passed."
        : failed
          ? `Failed at ${label(failed.step)}; the rest were skipped.`
          : `Stopped at ${label(stopped ?? "")}; the rest were skipped.`;
  // The step under way, for a screen reader (the summary line below says the outcome itself).
  const said = check.state === "running" && check.at !== null ? `Checking ${label(check.at)}` : "";
  const spoken = useSaid(said, SAY_AFTER_MS);
  const line =
    check.state === "running"
      ? { className: "check-summary muted", text: `Checking ${host}…` }
      : check.state === "error"
        ? { className: "problem-message", text: check.message }
        : { className: `check-summary ${check.result.ok ? "check-ok" : "muted"}`, text: summary };
  return (
    <section className="check-panel" role="region" aria-label={`Check ${host}`}>
      <header>
        <h2>
          <span className="muted">Check · </span>
          {host}
        </h2>
        <span className="panel-head-buttons">
          <PanelButton />
          <button type="button" className="icon-button close" aria-label="Close the check" onClick={onClose}>
            <CloseGlyph />
          </button>
        </span>
      </header>
      <span className="visually-hidden" aria-live="polite" aria-atomic="true">
        {spoken}
      </span>
      {/* One line, the same element throughout, so its change to the outcome is heard once. */}
      <p className={line.className} aria-live="polite" title={line.text ?? undefined}>
        {line.text}
      </p>
      {check.state === "running" && <LiveSteps at={check.at} since={check.since} ended={false} />}
      {check.state === "error" && check.at !== null && <LiveSteps at={check.at} since={0} ended />}
      {check.state === "done" && (
        <CheckSteps host={host} steps={check.result.steps} rows={rows} actions={actions} stopped={stopped} />
      )}
    </section>
  );
}

/** `text` for the panel's live region once it has stayed the same for `after` ms (cleared at once). */
function useSaid(text: string, after: number): string {
  const [heard, setHeard] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setHeard(text), text === "" ? 0 : after);
    return () => clearTimeout(t);
  }, [text, after]);
  return text === "" ? "" : heard;
}

/** Seconds since `since`, ticking once a second while `on`. */
function useSecondsSince(since: number, on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since, on]);
  return Math.max(0, Math.floor((now - since) / 1000));
}

/** A step's node while the check runs: a muted ring to come, the accent ring under way (as a
 * Session's while it connects), a muted dot once done. */
function StepNode({ status }: { status: LiveStatus }) {
  if (status === "stopped") return <>{STOP_MARK}</>;
  return (
    <svg className={`check-node ${status}`} viewBox="0 0 8 8" width="8" height="8" aria-hidden="true">
      <circle cx="4" cy="4" r="3.25" />
    </svg>
  );
}

/** The steps while the check runs (`ended` false), or where it was when the call failed. */
function LiveSteps({ at, since, ended }: { at: string | null; since: number; ended: boolean }) {
  const steps = liveSteps(at, ended);
  const secs = useSecondsSince(since, !ended && at !== null);
  return (
    <ol className="check-steps">
      {steps.map(({ step, status }) => (
        <li
          key={step}
          data-step={step}
          data-status={status}
          data-stopped={status === "stopped" ? "" : undefined}
          className={`check-step ${status}`}
        >
          <div className="check-line">
            <span className="check-mark" aria-hidden="true">
              <StepNode status={status} />
            </span>
            <span className="visually-hidden">{LIVE_WORDS[status]}: </span>
            <span className="check-name">{label(step)}</span>
            {status === "running" && secs >= ELAPSED_FROM_S && <span className="check-elapsed">{secs} s</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}

export interface CheckStepsProps {
  host: string;
  steps: readonly CheckStep[];
  rows: readonly ErrorRow[];
  actions: ProblemActions;
  /** The step a stopped check stopped at, marked as such. */
  stopped?: string | null;
}

/** Steps as a list, ok, failed or skipped, the failing one as a clean error (`host.check`, and the
 * edit form's test login, `host.verify_login`). */
export function CheckSteps({ host, steps, rows, actions, stopped = null }: CheckStepsProps) {
  return (
    <ol className="check-steps">
      {steps.map((s) => (
        <li
          key={s.step}
          data-step={s.step}
          data-status={s.status}
          data-stopped={s.step === stopped ? "" : undefined}
          className={`check-step ${s.status}${s.step === stopped ? " stopped" : ""}`}
        >
          <div className="check-line">
            <span className="check-mark" aria-hidden="true">
              {s.step === stopped ? STOP_MARK : MARK[s.status]}
            </span>
            <span className="visually-hidden">{s.step === stopped ? LIVE_WORDS.stopped : RESULT[s.status]}: </span>
            <span className="check-name">{label(s.step)}</span>
            {s.status !== "fail" && (
              <span className="check-msg muted" title={s.message}>
                {s.message}
              </span>
            )}
          </div>
          {s.status === "fail" && (
            <div className="check-problem">
              <ProblemBody problem={problemFromStep(host, s)} rows={rows} actions={actions} notInTab />
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
