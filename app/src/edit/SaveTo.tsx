// "Save to" (ticket 35, API 10): where the vault can save a new Vault item (`vault.targets`),
// starting on the default (init.lua's `vault.save_to`, else roster.yml's) and saying where that's
// set. Radios: Tab reaches the choice, arrows move it. It lists again when `version` changes (a
// `:source`), keeping a choice that's still there. Shared by the add form (ticket 11) and "Save to
// vault" after a Session's own login (tickets 15, 16).
import { useEffect, useState } from "react";
import type { Backend, SaveTarget, SaveTargets } from "../backend/types";
import { errorText } from "../ui/format";

type Targets = { at: "loading" } | { at: "done"; found: SaveTargets } | { at: "failed"; message: string };

export interface SaveToChoice {
  /** The list, once roster answered (null while loading, on failure, or when not choosing). */
  found: SaveTargets | null;
  /** The place to send (`save_to`): the one picked, else the default; null when neither is there. */
  target: SaveTarget | null;
  /** The radios to render. */
  field: { targets: Targets; chosen: string | null; choose(id: string): void };
}

/** Lists the places once `enabled`, and again when `version` changes. */
export function useSaveTo(backend: Backend, enabled: boolean, version: number): SaveToChoice {
  const [targets, setTargets] = useState<Targets>({ at: "loading" });
  /** The target picked here; null: the default. */
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    backend.saveTargets().then(
      (found) => current && setTargets({ at: "done", found }),
      (e: unknown) => current && setTargets({ at: "failed", message: errorText(e) }),
    );
    return () => {
      current = false;
    };
  }, [backend, enabled, version]);
  const found = enabled && targets.at === "done" ? targets.found : null;
  const target = found
    ? (found.targets.find((t) => t.id === chosen) ?? found.targets.find((t) => t.id === found.default) ?? null)
    : null;
  return { found, target, field: { targets, chosen: target?.id ?? null, choose: setChosen } };
}

export function SaveToField({
  id,
  choice,
  pickMissing,
  onChoose,
}: {
  /** The field's id (its radios are named `${id}-saveto`). */
  id: string;
  choice: SaveToChoice;
  /** The user tried to save while the default names a place that isn't there. */
  pickMissing: boolean;
  onChoose?(): void;
}) {
  const { targets, chosen, choose } = choice.field;
  const found = choice.found;
  return (
    <div className="add-save-to">
      <span id={id} className="add-save-to-label">
        Save to
      </span>
      {targets.at === "loading" && <span className="edit-hint">Reading where the vault can save…</span>}
      {targets.at === "failed" && (
        <span className="edit-hint">roster saves it where its settings say (it couldn't list the other places: {targets.message})</span>
      )}
      {found && (
        <div
          className="add-targets"
          role="radiogroup"
          aria-labelledby={id}
          aria-describedby={found.problem ? `${id}-problem` : undefined}
        >
          {found.targets.map((t) => (
            <label key={t.id} className="add-way">
              <input
                type="radio"
                name={`${id}-saveto`}
                value={t.id}
                checked={chosen === t.id}
                onChange={() => {
                  choose(t.id);
                  onChoose?.();
                }}
              />
              {t.label}
              {t.id === found.default && <span className="add-target-from"> · default{found.from ? `, from ${found.from}` : ""}</span>}
            </label>
          ))}
        </div>
      )}
      {found?.problem && (
        <span id={`${id}-problem`} className={pickMissing && !choice.target ? "edit-field-problem" : "edit-hint"}>
          {pickMissing && !choice.target ? "Pick where to save it. " : ""}
          {found.problem.message}
        </span>
      )}
    </div>
  );
}
