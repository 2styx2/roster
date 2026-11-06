// The idle lock's timer: fires `onIdle` once `timeoutMs` has passed since the last input.
//
// It lives in the frontend because every input it counts (keys, mouse, the terminal's keys later)
// arrives in the webview first; a Rust timer would need an IPC call per keystroke. Input only
// records a timestamp. One timer waits for the deadline and, when it fires, re-checks the clock:
// a late timer (a throttled or sleeping machine) still locks, and input never reschedules timers.
import { realClock, type Clock } from "../ui/clock";

export interface IdleTimer {
  /** Start counting from now. */
  start(): void;
  /** Stop counting (while locked). */
  stop(): void;
  /** There was input: the timeout counts from now. */
  activity(): void;
}

export function idleTimer({
  timeoutMs,
  onIdle,
  clock = realClock,
}: {
  timeoutMs: number;
  onIdle: () => void;
  clock?: Clock;
}): IdleTimer {
  let last = 0;
  let handle: unknown = null;

  const wait = (ms: number) => {
    handle = clock.setTimeout(check, ms);
  };
  function check() {
    handle = null;
    const left = last + timeoutMs - clock.now();
    if (left > 0) return wait(left);
    onIdle();
  }
  const stop = () => {
    if (handle !== null) clock.clearTimeout(handle);
    handle = null;
  };

  return {
    start() {
      stop();
      last = clock.now();
      wait(timeoutMs);
    },
    stop,
    activity() {
      if (handle !== null) last = clock.now();
    },
  };
}
