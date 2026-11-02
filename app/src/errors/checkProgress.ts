// `:check HOST` as it runs (ticket 110, #193): serve's check job sends `job.progress` as each step
// starts (API 21, decision Q112 (q)), never a step's message or status. So while it runs the panel
// knows only which step is under way: the ones before it are done (ok, or skipped by design as a key
// Login's vault steps are), the rest still to come. The answer then says how each came out.
import { CHECK_STEPS, type HostCheck, type JobProgress } from "../backend/types";

export type CheckState =
  /** `at`: the step under way (null before the first, or on a serve before API 21, which sends
   * none); `since`: when it started, in ms. */
  | { state: "running"; host: string; at: string | null; since: number }
  | { state: "done"; host: string; result: HostCheck; at: string | null }
  /** The call failed (the core gave up after 90 s, serve went away): `at` is where it was. */
  | { state: "error"; host: string; message: string; at: string | null };

/** A check of `host` has started (or been asked again: serve joins a check of a Host that's
 * running, so asking again while it runs keeps where it is). */
export function checkStarted(prev: CheckState | null, host: string, now: number): CheckState {
  if (prev?.state === "running" && prev.host === host) return prev;
  return { state: "running", host, at: null, since: now };
}

/** serve's `job.progress`: moves a running check of the same Host on to the step that started.
 * Another Host's check, another kind of job, and a job's last word (it ended: the answer is on its
 * way) change nothing. One check per Host runs at a time, so any running check of this Host is the
 * one asked for, or the one it joined. */
export function checkProgressed(check: CheckState | null, job: JobProgress, now: number): CheckState | null {
  if (check?.state !== "running" || job.kind !== "check" || job.host !== check.host) return check;
  if (job.state !== "running" || job.at === check.at) return check;
  return { ...check, at: job.at, since: now };
}

export type LiveStatus = "pending" | "running" | "done" | "stopped";

/** Each step while the check runs, or where it was when the call failed (`stopped`). */
export function liveSteps(at: string | null, ended: boolean): { step: string; status: LiveStatus }[] {
  const under = at === null ? -1 : (CHECK_STEPS as readonly string[]).indexOf(at);
  return CHECK_STEPS.map((step, i) => ({
    step,
    status: i < under ? "done" : i === under ? (ended ? "stopped" : "running") : "pending",
  }));
}

/** serve's word for a step a stop skipped (diagnose.py). */
const STOPPED = "the check was stopped";

/** The step a stopped check stopped at (a lock stops a check at its next step: Q112 (q)), or null
 * when it passed or failed a step. Not ok with no failed step means it was stopped. */
export function stoppedStep(result: HostCheck, at: string | null): string | null {
  if (result.ok || result.steps.some((s) => s.status === "fail")) return null;
  return result.steps.find((s) => s.message === STOPPED)?.step ?? at ?? result.steps.find((s) => s.status === "skipped")?.step ?? null;
}
