// The fake Backend's stand-in for plugins/mesh, the Mesh controls (ticket 50): the same Plugin,
// line for line, in TypeScript, since the frontend's tests can't run Lua. It isn't trusted to be
// right: mesh.test.ts replays the transcript crates/roster-core/tests/plugin_mesh.rs records from
// the real Lua (app/src/plugins/mesh.transcript.json), with the same roster serve answers, and
// checks this does the same. Change the Lua first, then this.
//
// Below it, `meshServe`: a stand-in roster serve for the Mesh's methods (API 17), as the Rust test's,
// for `?fixture=mesh` and the UI tests.
import type { FakePlugin, FakeRoster } from "./fakePlugins";

type Obj = Record<string, unknown>;
type Link = { from: string; to: string; kind?: string; via?: string; status?: string; why?: string };
type PlanHost = { host: string; status: string; changes: string[]; error?: string; more?: number };
interface Status {
  links: Link[];
  link_count?: number;
  link_statuses?: Record<string, number>;
  links_more?: number;
  excluded?: Record<string, string>;
  reach: Record<string, number>;
  reached: Record<string, number>;
  members?: string[];
  pending?: Record<string, string>;
  cut_pending?: Record<string, string[]>;
  out_of_date?: boolean;
}
interface Plan extends Status {
  hosts: PlanHost[];
  already: boolean;
  warnings?: string[];
}
interface Job {
  job: number;
  action: string;
  host?: string | undefined;
  total: number;
}

// ------------------------------------------------------------------ lua/mesh/words.lua

const encoder = new TextEncoder();
/** Lua compares strings byte by byte: so does this. */
function byteCompare(a: string, b: string): number {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  return x.length - y.length;
}
const sorted = (list: string[]) => [...list].sort(byteCompare);

export const words = {
  count(n: number): string {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  },
  plural(n: number, one: string, many: string): string {
    return `${words.count(n)} ${n === 1 ? one : many}`;
  },
  STATUS: {
    ok: "works",
    untested: "written, not tested",
    asked: "not tested yet",
    unreachable: "unreachable",
    "no-host-key": "no host key",
    "no-via": "no Link to its hop",
    pending: "pending",
    skipped: "skipped",
  } as Record<string, string>,
  FIX: {
    ok: "Nothing: it works.",
    untested: "Nothing to do: the source has no nc or bash to test the port with, so roster wrote it without testing.",
    asked: "Plan the Mesh (p) to test it from its source.",
    unreachable: "Check routing and firewalls between the two it names, then plan again. Until the port answers, the Link is left out.",
    "no-host-key": "This Box has no recorded host key for the peer: check its key and run roster setup --only PEER, then plan again.",
    "no-via":
      "The Link goes through a jump Host (via:) that its source has no Link to, and ssh logs in to the jump Host first. Add a Link from the source to the jump Host in roster.yml's links:, or take via: off. Until then the Link is left out, and roster check fails.",
    pending: "Nothing to do now: a Host didn't answer. The next apply finishes it.",
    skipped: "Nothing: the source is a password Host (enroll: false), so roster never writes on it. Its peers still reach it.",
  } as Record<string, string>,
  LEFT_OUT: { unreachable: true, "no-host-key": true, "no-via": true } as Record<string, boolean>,
  status(status: string | undefined): string {
    return words.STATUS[status ?? "asked"] ?? status ?? "not tested yet";
  },
  state(host: string, st: Status): [string, string | undefined] {
    if (st.excluded?.[host] !== undefined) return [`kept out: ${st.excluded[host]}`, "muted"];
    const cut = st.cut_pending ?? {};
    if (cut[host]) return [`cut, pending on ${words.plural(cut[host].length, "Host", "Hosts")}`, "warn"];
    for (const c of words.keys(cut)) {
      for (const p of cut[c] ?? []) if (p === host) return [`still holds ${c}'s key (cut pending)`, "warn"];
    }
    if (st.pending?.[host] !== undefined) return [`pending: ${st.pending[host]}`, "warn"];
    return ["in the Mesh", undefined];
  },
  reach(n: number): string {
    return `can reach ${words.plural(n, "Host", "Hosts")}`;
  },
  link(x: Link): string {
    return `${x.from} → ${x.to}${x.via ? ` via ${x.via}` : ""}`;
  },
  id(name: string, i: number): string {
    return encoder.encode(name).length <= 100 ? name : `#${i}`;
  },
  clean(e: unknown): string {
    const s = e instanceof Error ? e.message : String(e);
    return s.replace(/^[\s\S]*?roster\.serve\.[a-z]+ [\w._]+: /, "");
  },
  keys(t: object | undefined | null): string[] {
    return sorted(Object.keys(t ?? {}));
  },
  settings(config: Obj): [{ leader: string | false }, string[]] {
    const s: { leader: string | false } = { leader: "y m" };
    const problems: string[] = [];
    const k = config.leader;
    if (k !== undefined) {
      if (k === false || (typeof k === "string" && k !== "" && !k.startsWith(" ") && !k.endsWith(" ") && !k.includes("  "))) s.leader = k;
      else problems.push('config.leader must be keys after the Leader, such as "y m", or false for none');
    }
    return [s, problems];
  },
};

// ------------------------------------------------------------------ init.lua

const POLL = 1000;
const DETAIL_LINKS = 20;
const DETAILS_AT_ONCE = 300;
const ACTIONS: Record<string, string> = { plan: "Planning the Mesh", apply: "Applying the Mesh", cut: "Cutting" };

const HELP = `# Mesh controls

The Mesh's controls in the app: who reaches whom, a plan you look at before an apply you confirm, and a Cut you confirm by typing the Host's name. The Mesh itself is \`roster mesh\` (\`:help mesh\`); this Plugin runs it through roster serve.

| | |
|---|---|
| \`:mesh\` | The Mesh view: every Host in it, what it **can reach** (the Hosts it can log in to with its Mesh key: the risk if it's taken over), what reaches it, and its state |
| \`:mesh plan\` | Plan: roster connects to each Host and shows what an apply would change, changing nothing. The plan view lists each Host's changes |
| \`:mesh apply\` | Apply the plan, after a question. Without a plan, it plans first |
| \`:mesh links\` | The Links worth a look: those through a jump Host (\`via\`) or with a problem, and what each status means |
| \`:mesh cut HOST\` | Take HOST out of the Mesh now, on every Host at once, after you type its name |
| \`:cancel mesh\` | Stop a plan or apply before its next Host: the rest is pending, and the next apply finishes it |

In the views: \`p\` plans, \`a\` applies, \`l\` shows the Links, \`x\` cuts the selected Host, \`e\` (in the Links) says what a status means. Each Host's details (\`:info HOST\`) have a Mesh section with its reach.

The status bar says **Mesh out of date** when \`roster.yml\` changed the Mesh since the last apply on this Box (after a Publish, say): click it to plan. A Host that didn't answer gets a \`pending\` badge, and one that still holds a cut Host's key \`cut pending\`.

**no-via**: a Link with \`via:\` goes through a jump Host, and ssh logs in to the jump Host first, so its source needs a Link to the jump Host too. Without one the Link is left out and \`roster check\` fails: add the Link it names, or take \`via:\` off.
`;

export const MESH_PERMISSIONS = [
  "inventory.read",
  "serve:mesh.status",
  "serve:mesh.job",
  "serve:mesh.stop",
  "serve:mesh.plan",
  "serve:mesh.apply",
  "serve:mesh.cut",
];

/** plugins/mesh as the fake Backend's Plugin. */
export function meshPlugin(): FakePlugin {
  return {
    manifest: {
      name: "mesh",
      version: "1.0.0",
      description: "The Mesh's controls: who reaches whom, plan and apply it, and Cut a Host out",
      author: "roster",
      api: 4,
      permissions: MESH_PERMISSIONS,
    },
    load,
  };
}

const two = (n: number) => String(n).padStart(2, "0");
const clock = (at: number) => {
  const d = new Date(at * 1000);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};

function load(roster: FakeRoster) {
  const [settings, problems] = words.settings(roster.plugin.config);
  for (const p of problems) roster.notify(`${p}; using the default`, "warn");

  const state = {
    status: null as Status | null,
    problem: null as string | null,
    jobs: false,
    job: null as Job | null,
    starting: null as string | null,
    asking: false,
    recheck: false,
    pushed: false,
    refreshing: false,
    again: false,
    timer: null as number | null,
    done: 0,
    plan: null as Plan | null,
    planned: 0,
    last: null as string | null,
    badged: new Set<string>(),
    detailed: new Set<string>(),
    queue: [] as string[],
  };

  const can = (method: string) => roster.has(`serve:${method}`);
  const ask = (method: string, params: Obj, done: (ok: boolean, result: unknown) => void): void => {
    if (!roster.serve) return done(false, "no serve permission");
    try {
      roster.serve.request(method, params, (r, why) => (why !== undefined ? done(false, why) : done(true, r ?? null)));
    } catch (e) {
      done(false, e);
    }
  };

  // ---------------------------------------------------------------- reading the Mesh

  const askStatus = (): void => {
    ask("mesh.status", { brief: true }, (ok, r) => {
      if (ok) {
        state.status = r as Status;
        state.problem = null;
      } else {
        state.status = null;
        state.problem = `roster serve couldn't say how the Mesh is: ${words.clean(r)}`;
      }
      state.refreshing = false;
      show();
      if (state.again) refresh();
    });
  };

  const refresh = (): void => {
    if (!(can("mesh.status") && can("mesh.job"))) {
      state.status = null;
      state.problem = "Allow serve:mesh.status and serve:mesh.job in :plugins to see the Mesh.";
      return show();
    }
    if (state.refreshing) {
      state.again = true;
      return;
    }
    state.refreshing = true;
    state.again = false;
    if (state.jobs) return askStatus();
    ask("mesh.job", {}, (ok, j) => {
      if (!ok) {
        const e = words.clean(j);
        state.status = null;
        state.refreshing = false;
        state.problem = e.includes("unknown method")
          ? "This roster serve has no Mesh jobs (API 17): update roster to use the Mesh controls."
          : `roster serve couldn't say how the Mesh is: ${e}`;
        return show();
      }
      state.jobs = true;
      const job = j as (Job & { state: string }) | null;
      if (job && job.state === "running" && !state.job) {
        state.job = { job: job.job, action: job.action, host: job.host, total: job.total };
        if (!state.pushed) state.timer = roster.every(POLL, () => poll());
      }
      askStatus();
    });
  };

  // ---------------------------------------------------------------- jobs

  type JobAnswer = Job & { state: string; done: number; at?: string | null; stopped?: boolean; result?: Obj; error?: { message: string } };

  const over = (j: JobAnswer | null): void => {
    if (state.timer !== null) roster.cancel(state.timer);
    state.timer = null;
    state.done = 0;
    roster.progress.remove("mesh");
    const action = state.job?.action ?? "";
    const host = state.job?.host ?? "";
    state.job = null;
    if (j === null) {
      roster.notify("The Mesh's job is gone: roster serve restarted. Plan again to see where it got to.", "warn");
      return refresh();
    }
    if (j.state === "failed") {
      roster.notify(`The Mesh ${action} failed: ${j.error?.message ?? ""}`, "error");
      return refresh();
    }
    const r = j.result as Obj;
    const pendingOf = (r.pending ?? {}) as Record<string, string>;
    const stopped = j.stopped ? `, stopped: ${words.plural(words.keys(pendingOf).length, "Host", "Hosts")} left pending` : "";
    if (action === "plan") {
      const p = r as unknown as Plan;
      state.plan = p;
      state.planned = Math.floor(Date.now() / 1000);
      let n = 0;
      for (const h of p.hosts) if (h.changes.length > 0) n++;
      roster.notify(
        p.already
          ? "Plan ready: the Mesh is as roster.yml says, nothing to apply."
          : `Plan ready: ${words.plural(n, "Host", "Hosts")} would change${stopped}. Press a in :view mesh-plan to apply it.`,
        "info",
        { actions: [{ label: "Show the plan", run: "view mesh-plan" }] },
      );
    } else if (action === "apply") {
      state.plan = null;
      const p = r as unknown as Plan;
      const pending = words.keys(pendingOf).length;
      let changed = 0;
      for (const h of p.hosts) if (h.status === "changed") changed++;
      state.last = p.already
        ? "Applied: already in the Mesh."
        : `Applied: ${words.plural(changed, "Host", "Hosts")} changed${pending > 0 ? `, ${words.count(pending)} pending (the next apply finishes them)` : ""}${stopped}.`;
      roster.notify(state.last, pending > 0 ? "warn" : "info", { quiet: false });
    } else {
      state.plan = null;
      const pending = words.keys(pendingOf);
      const confirmed = (r.confirmed ?? []) as string[];
      state.last = `${host} is cut from the Mesh on ${words.plural(confirmed.length, "Host", "Hosts")}.`;
      roster.notify(state.last, pending.length > 0 ? "warn" : "info", { quiet: false });
      for (const [i0, h] of pending.entries()) {
        if (i0 + 1 > 5) {
          roster.notify(`CUT PENDING on ${words.count(pending.length - 5)} more Hosts: see :view mesh`, "warn");
          break;
        }
        roster.notify(`CUT PENDING on ${h}: ${pendingOf[h] ?? ""}. Until it's done there, ${h} may still let ${host} in. Cut again once it answers.`, "warn");
      }
      for (const w of (r.warnings ?? []) as string[]) roster.notify(w, "warn", { quiet: false });
      const c = (r.change ?? {}) as { error?: string; fix?: string };
      if (c.error) roster.notify(`mesh: false for ${host} wasn't written: ${c.error} (${c.fix ?? ""})`, "warn");
    }
    refresh();
  };

  const stop = (job: number): void => ask("mesh.stop", { job }, () => undefined);

  // The job's progress in the status bar: from mesh.job's answer or a job_progress event.
  const draw = (j: { action: string; done: number; total: number; at?: string | null }): void => {
    const job = state.job;
    if (!job) return;
    state.done = j.done;
    roster.progress.set("mesh", {
      title: (ACTIONS[j.action] ?? j.action) + (job.host ? ` ${job.host} out` : ""),
      text: j.at ? `At ${j.at}` : undefined,
      done: j.done,
      total: j.total,
      cancel: can("mesh.stop") ? () => stop(job.job) : undefined,
    });
    if (j.action === "plan") show();
  };

  const poll = (): void => {
    if (!state.job) return;
    if (state.asking) {
      state.recheck = true;
      return;
    }
    state.asking = true;
    state.recheck = false;
    const following = state.job.job;
    ask("mesh.job", { job: following, brief: true }, (ok, a) => {
      state.asking = false;
      if (!ok || !state.job || state.job.job !== following) return;
      const j = a as JobAnswer | null;
      if (j === null || j.state !== "running") return over(j);
      draw(j);
      if (state.recheck) poll();
    });
  };

  // serve's job_progress (API 20): the progress as it moves, mesh.job asked once it's over.
  if (can("mesh.job")) {
    roster.on("job_progress", (e) => {
      if (e.kind !== "mesh") return;
      state.pushed = true;
      if (state.timer !== null) {
        roster.cancel(state.timer);
        state.timer = null;
      }
      if (!state.job || state.job.job !== e.job) return;
      if (e.state === "running" || e.state === "stopping") return draw(e as unknown as { action: string; done: number; total: number; at?: string | null });
      poll();
    });
  }

  const busy = (): boolean => {
    if (state.starting) {
      roster.notify(`A Mesh ${state.starting} is starting: wait for roster serve to answer.`, "warn");
      return true;
    }
    if (!state.job) return false;
    roster.notify(`A Mesh ${state.job.action} is running: wait for it, or stop it with :cancel mesh.`, "warn");
    return true;
  };

  const allowed = (action: string): boolean => {
    if (can(`mesh.${action}`)) return true;
    roster.notify(`Allow serve:mesh.${action} in :plugins to ${action} the Mesh from here.`, "warn");
    return false;
  };

  const start = (action: string, params: Obj): boolean => {
    if (busy()) return false;
    if (!state.jobs) {
      roster.notify(state.problem ?? "roster serve can't run the Mesh from here.", "warn");
      return false;
    }
    if (!allowed(action)) return false;
    params.background = true;
    state.starting = action;
    ask(`mesh.${action}`, params, (ok, a) => {
      state.starting = null;
      if (!ok) {
        roster.notify(`The Mesh ${action} didn't start: ${words.clean(a)}`, "error");
        return;
      }
      const r = a as Job;
      state.job = { job: r.job, action: r.action, host: r.host, total: r.total };
      state.done = 0;
      if (action === "plan") state.plan = null;
      roster.progress.set("mesh", {
        title: (ACTIONS[action] ?? action) + (r.host ? ` ${r.host} out` : ""),
        done: 0,
        total: r.total,
        cancel: can("mesh.stop") ? () => stop(r.job) : undefined,
      });
      if (state.pushed) poll();
      else state.timer = roster.every(POLL, poll);
      show();
    });
    return true;
  };

  // ---------------------------------------------------------------- what the user does

  const plan = (): void => {
    if (start("plan", {})) roster.views.open("mesh-plan");
  };

  const apply = (): void => {
    if (!allowed("apply") || busy()) return;
    const p = state.plan;
    if (!p) {
      roster.notify("Plan first: here's what an apply would change. Press a when you've looked.", "info", { quiet: false });
      return plan();
    }
    if (p.already) return roster.notify("Nothing to apply: the plan changes nothing.", "info", { quiet: false });
    let change = 0;
    let left = 0;
    for (const h of p.hosts) if (h.changes.length > 0) change++;
    for (const [status, n] of Object.entries(p.link_statuses ?? {})) if (words.LEFT_OUT[status]) left += n;
    roster.confirm({
      title: "Apply the Mesh?",
      text: "roster connects to each Host in turn, one at a time, and writes what the plan shows: Mesh keys in authorized_keys, and each source's ssh config. It applies roster.yml as it is now. A Host that doesn't answer is left pending, and the next apply finishes it.",
      facts: [
        { label: "Hosts that change", value: `${words.count(change)} of ${words.count(p.hosts.length)}` },
        { label: "Links that work", value: words.count(p.link_statuses?.ok ?? 0) },
        { label: "Links left out", value: words.count(left) },
      ],
      action: "Apply",
      run: () => void start("apply", {}),
    });
  };

  const cut = (host: string): void => {
    if (!allowed("cut") || busy()) return;
    const st = state.status;
    const member = (st?.members ?? []).includes(host);
    if (!member || !st) return roster.notify(`${host} isn't in the Mesh: there's nothing to cut.`, "warn");
    roster.confirm({
      title: `Cut ${host} from the Mesh?`,
      text: `Its key comes off every Host it can reach, every peer's key comes off ${host}, and its Mesh files go, on every Host at once. This Box's own access stays.\n\nThen mesh: false for ${host} is written to roster.yml as a Pending change, so the cut survives the next Publish. A Host that doesn't answer gets a warning until the cut is finished there.`,
      facts: [
        { label: "Host", value: host, data: true },
        { label: "reach", value: words.reach(st.reach[host] ?? 0) },
        { label: "reached from", value: words.plural(st.reached[host] ?? 0, "Host", "Hosts") },
      ],
      action: "Cut",
      danger: true,
      typed: host,
      run: () => void start("cut", { host }),
    });
  };

  const explain = (x: Link): void => {
    const lines = [words.link(x), "", `Status  ${words.status(x.status)}`];
    if (x.why) lines.push(`Why     ${x.why}`);
    lines.push("");
    lines.push(words.FIX[x.status ?? "asked"] ?? "");
    roster.float.open({ title: `Link ${words.link(x)}`, lines });
  };

  const links = (): Link[] => (state.plan ?? state.status)?.links ?? [];

  // ---------------------------------------------------------------- drawing

  const hostsOf = (st: Status): string[] => {
    const seen = new Set<string>();
    const add = (h: string) => seen.add(h);
    for (const h of st.members ?? []) add(h);
    for (const h of words.keys(st.excluded)) add(h);
    for (const h of words.keys(st.pending)) add(h);
    for (const h of words.keys(st.cut_pending)) {
      add(h);
      for (const p of st.cut_pending?.[h] ?? []) add(p);
    }
    return sorted([...seen]);
  };

  const linkRows = (list: Link[]) =>
    list.map((x, i) => ({
      id: `l${i + 1}`,
      cells: { from: x.from, to: x.to, via: x.via ?? "", status: words.status(x.status), why: x.why ?? "" },
      tone: x.status && words.LEFT_OUT[x.status] ? "error" : x.status === "pending" ? "warn" : undefined,
    }));

  const index = (row: unknown): number | undefined => {
    const m = /^l(\d+)$/.exec(typeof row === "string" ? row : "");
    return m ? Number(m[1]) : undefined;
  };
  const linkOf = (e: Obj): Link | undefined => {
    const i = index(e.row);
    return i === undefined ? undefined : links()[i - 1];
  };
  const byHost = (e: Obj) => e.host as string;
  const info = (e: Obj): void => {
    roster.views.close(e.view as string);
    roster.cmd(`info ${e.host as string}`);
  };

  const drawDetails = (names: string[]): void => {
    const st = state.status;
    if (!st) return;
    const mine = new Map<string, Link[]>();
    for (const x of links()) {
      for (const h of [x.from, x.to]) {
        const list = mine.get(h) ?? [];
        mine.set(h, list);
        if (list.length < DETAIL_LINKS) list.push(x);
      }
    }
    const members = new Set(st.members ?? []);
    for (const h of names) {
      const [what] = words.state(h, st);
      const section: Obj = {
        title: "Mesh",
        facts: [
          { label: "reach", value: words.reach(st.reach[h] ?? 0) },
          { label: "reached from", value: words.plural(st.reached[h] ?? 0, "Host", "Hosts") },
          { label: "state", value: what },
        ],
      };
      if (members.has(h)) {
        // The Host itself is the facts and the Cut on the heading; the rows are its Links (#176).
        const rows: Obj[] = [];
        for (const [i, x] of (mine.get(h) ?? []).entries()) {
          rows.push({
            id: `l${i + 1}`,
            cells: { link: words.link(x), status: words.status(x.status), member: "yes" },
            tone: x.status && words.LEFT_OUT[x.status] ? "error" : undefined,
          });
        }
        section.text = rows.length === 0 ? "Every Link of this Host works as roster.yml asks." : "The Links worth a look: a hop (via) or a problem.";
        if (rows.length > 0) {
          section.table = {
            columns: [
              { id: "link", label: "Link", kind: "data" },
              { id: "status", label: "Status" },
            ],
            rows,
            open: (e: Obj) => {
              const i = index(e.row);
              const x = i === undefined ? undefined : (mine.get(e.host as string) ?? [])[i - 1];
              if (x) explain(x);
            },
          };
        }
        section.actions = [{ label: `Cut ${h} from the Mesh`, key: "x", icon: "cut", run: (e: Obj) => cut(e.host as string) }];
      }
      roster.details.set("mesh", h, section);
      state.detailed.add(h);
    }
  };

  const details = (): void => {
    const st = state.status;
    const all = st ? hostsOf(st) : [];
    const now = new Set(all);
    for (const h of sorted([...state.detailed])) {
      if (!now.has(h)) {
        roster.details.set("mesh", h, null);
        state.detailed.delete(h);
      }
    }
    drawDetails(all.slice(0, DETAILS_AT_ONCE));
    state.queue = all.slice(DETAILS_AT_ONCE);
    const more = (): void => {
      drawDetails(state.queue.splice(0, DETAILS_AT_ONCE));
      if (state.queue.length > 0) roster.defer(50, more);
    };
    if (state.queue.length > 0) roster.defer(50, more);
  };

  const badges = (st: Status | null): void => {
    const want = new Map<string, string>();
    for (const c of words.keys(st?.cut_pending)) {
      want.set(c, "cut pending");
      for (const p of st?.cut_pending?.[c] ?? []) want.set(p, "cut pending");
    }
    for (const h of words.keys(st?.pending)) if (!want.has(h)) want.set(h, "pending");
    const names = sorted([...want.keys(), ...[...state.badged].filter((h) => !want.has(h))]);
    for (const h of names) roster.badges.set(h, want.get(h) ?? null);
    state.badged = new Set(want.keys());
  };

  const segment = (st: Status | null): void => {
    if (state.job || !st) return roster.status.remove("mesh");
    const cuts = words.keys(st.cut_pending);
    const pending = words.keys(st.pending);
    if (cuts.length > 0) {
      roster.status.set("mesh", { text: "Cut pending", title: "A cut isn't finished on every Host: :view mesh", run: "view mesh" });
    } else if (st.out_of_date) {
      roster.status.set("mesh", { text: "Mesh out of date", title: "roster.yml changed the Mesh since the last apply: plan it, then apply", run: "mesh plan" });
    } else if (pending.length > 0) {
      roster.status.set("mesh", { text: `Mesh: ${words.count(pending.length)} pending`, title: "Hosts that didn't answer: the next apply finishes them", run: "view mesh" });
    } else roster.status.remove("mesh");
  };

  const overview = (st: Status | null): [string[], Obj[]] => {
    if (!st) return [[state.problem ?? "Loading…"], []];
    const count = st.link_count ?? st.links.length;
    const statuses = st.link_statuses ?? {};
    const text: string[] = [];
    const members = st.members ?? [];
    if (members.length === 0) text.push("No Hosts are in the Mesh. Set mesh: true on a group in roster.yml, or add links:, then Publish.");
    else
      text.push(
        `${words.plural(members.length, "Host", "Hosts")} in the Mesh, ${words.plural(count, "Link", "Links")}. Each Host's reach is who it can log in to with its Mesh key: the risk if it's taken over.`,
      );
    if (st.out_of_date) text.push("roster.yml changed the Mesh since the last apply on this Box: plan it (p), then apply it (a).");
    if ((statuses["no-via"] ?? 0) > 0) {
      text.push(`${words.plural(statuses["no-via"] ?? 0, "Link goes", "Links go")} through a jump Host its source has no Link to (no-via): see :view mesh-links.`);
    }
    if (state.last) text.push(state.last);
    const facts = [
      { label: "Hosts", value: words.count(members.length) },
      { label: "Links", value: words.count(count) },
      { label: "out of date", value: st.out_of_date ? "yes" : "no" },
      { label: "pending", value: words.count(words.keys(st.pending).length) },
      { label: "cut pending", value: words.count(words.keys(st.cut_pending).length) },
    ];
    return [text, facts];
  };

  const views = (): void => {
    const st = state.status;
    const [text, facts] = overview(st);
    const members = new Set(st?.members ?? []);
    const rows = (st ? hostsOf(st) : []).map((h, i) => {
      const [what, tone] = words.state(h, st as Status);
      return {
        id: words.id(h, i + 1),
        host: h,
        tone,
        cells: { host: h, reach: st?.reach[h] ?? 0, reached: st?.reached[h] ?? 0, state: what, member: members.has(h) ? "yes" : "no" },
      };
    });
    roster.views.set("mesh", {
      title: "Mesh",
      place: "full",
      actions: [
        { label: "Plan", icon: "plan", run: plan },
        { label: "Apply", icon: "apply", run: apply },
      ],
      text: text.join("\n\n"),
      facts,
      table: {
        columns: [
          { id: "host", label: "Host", kind: "data" },
          { id: "reach", label: "Can reach", kind: "number" },
          { id: "reached", label: "Reached from", kind: "number" },
          { id: "state", label: "State" },
        ],
        rows,
        sort: "host",
        empty: st ? "No Hosts in the Mesh." : (state.problem ?? "Loading…"),
        open: info,
        actions: [
          { label: "Plan", key: "p", icon: "plan", run: plan },
          { label: "Apply", key: "a", icon: "apply", run: apply },
          { label: "Links", key: "l", run: () => roster.views.open("mesh-links") },
          { label: "Cut", key: "x", icon: "cut", when: { member: "yes" }, run: (e: Obj) => cut(byHost(e)) },
        ],
      },
    });

    const list = links();
    const from = state.plan ?? st;
    const ltext: string[] = [];
    if (from) {
      const statuses = from.link_statuses ?? {};
      const parts = words.keys(statuses).map((s) => `${words.count(statuses[s] ?? 0)} ${words.status(s)}`);
      ltext.push(`${words.plural(from.link_count ?? list.length, "Link", "Links")}${parts.length > 0 ? `: ${parts.join(", ")}` : ""}.`);
      const more = from.links_more ?? 0;
      ltext.push(
        `Listed: the Links that go through a jump Host (via) or have a problem${more > 0 ? `, the first ${words.count(list.length)} of ${words.count(list.length + more)}` : ""}${state.plan ? "" : ". Plan the Mesh to test them all"}.`,
      );
      ltext.push(
        "no-via: the Link goes through a jump Host its source has no Link to. ssh logs in to the jump Host first, so add a Link from the source to it in roster.yml, or take via: off.",
      );
    } else ltext.push(state.problem ?? "Loading…");
    roster.views.set("mesh-links", {
      title: "Mesh Links",
      place: "full",
      text: ltext.join("\n\n"),
      table: {
        columns: [
          { id: "from", label: "From", kind: "data" },
          { id: "to", label: "To", kind: "data" },
          { id: "via", label: "Via", kind: "data" },
          { id: "status", label: "Status", width: 18 },
          { id: "why", label: "Why" },
        ],
        rows: linkRows(list),
        empty: "No Link goes through a jump Host or has a problem.",
        open: (e: Obj) => {
          const x = linkOf(e);
          if (x) explain(x);
        },
        actions: [
          {
            label: "Explain",
            key: "e",
            run: (e: Obj) => {
              const x = linkOf(e);
              if (x) explain(x);
            },
          },
          { label: "Plan", key: "p", run: plan },
        ],
      },
    });

    const p = state.plan;
    const ptext: string[] = [];
    let pfacts: Obj[] = [];
    const prows: Obj[] = [];
    if (state.job && state.job.action === "plan") {
      ptext.push(`Planning: roster connects to each Host in turn and changes nothing. ${words.count(state.done)} of ${words.plural(state.job.total, "step", "steps")} so far.`);
    } else if (p) {
      let change = 0;
      for (const [i, h] of p.hosts.entries()) {
        if (h.changes.length > 0) change++;
        const what = h.changes.join("; ") + ((h.more ?? 0) > 0 ? `; and ${words.count(h.more ?? 0)} more` : "");
        prows.push({
          id: words.id(h.host, i + 1),
          host: h.host,
          tone: h.status === "pending" ? "warn" : h.changes.length === 0 ? "muted" : undefined,
          cells: { host: h.host, status: h.status === "would-change" ? "would change" : h.status, changes: h.error ?? what },
        });
      }
      ptext.push(
        `Planned at ${clock(state.planned)}. ${p.already ? "The Mesh is as roster.yml says: nothing to apply." : `${words.plural(change, "Host", "Hosts")} would change. Apply it with a: you're asked first.`}`,
      );
      for (const w of p.warnings ?? []) ptext.push(w);
      pfacts = [
        { label: "Hosts that change", value: `${words.count(change)} of ${words.count(p.hosts.length)}` },
        { label: "pending", value: words.count(words.keys(p.pending).length) },
      ];
    } else {
      ptext.push("No plan yet. Plan the Mesh (p): roster connects to each Host and shows what an apply would change, without changing anything.");
    }
    roster.views.set("mesh-plan", {
      title: "Mesh plan",
      place: "full",
      actions: [
        { label: "Apply", icon: "apply", run: apply },
        { label: "Plan again", icon: "plan", run: plan },
      ],
      text: ptext.join("\n\n"),
      facts: pfacts,
      table: {
        columns: [
          { id: "host", label: "Host", kind: "data" },
          { id: "status", label: "Status", width: 14 },
          { id: "changes", label: "Changes" },
        ],
        rows: prows,
        sort: "host",
        empty: "Nothing planned yet.",
        open: info,
        actions: [
          { label: "Apply", key: "a", icon: "apply", run: apply },
          { label: "Plan again", key: "p", icon: "plan", run: plan },
          { label: "Links", key: "l", run: () => roster.views.open("mesh-links") },
        ],
      },
    });
  };

  const show = (): void => {
    segment(state.status);
    badges(state.status);
    views();
    details();
  };

  // ---------------------------------------------------------------- commands, keys, help

  roster.commands.add("mesh", {
    desc: "The Mesh: who reaches whom; :mesh plan, apply, links, cut HOST",
    run: (a: Obj) => {
      const w = (a.words as string[])[0];
      const second = (a.words as string[])[1];
      if (w === undefined) {
        refresh();
        return roster.views.open("mesh");
      } else if (w === "plan") return plan();
      else if (w === "apply") return apply();
      else if (w === "links") return roster.views.open("mesh-links");
      else if (w === "cut" && second) return cut(second);
      roster.notify(`:mesh ${a.args as string}: there's :mesh, :mesh plan, :mesh apply, :mesh links and :mesh cut HOST`, "warn");
    },
  });

  if (settings.leader) roster.keymap.set("leader", settings.leader, "mesh");

  roster.help.set("mesh-controls", { title: "Mesh controls", summary: "The Mesh in the app: reach, plan and apply, Cut", markdown: HELP });

  if (roster.has("inventory.read")) roster.on("inventory_changed", () => refresh());

  roster.defer(50, refresh);
  show();
}

// ------------------------------------------------------------------ a stand-in roster serve

export interface MeshWorld {
  /** Hosts in `lab`, a meshed group: every pair is a Link. */
  lab: number;
  /** A name for the Nth extra Host (the worst case's long names). */
  name?: (i: number) => string;
  /** serve has API 17's jobs. */
  jobs?: boolean;
  outOfDate?: boolean;
  /** Polls of mesh.job a job answers "running" before it's done. */
  ticks?: number;
}

/** The meshed group's Hosts, in name order: esx-02, nas-1, orion-2, orion-3, then `lab-004`… */
export function meshLab(world: MeshWorld): string[] {
  const names = ["esx-02", "orion-2", "orion-3", "nas-1"];
  for (let i = names.length; i < world.lab; i++) names.push(world.name ? world.name(i) : `lab-${String(i).padStart(3, "0")}`);
  return sorted(names.slice(0, world.lab));
}

/** The Hosts the stand-in's Mesh names besides the meshed group: db-9 (behind jump-1) and sw-1 (kept out). */
export const MESH_OTHERS = ["db-9", "jump-1", "sw-1"];

/** roster serve's Mesh methods (API 17) as the Rust test's stand-in answers them: `lab` meshed, a
 * Link through jump-1 with no Link to it (no-via), sw-1 kept out, nas-1 down for a cut. */
export function meshServe(world: MeshWorld): (method: string, params: Obj) => unknown {
  const w = { jobs: true, outOfDate: true, ticks: 1, ...world };
  let cutPending: Record<string, string[]> = {};
  let job: { number: number; action: string; host?: string | undefined; total: number; left: number; stopped: boolean } | null = null;
  const lab = meshLab(w);
  const n = lab.length;
  const noVia = { from: "orion-3", to: "db-9", kind: "key", via: "jump-1", status: "no-via", why: "orion-3 has no Link to jump-1, its hop to db-9 (add { from: orion-3, to: jump-1 })" };
  const status = (): Obj => ({
    links: [noVia],
    links_more: 0,
    link_count: n * (n - 1) + 1,
    link_statuses: { asked: n * (n - 1), "no-via": 1 },
    excluded: { "sw-1": "mesh: false" },
    reach: Object.fromEntries(lab.map((h) => [h, n - 1])),
    reached: Object.fromEntries(lab.map((h) => [h, n - 1])),
    members: sorted([...lab, "db-9"]),
    pending: {},
    cut_pending: cutPending,
    out_of_date: w.outOfDate,
  });
  const result = (j: NonNullable<typeof job>): Obj => {
    if (j.action === "cut") {
      const peers = lab.filter((h) => h !== j.host);
      return {
        host: j.host,
        confirmed: peers.filter((h) => h !== "nas-1"),
        pending: { "nas-1": "no answer: ssh: connect to host nas-1 port 22: Connection timed out" },
        warnings: [`${j.host ?? ""}: /srv/mesh holds an earlier Mesh key that roster no longer uses (mesh_dir: changed), so delete it by hand`],
        change: { written: true, backup: "/home/you/.config/roster/backup/roster.yml" },
      };
    }
    const apply = j.action === "apply";
    const hosts = lab.map((h) =>
      h === "nas-1" && !j.stopped
        ? { host: h, status: "same", changes: [] }
        : j.stopped && h !== "esx-02"
          ? { host: h, status: "pending", changes: [], error: "stopped: not visited (the next roster mesh finishes it)" }
          : { host: h, status: apply ? "changed" : "would-change", changes: ["make key", "write ssh config", `add key from ${lab[0] ?? ""}`] },
    );
    const rest = status();
    delete rest.members;
    delete rest.out_of_date;
    return {
      ...rest,
      applied: apply,
      hosts,
      pending: Object.fromEntries(hosts.filter((h) => h.status === "pending").map((h) => [h.host, h.error])),
      already: false,
      warnings: ["orion-3: ~/ROSTER.md isn't roster's, so roster left it alone (move it away and apply again)"],
      links: [noVia, { from: "orion-2", to: "nas-1", kind: "key", status: "unreachable", why: "orion-2 can't reach 10.0.0.30:22" }],
      link_statuses: { ok: n * (n - 1) - 1, unreachable: 1, "no-via": 1 },
    };
  };
  return (method, params) => {
    switch (method) {
      case "mesh.job": {
        if (!w.jobs) throw new Error("unknown method 'mesh.job' (code -32601)");
        if (!job || (params.job !== undefined && params.job !== job.number)) return null;
        const v: Obj = { job: job.number, action: job.action, state: "running", total: job.total, done: job.total - job.left, at: "orion-2", stopped: job.stopped };
        if (job.host) v.host = job.host;
        if (job.left > 0 && !job.stopped) {
          job.left--;
          return v;
        }
        const r = result(job);
        if (job.action === "apply") w.outOfDate = false;
        if (job.action === "cut" && job.host) cutPending = { [job.host]: ["nas-1"] };
        return { ...v, state: "done", done: job.total, at: null, result: r };
      }
      case "mesh.status":
        return status();
      case "mesh.stop": {
        const stopping = job !== null && job.number === params.job && job.left > 0;
        if (stopping && job) job.stopped = true;
        return { job: params.job, stopping };
      }
      case "mesh.plan":
      case "mesh.apply":
      case "mesh.cut": {
        if (params.background !== true) throw new Error(`${method} without background would hold the Plugin (code -1)`);
        if (job && job.left > 0) throw new Error("a Mesh job is still running (code 111)");
        const action = method.slice(5);
        const host = typeof params.host === "string" ? params.host : undefined;
        const number = job ? job.number + 1 : 1;
        const total = action === "cut" ? n - 1 : 2 * n;
        job = { number, action, host, total, left: w.ticks, stopped: false };
        return { job: number, action, total, ...(host ? { host } : {}) };
      }
      default:
        throw new Error(`unknown method '${method}' (code -32601)`);
    }
  };
}
