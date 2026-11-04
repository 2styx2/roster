// `:check HOST` as it runs (ticket 110, #193): serve's check job sends `job.progress` as each step
// starts (API 21, decision Q112 (q)), never a step's message or status. So while it runs the panel
// knows only which step is under way: the ones before it are done (ok, or skipped by design as a key
// Login's vault steps are), the rest still to come. The answer then says how each came out.
import { CHECK_JOBS_API_VERSION, CHECK_STEPS, type CheckStarted, type HostCheck, type JobProgress } from "../backend/types";

export type CheckState =
  /** `at`: the step under way (null before the first, or on a serve before API 21, which sends
   * none); `since`: when it started, in ms; `job`: its job when it's the app's own to stop (#221
   * item 1), and `stopping` once Stop was pressed; `theirs` once the core says another caller
   * started it (a Plugin's), so it isn't the app's to stop (#361). */
  | { state: "running"; host: string; at: string | null; since: number; job?: string; stopping?: boolean; theirs?: boolean }
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

/** `jobs.list`, asked once as `:check` starts (issue #221): a check it joined that was already
 * running (started elsewhere, or before the app restarted) sent its progress before the panel
 * opened, so this fills in the step under way. Only while nothing newer has come: a `job.progress`
 * that arrived meanwhile wins over the list's older word. */
export function checkJoined(check: CheckState | null, jobs: readonly JobProgress[], now: number): CheckState | null {
  if (check?.state !== "running" || check.at !== null) return check;
  const job = jobs.find((j) => j.kind === "check" && j.host === check.host && j.state === "running");
  return job ? checkProgressed(check, job, now) : check;
}

/** The core says a check is under way: one the app started (or joined, having started it) can be
 * stopped. Another caller's check (a Plugin's) can't, and another Host's word changes nothing. */
export function checkOwned(check: CheckState | null, host: string, started: CheckStarted): CheckState | null {
  if (check?.state !== "running" || check.host !== host || check.job === started.job) return check;
  if (!started.own) return check.job === undefined && !check.theirs ? { ...check, theirs: true } : check;
  return { ...check, job: started.job };
}

/** What `:check stop` and the panel's `x` (#361) do now: stop the app's own check (its job), as
 * Stop does, or say why there's nothing of the app's to stop. `api`: serve's API version. */
export function stopTarget(check: CheckState | null, api: number): { job: string } | { message: string } {
  if (check?.state !== "running") return { message: "There's no check running to stop" };
  if (check.stopping) return { message: `The check of ${check.host} is already stopping` };
  if (check.job !== undefined) return { job: check.job };
  if (check.theirs) return { message: `The check of ${check.host} isn't the app's to stop: another caller started it` };
  if (api < CHECK_JOBS_API_VERSION) {
    return { message: `Stopping a check needs a newer roster (API version ${CHECK_JOBS_API_VERSION}; this one speaks ${api})` };
  }
  return { message: `The check of ${check.host} hasn't started yet: try again in a moment` };
}

/** Stop was pressed: the line says so until the answer comes, and there's no second Stop. */
export function checkStopping(check: CheckState | null): CheckState | null {
  return check?.state === "running" && check.job !== undefined ? { ...check, stopping: true } : check;
}

/** Stop didn't reach serve: Stop is offered again. */
export function checkStopFailed(check: CheckState | null): CheckState | null {
  return check?.state === "running" && check.stopping ? { ...check, stopping: false } : check;
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
