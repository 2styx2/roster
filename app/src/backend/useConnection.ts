// The workspace's link to roster serve: connecting (and again, on Retry or a new Backend in
// init.lua), what serve can do, and the Host list it last gave.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { servicesLeftOut } from "../inventory/said";
import type { Tabs } from "../session/tabs";
import type { Message } from "../ui/messages";
import { capabilities, type Capabilities } from "./capabilities";
import { BackendStartError, type Backend, type BackendInfo, type BackendProblem, type HostList } from "./types";

export type Conn =
  | { state: "connecting" }
  | { state: "failed"; problem: BackendProblem }
  | { state: "ready"; info: BackendInfo; hosts: HostList };

export interface Connection {
  conn: Conn;
  /** serve's `inventory.info` and Backend, while it's up. */
  info: BackendInfo | null;
  caps: Capabilities;
  hosts: HostList | null;
  /** Connects (`restart`: starts serve again); true once it's up with its Host list. */
  connect(restart: boolean): Promise<boolean>;
  /** The Inventory again, after roster.yml changed (an edit, a discard, a pull, an outside edit).
   * It updates in place: folds, the cursor and open Sessions stay. */
  reloadHosts(): void;
}

function asProblem(e: unknown): BackendProblem {
  if (e instanceof BackendStartError) return e.problem;
  const message = e instanceof Error ? e.message : String(e);
  return { kind: "failed", message, hint: "Retry, or run the backend command in a terminal to see why.", detail: null };
}

/** `backendPlan`: init.lua's `backend` and `roster_command` (null before the Config is read). */
export function useConnection(backend: Backend, tabs: Tabs, say: (m: Message) => void, backendPlan: string | null): Connection {
  const [conn, setConn] = useState<Conn>({ state: "connecting" });
  const connect = useCallback(
    async (restart: boolean): Promise<boolean> => {
      setConn({ state: "connecting" });
      // Whichever serve answers next may run on another Inventory (ticket 115): open Sessions count
      // as another's until it says where it runs.
      tabs.serveStarting();
      try {
        const info = await backend.connect(restart ? { restart: true } : undefined);
        const hosts = await backend.listHosts();
        setConn({ state: "ready", info, hosts });
        const leftOut = servicesLeftOut(hosts);
        if (leftOut) say(leftOut);
        return true;
      } catch (e) {
        setConn({ state: "failed", problem: asProblem(e) });
        return false;
      }
    },
    [backend, say, tabs],
  );
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- connecting is the effect
    void connect(false);
  }, [connect]);

  // Which roster runs (ticket 19): the core reads init.lua's `backend` and `roster_command` when it
  // starts serve, so a reload that changes either starts serve again, on the new Backend (WSL to
  // Windows and back). The first Config is the one the start used. Open Sessions keep running
  // where they are; the vault locks, since the new serve has never been unlocked.
  const startedPlan = useRef<string | null>(null);
  useEffect(() => {
    if (backendPlan === null) return;
    const first = startedPlan.current === null || startedPlan.current === backendPlan;
    startedPlan.current = backendPlan;
    if (!first) void connect(true);
  }, [backendPlan, connect]);

  const reloadHosts = useCallback(() => {
    backend.listHosts().then(
      (hosts) => {
        setConn((c) => (c.state === "ready" ? { ...c, hosts } : c));
        const leftOut = servicesLeftOut(hosts);
        if (leftOut) say(leftOut);
      },
      // The Sidebar keeps the list it has; serve's next change (or a :source) asks again.
      () => {},
    );
  }, [backend, say]);

  const info = conn.state === "ready" ? conn.info : null;
  const caps = useMemo(() => capabilities(info?.inventory), [info]);
  return { conn, info, caps, hosts: conn.state === "ready" ? conn.hosts : null, connect, reloadHosts };
}
