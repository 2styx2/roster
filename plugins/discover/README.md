# discover

A first-party roster Plugin: scan a network from the app, look at what answered, and add the Hosts you keep to the Inventory, **unreviewed**, as Pending changes you review and Publish. It's `roster discover` with a view, a question before anything happens, and progress you can stop.

The scan runs in `roster serve` on the Box, never in the app or in this Plugin's Lua: nmap when it's installed (service versions and web page titles), else roster's own TCP connect scan, on `roster discover`'s list of ports ([serve-api.md: Discover](../../docs/serve-api.md#discover-discoverplan-discoverstart-discoverstatus-discoverstop-discoveradd)). Everything here goes through roster's public Plugin API ([docs/plugins.md](../../docs/plugins.md)), like anyone's Plugin (decisions Q80, Q81, Q94 and Q100).

## What it adds

| Where | What |
|---|---|
| Commands | `:discover 10.0.0.0/24` asks to scan a range (several ranges: `:discover 10.0.0.0/24 10.0.1.0/28`). `:discover` opens the view, or asks to scan the `ranges` setting if nothing has been scanned yet. `:discover stop`, `:discover keep all`, `:discover keep none`, `:discover add` |
| Toolbar | **Scan**, by the window's buttons: the same as `:discover` |
| Key | `␣ y d` (the `leader` setting): the same as `:discover` |
| Question | Before a scan: the range, how many addresses and ports, and with what. Over 4,096 addresses (up to a /16), the stronger form: you type the range first. Before adding: which Hosts, into which group |
| View | **Discover**, a full view: what's going on, then a table of what answered, filled in as the scan finds it. Address, the name it would be added as (or the Host's, greyed, when it's in the Inventory already), what it looks like, its open ports, its web page's title, and its status. `m` keeps a row, `u` doesn't, `A` adds the kept ones, `i` or Enter shows its details. `/` filters, `s` sorts, as in any table |
| Floating window | A found address's details: its DNS name, the name it gets, the guessed type, hardware and OS when nmap found them, every open port with its product, and a link to its web page |
| Status bar | The scan's progress, with a stop button (`:cancel scan` does the same) |
| Notices | When the scan ends ("Scan done: 12 Hosts answered, 9 new"), and when Hosts were added |
| `:check` | A **Discover** section: whether this Box's roster can scan (serve API 18), with nmap or the built-in scanner, and which permissions are missing. It asks `discover.plan`, which connects nowhere |
| Help | `:help discover` |

A view holds 10,000 rows; a scan that finds more says so and keeps the first 10,000. Results live in memory: they're gone when the app restarts or `roster serve` does.

## Permissions

It asks for five `serve:` methods and nothing else: no Inventory, no Sessions, no terminal, no network of its own.

| Permission | What it's for | Flagged |
|---|---|---|
| `serve:discover.plan` | How many addresses a range holds, and whether nmap is there, for the question before a scan and for `:check`. Connects nowhere | no |
| `serve:discover.start` | Starting a scan you confirmed | **yes**: "Can scan networks from this computer, once you've confirmed it: roster connects to every address in a range, on many ports. A network's security tools may take a scan for an attack, so scan only networks you may." |
| `serve:discover.status` | What the scan found, asked each time roster serve pushes its progress (`job_progress`); with it the Plugin hears that progress | no |
| `serve:discover.stop` | Stopping it | no |
| `serve:discover.add` | Adding the Hosts you kept: a new group in `roster.yml`, `reviewed: false`, as Pending changes. Nothing connects to them and nothing is Published | **yes**: "Can add the Hosts a scan found to your Inventory, unreviewed, as Pending changes you review and Publish." |

Scanning is a network action, so the app's core holds `discover.start` and `discover.add` to calls you started yourself: an action, a command, a toolbar control or your answer to its question. A Plugin that calls them at load, on an event or from a timer gets an error, whatever it was granted. So no Plugin, this one included, can scan or add on its own.

Without the first four it still loads, and its view says which are missing; without `serve:discover.add` it scans, and adding says what's missing.

## Install

As a Package, in your `init.lua`:

```lua
roster.packages.add({ "https://github.com/2styx2/roster", dir = "plugins/discover", config = {
  ranges = { "10.0.0.0/24" }, -- what :discover alone offers to scan (none: name a range each time)
  leader = "y d",             -- the keys after the Leader that open it
  ports = "22,80,443,8443",   -- the TCP ports to try (roster discover's list if left out)
  group = "found",            -- the new group the kept Hosts go into (discovered-YYYYMMDD if left out)
} })
```

Then `:source`. The app clones roster's repo, loads the Plugin from `plugins/discover` and asks first, with every permission above. Allow pins the commit in `roster.lock`. Add `tag = "vX.Y.Z"` to stay on a release.

It needs `roster serve` API 18 on the Box (a roster with `discover.*`). With an older one, a scan says to update roster, and `:check` says so too.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `ranges` | none | What `:discover` alone offers to scan; with none, you name a range each time |
| `leader` | `"y d"` | The keys after the Leader that open its view; `false` binds none |
| `ports` | `roster discover`'s list | The TCP ports to try |
| `group` | `discovered-YYYYMMDD` | The new group the kept Hosts go into |

A setting it can't use is named in a notice, and the default is used instead.

## How it's made

```text
discover/
  roster-plugin.lua          the manifest: name, version, api 5, the five serve methods
  init.lua                   the view, the questions, the commands, the toolbar control, :check, help
  lua/discover/model.lua     the pure part: settings, rows, ports and details as text
```

- **The scan is serve's.** `discover.start` answers at once; roster serve pushes the scan's progress (`roster.on("job_progress", …)`, serve API 20), and each push asks `discover.status` with `since`, so each answer brings only what's new, and `roster.views.update` adds those rows without sending the rest. Until the first push comes (a serve before API 20 sends none) a timer (`roster.every(1000, poll)`) asks instead; the first push cancels it, and it stops when the scan ends.
- **It never waits for serve.** Every question is a `roster.serve.request` (decision Q103): the app's Publish can hold serve for a minute or two. The question before a scan comes when `discover.plan` answers, still part of what you typed, so it may ask; `discover.plan` is asked with `force` once, and a range over 4,096 addresses gets the stronger question. One `discover.status` question is out at a time (a push while one is out asks again once it's back). Its `:check` section answers later: `check` returns `"later"`, asks `discover.plan` with `roster.serve.request`, and answers with `roster.health.answer` when serve does.
- **The view is set once**, at load, with its table's actions; a new scan takes the old rows away with `remove`, so the actions' functions never change under the user.
- **Rows carry what decides their actions** (`state`, `pick`) as cells that aren't columns, so Keep shows only on new rows and Add only on kept ones (`when`).
- **It asks before anything happens.** `roster.confirm` before a scan and before an add; their `run` is what calls `discover.start` and `discover.add`.

## Testing it

- `crates/roster-core/tests/plugin_discover.rs` installs it as a Package with `dir = "plugins/discover"` from a git repo made from this folder, and drives it through the Plugin host against a stand-in `roster serve`: the install prompt's flags, the question before a scan and the stronger one over 4,096 addresses, the question coming after a busy serve, polling and following pushed progress, stopping, keeping and adding, `:check`, settings, what it does without its permissions, and that the core refuses a scan or an add a Plugin starts on its own. It waits for every request's answer after each step, and records what the Lua did in `app/src/plugins/discover.transcript.json` (each step's own ops, then each answer's).
- `app/src/plugins/discover.test.ts` replays that transcript against the fake Backend's stand-in (`app/src/backend/fakeDiscover.ts`), serve calls and all, and `app/src/App.discover.test.tsx` tests the UI with it. Change the Lua, run `ROSTER_UPDATE_TRANSCRIPT=1 cargo test -p roster-core --test plugin_discover`, and update the stand-in to match.
- `tests/test_serve_discover.py` tests serve's `discover.*` with a stand-in nmap (`tests/fakes/nmap`): nothing scans a real network.
- `?fixture=discover` (and `?fixture=discover-worst`, a /16 where 12,000 answer) in a plain browser (`npm run dev` in `app/`) shows it installed, with a stand-in network to scan.
