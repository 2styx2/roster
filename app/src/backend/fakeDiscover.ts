// The fake Backend's stand-in for plugins/discover (ticket 44), line for line in TypeScript, since
// the frontend's tests can't run Lua, and a stand-in roster serve for its `discover.*` methods. The
// stand-in isn't trusted to be right: discover.test.ts replays the transcript
// crates/roster-core/tests/plugin_discover.rs records from the real Lua
// (app/src/plugins/discover.transcript.json) and checks this does the same. Change the Lua first.
import type { FakePlugin, FakeRoster, FakeServe } from "./fakePlugins";
import { BackendCallError } from "./types";

const DEFAULT_LEADER = "y d";
const MAX_ROWS = 10000;
const CHUNK = 2000;
const PORTS_SHOWN = 4;
const VIEW = "discover";
const SCANS = ["serve:discover.plan", "serve:discover.start", "serve:discover.status", "serve:discover.stop"];
const ADDS = "serve:discover.add";

export interface FoundPort {
  port: number;
  name: string;
  product: string;
  title: string;
}

/** What `discover.status` says about one address that answered (serve-api.md's Found). */
export interface Found {
  address: string;
  name: string | null;
  type: string;
  hostname: string;
  title: string;
  web: string | null;
  known: string | null;
  added: string | null;
  vendor: string;
  os: string;
  mac: string;
  ports: FoundPort[];
}

interface Settings {
  leader: string;
  ranges: string[];
  ports: string | undefined;
  group: string | undefined;
}

const isKeys = (k: unknown): k is string => typeof k === "string" && k !== "" && !k.startsWith(" ") && !k.endsWith(" ") && !k.includes("  ");
const isRange = (s: unknown): s is string => typeof s === "string" && s.length <= 64 && /^[0-9a-fA-F.:/]+$/.test(s);

/** model.settings: init.lua's settings, checked; bad values use the default and are named. */
export function settings(config: Record<string, unknown>): [Settings, string[]] {
  const problems: string[] = [];
  const s: Settings = { leader: DEFAULT_LEADER, ranges: [], ports: undefined, group: undefined };
  if (config.leader !== undefined) {
    if (isKeys(config.leader)) s.leader = config.leader;
    else problems.push('config.leader must be keys after the Leader, such as "y d"');
  }
  if (config.ranges !== undefined) {
    const r = config.ranges;
    if (Array.isArray(r) && r.every(isRange)) s.ranges = r;
    else problems.push('config.ranges must be a list of networks, such as { "10.0.0.0/24" }');
  }
  if (config.ports !== undefined) {
    if (typeof config.ports === "string" && /^\d+[\d,]*$/.test(config.ports)) s.ports = config.ports;
    else problems.push('config.ports must be TCP ports separated by commas, such as "22,80,443"');
  }
  if (config.group !== undefined) {
    const g = config.group;
    if (typeof g === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(g) && g.length <= 64) s.group = g;
    else problems.push('config.group must be a group name, such as "found" (letters, digits, . _ -)');
  }
  return [s, problems];
}

const count = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;
const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`);
const codeOf = (e: unknown) => {
  const m = /\(code (-?\d+)\)$/.exec(String(e instanceof Error ? e.message : e));
  return m ? Number(m[1]) : null;
};
const messageOf = (e: unknown) =>
  String(e instanceof Error ? e.message : e)
    .replace(/^roster\.serve\.[a-z]+ [\w._]+: /, "")
    .replace(/ \(code -?\d+\)$/, "");

const portsText = (ports: FoundPort[]) => {
  const bits: string[] = [];
  for (const [i, p] of ports.entries()) {
    if (i >= PORTS_SHOWN) {
      bits.push(`+${ports.length - PORTS_SHOWN} more`);
      break;
    }
    bits.push(`${p.port} ${p.name}`);
  }
  return bits.join(" · ");
};

const stateOf = (f: Found) => (f.known ? "known" : f.added ? "added" : "new");

function row(f: Found, keep: boolean): Record<string, unknown> {
  const state = stateOf(f);
  const status = state === "known" ? `in the Inventory as ${f.known}` : state === "added" ? `added as ${f.added}` : "new";
  const r: Record<string, unknown> = {
    id: f.address,
    cells: {
      keep: keep ? "✓" : "",
      address: f.address,
      name: f.known ?? f.added ?? f.name ?? "",
      type: f.type,
      ports: portsText(f.ports),
      title: f.title !== "" ? f.title : f.hostname,
      status,
      state,
      pick: keep ? "yes" : "no",
    },
  };
  const host = f.known ?? f.added;
  if (host) r.host = host;
  if (state !== "new") r.tone = "muted";
  return r;
}

function detailLines(f: Found): string[] {
  const lines = [`Address   ${f.address}`];
  if (f.hostname !== "") lines.push(`DNS name  ${f.hostname}`);
  if (f.known) lines.push(`Host      ${f.known} (in the Inventory)`);
  else if (f.added) lines.push(`Host      ${f.added} (added, a Pending change)`);
  else lines.push(`Adds as   ${f.name ?? ""}`);
  lines.push(`Type      ${f.type} (guessed: fix it when you review it)`);
  if (f.vendor !== "") lines.push(`Hardware  ${f.vendor}`);
  if (f.os !== "") lines.push(`OS        ${f.os}`);
  if (f.mac !== "") lines.push(`MAC       ${f.mac}`);
  lines.push("", "Open ports");
  for (const p of f.ports) {
    let line = `  ${String(p.port).padEnd(6)} ${p.name}`;
    if (p.product !== "") line += `  ${p.product}`;
    if (p.title !== "") line += `  "${p.title}"`;
    lines.push(line);
  }
  return lines;
}

/** discover as the fake Backend's Plugin. */
export function discoverPlugin(options: { permissions?: string[] } = {}): FakePlugin {
  return {
    manifest: {
      name: "discover",
      version: "1.0.0",
      description: "Scan a network from the app and add what it finds, as Pending changes you review",
      author: "roster",
      api: 3,
      permissions: options.permissions ?? [...SCANS, ADDS],
    },
    load: (roster) => load(roster),
  };
}

interface Scan {
  id: string;
  targets: string[];
  scanner: string;
  state: string;
  done: number;
  total: number;
  count: number;
  error: string | null;
}

type Plan = { targets: string[]; addresses: number; ports: number; scanner: string; limit: number };
type Status = Scan & { scan: string; found: Found[] };

function load(roster: FakeRoster) {
  const [s, problems] = settings(roster.plugin.config);
  for (const p of problems) roster.notify(`${p}; using the default`, "warn");
  const missing = () => SCANS.filter((p) => !roster.has(p));
  /** As the Lua's `request`: roster serve without waiting; `done(true, result)` or `done(false, why)` later. */
  const request = (method: string, params: Record<string, unknown>, done: (ok: boolean, result: unknown) => void) => {
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
    try {
      if (!roster.serve) throw new Error("roster.serve.request: not granted");
      roster.serve.request(method, clean, (r, why) => (why !== undefined ? done(false, why) : done(true, r)));
    } catch (e) {
      done(false, e);
    }
  };

  let scan: Scan | null = null;
  let found = new Map<string, Found>();
  let order: string[] = [];
  let kept = new Set<string>();
  let cut = false;
  let polling: number | null = null;
  let asking = false;
  let again = false;
  let pushed = false;
  let planning = false;
  let adding = false;
  /** A found address, by its address: always one the scan found. */
  const the = (a: string): Found => {
    const f = found.get(a);
    if (!f) throw new Error(`discover: no ${a} found`);
    return f;
  };

  const counts = () => {
    let fresh = 0;
    let known = 0;
    let added = 0;
    let keep = 0;
    for (const a of order) {
      const st = stateOf(the(a));
      if (st === "new") fresh++;
      else if (st === "known") known++;
      else added++;
      if (kept.has(a)) keep++;
    }
    return [fresh, known, added, keep] as const;
  };

  const words = (): [string, unknown[]] => {
    const gone = missing();
    if (gone.length > 0) return [`Discover needs ${list(gone)}. Allow them in :plugins to scan a network.`, []];
    if (!scan) {
      let text = "Scan a network for Hosts: :discover 10.0.0.0/24. roster scans from this computer, and nothing is added until you pick what to keep.";
      if (s.ranges.length > 0)
        text = `Scan ${list(s.ranges)} for Hosts: :discover (or name another range: :discover 10.0.0.0/24). roster scans from this computer, and nothing is added until you pick what to keep.`;
      return [text, []];
    }
    const [fresh, known, added, keep] = counts();
    const where = list(scan.targets);
    let text: string;
    if (scan.state === "running") text = `Scanning ${where} with ${scan.scanner}: ${count(scan.done)} of ${count(scan.total)} addresses. Hosts show here as they're found.`;
    else if (scan.state === "stopping") text = `Stopping the scan of ${where}.`;
    else if (scan.state === "failed") text = `The scan of ${where} failed: ${scan.error ?? "no reason given"}.`;
    else text = `${scan.state === "stopped" ? "Stopped the scan of " : "Scanned "}${where}: ${plural(scan.count, "Host", "Hosts")} answered.`;
    if (fresh > 0)
      text += "\n\nKeep the ones you want (m, or :discover keep all), then add them (A): they go in unreviewed, as Pending changes you review in :changes and Publish.";
    else if (added > 0) text += "\n\nThe ones you added are Pending changes: review them in :changes, then Publish.";
    if (cut) text += `\n\nMore answered than the view shows: it keeps the first ${count(MAX_ROWS)}.`;
    const facts = [
      { label: "Range", value: where, data: true },
      { label: "Scanner", value: scan.scanner },
      { label: "Found", value: `${count(fresh)} new, ${count(known)} in the Inventory${added > 0 ? `, ${count(added)} added` : ""}` },
      { label: "Kept", value: count(keep) },
    ];
    return [text, facts];
  };

  const retell = () => {
    const [text, facts] = words();
    roster.views.update(VIEW, { text, facts });
  };

  const redraw = (addresses: string[]) => {
    let rows: unknown[] = [];
    for (const a of addresses) {
      rows.push(row(the(a), kept.has(a)));
      if (rows.length === CHUNK) {
        roster.views.update(VIEW, { rows });
        rows = [];
      }
    }
    const [text, facts] = words();
    roster.views.update(VIEW, { rows, text, facts });
  };

  const details = (e: Record<string, unknown>) => {
    const f = found.get(String(e.row));
    if (!f) return;
    const links = f.web ? [{ label: "Its web page", url: f.web }] : [];
    roster.float.open({ title: f.known ?? f.added ?? f.name ?? f.address, lines: detailLines(f), links });
  };

  const mark = (address: string, keep: boolean) => {
    const f = found.get(address);
    if (!f || stateOf(f) !== "new") return;
    if (keep) kept.add(address);
    else kept.delete(address);
    redraw([address]);
  };

  const keeping = () => order.filter((a) => kept.has(a) && stateOf(the(a)) === "new");

  const add = () => {
    if (!scan) return;
    const picks = keeping();
    if (picks.length === 0) {
      roster.notify("Keep a Host first: m on its row, or :discover keep all", "info", { quiet: false });
      return;
    }
    if (!roster.has(ADDS)) {
      roster.notify(`Adding needs ${ADDS}: allow it in :plugins`, "warn");
      return;
    }
    const names: string[] = [];
    for (const [i, a] of picks.entries()) {
      if (i >= 8) {
        names.push(`and ${picks.length - 8} more`);
        break;
      }
      names.push(the(a).name ?? a);
    }
    const id = scan.id;
    roster.confirm({
      title: `Add ${plural(picks.length, "Host", "Hosts")} to the Inventory?`,
      text: "They go in a new group, unreviewed, as Pending changes: nothing connects to them, and nothing is Published. Review them in :changes (names, Logins), then Publish.",
      facts: [
        { label: "Hosts", value: names.join(", "), data: true },
        { label: "Group", value: s.group ?? "a new discovered-YYYYMMDD", data: s.group !== undefined },
      ],
      action: "Add",
      run: () => {
        if (adding) return;
        adding = true;
        request("discover.add", { scan: id, addresses: picks, group: s.group }, (ok, a) => {
          adding = false;
          if (!ok) {
            roster.notify(`Nothing was added: ${messageOf(a)}`, "error");
            return;
          }
          const r = a as { group: string; added: { address: string; name: string }[] };
          const touched: string[] = [];
          for (const x of r.added) {
            const f = found.get(x.address);
            if (f) {
              f.added = x.name;
              kept.delete(x.address);
              touched.push(x.address);
            }
          }
          redraw(touched);
          roster.notify(`Added ${plural(r.added.length, "Host", "Hosts")} to ${r.group} as Pending changes: review them in :changes, then Publish`, "info", { quiet: false });
        });
      },
    });
  };

  const stop = () => {
    if (!scan || scan.state !== "running") return;
    request("discover.stop", { scan: scan.id }, () => undefined);
  };

  const progress = () => {
    if (!scan) return;
    if (scan.state === "running" || scan.state === "stopping") {
      roster.progress.set("scan", {
        title: `Scanning ${list(scan.targets)}`,
        text: `${plural(scan.count, "Host", "Hosts")} found so far`,
        done: scan.done,
        total: scan.total,
        cancel: stop,
      });
    } else roster.progress.remove("scan");
  };

  const heard = (ok: boolean, a: unknown) => {
    if (!scan) return;
    if (!ok) {
      scan.state = "failed";
      scan.error = messageOf(a);
    } else {
      const r = a as Status;
      Object.assign(scan, { state: r.state, done: r.done, total: r.total, count: r.count, error: r.error });
      const fresh: string[] = [];
      for (const f of r.found) {
        if (!found.has(f.address)) {
          if (order.length >= MAX_ROWS) {
            cut = true;
            break;
          }
          order.push(f.address);
        }
        found.set(f.address, f);
        fresh.push(f.address);
      }
      redraw(fresh);
    }
    progress();
    if (scan.state !== "running" && scan.state !== "stopping") {
      if (polling !== null) roster.cancel(polling);
      polling = null;
      retell();
      if (scan.state === "failed") roster.notify(`The scan of ${list(scan.targets)} failed: ${scan.error ?? "no reason given"}`, "error");
      else {
        const [fresh] = counts();
        roster.notify(`${scan.state === "stopped" ? "Stopped: " : "Scan done: "}${plural(scan.count, "Host", "Hosts")} answered, ${count(fresh)} new`, "info", { quiet: false });
      }
    }
  };

  const going = () => scan !== null && (scan.state === "running" || scan.state === "stopping");
  const poll = () => {
    if (!scan) return;
    if (asking) {
      again = true;
      return;
    }
    asking = true;
    again = false;
    const id = scan.id;
    request("discover.status", { scan: id, since: scan.count }, (ok, r) => {
      asking = false;
      if (scan && scan.id === id) heard(ok, r);
      if (again && going()) poll();
    });
  };
  // serve's job_progress (API 20): each may bring results; the first one means serve pushes.
  if (roster.has("serve:discover.status")) {
    roster.on("job_progress", (e) => {
      if (e.kind !== "discover") return;
      pushed = true;
      if (polling !== null) {
        roster.cancel(polling);
        polling = null;
      }
      if (scan && scan.id === e.job && going()) poll();
    });
  }

  const table = {
    columns: [
      { id: "keep", label: "Keep", width: 5 },
      { id: "address", label: "Address", kind: "data", width: 16 },
      { id: "name", label: "Name", kind: "data", width: 24 },
      { id: "type", label: "Looks like", width: 10 },
      { id: "ports", label: "Open ports" },
      { id: "title", label: "Title" },
      { id: "status", label: "Status", width: 22 },
    ],
    sort: "address",
    empty: "Nothing found yet.",
    open: details,
    actions: [
      { label: "Keep", key: "m", icon: "add", when: { state: "new", pick: "no" }, run: (e: Record<string, unknown>) => mark(String(e.row), true) },
      { label: "Don't keep", key: "u", icon: "close", when: { state: "new", pick: "yes" }, run: (e: Record<string, unknown>) => mark(String(e.row), false) },
      { label: "Add the kept Hosts", key: "A", icon: "addGroup", when: { pick: "yes" }, run: add },
      { label: "Details", key: "i", icon: "info", run: details },
    ],
    rows: [],
  };

  const started = (r: Status) => {
    scan = { id: r.scan, targets: r.targets, scanner: r.scanner, state: r.state, done: r.done, total: r.total, count: 0, error: null };
    let gone: string[] = [];
    for (const a of order) {
      gone.push(a);
      if (gone.length === CHUNK) {
        roster.views.update(VIEW, { remove: gone });
        gone = [];
      }
    }
    if (gone.length > 0) roster.views.update(VIEW, { remove: gone });
    found = new Map();
    order = [];
    kept = new Set();
    cut = false;
    retell();
    roster.views.open(VIEW);
    progress();
    if (polling !== null) roster.cancel(polling);
    polling = null;
    if (pushed) poll();
    else polling = roster.every(1000, poll);
  };

  const start = (targets: string[], force: boolean) => {
    request("discover.start", { targets, ports: s.ports, force }, (ok, r) => {
      if (!ok) {
        roster.notify(`The scan didn't start: ${messageOf(r)}`, codeOf(r) === 120 ? "warn" : "error");
        return;
      }
      started(r as Status);
    });
  };

  const ask = (targets: string[]) => {
    if (missing().length > 0) {
      roster.notify(`Discover needs ${list(missing())}: allow them in :plugins`, "warn");
      return;
    }
    if (scan && (scan.state === "running" || scan.state === "stopping")) {
      roster.notify(`A scan of ${list(scan.targets)} is going: stop it first (:discover stop)`, "warn");
      return;
    }
    if (planning) {
      roster.notify("Still waiting for roster serve to size the last range: a moment", "info", { quiet: false });
      return;
    }
    planning = true;
    request("discover.plan", { targets, ports: s.ports, force: true }, (ok, plan) => {
      planning = false;
      confirm(ok, plan);
    });
  };

  const confirm = (ok: boolean, plan: unknown) => {
    if (!ok && codeOf(plan) === -32601) {
      roster.notify(
        "Not scanned: the roster on this Box is too old to scan from the app (it needs roster serve API 18). Update roster there, or run `roster discover` in a terminal.",
        "error",
      );
      return;
    } else if (!ok) {
      roster.notify(`Not scanned: ${messageOf(plan)}`, "error");
      return;
    }
    const p = plan as Plan;
    const force = p.addresses > p.limit;
    const where = list(p.targets);
    let text = `roster scans from this computer: it connects to each of the ${plural(p.addresses, "address", "addresses")} on ${plural(p.ports, "TCP port", "TCP ports")}, with ${p.scanner}. Scan only networks you may: their security tools may take a scan for an attack.\n\nNothing is added until you pick what to keep.`;
    if (force) text += `\n\nThat's more than ${count(p.limit)} addresses, so it takes a while. Type the range to scan it.`;
    const question: Record<string, unknown> = {
      title: `Scan ${where}?`,
      text,
      facts: [
        { label: "Range", value: where, data: true },
        { label: "Addresses", value: count(p.addresses) },
        { label: "Ports", value: count(p.ports) },
        { label: "Scanner", value: p.scanner },
      ],
      action: "Scan",
      danger: force,
      run: () => start(p.targets, force),
    };
    if (force) question.typed = p.targets[0];
    roster.confirm(question);
  };

  roster.commands.add("discover", {
    desc: "Scan a network: :discover RANGE…, :discover stop, :discover keep all|none, :discover add",
    run: (a: Record<string, unknown>) => {
      const w = a.words as string[];
      const what = w[0];
      if (what === "stop") {
        if (scan && scan.state === "running") stop();
        else roster.notify("No scan is going", "info", { quiet: false });
      } else if (what === "add") add();
      else if (what === "keep") {
        const all = w[1] === "all";
        if (w[1] !== "all" && w[1] !== "none") {
          roster.notify(":discover keep all, or :discover keep none", "warn");
          return;
        }
        const touched: string[] = [];
        for (const addr of order) {
          if (stateOf(the(addr)) === "new" && kept.has(addr) !== all) {
            if (all) kept.add(addr);
            else kept.delete(addr);
            touched.push(addr);
          }
        }
        redraw(touched);
        roster.views.open(VIEW);
      } else if (what === undefined) {
        if (!scan && s.ranges.length > 0) ask(s.ranges);
        else roster.views.open(VIEW);
      } else ask(w);
    },
  });
  roster.keymap.set("leader", s.leader, "discover");
  roster.toolbar.set("discover", { label: "Scan a network for Hosts", text: "Scan", icon: "map", run: "discover" });
  roster.help.set("discover", {
    title: "Discover",
    summary: "Scan a network from the app and add what it finds",
    markdown: [
      "# Discover",
      "",
      "Scans a network for Hosts, from this computer, the way `roster discover` does, and shows what answered: its address, the name it would get, what it looks like, its open ports and its web page's title. You keep the ones you want and add them: they go into the Inventory in a new group, **unreviewed**, as Pending changes you review in `:changes` and Publish. Nothing is added, and nothing connects to a Host, before you say so.",
      "",
      "- `:discover 10.0.0.0/24` scans a range (several: `:discover 10.0.0.0/24 10.0.1.0/28`). It asks first, with how many addresses and ports.",
      `- \`:discover\` opens the view${s.ranges.length > 0 ? `, or scans ${list(s.ranges)} if nothing has been scanned yet` : ""}; \`␣ ${s.leader}\` and the toolbar's **Scan** do the same.`,
      "- On a row: `m` keeps it, `u` doesn't, `A` adds the kept ones, `i` or Enter shows its details. `:discover keep all` and `:discover keep none` mark every new one.",
      "- `:discover stop` (or `:cancel scan`, or the stop button by the progress) stops the scan; what it found stays.",
      "",
      "The scan runs in roster serve: nmap when it's installed (service versions and web page titles), else roster's own TCP connect scan. Up to 4,096 addresses as asked; more, up to a /16, only after you type the range. A Host already in the Inventory shows with its name, greyed out.",
      "",
      "It needs `serve:discover.plan`, `.start`, `.status` and `.stop` to scan, and `serve:discover.add` to add. See `:help plugins`.",
    ].join("\n"),
  });
  roster.health.set("discover", {
    title: "Discover",
    // It answers later (decision Q112h), from discover.plan's answer.
    check: (e: Record<string, unknown>) => {
      const gone = missing();
      if (gone.length > 0) return [{ level: "warn", message: `${list(gone)} not granted: Discover can't scan`, fix: "Allow them in :plugins" }];
      request("discover.plan", { targets: ["10.0.0.0/30"] }, (ok, plan) => {
        let out: Record<string, unknown>[];
        if (!ok && codeOf(plan) === -32601)
          out = [
            {
              level: "error",
              message: "roster on this Box can't scan from the app (it needs roster serve API 18)",
              fix: "Update roster on this Box; `roster discover` in a terminal works meanwhile",
            },
          ];
        else if (!ok) out = [{ level: "error", message: `roster serve didn't answer discover.plan: ${messageOf(plan)}` }];
        else {
          out = [{ level: "ok", message: `roster serve can scan, with ${(plan as Plan).scanner}` }];
          if ((plan as Plan).scanner !== "nmap")
            out[0] = {
              level: "warn",
              message: "nmap isn't installed on this Box: scans use roster's own TCP connect scan, with no service versions or web page titles",
              fix: "Install nmap on this Box (apt install nmap)",
            };
          if (!roster.has(ADDS)) out.push({ level: "warn", message: `${ADDS} isn't granted: scans can't add what they find`, fix: "Allow it in :plugins" });
        }
        roster.health.answer(e.check as number, out);
      });
      return "later";
    },
  });
  const [text, facts] = words();
  roster.views.set(VIEW, { title: "Discover", place: "full", text, facts, table });
}

// ---------------------------------------------------------------- the stand-in roster serve

export interface FakeNet {
  /** What answers, in address order, as discover.status would say it. */
  found: Found[];
  /** Addresses the scan visits per discover.status call (default: a quarter of them). */
  step?: number;
  scanner?: "nmap" | "built-in";
}

const ipv4 = (s: string) => s.split(".").reduce((n, b) => n * 256 + Number(b), 0);
const addressCount = (target: string) => {
  const [, bits = "32"] = target.split("/");
  const n = 2 ** (32 - Number(bits));
  return n <= 2 ? n : n - 2;
};
const inRange = (address: string, target: string) => {
  const [base = "", bits = "32"] = target.split("/");
  const mask = 2 ** (32 - Number(bits));
  return Math.floor(ipv4(address) / mask) === Math.floor(ipv4(base) / mask);
};

/** roster serve's discover.* for the fake Backend: a scan that moves on each time it's asked
 * (`step` addresses a discover.status), finding `net.found` in the ranges it's given. As the real
 * one: one at a time, 4,096 addresses without force, 65,536 with it, and discover.add marks what
 * it added (the fake's Inventory doesn't change). */
export function fakeDiscoverServe(net: FakeNet): FakeServe {
  // Its own copy: adding marks what it added, and a fixture's list is shared.
  const net0 = net.found.map((f) => ({ ...f }));
  const LIMIT = 4096;
  const MAX = 65536;
  let n = 0;
  let scan: { id: string; targets: string[]; done: number; total: number; state: string; found: Found[] } | null = null;
  const valid = (targets: unknown, force: boolean) => {
    if (!Array.isArray(targets) || targets.length === 0 || !targets.every((t) => typeof t === "string" && /^\d+\.\d+\.\d+\.\d+(\/\d+)?$/.test(t)))
      throw new BackendCallError(`params: ${JSON.stringify(targets)} isn't an IP address or network (e.g. 10.0.0.0/24)`, -32602);
    const total = (targets as string[]).reduce((a, t) => a + addressCount(t), 0);
    const limit = force ? MAX : LIMIT;
    if (total > limit) throw new BackendCallError(`that's ${count(total)} addresses; a scan visits at most ${count(limit)}${force ? "" : " without force"}`, 121);
    return [targets as string[], total] as const;
  };
  const status = (since = 0) => {
    if (!scan) throw new BackendCallError("no scan has started in this roster serve", 122);
    const seen = Math.ceil((scan.found.length * scan.done) / Math.max(scan.total, 1));
    const all = scan.found.slice(0, seen);
    return {
      scan: scan.id,
      state: scan.state,
      targets: scan.targets,
      scanner: net.scanner ?? "nmap",
      done: scan.done,
      total: scan.total,
      count: all.length,
      quiet: 0,
      found: all.slice(since).map((f) => ({ ...f })),
      error: null,
    };
  };
  return (method, params) => {
    switch (method) {
      case "discover.plan": {
        const [targets, total] = valid(params.targets, params.force === true);
        return { targets, addresses: total, ports: 47, scanner: net.scanner ?? "nmap", limit: LIMIT, max: MAX };
      }
      case "discover.start": {
        if (scan && scan.state === "running") throw new BackendCallError(`a scan of ${scan.targets.join(", ")} is going already`, 120, { scan: scan.id } as never);
        const [targets, total] = valid(params.targets, params.force === true);
        scan = { id: `scan-${++n}`, targets, done: 0, total, state: "running", found: net0.filter((f) => targets.some((t) => inRange(f.address, t))) };
        return status();
      }
      case "discover.status": {
        const s = status(Number(params.since ?? 0));
        if (scan && scan.state === "running") {
          scan.done = Math.min(scan.total, scan.done + (net.step ?? Math.ceil(scan.total / 4)));
          if (scan.done >= scan.total) scan.state = "done";
        }
        return s;
      }
      case "discover.stop": {
        if (!scan) throw new BackendCallError("no scan has started in this roster serve", 122);
        const stopping = scan.state === "running";
        if (stopping) scan.state = "stopped";
        return { scan: scan.id, stopping };
      }
      case "discover.add": {
        if (!scan || params.scan !== scan.id) throw new BackendCallError(`no scan ${JSON.stringify(params.scan)} here`, 122);
        const group = typeof params.group === "string" ? params.group : "discovered-20261031";
        const current = scan;
        const added = (params.addresses as string[]).map((a) => {
          const f = current.found.find((x) => x.address === a);
          if (!f || f.known || f.added) throw new BackendCallError(`${a}: not found by this scan, or in the Inventory already`, 123);
          f.added = f.name;
          return { address: a, name: f.name ?? a };
        });
        return { group, added, backup: "/home/you/infra/.git/roster/roster.yml.bak" };
      }
      default:
        throw new BackendCallError(`unknown method '${method}'`, -32601);
    }
  };
}

const port = (p: number, name: string, product = "", title = ""): FoundPort => ({ port: p, name, product, title });

/** A few Hosts on 10.0.0.0/24, one of them in the Inventory as `known` (the `?fixture=discover` net). */
export function smallNet(known: string): Found[] {
  const f = (address: string, more: Partial<Found>): Found => ({
    address,
    name: null,
    type: "server",
    hostname: "",
    title: "",
    web: null,
    known: null,
    added: null,
    vendor: "",
    os: "",
    mac: "",
    ports: [],
    ...more,
  });
  return [
    f("10.0.0.5", { known, type: "server", ports: [port(22, "ssh", "OpenSSH 9.6"), port(443, "https", "VMware ESXi")], web: "https://10.0.0.5" }),
    f("10.0.0.7", {
      name: "appliance",
      type: "appliance",
      hostname: "appliance.lab",
      title: "Appliance login",
      web: "https://10.0.0.7",
      ports: [port(443, "https", "lighttpd", "Appliance login")],
    }),
    f("10.0.0.9", { name: "db-10-0-0-9", type: "db", ports: [port(22, "ssh", "OpenSSH 9.6"), port(5432, "postgresql")] }),
    f("10.0.0.12", { name: "switch-10-0-0-12", type: "network", vendor: "Example Networks", ports: [port(22, "ssh"), port(23, "telnet"), port(80, "http")] }),
    f("10.0.0.21", { name: "bmc-10-0-0-21", type: "bmc", title: "Remote console", web: "https://10.0.0.21", ports: [port(443, "https", "", "Remote console"), port(623, "asf-rmcp")] }),
    f("10.0.0.40", { name: "windows-10-0-0-40", type: "windows", ports: [port(135, "msrpc"), port(445, "microsoft-ds"), port(3389, "ms-wbt-server"), port(5985, "wsman"), port(5986, "wsmans")] }),
  ];
}

/** The worst case: a /16 where 12,000 addresses answer (more than the view keeps), with long
 * names, long titles, many ports and text from far away. */
export function hugeNet(): Found[] {
  const out: Found[] = [];
  const titles = [
    "Integrated management console for the storage array in rack B, unit 42 (firmware 7.10.3-long-build-identifier)",
    "خادم الإنتاج — لوحة التحكم",
    "設定画面",
    "",
  ];
  for (let i = 0; i < 12000; i++) {
    const a = `10.0.${Math.floor(i / 250)}.${(i % 250) + 2}`;
    const odd = i % 7 === 0;
    out.push({
      address: a,
      name: odd ? `appliance-${a.replaceAll(".", "-")}-management-interface-secondary` : `server-${a.replaceAll(".", "-")}`,
      type: odd ? "appliance" : "server",
      hostname: odd ? `very-long-reverse-dns-name-for-${i}.storage.datacenter.example.com` : "",
      title: titles[i % titles.length] ?? "",
      web: odd ? `https://${a}` : null,
      known: i === 3 ? "esx-02" : null,
      added: null,
      vendor: "",
      os: "",
      mac: "",
      ports: odd ? [22, 80, 443, 623, 5900, 8080, 8443, 9443].map((p) => port(p, `svc-${p}`, "a product with a long version string 1.2.3")) : [port(22, "ssh", "OpenSSH 9.6")],
    });
  }
  return out;
}
