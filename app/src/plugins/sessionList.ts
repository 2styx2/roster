// The open Sessions as the app sends them to the core (`roster.sessions.list()`, decisions Q127 and
// Q185). The whole list goes each time and replaces the last. A Session opening or ending goes at
// once, since its `session_open` or `session_exit` follows and a listener's list must agree. Only a
// folder changing (OSC 7: a `cd`, or a Host printing folders as fast as it likes) waits, a little,
// and then the last list goes (review of #426, L3).
import type { OpenSession } from "../backend/types";

/** How long a folder change waits for more before the list goes. */
export const SESSIONS_COALESCE_MS = 100;

export class SessionList {
  private readonly send: (open: OpenSession[]) => void;
  /** The list sent last, and its Sessions without their folders, as text. */
  private sent: string | null = null;
  private sentShape: string | null = null;
  private waiting: OpenSession[] | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(send: (open: OpenSession[]) => void) {
    this.send = send;
  }

  /** The Sessions open now, in the order they opened. */
  update(open: OpenSession[]) {
    const text = JSON.stringify(open);
    const shape = JSON.stringify(open.map(({ session, host }) => [session, host]));
    if (shape !== this.sentShape) return this.now(open, text, shape);
    if (text === this.sent) {
      this.cancel();
      return;
    }
    this.waiting = open;
    this.timer ??= setTimeout(() => {
      this.timer = null;
      const o = this.waiting;
      this.waiting = null;
      if (o) this.now(o, JSON.stringify(o), shape);
    }, SESSIONS_COALESCE_MS);
  }

  /** Nothing more goes (the app's Plugins stopped). */
  stop() {
    this.cancel();
  }

  private now(open: OpenSession[], text: string, shape: string) {
    this.cancel();
    if (text === this.sent) return;
    this.sent = text;
    this.sentShape = shape;
    this.send(open);
  }

  private cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.waiting = null;
  }
}
