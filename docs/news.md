# What's new

What changed in each Release of roster, the CLI and the app together, newest first: what's new, what changed, what's gone and what's on its way out. The app says once, on its first start after an upgrade, "roster 0.2.0: what's new: `:help news`". [Deprecated names](deprecated.md) lists every old name that still works, and what replaces it.

Each Release has the same sections, left out when empty: **Breaking** (something you have to change), **New**, **Changed**, **Security**, **Fixed**, **Removed** and **Deprecated**. Inside a section the bullets are grouped by area: the CLI, the app, and the `roster serve` API with the API version that brought the change.

## Unreleased

### Breaking

**App**

- Plugin API 3 (`roster.api_version` 3): `roster.inventory.host(name)` gives `nil` for a name that isn't a Host, where it raised an error (code 2), so a Plugin that wrapped it in `pcall` checks for `nil` now. A `cmd:` or `env:` Login reference reaches a Plugin cut to its kind (`cmd:`, `env:`): it says how a secret is fetched, and a Plugin never needs it. See [`roster.inventory.host()`](plugin-api.md#rosterinventoryhostname) and [`LoginRef`](plugin-api.md#loginref).

### New

**App**

- **An option reference, and `:options`:** `:help options` now has every `init.lua` option and every name of its `roster` table, one entry each, as Neovim's `:help 'option'` lists options: its type, its default, the values it can have (one of a few, a range, or a form), what it does and an example, with the value it has now and where that was set. Each is a topic: `:help terminal.size`, `:help keys.leader`, `:help roster.keymap.set`, `:help roster.config.Theme`. `:options` finds an option with its value now, where it was set (the file and line, the State, or default) and its default. `:config types` writes them as types for lua-language-server (`types/roster-config.lua` in the config folder), so your editor completes option names and shows the same descriptions. See [Option reference](app/options.md).
- **Fill sudo's password prompt from the vault:** when a Session waits at `[sudo] password for USER:` for its own login user, a note in the pane's corner offers `␣ p` (`:fill`), which types the Host's password from the vault: its own `sudo: {auth}` from `roster.yml`, else its ssh Login. Nothing is typed until you press it; the password goes from roster serve straight to the Session, never through the window or to a Plugin, and only once roster has checked the prompt doesn't echo and the Host hasn't changed since the Session connected. With shell integration it's offered only while the command running is sudo itself; without it the note says roster can't tell whether you're still on the Host. su's `Password:` is never filled. Needs roster serve API 25. See [Keyboard](app/keyboard.md) and [security.md](app/security.md#filling-a-password-prompt).
- **Your Plugins in `:tutor`'s demo:** the Plugins running in your workspace load in the demo too, with the permissions you granted them, so a Plugin's tutorial (`roster.tutor.set`) can teach the Plugin itself. There they see the demo's Hosts; roster serve answers only the demo's Host list, nothing reaches the network, and their files start empty and go when you leave. One that fails to load there doesn't stop the tutorial. See [A Plugin's tutorial](plugins.md#a-plugins-tutorial).
- `:plugins` shows how full each Plugin's data folder is against its limits: "Data: 2.1 MB in 34 files (of 10 MB, 1,000 files)", or "Data: none yet". It's counted when the panel opens, from the folder's listing alone. See [A Plugin's own files](plugins.md#a-plugins-own-files).
- **What a Plugin can read without waiting for an event** (Plugin API 4): `roster.sessions.list()` gives the Sessions open now, the ones that opened before the Plugin loaded too (with `inventory.read` or `terminal.read`); `roster.inventory.request(done)` reads every Host and group without waiting for roster serve; and `roster.inventory.hosts()` and `.groups()` in one call are one read of the Inventory, not two. A Plugin with `serve:host.check_job` can read how any check of a Host came out (the new [`CheckJob`](plugin-api.md#checkjob) type). topology shows the Sessions open before it loaded as live, and a Host whose check failed as down ("check failed at tcp"); it asks for `serve:host.check_job` for that, so updating it asks you once. See [`roster.sessions.list()`](plugin-api.md#rostersessionslist) and [Asking roster serve](plugins.md#asking-roster-serve).
- **Shell integration for Plugins:** if the shell on a Host prints OSC 133 marks (a few lines in its rc file; `:help shell-integration` has them for bash, zsh, fish and PowerShell), a Plugin with `terminal.read` hears `command_done` when each command ends, with its command line, its output and its exit code, and each run of `terminal_output` says what the marks call it (its new `kind`: `prompt`, `input` or `output`; a hint, since the Host prints the marks). roster only reads the marks: it never puts hooks on a Host or types into a Session. recent-alerts never alerts on a line the marks call a prompt or what you typed, and keeps its guess at your own echoed command for the rest. Plugin API 4 (`roster.api_version` 4). See [Shell integration](plugins.md#shell-integration).
- **Shell hooks, opt-in:** with `shell_hooks: true` on a Host in `roster.yml` (or `terminal.shell_hooks = true` in `init.lua`, or `:integrate` for the Session on screen), roster sends the shell one line after login that turns on its prompt marks (OSC 133) and its folder (OSC 7) for bash, zsh, fish and PowerShell, in that shell only: no rc file is touched. It's sent only at an empty prompt roster knows, before you type, and never to a menu, a forced command or a network CLI; the echo is kept off the screen. A Session's row shows the folder its shell is in. Off unless you turn it on. See [Shell hooks](plugins.md#shell-hooks-roster-sets-it-up).
- **`:check HOST` shows each step as it runs:** the step under way is lit, with how long it has taken once it takes a while, and a stopped or abandoned check shows the step it stopped at. Needs roster serve API 21. See [Errors](app/errors.md).
- `roster.views.open(id, { select = ID })` (Plugin API 4) opens a view at a node of its graph or a row of its table; Topology's Reach section in a Host's details has a **Show esx-01 on the map** button that does. Row and heading buttons take a `map` icon. See [Views](plugins.md#views-tables-and-host-details-sections).
- Search on the docs website: the box at the top of every page (`/` goes to it) finds topics as `:help` does and text as `:helpgrep` does, opens one with the keyboard, and lists every match on `search.html?q=WORDS`. It runs in the page; nothing is sent anywhere. See [On the web and on paper](app/help.md#on-the-web-and-on-paper).
- **Every panel and view docked, at your width, or full window:** `:help`, Host details, the forms, `:plugins` and every Plugin view (Topology, Discover, the Mesh controls). `␣ z` (or the button by a panel's close) makes the panel you're in full window and back, `␣ <` and `␣ >` narrow and widen it, and its edge drags; the terminal fits its new size once, when the drag ends. Each panel remembers what you chose; `init.lua` sets the defaults with `panel.width` and `views = { topology = { place = "panel", width = 60 } }`, and `:panel reset` forgets your choice. A Plugin's `place` is now only where its view opens first. See [Panels](app/keyboard.md#panels-docked-or-full-window).
- **Several docked panels share one limit:** however many are docked, the terminal keeps 400 px (about 50 columns) beside them; they narrow in proportion, and when even their minimums don't fit they float over the terminal, side by side, as in a narrow window, where several panels on one side no longer lie on top of each other. See [Panels](app/keyboard.md#panels-docked-or-full-window).
- A Plugin's heading buttons on a view or a Host-details section take a key of their own (`key`, Plugin API 4), which runs them from anywhere in it; the Mesh controls' Cut on a Host's Mesh section is `x`, and that section lists only the Host's Links now (its own row is gone: the facts and the Cut say it). `roster serve`'s `mesh.*` and `discover.*` results are typed in the Plugin API reference and `types/roster.lua` (`MeshResult`, `DiscoverStatus`, …). See [Views](plugins.md#views-tables-and-host-details-sections) and [roster serve's results](plugin-api.md#roster-serves-results).
- Plugin views and Host-details sections take buttons on their heading (`actions`, with new `plan`, `apply` and `cut` icons), a notice can carry a button that opens a view when a background job finishes (`roster.notify(text, level, { actions = … })`), and `roster.views.update(id, { clear = true })` empties a table in one go. Tables cut a long name or address in the middle, keeping its end, and scroll sideways when narrow; focus goes into a view's table after its rows arrive, a question or a float. The Mesh controls use all of them.
- Plugins can add a section to `:check` that runs each time, like Neovim's `vim.health`: `roster.health.set(id, { check = function() … end })`. Its OK, WARNING and ERROR lines show under the Plugin's name on [Health](health); one that fails or doesn't answer in time is an ERROR line of its own. See [Health sections](plugins.md#health-sections).
- `:check %` checks the Host of the Session on screen, as Vim's `%` is the current file. See [Health](health).
- Plugin API 3: `roster.inventory.groups()`, `roster.keymap.del`, `roster.themes.remove` and `coroutine`. A row's, a button's, a finder item's or a status segment's function is told which one ran it and, with `inventory.read` or `terminal.read`, the Session on screen ([`HandlerContext`](plugin-api.md#handlercontext)).
- `:plugins types PATH` writes the Plugin API's types for this app (`types/roster.lua`) into a Plugin's folder, for lua-language-server. See [Types in your editor](plugins.md#types-in-your-editor).
- Plugins get timers: `roster.defer(ms, fn)` runs a function once, later, and `roster.every(ms, fn)` again and again until `roster.cancel(timer)`, on the Plugin's own thread; they end with the Plugin. recent-alerts uses one so its rows say "4 min ago" and stay true. See [Timers](plugin-api.md#rosterdeferms-fn).
- `roster.has(permission)` tells a Plugin whether it was granted a permission, before it listens for an event that needs one. A finder's `items` can be a function, run each time the finder opens.
- `?fixture=recent-alerts` in a plain browser (`npm run dev`) shows the example Plugin running with alerts, for checking Plugin UI headless.
- Plugin graphs: a Plugin's view can hold a graph of nodes, edges and clusters, drawn as roster's network map (Topology uses one). Move between nodes with `h` `j` `k` `l`, search with `/`, collapse a cluster to its count with `o`, zoom and pan; selecting a node lights up what it can reach and what can reach it, with the counts. Each node keeps its place between openings, 2,000 nodes stay smooth, and `t` lists every node and edge as a table.
- Plugin views and tables: a Plugin can add a side panel or a full view (`roster.views`), opened with `:view ID`, a key it binds, the `views` finder or its own command, with Esc taking you back. Its table sorts, moves with vim keys, runs actions on the selected row with a key or a button, takes rows changed in place as a scan finds them, and stays smooth at thousands of rows. A Plugin can also add a section to a Host's details (`roster.details`). See [Views, tables and Host-details sections](plugins.md#views-tables-and-host-details-sections).
- `:packages update NAME` checks one Package for a new version instead of all of them, and `:packages install NAME` asks again about a Package whose install you cancelled. A cancelled install is remembered: it no longer asks at every start while `init.lua` names it, and `:packages` shows it as cancelled. See [Packages](plugins.md#packages).
- What can go wrong with Packages and Plugins is in the error catalog: a repo that can't be fetched, no `git`, a new version that can't be used, a Plugin that can't load and one that's turned off. See [Packages](app/errors.md#packages) and [A Plugin stops](app/errors.md#a-plugin-stops).
- Packages from a folder of a repo: `dir = "plugins/NAME"` in a Package's line in `init.lua` loads the Plugin from that folder, so one repo can hold several Plugins. The install and update prompts show the folder, `roster.lock` keeps it, and `:packages update` shows only what changed in it. A folder outside the repo (`..`, a full path, a symlink that leads out) is refused. roster's own optional Plugins live this way, in its repo's `plugins/` folder, none bundled in the app. See [Packages](plugins.md#packages) and [First-party Plugins](plugins.md#first-party-plugins).
- Each Plugin has a data folder of its own: `roster.storage.read`, `write`, `list`, `remove`, `read_json` and `write_json` keep files there by name, with no permission to ask for. It's never the config folder or on the network, a write is all or nothing, a link there is never followed, and it holds up to 10 MB; `:plugins remove` and `:packages clean` remove it. See [A Plugin's own files](plugins.md#a-plugins-own-files).
- Plugin API 3 also gets what Folders needed, for any Plugin: `roster.echo` (the message line), `roster.cmdline` (the command line with one of its commands typed in), a command's `complete`, the Host and row under the Sidebar's cursor in a command, Sidebar rows that fold, draw as the Inventory's Hosts and take drag and drop, and a finder over a Plugin's own section.
- Plugins can talk to web services: `network:api.example.com` in a manifest grants `roster.http.request` and `roster.http.get` for that site only (`*.example.com` for the names under a domain, `http://` and `:PORT` when written). The requests run in roster's core, don't block the Plugin, follow redirects only to its sites, and never reach this computer or a private network by name. The install prompt and `:packages update` show every site, flagged, and an update that adds one asks again. See [The network](plugins.md#the-network).
- Plugins can reach a homelab name, a self-signed appliance and the web behind a proxy (decision Q116): `network:private:nas.lan` reaches a name on your private network and only private addresses there, with a warning of its own in the install prompt; `#sha256:FINGERPRINT` after an https site trusts exactly that certificate for that site; and `plugin_proxy = "http://10.0.0.5:3128"` in `init.lua` is your proxy for Plugins' requests to public names, never with credentials. `:plugins` says under each granted site how many requests went there and how many got no answer. See [The network](plugins.md#the-network).

- The Mesh controls, the first first-party Plugin (`plugins/mesh`): `:mesh` shows every Host in the Mesh with what it **can reach**, "Mesh out of date" in the status bar after a Publish, `:mesh plan` and an apply you confirm after looking at the plan, a Cut you confirm by typing the Host's name with a warning per Host that was down, Links through a jump Host and why a `no-via` one is left out, and a Mesh section in each Host's details. Install it with `{ "https://github.com/2styx2/roster", dir = "plugins/mesh" }` in `init.lua`'s `packages`. See [the Mesh controls](../plugins/mesh/README.md) and [The Mesh in the app](mesh.md#in-the-app).
- The Topology view, a first-party Plugin (`plugins/topology`): `:topology` (`␣ T`) draws this Box, every Host by group and the Mesh as a map, with live Sessions in the accent, password peers and Hosts out of the Mesh apart, Links with their direction and hop, and what's out of date, pending or being cut marked. Select a Host to see everything it can reach and everything that can reach it, every hop away, with the counts; `:topology GROUP` shows one group; Enter opens a Session, `c` checks the Host and `x` cuts it from the Mesh after you type its name. It stays quick at 2,000 Hosts. Install it with `{ "https://github.com/2styx2/roster", dir = "plugins/topology" }` in `init.lua`'s `packages`. See [the Topology view](../plugins/topology/README.md) and [Seeing the Mesh in Topology](mesh.md#seeing-the-mesh-in-topology).
- Plugin graphs filter: `f` picks a cluster, kind or state to show and hides the rest (the node and edge lists follow), and a Plugin can set the filter (`filter = { clusters = { "lab" } }`) or count reach one hop away instead of every hop (`reach = "direct"`). A Plugin can run `:check HOST` with `serve:host.check`. See [Graphs](plugins.md#graphs).
- Plugins can ask, show progress and act for you: `roster.confirm` asks a question the app draws (a stronger form, starting on Cancel and asking you to type a Host's name, for a Mesh Cut), `roster.progress` shows something long in the status bar with a stop button and `:cancel`, `roster.toolbar` adds a toolbar control, a Sidebar section can have buttons on its heading ("Dismiss all"), a floating window can have buttons and links, `roster.cmd(line)` runs a command line, and `roster.sessions.show(session, line)` goes to a Session by its id and finds the line in it. A table filters with `/`, an action can apply only to some rows, and `roster.views.update` can change its columns, sort and actions. See [Asking, progress, the toolbar and going places](plugins.md#asking-progress-the-toolbar-and-going-places).

- **Discover from the app**, as a first-party Plugin: `{ "https://github.com/2styx2/roster", dir = "plugins/discover" }` in `init.lua`'s `packages`. `:discover 10.0.0.0/24` (or the toolbar's **Scan**) asks first, then scans from the Box through `roster serve`, with its progress in the status bar and a stop button; what answers fills a table as it's found, with the name each would get, what it looks like and its open ports. Keep the ones you want (`m`) and add them (`A`): they go in a new group, unreviewed, as Pending changes. A Plugin can start a scan or an add only from something you did. `:check` says whether the Box's roster can scan. See [discover](../plugins/discover/README.md).
- Plugins hear roster serve's jobs as they go: the `job_progress` event (a Mesh run with `serve:mesh.job`, a scan with `serve:discover.status`) instead of asking every second, and a `:check` section can answer later (`return "later"`, then [`roster.health.answer`](plugin-api.md#rosterhealthanswercheck-lines)), so it never waits for serve. The Mesh controls, Discover and Topology use both. One Plugin can't take every one of serve's workers: each has 2 calls into it at a time, all of them 4. See [Asking roster serve](plugins.md#asking-roster-serve).
- Plugins can ask roster serve without waiting: `roster.serve.request(method, params, function(result, err) … end)` (Plugin API 3), with the same permissions as `roster.serve.call`. The answer to a request made in your action is part of it, so the Plugin can ask you a question with what serve said. The Mesh controls and Discover use it, so they keep answering while serve is busy with a Publish.
- Plugin graphs: `m` moves the selected node from the keyboard (`h` `j` `k` `l`, Enter keeps the place, Esc puts it back), the filter (`f`) takes several clusters, kinds or states at once from a menu of checkboxes, and an action's `when` (`{ state = "live" }`) runs it and shows its key only on the nodes it names. Cluster titles show whole where there's room, and an empty node or edge list keeps the focus, so `t` goes on. See [Graphs](plugins.md#graphs).

**CLI**

- `roster discover --json` prints its preview (what the scan found, with the names `--write` would give) and `roster mesh --dry-run --json` its plan, as `discover.plan`/`discover.status` and `mesh.plan` shape them, never a secret. See [Machine-readable output](cli-reference.md#machine-readable-output).
- `--json` on the read commands, for scripts, other tools and Claude: `roster hosts`, `info`, `resources`, `check` (with a HOST and `--box` too), `mesh status`, `providers` and `auth-check` print one JSON document with a `version`, using the Host, group and resource objects `roster serve` uses. It never holds a secret: Logins are references, with `cmd:` and `env:` ones cut to their kind. Errors are JSON on stderr, with the usual exit status; `ROSTER.md` tells Claude to use it. See [Machine-readable output](cli-reference.md#machine-readable-output).
- `roster serve` scans a network for the app (API 18): `discover.plan`, `discover.start`, `discover.status`, `discover.stop` and `discover.add`, codes 120-123. The scan runs in the background, a batch at a time, and can be stopped. See [Discover](serve-api.md#discover-discoverplan-discoverstart-discoverstatus-discoverstop-discoveradd).
- Mesh Links through a jump Host: `via: HOST` on a `links:` entry sends it through that Host with `ProxyJump`, and the peer's `from=` names the address it actually sees. `roster mesh --dry-run` shows the hop, and the reachability test runs through it. See [Through a jump Host](mesh.md#through-a-jump-host).
- `seen_as:` on a Host lists its other addresses (one or a list), which every Mesh peer's `from=` accepts beside its `ip:`: for a jump Host with a leg on each network, or a Host behind NAT. See [Other addresses](mesh.md#other-addresses).
- `mesh_dir:` on a Host, group or `defaults` says where a Mesh source keeps its files, for an ESXi Host with no datastore roster would pick; roster checks it on the Host first. See [`mesh_dir:`](mesh.md#esxi).
- `roster.yml` takes a per-Host (or group, or defaults) `sudo: { auth: "bw:esx-02 sudo" }`: the vault reference for that Host's own sudo password, which the app's fill key uses. See [A separate sudo password](adding-hosts.md#a-separate-sudo-password).

**serve API (API 25)**

- `session.fill {host, address, port, user, prompt}`: the password for sudo's prompt (or ssh's to the Host itself) a Host Session shows, for the app's core to type, and the one result with a secret; codes 130 (a prompt roster won't fill, or a Host changed since its Session connected) and 131 (no saved password). `session.prepare` says what each Session connects to (`login`). See [serve-api.md](serve-api.md#filling-a-password-prompt-sessionfill).

**serve API (API 24)**

- `mesh.cut`'s result has `warnings`: an earlier `mesh_dir:` the cut Host still holds a Mesh key in, which roster never removes. The Mesh controls show each as a warning after the cut. See [Cut](mesh.md#cut).

**serve API (API 23)**

- On native Windows, `vault.login` signs bw in with a password or SSO too: it drives `bw login` on a pseudoconsole (ConPTY), where it answered `59` before. There the `sso` step's `url` is `null`, because bw opens the sign-in page in the default browser itself; the app says so instead of showing a link. See [Signing in](serve-api.md#signing-in-vaultlogin).

**serve API (API 21)**

- `$/cancel {id}` stops a request sent earlier: one still queued or waiting for a lock never runs (code 5, nothing done), a running `host.check` or waiting Mesh run stops its job, and anything else that runs finishes, so nothing is half-written; `vault.lock` is never cancelled. The app's core sends it whenever it gives up waiting. See [Cancelling](serve-api.md#ordering-locks-and-jobs).
- `host.check` runs as a job (kind `check`, one per Host): `background: true` answers at once, `job.progress` says which step it's on, and `host.check_job` has the result (code 49: no such check); the waiting form answers as before. `vault.lock` stops a running check instead of waiting up to 45 s for it. The app checks a Host this way, so a check no longer holds one of serve's workers. Plugins hear check jobs with `serve:host.check_job`. See [Diagnostics](serve-api.md#diagnostics-hostcheck).
- An unlock has a worker of its own, so it never waits behind 8 busy requests, and `vault.status` waits for an unlock sent before it, so the app's check after an unlock it stopped waiting for sees what the unlock did. Vault items are made one at a time per vault (bw's and pass's CLIs aren't known to take two writes at once).

**serve API (API 20)**

- `roster serve` answers several requests at once: a quick read (the Host list, the Mesh's state, a job's progress) answers while a Publish, a `:check HOST` or a Mesh plan runs, and answers can come back in another order than asked. Writes to `roster.yml` and the vault's lock still take turns, through a lock each; one that waits past its time is the new code 4, with nothing done. Mesh runs and Discover scans are jobs: `jobs.list`, `jobs.stop`, and the `job.progress` notification as they go; serve's exit stops them all at once and records what they didn't do. See [Ordering, locks and jobs](serve-api.md#ordering-locks-and-jobs).

**serve API (API 19)**

- `grouped: true` on `mesh.status` says each meshed group once (`meshed`) and leaves out of `links` the pairs it covers, so a map of 2,000 meshed Hosts gets 2,000 names instead of 98,000 Links. See [The Mesh](serve-api.md#the-mesh-meshplan-meshapply-meshcut-meshstatus).

**serve API (API 17)**

- Mesh jobs: `background: true` on `mesh.plan`, `mesh.apply` and `mesh.cut` answers at once and runs the Mesh in the background; `mesh.job` says how far it has got and how it ended, and `mesh.stop` stops it before its next Host. `brief: true` on `mesh.status` and `mesh.job` keeps the answer small when a meshed group of hundreds of Hosts makes every pair a Link, and marks a `no-via` Link without connecting. Error code 111: a Mesh run while a job runs. See [The Mesh](serve-api.md#the-mesh-meshplan-meshapply-meshcut-meshstatus).

### Changed

**App**

- **A quieter message line, as Neovim's:** errors, warnings, answers (`:info`, `:config path`) and results that need attention (a Publish, a save roster warned about) still show, but a routine action's confirmation (a Host saved, added, moved or renamed, "Reloaded init.lua") and a toggle's tip ("Sidebar hidden, and kept that way. modes.standard.sidebar = false in init.lua makes it the default") no longer do: you see what changed. `:messages` lists the recent ones, quiet ones too; `:messages all` brings them back to the line (the app remembers it), or `ui.messages = "all"` in `init.lua`, which wins. A screen reader still hears what changed. See [`ui.messages`](app/config.md#fonts-and-the-terminal).
- **Plugins are quiet like roster:** a Plugin's info notice ("Copied esx-02's address") no longer pops up unless `ui.messages = "all"`, and a Plugin marks a routine confirmation on the message line quiet with `roster.echo(text, { quiet = true })`, as Folders now does for "Added esx-02 to Lab". Warnings, errors, answers and a notice with buttons still show, a screen reader still hears the quiet ones, and `:messages` keeps them all, notices too. `:cancel`'s "Stopping …" is quiet as well: the progress itself says it's stopping. A notice that needs attention says `{ quiet = false }`. Plugin API 4. See [`roster.echo`](plugin-api.md#rosterechotext-opts) and [`roster.notify`](plugin-api.md#rosternotifytext-level-opts).
- A Plugin's error about data that can't be handed over names the function and where in the table (`roster.sidebar.set: rows.3.label: a thread can't be a Plugin value`), and every `remove` checks its id as `set` does. `session_exit` names the Host of a tab closed while its Session ran.
- A command line a Plugin hands over (a row's, a button's, a finder item's, a status segment's) runs only if it's one of that Plugin's own commands or one of [the few of roster's a Plugin may run](plugin-api.md#command-lines-a-plugin-may-run): a button can no longer run `:plugins grant …` whatever its label says. `roster.sessions` is there for every Plugin now (for `show`); `roster.sessions.open` still needs `sessions.open`.
- A Plugin's key binding (`roster.keymap.set`) runs its line through the same check as a button's, each time the key is pressed: a key can't run `:plugins grant …`, `:packages`, `:source` or another Plugin's command. `:keys` shows such a binding as `plugins run NAME LINE`. See [The `roster` module](plugins.md#the-roster-module).
- A Plugin granted `serve:changes.diff` or `serve:host.check` gets a `cmd:` or `env:` Login reference cut to its kind in the diff's text and the check's messages too, as it already was in an `auth`: `cmd:` to the end of its line, `env:` without the variable's name. roster's own Pending changes and Health pages still show it whole. See [Security](app/security.md#plugins).
- A Plugin's progress shows in Focus too, in the top-right corner (it was hidden with the status bar), with its stop button. With several at once in a narrow window, the latest keeps its title and the others show only their track and share. See [Plugins](plugins.md#asking-progress-the-toolbar-and-going-places).
- A click or a timer from before a Plugin was reloaded can no longer run one of the reloaded Plugin's functions: each load's functions have numbers of their own. A table's actions that `roster.views.update` replaced are dropped at once.
- The Picker's ⓘ shows on the selected row only, as a Sidebar row's buttons do: a row under a resting pointer no longer shows one too.

- `terminal_output` sends the lines a Session's terminal commits, read from a terminal of its own, instead of the raw output with a one-second repaint filter: a progress bar arrives as it ended, a wrapped line comes whole, the screen ConPTY prints again after a resize is never output, and what full-screen programs (`vim`, `top`) draw isn't sent. See [Events](plugin-api.md#events).
- In a Plugin, `pairs` visits keys in order (numbers, then text), so the same state makes the same changes on every machine. An empty table reaches the app as `{}`, which it takes as an empty list.
- A Plugin's Leader key that's taken is refused with a notice naming what has it and a few free keys like it (`␣ f is taken (by builtin: find). Free after the Leader: a, g, h`).
- Folders is a built-in Plugin on the public API now, like the Host count: `:plugins` lists `folders`. It works as before (`␣ a`, `␣ A`, `:folder`, drag and drop, init.lua's Folders), and keeps your Folders in its own data folder instead of `folders.yml`. At the first start, `folders.yml`'s Folders move in, every Host included; one that doesn't parse moves nothing until it's fixed. After that the app doesn't read or write `folders.yml`: `:check` says so, and you can delete it. A Folder that was folded stays folded (its id is `folders:NAME` now, and the old one still works with `:fold`). See [`folders.yml`](app/config.md#foldersyml).
- A Plugin whose manifest, `init.lua` or a module is a symlink (or a junction) leading outside its folder doesn't load, for a local Plugin and a Package alike. See [A Plugin's files](app/errors.md#a-plugins-files).
- `init.lua`'s `modes` no longer warn "no section named …" or "no segment named …" for a Plugin's section or status segment: the names are checked once the Plugins have loaded.
- A Plugin's finder can have a `prompt` of its own (`Folders ›`); without one it shows its title, once (finders with items showed `›` twice). See [`roster.finders.set`](plugin-api.md#rosterfinderssetid-finder).
- A Plugin waiting for roster serve (behind a Publish, say) is no longer given up on and disabled after two seconds: waiting for serve never counts against a Plugin, for that call or for the calls queued behind it (`:help plugins`).
- Discover and Topology take `leader = false` in their `config`, as the Mesh controls do: they bind no Leader key, and the command (and Discover's **Scan**) still works. See [discover](../plugins/discover/README.md) and [the Topology view](../plugins/topology/README.md).

**CLI**

- `roster mesh cut HOST` warns about an earlier `mesh_dir:` it leaves on HOST, where it said nothing. See [Cut](mesh.md#cut).
- `ROSTER.md` tells Claude to run `roster check <name> --json` when a Host doesn't respond, to see which step fails and its fix, rather than `roster check --only <name>`.
- The Mesh gives a new `authorized_keys` it makes on ESXi (a user other than root) the sticky bit, so ESXi keeps it across a reboot.
- Moving a Host to another group keeps the `mesh_dir:` it inherited (roster writes it on the Host). Removing a source's `mesh_dir:`, or changing it, warns about the old directory until you delete it, and replaces the old `Include` in `~/.ssh/config`. See [`mesh_dir:`](mesh.md#esxi).
- A source that stops being one and loses (or changes) its `mesh_dir:` in the same edit is cleaned up from the directory it used until now, the one the `Include` in its `~/.ssh/config` names: an old `mesh_dir:` is warned about and kept (it was roster's default directory that went, with no word about the old one), roster's own default directory is removed, and the old `Include` goes. See [`mesh_dir:`](mesh.md#esxi).
- Publish's generated commit message names the `links:` that changed (`roster: add link orion-2 -> storage`), as it does Hosts and groups, rather than "roster: edit roster.yml".

### Security

**App**

- A Plugin can act on the network or the Inventory only when you've just asked it to: every serve method the install prompt flags (`mesh.apply`, `mesh.cut`, `host.check`, `discover.start`, `discover.add`, …) and `roster.inventory.update`, `.rename`, `.move` and `.review` work only in an action, command, finder item, toolbar control or question's answer of its own. At load, on an event or from a timer they're now errors (only `discover.start` and `discover.add` were held before). See [Plugins](plugins.md#asking-roster-serve).
- Only what you chose counts as your call: a finder's items as it opens, a `:check` section's lines and a question's cancel when another Plugin's question replaced it can no longer copy, ask, run a command line or call those methods, so another Plugin opening a finder can't lend them your call.
- `cmd:` and `env:` Login references are now cut from roster serve's error messages to a Plugin too, not only its answers.
- `roster.cmd` holds a command named after one of roster's (`open`, `check`, `plugins`, …) to roster's rule even if the Plugin added a command of that name.
- A Plugin can no longer keep your call alive by running its own commands through `roster.cmd` one after another: the command `roster.cmd` runs from your call is still your call (one hop, as a `roster.serve.request`'s answer is), but a `roster.cmd` or request made in it isn't, so the next command can't copy, ask, run a command line or act on the network. Folders' drag and drop still works. See [Plugins](plugins.md#asking-progress-the-toolbar-and-going-places).
- The `job_progress` event is cut as roster serve's answers are: a `cmd:` or `env:` Login reference in a job's text (a failed check's error message echoes the Login) reaches a Plugin as `cmd:` or `env:`. The cut reaches an answer's keys now too, not only its values.

**CLI**

- On Linux and macOS, `roster serve` removes its askpass folder (the private password socket's) however it ends: closed stdin even mid-request, SIGTERM, SIGHUP or SIGINT. A serve killed outright can't, so the next one to start removes this user's folders whose serve is gone, never another user's, a live one's or anything a link points at. Windows has no such sweep: the password pipe ends with serve whatever happens, and a folder a killed serve leaves under `%TEMP%` holds only Quick Connect's public host keys. On Windows serve also checks each askpass pipe client's process is yours, on top of the pipe's permissions.
- A Host check stopped while it logs in (`vault.lock`, `jobs.stop`) ends that login's ssh, so locking no longer waits up to ~35 s behind it.
- `--json` cuts `cmd:` and `env:` references everywhere in its output: in a key as much as a value, and in a value that isn't plain JSON (a set or a path), which went out uncut.

### Fixed

**CLI**

- A Mesh source moved back to roster's own directory (its `mesh_dir:` removed) that still holds the key from before the `mesh_dir:` gets a warning that roster uses that old key again, with `roster mesh --rotate HOST` to replace it; it was used again without a word. See [`mesh_dir:`](mesh.md#esxi).
- On native Windows, closing `roster serve` during a Mesh run ends the run's ssh with everything it started, as a step that times out does, so `mesh.json` records which Hosts were left to do (an ssh that is a batch file kept running before).
- The Mesh no longer writes a `via:` Link whose jump Host this Box has no host key for: the source's own Link to the jump Host isn't written then, so `ProxyJump` would have named a Host its ssh config doesn't have. Both are `no-host-key`, and `roster check` fails until `roster setup --only HOST` records the key.
- `roster discover --json` with a broken `roster.yml` found without `-c` (`ROSTER_CONFIG`, or the usual places) is error `1` with its fix, where it was ignored silently; with none at all it still scans.
- `roster serve` started with a temp dir whose path leaves a Unix socket's no room puts its askpass folder in `/tmp` rather than fail.
- `roster discover` scans IPv6 networks (nmap takes them only with `-6`, in a run of their own), scans an address that two of its networks hold once instead of writing it twice, and counts the hosts that answered with none of the ports open, as it said it did (nmap ran with `--open`, which leaves them out).

**App**

- `init.lua` runs as a block, as Lua runs a file: a one-line `require("me")` of a module that only makes `roster.*` calls loads, where it failed with "init.lua must return a table (it returned a boolean)" unless the file had a second line. `return require("me")` of a module that returns nothing says what happened and what to do. A bare `{ … }` with no `return` is now a syntax error at its line. See [How it works](app/config.md#how-it-works).
- Among `roster.*` calls the last one wins, so a module of overrides required after a base module takes effect (the first call won before). The returned table still wins over calls. See [The `roster` table](app/config.md#the-roster-table).
- A Config error in a value a required module returns names that module and line (`lua/opts.lua:4: …`), and one roster can't place says `(line unknown)`; it gave `init.lua` with a parent key's line, or the line of a `roster.set` whose value the returned table had replaced.
- A Plugin call that fails no longer leaves the buttons it was replacing dead ("that action is gone"), nor timers and commands behind it; 100 failed calls could use up a Plugin's timers.
- A Plugin that asks roster serve in a loop gets an error after 100 calls (or 300 s of waiting) in one go, instead of running for ever and keeping serve from the app.
- An answer to what a Plugin asked while loading is no longer lost (first load) or put on the load before (reload).
- A Plugin command whose line runs itself, or two that run each other, stop with a notice instead of recursing until the app gives up.
- A Plugin's `pairs` costs far less on a list (about 7 times faster on 10,000 items) and on tables with only text or only number keys, in the same order as before.
- The install prompt says what `serve:host.check` does: it connects to the Host and signs in once, changing nothing there or in the Inventory (it said it could change things on your Hosts). And a Plugin's command named after one of roster's (`:theme`, `:lock`, …) is never its own to run with `roster.cmd`, whichever of roster's it is, not only the ones that change trust or writes.
- Closing the app gives `roster serve` up to 3 s (was 1 s) to stop a running Mesh job and record what it didn't finish before it's killed.

**serve API**

- `host.check`: a waiting check that had joined another request's check answers `5` as soon as it's cancelled, rather than keep its worker until that check ends (up to 45 s); the check goes on for the others.
- `host.check` (API 22): a waiting check cancelled stops the check only when no other request waits for it and none asked for it in the background, where cancelling a request that had joined someone else's check stopped it for both; the background form says whether it `joined` a running check, and the app's core stops only a check it started when it gives up on it. A check asked for while the last one is stopping is a new check, not the stopping one (which answered `ok: false` with its steps skipped). `host.check_job` still finds a check that ended after a newer check of its Host started (it was `49`). A check shares the vault only for the steps that fetch a secret or mint a token, so an unlock or a lock no longer waits up to 45 s for a check (the lock screen hung, then failed).
- `vault.undo_create`: an undo that fails in an unexpected way keeps the item, so it can be undone again (it was forgotten: the item stayed in the vault and a retry answered `63`).
- `vault.configure` no longer fails ("dictionary changed size") when roster.yml reloads with a new provider while it runs.
- Closing `roster serve` mid Mesh job stops the job at once and records in `mesh.json` what it didn't finish (pending), where the job died with serve and the next run didn't know; a step cut short leaves each file whole.
- `discover.*`: IPv6 targets scan (with `-6`), a scan of IPv4 and IPv6 targets together no longer fails sorting them, an address two targets hold is visited once (`targets` drops the one another covers), `quiet` counts the Hosts that answered with none of the ports open (nmap; it's 0 with the built-in scanner, which can't tell them from no Host), and the built-in scanner reads its Hosts' SSH banners at once rather than one by one, so a batch (and a stop) no longer waits minutes.
- A background `mesh.plan` or `mesh.apply` works the Mesh out once rather than three times, two of them while serve answers nothing else.

### Deprecated

**App**

- `folders.yml`: Folders made in the app are kept by the Folders Plugin now. It's read once, to move its Folders in, and then no longer; hand-written Folders go in `init.lua`. See [Deprecated names](deprecated.md).
- `roster.keymap.set(context, keys, false)`: use `roster.keymap.del(context, keys)`. It takes the Plugin's own binding off now, rather than claiming the keys with no action. See [Deprecated names](deprecated.md).

## v0.2.0

### New

**App**

- `:tutor`, like Neovim's `:Tutor`: four short lessons you do rather than read, on a demo Inventory of made-up Hosts under a "Demo Inventory" banner, so nothing you try reaches your network. Each step ticks itself when you do it, and `:tutor` comes back where you left off; your own Sessions keep running behind it. Plugins can ship tutorials too (`roster.tutor.set`). See [the tutor](app/help.md#the-tutor).
- Host details: `␣ i`, `:info HOST`, the ⓘ on a Host's row and `Ctrl+i` in the Picker show what `roster info HOST` shows (address, services, the Vault item each Login uses by name) in a side panel, and `:open SERVICE` opens a web service in your browser. See [`:info`](:info) and [`:details`](:details).
- Sign out of the vault to use another account: `:vault signout`, or "Use a different account" on the lock screen. It asks first, naming the account. See [Signing out](app/errors.md#signing-out).
- Help, redone the way Neovim's is: an index grouped as Getting started, Make it yours, Reference, Extending and What's new; [Getting started](app/start.md); `:helpgrep TEXT` searches every page; `g O` is a page's outline; `Ctrl+]` follows a link; the generated [Quick reference](quickref) and [Every topic](all) pages, [Recipes](app/recipes.md), [How far roster bends](app/extending.md), and the CLI's docs in help too ([The roster command](cli-reference.md)).
- Help from where you are: in the command line, `Ctrl+]` or `F1` opens help on the command you're typing, and Esc in help brings the line back as you left it. In App mode, `␣ F1` opens help on what's selected (a Host's row: `:connect`), and `F1` does the same in the Picker, every finder and the Key bindings panel. See [Help from where you are](app/help.md#help-from-where-you-are).
- Health: `:check` with no Host checks this Box (roster, `roster.yml`, ssh, the vault, askpass, the infra repo) without connecting anywhere, and shows the result as the [Health](health) page, each check with its fix and help topic. `:help health` shows the last one.
- The docs on the web and on paper: every `:help` page is a website, [2styx2.github.io/roster/](https://2styx2.github.io/roster/), with a stable address for every topic (`tag.html?t=terminal.size`), and one PDF on each Release. Both are made from the same pages as help in the app. See [On the web and on paper](app/help.md#on-the-web-and-on-paper).
- What's new: this page, `:help news`, and the status line says once after an upgrade that it's there. Old names that still work are on [Deprecated names](deprecated.md), and `:help` on an old name lands on its row.
- roster on Windows without WSL: `backend = "local"` in `init.lua` runs the roster installed on Windows itself, with Windows' own OpenSSH, and `"auto"` takes it when it finds your Inventory there. Changing `backend` and `:source` starts roster again on the new one, both ways. See [`backend`](backend).
- Plugins: Lua that adds commands, keys, Themes, Sidebar sections, finders, status segments, badges, floating windows and help pages, drawn in roster's own style. `:plugins install PATH` asks first, naming every permission it wants and why a risky one is risky; `:plugins` lists them with their permissions as switches, and turning one off takes it away at once. A Plugin never sees a password or the vault, and can't Publish. See [Writing a Plugin](plugins.md).
- Packages: name Plugins from git repos in `init.lua` (`packages = { { "owner/repo", tag = "v1.0.0" } }`), the way lazy.nvim does it. The app fetches them into its own data folder, asks before running one, and pins each commit in `roster.lock` next to `init.lua`, so your dotfiles get the same versions everywhere, offline included. `:packages update` shows each new commit and its diff, and asks again for any new permission, before applying it; `:packages clean` removes what `init.lua` no longer names. See [Packages](plugins.md#packages).
- recent-alerts, an example Plugin to copy: it lists the lines your Sessions print with `ERROR`, `panic` or `disk full` in the Sidebar, with the Host and time, a badge on the Host, a `⚠` count, a finder and `:alerts`. It asks only for `terminal.read`. Plugins can now copy text with `roster.clipboard.copy`, only when you choose one of their actions. See [A first Plugin](plugins.md#a-first-plugin).
- The Plugin API reference: every `roster.*` function with its parameters, returns, errors, permission and an example, and every type (a Host, a Sidebar row, an event) with all its fields, generated from the app itself so it can't go stale. `:help roster.inventory.host()` or `:help roster-Host` opens one entry. Its types also come as `roster.lua` for lua-language-server, so your editor completes `roster.` and checks your Plugin. See [The Plugin API](plugin-api.md).

**CLI**

- The Mesh: `mesh:` on a group or Host and top-level `links:` in `roster.yml` say which Hosts reach which, and `roster mesh` sets it up from this Box, one Host at a time (a key made on each source, tagged entries on its peers; `--dry-run` shows the plan). `roster mesh status` shows who reaches whom without connecting, and `roster mesh cut HOST` takes a Host out everywhere at once. `roster check` reports the Mesh's drift. See [The Mesh](mesh.md).
- `roster check --box`: this Box's health, like Neovim's `:checkhealth`, each check `ok`, `warn` or `error` with its fix. Local only: it never connects to a Host. See [`roster check --box`](cli-reference.md#roster-check---box).
- roster runs on Windows itself: `uv tool install .` there, and it uses Windows' built-in OpenSSH, keeps its files in `%APPDATA%\roster`, and gives password Sessions their password over a named pipe only you can open. See [On Windows](cli-reference.md#on-windows).
- A man page: `man roster` after `roster man --install`, generated from the parser and [The roster command](cli-reference.md#commands). The Release's files carry it too.

**serve API (API 14 to 16)**

- API 14: `vault.logout` signs the vault CLI out, after forgetting every secret roster holds.
- API 15: the Mesh's `mesh.plan`, `mesh.apply`, `mesh.cut` and `mesh.status`, and error code 110. See [The Mesh](serve-api.md#the-mesh-meshplan-meshapply-meshcut-meshstatus).
- API 16: `box.check`, this Box's health. See [This Box's health](serve-api.md#this-boxs-health-boxcheck).

### Changed

**App**

- The finders say how many results a query left, and "No matches", to a screen reader once you stop typing; help's search count is announced as it changes; the outline's section sits at the right, as in `:helpgrep`.
- Linux: when WebGL can't start or loses its context, the terminal draws with the DOM renderer instead, and `:info` names the renderer in use and how fast the Picker opened. The Enter that finishes an input-method word (IBus, Fcitx) no longer also opens a Host. See [Linux and WSLg](app/dev/linux.md).
- A Sidebar row's buttons (ⓘ, rename, remove…) show only on the row you clicked, or under the App-mode cursor, never on hover, so a row's address stays in view until you click it. In App mode the cursor starts on the row you clicked.
- `:edit`, `:host add` and Save to vault open at once instead of waiting on "Pulling the infra repo…". They pull in the background only when the last pull is older than [`pull_fresh_minutes`](pull_fresh_minutes) (5 by default), and Save waits for that pull. A pull that changed the Host you're editing updates the fields you hadn't touched and says so. A pull that fails blocks the save, not the form.
- Code in `:help`, on the docs website and in its PDF is coloured: Lua, shell, YAML, JSON and TOML, each from your Theme's new syntax colours (`syntax_keyword`, `syntax_string`, … in `colors` or a Theme of your own; a Theme that leaves them out gets its base's). A `:command` in a sentence reads as one, and a shell line like `roster sync --dry-run` is coloured as in a block. Headings, code and tables on the help pages were retuned for reading, and the PDF prints code in a palette that holds in greyscale. See [Code's colours](app/themes.md#codes-colours).

**CLI**

- `roster setup` and `roster revoke` rewrite a Host's `authorized_keys` as a new file moved into place, keeping its mode: a run cut short (a timeout, a dropped connection) leaves the old file whole, where before it could leave it empty and lock everyone out.

## v0.1.0

The first Release, after iteration 4: the CLI and the app, built and tested together.

### New

**CLI**

- One `roster.yml` for a team's Hosts, their Logins and Resources, with the secrets in a vault: Bitwarden, 1Password, `pass`, KeePassXC (local only), environment variables or a command. See [`roster.yml`](cli-reference.md#rosteryml) and [Password providers](cli-reference.md#password-providers).
- `roster setup`, `sync`, `check`, `hosts`, `info`, `run`, `web`, `discover` and the rest: [Commands](cli-reference.md#commands).
- `roster serve`, the JSON-RPC API the app talks to roster through, at API 13: [The roster serve API](serve-api.md).

**App**

- The Picker (`␣ f`) and Sessions, with key or password Logins; the Sidebar with Sessions, Folders and the Inventory; Focus mode (`F11`).
- The Live Inventory: add, edit, rename, move and remove Hosts and groups, then `:changes` and `:publish` to the infra repo. Quick Connect to a box that isn't in the Inventory, and Save to vault after a Session's own login.
- Your [`init.lua`](app/config.md): the Leader, every key, Themes, fonts, the layout of each view mode, this Box's vault settings; `:source` reloads it.
- The lock screen with the full vault sign-in, the idle lock, and a clean message and fix for every way a Session can fail ([Connection errors](app/errors.md)).
- `:help`, the docs inside the app, Neovim-style.

### Deprecated

**App**

- The development env vars `ROSTER_DESK_ROSTER` and `ROSTER_DESK_WSL_DISTRO`, from when the app was called roster-desk: use `ROSTER_APP_ROSTER` and `ROSTER_APP_WSL_DISTRO`. See [Deprecated names](deprecated.md).

## See also

[Deprecated names](deprecated.md) · [Getting started](app/start.md) · [Cutting a Release](releasing.md)
