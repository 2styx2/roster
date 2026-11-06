// The Session commands: open one to a Host (or a Quick Connect), go to one, close it, reconnect it,
// fill its prompt, turn on its shell integration, save its typed password. session/actions.ts
// does what they ask.
import type { AppContext, CommandDef } from "../commands/table";
import { matching } from "../ui/completion";
import { BUILTIN } from "../registry";

/** What the Session commands ask of the app. */
export interface SessionContext {
  /** Opens a Session to the Host (the app checks it exists and is reviewed); `here`: in the
   * current tab if its Session has ended, else a new one. */
  connect(host: string, here?: boolean): void;
  /** Quick Connect (ticket 14): a Session to `user@address[:port]`, a box that isn't in the
   * Inventory; null opens the Picker to type one. */
  quickConnect(target: string | null): void;
  /** Goes to the Host's open Session if there is one, else opens one (as `connect`). */
  open(host: string): void;
  /** Reconnects Session `n` (1-based, going to it) if it has ended or was refused; with none, the
   * one on screen. */
  reconnect(n?: number | null): void;
  /** The Session on screen: its Host, and whether it's a Quick Connect (not on a Host); null with none. */
  sessionOnScreen(): { host: string; quick: boolean } | null;
  /** The Session `delta` places after the current one, wrapping. */
  selectRelative(delta: number): void;
  /** The Nth Session, counting from 1. */
  selectNth(n: number): void;
  /** Closes the Nth Session, or the current one. */
  close(n: number | null): void;
  /** Opens "Save to vault" for the current Session, once it logged in with a password typed for it
   * (tickets 15, 16). */
  saveSession(): void;
  /** Fills the password prompt the current Session shows from the vault (ticket 119): only when
   * one is detected; the password goes from serve to the Session's PTY through the core, never
   * through the frontend. */
  fillPrompt(): void;
  /** `:integrate` (ticket 121): sends the current Session's shell the hook line now. */
  integrate(): void;
}

type SessionCommand = CommandDef<SessionContext & AppContext>;

const command = (id: string, area: string, label: string, run: (ctx: SessionContext) => void): SessionCommand => ({
  id,
  source: BUILTIN,
  area,
  label: () => label,
  run,
});

export const sessionCommands = {
  connect: {
    id: "connect",
    source: BUILTIN,
    area: "Hosts",
    arg: "host",
    label: (h) => (h ? `Connect to ${h}` : "Open a Session to a Host, or to user@address (Quick Connect)"),
    doc:
      "Opens a new Session to the Host, in a tab of its own. A Host that isn't reviewed yet stays closed until you " +
      "review it ([:review](:review)). Anything that isn't a Host's name but reads as `user@address` or " +
      "`user@address:port` is a Quick Connect: the tab shows the box's host key for you to check, and asks for a " +
      "password (left empty, this Box's own keys log in). [:here](:here) reuses a tab whose Session has ended; " +
      "[Connection errors](errors-guide) says what to do when it doesn't connect.",
    run: (ctx, h) => ctx.connect(h ?? ""),
  },
  open: {
    // A Host (or its open Session), or a web service in the default browser (ticket 18, Q71):
    // `open HOST`, `open SERVICE` (the current Host's), `open HOST SERVICE`. A Host's name wins.
    id: "open",
    source: BUILTIN,
    area: "Hosts",
    arg: "text",
    label: (a) =>
      a
        ? a.includes(" ")
          ? `Open ${a.replace(" ", "'s ")} in the browser`
          : `Open ${a}: the Host or its Session, else the current Host's web service`
        : "Open a Host or go to its Session, or open a web service in the browser",
    run: (ctx, a) => ctx.open(a ?? ""),
    complete: (word, hostNames, ctx) => {
      const space = word.indexOf(" ");
      if (space >= 0) {
        const host = word.slice(0, space);
        return matching(ctx?.webServices?.(host) ?? [], word.slice(space + 1).trimStart()).map((s) => `${host} ${s}`);
      }
      const names = [...new Set([...(ctx?.webServices?.(null) ?? []), ...[...hostNames].sort()])];
      return matching(names, word);
    },
  },
  here: {
    id: "here",
    source: BUILTIN,
    area: "Hosts",
    arg: "host",
    // One title with the Picker's key for it (picker.chooseHere, round 20).
    label: (h) => (h ? `Connect to ${h} in this tab` : "Reopen here, if its Session ended"),
    run: (ctx, h) => ctx.connect(h ?? "", true),
  },
  quick: {
    id: "quick",
    source: BUILTIN,
    area: "Hosts",
    arg: "text",
    optionalArg: true,
    label: (t) => (t ? `Quick Connect to ${t}` : "Quick Connect: a Session to user@address[:port], not in the Inventory"),
    run: (ctx, t) => ctx.quickConnect(t ?? null),
  },
  save: command("save", "Sessions", "Save to vault: the password typed for this Session, once it logged in", (ctx) => ctx.saveSession()),
  fill: command("fill", "Sessions", "Fill a password prompt from the vault", (ctx) => ctx.fillPrompt()),
  integrate: command(
    "integrate",
    "Sessions",
    "Turn on shell integration in this Session's shell: one line that marks its prompts and says its folder",
    (ctx) => ctx.integrate(),
  ),
  reconnect: {
    id: "reconnect",
    source: BUILTIN,
    area: "Sessions",
    // A number: that Session (the Sidebar's ended rows, round 20); none: the one on screen.
    arg: "number",
    optionalArg: true,
    label: (n) => (n ? `Reconnect Session ${n}, if it has ended` : "Reconnect an ended Session"),
    run: (ctx, n) => ctx.reconnect(n === undefined ? null : Number(n)),
  },
  next: command("next", "Sessions", "Next Session", (ctx) => ctx.selectRelative(1)),
  prev: command("prev", "Sessions", "Previous Session", (ctx) => ctx.selectRelative(-1)),
  session: {
    id: "session",
    source: BUILTIN,
    area: "Sessions",
    arg: "number",
    label: (n) => `Go to Session ${n ?? "N"}`,
    run: (ctx, n) => ctx.selectNth(Number(n)),
  },
  close: {
    id: "close",
    source: BUILTIN,
    area: "Sessions",
    arg: "number",
    optionalArg: true,
    label: (n) => (n ? `Close Session ${n}` : "Close the Session"),
    run: (ctx, n) => ctx.close(n === undefined ? null : Number(n)),
  },
} satisfies Record<string, SessionCommand>;
