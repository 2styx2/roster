// Sessions opening and ending as Plugin events (`session_open`, `session_exit`), told from one
// snapshot of the tabs to the next. Each tab's state and Host is kept (a Quick Connect Session's
// is null), so a tab closed while it ran still names its Host in `session_exit`. The Sessions
// open now go with them in the order they opened (a reconnect is a new open, so it goes last),
// with the folder each one's shell last said (OSC 7, #242): the core gives that list to
// `roster.sessions.list()` (ticket 96, decision Q127), and the cwd to terminal.read's Plugins only
// (Q185).
import type { OpenSession } from "../backend/types";
import { isLive } from "../session/status";
import type { Tab } from "../session/tabs";

export interface SessionEvent {
  name: "session_open" | "session_exit";
  /** What a Plugin hears: a Quick Connect Session's `host` is nil to it (not a Host of the Inventory). */
  payload: { session: number; host: string | null; code?: number | null };
  /** What `:tutor` hears (the tab's own host, a Quick Connect's too); null: nothing. */
  tutor: { host: string; code?: number | null } | null;
}

export class SessionEvents {
  private seen = new Map<number, { state: "live" | "ended"; host: string | null }>();
  private order = new Map<number, string | null>();

  /** The events since the last snapshot, and the Sessions open now. */
  next(tabs: readonly Tab[]): { events: SessionEvent[]; open: OpenSession[] } {
    const before = this.seen;
    const now = new Map<number, { state: "live" | "ended"; host: string | null }>();
    const events: SessionEvent[] = [];
    for (const t of tabs) {
      const ended = !isLive(t.status);
      const host = t.quick ? null : t.host;
      now.set(t.id, { state: ended ? "ended" : "live", host });
      if (!ended && before.get(t.id)?.state !== "live") {
        this.order.delete(t.id);
        this.order.set(t.id, host);
        events.push({ name: "session_open", payload: { session: t.id, host }, tutor: { host: t.host } });
      }
      if (ended && before.get(t.id)?.state === "live") {
        this.order.delete(t.id);
        const code = t.status.state === "ended" ? t.status.exit.code : null;
        events.push({ name: "session_exit", payload: { session: t.id, host, code }, tutor: { host: t.host, code } });
      }
    }
    for (const [id, was] of before) {
      if (now.has(id)) continue;
      this.order.delete(id);
      if (was.state === "live") events.push({ name: "session_exit", payload: { session: id, host: was.host, code: null }, tutor: null });
    }
    this.seen = now;
    const cwds = new Map(tabs.map((t) => [t.id, t.cwd ?? null]));
    const open = [...this.order].map(([session, host]) => ({ session, host, cwd: cwds.get(session) ?? null }));
    return { events, open };
  }
}
