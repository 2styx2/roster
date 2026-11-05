// The workspace's vault: init.lua's vault settings reach roster (`vault.configure`, API 10;
// tickets 35 and 41) before the lock screen asks where the vault stands (a KeePassXC database may
// be init.lua's), and again on every `:source`; then the Lock, and what locking empties.
import { useEffect, useReducer, useState } from "react";
import type { Capabilities } from "../backend/capabilities";
import type { Backend, BackendInfo, VaultSettings } from "../backend/types";
import { vaultSettingsOf } from "../config/vault";
import type { Config } from "../config/types";
import type { Tabs } from "../session/tabs";
import { errorText } from "../ui/format";
import type { Message } from "../ui/messages";
import type { Clock } from "./idle";
import { TypedPasswords } from "./forgetOnLock";
import { useVault, type Vault } from "./useVault";

export interface WorkspaceVault {
  vault: Vault;
  /** roster takes init.lua's vault settings: the forms offer where "Save to vault" goes. */
  configures: boolean;
  /** Goes up when where "Save to vault" can go may have changed (ticket 35): the forms list again. */
  targetsVersion: number;
  bumpTargets(): void;
  /** The workspace's typed passwords, emptied when it locks. */
  typed: TypedPasswords;
}

export function useWorkspaceVault(
  backend: Backend,
  tabs: Tabs,
  info: BackendInfo | null,
  caps: Capabilities,
  config: Config | null,
  { idleMs, clock, say }: { idleMs: number; clock: Clock | undefined; say(m: Message): void },
): WorkspaceVault {
  const configures = caps.has("vaultConfig");
  const settingsKey = JSON.stringify(vaultSettingsOf(config?.vault));
  const [configuredFor, setConfiguredFor] = useState<BackendInfo | null>(null);
  const [targetsVersion, bumpTargets] = useReducer((n: number) => n + 1, 0);
  const active = info !== null && (!configures || configuredFor === info);
  const vault = useVault(backend, active, { idleMs, clock });
  const checkVault = vault.check;
  useEffect(() => {
    if (!info || !configures) return;
    let live = true;
    backend.configureVault(JSON.parse(settingsKey) as VaultSettings).then(
      (r) => {
        if (!live) return;
        setConfiguredFor(info);
        bumpTargets();
        // A KeePassXC database that changed forgot the master password: the lock screen again.
        if (r.locked.length) void checkVault();
        // A setting roster can't use is left out on its own; the rest apply.
        const refused = (r.refused ?? []).map((x) => `roster left out init.lua's vault.${x.setting}: ${x.message}`);
        if (refused.length) say(refused.join(" "));
      },
      (e: unknown) => {
        if (!live) return;
        setConfiguredFor(info);
        say(`roster didn't take init.lua's vault settings: ${errorText(e)}`);
      },
    );
    return () => {
      live = false;
    };
  }, [backend, info, configures, settingsKey, checkVault, say]);

  const [typed] = useState(() => new TypedPasswords());
  useEffect(() => {
    if (vault.locked) typed.forget();
  }, [vault.locked, typed]);
  const unlocked = vault.view.state === "unlocked";
  useEffect(() => {
    if (unlocked) tabs.resumeAfterUnlock();
  }, [unlocked, tabs]);
  return { vault, configures, targetsVersion, bumpTargets, typed };
}
