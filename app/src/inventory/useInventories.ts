// Named Inventories (ticket 115, API 27): asked of each serve once it's up, so the status bar names
// the one it runs on and Sessions are marked with theirs; and `:inventory NAME`, which asks first,
// then switches roster over to it.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Capabilities } from "../backend/capabilities";
import type { Backend, BackendInfo, Inventories } from "../backend/types";
import { usePanelState, type Layer, type PanelState } from "../panel/stack";
import { isLive } from "../session/status";
import type { Tabs, TabsSnapshot } from "../session/tabs";
import { errorText } from "../ui/format";
import type { Message } from "../ui/messages";
import type { FocusReturn } from "../ui/useFocusReturn";
import { afterSwitch, NONE_NAMED, switchPlan, type SwitchPlan } from "./switch";

type Confirm = Extract<SwitchPlan, { kind: "confirm" }>;

export interface InventoriesState {
  /** The named Inventories as this serve last listed them; null until it has, or before API 27. */
  inventories: Inventories | null;
  /** `:inventory NAME`'s question while it's up. */
  question: PanelState<Confirm>;
  /** The question's place in the stack: held while a confirmed switch runs. */
  layer: Layer;
  /** A confirmed switch is running (its step can't be closed). */
  switching(): boolean;
  /** `:inventory NAME`: asks before switching, or says why it can't; null starts the command line. */
  ask(name: string | null): void;
  /** The question's yes: asked again (Pending changes made meanwhile still block it), then the switch. */
  confirm(): Promise<void>;
  /** What the error screen says when serve didn't start again after a switch. */
  startNote: string | null;
}

export function useInventories(opts: {
  backend: Backend;
  info: BackendInfo | null;
  caps: Capabilities;
  tabs: Tabs;
  sessions: TabsSnapshot;
  say(m: Message): void;
  focus: FocusReturn;
  connect(restart: boolean): Promise<boolean>;
  lockNow(): Promise<string | null>;
  pendingNow(): Promise<number>;
  openCommandLine(text: string): void;
}): InventoriesState {
  const { backend, info, caps, tabs, say } = opts;
  const lists = caps.has("inventories");
  // Kept with the serve it came from: one serve's answer never stands for the next one's.
  const [listed, setListed] = useState<{ info: BackendInfo; list: Inventories } | null>(null);
  const inventories = listed && info && listed.info === info ? listed.list : null;
  const keep = useCallback((at: BackendInfo, list: Inventories | null) => setListed(list && { info: at, list }), []);
  useEffect(() => {
    if (!info || !lists) return;
    let live = true;
    backend.listInventories().then(
      (list) => live && keep(info, list),
      () => live && keep(info, null),
    );
    return () => {
      live = false;
    };
  }, [backend, info, lists, keep]);
  useEffect(() => {
    if (!info) return;
    // Before API 27 there are no named Inventories: the file inventory.info names is where it runs.
    // A list that fails never says, so Sessions opened before this serve stay another's.
    if (!lists) tabs.setInventory({ name: null, path: info.inventory.path });
    else if (inventories) tabs.setInventory({ name: inventories.name, path: inventories.path });
  }, [tabs, info, lists, inventories]);
  // Said when it changes, so a screen reader hears it too (the message line is a status region).
  const last = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!inventories) return;
    const was = last.current;
    last.current = inventories.name;
    if (was === undefined || was === inventories.name) return;
    say(
      inventories.name !== null
        ? afterSwitch(inventories, inventories.name)
        : `roster runs on ${inventories.path ?? "no roster.yml"} now, which isn't a named Inventory`,
    );
  }, [inventories, say]);

  const question = usePanelState<Confirm>(opts.focus, "switch");
  /** The Inventory a confirmed switch is going to, while it runs: a second `:inventory` waits. */
  const goingTo = useRef<string | null>(null);
  const [startNote, setStartNote] = useState<string | null>(null);
  const openSessions = () => opts.sessions.tabs.filter((t) => isLive(t.status)).length;

  const ask = (name: string | null) => {
    if (goingTo.current !== null) return say(`A switch to ${goingTo.current} is already running`);
    if (!lists) return say(caps.needsNewer("inventories"));
    backend.listInventories().then(
      async (list) => {
        if (info) keep(info, list);
        if (name === null) return list.inventories.length === 0 ? say(NONE_NAMED) : opts.openCommandLine("inventory ");
        const plan = switchPlan(list, name, { sessions: openSessions(), pending: await opts.pendingNow() });
        if (plan.kind === "say") return say(plan.message);
        question.open(plan);
      },
      (e: unknown) => say(`Couldn't list the named Inventories: ${errorText(e)}`),
    );
  };

  /** Only one Inventory's vault is ever unlocked: this one locks (covering the Sessions) before
   * serve is asked to switch, and the new serve starts locked. One that doesn't lock stops it. Then
   * what roster runs on now, said plainly whatever happened. */
  const switchTo = async (to: string) => {
    const lockFailed = await opts.lockNow();
    if (lockFailed !== null) {
      question.close();
      return say(`Couldn't lock the vault (${lockFailed}): nothing switched`);
    }
    try {
      await backend.useInventory(to);
    } catch (e) {
      question.close();
      return say(`Couldn't switch to ${to}: ${errorText(e)}`);
    }
    question.close();
    say(`Restarting roster on ${to}…`);
    setStartNote(null);
    // serve starts again as for a new backend: its start asks roster which file to use.
    if (!(await opts.connect(true))) {
      return setStartNote(`${to} is the active Inventory now, but roster didn't start again on it: fix what's above, then Retry.`);
    }
    const now = await backend.listInventories().catch((e: unknown) => errorText(e));
    if (typeof now === "string") {
      return say(`${to} is the active Inventory now, but roster couldn't say which Inventory it started on (${now}): its Sessions from before stay marked`);
    }
    if (now.name !== to) say(afterSwitch(now, to));
  };

  const confirm = async () => {
    const plan = question.value;
    if (!plan) return;
    const to = plan.to;
    // A list roster can't give now: the last one decides.
    const list = await backend.listInventories().catch(() => inventories);
    const again = list ? switchPlan(list, to, { sessions: openSessions(), pending: await opts.pendingNow() }) : null;
    if (!again) {
      question.close();
      return say("Couldn't list the named Inventories: nothing switched");
    }
    if (again.kind === "say") {
      question.close();
      return say(again.message);
    }
    if (again.action === null) return question.set(again);
    goingTo.current = to;
    try {
      await switchTo(to);
    } finally {
      goingTo.current = null;
    }
  };

  const switching = () => goingTo.current !== null;
  return { inventories, question, layer: { ...question.layer, held: switching }, switching, ask, confirm, startNote };
}
