// The pull before an Inventory write (decision Q88, amending Q13 and ticket 10's pull on opening).
// A form (`:edit`, `:host add`, Save to vault) opens at once from the Inventory the app already
// has. If the last good pull of the infra repo is older than `pull_fresh_minutes`, it pulls in the
// background meanwhile; the form's Save waits for that pull, and pulls again if the form sat open
// past the window, so a write still never lands on a repo that wasn't pulled within the window,
// and a diverged or failed pull still blocks it with the same errors (62-63, rows 39-41).
//
// One gate per Backend, held by App: forms share it with `:pull`, so two forms opened a minute
// apart pull once, and a pull already running is joined, never started twice.
import { useCallback, useEffect, useRef, useState } from "react";
import { problemFromCallError } from "../errors/catalog";
import type { Problem } from "../errors/classify";
import type { BoxSync, PullResult } from "../backend/types";

/** What a form's pull came to: no pull needed (the last good one was `ago` ms back), or what the pull did. */
export type PullOutcome = { fresh: true; ago: number } | { fresh: false; result: PullResult };

export interface PullGate {
  /** Pulls unless the last good pull is fresh; joins a pull already running. Rejects as the pull did. */
  ensure(): Promise<PullOutcome>;
  /** Pulls now, whatever the window (`:pull`), and counts it as the last good pull. */
  pull(): Promise<PullResult>;
}

export interface PullGateOptions {
  /** The freshness window in ms, read on each call (a `:source` may change it). 0: always pull. */
  windowMs(): number;
  now(): number;
  /** A pull brought new commits: the app reads the Inventory again. */
  onUpdated(result: PullResult): void;
}

export function pullGate(pull: () => Promise<PullResult>, opts: PullGateOptions): PullGate {
  let lastGood: number | null = null;
  let running: Promise<PullResult> | null = null;
  const start = () => {
    running ??= pull().then(
      (result) => {
        running = null;
        lastGood = opts.now();
        if (result.updated) opts.onUpdated(result);
        return result;
      },
      (e: unknown) => {
        running = null;
        throw e;
      },
    );
    return running;
  };
  return {
    ensure() {
      const window = opts.windowMs();
      const ago = lastGood === null ? null : opts.now() - lastGood;
      if (!running && window > 0 && ago !== null && ago < window) return Promise.resolve({ fresh: true, ago });
      return start().then((result) => ({ fresh: false, result }));
    },
    pull: start,
  };
}

/** A form's view of its pull. `skipped`: Pending changes are already here (the repo was pulled
 * before the first one, and a pull now would refuse them), so it doesn't pull at all. */
export type FormPull =
  | { at: "skipped" }
  | { at: "fresh"; ago: number }
  | { at: "pulling" }
  | { at: "pulled"; result: PullResult }
  | { at: "failed"; problem: Problem };

/** Starts the form's background pull on opening (unless `skip`), and gives Save the same check:
 * `ready()` resolves to what the pull did, or null when it failed (the state says why). */
export function useFormPull(
  gate: PullGate,
  skip: boolean,
  subject: string,
  onResult?: (outcome: PullOutcome) => void,
): {
  state: FormPull;
  ready(): Promise<PullOutcome | "skipped" | null>;
  retry(): void;
} {
  const [state, setState] = useState<FormPull>(() => (skip ? { at: "skipped" } : { at: "pulling" }));
  const live = useRef(true);
  const onResultRef = useRef(onResult);
  useEffect(() => {
    onResultRef.current = onResult;
  });
  const skipRef = useRef(skip);
  useEffect(() => {
    skipRef.current = skip;
  });

  const ready = useCallback(async (): Promise<PullOutcome | "skipped" | null> => {
    if (skipRef.current) return "skipped";
    setState((s) => (s.at === "fresh" || s.at === "pulled" ? s : { at: "pulling" }));
    try {
      const outcome = await gate.ensure();
      if (!live.current) return null;
      setState((s) =>
        outcome.fresh ? (s.at === "pulled" ? s : { at: "fresh", ago: outcome.ago }) : { at: "pulled", result: outcome.result },
      );
      onResultRef.current?.(outcome);
      return outcome;
    } catch (e) {
      if (live.current) setState({ at: "failed", problem: problemFromCallError(subject, e) });
      return null;
    }
  }, [gate, subject]);

  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    live.current = true;
    if (!skipRef.current) void ready();
    return () => {
      live.current = false;
    };
  }, [ready, attempt]);

  return { state, ready, retry: () => setAttempt((n) => n + 1) };
}

/** The form's one line about the pull. */
export function pullLine(state: FormPull): string {
  switch (state.at) {
    case "skipped":
      return "Pending changes are already here, so roster didn't pull.";
    case "fresh": {
      const minutes = Math.floor(state.ago / 60_000);
      const when = minutes < 1 ? "under a minute" : `${minutes} minute${minutes === 1 ? "" : "s"}`;
      return `Pulled the infra repo ${when} ago, so roster didn't pull again.`;
    }
    case "pulling":
      return "Pulling the infra repo in the background…";
    case "failed":
      return "Couldn't pull the infra repo, so nothing can be saved yet.";
    case "pulled": {
      const p = state.result;
      if (!p.upstream) return "No upstream to pull from; this Box's copy is the one.";
      if (p.updated) return `Pulled ${p.commits} new commit${p.commits === 1 ? "" : "s"} from ${p.upstream}${afterPull(p)}.`;
      return `Up to date with ${p.upstream}.`;
    }
  }
}

/** A `roster sync` that failed after a change roster wrote (T150): the change stands, but this
 * Box's ssh config didn't follow. */
export function syncFailed(sync: BoxSync): string {
  return `this Box's ssh config didn't follow (${sync.error ?? "roster sync failed"}): run roster sync`;
}

/** ", but SYNC FAILED" after a pull that brought commits and whose sync failed (T153), or nothing. */
export function afterPull(r: PullResult): string {
  return r.sync && !r.sync.ok ? `, but ${syncFailed(r.sync)}` : "";
}
