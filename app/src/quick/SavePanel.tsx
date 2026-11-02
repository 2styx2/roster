// "Save to vault" after a Session's own login (decisions Q43, Q68). For a Quick Connect (ticket 15) a
// side panel asks for the Host's name (pre-filled from what the box's shell calls itself), its group
// and where in the vault, then runs roster's `quick.save`: the Vault item `<name> ssh`, then the Host
// as a Pending change, with the host key confirmed for the Session recorded for it. For an `auth:
// prompt` Host (ticket 16) only where in the vault: `host.save_login` makes `<host> ssh` and points
// the Host's Login at it. The password isn't here: roster holds it from the connect card and saves
// it only because that Session logged in with it.
//
// Like the add form, it opens at once and pulls the infra repo in the background when the last pull
// is stale (decision Q88; not over Pending changes); saving waits for that pull. It
// opens from a click or `:save`, keyboard first: Name has focus, Enter saves, Esc closes (the offer
// stays). No motion of its own, like the other side panels.
import { useEffect, useId, useRef, useState } from "react";
import { type Backend, type HostList, type QuickSave, type SaveLogin } from "../backend/types";
import { problemFromCallError, type ErrorRow } from "../errors/catalog";
import type { Problem } from "../errors/classify";
import { ProblemBody, type ProblemActions } from "../errors/ErrorPanel";
import { SaveToField, useSaveTo } from "../edit/SaveTo";
import { useFormPull, type PullGate } from "../edit/pull";
import { PullStatus } from "../edit/PullStatus";
import { CloseGlyph } from "../ui/CloseGlyph";
import { PanelButton } from "../panel/PanelFrame";
import { Keys } from "../ui/Keys";
import { suggestedName } from "./hostname";
import { formatQuickTarget, type QuickTarget } from "./target";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type Phase =
  | { at: "ready" }
  | { at: "waiting" }
  | { at: "saving" }
  | { at: "failed"; problem: Problem };

export interface SavePanelProps {
  backend: Backend;
  hosts: HostList;
  /** What's saved: a Quick Connect (serve's id for it, where it went, what its shell calls the
   * box), or an `auth: prompt` Host's Session (serve's held id, the Host's name). */
  what: { quick: { id: string; to: QuickTarget; hostname: string | null } } | { host: { held: string; name: string } };
  /** The group the form starts in. */
  group: string;
  pendingCount: number;
  rows: readonly ErrorRow[];
  actions: ProblemActions;
  /** roster can say where it saves (`vault.targets`): show "Save to". */
  chooseTarget?: boolean;
  targetsVersion?: number;
  onSaved(result: QuickSave | SaveLogin): void;
  /** The pull before a write (decision Q88), shared with the other forms and `:pull`. */
  pull: PullGate;
  onClose(): void;
}

export function SavePanel({
  backend,
  hosts,
  what,
  group: startGroup,
  pendingCount,
  rows,
  actions,
  chooseTarget = false,
  targetsVersion = 0,
  onSaved,
  pull,
  onClose,
}: SavePanelProps) {
  const ids = useId();
  const [phase, setPhase] = useState<Phase>({ at: "ready" });
  // The name follows what the box's shell says until the user types one.
  const [typedName, setTypedName] = useState<string | null>(null);
  const quick = "quick" in what ? what.quick : null;
  const fixed = "host" in what ? what.host : null;
  const name = fixed?.name ?? typedName ?? (quick ? suggestedName(quick.hostname, quick.to.address) : "");
  const [group, setGroup] = useState(startGroup);
  const [tried, setTried] = useState(false);
  const [pickMissing, setPickMissing] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const label = quick ? formatQuickTarget(quick.to) : (fixed?.name ?? "");
  /** A pull brought new commits while the form was open (decision Q88). */
  const [pulledIn, setPulledIn] = useState(false);
  const formPull = useFormPull(pull, pendingCount > 0, label, (outcome) => {
    if (!outcome.fresh && outcome.result.updated) setPulledIn(true);
  });
  useEffect(() => {
    (document.getElementById(`${ids}-name`) ?? document.getElementById(`${ids}-save`))?.focus();
  }, [ids]);

  const saveTo = useSaveTo(backend, chooseTarget, targetsVersion);
  const busy = phase.at === "waiting" || phase.at === "saving";
  const trimmed = name.trim();
  const taken = quick ? hosts.hosts.find((h) => h.name === trimmed) : undefined;
  const nameProblem = !trimmed
    ? "Name the Host"
    : !NAME.test(trimmed)
      ? "Use letters, digits, . _ - (starting with a letter or digit)"
      : taken
        ? `${trimmed} is already a Host (group ${taken.group})`
        : null;
  const groupProblem = !quick ? null : !group.trim() ? "Pick a group" : !NAME.test(group.trim()) ? "Use letters, digits, . _ -" : null;
  const item = `${trimmed || "<name>"} ssh`;

  const save = async () => {
    if (busy) return;
    setTried(true);
    if (nameProblem || groupProblem) {
      document.getElementById(`${ids}-${nameProblem ? "name" : "group"}`)?.focus();
      return;
    }
    if (saveTo.found && !saveTo.target) {
      setPickMissing(true);
      return;
    }
    // The pull first (decision Q88). A failed one says why above, and nothing is saved.
    setPhase({ at: "waiting" });
    if ((await formPull.ready()) === null) return live.current && setPhase({ at: "ready" });
    if (!live.current) return;
    setPhase({ at: "saving" });
    try {
      const where = saveTo.target ? { save_to: saveTo.target.save_to } : {};
      const result = quick
        ? await backend.saveQuick({
            quick: quick.id,
            name: trimmed,
            group: group.trim(),
            item: `${trimmed} ssh`,
            ...where,
          })
        : await backend.saveLogin({
            held: fixed?.held ?? "",
            item: `${trimmed} ssh`,
            ...where,
          });
      if (live.current) onSaved(result);
    } catch (e) {
      if (!live.current) return;
      setPhase({ at: "failed", problem: problemFromCallError(trimmed, e) });
    }
  };

  return (
    <section
      className="side-panel edit-panel add-panel save-panel"
      role="region"
      aria-label="Save to vault"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        <h2>Save to vault</h2>
        <span className="panel-head-buttons">
          <PanelButton />
          <button type="button" className="icon-button close" aria-label="Close the save form" onClick={onClose}>
            <CloseGlyph />
          </button>
        </span>
      </header>
      <p className="edit-note">
        <span className="mono">{label}</span> logged in with the password you typed. roster saves it as a Vault item, then{" "}
        {quick ? "adds the Host" : "points the Host's Login at it"}, as a Pending change.
      </p>
      <PullStatus pull={formPull} rows={rows} actions={actions} />
      {pulledIn && taken && (
        <p className="edit-note" role="status">
          The pull brought a Host named <span className="mono">{trimmed}</span>, so this one needs another name.
        </p>
      )}
      <form
        className="edit-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="edit-fields">
          {!quick && (
            <p className="edit-hint">
              Vault item <span className="mono">{item}</span>
            </p>
          )}
          {quick && (
            <div className="edit-field">
              <label htmlFor={`${ids}-name`}>Host name</label>
              <input
                id={`${ids}-name`}
                className="mono"
                value={name}
                placeholder="e.g. nas-01"
                spellCheck={false}
                autoComplete="off"
                disabled={busy}
                aria-invalid={tried && nameProblem ? true : undefined}
                aria-describedby={`${ids}-name-hint`}
                onChange={(e) => {
                  setTypedName(e.target.value);
                  if (phase.at === "failed") setPhase({ at: "ready" });
                }}
              />
              <span id={`${ids}-name-hint`} className={tried && nameProblem ? "edit-field-problem" : "edit-hint"}>
                {tried && nameProblem ? (
                  nameProblem
                ) : (
                  <>
                    Vault item <span className="mono">{item}</span>
                  </>
                )}
              </span>
            </div>
          )}
          {quick && (
            <div className="edit-field">
              <label htmlFor={`${ids}-group`}>Group</label>
              <input
                id={`${ids}-group`}
                className="mono"
                value={group}
                list={`${ids}-groups`}
                spellCheck={false}
                autoComplete="off"
                disabled={busy}
                aria-invalid={tried && groupProblem ? true : undefined}
                aria-describedby={tried && groupProblem ? `${ids}-group-problem` : undefined}
                onChange={(e) => {
                  setGroup(e.target.value);
                  if (phase.at === "failed") setPhase({ at: "ready" });
                }}
              />
              {tried && groupProblem && (
                <span id={`${ids}-group-problem`} className="edit-field-problem">
                  {groupProblem}
                </span>
              )}
              <datalist id={`${ids}-groups`}>
                {Object.keys(hosts.groups).map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </div>
          )}
          {chooseTarget && (
            <SaveToField id={`${ids}-saveto`} choice={saveTo} pickMissing={pickMissing} onChoose={() => setPickMissing(false)} />
          )}
        </div>
        {phase.at === "waiting" && <p className="muted edit-status">Waiting for the pull to finish…</p>}
        {phase.at === "saving" && <p className="muted edit-status">Saving {item} to the vault…</p>}
        {phase.at === "failed" && (
          <div className="edit-problem" role="alert">
            <ProblemBody problem={phase.problem} rows={rows} actions={actions} notInTab />
          </div>
        )}
        <div className="edit-actions">
          <button type="submit" className="primary" id={`${ids}-save`} disabled={busy}>
            Save
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <span className="edit-keys muted key-hint">
            <Keys keys="Enter" /> save <Keys keys="Escape" /> close
          </span>
        </div>
      </form>
    </section>
  );
}
