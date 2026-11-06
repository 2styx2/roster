// The Sessions' terminals, one per tab, and the basic tab strip that the `sessions = "tabs"`
// option shows instead of the Sidebar's Sessions section. Inactive terminals stay mounted, just
// hidden, so their screens survive switching. Buttons here run command lines (`session N`,
// `close N`, `reconnect`) like every other way in.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { HostKeyScan } from "../backend/types";
import type { ErrorRow } from "../errors/catalog";
import { ErrorPanel, type ProblemActions } from "../errors/ErrorPanel";
import type { CommandLine } from "../keymap";
import type {
  TerminalEnv,
  TerminalViewComponent,
} from "../terminal/TerminalView";
import { Keys } from "../ui/Keys";
import { useMediaMatch } from "../ui/useMediaMatch";
import {
  tabFacts,
  type PasswordPrompt,
  type Tab,
  type Tabs,
  type TabsSnapshot,
} from "./tabs";
import { HopCrumb } from "./HopCrumb";
import type { QuickTarget } from "../quick/target";
import { CloseGlyph } from "../ui/CloseGlyph";
import { useForgetOnLock } from "../lock/forgetOnLock";
import { cardMoreBelow, revealInCard } from "./reveal";
import { slip, type Message } from "../ui/messages";
import { connectPhase, isLive, statusText, type ConnectPhase } from "./status";

/** The tab's state dot (as in the prototype): filled for a key login, hollow for a password one,
 * grey once the Session has ended or was refused. */
function StateDot({ tab }: { tab: Tab }) {
  const done = !isLive(tab.status);
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
          <div
            key={tab.id}
            className={`tab${selected ? " selected" : ""} ${tab.status.state}`}
          >
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
                <span className="tab-name">
                  {tab.label === tab.host
                    ? tab.label
                    : tab.label.slice(0, tab.host.length)}
                </span>
                {tab.label !== tab.host && (
                  <span className="tab-tail">
                    {tab.label.slice(tab.host.length)}
                  </span>
                )}
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

/** What the connect card says on its second line: honest about where it is (taste.md). `ssh` is a
 * command you could paste, so it's in Iosevka (the paste rule). */
const PHASE_WORDS: Record<ConnectPhase, ReactNode> = {
  starting: (
    <>
      Starting <span className="connect-cmd">ssh</span> on this Box…
    </>
  ),
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
function ConnectCard({
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
  closeKeys = null,
  leader = "",
  fills = true,
  help,
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
  /** The keys that close the Session ("␣ d d"): offered once connecting has taken a while. */
  closeKeys?: string | null;
  leader?: string;
  /** It logs in with a key: the Host's node fills when the shell answers (a password one stays a
   * ring), as in the Sidebar. */
  fills?: boolean;
  /** Opens a help topic (`:help host-keys` from the key question). */
  help?: (topic: string) => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  const trustButton = useRef<HTMLButtonElement>(null);
  // A host-key question opens on Cancel (owner, after round 11): a reflexive Enter must not trust a
  // key nobody has read; trusting takes Tab then Enter, or a click.
  const cancelButton = useRef<HTMLButtonElement>(null);
  // The typed password lives only in this input (never React state): read once on submit, sent,
  // and the field emptied at once (docs/app/security.md).
  const passwordField = useRef<HTMLInputElement>(null);
  // Quick Connect's "I've checked this key": where its question opens (round 16), so the keys
  // follow the task: read the key, Space to tick, Tab to the password, Enter.
  const checkedBox = useRef<HTMLInputElement>(null);
  useForgetOnLock(() => {
    if (passwordField.current) passwordField.current.value = "";
  });
  const keysNote = useId();
  // Which button Enter acts on now, so its ↵ shows there and nowhere else (round 21): the
  // focused button; in Quick Connect, Trust also while the password field has focus (Enter there
  // submits). Elsewhere (the boxes, the card itself, the help pointer) Enter never connects, so
  // neither shows it (round 22).
  const [enterOn, setEnterOn] = useState<"trust" | "cancel" | null>(null);
  const noteFocus = (at: EventTarget | null) => {
    const el = at instanceof Element ? at : null;
    setEnterOn(
      el === null
        ? null
        : el.closest(".key-cancel")
          ? "cancel"
          : el === trustButton.current ||
              (checkedBox.current !== null && el === passwordField.current)
            ? "trust"
            : null,
    );
  };
  // Whether to save the password once it logs in: a choice, not a secret, so plain state.
  const [save, setSave] = useState(false);
  // Quick Connect's key question: Enter connects only once the key is marked checked, so a
  // password typed and entered never trusts a key nobody read (owner, after round 14).
  const [checkedKey, setCheckedKey] = useState(false);
  // Enter before the tick isn't silent: the error room says what's missing (round 16).
  const [nudged, setNudged] = useState(false);
  // A short window (the size where the map gives way) puts the box right under the key it
  // vouches for, so the two are on screen together at 480×320 (round 19).
  const short = useMediaMatch("(max-height: 460px)");
  const question =
    (phase === "asking" || phase === "trusting") &&
    hostKey !== null &&
    answers !== undefined;
  const asksPassword =
    phase === "password" && prompt !== null && answers?.connect !== undefined;
  const asking = question || asksPassword;
  // Scrolls Quick Connect's card so "I've checked this key" is whole between the title's and the
  // footer's fades, with the fingerprint's top too when both fit (the box wins when they don't),
  // and no line cut by either edge (round 21: round 20 read the pin from the stuck title's
  // offsetTop, so from the password field the card never scrolled back and the box stayed under
  // the title).
  const revealBox = () => {
    const c = card.current;
    const row = checkedBox.current?.closest(".quick-checked-row");
    if (!c || !row) return;
    revealInCard(c, row, c.querySelector(".key-print"), FADE_PX);
  };
  // The password field is revealed with its label and the note under it ("Leave it empty…") as
  // one block when they fit (round 23: after Enter on the ticked box the note lay under the
  // footer's fade), else the field with as much of the note as fits.
  const revealField = (field: HTMLElement) => {
    const c = card.current;
    if (!c) return;
    const label = field.closest("label");
    const noteId = field.getAttribute("aria-describedby");
    const note = noteId ? document.getElementById(noteId) : null;
    const block = [label, field, note].filter((el): el is HTMLElement => el !== null);
    revealInCard(c, field, note, FADE_PX, block);
  };
  // Focus moved to the pinned title or footer (Trust, Cancel), always in view: the card only
  // settles where no line is cut by either edge (round 23: Enter on "Save to vault" went to
  // Trust and left "Password for root" sliced by the title).
  const settle = () => {
    if (card.current) revealInCard(card.current, null, null, FADE_PX);
  };
  // The question's edges say what's past them (round 20): the title's rule and fade only once
  // something is under it, the footer's fade only while more lies below it, so neither fades a
  // line that isn't going anywhere. Set as the card scrolls and whenever its size changes.
  useEffect(() => {
    const c = card.current;
    if (!asking || !c) return;
    markScroll(c);
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => markScroll(c));
    watch.observe(c);
    return () => watch.disconnect();
  }, [asking, short]);
  // Keyboard first: the question takes focus (after the terminal, which the active pane focuses
  // first): Cancel, so Enter and Esc both cancel and trusting is deliberate (Q233). Once answered,
  // focus goes back to the terminal.
  const asked = useRef(false);
  useEffect(() => {
    if (asking && active)
      // Its ring shows even when the question came from a click (round 12): the focused Cancel
      // must read as the default.
      {
        const target =
          checkedBox.current ??
          passwordField.current ??
          cancelButton.current ??
          trustButton.current;
        target?.focus({
          focusVisible: true,
          // The card opens at its top, its question in view; focus doesn't scroll it (round 14)…
          preventScroll: true,
        } as FocusOptions);
        // …unless a short window hides the focused control: then it scrolls just enough, clear
        // of the sticky title and buttons (scroll-padding; round 16). A button in the sticky
        // footer is always in view, so the card stays at its top (round 18: Cancel's scroll had
        // opened it 53 px down at 480×320, its first lines under the title).
        // Quick Connect's box is shown with the key it vouches for (round 19).
        // Either way it lands whole between the fades, no line cut at an edge (round 21).
        if (target && target === checkedBox.current) revealBox();
        else if (target && target === passwordField.current) revealField(target);
        else if (target && card.current && !target.closest(".key-actions"))
          revealInCard(card.current, target, null, FADE_PX);
      }
    if (asking) asked.current = true;
    else if (asked.current) {
      asked.current = false;
      if (
        active &&
        (document.activeElement === document.body ||
          document.activeElement === null)
      ) {
        card.current?.parentElement
          ?.querySelector<HTMLElement>("textarea, input")
          ?.focus();
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
  // How long it has been connecting (taste.md: honest under failure): a slow Host and a hung one
  // shouldn't look the same. Seconds from 3 s, once a second, as text (no motion); the way
  // out shows from the start. While roster waits for an answer from you, there's nothing to time.
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  const waiting =
    phase === "starting" ||
    phase === "logging-in" ||
    phase === "checking-key" ||
    phase === "trusting";
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waiting]);
  const seconds = Math.floor((now - startedAt) / 1000);
  const words = phase ?? (gone ? null : last);
  if (words === null) return null;
  const title = `${again ? "Reconnecting" : "Connecting"} to ${host}`;
  // A Quick Connect's name already holds its address (user@address), so the title doesn't repeat it.
  // The questions show it on its own line under the title (one template for both, round 18).
  const where = question
    ? quick
      ? // What was typed, plus the port (round 19): the title already names the address, so
        // this line keeps the user it logs in as instead of repeating it.
        `${quick.user}@${endpoint(quick)}`
      : `${hostKey.address}:${hostKey.port}`
    : quick
      ? null
      : asksPassword
        ? `${prompt.address}:${prompt.port}`
        : address;
  const asksQuick = question && quick !== null && answers.connect !== undefined;
  // Enter (or Trust) before the tick: the box takes focus and is marked until it's ticked, and the
  // card scrolls so the key and the box are in view together (round 19).
  const blocked = () => {
    setNudged(true);
    checkedBox.current?.focus({
      focusVisible: true,
      preventScroll: true,
    } as FocusOptions);
    revealBox();
  };
  // After the tick, Enter on a box or on the card moves on to the password field instead of
  // connecting (round 22: Enter on the ticked box submitted the form with an empty password while
  // no button showed ↵, the field still under the footer's fade). Only Enter in the field, or
  // Trust itself, connects; an empty field is a key login ("Leave it empty…"), so it's allowed
  // there. A character typed on the box goes into the field too, so nothing typed vanishes.
  const toPassword = (typed?: string) => {
    const field = passwordField.current;
    if (!field || !card.current) return;
    field.focus({ focusVisible: true, preventScroll: true } as FocusOptions);
    if (typed !== undefined) {
      const end = field.value.length;
      field.setRangeText(typed, end, end, "end");
    }
    revealField(field);
  };
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
                // Enter on the card itself (focus lands there when its text is clicked) never
                // trusts a key: a host-key question needs Trust and connect itself (Q233), and
                // Quick Connect's needs "I've checked this key" ticked (Q236), and even then
                // Enter here goes on to the password field: only the field or Trust connects
                // (round 22). A password prompt (no key in question) still connects.
                e.preventDefault();
                if (asksPassword) connectQuick();
                else if (asksQuick) {
                  if (checkedKey) toPassword();
                  else blocked();
                }
              } else if (e.key === "Tab") {
                // The question holds focus until it's answered (round 16): Tab cycles its own
                // controls and never wanders off to the Sidebar behind it.
                const all = Array.from(
                  e.currentTarget.querySelectorAll<HTMLElement>(
                    "button, input, [href], [tabindex]:not([tabindex='-1'])",
                  ),
                ).filter((el) => !el.hasAttribute("disabled"));
                const head = all[0];
                const tail = all[all.length - 1];
                if (!head || !tail) return;
                const at = document.activeElement;
                const i = all.indexOf(at as HTMLElement);
                const next =
                  i < 0
                    ? e.shiftKey
                      ? tail
                      : head
                    : all[(i + (e.shiftKey ? -1 : 1) + all.length) % all.length];
                if (!next) return;
                e.preventDefault();
                // A control in the pinned title or footer is always in view: focusing it never
                // scrolls the card (round 20: Shift+Tab to Trust scrolled it 24 px, a line of
                // the question half under the title). Any other control scrolls just enough to
                // sit whole between the fades, to a scroll where no line is cut by the title's
                // rule or the footer's edge (round 21: Tab to `:help host-keys` left the box's
                // row half under the title); the box brings the key with it.
                next.focus({ preventScroll: true });
                const pinned =
                  next.closest(".key-actions, .connect-title") !== null;
                if (next === checkedBox.current) revealBox();
                else if (next === passwordField.current) revealField(next);
                else if (!pinned)
                  revealInCard(e.currentTarget, next, null, FADE_PX);
                else settle();
              }
            }
          : undefined
      }
      tabIndex={asking ? -1 : undefined}
      onScroll={asking ? (e) => markScroll(e.currentTarget) : undefined}
      onFocus={asking ? (e) => noteFocus(e.target) : undefined}
      onBlur={
        asking
          ? (e) => {
              if (!e.currentTarget.contains(e.relatedTarget)) noteFocus(null);
            }
          : undefined
      }
    >
      {/* The map: this Box, the edge, the Host. The edge says how far the connection has got
          (`data-phase`): part-way while ssh starts, to the Host's ring while it logs in, and the
          ring fills when the shell answers (`.leaving`). */}
      <svg
        className={`connect-map${asking ? " waiting" : ""}`}
        data-phase={phase ?? "up"}
        viewBox="0 0 72 12"
        width="136"
        height="23"
        aria-hidden="true"
      >
        {/* This Box's square about 10 px beside an 18 px Host ring (DESIGN.md), so the Host is
            the focus (round 11: an 18 px square outweighed a 27 px hairline ring). */}
        <rect
          className="connect-box"
          x="4.95"
          y="4.45"
          width="3.1"
          height="3.1"
          rx="0.6"
        />
        {/* The edge comes to the ring's gap, which faces it, and reaches the ring as it closes (owner, after round 13: every
            glyph at the gap read as a spinner): connecting is an edge arriving at an open node. */}
        {/* The route, faint and dashed, under the edge: 40% reads as part-way, not as a broken line
            (round 13). */}
        <line className="connect-route" x1="8.4" y1="6" x2="61" y2="6" />
        <line className="connect-edge" x1="8.4" y1="6" x2="61" y2="6" />
        {/* The Host's ring is open while connecting (the Sidebar's connecting node, Q216); a
            closed ring fades in over it when the shell answers, then fills for a key login. */}
        {/* One arc, its 50° gap facing the edge (on the card; the Sidebar's node keeps the logo's
            upper-right gap). A dash pattern under non-scaling-stroke drew two gaps (round 9). */}
        <path
          className="connect-host"
          d="M62.462 4.817 A2.8 2.8 0 1 1 62.462 7.183"
        />
        <circle className="connect-host-closed" cx="65" cy="6" r="2.8" />
        {fills && (
          <circle className="connect-host-fill" cx="65" cy="6" r="2.8" />
        )}
      </svg>
      <p className="connect-title">
        {/* A question is titled as one: it asks, it isn't connecting yet (round 8). */}
        {asking && !asksPassword ? (
          <>
            <span className="muted">Trust </span>
            {/* Quick Connect's host is `user@address`: the key belongs to the address (round 16). */}
            <span className="connect-name">{quick ? quick.address : host}</span>
            <span className="muted">'s host key?</span>
            {where && (
              <span className="connect-address connect-address-line">
                {where}
              </span>
            )}
          </>
        ) : (
          <>
            <span className="muted">
              {phase === null
                ? "Logged in to "
                : again
                  ? "Reconnecting to "
                  : "Connecting to "}
            </span>
            <span className="connect-name">{host}</span>
            {where && <span className="connect-address"> {where}</span>}
          </>
        )}
      </p>
      {asksPassword ? (
        <>
          <p className="key-says">
            <span className="connect-name">{host}</span>'s Login is{" "}
            <span className="connect-name">auth: prompt</span>: roster has no
            saved password for it.
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
              <input
                ref={passwordField}
                type="password"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            {canSave && (
              <label className="add-check quick-save">
                <input
                  type="checkbox"
                  checked={save}
                  onChange={(e) => setSave(e.target.checked)}
                />
                Save to vault once it logs in
              </label>
            )}
            <div className="key-actions">
              <button type="submit" className="primary" ref={trustButton}>
                Connect
              </button>
              <button type="button" onClick={() => answers.cancel()}>
                Cancel
                <span className="btn-keys" aria-hidden="true">
                  <Keys keys="Escape" />
                </span>
              </button>
            </div>
          </form>
        </>
      ) : asksQuick ? (
        <>
          {/* The Inventory question's template (round 18): the address is on the title's second
              line, so the sentence reads as the Host one does. */}
          <p className="key-says">
            {hostKey.recorded === "match"
              ? "This is the key roster recorded for this address."
              : "roster hasn't seen a key at this address before."}
          </p>
          <p className="key-print">
            <span className="key-type">{hostKey.key_type}</span>{" "}
            <span className="key-fingerprint">{hostKey.fingerprint}</span>
          </p>
          {!short && <KeyAdvice where="the machine's" help={help} />}
          <form
            className="quick-login"
            onSubmit={(e) => {
              e.preventDefault();
              if (checkedKey) connectQuick();
              else blocked();
            }}
          >
            {/* The box and, after a blocked Enter, what it needs, on one row: the words sit
                beside the box they're about, in the room the row already has, so nothing moves
                (round 19: from the footer they had said "above" from ~220 px away). */}
            {/* After a blocked Enter the row is marked as one, box and words inside one frame
                (round 20: the box's own frame sat 1–2 px outside its focus ring, in another
                colour, with the words outside it). */}
            <div
              className="quick-checked-row"
              data-nudged={(nudged && !checkedKey) || undefined}
            >
              <label className="add-check quick-checked">
                <input
                  ref={checkedBox}
                  type="checkbox"
                  checked={checkedKey}
                  onChange={(e) => {
                    setCheckedKey(e.target.checked);
                    setNudged(false);
                  }}
                  onKeyDown={(e) => {
                    // Enter on the box never submits (round 22): before the tick it says
                    // what's missing, after it it goes on to the password field.
                    if (e.key === "Enter") {
                      e.preventDefault();
                      e.stopPropagation();
                      if (checkedKey) toPassword();
                      else blocked();
                    } else if (printable(e)) {
                      // Typing on the box is typing the password: it lands in the field.
                      e.preventDefault();
                      toPassword(e.key);
                    }
                  }}
                />
                I've checked this key
              </label>
              <p className="key-nudge" role="alert">
                {nudged && !checkedKey ? "Tick it to trust and connect." : ""}
              </p>
            </div>
            {short && <KeyAdvice where="the machine's" help={help} />}
            <label className="quick-password">
              <span>
                Password for <span className="connect-name">{quick.user}</span>
              </span>
              <input
                ref={passwordField}
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-describedby={keysNote}
              />
            </label>
            <p className="muted quick-keys" id={keysNote}>
              Leave it empty to log in with this Box's keys.
            </p>
            {canSave && (
              <label className="add-check quick-save">
                <input
                  type="checkbox"
                  checked={save}
                  onChange={(e) => setSave(e.target.checked)}
                  onKeyDown={(e) => {
                    // Nor does Enter on "Save to vault" (round 22): it goes on to Trust, where ↵
                    // shows, or says what's missing before the tick.
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (!checkedKey) blocked();
                    else {
                      trustButton.current?.focus({
                        focusVisible: true,
                        preventScroll: true,
                      } as FocusOptions);
                      settle();
                    }
                  }}
                />
                Save to vault once it logs in
              </label>
            )}
            <div className="key-actions">
              <button
                type="submit"
                className={checkedKey ? "primary" : undefined}
                aria-disabled={!checkedKey || undefined}
                ref={trustButton}
              >
                Trust and connect
                {/* ↵ shows where Enter acts (round 21): here while Trust or the password field
                    has focus, dim until the tick arms it. Hidden, its room is even padding either
                    side, so neither focus nor the tick resizes the button (round 22). */}
                <span className="btn-keys" aria-hidden="true">
                  <Keys
                    keys="Enter"
                    className={`key-enter${enterOn === "trust" ? " on" : ""}${checkedKey ? "" : " key-dim"}`}
                  />
                </span>
              </button>
              <button
                type="button"
                className="key-cancel"
                onClick={() => answers.cancel()}
              >
                Cancel
                <CancelKeys enter={enterOn === "cancel"} />
              </button>
            </div>
          </form>
        </>
      ) : question ? (
        <>
          <p className="key-says">roster hasn't seen this Host's key before.</p>
          <p className="key-print">
            <span className="key-type">{hostKey.key_type}</span>{" "}
            <span className="key-fingerprint">{hostKey.fingerprint}</span>
          </p>
          <KeyAdvice where="the Host's" help={help} />
          <div className="key-actions">
            <button
              type="button"
              className="key-trust"
              ref={trustButton}
              onClick={() => answers.trust()}
            >
              {/* The question opens on Cancel, so trusting is deliberate (Q233): ↵ shows on Trust
                  only once Tab brings focus to it, on Cancel while it has focus (round 21: a dim
                  ↵ on Trust read as the default while Enter cancelled); hidden, its room is
                  even padding either side (round 22). */}
              Trust and connect
              <span className="btn-keys" aria-hidden="true">
                <Keys
                  keys="Enter"
                  className={`key-enter${enterOn === "trust" ? " on" : ""}`}
                />
              </span>
            </button>
            <button
              type="button"
              className="key-cancel"
              ref={cancelButton}
              onClick={() => answers.cancel()}
            >
              Cancel
              <CancelKeys enter={enterOn === "cancel"} />
            </button>
          </div>
          {/* The keys are on the buttons; this line only speaks while the key is recorded. */}
          <p className="connect-phase muted" aria-live="polite">
            {phase === "trusting" ? PHASE_WORDS.trusting : ""}
          </p>
        </>
      ) : (
        <p className="connect-phase muted">
          {/* As the ring closes the words say so, so the two never disagree. */}
          {/* Kept, empty, as the ring closes: the card's height never changes, so it never jumps. */}
          {phase === null ? " " : PHASE_WORDS[words]}
          {/* Not announced: a status that changed every second would talk over everything. */}
          {waiting && seconds >= 3 && (
            <span className="connect-elapsed" aria-hidden="true">
              {" "}
              · {seconds} s
            </span>
          )}
        </p>
      )}
      {/* The way out shows from the start (round 9: no moment without one); its line is kept, so nothing moves. */}
      {!asking && closeKeys && (
        <p
          className={`connect-stop key-hint${waiting ? "" : " later"}`}
          aria-hidden={!waiting}
        >
          <Keys keys={closeKeys} leader={leader} /> stops it
        </p>
      )}
    </div>
  );
}

type Exit = Extract<Tab["status"], { state: "ended" }>["exit"];

/** An ended Session's pane note, in the Sidebar row's words (round 21): "ended" for a clean exit
 * (code 0), "closed" for one closed here, and the code or the signal only when it says
 * something went wrong. */
export function endedWords(exit: Exit): string {
  if (exit.closed) return "closed";
  if (exit.code === 0) return "ended";
  return exit.code === null ? "ended (signal)" : `ended (code ${exit.code})`;
}

/** Its tone: warn for a non-zero code or a signal; none (muted) for a clean exit or a close. A
 * refused or failed Session shows its error panel instead, in the error colour. */
export function endedTone(exit: Exit): "warn" | null {
  return exit.closed || exit.code === 0 ? null : "warn";
}

/** A key that types a character into a field: one character, no shortcut modifier (AltGr's
 * characters count), not Space (which ticks a box), not mid-composition. */
function printable(e: KeyboardEvent): boolean {
  if (e.key.length !== 1 || e.key === " " || e.nativeEvent.isComposing)
    return false;
  if (e.getModifierState("AltGraph")) return true;
  return !e.ctrlKey && !e.metaKey && !e.altKey;
}

/** What the message line says when a key question is cancelled: nothing reaches roster's
 * known_hosts until Trust (`tabs.cancelKey` calls no Backend). */
export function keyCancelled(host: string): string {
  return `Didn't trust ${host}'s key; nothing was saved.`;
}

/** Cancel's keys on a key question: Esc always, and ↵ before it while Cancel has focus (Enter
 * then cancels, as the question opens; round 21). Hidden, its room is even padding either side
 * of "Cancel Esc", so focus never resizes the button (round 22). */
function CancelKeys({ enter }: { enter: boolean }) {
  return (
    <span className="btn-keys" aria-hidden="true">
      <Keys keys="Enter" className={`key-enter${enter ? " on" : ""}`} />
      <Keys keys="Escape" />
    </span>
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
    <div
      className="session-note save-offer"
      role="status"
      aria-label="Save to vault"
    >
      <span>
        <span className="connect-name">{host}</span> logged in with the password
        you typed.
      </span>
      {saveKeys && (
        <span className="muted key-hint">
          <Keys keys={saveKeys} leader={leader} />
        </span>
      )}
      <button
        type="button"
        className="reconnect primary"
        onClick={() => run("save")}
      >
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
      <div
        className="session-note fill-offer elsewhere"
        role="status"
        aria-label="Password prompt"
      >
        <span>
          {whose} password prompt: {prompt.elsewhere}. roster won't fill it.
        </span>
      </div>
    );
  }
  const to = prompt.hop?.host ?? host;
  return (
    <div
      className="session-note save-offer fill-offer"
      role="status"
      aria-label="Password prompt"
    >
      <span>
        {whose} password prompt · fill{" "}
        <span className="connect-name">{to}</span>'s from the vault
        {!prompt.marked && (
          <>
            {" "}
            <span className="muted">
              (roster can't tell whether you're still on {host}: without the
              shell's marks a nested shell can't be ruled out)
            </span>
          </>
        )}
      </span>
      {fillKeys && (
        <span className="muted key-hint">
          <Keys keys={fillKeys} leader={leader} />
        </span>
      )}
      <button
        type="button"
        className="reconnect primary"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => run("fill")}
      >
        Fill
      </button>
    </div>
  );
}

/** The key question's advice, and where to find how (round 18): `:help host-keys` says where a
 * fingerprint is read on the machine. */
function KeyAdvice({
  where,
  help,
}: {
  where: string;
  help?: ((topic: string) => void) | undefined;
}) {
  return (
    <p className="muted key-advice">
      {/* "trust it." breaks as one, so "it." never sits alone before the pointer (round 20). */}
      Compare it with {where} console or its owner before you{" "}
      <span className="nowrap">trust it.</span>
      {help && (
        <>
          {" "}
          <button
            type="button"
            className="key-help-link"
            aria-label="How to check a host key: :help host-keys"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => help("host-keys")}
          >
            :help host-keys
          </button>
        </>
      )}
    </p>
  );
}

/** The fades at the question's pinned title and footer: a line box (the advice's 17 px and the
 * says line's 19 px, with room), so a line scrolled half under either fades out whole and no
 * glyph fragment shows past it (round 20: 12 px left a sliver). styles.css says it too. */
const FADE_PX = 22;

/** Marks a question card scrolled (something under its title) and with more below its footer. */
function markScroll(c: HTMLElement) {
  c.toggleAttribute("data-scrolled", c.scrollTop > 0);
  // Text below the footer, not just more scroll (round 23: the fade lay over 7 px of padding).
  c.toggleAttribute("data-more", cardMoreBelow(c));
}

/** address:port as ssh would write it ([address]:port for IPv6). */
function endpoint({ address, port }: QuickTarget): string {
  return `${address.includes(":") ? `[${address}]` : address}:${port}`;
}

/** The shell answered: the Host's ring closes and fills (--dur-fade, 120 ms), "Logged in to …"
 * holds (--dur-hold, 220 ms) so the landing is seen, then the card fades (120 ms). The card is
 * unmounted after all three (styles.css `.connect-card.leaving`). */
const FADE_MS = 120 + 220 + 120;

export interface SessionPanesProps {
  tabs: Pick<
    Tabs,
    | "wiring"
    | "trustKey"
    | "cancelKey"
    | "connectQuick"
    | "connectPrompted"
    | "dismissSave"
  >;
  snapshot: TabsSnapshot;
  leader: string;
  terminalView: TerminalViewComponent;
  /** Shared by every terminal (options, keys, clipboard). */
  terminalEnv: TerminalEnv;
  /** The keys that reconnect an ended tab ("␣ r"), if the keymap has them. */
  reconnectKeys: string | null;
  /** The keys that close a Session ("␣ d d"): a connect that's taking long offers them. */
  closeKeys?: string | null;
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
  /** Says something on the message line (a key question cancelled, round 21). */
  say?(message: Message): void;
}

export function SessionPanes({
  tabs,
  snapshot,
  leader,
  terminalView: TerminalView,
  terminalEnv,
  reconnectKeys,
  closeKeys = null,
  run,
  errorRows,
  copy,
  addressOf,
  canSave = false,
  saveKeys = null,
  reveal = null,
  canFill = false,
  fillKeys = null,
  say,
}: SessionPanesProps) {
  const actions: ProblemActions = { run, copy };
  return (
    <div className="panes">
      {snapshot.tabs.map((tab) => {
        const active = tab.id === snapshot.active;
        const s = tab.status;
        const wiring = tabs.wiring(tab.id);
        return (
          <div
            key={tab.id}
            className="pane"
            role="group"
            aria-label={`Session ${tab.label}`}
            hidden={!active}
          >
            {s.state === "failed" ? (
              <div className="session-error">
                <ErrorPanel
                  title="Couldn't open a Session"
                  problem={s.problem}
                  rows={errorRows}
                  actions={actions}
                />
              </div>
            ) : (
              wiring && (
                <TerminalView
                  active={active}
                  leader={leader}
                  {...wiring}
                  env={terminalEnv}
                  reveal={
                    reveal?.session === tab.id
                      ? { text: reveal.text, nonce: reveal.nonce }
                      : null
                  }
                />
              )
            )}
            {isLive(s) && (
              <ConnectCard
                key={tab.attempt}
                host={tab.host}
                address={addressOf?.(tab.host) ?? null}
                phase={connectPhase(tab)}
                again={tab.attempt > 1}
                hostKey={s.state === "asking" ? s.key : null}
                answers={{
                  trust: () => tabs.trustKey(tab.id),
                  cancel: () => {
                    // Cancel on a key question closes the Session (or takes a reconnect back):
                    // it says so, and that nothing was recorded, since nothing was (round 21:
                    // it closed with no word). Calm, in the text colour.
                    const keyQuestion = s.state === "asking" && s.key !== null;
                    tabs.cancelKey(tab.id);
                    if (keyQuestion)
                      say?.(slip(keyCancelled(tab.quick?.to.address ?? tab.host)));
                  },
                  connect: (password, save) =>
                    tab.quick
                      ? tabs.connectQuick(tab.id, password, save)
                      : tabs.connectPrompted(tab.id, password, save),
                }}
                active={active}
                quick={tab.quick?.to ?? null}
                canSave={canSave}
                prompt={s.state === "password" ? s : null}
                closeKeys={closeKeys}
                leader={leader}
                fills={tab.auth !== "password"}
                help={(topic) => run(`help ${topic}`)}
              />
            )}
            {tab.save?.loggedIn &&
              tab.save.saved === null &&
              s.state === "open" && (
                <SaveOffer
                  host={tab.host}
                  saveKeys={saveKeys}
                  leader={leader}
                  run={run}
                  dismiss={() => tabs.dismissSave(tab.id)}
                />
              )}
            {canFill && tab.prompt && !tab.quick && s.state === "open" && (
              <FillOffer
                host={tab.host}
                prompt={tab.prompt}
                fillKeys={fillKeys}
                leader={leader}
                run={run}
              />
            )}
            {/* Where a nested ssh took the Session (ticket 120), said once when it changes. */}
            <span
              className="visually-hidden"
              role="status"
              aria-label="Where this Session is"
            >
              {tab.hop
                ? `Now on ${tab.hop.to}${tab.hop.known ? "" : ", not a Host roster can resolve"}`
                : ""}
            </span>
            {s.state === "ended" && s.problem && (
              <div className="session-error overlay">
                <ErrorPanel
                  title="Session ended"
                  problem={s.problem}
                  rows={errorRows}
                  actions={actions}
                />
              </div>
            )}
            {s.state === "ended" && !s.problem && (
              <div
                className="session-note ended"
                data-tone={endedTone(s.exit) ?? undefined}
              >
                <span>{endedWords(s.exit)}</span>
                {reconnectKeys && (
                  <span className="muted key-hint">
                    {" "}
                    · <Keys keys={reconnectKeys} leader={leader} /> or
                  </span>
                )}{" "}
                <button
                  type="button"
                  className="reconnect"
                  onClick={() => run("reconnect")}
                >
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
