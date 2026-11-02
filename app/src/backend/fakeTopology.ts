// Ticket 40: the fake Backend's stand-in for plugins/topology, the Topology view. TypeScript shaped
// like its Lua (init.lua and lua/topology/build.lua), step for step, so the UI tests and
// `?fixture=topology` test the real Plugin's behaviour: topology.test.ts replays the transcript
// crates/roster-core/tests/plugin_topology.rs recorded from the Lua and checks this does the same.
// Change the Lua, record the transcript again, and change this to match.
import type { FakePlugin, FakeRoster } from "./fakePlugins";
import type { Host, HostList } from "./types";

type Obj = Record<string, unknown>;
type Edge = { id: string; from: string; to: string; dir?: string; style?: string; tone?: string; cut?: boolean; label?: string };
type Cluster = { id: string; title: string; mesh?: boolean; members: string[] };
type Link = { from: string; to: string; kind?: string; via?: string; skip?: string };

export const TOPOLOGY_PERMISSIONS = ["inventory.read", "serve:mesh.status", "serve:host.check", "serve:mesh.cut", "serve:mesh.job", "serve:host.check_job"];

const BOX = ":box";
const MAX_HOSTS = 4999;
const MAX_EDGES = 9000;

const gid = (name: string, part?: string) => `:group:${name}${part ? `/${part}` : ""}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
/** Lua's `pairs`: keys in order. */
const keys = (o: unknown) => Object.keys((o ?? {}) as Obj).sort();
/** Leaves out what's nil, as a Lua table does. */
const plain = <T extends Obj>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T;

export function settingsOf(config: Obj): { settings: { leader: string; refresh: number }; problems: string[] } {
  const settings = { leader: "T", refresh: 60 };
  const problems: string[] = [];
  if (config.leader !== undefined) {
    if (typeof config.leader === "string" && /\S/.test(config.leader)) settings.leader = config.leader;
    else problems.push('topology: leader must be the keys after the Leader, such as "T"');
  }
  if (config.refresh !== undefined) {
    const r = config.refresh;
    if (typeof r === "number" && Number.isInteger(r) && r >= 10 && r <= 3600) settings.refresh = r;
    else problems.push("topology: refresh must be a whole number of seconds from 10 to 3600");
  }
  return { settings, problems };
}

const password = (h: Host) => {
  const auth = h.ssh?.auth;
  return !h.enroll && auth !== "agent" && auth !== "key" && auth !== "none";
};

interface Structure {
  hosts: Map<string, Host>;
  order: string[];
  clusters: Cluster[];
  clusterOf: Map<string, string>;
  edges: Edge[];
  involved: Set<string>;
  out: Map<string, number>;
  in: Map<string, number>;
  skipped: Map<string, number>;
  nohop: Map<string, string>;
  mesh: Obj | null;
  trimmed: number;
  cut: number;
  links: number;
  groups: number;
}

const bump = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by);

export function structure(hosts: readonly Host[], groups: Record<string, { title?: string }>, mesh: Obj | null): Structure {
  const s: Structure = {
    hosts: new Map(),
    order: [],
    clusters: [],
    clusterOf: new Map(),
    edges: [],
    involved: new Set(),
    out: new Map(),
    in: new Map(),
    skipped: new Map(),
    nohop: new Map(),
    mesh,
    trimmed: 0,
    cut: 0,
    links: 0,
    groups: 0,
  };
  for (const h of hosts) {
    if (s.order.length >= MAX_HOSTS) s.trimmed++;
    else if (typeof h.name === "string") {
      s.order.push(h.name);
      s.hosts.set(h.name, h);
    }
  }
  const meshed: { group: string; keys: string[]; peers: string[] }[] = [];
  const meshOf = new Map<string, (typeof meshed)[number]>();
  if (mesh && typeof mesh.meshed === "object" && mesh.meshed !== null) {
    const groupsMeshed = mesh.meshed as Record<string, string[]>;
    for (const g of keys(groupsMeshed)) {
      const m = { group: g, keys: [] as string[], peers: [] as string[] };
      for (const n of groupsMeshed[g] ?? []) {
        const h = s.hosts.get(n);
        if (h) (h.enroll ? m.keys : m.peers).push(n);
      }
      const all = m.keys.length + m.peers.length;
      if (all > 1) {
        for (const n of [...m.keys, ...m.peers]) meshOf.set(n, m);
        meshed.push(m);
        for (const n of m.keys) {
          s.involved.add(n);
          bump(s.out, n, all - 1);
          bump(s.in, n, m.keys.length - 1);
        }
        for (const n of m.peers) {
          s.involved.add(n);
          bump(s.skipped, n, all - 1);
          bump(s.in, n, m.keys.length);
        }
        s.links += m.keys.length * (all - 1);
      }
    }
  }
  const pair = new Map<string, Link>();
  const working: Link[] = [];
  if (mesh) {
    for (const l of (mesh.links ?? []) as Link[]) {
      if (!s.hosts.has(l.from) || !s.hosts.has(l.to)) continue;
      if (l.skip) bump(s.skipped, l.from);
      else {
        working.push(l);
        pair.set(`${l.from}>${l.to}`, l);
        s.involved.add(l.from);
        s.involved.add(l.to);
        bump(s.out, l.from);
        bump(s.in, l.to);
      }
    }
  }
  s.links += working.length;

  const list: string[] = [];
  const members = new Map<string, string[]>();
  for (const name of s.order) {
    const g = s.hosts.get(name)?.group ?? "";
    if (!members.has(g)) {
      list.push(g);
      members.set(g, []);
    }
    members.get(g)?.push(name);
  }
  s.groups = list.length;
  const byId = new Map<string, Cluster>();
  const add = (id: string, title: string, names: string[]) => {
    if (names.length === 0) return;
    const c: Cluster = { id, title, members: names };
    s.clusters.push(c);
    byId.set(id, c);
    for (const n of names) s.clusterOf.set(n, id);
  };
  for (const g of list) {
    const info = groups[g];
    const title = info && typeof info.title === "string" && info.title !== "" ? info.title : g;
    const names = members.get(g) ?? [];
    if (!names.some((n) => s.involved.has(n))) add(gid(g), title, names);
    else {
      const main: string[] = [];
      const peers: string[] = [];
      const rest: string[] = [];
      for (const n of names) {
        if (!s.involved.has(n)) rest.push(n);
        else if (s.hosts.get(n)?.enroll) main.push(n);
        else peers.push(n);
      }
      add(gid(g), title, main);
      add(gid(g, "peers"), `${title} · password peers`, peers);
      add(gid(g, "out"), `${title} · not in the Mesh`, rest);
    }
  }

  const raw: { from: string; to: string; style: string; tone?: string; label?: string; dir?: string; gone?: boolean }[] = [];
  const emit = (from: string, to: string, kind: string) => {
    const e: (typeof raw)[number] = { from, to, style: kind === "password" ? "dashed" : "solid" };
    raw.push(e);
    return e;
  };
  const exactly = (c: Cluster | undefined, names: string[]) => {
    if (!c) return names.length === 0;
    if (c.members.length !== names.length) return false;
    const set = new Set(names);
    return c.members.every((n) => set.has(n));
  };
  meshed.sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
  for (const m of meshed) {
    const main = byId.get(gid(m.group));
    const peers = byId.get(gid(m.group, "peers"));
    if (exactly(main, m.keys) && exactly(peers, m.peers)) {
      if (m.keys.length > 1 && main) main.mesh = true;
      if (m.keys.length > 0 && m.peers.length > 0 && main && peers) emit(main.id, peers.id, "password");
    } else {
      const all = [...m.keys, ...m.peers];
      for (const a of m.keys)
        for (const b of all)
          if (a !== b) {
            const l: Link = { from: a, to: b, kind: s.hosts.get(b)?.enroll ? "key" : "password" };
            working.push(l);
            pair.set(`${a}>${b}`, l);
          }
    }
  }

  const buckets: { from: string; to: string; kind: string; via?: string; pairs: Link[] }[] = [];
  const bucketAt = new Map<string, (typeof buckets)[number]>();
  for (const l of working) {
    const cf = s.clusterOf.get(l.from) as string;
    const ct = s.clusterOf.get(l.to) as string;
    const key = [cf, ct, l.kind ?? "key", l.via ?? ""].join("\u0000");
    let b = bucketAt.get(key);
    if (!b) {
      b = { from: cf, to: ct, kind: l.kind ?? "key", ...(l.via ? { via: l.via } : {}), pairs: [] };
      bucketAt.set(key, b);
      buckets.push(b);
    }
    b.pairs.push(l);
  }
  for (const b of buckets) {
    const F = byId.get(b.from)?.members ?? [];
    const T = byId.get(b.to)?.members ?? [];
    const same = b.from === b.to;
    const need = same ? F.length * (F.length - 1) : F.length * T.length;
    if (!b.via && b.pairs.length === need) {
      const c = byId.get(b.from);
      if (same && c) c.mesh = true;
      else emit(b.from, b.to, b.kind);
    } else if (b.via) {
      for (const l of b.pairs) {
        const e = emit(l.from, l.to, b.kind);
        const via = l.via as string;
        const m = meshOf.get(l.from);
        const hop = pair.has(`${l.from}>${via}`) || (m !== undefined && m === meshOf.get(via) && s.hosts.get(l.from)?.enroll);
        if (hop) e.label = `via ${via}`;
        else {
          e.label = `via ${via}, but ${l.from} has no Link to it`;
          e.tone = "error";
          s.nohop.set(l.from, via);
        }
      }
    } else {
      const perFrom = new Map<string, number>();
      const perTo = new Map<string, number>();
      for (const l of b.pairs) bump(perFrom, l.from);
      const left: Link[] = [];
      for (const l of b.pairs) {
        const want = T.length - (same ? 1 : 0);
        if (want > 1 && perFrom.get(l.from) === want) {
          emit(l.from, b.to, b.kind);
          perFrom.set(l.from, 0);
        } else if (perFrom.get(l.from) !== 0) left.push(l);
      }
      for (const l of left) bump(perTo, l.to);
      for (const l of left) {
        const want = F.length - (same ? 1 : 0);
        if (want > 1 && perTo.get(l.to) === want) {
          emit(b.from, l.to, b.kind);
          perTo.set(l.to, 0);
        } else if (perTo.get(l.to) !== 0) emit(l.from, l.to, b.kind);
      }
    }
  }

  const keyOf = (e: (typeof raw)[number], from: string, to: string) => [from, to, e.style, e.tone ?? "", e.label ?? ""].join("\u0000");
  const at = new Map<string, number>();
  raw.forEach((e, i) => at.set(keyOf(e, e.from, e.to), i));
  raw.forEach((e, i) => {
    if (e.gone) return;
    const j = at.get(keyOf(e, e.to, e.from));
    const back = j === undefined ? undefined : raw[j];
    if (back && j !== i && !back.gone) {
      back.gone = true;
      e.dir = "both";
    }
    if (s.edges.length >= MAX_EDGES) s.cut++;
    else s.edges.push(plain({ id: `mesh:${e.from}>${e.to}`, from: e.from, to: e.to, dir: e.dir, style: e.style, tone: e.tone, label: e.label }) as Edge);
  });

  if (mesh) {
    const cuts = (mesh.cut_pending ?? {}) as Record<string, string[]>;
    for (const host of keys(cuts)) {
      if (!s.hosts.has(host)) continue;
      for (const p of cuts[host] ?? [])
        if (s.hosts.has(p) && s.edges.length < MAX_EDGES)
          s.edges.push({ id: `cut:${host}>${p}`, from: host, to: p, dir: "both", style: "dotted", tone: "error", cut: true, label: "cut pending" });
    }
  }
  return s;
}

export function graphOf(s: Structure, live: Map<string, Set<number>>, down: Map<string, string>, ended: Set<string>) {
  const mesh = s.mesh ?? {};
  const cutPending = (mesh.cut_pending ?? {}) as Record<string, string[]>;
  const pending = (mesh.pending ?? {}) as Record<string, string>;
  const nodes: Obj[] = [{ id: BOX, label: "This Box", shape: "square", kind: "box" }];
  const edges: Obj[] = [];
  const clusters: Obj[] = [];
  for (const c of s.clusters) {
    clusters.push(plain({ id: c.id, title: c.title, mesh: c.mesh }));
    edges.push({ id: `box>${c.id}`, from: BOX, to: c.id, tone: "muted" });
  }
  edges.push(...s.edges);
  for (const name of s.order) {
    const h = s.hosts.get(name) as Host;
    const isLive = (live.get(name)?.size ?? 0) > 0;
    let shape = "dot";
    if (h.reviewed === false) shape = "dashed";
    else if (ended.has(name) && !isLive) shape = "hollow";
    else if (password(h)) shape = "ring";
    let mark: string | undefined;
    let note: string | undefined;
    if (cutPending[name]) [mark, note] = ["error", `cut pending on ${plural(cutPending[name].length, "Host")}`];
    else if (down.has(name) && !isLive) note = down.get(name);
    else if (pending[name]) [mark, note] = ["warn", "Mesh pending"];
    else if (s.nohop.has(name)) [mark, note] = ["warn", `no Link to its hop ${s.nohop.get(name) ?? ""}`];
    nodes.push(
      plain({
        id: name,
        label: name,
        host: name,
        cluster: s.clusterOf.get(name),
        kind: typeof h.type === "string" && h.type !== "" ? h.type : undefined,
        detail: h.ip,
        shape,
        state: isLive ? "live" : down.has(name) ? "down" : undefined,
        mark,
        note,
      }),
    );
    if (isLive) edges.push({ id: `live:${name}`, from: BOX, to: name, tone: "live" });
  }
  return { nodes, edges, clusters };
}

export function textOf(s: Structure, why: { reads: boolean; mesh: boolean; error?: string | undefined; inventoryError?: string | undefined }): string {
  const lines: string[] = [];
  if (!why.reads) lines.push("Allow inventory.read in :plugins to see your Hosts: only this Box is on the map.");
  else if (why.inventoryError) lines.push(`Your Hosts couldn't be read: ${why.inventoryError}`);
  else {
    let line = `${plural(s.order.length, "Host")} in ${plural(s.groups, "group")}.`;
    if (s.trimmed > 0) line += ` ${plural(s.trimmed, "more Host")} left out: a map holds 5,000.`;
    lines.push(line);
  }
  if (!why.mesh) lines.push("Allow serve:mesh.status in :plugins to see the Mesh.");
  else if (why.error) lines.push(`The Mesh isn't shown: ${why.error}`);
  else if (s.mesh) {
    const m = s.mesh;
    let line = `The Mesh: ${plural(s.involved.size, "Host")}, ${plural(s.links, "Link")}.`;
    if (s.cut > 0) line += ` ${plural(s.cut, "edge")} left out: a map holds 10,000.`;
    lines.push(line);
    if (m.out_of_date) lines.push("The Mesh is out of date: roster.yml changed it since the last apply on this Box (roster mesh).");
    const cuts = keys(m.cut_pending).length;
    if (cuts > 0) lines.push(`Cut pending on ${plural(cuts, "Host")}: a peer didn't answer, so its key may still be there.`);
    const waiting = keys(m.pending).length;
    if (waiting > 0) lines.push(`${plural(waiting, "Host")} didn't answer the last apply (Mesh pending).`);
  }
  return lines.join("\n\n");
}

export function detailsOf(s: Structure, name: string): Obj | null {
  const m = s.mesh;
  if (!m) return null;
  const excluded = (m.excluded as Record<string, string> | undefined)?.[name];
  const cut = (m.cut_pending as Record<string, string[]> | undefined)?.[name];
  const pend = (m.pending as Record<string, string> | undefined)?.[name];
  if (!(s.involved.has(name) || excluded || cut || pend || s.skipped.has(name))) return null;
  const facts: Obj[] = [];
  const h = s.hosts.get(name);
  if (excluded) facts.push({ label: "In the Mesh", value: `no: ${excluded}` });
  else if (s.involved.has(name)) facts.push({ label: "In the Mesh", value: h && !h.enroll ? "yes, as a password peer: it's reached, and reaches no one" : "yes" });
  facts.push({ label: "Reaches", value: `${plural(s.out.get(name) ?? 0, "Host")} directly` });
  facts.push({ label: "Reached by", value: `${plural(s.in.get(name) ?? 0, "Host")} directly` });
  if (s.skipped.has(name)) facts.push({ label: "Not written", value: `${plural(s.skipped.get(name) ?? 0, "Link")} from it: roster doesn't write on a password Host` });
  if (s.nohop.has(name)) facts.push({ label: "Hop", value: `no Link to ${s.nohop.get(name) ?? ""}` });
  if (pend) facts.push({ label: "Pending", value: pend });
  if (cut) facts.push({ label: "Cut pending on", value: cut.join(", "), data: true });
  return { title: "Reach", text: "Directly is its own Mesh keys. Selected in :topology, it counts every hop: what those Hosts' own keys reach too.", facts };
}

const FIELDS = ["id", "label", "title", "host", "cluster", "kind", "detail", "shape", "state", "mark", "note", "from", "to", "dir", "style", "tone", "cut", "mesh"];
const sig = (t: Obj) => FIELDS.map((f) => (t[f] === undefined ? "" : String(t[f]))).join("\u0001");
const detailsSig = (d: Obj) => [d.title, d.text, ...(d.facts as Obj[]).map((f) => `${String(f.label)}=${String(f.value)}`)].join("\u0001");

function diff(before: Map<string, string> | null, items: Obj[]): [Obj[], string[], Map<string, string>] {
  const now = new Map<string, string>();
  const changed: Obj[] = [];
  for (const it of items) {
    const sg = sig(it);
    now.set(it.id as string, sg);
    if (!before || before.get(it.id as string) !== sg) changed.push(it);
  }
  const gone = before ? [...before.keys()].filter((id) => !now.has(id)).sort() : [];
  return [changed, gone, now];
}

export function groupClusters(s: Structure, word: string): string[] {
  const w = word.toLowerCase();
  let base: string | undefined;
  for (const c of s.clusters) {
    const b = c.id.replace(/\/peers$/, "").replace(/\/out$/, "");
    const title = c.title.replace(/ · password peers$/, "").replace(/ · not in the Mesh$/, "");
    if (b.slice(":group:".length).toLowerCase() === w || title.toLowerCase() === w) {
      base = b;
      break;
    }
  }
  if (!base) return [];
  return s.clusters.filter((c) => c.id === base || c.id === `${base}/peers` || c.id === `${base}/out`).map((c) => c.id);
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** plugins/topology, as its Lua. */
export function topologyPlugin(): FakePlugin {
  return {
    manifest: {
      name: "topology",
      version: "1.1.0",
      description: "The Topology view: this Box, your Hosts by group, the Mesh and its Links as a map",
      author: "roster",
      api: 4,
      permissions: TOPOLOGY_PERMISSIONS,
    },
    load(roster: FakeRoster) {
      const { settings, problems } = settingsOf(roster.plugin.config);
      for (const p of problems) roster.notify(`${p}; using the default`, "warn");
      const reads = roster.has("inventory.read");
      const canMesh = roster.has("serve:mesh.status");
      const canCheck = roster.has("serve:host.check");
      const canCut = roster.has("serve:mesh.cut");
      const canJob = roster.has("serve:mesh.job");
      const canHearChecks = roster.has("serve:host.check_job");
      const VIEW = "topology";
      const live = new Map<string, Set<number>>();
      const down = new Map<string, string>();
      const ended = new Set<string>();
      let mesh: Obj | null = null;
      let meshError: string | undefined;
      let s = structure([], {}, null);
      let sent: { nodes: Map<string, string>; edges: Map<string, string>; clusters: Map<string, string> } | null = null;
      let sentText = "";
      let detailed = new Map<string, string>();
      const queued: string[] = [];
      let flushing = false;
      let filtered = false;
      let inventoryError: string | undefined;
      let hosts: Host[] | null = null;
      let groups: Record<string, { title?: string }> = {};

      const ask = (method: string, params: Obj, done: (r: unknown, why?: string) => void) => {
        try {
          if (!roster.serve) throw new Error("roster.serve: no serve permission");
          roster.serve.request(method, params, (r, why) => done(r, why));
        } catch (e) {
          done(undefined, errorText(e));
        }
      };
      const clean = (why: unknown) => String(why).replace(/^.*?roster\.serve\.request [\w._]+: /, "");
      const readInventory = () => {
        [hosts, groups, inventoryError] = [[], {}, undefined];
        if (!reads || !roster.inventory) return;
        try {
          hosts = roster.inventory.hosts();
          groups = roster.inventory.groups();
        } catch (e) {
          inventoryError = errorText(e);
        }
      };
      const restructure = () => {
        if (!hosts) readInventory();
        s = structure(hosts ?? [], groups, mesh);
      };
      const flush = () => {
        flushing = false;
        let n = 0;
        while (queued.length > 0 && n < 400) {
          const name = queued.shift() as string;
          const d = s.hosts.has(name) ? detailsOf(s, name) : null;
          // A reach section's button (api 4): the map, at its Host.
          if (d) d.actions = [{ label: `Show ${name} on the map`, icon: "map", run: (e: Obj) => roster.views.open(VIEW, { select: String(e.host) }) }];
          roster.details.set("topology", name, d);
          n++;
        }
        if (queued.length > 0) {
          flushing = true;
          roster.defer(50, flush);
        }
      };
      const details = () => {
        const now = new Map<string, string>();
        for (const name of s.order) {
          const d = detailsOf(s, name);
          if (d) now.set(name, detailsSig(d));
        }
        for (const name of [...now.keys()].sort()) if (detailed.get(name) !== now.get(name)) queued.push(name);
        for (const name of [...detailed.keys()].sort()) if (!now.has(name)) queued.push(name);
        detailed = now;
        if (!flushing) flush();
      };

      let refresh = () => {};
      let asking = false;
      let again = false;
      const check = (e: Obj) => {
        if (!e.host) return roster.notify("That's this Box: pick a Host to check.", "info", { quiet: false });
        roster.cmd(`check ${String(e.host)}`);
      };
      type Cutting = { job?: unknown; host: string; timer?: number | undefined; polling?: boolean; again?: boolean };
      let cutting: Cutting | null = null;
      let pushed = false;
      const cutDone = (host: string, r: Obj) => {
        const waiting = keys(r.pending).length;
        if (waiting > 0) roster.notify(`Cut ${host}: cut pending on ${plural(waiting, "Host")} that didn't answer.`, "warn");
        else roster.notify(`Cut ${host} from ${plural(((r.confirmed ?? []) as unknown[]).length, "Host")}.`, "info", { quiet: false });
      };
      const cutOver = () => {
        if (cutting?.timer !== undefined) roster.cancel(cutting.timer);
        cutting = null;
        roster.progress.remove("topology-cut");
        refresh();
      };
      const cutPoll = () => {
        if (!cutting) return;
        if (cutting.polling) {
          cutting.again = true;
          return;
        }
        cutting.polling = true;
        cutting.again = false;
        ask("mesh.job", { job: cutting.job }, (r) => {
          if (!cutting) return;
          cutting.polling = false;
          const j = typeof r === "object" && r !== null ? (r as Obj) : null;
          if (!j) {
            roster.notify(`Cut ${cutting.host}: roster serve lost track of it; :topology shows where the Mesh is now.`, "warn");
            return cutOver();
          }
          if (j.state === "running") {
            roster.progress.set("topology-cut", { title: `Cutting ${cutting.host} from the Mesh`, done: j.done ?? 0, total: j.total ?? 0 });
            if (cutting.again) cutPoll();
            return;
          }
          if (j.state === "done") cutDone(cutting.host, (j.result ?? {}) as Obj);
          else roster.notify(`Cut ${cutting.host}: ${String((j.error as Obj | undefined)?.message ?? "it failed")}`, "error");
          cutOver();
        });
      };
      const cut = (e: Obj) => {
        if (!e.host) return roster.notify("That's this Box: it's never in the Mesh, so there's nothing to cut.", "info", { quiet: false });
        const h = String(e.host);
        const m = mesh ?? {};
        if (!(s.involved.has(h) || (m.cut_pending as Obj | undefined)?.[h])) return roster.notify(`${h} isn't in the Mesh: there's nothing to cut.`, "info", { quiet: false });
        roster.confirm({
          title: `Cut ${h} from the Mesh?`,
          text: `Its key comes off every Host it reaches, and every peer's key comes off it, at once. This Box keeps its own access, so you can look into it.\n\nroster writes \`mesh: false\` for ${h} as a Pending change, so the cut lasts after the next Publish.`,
          facts: [
            { label: "Reaches now", value: `${plural(s.out.get(h) ?? 0, "Host")} directly` },
            { label: "Reached by", value: `${plural(s.in.get(h) ?? 0, "Host")} directly` },
          ],
          action: "Cut",
          danger: true,
          typed: h,
          run: () => {
            if (cutting) return roster.notify(`A cut of ${cutting.host} is still going: wait for it to finish.`, "warn");
            const c: Cutting = { host: h };
            cutting = c;
            ask("mesh.cut", { host: h, background: true }, (r, why) => {
              if (typeof r === "object" && r !== null && (r as Obj).job !== undefined) {
                const job = r as Obj;
                c.job = job.job;
                roster.progress.set("topology-cut", { title: `Cutting ${h} from the Mesh`, done: 0, total: job.total ?? 0 });
                if (pushed) cutPoll();
                else c.timer = roster.every(1000, cutPoll);
                return;
              }
              cutting = null;
              if (typeof r === "object" && r !== null) cutDone(h, r as Obj);
              else roster.notify(`Cut ${h}: ${clean(why)}`, "error");
              refresh();
            });
          },
        });
      };

      const draw = () => {
        const g = graphOf(s, live, down, ended);
        const text = textOf(s, { reads, mesh: canMesh, error: meshError, inventoryError });
        if (!sent) {
          const actions: Obj[] = [{ label: "Details", key: "i", icon: "info", run: (e: Obj) => (e.host ? roster.cmd(`info ${String(e.host)}`) : undefined) }];
          if (canCheck) actions.push({ label: "Check", key: "c", icon: "review", run: (e: Obj) => check(e) });
          if (canCut && canJob) actions.push({ label: "Cut", key: "x", icon: "close", run: (e: Obj) => cut(e) });
          roster.views.set(VIEW, { title: "Topology", place: "full", text, graph: { clusters: g.clusters, nodes: g.nodes, edges: g.edges, reach: "all", actions } });
          sent = { nodes: diff(null, g.nodes)[2], edges: diff(null, g.edges)[2], clusters: diff(null, g.clusters)[2] };
          sentText = text;
        } else {
          const [clusters, clustersGone, c] = diff(sent.clusters, g.clusters);
          const [nodes, nodesGone, n] = diff(sent.nodes, g.nodes);
          const [edges, edgesGone, e] = diff(sent.edges, g.edges);
          sent = { nodes: n, edges: e, clusters: c };
          const changes: Obj = {};
          if (clusters.length) changes.clusters = clusters;
          if (nodes.length) changes.nodes = nodes;
          if (edges.length) changes.edges = edges;
          const remove = [...nodesGone, ...clustersGone].sort();
          if (remove.length) changes.remove = remove;
          if (edgesGone.length) changes.remove_edges = edgesGone;
          if (text !== sentText) {
            changes.text = text;
            sentText = text;
          }
          if (Object.keys(changes).length) roster.views.update(VIEW, changes);
        }
        details();
      };
      refresh = () => {
        if (!canMesh) {
          [mesh, meshError] = [null, undefined];
          restructure();
          return draw();
        }
        if (asking) {
          again = true;
          return;
        }
        asking = true;
        ask("mesh.status", { grouped: true }, (r, why) => {
          asking = false;
          if (typeof r === "object" && r !== null) [mesh, meshError] = [r as Obj, undefined];
          else [mesh, meshError] = [null, clean(why ?? "roster serve said nothing about the Mesh")];
          restructure();
          draw();
          if (again) {
            again = false;
            refresh();
          }
        });
      };

      roster.commands.add("topology", {
        desc: "The Topology view: this Box, your Hosts by group and the Mesh; :topology GROUP shows one group",
        run: (a: Obj) => {
          if (!sent) {
            restructure();
            draw();
          }
          const word = (a.words as string[] | undefined)?.[0];
          if (word) {
            const ids = groupClusters(s, word);
            if (ids.length === 0) return roster.notify(`There's no group ${word} on the map.`, "warn");
            roster.views.update(VIEW, { filter: { clusters: ids } });
            filtered = true;
          } else if (filtered) {
            roster.views.update(VIEW, { filter: {} });
            filtered = false;
          }
          roster.views.open(VIEW);
        },
      });
      roster.keymap.set("leader", settings.leader, "topology");
      roster.help.set("topology", { title: "Topology", summary: "The map: this Box, your Hosts by group, the Mesh, and who can reach whom", markdown: helpPage(settings.leader) });
      roster.health.set("topology", {
        title: "Topology",
        check: () => {
          const out: Obj[] = [];
          if (!reads) out.push({ level: "warn", message: "inventory.read isn't granted, so the map has no Hosts", fix: "allow it in :plugins" });
          if (!canMesh) {
            out.push({ level: "warn", message: "serve:mesh.status isn't granted, so the map has no Mesh", fix: "allow it in :plugins" });
            return out;
          }
          if (meshError) out.push({ level: "warn", message: `Mesh status isn't available: ${meshError}`, fix: "update roster on this Box (the Mesh came with serve API 15)" });
          else if (!mesh) out.push({ level: "warn", message: "Mesh status hasn't come yet", fix: "run :check again in a moment" });
          else {
            const st = mesh as Obj;
            out.push({ level: "ok", message: `Mesh status available: ${plural(((st.members ?? []) as unknown[]).length, "Host")} roster visits` });
            if (st.out_of_date) out.push({ level: "warn", message: "The Mesh is out of date", fix: "apply it: roster mesh" });
          }
          return out;
        },
      });
      if (reads) {
        // The Sessions open before it loaded (api 4).
        for (const open of roster.sessions.list?.() ?? []) {
          if (!open.host) continue;
          const set = live.get(open.host) ?? new Set<number>();
          set.add(open.session);
          live.set(open.host, set);
        }
        roster.on("session_open", (e) => {
          if (!e.host) return;
          const host = String(e.host);
          const set = live.get(host) ?? new Set<number>();
          set.add(Number(e.session));
          live.set(host, set);
          down.delete(host);
          ended.delete(host);
          draw();
        });
        roster.on("session_exit", (e) => {
          if (!e.host) return;
          const host = String(e.host);
          live.get(host)?.delete(Number(e.session));
          if ((live.get(host)?.size ?? 0) === 0) {
            live.delete(host);
            ended.add(host);
            if (e.code === 255) down.set(host, "ssh failed");
          }
          draw();
        });
        roster.on("inventory_changed", () => {
          hosts = null;
          refresh();
        });
      }
      // How a check came out (serve API 21), asked once it's done: a failed one shows its Host down.
      // Only the answer for a Host's latest finished check counts (by when it ended, not its id).
      const latest = new Map<string, number>();
      let tokens = 0;
      const checkDone = (e: Obj) => {
        if (typeof e.host !== "string") return;
        const host = e.host;
        const token = ++tokens;
        latest.set(host, token);
        ask("host.check_job", { job: e.job }, (j) => {
          if (latest.get(host) !== token) return;
          const job = j as { state?: string; result?: { ok?: boolean; steps?: { step: string; status: string }[] } } | undefined;
          const r = job?.result;
          if (!r || job.state !== "done") return;
          if (r.ok) down.delete(host);
          else {
            const failed = (r.steps ?? []).find((step) => step.status === "fail")?.step;
            down.set(host, failed ? `check failed at ${failed}` : "check failed");
          }
          draw();
        });
      };
      // serve's job_progress (API 20): a cut's progress, mesh.job asked once it's over; a check's result.
      if (canJob || canHearChecks) {
        roster.on("job_progress", (e) => {
          if (e.kind === "check") {
            if (e.state === "done") checkDone(e);
            return;
          }
          if (e.kind !== "mesh") return;
          pushed = true;
          if (cutting?.timer !== undefined) {
            roster.cancel(cutting.timer);
            cutting.timer = undefined;
          }
          if (!cutting || cutting.job !== e.job) return;
          if (e.state === "running" || e.state === "stopping") {
            roster.progress.set("topology-cut", { title: `Cutting ${cutting.host} from the Mesh`, done: e.done ?? 0, total: e.total ?? 0 });
            return;
          }
          cutPoll();
        });
      }
      if (canMesh) roster.every(settings.refresh * 1000, () => refresh());
      roster.defer(50, () => refresh());
    },
  };
}

function helpPage(leader: string): string {
  return [
    "# Topology",
    "",
    `A map of this Box and every Host, grouped as the Inventory groups them, with the Mesh's reach and Links. \`:topology\` opens it (\`:topology GROUP\` shows one group), and so does \`␣ ${leader}\`; Esc goes back.`,
    "",
    "- **Nodes:** this Box is the square; a filled node takes a key, a ring a password, a dashed ring isn't reviewed, a hollow one's Session ended. A live Session is in the accent, with its edge from this Box; a Host that's down (its Session couldn't connect, or a check of it failed) is crossed out.",
    "- **Edges:** grey from this Box to each group; solid for a Mesh key, dashed for a password peer, an arrow one way. A cluster drawn as a mesh reaches itself both ways. A broken, dotted edge is a cut not finished.",
    "- **Marks:** warn for a Host that didn't answer the last apply or has no Link to its hop, error for a cut not finished. The text above the map says when the Mesh is out of date.",
    "- **A group the Mesh touches** shows as up to three clusters: its Hosts that reach each other, its password peers (reached, never reaching), and the ones not in the Mesh.",
    "",
    "Select a Host to light up what it can reach and what can reach it, every hop: what its key reaches, and what those Hosts' own keys reach, which is what someone on it could reach. Its details (`i`) say how many directly.",
    "",
    "Keys: `h` `j` `k` `l` move, `/` searches, `f` filters by group, kind or state (hiding the rest), `o` collapses a group, `+` `-` `0` zoom, `t` lists every node and edge. On a Host: Enter opens a Session, `i` its details, `c` Check, `x` Cut from the Mesh (after you type its name).",
    "",
    "It needs **inventory.read** for the Hosts, **serve:mesh.status** for the Mesh, **serve:host.check** for Check, **serve:host.check_job** to show a Host down when a check of it fails, and **serve:mesh.cut** with **serve:mesh.job** for Cut. Without one it says so above the map.",
  ].join("\n");
}

// ------------------------------------------------------------------- ?fixture=topology

/** The made-up network `?fixture=topology` shows: `hosts` Hosts in four subnets (makeHosts), two
 * of them meshed, a Host that Links to a whole subnet, a two-way Link across, a Link through a
 * jump Host it has no Link to (no-via), a cut not finished and a Host that didn't answer. */
export interface TopologyWorld {
  /** The Hosts, as makeHosts makes them (renamed in the worst case). */
  list: HostList;
  /** Polls of mesh.job a cut answers "running" before it's done. */
  ticks?: number;
}

const MESHED = ["subnet-1", "subnet-3"];

/** roster serve's `mesh.status { grouped = true }`, `mesh.cut { background = true }` and `mesh.job`
 * for the world, as the Rust test's stand-in answers them. */
export function topologyServe(world: TopologyWorld): (method: string, params: Obj) => unknown {
  const hosts = world.list.hosts;
  const by = (g: string) => hosts.filter((h) => h.group === g);
  const meshed: Record<string, string[]> = {};
  const excluded: Record<string, string> = {};
  for (const g of MESHED) {
    meshed[g] = by(g).filter((h) => h.reviewed).map((h) => h.name);
    for (const h of by(g)) if (!h.reviewed) excluded[h.name] = "not reviewed (reviewed: false)";
  }
  const kind = (h: Host) => (h.enroll ? "key" : "password");
  const keyed = (g: string) => by(g).filter((h) => h.reviewed && h.enroll);
  const links: Link[] = [];
  // One Host of subnet-1 reaches every Host of subnet-2; subnet-2 and subnet-4 reach each other
  // through one pair each way; a Host of subnet-4 goes through a jump Host it has no Link to.
  const [source] = keyed("subnet-1");
  if (source) for (const t of by("subnet-2").filter((h) => h.reviewed)) links.push({ from: source.name, to: t.name, kind: kind(t) });
  const [a, jump] = keyed("subnet-2");
  const [b, far] = keyed("subnet-4");
  if (a && b) links.push({ from: a.name, to: b.name, kind: "key" }, { from: b.name, to: a.name, kind: "key" });
  if (b && far && jump) links.push({ from: b.name, to: far.name, kind: "key", via: jump.name } as Link);
  const members = [...new Set([...Object.values(meshed).flat(), ...links.flatMap((l) => [l.from, l.to])])].sort();
  const victim = keyed("subnet-3")[0]?.name;
  const peer = keyed("subnet-3")[1]?.name;
  let cutPending: Record<string, string[]> = victim && peer ? { [victim]: [peer] } : {};
  const late = keyed("subnet-1")[2]?.name;
  let job: { host: string; left: number } | null = null;
  return (method, params) => {
    switch (method) {
      case "mesh.status":
        return {
          links,
          excluded,
          reach: {},
          members,
          pending: late ? { [late]: "no answer: ssh: connect to host port 22: Connection timed out" } : {},
          cut_pending: cutPending,
          out_of_date: true,
          ...(params.grouped === true ? { meshed } : {}),
        };
      case "mesh.cut": {
        const host = String(params.host);
        job = { host, left: world.ticks ?? 1 };
        return { job: 1, action: "cut", total: members.length, host };
      }
      case "mesh.job": {
        if (!job) return null;
        if (job.left-- > 0) return { job: 1, action: "cut", host: job.host, state: "running", done: 1, total: members.length, at: members[0] ?? null, stopped: false };
        const host = job.host;
        job = null;
        cutPending = { ...cutPending };
        return {
          job: 1,
          action: "cut",
          host,
          state: "done",
          done: members.length,
          total: members.length,
          at: null,
          stopped: false,
          result: { host, confirmed: members.filter((m) => m !== host), pending: {}, change: { written: true, backup: "/home/you/.config/roster/backup/roster.yml" } },
        };
      }
      default:
        throw new Error(`unknown method '${method}' (code -32601)`);
    }
  };
}
