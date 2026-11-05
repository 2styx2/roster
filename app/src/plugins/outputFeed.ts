// The Sessions' output for the Plugins granted terminal.read (ticket 79): each Session's bytes go
// through a terminal of its own (committed.ts), and the lines it commits go as `terminal_output`,
// batched, then the commands that ended as `command_done` (ticket 94), each Session's in order.
import type { PluginEventName } from "../backend/types";
import { CommittedLines, lastLines, OUTPUT_MAX, type Run as OutputRun, type ScreenSize } from "./committed";

/** How often the Sessions' output goes to the Plugins that read it. */
const OUTPUT_EVERY_MS = 200;

export interface FeedWants {
  /** Whether any running Plugin may read the Sessions' output (so it's worth decoding). */
  reads(): boolean;
  /** Whether any running Plugin hears `command_done` (#223, Q185): only then is a command's
   * output kept for it. */
  done(): boolean;
}

export class OutputFeed {
  private readonly screens = new Map<number, { host: string | null; lines: CommittedLines; done: Promise<void> }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The flush running, if any: the next waits for it (a Session's events stay in order). */
  private flushing: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly send: (name: PluginEventName, payload: Record<string, unknown>) => Promise<void>,
    private readonly wants: FeedWants,
  ) {}

  /** A Session's output, with the size of its terminal. */
  output(session: number, host: string | null, data: Uint8Array, size: ScreenSize): void {
    if (!this.wants.reads()) {
      for (const id of [...this.screens.keys()]) this.gone(id);
      return;
    }
    let s = this.screens.get(session);
    if (!s) {
      s = { host, lines: new CommittedLines(size), done: Promise.resolve() };
      this.screens.set(session, s);
    }
    s.host = host;
    // In order: a resize lands between the output before it and after it.
    const { lines } = s;
    // Asked as each output comes, so a listener added meanwhile counts from the next command.
    const wanted = this.wants.done();
    s.done = s.done.then(() => {
      lines.collectDone(wanted);
      lines.resize(size);
      return lines.write(data);
    });
    if (!this.stopped) this.timer ??= setTimeout(() => void this.flush(), OUTPUT_EVERY_MS);
  }

  /** Sends the lines committed so far (tests call it rather than wait). */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const run = this.flushing.then(() => Promise.all([...this.screens.keys()].map((id) => this.flushSession(id)))).then(() => {});
    this.flushing = run.catch(() => {});
    return run;
  }

  /** A Session that ended: what it had goes first, then its terminal. */
  async ended(session: number): Promise<void> {
    const flushed = this.flushing.then(() => this.flushSession(session));
    this.flushing = flushed.catch(() => {});
    await flushed.catch(() => {});
    this.gone(session);
  }

  /** A Session that ended takes its terminal with it. */
  gone(session: number): void {
    this.screens.get(session)?.lines.dispose();
    this.screens.delete(session);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const s of this.screens.values()) s.lines.dispose();
    this.screens.clear();
  }

  /** Sends what Session `session` committed: each run of lines of one kind as a
   * `terminal_output`, then the commands that ended in it. */
  private async flushSession(session: number): Promise<void> {
    const s = this.screens.get(session);
    if (!s) return;
    await s.done;
    const runs = s.lines.takeRuns();
    const done = s.lines.takeDone();
    // Too much at once: the last whole lines that fit, in all the runs together.
    let room = OUTPUT_MAX;
    const kept: OutputRun[] = [];
    for (let i = runs.length - 1; i >= 0 && room > 0; i--) {
      const r = runs[i] as OutputRun;
      const text = lastLines(r.text, room);
      if (text) kept.unshift({ text, kind: r.kind });
      room -= r.text.length;
    }
    for (const r of kept) await this.send("terminal_output", { session, host: s.host, text: r.text, kind: r.kind });
    for (const d of done) await this.send("command_done", { session, host: s.host, ...d });
  }
}
