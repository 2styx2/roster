// What happens once in the workspace's life, and where the keys go as it changes: the State read
// at start (and what's new after an upgrade), the window's place, a fixture's Sessions, the tutor's
// page on the demo, every Session ended at the end; focus after unlocking, after the last Session,
// back from the demo, and around a Plugin's question or float.
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { inLayer } from "../panel/stack";
import { NEWS_KEY, newsNote } from "../news/news";
import type { Platform } from "../platform/types";
import type { Registries } from "../registries";
import type { Tabs } from "../session/tabs";
import type { StateStore } from "../state/store";
import type { TutorialDef } from "../tutor/tutor";
import type { Message } from "../ui/messages";
import type { FocusReturn } from "../ui/useFocusReturn";
import { Latest } from "./latest";

export function useWorkspaceLife(o: {
  store: StateStore;
  platform: Platform;
  registries: Registries;
  tabs: Tabs;
  appVersion: string;
  /** serve is up and the vault unlocked. */
  unlocked: boolean;
  suspended: boolean;
  noSessions: boolean;
  openAtStart: readonly string[] | undefined;
  demoTutorial: TutorialDef | null;
  openTutorial(def: TutorialDef): void;
  focus: FocusReturn;
  /** Plugins' question and float now (null: none up). */
  pluginConfirm: string | number | null;
  pluginFloat: string | null;
  say(m: Message): void;
}): { setPromptButton(el: HTMLButtonElement | null): void } {
  const { store, platform, registries, tabs, appVersion, unlocked, suspended, focus, say } = o;
  // The State file, once: what changed before it was read (Hosts picked) is replayed over it; and
  // what's new (ticket 47), said once after an upgrade when the workspace first shows.
  const [newsLine, setNewsLine] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void store.load().then(() => {
      const { note, seen } = newsNote(store.snapshot(), appVersion);
      if (store.get(NEWS_KEY) !== seen) store.set(NEWS_KEY, seen);
      if (note && live) setNewsLine(note);
    });
    return () => {
      live = false;
    };
  }, [store, appVersion]);
  useEffect(() => {
    if (!unlocked || !newsLine) return;
    say(newsLine);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- saying it once the workspace shows is the effect
    setNewsLine(null);
  }, [unlocked, newsLine, say]);
  // The window's size and place go in the State; the Tauri shell restores them at the next start.
  useEffect(() => platform.window?.watchGeometry((g) => store.set("window", g)), [platform, store]);
  // A fixture's Sessions open once the app is first unlocked, as if the user had opened them.
  const [opened] = useState(() => new Latest(false));
  const { openAtStart } = o;
  useEffect(() => {
    if (!unlocked || opened.get() || !openAtStart) return;
    opened.set(true);
    for (const host of openAtStart) tabs.open(host);
  }, [unlocked, openAtStart, tabs, opened]);
  // On the demo Inventory: the tutorial running is the demo's too (a Plugin's isn't registered in
  // the demo's registries), and once the demo is up its page opens where you left off.
  const { demoTutorial } = o;
  useEffect(() => {
    if (demoTutorial && registries.tutorials.get(demoTutorial.id) !== demoTutorial) return registries.tutorials.register(demoTutorial);
  }, [registries, demoTutorial]);
  const [openTutorial] = useState(() => new Latest(o.openTutorial));
  useLayoutEffect(() => openTutorial.set(o.openTutorial));
  useEffect(() => {
    if (unlocked && demoTutorial) openTutorial.get()(demoTutorial);
  }, [unlocked, demoTutorial, openTutorial]);
  // Closing the app ends every Session.
  useEffect(() => () => tabs.closeAll(), [tabs]);

  // A Plugin's prompt that came up behind the lock screen (a Package init.lua names, at start)
  // keeps the keys, on its safe choice, so Esc answers it and a stray Enter installs nothing
  // (ticket 56, decision Q87); this workspace's own prompt: the demo's never reaches for yours.
  const [prompt] = useState(() => new Latest<HTMLButtonElement | null>(null));
  const keysHome = useCallback(() => focus.toMain(prompt.get()), [prompt, focus]);
  useEffect(() => {
    if (unlocked) keysHome();
  }, [unlocked, keysHome]);
  // With the last Session closed, the keys need somewhere to go.
  const { noSessions } = o;
  useEffect(() => {
    if (noSessions && (document.activeElement === document.body || document.activeElement === null)) focus.toMain();
  }, [noSessions, focus]);
  // Back from the demo Inventory: the keys come back here.
  const [wasSuspended] = useState(() => new Latest(suspended));
  useEffect(() => {
    if (wasSuspended.get() && !suspended) keysHome();
    wasSuspended.set(suspended);
  }, [suspended, wasSuspended, keysHome]);
  // A Plugin's question (ticket 78) or float (ticket 91) takes the keys; answering or closing puts
  // them back where they were. Before the panel's own effect focuses its button (layout effects
  // run first), and only when a new one comes up.
  const { pluginConfirm, pluginFloat } = o;
  useLayoutEffect(() => {
    if (pluginConfirm !== null && !inLayer("plugin-confirm")) focus.remember();
  }, [pluginConfirm, focus]);
  useLayoutEffect(() => {
    if (pluginFloat !== null && !inLayer("plugin-float")) focus.remember();
  }, [pluginFloat, focus]);
  return { setPromptButton: (el) => prompt.set(el) };
}
