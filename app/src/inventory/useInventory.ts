// The Inventory as the workspace changes it (tickets 10, 28): the Pending changes, the pull before
// a write, roster.yml edited outside the app, `:source`'s roster.yml, and each Live Inventory
// change through roster with what it says after.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLatest } from "../app/latest";
import type { Capabilities } from "../backend/capabilities";
import type { Backend, BackendInfo } from "../backend/types";
import type { ChangesState } from "../edit/ChangesPanel";
import { pullGate, syncFailed, type PullGate } from "../edit/pull";
import { realClock, type Clock } from "../lock/idle";
import type { Registries } from "../registries";
import { BUILTIN } from "../registry";
import { countOf, errorText } from "../ui/format";
import { quiet, type Message } from "../ui/messages";
import type { InventoryOp } from "./commands";
import { afterChange, butWarnings, inventoryBroken, inventoryRefusal, routine } from "./said";
import { isPlainFile, keptAs } from "./store";

export interface InventoryState {
  pending: ChangesState | null;
  setPending(f: (p: ChangesState | null) => ChangesState | null): void;
  pendingCount: number;
  /** Asks for the Pending changes again (after every edit, discard and pull). */
  refreshPending(): void;
  /** The Pending changes now, asked again (a switch is blocked by them); the last count if roster can't say. */
  pendingNow(): Promise<number>;
  /** Pulled before an Inventory write (decision Q88): one gate per Backend, shared by the forms and
   * `:pull`, so a pull within `pull_fresh_minutes` isn't repeated and one running is joined. */
  gate: PullGate;
  /** roster.yml is a plain file (T212): every edit is saved straight away, no Pending changes. */
  plain: boolean;
  /** How an edit was kept, said after what it did. */
  kept: string;
  /** roster.yml changed: the Host list, the Pending changes and where passwords can be saved again. */
  changed(): void;
  /** One Live Inventory change through roster, then the Sidebar and the count again, and what
   * happened in a line. A refusal is roster's message, with its fix. */
  run(op: InventoryOp): Promise<void>;
}

export function useInventory(opts: {
  backend: Backend;
  registries: Registries;
  info: BackendInfo | null;
  caps: Capabilities;
  reloadHosts(): void;
  bumpTargets(): void;
  setStale(file: string, on: boolean): void;
  say(m: Message): void;
  autoReload: boolean;
  pullFreshMinutes: number;
  clock: Clock | undefined;
}): InventoryState {
  const { backend, registries, info, caps, reloadHosts, bumpTargets, setStale, say, autoReload } = opts;
  const canEdit = caps.has("edit");
  const canLive = caps.has("live");
  const [pending, setPending] = useState<ChangesState | null>(null);
  const refreshPending = useCallback(() => {
    if (!canEdit) return;
    backend.pendingChanges().then(
      (changes) => setPending({ state: "done", changes }),
      (e: unknown) => setPending({ state: "error", message: errorText(e) }),
    );
  }, [backend, canEdit]);
  useEffect(() => refreshPending(), [refreshPending]);
  const pendingCount = pending?.state === "done" ? pending.changes.count : 0;
  const pendingNow = useCallback(
    // A count roster can't give now: the last one stands in (the switch's question says it).
    async () => (canEdit ? ((await backend.pendingChanges().catch(() => null))?.count ?? pendingCount) : 0),
    [backend, canEdit, pendingCount],
  );

  const pull = useLatest({ windowMs: opts.pullFreshMinutes * 60_000, clock: opts.clock ?? realClock, reloadHosts });
  const gate = useMemo(
    () =>
      pullGate(() => backend.pullInventory(), {
        windowMs: () => pull.get().windowMs,
        now: () => pull.get().clock.now(),
        onUpdated: () => pull.get().reloadHosts(),
      }),
    [backend, pull],
  );

  const changed = useCallback(() => {
    reloadHosts();
    refreshPending();
    bumpTargets();
  }, [reloadHosts, refreshPending, bumpTargets]);

  // roster.yml edited outside the app (ticket 28, decision Q58): serve applies it with
  // auto_reload (the Sidebar follows), else only says so, for `:source`. A file that doesn't load
  // keeps the last good Inventory and says the line.
  const ready = info !== null;
  useEffect(() => {
    if (!ready || !canLive) return;
    const stop = backend.onInventoryChanged((change) => {
      if (!change.applied) return setStale("roster.yml", true);
      setStale("roster.yml", false);
      changed();
      if (change.error) say(inventoryBroken(change.error));
      else if (change.sync && !change.sync.ok) say(`roster.yml changed outside the app and was applied, but ${syncFailed(change.sync)}.`);
    });
    backend.watchInventory(autoReload).catch((e: unknown) => say(quiet(`roster isn't watching roster.yml for outside edits: ${errorText(e)}`)));
    return stop;
  }, [backend, ready, canLive, autoReload, changed, setStale, say]);
  // `:source` reloads roster.yml too.
  useEffect(() => {
    if (!canLive) return;
    return registries.reloaders.register({
      id: "roster.yml",
      source: BUILTIN,
      describe: "roster.yml (the Inventory)",
      files: () => ["roster.yml"],
      owns: (p) => /(^|[\\/])roster\.yml$/.test(p.trim()),
      async reload() {
        const r = await backend.reloadInventory();
        setStale("roster.yml", false);
        changed();
        if (r.error) return inventoryBroken(r.error);
        return r.sync && !r.sync.ok ? `Reloaded roster.yml, but ${syncFailed(r.sync)}.` : null;
      },
    });
  }, [registries, backend, canLive, changed, setStale]);

  const plain = isPlainFile(info?.inventory);
  const kept = keptAs(plain);
  const call = useCallback(
    async (op: InventoryOp): Promise<Message> => {
      switch (op.op) {
        case "remove": {
          const r = await backend.removeHost(op.host);
          return routine(`Removed ${r.removed}`, `Removed ${r.removed} from ${r.group}${kept}. Its vault item, if any, is untouched.`, afterChange(r));
        }
        case "rename": {
          const r = await backend.renameHost(op.host, op.to);
          return r.changed
            ? routine(`Renamed ${op.host} to ${op.to}`, `Renamed ${op.host} to ${op.to}${kept}.`, afterChange(r))
            : `${op.host} already has that name.`;
        }
        case "move": {
          const r = await backend.moveHost(op.host, op.group);
          if (!r.changed) return `${op.host} is already in ${op.group}.`;
          // What it keeps from its old group is worth knowing: said whatever the setting.
          if (r.pinned.length) return `Moved ${op.host} to ${op.group}${kept}. It keeps its ${r.pinned.join(", ")}, now written on the Host.` + butWarnings(afterChange(r));
          return routine(`Moved ${op.host} to ${op.group}`, `Moved ${op.host} to ${op.group}${kept}.`, afterChange(r));
        }
        case "group-new": {
          const r = await backend.newGroup(op.name);
          return routine(`Added group ${op.name}`, `Added group ${op.name}${kept}. Drag Hosts onto it, or + adds one.`, afterChange(r));
        }
        case "group-rename": {
          const r = await backend.renameGroup(op.group, op.to);
          return r.changed
            ? routine(`Renamed group ${op.group} to ${op.to}`, `Renamed group ${op.group} to ${op.to}${kept}.`, afterChange(r))
            : `${op.group} already has that name.`;
        }
        case "group-delete": {
          const r = await backend.deleteGroup(op.group, op.to);
          return r.moved.length
            ? `Deleted group ${op.group}; ${countOf(r.moved.length, "Host")} moved to ${r.to ?? "?"}${plain ? kept : `,${kept}`}.` + butWarnings(afterChange(r))
            : routine(`Deleted group ${op.group}`, `Deleted group ${op.group}${kept}.`, afterChange(r));
        }
      }
    },
    [backend, kept, plain],
  );
  const run = useCallback(
    async (op: InventoryOp) => {
      try {
        say(await call(op));
      } catch (e) {
        say(inventoryRefusal(e));
      }
      reloadHosts();
      refreshPending();
    },
    [call, say, reloadHosts, refreshPending],
  );
  return { pending, setPending, pendingCount, refreshPending, pendingNow, gate, plain, kept, changed, run };
}
