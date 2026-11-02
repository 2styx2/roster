# mesh: the Mesh controls

The [Mesh](../../docs/mesh.md)'s controls in the roster app: who reaches whom and what each Host **can reach**, "Mesh out of date" after a Publish, a plan you look at before an apply you confirm, and a Cut you confirm by typing the Host's name.

It's a first-party Plugin ([plugins/README.md](../README.md)): roster's core stays small, so the app has no Mesh controls of its own (decision Q80). The Mesh itself is `roster mesh`, in the CLI and roster serve; this Plugin runs it through serve's `mesh.*` methods, on the public Plugin API only, with the permissions below and nothing else.

## Install

In your `init.lua`, then `:source`:

```lua
roster.packages.add({ "https://github.com/2styx2/roster", dir = "plugins/mesh" })
```

The app clones roster's repo, shows the folder, the commit and every permission, and asks first. Allow pins the commit in `roster.lock`. Add `tag = "vX.Y.Z"` to stay on a release, and `config = { leader = "y m" }` to pick its key (below).

It needs roster serve's API 17 (Mesh jobs). With an older roster it loads and says so, and never starts a Mesh run.

## What it adds

| Where | What |
|---|---|
| `:mesh` (and `␣ y m`) | The **Mesh** view: every Host in the Mesh or kept out of it, how many Hosts it **can reach** with its Mesh key (the risk if it's taken over), how many reach it, and its state (in the Mesh, kept out and why, pending, cut pending). Enter shows the Host's details. `p` plans, `a` applies, `l` shows the Links, `x` cuts the selected Host |
| `:mesh plan` | Plans: roster connects to each Host in turn, one at a time, and changes nothing. The **Mesh plan** view lists each Host's changes (`make key`, `add key from orion-2`, …) and the warnings. Progress shows in the status bar |
| `:mesh apply` | Applies the plan you looked at, after a question that says how many Hosts change and how many Links are left out. Without a plan, it plans first |
| `:mesh links` | The **Mesh Links** view: the Links worth a look, those through a jump Host (`via`) or with a problem, with each one's status and why. `e` explains a status and what to do about it |
| `:mesh cut HOST` | Takes HOST out of the Mesh now, on every Host at once, after you type its name (the stronger question, which starts on Cancel). Each Host that didn't answer gets its own warning, `CUT PENDING on nas-1: …`, and a `cut pending` badge; an earlier `mesh_dir:` left on the cut Host gets one too (roster serve API 24) |
| `:cancel mesh` | Stops a plan or apply before its next Host (the progress's stop button does the same). What it hadn't reached is pending, and the next apply finishes it |
| Status bar | **Mesh out of date** when `roster.yml` changed the Mesh since the last apply on this Box (after a Publish, say): click it to plan. **Cut pending** while a cut isn't finished everywhere, **Mesh: 2 pending** while Hosts are pending |
| Badges | `pending` on a Host that didn't answer, `cut pending` on a Host that still holds a cut Host's key |
| Host details | A **Mesh** section in each Host's details (`:info HOST`): its reach ("can reach 7 Hosts"), what reaches it, its state, its Links worth a look, and Cut |
| Help | `:help mesh-controls` |

**no-via.** A Link with `via:` goes through a jump Host, and ssh logs in to the jump Host first, so its source needs a Link to the jump Host too. Without one, the Link is `no-via`: left out, and `roster check` fails. The Mesh view counts them, the Links view lists them, and `e` says what to add (`{ from: orion-3, to: jump-1 }`). serve marks them without connecting, so they show before any plan.

**A big Mesh.** In a meshed group every pair of Hosts is a Link: 500 Hosts make 249,500. The Plugin asks serve for its brief answers (`brief: true`), which count the Links and list only those worth a look (at most 1,000), and draws the Host details a few hundred at a time, so it stays inside a Plugin's [limits](../../docs/plugins.md#limits).

## Permissions

| Permission | Why | Flagged |
|---|---|---|
| `serve:mesh.status` | Who reaches whom as `roster.yml` says, what's pending and whether the Mesh is out of date: the Mesh view, the badges, the status segment and the Host details. It never connects to a Host | no |
| `serve:mesh.job` | How a plan, apply or cut ended, asked once it's over; with it the Plugin hears the job's progress as roster serve pushes it (`job_progress`). Also how it learns serve has jobs at all | no |
| `serve:mesh.stop` | Stop a plan or apply before its next Host, from the progress's stop button or `:cancel mesh` | no |
| `serve:mesh.plan` | Plan: connects to each Host and reads, changing nothing | no |
| `serve:mesh.apply` | Apply the plan, only after you confirm the question | yes: it writes keys and ssh config on your Hosts |
| `serve:mesh.cut` | Cut a Host, only after you type its name; it also writes `mesh: false` for it to `roster.yml` as a Pending change | yes: it takes keys off your Hosts |
| `inventory.read` | Only for the `inventory_changed` event, so "Mesh out of date" shows right after a Publish, a pull or an edit. It never reads a Host's Login | no |

It calls `mesh.plan`, `mesh.apply` and `mesh.cut` only with `background: true` (as jobs), never the forms that wait, because a Mesh run takes minutes. It asks for no other serve method, can't Publish, never sees a password or the vault, and doesn't reach the network.

**Without them** it still loads and says what's missing: without `serve:mesh.status` or `serve:mesh.job` the Mesh view says "Allow serve:mesh.status and serve:mesh.job in :plugins to see the Mesh."; without `serve:mesh.apply` or `serve:mesh.cut`, `a` and `x` say which permission to allow instead of asking anything; without `inventory.read` it refreshes when you open `:mesh` and after its own runs. Turn any of them off in `:plugins`.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `leader` | `"y m"` | The keys after the Leader that run `:mesh`; `false` binds none |

A setting it can't use is named in a notice, and the default is used.

## How it's made

```text
mesh/
  roster-plugin.lua      the manifest: name, version, api 5, the permissions above
  init.lua               the Plugin: the views, Host details, badges, status, commands, jobs
  lua/mesh/words.lua     the pure part: what serve's answers say, in words
```

- **Every Mesh run is a job.** `mesh.plan`, `mesh.apply` and `mesh.cut` with `background: true` answer at once with the job's number (serve API 17). roster serve pushes the job's progress (`roster.on("job_progress", …)`, serve API 20): the Plugin sets the progress from each push and asks `mesh.job` once, when the job is over, for its result. Until the first push comes (a serve before API 20 sends none) a timer (`roster.every(1000, …)`) asks `mesh.job` instead, and the first push cancels it.
- **It never waits for serve.** Every question is a `roster.serve.request` (decision Q103): the app's Publish can hold serve for a minute or two, so the controls keep answering meanwhile and catch up when serve does. There's one `mesh.job` question out at a time (a job that ends while one is out is asked about again once it's back), a refresh asked for while one is out goes again once it's back, and a plan, apply or cut asked for while the last is still starting says so instead of asking twice. A Plugin reloaded mid-run finds the job with `mesh.job` and follows it again.
- **It asks, the app draws.** Apply is a plain question (`roster.confirm`); Cut is the stronger one with `danger` and `typed`. Nothing runs until you answer.
- **The first look is deferred** (`roster.defer(50, …)`): nothing calls serve while the Plugin loads, so a busy serve can't hold the app's start.

## Testing it

`crates/roster-core/tests/plugin_mesh.rs` installs it as a Package from a git repo with `dir = "plugins/mesh"` and drives it through the Plugin host against a stand-in roster serve: every view and section, plan and apply behind the question, Cut behind the typed name and its warnings, stopping, no permissions, an older serve, a reload mid-run, a serve busy with a Publish, and 500 and 1,000 Hosts (`cargo test --release -p roster-core --test plugin_mesh -- --ignored` times the 1,000 against the 250 ms a call may take; see [performance.md](../../docs/app/performance.md#budgets)). It waits for every request's answer after each step, and records a run in `app/src/plugins/mesh.transcript.json` (each step's own ops, then each answer's), which `app/src/plugins/mesh.test.ts` replays against the app's stand-in (`app/src/backend/fakeMesh.ts`); `app/src/App.mesh.test.tsx` then tests it in the app. `?fixture=mesh` (and `?fixture=mesh-worst`, 500 Hosts with long and non-Latin names) shows it in a plain browser. Change the Lua, run `ROSTER_UPDATE_TRANSCRIPT=1 cargo test -p roster-core --test plugin_mesh`, and update the stand-in to match. serve's side is `tests/test_mesh.py`.
