import { describe, expect, it } from "vitest";
import { idleTimer } from "./idle";
import { manualClock } from "../ui/manualClock";

const MIN = 60_000;

describe("idleTimer", () => {
  it("fires once after the timeout with no input", () => {
    const clock = manualClock();
    let fired = 0;
    const idle = idleTimer({ timeoutMs: 15 * MIN, onIdle: () => fired++, clock });
    idle.start();
    clock.advance(15 * MIN - 1);
    expect(fired).toBe(0);
    clock.advance(1);
    expect(fired).toBe(1);
    clock.advance(60 * MIN);
    expect(fired).toBe(1);
  });

  it("counts the timeout from the last input", () => {
    const clock = manualClock();
    let fired = 0;
    const idle = idleTimer({ timeoutMs: 15 * MIN, onIdle: () => fired++, clock });
    idle.start();
    clock.advance(10 * MIN);
    idle.activity();
    clock.advance(10 * MIN);
    expect(fired).toBe(0);
    idle.activity();
    clock.advance(14 * MIN);
    expect(fired).toBe(0);
    clock.advance(1 * MIN);
    expect(fired).toBe(1);
  });

  it("never fires while stopped, and starts counting afresh", () => {
    const clock = manualClock();
    let fired = 0;
    const idle = idleTimer({ timeoutMs: 15 * MIN, onIdle: () => fired++, clock });
    idle.start();
    clock.advance(14 * MIN);
    idle.stop();
    clock.advance(60 * MIN);
    expect(fired).toBe(0);
    idle.start();
    clock.advance(14 * MIN);
    expect(fired).toBe(0);
    clock.advance(1 * MIN);
    expect(fired).toBe(1);
  });

  it("does nothing when activity comes in while stopped", () => {
    const clock = manualClock();
    let fired = 0;
    const idle = idleTimer({ timeoutMs: 15 * MIN, onIdle: () => fired++, clock });
    idle.activity();
    clock.advance(60 * MIN);
    expect(fired).toBe(0);
  });
});
