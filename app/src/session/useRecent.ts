// The Hosts you opened last, for the idle pane's map (Q218, Q221, Q223), and the window's title.
import { useEffect, useMemo, useRef } from "react";
import type { Host, HostList } from "../backend/types";
import { usedHost } from "../state/appState";
import type { StateStore } from "../state/store";
import type { TabsSnapshot } from "./tabs";

/** A Host goes on the Recent list once its Session reaches a shell (round 21: one whose key
 * question was cancelled, never logged in, was listed). Each attempt counts once. Returns the idle
 * pane's list: the last Hosts opened that are still in the Inventory and reviewed, at most six;
 * with no history yet (a first launch), the Inventory's first reviewed Hosts, so the first screen
 * shows the network too (Q223). */
export function useRecent(o: { sessions: TabsSnapshot; store: StateStore; hosts: HostList | null; recentHosts: readonly string[] }): {
  hosts: readonly Host[];
  title: string;
} {
  const { sessions, store, hosts, recentHosts } = o;
  const shelled = useRef(new Set<string>());
  useEffect(() => {
    for (const t of sessions.tabs) {
      const at = `${t.id}:${t.attempt}`;
      if (t.quick || !t.shell || shelled.current.has(at)) continue;
      shelled.current.add(at);
      store.update((s) => usedHost(s, t.host));
    }
  }, [sessions, store]);
  return useMemo(() => {
    const all = hosts?.hosts ?? [];
    const byName = new Map(all.map((h) => [h.name, h]));
    const recent = recentHosts
      .flatMap((n) => {
        const h = byName.get(n);
        return h && h.reviewed ? [h] : [];
      })
      .slice(0, 6);
    return recent.length > 0 ? { hosts: recent, title: "Recent" } : { hosts: all.filter((h) => h.reviewed).slice(0, 6), title: "In the Inventory" };
  }, [hosts, recentHosts]);
}

/** The window's title names the Session on screen ("esx-02 — roster"), as editors name the file. */
export function useWindowTitle(sessions: TabsSnapshot): void {
  const titleOf = sessions.tabs.find((t) => t.id === sessions.active)?.label;
  useEffect(() => {
    document.title = titleOf ? `${titleOf} — roster` : "roster";
  }, [titleOf]);
}
