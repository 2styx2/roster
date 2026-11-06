// `:tutor`'s demo Inventory (ticket 55, decision Q76): while a tutorial runs, a second workspace on a
// fake Backend and a State in memory sits in front of yours; leaving throws it away.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Backend } from "../backend/types";
import type { DemoPlugins } from "../plugins/manager";
import type { Platform } from "../platform/types";
import type { StateStore } from "../state/store";
import { demoBackend, demoPlatform } from "./demo";
import { TutorProgress, type TutorialDef } from "./tutor";

/** What a workspace knows of `:tutor`: the progress (in the real State), and either how to start a
 * tutorial (the real workspace) or the one running on the demo Inventory. */
export interface TutorLink {
  progress: TutorProgress;
  /** Starts `tutorial` on the demo, with `plugins` (the ones running here) loaded there too. */
  start?(tutorial: TutorialDef, plugins?: DemoPlugins): void;
  demo?: {
    tutorial: TutorialDef;
    leave(): void;
    switchTo(tutorial: TutorialDef): void;
    /** Registers what stops this workspace's Plugins when the demo ends (ticket 66). */
    onStop(stop: () => void): () => void;
    /** Why your Plugins aren't in the demo, said once; null when they are. */
    problem: string | null;
  };
}

export interface Demo {
  /** Your workspace's link. */
  real: TutorLink;
  /** The demo's, and what it runs on, once its fake Backend has loaded. */
  demo: { link: TutorLink; backend: Backend; platform: Platform } | null;
}

export function useDemo(realBackend: Backend, platform: Platform, store: StateStore): Demo {
  const [progress] = useState(() => new TutorProgress(store));
  // The tutorial asked for, and the Plugins of yours it brings along (ticket 66).
  const [tutorial, setTutorial] = useState<TutorialDef | null>(null);
  const [plugins, setPlugins] = useState<DemoPlugins | null>(null);
  const [loaded, setLoaded] = useState<{ backend: Backend; platform: Platform; problem: string | null; close(): Promise<void> } | null>(null);
  // What stops the demo's Plugin manager (its workspace registers it), run before the demo goes.
  const [stoppers] = useState(() => new Set<() => void>());
  useEffect(() => {
    if (!tutorial || loaded) return;
    let live = true;
    void demoBackend(realBackend, plugins ?? undefined).then((demo) => {
      if (live) setLoaded({ backend: demo.backend, platform: demoPlatform(platform, (k) => store.get(k), demo.plugins ?? undefined), problem: demo.problem, close: demo.close });
      else void demo.close();
    });
    return () => {
      live = false;
    };
  }, [tutorial, loaded, platform, store, realBackend, plugins]);
  // Another tutorial while one runs: the same demo, the new tutorial.
  const start = useCallback((def: TutorialDef, yours?: DemoPlugins) => {
    setTutorial(def);
    if (yours) setPlugins(yours);
  }, []);
  // Leaving stops the demo's Plugins and throws their files away (the core does it too when the
  // app quits).
  const leave = useCallback(() => {
    for (const stop of [...stoppers]) stop();
    stoppers.clear();
    void loaded?.close();
    setTutorial(null);
    setPlugins(null);
    setLoaded(null);
  }, [loaded, stoppers]);
  const onStop = useCallback(
    (stop: () => void) => {
      stoppers.add(stop);
      return () => void stoppers.delete(stop);
    },
    [stoppers],
  );
  const real = useMemo(() => ({ progress, start }), [progress, start]);
  const problem = loaded?.problem ?? null;
  const link = useMemo(
    () => (tutorial ? { progress, demo: { tutorial, leave, switchTo: start, onStop, problem } } : null),
    [tutorial, progress, leave, start, onStop, problem],
  );
  return { real, demo: link && loaded ? { link, backend: loaded.backend, platform: loaded.platform } : null };
}
