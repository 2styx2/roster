// The Sessions' terminals, one per tab, and the basic tab strip that the `sessions = "tabs"`
// option shows instead of the Sidebar's Sessions section. Inactive terminals stay mounted, just
// hidden, so their screens survive switching. Buttons here run command lines (`session N`,
// `close N`, `reconnect`) like every other way in.
import { useEffect, useId, useRef, useState } from "react";
import type { HostKeyScan } from "../backend/types";
import type { ErrorRow } from "../errors/catalog";
import { ErrorPanel, type ProblemActions } from "../errors/ErrorPanel";
import type { CommandLine } from "../keymap";
import type { TerminalEnv, TerminalViewComponent } from "../terminal/TerminalView";
import { Keys } from "../ui/Keys";
import { tabFacts, type PasswordPrompt, type Tab, type Tabs, type TabsSnapshot } from "./tabs";
import { HopCrumb } from "./HopCrumb";
import type { QuickTarget } from "../quick/target";
import { CloseGlyph } from "../ui/CloseGlyph";

/** Where a Session is on its way to a shell (issue #78): `starting` while roster prepares it and
 * ssh starts on this Box, `logging-in` once ssh runs and the Host hasn't answered yet, null once
 * it has (or it ended, or was refused). For a Host whose key roster hasn't seen (ticket 36):
 * `checking-key` while its key is fetched, `asking` while the user decides, `trusting` while
 * roster records it. */
export type ConnectPhase = "starting" | "logging-in" | "checking-key" | "asking" | "trusting" | "password";

export function connectPhase(tab: Tab): ConnectPhase | null {
  const s = tab.status;
  if (s.state === "asking") return !s.key ? "checking-key" : s.trusting ? "trusting" : "asking";
  if (s.state === "password") return "password";
  if (s.state === "connecting") return "starting";
  if (tab.status.state === "open" && !tab.shell) return "logging-in";
  return null;
}

/** How the Session's link to its Host stands, for the edge drawn from its node (taste.md: an
 * edge drawn on connect, snapping back on failure): drawing, up, or down. */
export function linkOf(tab: Tab): "connecting" | "up" | "down" {
  if (connectPhase(tab)) return "connecting";
  return tab.status.state === "open" ? "up" : "down";
}

export function statusText(tab: Tab): string {
  const s = tab.status;
  switch (s.state) {
    case "connecting":
      return "connecting…";
    case "asking":
      return s.key ? "new host key" : "connecting…";
    case "password":
      return "password";
    case "open":
      return tab.shell ? "" : "connecting…";
    case "failed":
      return "failed";
    case "ended":
      if (s.exit.closed) return "closed";
      return s.exit.code === null ? "ended (signal)" : `ended (code ${s.exit.code})`;
  }
}

/** The tab's state dot (as in the prototype): filled for a key login, hollow for a password one,
 * grey once the Session has ended or was refused. */
function StateDot({ tab }: { tab: Tab }) {
  const done = tab.status.state === "ended" || tab.status.state === "failed";
  const auth = tab.auth;
  const connecting = connectPhase(tab) !== null;
  const cls = [
    "st",
    auth === "password" ? "pw" : "",
    done ? "ended" : "",
    connecting ? "connecting" : auth === null && !done ? "pending" : "",
  ];
  return <span className={cls.filter(Boolean).join(" ")} aria-hidden="true" />;
}

export interface TabStripProps {
  snapshot: TabsSnapshot;
  /** Runs a command line (`session N`, `close N`): the strip has no actions of its own. */
  run(line: CommandLine): void;
}

/** A basic tab strip: see, switch and close. */
export function TabStrip({ snapshot, run }: TabStripProps) {
  return (
    <div className="tabstrip" role="tablist" aria-label="Sessions">
      {snapshot.tabs.map((tab, i) => {
        const selected = tab.id === snapshot.active;
        const status = statusText(tab);
        return (
          <div key={tab.id} className={`tab${selected ? " selected" : ""} ${tab.status.state}`}>
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={-1}
              title={[tab.label, tabFacts(tab)].filter(Boolean).join("\n")}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(`session ${i + 1}`)}
            >
              <StateDot tab={tab} />
              <span className="tab-host">
                <span className="tab-name">{tab.label === tab.host ? tab.label : tab.label.slice(0, tab.host.length)}</span>
                {tab.label !== tab.host && <span className="tab-tail">{tab.label.slice(tab.host.length)}</span>}
              </span>
              {tab.hop && <HopCrumb hop={tab.hop} spoken />}
              {status && <span className="tab-status"> {status}</span>}
            </button>
            <button
              type="button"
              className="tab-close"
              aria-label={`Close ${tab.label}`}
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(`close ${i + 1}`)}
            >
              <CloseGlyph />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** What the connect card says on its second line: honest about where it is (taste.md). */
const PHASE_WORDS: Record<ConnectPhase, string> = {
  starting: "Starting ssh on this Box…",
  "logging-in": "Logging in…",
  "checking-key": "Fetching the Host's key…",
  asking: "",
  trusting: "Recording the key…",
  password: "",
};

/** The host key question's answers (ticket 36), from the tab's store. */
export interface KeyAnswers {
  trust(): void;
  cancel(): void;
  /** A Quick Connect's answer (ticket 14): the key is confirmed, with the password typed (empty:
   * this Box's keys), and whether to save it to the vault once it logs in (ticket 15). */
  connect?(password: string, save: boolean): void;
}

/**
 * The pane while its Session connects (issue #78): not a blank terminal, but this Box's square, an
 * edge drawn to the Host's node, the Host and its address in Iosevka, and what's happening now.
 * It's the network-map motif (taste.md), never a spinner. When the shell answers, it fades out
 * over the first output; a failure replaces it with the error at once.
 */
export function ConnectCard({
  host,
  address,
  phase,
  again,
  hostKey = null,
  answers,
  active = true,
  quick = null,
  canSave = false,
  prompt = null,
}: {
  host: string;
  address: string | null;
  /** Null: the shell answered, so the card fades out and then goes. */
  phase: ConnectPhase | null;
  /** A reconnect ("Reconnecting to …"). */
  again: boolean;
  /** The key to ask about (ticket 36), while `phase` is asking or trusting. */
  hostKey?: HostKeyScan | null;
  answers?: KeyAnswers;
  /** Its pane is the one showing: the question then takes focus. */
  active?: boolean;
  /** A Quick Connect (ticket 14): the question asks for the password too. */
  quick?: QuickTarget | null;
  /** roster can save a typed password once the Session logs in (API 13, ticket 15): offer it. */
  canSave?: boolean;
  /** An `auth: prompt` Host (ticket 16): roster has no saved password, so the card asks for it. */
  prompt?: { user: string; address: string; port: number } | null;
}) {
  const card = useRef<HTMLDivElement>(null);
  const trustButton = useRef<HTMLButtonElement>(null);
  // The typed password lives only in this input (never React state): read once on submit, sent,
  // and the field emptied at once (docs/app/security.md).
  const passwordField = useRef<HTMLInputElement>(null);
  const keysNote = useId();
  // Whether to save the password once it logs in: a choice, not a secret, so plain state.
  const [save, setSave] = useState(false);
  const question = (phase === "asking" || phase === "trusting") && hostKey !== null && answers !== undefined;
  const asksPassword = phase === "password" && prompt !== null && answers?.connect !== undefined;
  const asking = question || asksPassword;
  // Keyboard first: the question takes focus (after the terminal, which the active pane focuses
  // first), so Enter trusts and Esc cancels. Once answered, focus goes back to the terminal.
  const asked = useRef(false);
  useEffect(() => {
    if (asking && active) (passwordField.current ?? trustButton.current)?.focus();
    if (asking) asked.current = true;
    else if (asked.current) {
      asked.current = false;
      if (active && (document.activeElement === document.body || document.activeElement === null)) {
        card.current?.parentElement?.querySelector<HTMLElement>("textarea, input")?.focus();
      }
    }
  }, [asking, active]);
  // The last phase, kept while the card fades out after the shell answered; then it's gone.
  const [last, setLast] = useState<ConnectPhase | null>(phase);
  if (phase !== null && phase !== last) setLast(phase);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (phase !== null) return;
    const t = setTimeout(() => setGone(true), FADE_MS);
    return () => clearTimeout(t);
  }, [phase]);
  const words = phase ?? (gone ? null : last);
  if (words === null) return null;
  const title = `${again ? "Reconnecting" : "Connecting"} to ${host}`;
  // A Quick Connect's name already holds its address (user@address), so the title doesn't repeat it.
  const where = quick ? null : question ? `${hostKey.address}:${hostKey.port}` : asksPassword ? `${prompt.address}:${prompt.port}` : address;
  const asksQuick = question && quick !== null && answers.connect !== undefined;
  const connectQuick = () => {
    const field = passwordField.current;
    const typed = field?.value ?? "";
    if (field) field.value = "";
    answers?.connect?.(typed, canSave && save && typed !== "");
  };
  // The question stays in this same card (no new surface, no second entrance): the edge waits,
  // dashed, short of the Host until the user answers.
  return (
    <div
      ref={card}
      className={`connect-card${phase === null ? " leaving" : ""}${asking ? " key-question" : ""}`}
      role={asking ? "alertdialog" : "status"}
      aria-label={
        asksQuick
          ? `Quick Connect to ${host}`
          : asksPassword
            ? `Password for ${host}`
            : question
              ? `Trust ${host}'s host key?`
              : phase === null
                ? undefined
                : title
      }
      onKeyDown={
        asking
          ? (e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                answers?.cancel();
              } else if (e.key === "Enter" && e.target === e.currentTarget) {
                e.preventDefault();
                if (asksQuick || asksPassword) connectQuick();
                else answers?.trust();
              }
            }
          : undefined
      }
      tabIndex={asking ? -1 : undefined}
    >
      <svg className={`connect-map${asking ? " waiting" : ""}`} viewBox="0 0 72 12" width="72" height="12" aria-hidden="true">
        <rect className="connect-box" x="1" y="2" width="8" height="8" rx="1.6" />
        <line className="connect-edge" x1="12" y1="6" x2="59" y2="6" />
        <circle className="connect-host" cx="65" cy="6" r="4.25" />
      </svg>
      <p className="connect-title">
        <span className="muted">{again ? "Reconnecting to " : "Connecting to "}</span>
        <span className="connect-name">{host}</span>
        {where && <span className="connect-address"> {where}</span>}
      </p>
      {asksPassword ? (
        <>
          <p className="key-says">
            <span className="connect-name">{host}</span>'s Login is <span className="connect-name">auth: prompt</span>: roster has no saved
            password for it.
          </p>
          <form
            className="quick-login"
            onSubmit={(e) => {
              e.preventDefault();
              if (passwordField.current?.value) connectQuick();
            }}
          >
            <label className="quick-password">
              <span>
                Password for <span className="connect-name">{prompt.user}</span>
              </span>
              <input ref={passwordField} type="password" autoComplete="off" spellCheck={false} />
            </label>
            {canSave && (
              <label className="add-check quick-save">
                <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
                Save to vault once it logs in
              </label>
            )}
            <div className="key-actions">
              <button type="submit" className="primary" ref={trustButton}>
                Connect
              </button>
              <button type="button" onClick={() => answers.cancel()}>
                Cancel
              </button>
            </div>
          </form>
          <p className="connect-phase muted">
            <span className="key-hint">
              <Keys keys="Enter" /> connect · <Keys keys="Escape" /> cancel
            </span>
          </p>
        </>
      ) : asksQuick ? (
        <>
          <p className="key-says">
            {hostKey.recorded === "match" ? "This is the key roster recorded for " : "roster hasn't seen a key at "}
            <span className="connect-address">{endpoint(quick)}</span>
            {hostKey.recorded === "match" ? "." : " before."}
          </p>
          <p className="key-print">
            <span className="key-type">{hostKey.key_type}</span> <span className="key-fingerprint">{hostKey.fingerprint}</span>
          </p>
          <p className="muted key-advice">Compare it with the machine's console or its owner before you trust it.</p>
          <form
            className="quick-login"
            onSubmit={(e) => {
              e.preventDefault();
              connectQuick();
            }}
          >
            <label className="quick-password">
              <span>
                Password for <span className="connect-name">{quick.user}</span>
              </span>
              <input ref={passwordField} type="password" autoComplete="off" spellCheck={false} aria-describedby={keysNote} />
            </label>
            <p className="muted quick-keys" id={keysNote}>
              Leave it empty to log in with this Box's keys.
            </p>
            {canSave && (
              <label className="add-check quick-save">
                <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
                Save to vault once it logs in
              </label>
            )}
            <div className="key-actions">
              <button type="submit" className="primary" ref={trustButton}>
                Trust and connect
              </button>
              <button type="button" onClick={() => answers.cancel()}>
                Cancel
              </button>
            </div>
          </form>
          <p className="connect-phase muted">
            <span className="key-hint">
              <Keys keys="Enter" /> connect · <Keys keys="Escape" /> cancel
            </span>
          </p>
        </>
      ) : question ? (
        <>
          <p className="key-says">roster hasn't seen this Host's key before.</p>
          <p className="key-print">
            <span className="key-type">{hostKey.key_type}</span> <span className="key-fingerprint">{hostKey.fingerprint}</span>
          </p>
          <p className="muted key-advice">Compare it with the Host's console or its owner before you trust it.</p>
          <div className="key-actions">
            <button type="button" className="primary" ref={trustButton} onClick={() => answers.trust()}>
              Trust and connect
            </button>
            <button type="button" onClick={() => answers.cancel()}>
              Cancel
            </button>
          </div>
          <p className="connect-phase muted" aria-live="polite">
            {phase === "trusting" ? (
              PHASE_WORDS.trusting
            ) : (
              <span className="key-hint">
                <Keys keys="Enter" /> trust · <Keys keys="Escape" /> cancel
              </span>
            )}
          </p>
        </>
      ) : (
        <p className="connect-phase muted">{PHASE_WORDS[words]}</p>
      )}
    </div>
  );
}

/** "Save to vault" (ticket 15): the Session logged in with the password typed for it, so roster can
 * save it now. A quiet note in the pane's corner, like "Session ended": it never takes the
 * terminal's focus, since the user just reached a shell. */
function SaveOffer({
  host,
  saveKeys,
  leader,
  run,
  dismiss,
}: {
  host: string;
  saveKeys: string | null;
  leader: string;
  run(line: CommandLine): void;
  dismiss(): void;
}) {
  return (
    <div className="session-note save-offer" role="status" aria-label="Save to vault">
      <span>
        <span className="connect-name">{host}</span> logged in with the password you typed.
      </span>
      {saveKeys && (
        <span className="muted key-hint">
          <Keys keys={saveKeys} leader={leader} />
        </span>
      )}
      <button type="button" className="reconnect primary" onClick={() => run("save")}>
        Save…
      </button>
      <button type="button" className="reconnect" onClick={dismiss}>
        Not now
      </button>
    </div>
  );
}

/** The fill key's offer (ticket 119, decision Q129): the Session waits at a password prompt, and
 * the key types the Host's password from the vault. Without the shell's marks it says roster can't
 * tell whether the Session is still on the Host. A quiet note in the pane's corner, as "Save to
 * vault": it never takes the terminal's focus (its button keeps it there), and it goes as soon as
 * the prompt does. When the shell's marks say the prompt may be another Host's, it says so and
 * offers nothing. A nested ssh's prompt (ticket 120) names the Host that ssh went to. */
function FillOffer({
  host,
  prompt,
  fillKeys,
  leader,
  run,
}: {
  /** The Session's own Host. */
  host: string;
  prompt: PasswordPrompt;
  fillKeys: string | null;
  leader: string;
  run(line: CommandLine): void;
}) {
  const whose = prompt.kind === "ssh" ? "ssh's" : "sudo's";
  if (prompt.elsewhere !== null) {
    return (
      <div className="session-note fill-offer elsewhere" role="status" aria-label="Password prompt">
        <span>
          {whose} password prompt: {prompt.elsewhere}. roster won't fill it.
        </span>
      </div>
    );
  }
  const to = prompt.hop?.host ?? host;
  return (
    <div className="session-note save-offer fill-offer" role="status" aria-label="Password prompt">
      <span>
        {whose} password prompt · fill <span className="connect-name">{to}</span>'s from the vault
        {!prompt.marked && (
          <>
            {" "}
            <span className="muted">(roster can't tell whether you're still on {host}: without the shell's marks a nested shell can't be ruled out)</span>
          </>
        )}
      </span>
      {fillKeys && (
        <span className="muted key-hint">
          <Keys keys={fillKeys} leader={leader} />
        </span>
      )}
      <button type="button" className="reconnect primary" onMouseDown={(e) => e.preventDefault()} onClick={() => run("fill")}>
        Fill
      </button>
    </div>
  );
}

/** address:port as ssh would write it ([address]:port for IPv6). */
function endpoint({ address, port }: QuickTarget): string {
  return `${address.includes(":") ? `[${address}]` : address}:${port}`;
}

/** How long the card takes to fade out (--dur-fade in styles.css). */
const FADE_MS = 120;

export interface SessionPanesProps {
  tabs: Pick<Tabs, "wiring" | "trustKey" | "cancelKey" | "connectQuick" | "connectPrompted" | "dismissSave">;
  snapshot: TabsSnapshot;
  leader: string;
  terminalView: TerminalViewComponent;
  /** Shared by every terminal (options, keys, clipboard). */
  terminalEnv: TerminalEnv;
  /** The keys that reconnect an ended tab ("␣ r"), if the keymap has them. */
  reconnectKeys: string | null;
  /** Runs a command line (the Retry and Reconnect buttons run `reconnect`). */
  run(line: CommandLine): void;
  /** The error catalog's rows (docs/app/errors.md), for a refused or failed Session. */
  errorRows: readonly ErrorRow[];
  /** Puts a command from an error's fix on the clipboard. */
  copy(text: string): Promise<void>;
  /** A Host's address, for the connect card ("10.0.0.6"), or null. */
  addressOf?(host: string): string | null;
  /** roster can save a typed password once its Session logs in (API 13, tickets 15 and 16). */
  canSave?: boolean;
  /** The keys that open the save form (`:save`), if the keymap has them. */
  saveKeys?: string | null;
  /** A line to find in one Session's scrollback (`roster.sessions.show`, ticket 78). */
  reveal?: { session: number; text: string; nonce: number } | null;
  /** roster can fill a password prompt from the vault (API 25, ticket 119): offer it. */
  canFill?: boolean;
  /** The keys that fill it (`:fill`), if the keymap has them. */
  fillKeys?: string | null;
}

export function SessionPanes({
  tabs,
  snapshot,
  leader,
  terminalView: TerminalView,
  terminalEnv,
  reconnectKeys,
  run,
  errorRows,
  copy,
  addressOf,
  canSave = false,
  saveKeys = null,
  reveal = null,
  canFill = false,
  fillKeys = null,
}: SessionPanesProps) {
  const actions: ProblemActions = { run, copy };
  return (
    <div className="panes">
      {snapshot.tabs.map((tab) => {
        const active = tab.id === snapshot.active;
        const s = tab.status;
        const wiring = tabs.wiring(tab.id);
        return (
          <div key={tab.id} className="pane" role="group" aria-label={`Session ${tab.label}`} hidden={!active}>
            {s.state === "failed" ? (
              <div className="session-error">
                <ErrorPanel title="Couldn't open a Session" problem={s.problem} rows={errorRows} actions={actions} />
              </div>
            ) : (
              wiring && (
                <TerminalView
                  active={active}
                  leader={leader}
                  {...wiring}
                  env={terminalEnv}
                  reveal={reveal?.session === tab.id ? { text: reveal.text, nonce: reveal.nonce } : null}
                />
              )
            )}
            {s.state !== "failed" && s.state !== "ended" && (
              <ConnectCard
                key={tab.attempt}
                host={tab.host}
                address={addressOf?.(tab.host) ?? null}
                phase={connectPhase(tab)}
                again={tab.attempt > 1}
                hostKey={s.state === "asking" ? s.key : null}
                answers={{
                  trust: () => tabs.trustKey(tab.id),
                  cancel: () => tabs.cancelKey(tab.id),
                  connect: (password, save) =>
                    tab.quick ? tabs.connectQuick(tab.id, password, save) : tabs.connectPrompted(tab.id, password, save),
                }}
                active={active}
                quick={tab.quick?.to ?? null}
                canSave={canSave}
                prompt={s.state === "password" ? s : null}
              />
            )}
            {tab.save?.loggedIn && tab.save.saved === null && s.state === "open" && (
              <SaveOffer host={tab.host} saveKeys={saveKeys} leader={leader} run={run} dismiss={() => tabs.dismissSave(tab.id)} />
            )}
            {canFill && tab.prompt && !tab.quick && s.state === "open" && (
              <FillOffer host={tab.host} prompt={tab.prompt} fillKeys={fillKeys} leader={leader} run={run} />
            )}
            {/* Where a nested ssh took the Session (ticket 120), said once when it changes. */}
            <span className="visually-hidden" role="status" aria-label="Where this Session is">
              {tab.hop ? `Now on ${tab.hop.to}${tab.hop.known ? "" : ", not a Host roster can resolve"}` : ""}
            </span>
            {s.state === "ended" && s.problem && (
              <div className="session-error overlay">
                <ErrorPanel title="Session ended" problem={s.problem} rows={errorRows} actions={actions} />
              </div>
            )}
            {s.state === "ended" && !s.problem && (
              <div className="session-note ended">
                <span>{statusText(tab)}</span>
                {reconnectKeys && (
                  <span className="muted key-hint">
                    {" "}
                    · <Keys keys={reconnectKeys} leader={leader} /> or
                  </span>
                )}{" "}
                <button type="button" className="reconnect" onClick={() => run("reconnect")}>
                  Reconnect
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
