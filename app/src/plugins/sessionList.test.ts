// The open Sessions as the app sends them to the core for `roster.sessions.list()` (Q127, Q185):
// a Session opening or ending goes at once, before its event; a folder changing (OSC 7, which a
// Host can print as fast as it likes) is coalesced (review of #426, L3).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenSession } from "../backend/types";
import { SessionList, SESSIONS_COALESCE_MS } from "./sessionList";

describe("sending the open Sessions to the core", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const one = (cwd: string | null): OpenSession[] => [{ session: 1, host: "esx-02", cwd }];

  it("sends a new or ended Session at once, and the same list only once", () => {
    const sent: OpenSession[][] = [];
    const list = new SessionList((o) => sent.push(o));
    list.update(one(null));
    list.update(one(null));
    expect(sent).toEqual([one(null)]);
    list.update([]);
    expect(sent).toEqual([one(null), []]);
  });

  it("sends folder changes once a while, the last one", () => {
    const sent: OpenSession[][] = [];
    const list = new SessionList((o) => sent.push(o));
    list.update(one(null));
    for (let i = 0; i < 50; i++) list.update(one(`/srv/${i}`));
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(SESSIONS_COALESCE_MS);
    expect(sent).toEqual([one(null), one("/srv/49")]);
  });

  it("a Session opening while a folder change waits sends the whole list at once, and nothing after", () => {
    const sent: OpenSession[][] = [];
    const list = new SessionList((o) => sent.push(o));
    list.update(one(null));
    list.update(one("/srv/app"));
    const two: OpenSession[] = [...one("/srv/app"), { session: 2, host: null, cwd: null }];
    list.update(two);
    expect(sent).toEqual([one(null), two]);
    vi.advanceTimersByTime(SESSIONS_COALESCE_MS);
    expect(sent).toHaveLength(2);
  });

  it("sends nothing after it stops", () => {
    const sent: OpenSession[][] = [];
    const list = new SessionList((o) => sent.push(o));
    list.update(one(null));
    list.update(one("/srv/app"));
    list.stop();
    vi.advanceTimersByTime(SESSIONS_COALESCE_MS);
    expect(sent).toHaveLength(1);
  });
});
