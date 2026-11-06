// `:check` (tickets 26, 49, 110): a Host's check in the check panel, as serve's check job says
// which step it's on; this Box's health with no Host, shown as `:help health`; and Stop.
import { useEffect, useRef, useState } from "react";
import type { Capabilities } from "../backend/capabilities";
import type { Backend, BackendInfo, CheckStarted } from "../backend/types";
import type { ConfigReport } from "../config/types";
import type { ConfigWarning } from "../config/apply";
import { runHealth, type HealthContext, type HealthReport } from "../health/health";
import { fontFound, type FontProbe } from "../terminal/fonts";
import type { Registries } from "../registries";
import type { TerminalOptions } from "../terminal/options";
import { errorText } from "../ui/format";
import type { Message } from "../ui/messages";
import type { Layer } from "../panel/stack";
import type { CheckState } from "./CheckPanel";
import { checkJoined, checkOwned, checkProgressed, checkStarted, checkStopFailed, checkStopping, stopTarget } from "./checkProgress";

export interface CheckActions {
  /** The check panel's check, or null while it's closed. */
  check: CheckState | null;
  /** This Box's health (`:check` alone), or null before the first. */
  health: HealthReport | null;
  /** Checks `host` (it's in the Inventory). */
  checkHost(host: string): void;
  /** Every health section, shown as `:help health` (open at once, saying it's checking, then
   * filled in). roster's own sections need `box.check` (API 16). */
  checkBox(): void;
  /** `:check stop` and the panel's `x` (#361): stops the app's own check, or says why it can't. */
  stopOwn(): void;
  /** Stops the check's `job` (the panel's Stop, #221): serve stops it at its next step, and the
   * check's own answer then says where. A stop that doesn't reach serve offers Stop again. */
  stop(job: string): void;
  /** Closes the panel; a check still running there is no longer followed. */
  close(): void;
  /** The panel's place in the stack. */
  layer: Layer;
}

export function useCheck(opts: {
  backend: Backend;
  registries: Registries;
  info: BackendInfo | null;
  caps: Capabilities;
  report: ConfigReport | null;
  warnings: readonly ConfigWarning[];
  terminalOptions: TerminalOptions;
  fontInstalled: FontProbe | undefined;
  openHealth(): void;
  say(m: Message): void;
}): CheckActions {
  const { backend, info, caps, say } = opts;
  const [check, setCheck] = useState<CheckState | null>(null);
  const [health, setHealth] = useState<HealthReport | null>(null);
  // Each run's number: an answer for an earlier one (or a closed panel's) is dropped.
  const run = useRef(0);
  const healthRun = useRef(0);

  // serve's check job says which step it's on (API 21; an older serve sends nothing, and the panel
  // waits for the answer as before).
  const running = check?.state === "running";
  useEffect(() => {
    if (!info || !running) return;
    return backend.onJobProgress((job) => setCheck((c) => checkProgressed(c, job, Date.now())));
  }, [backend, info, running]);

  const stop = (job: string) => {
    const at = run.current;
    setCheck(checkStopping);
    backend.stopCheck(job).catch((e: unknown) => {
      if (at !== run.current) return;
      setCheck(checkStopFailed);
      say(`The check couldn't be stopped: ${errorText(e)}`);
    });
  };

  const checkHost = (host: string) => {
    if (!caps.has("check")) return say(caps.needsNewer("check"));
    const at = ++run.current;
    const current = () => at === run.current;
    setCheck((prev) => checkStarted(prev, host, Date.now()));
    // A check already running (serve joins it) sent its progress before now: ask once where it is.
    if (caps.has("checkJobs")) {
      backend.listJobs().then(
        (jobs) => current() && setCheck((c) => checkJoined(c, jobs, Date.now())),
        // Its progress still comes as it runs; only the steps before now go unsaid.
        () => undefined,
      );
    }
    // Where it was (ticket 110) stays with the answer: a stopped check's step, a failed call's.
    const where = (prev: CheckState | null) => (prev?.state === "running" && prev.host === host ? prev.at : null);
    // The core hands over the check's job as it starts: the app's own can be stopped (#221).
    const started = (s: CheckStarted) => current() && setCheck((c) => checkOwned(c, host, s));
    backend.checkHost(host, started).then(
      (result) => current() && setCheck((prev) => ({ state: "done", host, result, at: where(prev) })),
      (e: unknown) => current() && setCheck((prev) => ({ state: "error", host, message: errorText(e), at: where(prev) })),
    );
  };

  const checkBox = () => {
    const at = ++healthRun.current;
    setHealth({ state: "running" });
    opts.openHealth();
    const finish = async (box: HealthContext["box"], boxProblem: string | null) => {
      if (at !== healthRun.current) return;
      const hctx: HealthContext = {
        box,
        boxProblem,
        backend: info ? { name: info.backend, rosterVersion: info.inventory.roster_version, caps } : null,
        config: { path: opts.report?.path ?? null, error: opts.report?.error ?? null, warnings: opts.warnings },
        font: { families: opts.terminalOptions.fonts, inUse: fontFound(opts.terminalOptions.fonts, opts.fontInstalled ?? (() => null)) },
      };
      // A Plugin's section may answer later (ticket 60): the page says it's checking until then.
      const sections = await runHealth(opts.registries.health.list(), hctx);
      if (at === healthRun.current) setHealth({ state: "done", at: new Date(), sections });
    };
    if (!info || !caps.has("boxCheck")) return void finish(null, null);
    backend.checkBox().then(
      (box) => finish(box, null),
      (e: unknown) => finish(null, errorText(e)),
    );
  };

  const stopOwn = () => {
    const target = stopTarget(check, caps);
    if ("job" in target) stop(target.job);
    else say(target.message);
  };

  const close = () => {
    run.current++;
    setCheck(null);
  };

  return { check, health, checkHost, checkBox, stopOwn, stop, close, layer: { id: "check", open: check !== null, close } };
}
