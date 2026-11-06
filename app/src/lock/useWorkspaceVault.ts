// The workspace's vault: init.lua's vault settings reach roster (`vault.configure`, API 10;
// tickets 35 and 41) before the lock screen asks where the vault stands (a KeePassXC database may
// be init.lua's), and again on every `:source`; then the Lock, and what locking empties.
import { useEffect, useReducer, useState } from "react";
import type { Capabilities } from "../backend/capabilities";
import type { Backend, BackendInfo, VaultAccount, VaultSettings } from "../backend/types";
import { vaultSettingsOf } from "../config/vault";
import type { Config } from "../config/types";
import { usePanelState, type PanelState } from "../panel/stack";
import type { Tabs } from "../session/tabs";
import { errorText } from "../ui/format";
import type { Message } from "../ui/messages";
import type { FocusReturn } from "../ui/useFocusReturn";
import type { Clock } from "../ui/clock";
import { TypedPasswords } from "./forgetOnLock";
import { noAccountWords } from "./LockScreen";
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
  /** `:lock`. */
  lock(): void;
  /** `:vault signout` (ticket 42): asks first, naming the account roster's CLI is signed in as now. */
  askSignOut(): void;
  /** Its question, while it's up. */
  signingOut: PanelState<VaultAccount>;
}

export function useWorkspaceVault(
  backend: Backend,
  tabs: Tabs,
  info: BackendInfo | null,
  caps: Capabilities,
  config: Config | null,
  { idleMs, clock, say, focus }: { idleMs: number; clock: Clock | undefined; say(m: Message): void; focus: FocusReturn },
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
  const signingOut = usePanelState<VaultAccount>(focus, "sign-out");
  const lock = () => {
    if (!vault.lock()) say("Nothing to lock: no Host Login uses a vault with a master password.");
  };
  const askSignOut = () => {
    if (!caps.has("signOut")) return say(caps.needsNewer("signOut"));
    // Ask roster who the CLI is signed in as now: a sign-in from the lock screen doesn't say.
    backend.vaultStatus().then(
      (s) => {
        if (!s.provider) return say("Nothing to sign out of: no Host Login uses a vault with an account.");
        if (!s.can_sign_out) return say(noAccountWords(s.provider));
        if (!s.account) return say("The vault CLI isn't signed in on this Box, so there's no account to sign out of.");
        signingOut.open(s.account);
      },
      (e: unknown) => say(`Couldn't ask the vault who's signed in: ${errorText(e)}`),
    );
  };
  return { vault, configures, targetsVersion, bumpTargets, typed, lock, askSignOut, signingOut };
}
