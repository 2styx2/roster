// What Sessions work with, kept up to date in Tabs: a password Host whose vault turns out locked
// (session.prepare code 14) brings up the lock screen, and the tab opens by itself once it's
// unlocked again; Plugins hear every Session's output; a new Host's key is asked about; shell hooks
// (ticket 121); and prompt fills (ticket 119), a nested ssh's (ticket 120) read at the shell's C
// mark against the Inventory as it is then.
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Latest } from "../ui/latest";
import type { Capabilities } from "../backend/capabilities";
import type { Host } from "../backend/types";
import type { Config } from "../config/types";
import { PromptWatch } from "./prompt";
import { XtermPromptScreen } from "./promptScreen";
import { shellHooksOn } from "./shellHooks";
import type { OutputTap, Tabs } from "./tabs";

export function useTabsConfig(opts: {
  tabs: Tabs;
  caps: Capabilities;
  config: Config | null;
  hosts: readonly Host[];
  hostByName: ReadonlyMap<string, Host>;
  lockVault(): void;
  outputTap: OutputTap;
}) {
  const { tabs, caps, hostByName, lockVault, outputTap } = opts;
  const asksAboutKeys = caps.has("hostKey");
  const canFill = caps.has("fill");
  const refuseFill = useMemo(() => (caps.has("nestedFill") ? null : (what: string) => caps.needsNewer("nestedFill", what)), [caps]);
  const shellHooksInit = opts.config?.terminal.shellHooks ?? null;
  const [inventoryNow] = useState(() => new Latest<readonly Host[]>([]));
  useLayoutEffect(() => inventoryNow.set(opts.hosts));
  useEffect(() => {
    tabs.configure({
      onVaultLocked: lockVault,
      outputTap,
      asksAboutKeys,
      shellHooks: {
        on: (tab) => shellHooksOn(shellHooksInit, tab.quick ? undefined : hostByName.get(tab.host)?.shell_hooks),
        screen: (size) => new XtermPromptScreen(size),
      },
      fillPrompts: canFill
        ? {
            userOf: (host) => hostByName.get(host)?.ssh.user ?? null,
            watch: (size, user, nonce) => new PromptWatch(size, user, { hosts: inventoryNow.get, refuseFill }, nonce),
          }
        : null,
    });
    return () => tabs.configure({ outputTap: null });
  }, [tabs, outputTap, lockVault, asksAboutKeys, shellHooksInit, hostByName, canFill, refuseFill, inventoryNow]);
}
