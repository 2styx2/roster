# topology: the Topology view

A map of your network in the roster app: this Box, every Host grouped as the Inventory groups them, the [Mesh](../../docs/mesh.md)'s reach and its Links, live Sessions in the accent, and what's down, pending or being cut. Select a Host and the map lights up what it **can reach** and what can reach it, with the counts: the risk the Mesh brings, where you can see it (decision Q63).

It's a first-party Plugin ([plugins/README.md](../README.md)): roster's core stays small, so the app has no Topology view of its own (decision Q80). It draws with the app's graph view ([Graphs](../../docs/plugins.md#graphs)) on the public Plugin API only, with the permissions below and nothing else.

## Install

In your `init.lua`, then `:source`:

```lua
roster.packages.add({ "https://github.com/2styx2/roster", dir = "plugins/topology" })
```

The app clones roster's repo, shows the folder, the commit and every permission, and asks first. Allow pins the commit in `roster.lock`. Add `tag = "vX.Y.Z"` to stay on a release, and `config = { … }` for the settings below.

It draws the Mesh best with roster serve's API 19 (`mesh.status`'s `grouped`, which says a meshed group once instead of every pair in it). An older roster still works, but a big Mesh is slow to draw there, and before API 15 there's no Mesh at all: the map shows the Box and the Hosts, and `:check` says why. Before API 21 a check isn't a job, so the Plugin hears no check's result: a failed `:check` or Check doesn't cross its Host out (a Session that couldn't connect still does), and nothing on the map or in `:check` says so.

## What it adds

| Where | What |
|---|---|
| `:topology` (and `␣ T`) | The **Topology** view, over the whole window; Esc goes back. `:topology GROUP` opens it showing only that group (by its name or title). It's in the `views` finder (`:view`) too |
| The map | **This Box** is the square. A Host is filled when it takes a key, a ring when it takes a password, a dashed ring when it isn't reviewed, hollow once its Session ended. A **live** Session is in the accent, with its edge drawn in from this Box, the Sessions open before the Plugin loaded too; a Host whose Session couldn't connect (ssh's 255) or whose last check failed is crossed out as down ("check failed at tcp"), until a Session to it opens or a check of it passes. Each group is a cluster with a grey edge from this Box |
| The Mesh | A meshed group's Hosts that reach each other are their cluster, drawn as a mesh. A group the Mesh touches shows as up to three clusters: its Hosts that reach each other, its **password peers** (reached, never reaching: roster doesn't write on a password Host) and the Hosts **not in the Mesh**. A Link is solid for a key, dashed for a password peer, an arrow one way or a line both ways; one edge stands for every Link between two clusters, or between a Host and a whole cluster. A Link through a jump Host says `via jump-1`, and in the error colour when its source has no Link to the jump Host (`no-via`) |
| Marks | Error on a Host whose cut isn't finished (`cut pending on 2 Hosts`), with a broken, dotted edge to each peer that may still hold its key; warn on a Host that didn't answer the last apply (`Mesh pending`) or has no Link to its hop. The text above the map says when **the Mesh is out of date** |
| Reach | Selecting a Host lights up every Host it can reach and every Host that can reach it, every hop away, with the counts under the map ("Reaches 7 nodes; reached by 3"). Every hop because a Mesh key on a Host goes on to whatever that Host's own keys reach: that's what someone who got onto it could reach (decision Q102) |
| On a Host | Enter opens a Session (the app's own `:open`). `i` shows its details, `c` runs the app's `:check HOST`, `x` cuts it from the Mesh after a question you answer by typing its name |
| Keys of the graph | `h` `j` `k` `l` move, `/` searches (`n`/`N` go through the matches), `m` moves the selected node (`h` `j` `k` `l`, Enter keeps, Esc puts it back), `f` filters by group, kind or state and hides the rest, `o` collapses a cluster to its count, `+` `-` `0` zoom, `H` `J` `K` `L` pan, `t` lists every node and then every edge as a table |
| Host details | A **Reach** section in each Mesh Host's details (`:info HOST`): whether it's in the Mesh (or why not), how many Hosts it reaches and is reached by **directly** (its own Links), Links from it roster doesn't write, its hop, pending, cut pending. Its **Show esx-01 on the map** button opens the map at that Host, opening its group if it's collapsed (the app's Plugin API 4) |
| `:check` | A **Topology** section: whether Mesh status was available the last time it asked (it doesn't make `:check` wait for serve), and whether the Mesh is out of date |
| Help | `:help topology` |
| Tutorial | `:tutor topology`: open the map, show one group, go from a node to its details and a Session, on the tutorial's demo Inventory (its six made-up Hosts in two groups). The demo has no Mesh, so the tutorial says so and teaches the map without it |

It never changes anything on its own. Cut is the only thing that does, and only after you type the Host's name.

## Permissions

| Permission | Why | Flagged |
|---|---|---|
| **`inventory.read`** | The Hosts and their groups, the Sessions open when it loads (`roster.sessions.list`), and the `session_open`, `session_exit` and `inventory_changed` events: which Sessions are live, which failed to connect, and when to draw the map again. It reads a Host's Login reference only to tell a key from a password (the node's shape), never a password | no |
| **`serve:mesh.status`** | Who reaches whom as `roster.yml` says, what's pending, cut pending and out of date: the Mesh on the map and the Reach sections. It never connects to a Host. Asked when the map opens, after an Inventory change, after a Cut, and once a minute (`refresh`) | no |
| **`serve:host.check`** | Only so `c` may run the app's own `:check HOST` (a Plugin may run `:check` only with this permission). The app runs the diagnostics and shows them; this Plugin never calls `host.check` itself | yes: it connects to the Host |
| **`serve:mesh.cut`** | Cut from a node, only after you type the Host's name: its key comes off every peer and every peer's off it, and `mesh: false` is written for it as a Pending change. Run as a job (`background`), never the form that waits | yes: it takes keys off your Hosts |
| **`serve:mesh.job`** | How that cut ended, asked once it's over; with it the Plugin hears the cut's progress as roster serve pushes it (`job_progress`, the progress in the status bar) | no |
| **`serve:host.check_job`** | How a check of a Host came out, the app's `:check` or Check from the map: it hears that a check ended (`job_progress`) and asks `host.check_job` once, so a failed check shows the Host down. It never starts a check (serve API 21; an older serve's checks aren't jobs, so nothing is heard) | no |

It asks for no other serve method, can't Publish, never sees a password or the vault, can't type into a Session or open one itself, and doesn't reach the network.

**Without them** it still loads. Without `inventory.read` the map is only this Box, and says "Allow inventory.read in :plugins to see your Hosts"; without `serve:mesh.status` it says "Allow serve:mesh.status in :plugins to see the Mesh" and asks nothing on a timer; without `serve:host.check` there's no Check, without `serve:host.check_job` a failed check doesn't show a Host down, and without `serve:mesh.cut` and `serve:mesh.job` no Cut. Its `:check` section says what's missing. Turn any of them off in `:plugins`.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `leader` | `"T"` | The keys after the Leader that run `:topology`; `false` binds none |
| `refresh` | `60` | Seconds between looks at `mesh.status` (10 to 3600), for applies and cuts made elsewhere |

```lua
{ "https://github.com/2styx2/roster", dir = "plugins/topology", config = { leader = "g t", refresh = 120 } },
```

A setting it can't use is named in a notice, and the default is used.

## How it's made

```text
topology/
  roster-plugin.lua          the manifest: name, version, api 5, the permissions above
  init.lua                   the Plugin: the view, its actions, events, command, help, :check section
  lua/topology/build.lua     the pure part: Hosts and the Mesh into clusters, nodes, edges and words
```

- **Few edges for a big Mesh.** A meshed group of 50 is 2,450 Links. `mesh.status { grouped = true }` (serve API 19) says each meshed group once, and the Plugin draws it as its cluster's mesh; the other Links are grouped by the clusters at their ends, so a group-to-group Link is one edge. 2,000 Hosts in 40 meshed groups (98,000 Links) are 2,001 nodes and 40 edges.
- **Reach every hop away** (`reach = "all"` on the graph): the graph counts it on select. The Reach section in a Host's details gives the direct counts, the ones `roster mesh` reports.
- **Only what changed.** The map is set once; after that, a Session, an Inventory change or a refresh sends only the nodes, edges and clusters that changed (`roster.views.update`), so a node that turns live keeps its place and its edge draws in. The Hosts are read again only when the app says they changed.
- **It never waits for roster serve.** Every Mesh question is a `roster.serve.request`: the answer comes later as a call of its own, so a busy serve (a Publish, a long Mesh run) holds up neither the Plugin nor the app. One `mesh.status` at a time; Check is the app's, and its result is asked once when serve says the check ended; Cut is a job it follows by roster serve's pushed progress (`job_progress`), asking `mesh.job` once it's over; before serve API 20, which pushes nothing, a timer asks `mesh.job` once a second. The Hosts come from `roster.inventory.request` too, so a big Inventory doesn't hold it up either, and are asked again only on `inventory_changed` (an answer to a read made before a change is asked again). The first look is deferred so nothing asks serve while the app starts, and the Reach sections go 400 a call.
- **What it knows of before it loaded:** the Sessions open then (`roster.sessions.list`, Plugin API 4); a check that ended before it loaded isn't heard. A filter over several clusters (`:topology lab`, with its peers) shows as "3 clusters" in the filter.

## Testing it

`crates/roster-core/tests/plugin_topology.rs` installs it as a Package with `dir = "plugins/topology"` from a git repo made from this checkout and drives it through the Plugin host against a stand-in roster serve with a made-up network: the map, Sessions turning nodes live (and the ones open before it loaded), Check and a check's result, Cut behind the typed name, `:topology GROUP`, no permissions, an older serve, what it can't reach, and 2,000 Hosts in a Mesh of 98,000 Links; and its tutorial on the demo's Plugin host, where every step names a demo Host or group and the map says there's no Mesh. It records a run in `app/src/plugins/topology.transcript.json`, which `app/src/plugins/topology.test.ts` replays against the app's stand-in (`app/src/backend/fakeTopology.ts`); `app/src/App.topology.test.tsx` tests it in the app. `?fixture=topology` (and `?fixture=topology-worst`, 2,000 Hosts with long and non-Latin names) shows it in a plain browser. Change the Lua, run `ROSTER_UPDATE_TRANSCRIPT=1 cargo test -p roster-core --test plugin_topology`, and update the stand-in to match. serve's side is `tests/test_mesh.py`.
