// The Config in the workspace (ticket 21): the one the app started with, then each save's, and
// what it makes of it. A broken save comes with the last good Config and the error, so nothing
// changes but the toast.
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useLatest } from "../ui/latest";
import type { Platform } from "../platform/types";
import type { Registries } from "../registries";
import { deriveConfig, registerConfig, type ConfigWarning } from "./apply";
import { initLuaReloader } from "./source";
import type { ConfigReport } from "./types";

export interface ConfigState {
  report: ConfigReport | null;
  config: ConfigReport["config"] | null;
  derived: ReturnType<typeof deriveConfig> | null;
  /** What registering the Config's keys, Themes and Folders found. */
  warnings: readonly ConfigWarning[];
  /** Config files saved since their last reload and not applied yet ("init.lua", "roster.yml"):
   * the status bar's quiet hint to `:source` (decision Q58). */
  stale: readonly string[];
  setStale(file: string, on: boolean): void;
  /** A report from a reload: the newest wins, and init.lua is applied. */
  take(r: ConfigReport): void;
}

export function useConfigReport(platform: Platform, registries: Registries, initial: ConfigReport | null): ConfigState {
  const [report, setReport] = useState<ConfigReport | null>(initial);
  const [stale, setStaleFiles] = useState<readonly string[]>([]);
  const setStale = useCallback((file: string, on: boolean) => {
    setStaleFiles((s) => (s.includes(file) === on ? s : on ? [...s, file] : s.filter((f) => f !== file)));
  }, []);
  // One that arrives late (or twice) never replaces a newer one.
  const take = useCallback((r: ConfigReport) => {
    setStale("init.lua", false);
    setReport((cur) => (cur && cur.version >= r.version ? cur : r));
  }, [setStale]);
  useEffect(() => {
    const source = platform.config;
    if (!source) return;
    let live = true;
    // Listen first, then ask again: a save between main.tsx's load and now isn't lost.
    const stopChanges = source.watch(take);
    // A save that wasn't applied (auto_reload off, decision Q58): a quiet hint to :source.
    const stopStale = source.watchStale(() => setStale("init.lua", true));
    // A load that fails leaves the Config the app started with; the error screen or the toast has
    // said what's wrong with it already.
    source.load().then(
      (r) => {
        if (live && r) take(r);
      },
      () => {},
    );
    return () => {
      live = false;
      stopChanges();
      stopStale();
    };
  }, [platform, take, setStale]);
  // init.lua is what `:source` reloads (decision Q58).
  const path = useLatest(report?.path ?? null);
  useEffect(() => {
    const source = platform.config;
    if (!source) return;
    return registries.reloaders.register(
      initLuaReloader({
        path: path.get,
        reload: async () => {
          const r = await source.reload();
          if (r) take(r);
          return r;
        },
      }),
    );
  }, [registries, platform, take, path]);

  const config = report?.config ?? null;
  const derived = useMemo(() => (config ? deriveConfig(config) : null), [config]);
  // Keys, Themes and Folders go through the registries as "init.lua"; the next Config replaces
  // them. Before paint, so a custom Theme never flashes the default.
  const [warnings, setWarnings] = useState<readonly ConfigWarning[]>([]);
  useLayoutEffect(() => {
    if (!config) return;
    const registered = registerConfig(registries, config);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- what registering found is its result
    setWarnings(registered.warnings);
    return registered.dispose;
  }, [registries, config]);
  return { report, config, derived, warnings, stale, setStale, take };
}
