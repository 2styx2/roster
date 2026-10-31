// The fake Backend's stand-in for examples/plugins/recent-alerts (ticket 56): the same Plugin, line
// for line, in TypeScript, since the frontend's tests can't run Lua. It isn't trusted to be right:
// recentAlerts.test.ts replays the transcript crates/roster-core/tests/recent_alerts.rs records
// from the real Lua (app/src/plugins/recent-alerts.transcript.json) and checks this does the same.
// Change the Lua first, then this.
import type { FakePlugin, FakeRoster } from "./fakePlugins";

const DEFAULT_PATTERNS = ["ERROR", "panic", "disk full"];
const LINE_MAX = 300;
const CARRY_MAX = 2000;
const CONTEXT = 3;
const QUICK = "Quick Connect";

interface Settings {
  patterns: string[];
  leader: string;
  max: number;
  notify: boolean;
  quiet: number;
}

/** match.settings: init.lua's settings, checked; bad values use the default and are named. */
export function settings(config: Record<string, unknown>): [Settings, string[]] {
  const problems: string[] = [];
  const s: Settings = { patterns: DEFAULT_PATTERNS, leader: "w w", max: 100, notify: true, quiet: 30 };
  if (config.patterns !== undefined) {
    const p = config.patterns;
    if (Array.isArray(p) && p.length > 0 && p.every((x) => typeof x === "string" && x !== "" && x.length <= 200)) s.patterns = p as string[];
    else problems.push('config.patterns must be a list of text, such as { "ERROR", "panic" }');
  }
  if (config.leader !== undefined) {
    const k = config.leader;
    if (typeof k === "string" && k !== "" && !k.startsWith(" ") && !k.endsWith(" ") && !k.includes("  ")) s.leader = k;
    else problems.push('config.leader must be keys after the Leader, such as "w w"');
  }
  if (config.max !== undefined) {
    const m = config.max;
    if (typeof m === "number" && Number.isInteger(m) && m >= 1 && m <= 1000) s.max = m;
    else problems.push("config.max must be a whole number from 1 to 1000");
  }
  if (config.notify !== undefined) {
    if (typeof config.notify === "boolean") s.notify = config.notify;
    else problems.push("config.notify must be true or false");
  }
  if (config.quiet !== undefined) {
    const q = config.quiet;
    if (typeof q === "number" && Number.isInteger(q) && q >= 0 && q <= 3600) s.quiet = q;
    else problems.push("config.quiet must be a whole number of seconds from 0 to 3600");
  }
  return [s, problems];
}

function lines(carry: string | undefined, text: string): [string[], string] {
  const all = (carry ?? "") + text;
  const parts = all.split("\n");
  let rest = parts.pop() ?? "";
  // The Lua keeps the last CARRY_MAX bytes, cut where a character starts.
  const bytes = new TextEncoder().encode(rest);
  if (bytes.length > CARRY_MAX) {
    let from = bytes.length - CARRY_MAX;
    while (from < bytes.length && ((bytes[from] ?? 0) & 0xc0) === 0x80) from++;
    rest = new TextDecoder().decode(bytes.slice(from));
  }
  return [parts, rest];
}

/** match.prompt: a shell prompt and what was typed after it, the shell's echo of your command. */
export function prompt(line: string): boolean {
  return /^\S+[$#] /.test(line) || /^\[[^\]]*\][$#] /.test(line) || /^\$ /.test(line) || /^PS [^>]*> /.test(line);
}

function tidy(line: string): string {
  const t = line.trim();
  const chars = [...t];
  return chars.length > LINE_MAX ? `${chars.slice(0, LINE_MAX - 1).join("")}…` : t;
}

const two = (n: number) => String(n).padStart(2, "0");
const clock = (at: number) => {
  const d = new Date(at * 1000);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};
const date = (at: number) => {
  const d = new Date(at * 1000);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${clock(at)}`;
};
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const list = (p: string[]) => (p.length === 1 ? (p[0] ?? "") : `${p.slice(0, -1).join(", ")} or ${p[p.length - 1] ?? ""}`);

interface Alert {
  id: number;
  /** null: a Quick Connect Session, which has no Host. */
  host: string | null;
  session: number;
  text: string;
  pattern: string;
  at: number;
  before: string[];
}

export interface RecentAlertsOptions {
  version?: string;
  permissions?: string[];
  /** A version that misbehaves: output with "BAD" in it makes it throw. */
  throwsOn?: string;
}

/** recent-alerts as the fake Backend's Plugin. */
export function recentAlerts(options: RecentAlertsOptions = {}): FakePlugin {
  return {
    manifest: {
      name: "recent-alerts",
      version: options.version ?? "1.0.0",
      description: "Lines your Sessions print that look like trouble: ERROR, panic, disk full",
      author: "A. N. Author",
      api: 2,
      permissions: options.permissions ?? ["terminal.read"],
    },
    load: (roster) => load(roster, options),
  };
}

function load(roster: FakeRoster, options: RecentAlertsOptions) {
  const [s, problems] = settings(roster.plugin.config);
  for (const p of problems) roster.notify(`${p}; using the default`, "warn");
  const reads = roster.plugin.permissions.includes("terminal.read");

  let alerts: Alert[] = [];
  let nextId = 0;
  const carry = new Map<number, string>();
  const context = new Map<number, string[]>();
  let badged = new Map<string, number>();
  const told = new Map<string, { at: number | null; held: number }>();
  const where = (a: Alert) => a.host ?? QUICK;

  const details = (a: Alert) => {
    const out = [`Host     ${a.host ?? `none (${QUICK})`}`, `Session  ${a.session}`, `At       ${date(a.at)}`, `Matched  ${a.pattern}`, ""];
    for (const l of a.before) out.push(`  ${l}`);
    out.push(`› ${a.text}`);
    roster.float.open({ title: a.host ? `Alert on ${a.host}` : "Alert in a Quick Connect Session", lines: out });
  };

  const show = () => {
    const rows: Record<string, unknown>[] = [];
    const items: Record<string, unknown>[] = [];
    const perHost = new Map<string, number>();
    for (const a of [...alerts].reverse()) {
      if (a.host) perHost.set(a.host, (perHost.get(a.host) ?? 0) + 1);
      rows.push({
        id: String(a.id),
        label: a.text,
        detail: where(a),
        note: clock(a.at),
        title: `${where(a)} at ${clock(a.at)}: ${a.text}`,
        ...(a.host ? { host: a.host } : {}),
        actions: [
          { label: `Details of ${a.text}`, icon: "info", run: () => details(a) },
          {
            label: `Copy ${a.text}`,
            icon: "copy",
            run: () => {
              roster.clipboard.copy(a.text);
              roster.notify(`Copied the line from ${where(a)}`);
            },
          },
          {
            label: `Dismiss ${a.text}`,
            icon: "close",
            run: () => {
              alerts = alerts.filter((x) => x.id !== a.id);
              show();
            },
          },
        ],
      });
      items.push({ id: String(a.id), label: a.text, detail: `${where(a)} · ${clock(a.at)}`, run: () => details(a) });
    }
    const empty = reads ? `No alerts. Lines with ${list(s.patterns)} show here.` : "Allow terminal.read in :plugins to see alerts.";
    roster.sidebar.set("recent-alerts", { title: "Recent alerts", order: 200, empty, rows });
    roster.finders.set("alerts", { title: "Recent alerts", items });
    if (alerts.length > 0) {
      roster.status.set("alerts", { text: `⚠ ${alerts.length}`, title: plural(alerts.length, "recent alert", "recent alerts"), run: "finder alerts" });
    } else roster.status.remove("alerts");
    const hosts = [...new Set([...perHost.keys(), ...badged.keys()])].sort();
    for (const host of hosts) {
      const n = perHost.get(host);
      roster.badges.set(host, n ? String(n) : null);
    }
    badged = perHost;
  };

  roster.commands.add("alerts", {
    desc: "Recent alerts: :alerts shows them, :alerts clear dismisses them all",
    run: (a: Record<string, unknown>) => {
      const what = (a.words as string[] | undefined)?.[0];
      if (what === "clear") {
        const n = alerts.length;
        alerts = [];
        show();
        roster.notify(n === 0 ? "No alerts to clear" : `Dismissed ${plural(n, "alert", "alerts")}`);
      } else if (what === undefined) {
        if (alerts.length === 0) return roster.notify("No alerts");
        roster.float.open({ title: "Recent alerts", lines: [...alerts].reverse().map((x) => `${clock(x.at)}  ${where(x)}  ${x.text}`) });
      } else roster.notify(":alerts shows the alerts, :alerts clear dismisses them all", "warn");
    },
  });
  roster.keymap.set("leader", s.leader, "finder alerts");

  roster.help.set("recent-alerts", {
    title: "Recent alerts",
    summary: "Lines your Sessions print that look like trouble",
    markdown: [
      "# Recent alerts",
      "",
      `Watches what your Sessions print and lists the lines with ${list(s.patterns)} in the **Recent alerts** section of the Sidebar, newest first, each with its Host and time.`,
      "",
      "- `:alerts` shows them all; `:alerts clear` dismisses them all.",
      `- \`␣ ${s.leader}\` finds one (\`:finder alerts\`); the status bar's \`⚠\` count opens the same finder.`,
      "- On a row: Enter goes to the Host's Session; the buttons show the details, copy the line or dismiss it.",
      "",
      `It keeps the last ${s.max} alerts, in memory only: they're gone when the app restarts.`,
      "",
      "It needs **terminal.read**, which lets it see everything your Sessions print. Revoke it in `:plugins` and it stops at once.",
    ].join("\n"),
  });

  if (reads) {
    roster.on("terminal_output", (e) => {
      const text = String(e.text);
      if (options.throwsOn && text.includes(options.throwsOn)) throw new Error(`${options.throwsOn} in the output`);
      const session = Number(e.session);
      const host = typeof e.host === "string" ? e.host : null;
      const [whole, rest] = lines(carry.get(session), text);
      carry.set(session, rest);
      const seen = context.get(session) ?? [];
      const fresh: Alert[] = [];
      for (const raw of whole) {
        const all = raw.trim();
        const pattern = all !== "" && !prompt(all) ? s.patterns.find((p) => all.includes(p)) : undefined;
        const line = tidy(all);
        if (pattern) {
          const a: Alert = { id: ++nextId, host, session, text: line, pattern, at: Math.floor(Date.now() / 1000), before: seen.slice(-CONTEXT) };
          alerts.push(a);
          fresh.push(a);
        }
        if (line !== "") {
          seen.push(line);
          if (seen.length > CONTEXT) seen.shift();
        }
      }
      context.set(session, seen);
      const last = fresh[fresh.length - 1];
      if (!last) return;
      while (alerts.length > s.max) alerts.shift();
      show();
      if (s.notify) {
        // At most one notice per Host each `quiet` seconds; the ones held back count in the next.
        const key = where(last);
        const t = told.get(key) ?? { at: null, held: 0 };
        told.set(key, t);
        const now = Math.floor(Date.now() / 1000);
        if (t.at !== null && now - t.at < s.quiet) t.held += fresh.length;
        else {
          const n = t.held + fresh.length;
          t.at = now;
          t.held = 0;
          roster.notify(n === 1 ? `${key}: ${last.text}` : `${n} new alerts on ${key}, the last: ${last.text}`, "warn");
        }
      }
    });
    roster.on("session_exit", (e) => {
      carry.delete(Number(e.session));
      context.delete(Number(e.session));
    });
  }

  show();
}
