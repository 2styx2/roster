// Fake timeouts for a UI test that must decide what happens first: a reply the fake Backend holds
// back (its `delay`), the 150 ms before `:help` says it's loading, a debounce. The test moves time
// on with `pass`, so what it checks never depends on the machine's speed. test-setup.ts puts the
// real timers back after each test.
import { act } from "@testing-library/react";
import { vi } from "vitest";

/** From here on setTimeout is the test's to move on (`pass`). The rest (setInterval, Date) stays
 * real: Testing Library's findBy* still polls. */
export function fakeTimeouts() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // Testing Library drains its updates on a setTimeout(0), which it moves on by itself only when
  // it sees Jest's fake timers: these are Vitest's, so it's told how.
  (globalThis as { jest?: unknown }).jest = { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) };
}

export function realTimeouts() {
  vi.useRealTimers();
  delete (globalThis as { jest?: unknown }).jest;
}

/** For userEvent.setup's `advanceTimers`: its pause between keys, under fake timeouts too. */
export const advanceTimers = (ms: number) => {
  if (vi.isFakeTimers()) vi.advanceTimersByTime(ms);
};

/** `ms` of the fake time pass, and what it set off has run (React's updates too). */
export const pass = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
