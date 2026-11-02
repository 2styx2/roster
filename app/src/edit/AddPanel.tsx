// `:host add` (ticket 11): a side panel to add a Host. Like `:edit`, it opens at once and pulls the
// infra repo in the background when the last pull is stale (decision Q88; not over Pending
// changes); adding waits for that pull, and a failed one blocks it. A Host with a Login is a
// verified add (decision Q43):
// roster scans the address's host key and the user confirms it, then `host.add` runs one test login,
// saves a typed password to the vault as `<host> ssh`, and adds the Host as a Pending change.
// Nothing is written when the test login fails. Without a Login the Host goes in unreviewed.
//
// The typed password lives only in its input (uncontrolled, like the lock screen's), goes to roster
// once in the `host.add` call, and the input is emptied when the call returns, pass or fail.
//
// "Save to" (ticket 35, API 10) lists where roster says the vault can save a typed password
// (`vault.targets`), starting on the default (init.lua's `vault.save_to`, else roster.yml's) and
// saying where that's set. Radios, like "How it logs in": Tab reaches the choice, arrows move it,
// Enter adds. It lists again when `targetsVersion` changes (a `:source`), keeping a choice that's
// still there.
//
// Keyboard first: Name has focus, Tab moves, Enter adds, Esc closes. It opens from a key, so it
// doesn't animate (emil-design-eng: never animate keyboard-initiated actions).
import { useEffect, useId, useRef, useState } from "react";
import { addHostChecked } from "../backend/afterTimeout";
import {
  BackendCallError,
  type Backend,
  type CheckStep,
  type HostAdd,
  type HostList,
  type ScannedKey,
} from "../backend/types";
import { problemFromCallError, type ErrorRow } from "../errors/catalog";
import type { Problem } from "../errors/classify";
import { CheckSteps } from "../errors/CheckPanel";
import { ProblemBody, type ProblemActions } from "../errors/ErrorPanel";
import { CloseGlyph } from "../ui/CloseGlyph";
import { PanelButton } from "../panel/PanelFrame";
import { Keys } from "../ui/Keys";
import { useFormPull, type PullGate } from "./pull";
import { PullStatus } from "./PullStatus";
import { SaveToField, useSaveTo } from "./SaveTo";
import {
  addParams,
  addProblem,
  defaultItem,
  defaultRef,
  emptyDraft,
  isNewGroup,
  itemSuggestions,
  problemsOf,
  type AddDraft,
  type AddField,
  type LoginWay,
} from "./addForm";

type Phase =
  | { at: "ready" }
  | { at: "waiting" }
  | { at: "scanning" }
  | { at: "confirm-key"; key: ScannedKey }
  | { at: "key-refused"; key: ScannedKey }
  | { at: "adding" }
  | { at: "verify-failed"; problem: Problem; steps: CheckStep[] }
  | { at: "failed"; problem: Problem };

export interface AddPanelProps {
  backend: Backend;
  hosts: HostList;
  /** The group the form starts in (the selected Host's, else the first). */
  group: string;
  /** Pending changes already on this Box: the repo was pulled before the first one. */
  pendingCount: number;
  rows: readonly ErrorRow[];
  actions: ProblemActions;
  onAdded(result: HostAdd): void;
  /** The pull before a write (decision Q88), shared with the other forms and `:pull`. */
  pull: PullGate;
  onClose(): void;
  /** roster can say where it saves (`vault.targets`, API 10): show "Save to". */
  chooseTarget?: boolean;
  /** Changes when the vault settings may have (a `:source` of init.lua or roster.yml): list again. */
  targetsVersion?: number;
}

const LOGIN_WAYS: { way: LoginWay; label: string }[] = [
  { way: "password", label: "Type its password" },
  { way: "item", label: "An existing vault item" },
  { way: "none", label: "No Login yet" },
];

interface FieldDef {
  name: Exclude<AddField, "item">;
  label: string;
  mono: boolean;
  placeholder?: string;
}

const FIELDS: readonly FieldDef[] = [
  { name: "name", label: "Name", mono: true, placeholder: "e.g. esx-02" },
  { name: "address", label: "Address", mono: true, placeholder: "e.g. 10.19.77.5" },
  { name: "port", label: "Port", mono: true },
  { name: "user", label: "User", mono: true, placeholder: "e.g. root" },
  { name: "group", label: "Group", mono: true },
  { name: "type", label: "Type", mono: true, placeholder: "esxi, switch, linux…" },
  { name: "title", label: "Title", mono: false },
];

export function AddPanel({
  backend,
  hosts,
  group,
  pendingCount,
  rows,
  actions,
  onAdded,
  pull,
  onClose,
  chooseTarget = false,
  targetsVersion = 0,
}: AddPanelProps) {
  const [draft, setDraft] = useState<AddDraft>(() => emptyDraft(group));
  const [phase, setPhase] = useState<Phase>({ at: "ready" });
  /** Problems show once a field was left, or after a try to add. */
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  /** roster's own word on a field (80 with data.field, 81 for the name). */
  const [rosterSays, setRosterSays] = useState<{ field: string; message: string } | null>(null);
  // Uncontrolled on purpose: the password lives only in the input, never in React state.
  const password = useRef<HTMLInputElement>(null);
  const [hasPassword, setHasPassword] = useState(false);
  const trustRef = useRef<HTMLButtonElement>(null);
  const live = useRef(true);
  const ids = useId();
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  /** A pull brought new commits while the form was open (decision Q88). */
  const [pulledIn, setPulledIn] = useState(false);
  const formPull = useFormPull(pull, pendingCount > 0, "the infra repo", (outcome) => {
    if (!outcome.fresh && outcome.result.updated) setPulledIn(true);
  });
  useEffect(() => {
    document.getElementById(`${ids}-name`)?.focus();
  }, [ids]);
  const confirming = phase.at === "confirm-key";
  useEffect(() => {
    if (confirming) trustRef.current?.focus();
  }, [confirming]);

  const fieldId = (f: string) => `${ids}-${f}`;
  const busy = phase.at === "waiting" || phase.at === "scanning" || phase.at === "adding";
  const login = draft.login;

  // ---- Save to (ticket 35)
  const choosing = chooseTarget && login === "password";
  const saveTo = useSaveTo(backend, choosing, targetsVersion);
  const { found, target } = saveTo;
  const [pickMissing, setPickMissing] = useState(false);
  const name = draft.name.trim() || "the Host";
  const newGroup = isNewGroup(draft, hosts);
  const suggestions = itemSuggestions(draft, hosts);

  const problemOf = (f: AddField): string | null => {
    const mine = touched.has(f) || touched.has("*") ? addProblem(f, draft, hosts) : null;
    return mine ?? (rosterSays?.field === f ? rosterSays.message : null);
  };
  const passwordMissing = login === "password" && !hasPassword && (touched.has("password") || touched.has("*"));

  const set = (patch: Partial<AddDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setRosterSays(null);
    if (phase.at !== "ready" && !busy && phase.at !== "confirm-key") setPhase({ at: "ready" });
  };

  /** Empties the password input: after every call that carried it, pass or fail. */
  const forgetPassword = () => {
    if (password.current) password.current.value = "";
    setHasPassword(false);
    // Emptied on purpose: no "type the password" nag until the next try.
    setTouched((t) => new Set([...t].filter((f) => f !== "password" && f !== "*")));
  };

  const add = async (hostKey?: string) => {
    const params = addParams(draft, hosts, login === "password" ? password.current?.value : undefined, target?.save_to);
    if (!params) return;
    setPhase({ at: "adding" });
    try {
      // After a timeout, addHostChecked asks roster whether the Host went in, and says so.
      const result = await addHostChecked(backend, hostKey ? { ...params, host_key: hostKey } : params);
      if (live.current) onAdded(result);
    } catch (e) {
      if (!live.current) return;
      const problem = problemFromCallError(params.name, e);
      const steps = e instanceof BackendCallError && Array.isArray(e.data?.["steps"]) ? (e.data["steps"] as CheckStep[]) : null;
      if (steps) return setPhase({ at: "verify-failed", problem, steps });
      if (e instanceof BackendCallError && (e.code === 80 || e.code === 81)) {
        const field = e.code === 81 ? "name" : String(e.data?.["field"] ?? "");
        setRosterSays({ field: field === "ip" ? "address" : field, message: e.message });
      }
      setPhase({ at: "failed", problem });
    } finally {
      // params held the password too; it goes out of scope here.
      forgetPassword();
    }
  };

  const submit = async () => {
    if (busy) return;
    setTouched(new Set(["*"]));
    const problems = problemsOf(draft, hosts);
    if (problems.length || (login === "password" && !password.current?.value)) {
      const first = problems[0]?.[0] ?? "password";
      (first === "password" ? password.current : document.getElementById(fieldId(first)))?.focus();
      return;
    }
    if (found && !target) {
      // The default names a place that isn't there: this Host's choice has to be made here.
      setPickMissing(true);
      document.querySelector<HTMLInputElement>(`input[name="${fieldId("saveto")}-saveto"]`)?.focus();
      return;
    }
    // The pull first (decision Q88): the one running, or a new one if the last is stale. A failed
    // one says why above and nothing is written; roster refuses a name the pull brought (81).
    setPhase({ at: "waiting" });
    const pulled = await formPull.ready();
    if (!live.current) return;
    if (pulled === null) return setPhase({ at: "ready" });
    if (login === "none") return add();
    // A Login means a first login to this address: its host key is shown and confirmed first.
    setPhase({ at: "scanning" });
    try {
      const key = await backend.scanKey(draft.address.trim(), Number(draft.port.trim()));
      if (!live.current) return;
      if (key.recorded === "match") return add();
      if (key.recorded === "changed") {
        forgetPassword();
        return setPhase({
          at: "failed",
          problem: {
            code: 43,
            host: draft.name.trim(),
            message: `The host key at ${key.address}:${key.port} isn't the one roster recorded - not adding ${draft.name.trim()}`,
            details: `offered ${key.key_type} ${key.fingerprint}`,
            data: { offered: key.fingerprint },
          },
        });
      }
      setPhase({ at: "confirm-key", key });
    } catch (e) {
      if (!live.current) return;
      forgetPassword();
      setPhase({ at: "failed", problem: problemFromCallError(draft.name.trim(), e) });
    }
  };

  const refuseKey = (key: ScannedKey) => {
    forgetPassword();
    setPhase({ at: "key-refused", key });
  };

  const touch = (f: string) => setTouched((t) => (t.has(f) ? t : new Set(t).add(f)));

  return (
    <section
      className="side-panel edit-panel add-panel"
      role="region"
      aria-label="Add a Host"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          if (phase.at === "confirm-key") return refuseKey(phase.key);
          onClose();
        }
      }}
    >
      <header>
        <h2>Add a Host</h2>
        <span className="panel-head-buttons">
          <PanelButton />
          <button type="button" className="icon-button close" aria-label="Close the add form" onClick={onClose}>
            <CloseGlyph />
          </button>
        </span>
      </header>
      <PullStatus pull={formPull} rows={rows} actions={actions} />
      {pulledIn && hosts.hosts.some((h) => h.name === draft.name.trim()) && (
        <p className="edit-note" role="status">
          The pull brought a Host named <span className="mono">{draft.name.trim()}</span>, so this one needs another name.
        </p>
      )}
      <form
        className="edit-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (phase.at === "confirm-key") return void add(phase.key.fingerprint);
          void submit();
        }}
      >
        <div className="edit-fields">
          {FIELDS.map((f) => {
            const problem = problemOf(f.name);
            const id = fieldId(f.name);
            const note = f.name === "group" && newGroup ? "new group" : null;
            return (
              <div key={f.name} className="edit-field">
                <label htmlFor={id}>
                  {f.label}
                  {note && <span className="edit-changed"> · {note}</span>}
                </label>
                <input
                  id={id}
                  className={f.mono ? "mono" : undefined}
                  value={draft[f.name]}
                  placeholder={f.placeholder}
                  list={f.name === "group" ? `${ids}-groups` : undefined}
                  spellCheck={false}
                  autoComplete="off"
                  inputMode={f.name === "port" ? "numeric" : undefined}
                  disabled={busy}
                  aria-invalid={problem ? true : undefined}
                  aria-describedby={problem ? `${id}-problem` : undefined}
                  onBlur={() => touch(f.name)}
                  onChange={(e) => set({ [f.name]: e.target.value })}
                />
                {problem && (
                  <span id={`${id}-problem`} className="edit-field-problem">
                    {problem}
                  </span>
                )}
              </div>
            );
          })}
          <datalist id={`${ids}-groups`}>
            {Object.keys(hosts.groups).map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
          <fieldset className="add-login" disabled={busy}>
            <legend>Login</legend>
            <div className="add-ways" role="radiogroup" aria-label="How it logs in">
              {LOGIN_WAYS.map(({ way, label }) => (
                <label key={way} className="add-way">
                  <input
                    type="radio"
                    name={`${ids}-login`}
                    value={way}
                    checked={login === way}
                    onChange={() => {
                      set({ login: way, item: "" });
                      setHasPassword(false);
                    }}
                  />
                  {label}
                </label>
              ))}
            </div>
            {login === "password" && (
              <div className="edit-field">
                <label htmlFor={fieldId("password")}>Password</label>
                <input
                  id={fieldId("password")}
                  ref={password}
                  type="password"
                  className="mono"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={passwordMissing ? true : undefined}
                  aria-describedby={passwordMissing ? `${fieldId("password")}-problem` : undefined}
                  onBlur={() => touch("password")}
                  onChange={(e) => {
                    // Only whether there is one: the value stays in the input.
                    setHasPassword(e.target.value !== "");
                    setRosterSays(null);
                  }}
                />
                {passwordMissing && (
                  <span id={`${fieldId("password")}-problem`} className="edit-field-problem">
                    Type the password {name} takes
                  </span>
                )}
              </div>
            )}
            {login !== "none" && (
              <div className="edit-field">
                <label htmlFor={fieldId("item")}>{login === "password" ? "Save it as" : "Vault item"}</label>
                <input
                  id={fieldId("item")}
                  className="mono"
                  value={draft.item}
                  placeholder={login === "password" ? defaultItem(draft.name) : defaultRef(draft.name)}
                  list={`${ids}-items`}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={problemOf("item") ? true : undefined}
                  aria-describedby={`${fieldId("item")}-hint`}
                  onBlur={() => touch("item")}
                  onChange={(e) => set({ item: e.target.value })}
                />
                <datalist id={`${ids}-items`} data-testid="item-suggestions">
                  {suggestions.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
                <span id={`${fieldId("item")}-hint`} className={problemOf("item") ? "edit-field-problem" : "edit-hint"}>
                  {problemOf("item") ??
                    (login === "password"
                      ? "Saved to the vault only after the test login passes. Name it <host> <what it opens>."
                      : "Its password is looked up for the test login, never shown.")}
                </span>
              </div>
            )}
            {choosing && (
              <SaveToField id={fieldId("saveto")} choice={saveTo} pickMissing={pickMissing} onChoose={() => setPickMissing(false)} />
            )}
            <label className="add-check">
              <input type="checkbox" checked={draft.enroll} onChange={(e) => set({ enroll: e.target.checked })} />
              Install this Box's key on it later (enroll)
            </label>
          </fieldset>
        </div>
        <p className="edit-note">
          {login === "none"
            ? `With no Login to test, ${name} goes in unreviewed: it can't be opened until it's marked reviewed.`
            : "roster tests the login first: one attempt, after you confirm the host key. Nothing is saved if it fails."}
        </p>
        {phase.at === "scanning" && <p className="muted edit-status">Reading the host key at {draft.address.trim()}…</p>}
        {phase.at === "confirm-key" && (
          <div className="add-key" role="group" aria-label="Confirm the host key">
            <p className="edit-status">
              First login to {phase.key.address}
              {phase.key.port === 22 ? "" : `:${phase.key.port}`}. Its {phase.key.key_type} host key is:
            </p>
            <p className="mono add-fingerprint">{phase.key.fingerprint}</p>
            <p className="muted edit-status">Compare it with the Host's console or its owner before you trust it.</p>
            <div className="edit-actions">
              <button type="button" className="primary" ref={trustRef} onClick={() => void add(phase.key.fingerprint)}>
                Trust it and add
              </button>
              <button type="button" onClick={() => refuseKey(phase.key)}>
                Don't trust it
              </button>
            </div>
          </div>
        )}
        {phase.at === "key-refused" && (
          <p className="edit-status" role="alert">
            Not added: you didn't trust the host key at {phase.key.address}. Nothing was written.
          </p>
        )}
        {phase.at === "waiting" && <p className="muted edit-status">Waiting for the pull to finish…</p>}
        {phase.at === "adding" && (
          <p className="muted edit-status">{login === "none" ? "Adding…" : `Testing the login to ${draft.address.trim()}…`}</p>
        )}
        {phase.at === "verify-failed" && (
          <div className="edit-problem" role="alert">
            <p className="edit-status">The test login failed, so nothing was saved: not the Host, not the password.</p>
            <CheckSteps host={draft.name.trim()} steps={phase.steps} rows={rows} actions={actions} />
          </div>
        )}
        {phase.at === "failed" && (
          <div className="edit-problem" role="alert">
            <ProblemBody problem={phase.problem} rows={rows} actions={actions} notInTab />
          </div>
        )}
        {phase.at !== "confirm-key" && (
          <div className="edit-actions">
            <button type="submit" className="primary" disabled={busy}>
              {login === "none" ? "Add unreviewed" : "Test login and add"}
            </button>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <span className="edit-keys muted key-hint">
              <Keys keys="Enter" /> add <Keys keys="Escape" /> close
            </span>
          </div>
        )}
      </form>
    </section>
  );
}
