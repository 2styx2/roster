import { describe, expect, it, vi } from "vitest";
import { FAKE_FINGERPRINT, FAKE_HOST_PASSWORD, fakeBackend, makeHosts, type FakeScenario } from "../backend/fake";
import { QUICK_CONNECT_API_VERSION, SAVE_TO_VAULT_API_VERSION, type SessionEvents } from "../backend/types";
import { Tabs, type TabStatus } from "./tabs";

const hosts = makeHosts(12);
const reviewed = hosts.hosts.filter((h) => h.reviewed).map((h) => h.name);
const unreviewed = hosts.hosts.find((h) => !h.reviewed)!.name;

const text = (chunks: Uint8Array[]) => chunks.map((c) => new TextDecoder().decode(c)).join("");
const settle = () => new Promise((r) => setTimeout(r, 10));
/** serve's vault unlocked, as behind an unlocked lock screen (password Hosts need it). */
const unlocked = { vault: { status: "unlocked" } } as const;

/** The fake Backend, noting which Hosts' Sessions were closed. */
function recordingCloses(scenario: FakeScenario) {
  const backend = fakeBackend({ ...unlocked, ...scenario });
  const closed: string[] = [];
  const open = backend.openSession.bind(backend);
  backend.openSession = async (host, size, events) => {
    const s = await open(host, size, events);
    return { ...s, close: () => (closed.push(host), s.close()) };
  };
  return { backend, closed };
}

/** The fake Backend, but each Session's output and exit are driven by the test (per Host). */
function scriptedSessions() {
  const backend = fakeBackend({ ...unlocked, hosts });
  const events = new Map<string, SessionEvents>();
  const typed = new Map<string, string>();
  backend.openSession = async (host, _size, ev) => {
    events.set(host, ev);
    const done = async () => {};
    const write = async (data: string) => void typed.set(host, (typed.get(host) ?? "") + data);
    return { id: events.size, auth: "key", write, resize: done, close: done };
  };
  const session = (host: string) => {
    const ev = events.get(host);
    if (!ev) throw new Error(`no Session to ${host}`);
    return {
      print: (s: string | Uint8Array) => ev.output(typeof s === "string" ? new TextEncoder().encode(s) : s),
      exit: (code: number) => ev.exit({ code, closed: false }),
    };
  };
  return { backend, session, typed };
}

const problemOf = (status: TabStatus | undefined) => (status?.state === "ended" ? status.problem : undefined);

/** Store plus a way to see a tab's terminal output. */
function setup() {
  const tabs = new Tabs(fakeBackend({ ...unlocked, hosts }));
  const screens = new Map<number, Uint8Array[]>();
  const attach = (id: number) => {
    const seen: Uint8Array[] = [];
    screens.set(id, seen);
    return tabs.attach(id, (d) => seen.push(d));
  };
  const screen = (id: number) => text(screens.get(id) ?? []);
  return { tabs, attach, screen };
}

describe("reaching a shell (issue #78, item 1)", () => {
  it("says the Session reached a shell only once it prints, and starts over on reconnect", async () => {
    const { backend, session } = scriptedSessions();
    const tabs = new Tabs(backend);
    const id = tabs.open(reviewed[0]!);
    const tab = () => tabs.snapshot().tabs[0]!;
    expect(tab()).toMatchObject({ status: { state: "connecting" }, shell: false });
    await settle();
    // ssh is running, but still logging in: nothing on screen yet.
    expect(tab()).toMatchObject({ status: { state: "open" }, shell: false });
    session(reviewed[0]!).print("Last login: today\r\n$ ");
    expect(tab().shell).toBe(true);
    session(reviewed[0]!).exit(0);
    expect(tabs.reconnect(id)).toBe(true);
    expect(tab()).toMatchObject({ status: { state: "connecting" }, shell: false });
  });
});

describe("Tabs", () => {
  it("opens a Session in a new active tab and shows its output", async () => {
    const { tabs, attach, screen } = setup();
    const id = tabs.open(reviewed[0]!);
    expect(tabs.snapshot().active).toBe(id);
    expect(tabs.snapshot().tabs[0]).toMatchObject({ id, host: reviewed[0], status: { state: "connecting" } });
    attach(id);
    await settle();
    expect(tabs.snapshot().tabs[0]!.status).toEqual({ state: "open" });
    expect(screen(id)).toContain(`Connected to ${reviewed[0]}`);
  });

  it("sends keystrokes, Esc included, to the Session", async () => {
    const { tabs, attach, screen } = setup();
    const id = tabs.open(reviewed[0]!);
    attach(id);
    await settle();
    tabs.write(id, "vim\x1b");
    expect(screen(id)).toContain("vim^[");
  });

  it("keeps keys typed before the Session finished opening (ConPTY's ESC[6n answer)", async () => {
    const { tabs, attach, screen } = setup();
    const id = tabs.open(reviewed[0]!);
    attach(id);
    tabs.write(id, "\x1b[1;1R");
    await settle();
    expect(screen(id)).toContain("^[[1;1R");
  });

  it("replays earlier output to a terminal that attaches again", async () => {
    const { tabs, attach, screen } = setup();
    const id = tabs.open(reviewed[0]!);
    attach(id)();
    await settle();
    tabs.write(id, "ls");
    attach(id);
    expect(screen(id)).toMatch(/Connected to .*ls$/s);
  });

  it("shows roster's refusal in the tab, with its code", async () => {
    const { tabs } = setup();
    tabs.open(unreviewed);
    await settle();
    expect(tabs.snapshot().tabs[0]!.status).toMatchObject({
      state: "failed",
      code: 20,
      message: `${unreviewed} is not reviewed yet (reviewed: false in roster.yml) - not logging in`,
    });
  });

  it("keeps a refusal's code, fix and data as the tab's Problem", async () => {
    const host = reviewed[0]!;
    const message = `no vault item named '${host} shh' (ssh Login of ${host}) - did you mean: '${host} ssh'`;
    const fix = `fix the name in ${host}'s auth: in roster.yml, or rename the item in the vault`;
    const tabs = new Tabs(
      fakeBackend({ ...unlocked, hosts, refusals: { [host]: { code: 32, message, data: { fix, near: [`${host} ssh`] } } } }),
    );
    tabs.open(host);
    await settle();
    const status = tabs.snapshot().tabs[0]!.status;
    expect(status.state === "failed" && status.problem).toEqual({
      code: 32,
      host,
      message,
      fix,
      details: `[32] ${message}`,
      data: { near: [`${host} ssh`] },
    });
  });

  it("classifies ssh's failure from the tab's last output when it exits 255", async () => {
    const host = reviewed[0]!;
    const tabs = new Tabs(
      fakeBackend({
        ...unlocked,
        hosts,
        sshFailures: { [host]: "\x1b[0mssh: connect to host 10.0.0.6 port 2222: Connection refused\r\n" },
      }),
    );
    tabs.open(host);
    await settle();
    const status = tabs.snapshot().tabs[0]!.status;
    expect(status).toMatchObject({ state: "ended", exit: { code: 255 } });
    expect(status.state === "ended" && status.problem).toMatchObject({
      code: 41,
      host,
      message: `${host} (10.0.0.6:2222) refused the connection`,
      details: "ssh: connect to host 10.0.0.6 port 2222: Connection refused",
    });
  });

  it("looks only at the latest attempt's output when classifying", async () => {
    const host = hosts.hosts.find((h) => h.reviewed && h.enroll)!.name;
    const scenario: FakeScenario = {
      ...unlocked,
      hosts,
      sshFailures: { [host]: "ssh: Could not resolve hostname x.lab: Name or service not known\r\n" },
    };
    const tabs = new Tabs(fakeBackend(scenario));
    const id = tabs.open(host);
    // Wait for each attempt's own end, not a fixed time: on a loaded runner a 10 ms sleep can
    // run out before the first attempt has ended, and then reconnect() rightly does nothing
    // (issue #76: the tab then ends with the first attempt's 40).
    const ended = () => vi.waitFor(() => expect(tabs.snapshot().tabs[0]!.status.state).toBe("ended"));
    await ended();
    scenario.sshFailures = { [host]: "admin@x: Permission denied (publickey).\r\n" };
    expect(tabs.reconnect(id)).toBe(true);
    await ended();
    const status = tabs.snapshot().tabs[0]!.status;
    expect(status.state === "ended" && status.problem?.code).toBe(46);
  });

  it("never lets an earlier attempt's late output or exit reach the reconnect (issue #76)", async () => {
    const backend = fakeBackend({ ...unlocked, hosts });
    const attempts: SessionEvents[] = [];
    backend.openSession = async (_host, _size, ev) => {
      attempts.push(ev);
      const done = async () => {};
      return { id: attempts.length, auth: "key", write: done, resize: done, close: done };
    };
    const print = (ev: SessionEvents, s: string) => ev.output(new TextEncoder().encode(s));
    const tabs = new Tabs(backend);
    const id = tabs.open(reviewed[0]!);
    await vi.waitFor(() => expect(attempts).toHaveLength(1));
    const [first] = attempts;
    print(first!, "ssh: Could not resolve hostname x.lab: Name or service not known\r\n");
    first!.exit({ code: 255, closed: false });
    expect(tabs.reconnect(id)).toBe(true);
    await vi.waitFor(() => expect(attempts).toHaveLength(2));
    // The first attempt speaks again, after the reconnect: none of it may count.
    print(first!, "ssh: Could not resolve hostname x.lab: Name or service not known\r\n");
    first!.exit({ code: 255, closed: false });
    expect(tabs.snapshot().tabs[0]!.status.state).not.toBe("ended");
    print(attempts[1]!, "admin@x: Permission denied (publickey).\r\n");
    attempts[1]!.exit({ code: 255, closed: false });
    expect(problemOf(tabs.snapshot().tabs[0]!.status)).toMatchObject({ code: 46, details: "admin@x: Permission denied (publickey)." });
  });

  it("decodes each tab's output on its own, even with a character split across chunks", async () => {
    const { backend, session } = scriptedSessions();
    const tabs = new Tabs(backend);
    const [a, b] = [reviewed[0]!, reviewed[1]!];
    tabs.open(a);
    tabs.open(b);
    await settle();
    const arrow = new TextEncoder().encode("→"); // 3 bytes
    session(a).print("ssh: connect to host 10.0.0.6 port 22: Connection refused ");
    session(a).print(arrow.slice(0, 2));
    session(b).print("ssh: connect to host 10.0.0.7 port 22: Connection refused\r\n");
    session(a).print(arrow.slice(2));
    session(a).print("\r\n");
    session(a).exit(255);
    session(b).exit(255);
    await settle();
    const [ta, tb] = tabs.snapshot().tabs;
    expect(problemOf(ta?.status)?.details).toBe("ssh: connect to host 10.0.0.6 port 22: Connection refused →");
    expect(problemOf(tb?.status)?.details).toBe("ssh: connect to host 10.0.0.7 port 22: Connection refused");
  });

  describe("classifies only what ssh printed before the login (the pre-auth window)", () => {
    /** A clock the test moves. */
    function clock() {
      let t = 1_000_000;
      return { now: () => t, advance: (ms: number) => void (t += ms) };
    }
    const CHANGED_KEY = [
      "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
      "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @",
      "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
      "Host key verification failed.",
      "",
    ].join("\r\n");

    it("still classifies ssh's own failure inside the window", async () => {
      const { backend, session } = scriptedSessions();
      const c = clock();
      const tabs = new Tabs(backend, { now: c.now });
      const host = reviewed[0]!;
      tabs.open(host);
      await settle();
      c.advance(9_000); // ConnectTimeout is 10 s
      session(host).print(CHANGED_KEY);
      session(host).exit(255);
      await settle();
      expect(problemOf(tabs.snapshot().tabs[0]?.status)?.code).toBe(43);
    });

    it("a nested ssh failing on the Host, then the Session ending 255, is a dropped Session (row 20)", async () => {
      const { backend, session } = scriptedSessions();
      const c = clock();
      const tabs = new Tabs(backend, { now: c.now });
      const host = reviewed[0]!;
      tabs.open(host);
      await settle();
      session(host).print("Last login: Tue Oct 28 09:12:01 2026\r\nadmin@web-1:~$ ");
      c.advance(60_000);
      session(host).print("ssh other\r\n");
      session(host).print(CHANGED_KEY);
      session(host).print("admin@other: Permission denied (publickey,password).\r\nadmin@web-1:~$ exit\r\n");
      session(host).exit(255);
      await settle();
      const problem = problemOf(tabs.snapshot().tabs[0]?.status);
      expect(problem?.code).toBe("dropped");
      expect(problem?.message).toContain(host);
    });

    it("ignores a `roster askpass:` line the Host prints after the window", async () => {
      const { backend, session } = scriptedSessions();
      const c = clock();
      const tabs = new Tabs(backend, { now: c.now });
      const host = reviewed[0]!;
      tabs.open(host);
      await settle();
      session(host).print("admin@web-1:~$ ");
      c.advance(45_000);
      session(host).print("roster askpass: [32] no vault item named 'x' - did you mean: 'evil'\r\n");
      session(host).exit(255);
      await settle();
      expect(problemOf(tabs.snapshot().tabs[0]?.status)?.code).toBe("dropped");
    });

    it("closes the window after a few KB of output, even quickly", async () => {
      const { backend, session } = scriptedSessions();
      const tabs = new Tabs(backend, { now: clock().now });
      const host = reviewed[0]!;
      tabs.open(host);
      await settle();
      for (let i = 0; i < 120; i++) session(host).print(`line ${i} ${"y".repeat(70)}\r\n`);
      session(host).print("roster askpass: [11] Bitwarden unlock failed\r\n");
      session(host).exit(255);
      await settle();
      expect(problemOf(tabs.snapshot().tabs[0]?.status)?.code).toBe("dropped");
    });

    it("keeps ssh's last lines when the connection drops after the window", async () => {
      const { backend, session } = scriptedSessions();
      const c = clock();
      const tabs = new Tabs(backend, { now: c.now });
      const host = reviewed[0]!;
      tabs.open(host);
      await settle();
      session(host).print("admin@web-1:~$ ");
      c.advance(600_000);
      session(host).print("Timeout, server 10.0.0.6 not responding.\r\n");
      session(host).exit(255);
      await settle();
      const problem = problemOf(tabs.snapshot().tabs[0]?.status);
      expect(problem).toMatchObject({ code: "dropped", message: `${host} stopped answering, so ssh ended the Session` });
      expect(problem?.details).toContain("Timeout, server 10.0.0.6 not responding.");
    });

    it("a normal exit after the window is no Problem", async () => {
      const { backend, session } = scriptedSessions();
      const c = clock();
      const tabs = new Tabs(backend, { now: c.now });
      const host = reviewed[0]!;
      tabs.open(host);
      await settle();
      c.advance(60_000);
      session(host).print("logout\r\n");
      session(host).exit(0);
      await settle();
      expect(problemOf(tabs.snapshot().tabs[0]?.status)).toBeNull();
    });
  });

  it("marks the tab ended with the exit code when the Session ends", async () => {
    const { tabs, attach } = setup();
    const id = tabs.open(reviewed[0]!);
    attach(id);
    await settle();
    tabs.write(id, "exit\r");
    await settle();
    expect(tabs.snapshot().tabs[0]!.status).toEqual({ state: "ended", exit: { code: 0, closed: false }, problem: null });
  });

  it("closing a tab ends its Session and activates a neighbour", async () => {
    const { backend, closed } = recordingCloses({ hosts });
    const tabs = new Tabs(backend);
    const a = tabs.open(reviewed[0]!);
    const b = tabs.open(reviewed[1]!);
    const c = tabs.open(reviewed[2]!);
    await settle();
    tabs.select(b);
    tabs.close(b);
    expect(closed).toEqual([reviewed[1]]);
    expect(tabs.snapshot().tabs.map((t) => t.id)).toEqual([a, c]);
    expect(tabs.snapshot().active).toBe(c);
    tabs.close(c);
    tabs.close(a);
    expect(tabs.snapshot()).toEqual({ tabs: [], active: null, previous: null });
  });

  it("closes a Session that finishes opening after its tab was closed", async () => {
    const { backend, closed } = recordingCloses({ hosts, delay: 5 });
    const tabs = new Tabs(backend);
    tabs.close(tabs.open(reviewed[0]!));
    expect(closed).toEqual([]);
    await settle();
    expect(closed).toEqual([reviewed[0]]);
  });

  it("tells the Session the terminal's size once it's open", async () => {
    const { tabs, attach, screen } = setup();
    const id = tabs.open(reviewed[0]!);
    attach(id);
    tabs.resize(id, { cols: 132, rows: 43 });
    // The fake shell answers after a few chained timers; wait for its line rather than a fixed
    // sleep, which was too short under load.
    await vi.waitFor(() => expect(screen(id)).toContain("[resized to 132x43]"));
    // and the next tab starts at that size
    const next = tabs.open(reviewed[1]!);
    attach(next);
    await vi.waitFor(() => expect(screen(next)).toContain("(fake, 132x43)"));
  });

  it("reconnects an ended tab in place, under the old output, through session.prepare again", async () => {
    const backend = fakeBackend({ ...unlocked, hosts });
    const opened: string[] = [];
    const open = backend.openSession.bind(backend);
    backend.openSession = (host, size, events) => (opened.push(host), open(host, size, events));
    const tabs = new Tabs(backend);
    const id = tabs.open(reviewed[0]!);
    const seen: Uint8Array[] = [];
    tabs.attach(id, (d) => seen.push(d));
    await settle();
    tabs.write(id, "exit\r");
    await settle();
    expect(tabs.reconnect(id)).toBe(true);
    expect(tabs.snapshot().tabs).toEqual([expect.objectContaining({ id, status: { state: "connecting" } })]);
    await settle();
    expect(tabs.snapshot().tabs[0]!.status).toEqual({ state: "open" });
    expect(opened).toEqual([reviewed[0], reviewed[0]]);
    expect(text(seen)).toMatch(/exit\r\n.*reconnecting.*Connected to/s);
    tabs.write(id, "ls");
    expect(text(seen)).toMatch(/ls$/);
  });

  it("retries a tab roster refused, once the problem is fixed", async () => {
    const scenario: FakeScenario = { ...unlocked, hosts, sessionRefusal: { code: 21, message: "run roster sync" } };
    const tabs = new Tabs(fakeBackend(scenario));
    const id = tabs.open(reviewed[0]!);
    await settle();
    expect(tabs.snapshot().tabs[0]!.status.state).toBe("failed");
    delete scenario.sessionRefusal;
    expect(tabs.reconnect(id)).toBe(true);
    await settle();
    expect(tabs.snapshot().tabs[0]!.status).toEqual({ state: "open" });
  });

  it("leaves a tab that's still connecting or open alone", async () => {
    const { backend, closed } = recordingCloses({ hosts });
    const tabs = new Tabs(backend);
    const id = tabs.open(reviewed[0]!);
    expect(tabs.reconnect(id)).toBe(false);
    await settle();
    expect(tabs.reconnect(id)).toBe(false);
    expect(tabs.snapshot().tabs[0]!.status).toEqual({ state: "open" });
    expect(closed).toEqual([]);
  });

  it("can reconnect an ended tab to another Host (the Picker's open-here key)", async () => {
    const { tabs, attach, screen } = setup();
    const id = tabs.open(reviewed[0]!);
    attach(id);
    await settle();
    tabs.write(id, "exit\r");
    await settle();
    tabs.reconnect(id, reviewed[1]!);
    await settle();
    expect(tabs.snapshot().tabs).toEqual([expect.objectContaining({ id, host: reviewed[1], status: { state: "open" } })]);
    expect(screen(id)).toContain(`Connected to ${reviewed[1]}`);
  });

  it("holds several Sessions to the same Host, told apart by their labels", async () => {
    const { tabs } = setup();
    const a = tabs.open(reviewed[0]!);
    const b = tabs.open(reviewed[0]!);
    tabs.open(reviewed[1]!);
    await settle();
    expect(tabs.snapshot().tabs.map((t) => [t.label, t.status.state])).toEqual([
      [reviewed[0], "open"],
      [`${reviewed[0]} (2)`, "open"],
      [reviewed[1], "open"],
    ]);
    tabs.close(a);
    const c = tabs.open(reviewed[0]!);
    expect(tabs.snapshot().tabs.find((t) => t.id === c)!.label).toBe(reviewed[0]);
    expect(tabs.snapshot().tabs.find((t) => t.id === b)!.label).toBe(`${reviewed[0]} (2)`);
  });
});

describe("Tabs selection by order (ticket 07)", () => {
  function three() {
    const tabs = new Tabs(fakeBackend({ hosts }));
    const ids = reviewed.slice(0, 3).map((h) => tabs.open(h));
    return { tabs, ids, active: () => tabs.snapshot().active };
  }

  it("moves to the next and previous tab, wrapping around", () => {
    const { tabs, ids, active } = three();
    expect(active()).toBe(ids[2]);
    tabs.selectRelative(1);
    expect(active()).toBe(ids[0]);
    tabs.selectRelative(-1);
    expect(active()).toBe(ids[2]);
    tabs.selectRelative(-1);
    expect(active()).toBe(ids[1]);
  });

  it("goes to the Nth tab, counting from 1, and ignores a number past the end", () => {
    const { tabs, ids, active } = three();
    tabs.selectNth(1);
    expect(active()).toBe(ids[0]);
    tabs.selectNth(9);
    expect(active()).toBe(ids[0]);
  });

  it("remembers the previous Session (the session bar's `-`), forgetting a closed one", () => {
    const { tabs, ids } = three();
    const previous = () => tabs.snapshot().previous;
    expect(previous()).toBe(ids[1]);
    tabs.selectNth(1);
    expect(previous()).toBe(ids[2]);
    tabs.selectNth(1);
    expect(previous()).toBe(ids[2]);
    tabs.close(ids[2]!);
    expect(previous()).toBeNull();
  });

  it("does nothing with no tabs", () => {
    const tabs = new Tabs(fakeBackend({ hosts }));
    tabs.selectRelative(1);
    tabs.selectNth(1);
    expect(tabs.snapshot().active).toBeNull();
  });
});

describe("a Host whose host key roster hasn't seen (ticket 36, decision Q60)", () => {
  const host = reviewed[0]!;
  const h = hosts.hosts.find((x) => x.name === host)!;
  /** The fake Backend with `host`'s key unrecorded, counting the Sessions that really started. */
  function unknownKey(extra: Partial<FakeScenario> = {}) {
    const scenario: FakeScenario = { ...unlocked, hosts, unknownKeys: { [host]: {} }, ...extra };
    const backend = fakeBackend(scenario);
    const started: string[] = [];
    const trusted: string[] = [];
    const open = backend.openSession.bind(backend);
    backend.openSession = async (name, size, events) => {
      const s = await open(name, size, events);
      started.push(name);
      return s;
    };
    const trust = backend.trustHostKey.bind(backend);
    backend.trustHostKey = (name, fp) => (trusted.push(`${name} ${fp}`), trust(name, fp));
    return { tabs: new Tabs(backend), started, trusted, scenario };
  }
  const status = (tabs: Tabs) => tabs.snapshot().tabs[0]?.status;
  const asked = (tabs: Tabs) =>
    vi.waitFor(() => {
      const s = status(tabs);
      if (s?.state !== "asking" || !s.key) throw new Error(`not asking yet: ${JSON.stringify(s)}`);
      return s;
    });

  it("asks first, showing the key, and connects nothing until the answer", async () => {
    const { tabs, started, trusted } = unknownKey();
    tabs.open(host);
    const s = await asked(tabs);
    expect(s).toEqual({
      state: "asking",
      trusting: false,
      key: { host, address: h.ip, port: 22, key_type: "ssh-ed25519", fingerprint: FAKE_FINGERPRINT, recorded: "none" },
    });
    expect(started).toEqual([]);
    expect(trusted).toEqual([]);
  });

  it("records the key on trust and connects; the next Session doesn't ask", async () => {
    const { tabs, started, trusted } = unknownKey();
    const id = tabs.open(host);
    await asked(tabs);
    tabs.trustKey(id);
    expect(status(tabs)).toMatchObject({ state: "asking", trusting: true });
    await vi.waitFor(() => expect(status(tabs)).toEqual({ state: "open" }));
    expect(trusted).toEqual([`${host} ${FAKE_FINGERPRINT}`]);
    expect(started).toEqual([host]);
    tabs.open(host);
    await vi.waitFor(() => expect(tabs.snapshot().tabs[1]?.status).toEqual({ state: "open" }));
    expect(trusted).toHaveLength(1);
  });

  it("records nothing and leaves no Session on cancel", async () => {
    const { tabs, started, trusted } = unknownKey();
    const id = tabs.open(host);
    await asked(tabs);
    tabs.cancelKey(id);
    expect(tabs.snapshot().tabs).toEqual([]);
    expect(started).toEqual([]);
    expect(trusted).toEqual([]);
    tabs.open(host);
    await asked(tabs); // nothing was recorded, so it asks again
  });

  it("puts a reconnected tab back as it was on cancel", async () => {
    const { tabs, started, scenario } = unknownKey({ unknownKeys: {} });
    const id = tabs.open(host);
    await vi.waitFor(() => expect(status(tabs)).toEqual({ state: "open" }));
    tabs.write(id, "exit\r");
    await vi.waitFor(() => expect(status(tabs)?.state).toBe("ended"));
    const before = tabs.snapshot().tabs[0];
    scenario.unknownKeys = { [host]: {} }; // say its key was taken out of roster's known hosts since
    expect(tabs.reconnect(id)).toBe(true);
    await asked(tabs);
    tabs.cancelKey(id);
    expect(tabs.snapshot().tabs).toEqual([before]);
    expect(started).toEqual([host]);
  });

  it("refuses a key that changed between the question and the trust", async () => {
    const { tabs, started } = unknownKey({ unknownKeys: { [host]: { changesOnTrust: true } } });
    const id = tabs.open(host);
    await asked(tabs);
    tabs.trustKey(id);
    await vi.waitFor(() => expect(status(tabs)?.state).toBe("failed"));
    const s = status(tabs);
    expect(s?.state === "failed" && s.problem).toMatchObject({ code: 23, host });
    expect(started).toEqual([]);
  });

  it("says why when the key can't be fetched", async () => {
    const { tabs, started } = unknownKey({ unknownKeys: { [host]: { unreachable: true } } });
    tabs.open(host);
    await vi.waitFor(() => expect(status(tabs)?.state).toBe("failed"));
    const s = status(tabs);
    expect(s?.state === "failed" && s.problem).toMatchObject({ code: 42, host });
    expect(started).toEqual([]);
  });

  it("never asks about a key that differs from the recorded one: ssh refuses it", async () => {
    // roster had no key when session.prepare looked, but one (another) is recorded by the time the
    // key is fetched: the Session starts again and strict checking decides (Q44).
    const { tabs, trusted } = unknownKey({ unknownKeys: { [host]: { recordedAs: "changed" } } });
    tabs.open(host);
    await vi.waitFor(() => expect(status(tabs)?.state).toBe("ended"));
    const s = status(tabs);
    expect(s?.state === "ended" && s.problem?.code).toBe(43);
    expect(trusted).toEqual([]);
  });

  it("asks at most once per attempt, even if roster keeps saying it has no key", async () => {
    const { tabs, started } = unknownKey({ unknownKeys: { [host]: { recordedAs: "match" } } });
    tabs.open(host);
    await vi.waitFor(() => expect(status(tabs)?.state).toBe("failed"));
    const s = status(tabs);
    expect(s?.state === "failed" && s.code).toBe(44);
    expect(started).toEqual([]);
  });

  it("doesn't ask through a roster older than API 11: roster's 44 is then a refusal", async () => {
    const { tabs, trusted } = unknownKey();
    tabs.setAsksAboutKeys(false);
    tabs.open(host);
    await vi.waitFor(() => expect(status(tabs)?.state).toBe("failed"));
    const s = status(tabs);
    expect(s?.state === "failed" && s.code).toBe(44);
    expect(trusted).toEqual([]);
  });

  it("drops keys typed while it asks", async () => {
    const { tabs } = unknownKey();
    const id = tabs.open(host);
    await asked(tabs);
    tabs.write(id, "y\r");
    tabs.trustKey(id);
    await vi.waitFor(() => expect(status(tabs)).toEqual({ state: "open" }));
    const seen: Uint8Array[] = [];
    tabs.attach(id, (d) => seen.push(d));
    expect(text(seen)).not.toContain("y");
  });
});

describe("Quick Connect (ticket 14)", () => {
  const to = { user: "root", address: "10.0.0.5", port: 22 };
  const PASSWORD = FAKE_HOST_PASSWORD;
  function quick(extra: Partial<FakeScenario> = {}) {
    const backend = fakeBackend({ ...unlocked, hosts, apiVersion: QUICK_CONNECT_API_VERSION, ...extra });
    return { backend, tabs: new Tabs(backend) };
  }
  const status = (tabs: Tabs) => tabs.snapshot().tabs[0]?.status;
  const asked = (tabs: Tabs) =>
    vi.waitFor(() => {
      const s = status(tabs);
      if (s?.state !== "asking" || !s.key) throw new Error(`not asking yet: ${JSON.stringify(s)}`);
      return s;
    });

  it("opens a tab for user@address that shows the box's key first and connects nothing", async () => {
    const { backend, tabs } = quick();
    tabs.openQuick(to);
    const tab = tabs.snapshot().tabs[0]!;
    expect(tab).toMatchObject({ host: "root@10.0.0.5", label: "root@10.0.0.5", quick: { to, id: null } });
    const s = await asked(tabs);
    expect(s.key).toEqual({ host: "root@10.0.0.5", address: "10.0.0.5", port: 22, key_type: "ssh-ed25519", fingerprint: FAKE_FINGERPRINT, recorded: "none" });
    expect(backend.quickConnects()).toEqual([]);
  });

  it("connects with the typed password and the key the user saw, and keeps neither in the tab", async () => {
    const { backend, tabs } = quick();
    const id = tabs.openQuick(to);
    await asked(tabs);
    tabs.connectQuick(id, PASSWORD);
    expect(status(tabs)).toEqual({ state: "connecting" });
    await vi.waitFor(() => expect(status(tabs)).toEqual({ state: "open" }));
    expect(backend.quickConnects()).toEqual([{ ...to, fingerprint: FAKE_FINGERPRINT, password: true }]);
    const tab = tabs.snapshot().tabs[0]!;
    expect(tab).toMatchObject({ auth: "password", quick: { to, id: "q1" } });
    expect(JSON.stringify(tabs.snapshot())).not.toContain(PASSWORD);
  });

  it("its output reaches the Plugins' tap with no Host: it isn't one in the Inventory", async () => {
    const { tabs } = quick();
    const hostsSeen = new Set<string | null>();
    tabs.setOutputTap({ output: (_id, host) => void hostsSeen.add(host), resized: () => {} });
    const id = tabs.openQuick(to);
    await asked(tabs);
    tabs.connectQuick(id, PASSWORD);
    await vi.waitFor(() => expect(status(tabs)).toEqual({ state: "open" }));
    await vi.waitFor(() => expect(hostsSeen.size).toBeGreaterThan(0));
    expect([...hostsSeen]).toEqual([null]);
  });

  it("logs in with this Box's keys when the password is left empty", async () => {
    const { backend, tabs } = quick();
    const id = tabs.openQuick(to);
    await asked(tabs);
    tabs.connectQuick(id, "");
    await vi.waitFor(() => expect(status(tabs)).toEqual({ state: "open" }));
    expect(backend.quickConnects()[0]!.password).toBe(false);
    expect(tabs.snapshot().tabs[0]!.auth).toBe("key");
  });

  it("ends with the box's refusal on a wrong password", async () => {
    const { tabs } = quick();
    const id = tabs.openQuick(to);
    await asked(tabs);
    tabs.connectQuick(id, "nope");
    await vi.waitFor(() => expect(status(tabs)?.state).toBe("ended"));
    expect(problemOf(status(tabs))).toMatchObject({ host: "root@10.0.0.5" });
  });

  it("records nothing and closes the tab on cancel", async () => {
    const { backend, tabs } = quick();
    const id = tabs.openQuick(to);
    await asked(tabs);
    tabs.cancelKey(id);
    expect(tabs.snapshot().tabs).toEqual([]);
    expect(backend.quickConnects()).toEqual([]);
  });

  it("never asks about a key that differs from the one roster recorded for the address", async () => {
    const { backend, tabs } = quick({ scanKeys: { "10.0.0.5": { recorded: "changed" } } });
    tabs.openQuick(to);
    await vi.waitFor(() => expect(status(tabs)?.state).toBe("failed"));
    const s = status(tabs);
    expect(s?.state === "failed" && s.code).toBe(43);
    expect(backend.quickConnects()).toEqual([]);
  });

  it("refuses a key that changed between the question and the connect", async () => {
    const { tabs } = quick({ quickBoxes: { "10.0.0.5": { changesOnConnect: true } } });
    const id = tabs.openQuick(to);
    await asked(tabs);
    tabs.connectQuick(id, PASSWORD);
    await vi.waitFor(() => expect(status(tabs)?.state).toBe("failed"));
    const s = status(tabs);
    expect(s?.state === "failed" && s.problem).toMatchObject({ code: 23, host: "root@10.0.0.5" });
  });

  it("says why when the box doesn't answer", async () => {
    const { tabs } = quick({ quickBoxes: { "10.0.0.5": { unreachable: true } } });
    tabs.openQuick(to);
    await vi.waitFor(() => expect(status(tabs)?.state).toBe("failed"));
    const s = status(tabs);
    expect(s?.state === "failed" && s.code).toBe(42);
  });

  it("asks again, key and password, on a reconnect", async () => {
    const { backend, tabs } = quick();
    const id = tabs.openQuick(to);
    await asked(tabs);
    tabs.connectQuick(id, PASSWORD);
    await vi.waitFor(() => expect(status(tabs)).toEqual({ state: "open" }));
    tabs.write(id, "exit\r");
    await vi.waitFor(() => expect(status(tabs)?.state).toBe("ended"));
    expect(tabs.reconnect(id)).toBe(true);
    await asked(tabs);
    expect(backend.quickConnects()).toHaveLength(1);
    expect(tabs.snapshot().tabs[0]!.quick).toEqual({ to, id: null });
  });
});

describe('"Save to vault" on Quick Connect (ticket 15)', () => {
  const to = { user: "root", address: "10.0.0.5", port: 22 };
  function saving(extra: Partial<FakeScenario> = {}) {
    const backend = fakeBackend({
      ...unlocked,
      hosts,
      apiVersion: SAVE_TO_VAULT_API_VERSION,
      quickBoxes: { "10.0.0.5": { hostname: "nas-01" } },
      ...extra,
    });
    return { backend, tabs: new Tabs(backend) };
  }
  const tab = (tabs: Tabs) => tabs.snapshot().tabs[0]!;
  async function connected(tabs: Tabs, password = FAKE_HOST_PASSWORD, save = true) {
    const id = tabs.openQuick(to);
    await vi.waitFor(() => {
      const s = tab(tabs).status;
      if (s.state !== "asking" || !s.key) throw new Error("not asking yet");
    });
    tabs.connectQuick(id, password, save);
    return id;
  }

  it("asks serve to hold the password, and offers the save once the Session logged in with it", async () => {
    const { backend, tabs } = saving();
    await connected(tabs);
    await vi.waitFor(() => expect(tab(tabs).save).toMatchObject({ held: "q1", loggedIn: true }));
    expect(backend.held()).toEqual(["q1"]);
    // the box's own name, from the window title its shell set after the login
    await vi.waitFor(() => expect(tab(tabs).save?.hostname).toBe("nas-01"));
    expect(JSON.stringify(tabs.snapshot())).not.toContain(FAKE_HOST_PASSWORD);
  });

  it("holds nothing without the tick", async () => {
    const { backend, tabs } = saving();
    await connected(tabs, FAKE_HOST_PASSWORD, false);
    await vi.waitFor(() => expect(tab(tabs).status.state).toBe("open"));
    expect(tab(tabs).save).toBeNull();
    expect(backend.held()).toEqual([]);
  });

  it("forgets the password when the Session ends without saving", async () => {
    const { backend, tabs } = saving();
    const id = await connected(tabs);
    await vi.waitFor(() => expect(tab(tabs).save?.loggedIn).toBe(true));
    tabs.write(id, "exit\r");
    await vi.waitFor(() => expect(backend.forgotten()).toEqual(["q1"]));
    expect(tab(tabs).save).toBeNull();
  });

  it("forgets it when the box refused the password: nothing to save", async () => {
    const { backend, tabs } = saving();
    await connected(tabs, "nope");
    await vi.waitFor(() => expect(tab(tabs).status.state).toBe("ended"));
    await vi.waitFor(() => expect(backend.forgotten()).toEqual(["q1"]));
    expect(tab(tabs).save).toBeNull();
  });

  it("forgets it when the user turns the offer down, or closes the tab", async () => {
    const { backend, tabs } = saving();
    const id = await connected(tabs);
    await vi.waitFor(() => expect(tab(tabs).save?.loggedIn).toBe(true));
    tabs.dismissSave(id);
    expect(tab(tabs).save).toBeNull();
    expect(backend.forgotten()).toEqual(["q1"]);
    tabs.close(id);
    expect(backend.forgotten()).toEqual(["q1"]);
  });

  it("keeps the saved Host's name, and forgets nothing more once saved", async () => {
    const { backend, tabs } = saving();
    const id = await connected(tabs);
    await vi.waitFor(() => expect(tab(tabs).save?.loggedIn).toBe(true));
    tabs.saved(id, "nas-01");
    expect(tab(tabs).save).toMatchObject({ saved: "nas-01" });
    tabs.close(id);
    await settle();
    expect(backend.forgotten()).toEqual([]);
  });
});

describe("a held password, around the Session's life (iteration-4 review)", () => {
  /** The fake Backend, but the test resolves the Session's opening and says when it logged in. */
  function heldSessions() {
    const backend = fakeBackend({ ...unlocked, hosts, apiVersion: SAVE_TO_VAULT_API_VERSION });
    let events: SessionEvents | null = null;
    let resolve: (held: string) => void = () => {};
    backend.openSession = (_host, _size, ev) => {
      events = ev;
      return new Promise((r) => {
        const done = async () => {};
        resolve = (held) => r({ id: 1, auth: "password", held, write: done, resize: done, close: done });
      });
    };
    backend.openQuickSession = (_to, _password, size, ev) => backend.openSession("", size, ev);
    let login: (held: string) => void = () => {};
    backend.onLoggedIn = (cb) => ((login = cb), () => {});
    const tabs = new Tabs(backend);
    const print = (s: string | Uint8Array) => events!.output(typeof s === "string" ? new TextEncoder().encode(s) : s);
    return { backend, tabs, open: (held: string) => resolve(held), login: (held: string) => login(held), print };
  }
  /** A Quick Connect as `user` to a box, with "Save to vault" ticked and serve holding `h1`. */
  async function quickSaving(user: string) {
    const t = heldSessions();
    const id = t.tabs.openQuick({ user, address: "10.0.0.5", port: 22 });
    await vi.waitFor(() => {
      const s = t.tabs.snapshot().tabs[0]!.status;
      if (s.state !== "asking" || !s.key) throw new Error("not asking yet");
    });
    t.tabs.connectQuick(id, FAKE_HOST_PASSWORD, true);
    await settle();
    t.open("h1");
    await vi.waitFor(() => expect(t.tabs.snapshot().tabs[0]!.save?.held).toBe("h1"));
    return { ...t, save: () => t.tabs.snapshot().tabs[0]!.save };
  }

  it("forgets the password a Session holds when it opens after its tab was closed", async () => {
    const { backend, tabs, open } = heldSessions();
    const id = tabs.open(reviewed[0]!);
    await settle();
    tabs.close(id);
    open("h1");
    await vi.waitFor(() => expect(backend.forgotten()).toEqual(["h1"]));
  });

  it("reads the box's name across a character split between two chunks of output", async () => {
    const { login, print, save } = await quickSaving("jé");
    login("h1");
    const bytes = new TextEncoder().encode("[jé@nas-01 ~]$ ");
    const split = 3; // "[j" and the first of "é"'s two bytes
    print(bytes.slice(0, split));
    print(bytes.slice(split));
    expect(save()?.hostname).toBe("nas-01");
  });

  it("reads the box's name from a prompt printed before serve said it logged in", async () => {
    const { login, print, save } = await quickSaving("root");
    print("\x1b]0;root@nas-01: ~\x07[root@nas-01 ~]# ");
    expect(save()?.hostname).toBeNull();
    login("h1");
    expect(save()).toMatchObject({ loggedIn: true, hostname: "nas-01" });
  });

  it("keeps only a bounded tail of that output", async () => {
    const { login, print, save } = await quickSaving("root");
    print("[root@old-name ~]# ");
    print("x".repeat(8 * 1024));
    login("h1");
    expect(save()?.hostname).toBeNull();
  });
});
