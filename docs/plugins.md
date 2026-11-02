# Writing a Plugin

A Plugin is a folder of Lua that adds to roster the way the app's own features do: commands, key bindings, Themes, Sidebar sections, finders, status segments, toolbar controls, badges on Hosts, floating windows, views (side panels and full views with tables or graphs), sections of a Host's details and of `:check`, questions the app asks for it, progress, notices, help pages, timers, files of its own and, with a `network:` grant, requests to the sites it names. It runs in the same sandbox as your `init.lua` ([config.md](app/config.md#the-sandbox)), and it only gets the functions for the permissions you granted it. It never sees a password, the vault or what you type at a login prompt, and it can't Publish (ADR 0006, decision Q81).

A Plugin draws nothing itself. It hands the app data (rows, text, items) and the app draws them in roster's own style, with its keys and Theme, so a Plugin looks native and can't do anything else on screen.

## A first Plugin

[`examples/plugins/recent-alerts`](../examples/plugins/recent-alerts) is the worked example, built the way an author outside roster would build one: it watches what your Sessions print and lists the lines with `ERROR`, `panic` or `disk full` in a Sidebar section, with a badge on each Host that has some, a status segment with the count, a finder, a floating window with an alert's details, a notice when one arrives, `:alerts` and `:alerts clear`, a Leader key from its settings and its own help page. It asks for one permission, `terminal.read`. Copy the folder to start your own; its [README](../examples/plugins/recent-alerts/README.md) is the template for yours. [`examples/plugins/pinned`](../examples/plugins/pinned) is a smaller one that reads the Inventory.

```text
recent-alerts/
  roster-plugin.lua            the manifest: who it is and what it asks for
  init.lua                     its code
  lua/recent-alerts/match.lua  its own modules, if it has any: require("recent-alerts.match")
  README.md                    what it does, what it asks for and why, and its settings
```

The manifest is read before any of the Plugin's code runs, for the install prompt:

```lua
return {
  name = "recent-alerts",       -- lower case letters, digits and -; how it's known everywhere
  version = "1.0.0",
  description = "Lines your Sessions print that look like trouble",
  author = "you",
  api = 3,                      -- the roster.api_version it's written for
  permissions = { "terminal.read" },
}
```

And the heart of its `init.lua`, shortened:

```lua
local roster = require("roster")
local settings = roster.plugin.config          -- init.lua's config = { … }, when it's a Package
local alerts = {}

local function show()
  local rows = {}
  for i = #alerts, 1, -1 do
    local a = alerts[i]
    rows[#rows + 1] = { id = tostring(a.id), label = a.text, detail = a.host, host = a.host,
      actions = { { label = "Copy " .. a.text, icon = "copy", run = function() roster.clipboard.copy(a.text) end } } }
  end
  roster.sidebar.set("recent-alerts", { title = "Recent alerts", empty = "No alerts.", rows = rows })
  roster.status.set("alerts", { text = "⚠ " .. #alerts, run = "finder alerts" })
end

roster.commands.add("alerts", {
  desc = "Recent alerts",
  run = function(a) if a.words[1] == "clear" then alerts = {} show() end end,
})
roster.keymap.set("leader", settings.leader or "w w", "finder alerts")

-- Only with terminal.read: listening for an event it may not hear is an error.
if roster.has("terminal.read") then
  roster.on("terminal_output", function(e)
    for line in e.text:gmatch("[^\n]+") do
      if line:find("ERROR", 1, true) then
        alerts[#alerts + 1] = { id = #alerts + 1, host = e.host, text = line }
      end
    end
    show()
  end)
end
show()
```

Some things it shows that every Plugin meets:

- **Draw everything from your own state in one function.** Each `set` replaces what was there, so calling `show()` after any change keeps the section, finder, status and badges in step.
- **Check `roster.plugin.config`**: anyone can write anything in init.lua. Name a bad setting in a notice and use the default.
- **Ask only for what you need**, and keep working without it: check with `roster.has("terminal.read")`, and say what's missing (its section reads "Allow terminal.read in :plugins to see alerts.").
- **`terminal_output` comes as whole lines**, the way the terminal shows them once the Session moves past them; recent-alerts still keeps an unfinished end, which costs nothing.
- **Keep what you show true with a timer**: its rows say "just now", then "4 min ago", and `roster.every(30000, show)` draws them again while there are alerts; it cancels the timer when there are none.
- **Keys after the Leader that roster uses are refused** (`a` is Folders', `f` the Picker's; `:keys` lists them all), with a notice that names what has the key and a few free ones like it. Make yours a setting.
- **The same state makes the same changes**: `pairs` visits keys in order (numbers, then text), so badges set from a table of Hosts come out in name order on every machine. A list (`{ "a", "b" }`) costs about what `ipairs` does; other tables are sorted, so prefer `ipairs` for a list you walk often.

`:plugins install ~/plugins/recent-alerts` installs it. To share it, push the folder to a git repo: others name it in `init.lua` as a [Package](#packages). A path is `~/…`, a full path, or a folder under the config folder (`plugins/pinned`).

## Installing and trusting

- **`:plugins install PATH`** reads the manifest and asks first: who wrote it, where it's from (unverified), and every permission it asks for, with the risky ones flagged and explained. Cancel (`Esc`) installs nothing.
- **An update that asks for a new permission asks again** at the next start. Until you answer, it doesn't run. "Not now" runs it without the new permission.
- **`:plugins`** lists every Plugin: whether it's running or why it stopped, its permissions as switches, how full its [data folder](#a-plugins-own-files) is, and what it did lately. Turning a switch off takes the permission away at once: the Plugin is loaded again without it, with no restart. Turning it on grants it.
- **`:plugins remove NAME`** unloads it and takes everything it added away. **`:plugins reload NAME`** loads it again, after you've changed it or once it was stopped.
- `:plugins revoke NAME PERMISSION` and `:plugins grant NAME PERMISSION` do what the switches do.
- **`:plugins types PATH`** writes the API's types for this app as `types/roster.lua` in the Plugin folder PATH, over an older copy ([Types in your editor](#types-in-your-editor)).

What you granted is kept in the app's State, which neither `init.lua` nor a Plugin can write.

Every Plugin is made the same way, with the same API, the same prompts and the same install path. The two built into the app are written on this API too: `hosts` (the status bar's Host count) and `folders` (the Sidebar's Folders, with `:folder`, `␣ a` and `␣ A`, which keeps your Folders in [its own files](#a-plugins-own-files)). `:plugins` lists them, and revoking a permission takes away what it gives: the count, or Folders' checks of Host names.

Every file of a Plugin's code (the manifest, `init.lua` and each module it `require`s) must really be inside its folder: a symlink (or, on Windows, a junction) that leads out is refused, for a local Plugin and a Package alike, with the file named ([errors](app/errors.md#a-plugins-files)). A link that stays inside is fine.

## Packages

A Package is a Plugin from a git repo, named in `init.lua` and pinned to a commit, the way lazy.nvim does it for Neovim ([config.md](app/config.md#packages)):

```lua
packages = {
  { "someone/recent-alerts", tag = "v1.2.0", config = { patterns = { "ERROR", "panic" } } },
  "https://git.example.com/team/roster-extras.git",
},
```

- **Nothing installs that isn't named there.** At start, and on `:source` after you change the list, the app clones each new one into its own data folder (next to the State, never the config folder) and asks first, with the same prompt as `:plugins install`: who wrote it, its git URL and commit as the unverified source, and every permission. Cancel removes the clone and installs nothing, and the app remembers it: it doesn't ask again while `init.lua` names that Package from the same repo and folder. `:packages` shows it as cancelled, and **`:packages install NAME`** asks again. Another repo or folder under the same name is other code, so it asks; taking the line out of `init.lua` forgets the cancel.
- **`roster.lock`**, next to `init.lua`, pins each installed Package's commit. Put it in your dotfiles with `init.lua`: on another machine the app clones exactly those commits (and asks, since what you granted is per Box). With the clones and the lock in place, the app starts without the network.
- **`:packages`** lists them: the commit each is at, what `init.lua` asks for, and whether it runs.
- **`:packages update`** fetches each one and shows what's new before anything changes: the commits, the diff, and any permission the new version asks for. Enter updates (and grants what it newly asks for); Esc keeps the version it has. **`:packages update NAME`** fetches and checks only that one.
- **`:packages clean`** removes the clones and lock lines of Packages `init.lua` no longer names, with everything they added. **`:plugins remove NAME`** takes one out at once, clone and lock line included.
- **`config`** is a table of settings the Package reads as `roster.plugin.config` (a `config = function() … end` as in lazy.nvim isn't possible: the Package's code runs in a Lua state of its own, which a function from `init.lua` can't move into).
- **`dir`** loads the Plugin from a folder of the repo instead of its top, for a repo that holds several: `{ "https://git.example.com/team/roster-extras.git", dir = "plugins/alerts" }`. The clone is the whole repo; the Package is named after the folder (`alerts`) unless `name =` says otherwise. The prompts show the folder next to the git URL, `roster.lock` keeps it (another folder is other code, so it asks again), and `:packages update` shows only the commits, diff and manifest of that folder: a commit elsewhere in the repo isn't an update to it. The folder must be inside the repo: a full path, `..`, a backslash, `.git`, or a symlink that leads out of the clone is refused ([errors](app/errors.md#packages)). Two Packages from one repo each get a clone of their own, so each is pinned and updated on its own (decision Q94).

The app runs your system's `git` (it must be installed) with no shell, no credentials of roster's and no way to ask for any: a private repo works when your own git setup (an ssh agent, say) already gets in. Only `https`, `ssh` and `file` URLs, no submodules, and no hooks. What can go wrong fetching one (a repo out of reach, no `git`, a new version that can't be used) is in [the errors](app/errors.md#packages).

### First-party Plugins

Optional Plugins the roster project writes live in roster's repo, one folder each under [`plugins/`](../plugins/README.md), and install as Packages like any other (decisions Q81 and Q94): the same prompt, the same permissions, pinned in `roster.lock`. None is bundled in the app. What sets them apart is that they're reviewed like the core, tested in CI with it, and security-reviewed against [a checklist](../plugins/README.md#security-review). To install one, name it with `dir`:

```lua
packages = {
  { "https://github.com/2styx2/roster", dir = "plugins/NAME" },
},
```

| Plugin | What it does | Its line in `init.lua` |
|---|---|---|
| [mesh](../plugins/mesh/README.md) | The Mesh controls: each Host's reach, plan and apply, Cut | `{ "https://github.com/2styx2/roster", dir = "plugins/mesh" }` |
| [discover](../plugins/discover/README.md) | Scan a network from the app (`:discover 10.0.0.0/24`, the toolbar's **Scan**), watch what answers come in, keep the ones you want and add them, unreviewed, as Pending changes. The scan runs in `roster serve` ([`discover.*`](serve-api.md#discover-discoverplan-discoverstart-discoverstatus-discoverstop-discoveradd)); it asks before scanning and before adding | `{ "https://github.com/2styx2/roster", dir = "plugins/discover" }` |
| [topology](../plugins/topology/README.md) | The Topology view: this Box, every Host by group and the Mesh as a map, what each Host can reach every hop away, live Sessions, Check and Cut from a node | `{ "https://github.com/2styx2/roster", dir = "plugins/topology" }` |

[`mesh`](../plugins/mesh/README.md) is also the worked example of a Plugin that runs something long in roster serve: every Mesh run is a job it starts with `background = true`, follows by the `job_progress` event (a timer polling `mesh.job` only until the first push, for a serve before API 20), and stops with `mesh.stop`, because a Mesh run takes minutes and no worker of serve's should wait for it. [`topology`](../plugins/topology/README.md) shows how a big [graph](#graphs) stays small (a meshed group is one cluster with `mesh = true`, Links between clusters one edge), how to send only what changed with `roster.views.update`, and how to hand something slow to the app (`roster.cmd("check " .. host)`) instead of waiting for it.

## Permissions

A function a permission gives isn't there without it: `roster.inventory` is `nil` until `inventory.read` is granted. Each of them checks the grant again when it's called.

| Permission | What it adds | Why it's flagged |
|---|---|---|
| none | Commands, keys, Themes, Sidebar sections, status segments, toolbar controls, finders, badges, floats, views and their tables, Host-details sections, questions (`roster.confirm`), progress, notices, the message line (`roster.echo`), the command line (`roster.cmdline`), help pages, `roster.cmd` for [the commands that only show something](plugin-api.md#command-lines-a-plugin-may-run), going to a Session (`roster.sessions.show`), [its own files](#a-plugins-own-files) (`roster.storage`), the `lock` and `unlock` events | |
| `inventory.read` | `roster.inventory.hosts()`, `roster.inventory.host(name)`, `roster.inventory.groups()` and `roster.inventory.request(done)`: Hosts with their Login *references* (a vault item's name, never its password; a `cmd:` or `env:` one cut to `cmd:` or `env:`, since it says how a secret is fetched); the events that name a Host, and the Sessions open now (`roster.sessions.list()`); the Session on screen in a handler's context | |
| `inventory.write` | `roster.inventory.update(host, changes)`, `rename(host, to)`, `move(host, group)`, `review(host, reviewed)`: as Pending changes, which you review and Publish | Can change Hosts |
| `sessions.open` | `roster.sessions.open(host)`, as `:connect HOST`; `:open` and `:connect` in `roster.cmd` and a `run` line | Can open Sessions on your Hosts |
| `terminal.read` | The `terminal_output` and `command_done` events: what your Sessions print, and the commands that end in a shell with [shell integration](#shell-integration); the Session events and `roster.sessions.list()` | Sees everything your Sessions print, including anything a server echoes back. A password you type at a prompt that echoes it would be visible too |
| `terminal.write` | `roster.terminal.send(session, text)` | Can type into your Sessions, as if you typed it |
| `serve:METHOD` | `roster.serve.request(method, params, done)` and `roster.serve.call(method, params)` for that method only ([asking roster serve](#asking-roster-serve)): `inventory.info`, `hosts.list`, `host.get`, `host.check`, `host.check_job`, `changes.diff`, and the `mesh.*` and `discover.*` methods. Every method flagged in the next column (`mesh.apply`, `mesh.cut`, `host.check`, `discover.start`, `discover.add`, …) works only in a call the user started, never at load, on an event, from a timer, or in a finder's `items` or a `:check` section's `check` | Any method that can change something or reach the network (`mesh.apply`, `mesh.cut`, `discover.start`, `discover.add`, …): everything but `inventory.info`, `hosts.list`, `host.get`, `host.check_job`, `changes.diff`, `mesh.status`, `mesh.plan`, `mesh.job`, `mesh.stop`, `discover.plan`, `discover.status` and `discover.stop`. `discover.start` says it scans networks from this computer, and `host.check` that it connects to the Host and signs in once (it changes nothing there or in the Inventory) |
| `network:SITE` | `roster.http.request(request, done)` and `roster.http.get(url, done)`, to that site only | Always: anything the Plugin can read could leave this computer. Also said: plain `http://`, an address on this computer or a private network, a name on your private network (`private:`), and a pinned certificate (`#sha256:`) |

**What acts on the network or the Inventory waits for the user.** Every serve method the install prompt flags, and `inventory.write`'s `roster.inventory.update`, `.rename`, `.move` and `.review`, work only in a call the user started (decision Q100): at load, on an event or from a timer they're errors, whatever was granted.

No permission reaches a secret, nor how one is fetched: a `cmd:COMMAND` or `env:VAR` Login reference reaches a Plugin as `cmd:` or `env:`, from `roster.inventory`, `roster.serve.request` and `roster.serve.call` alike, in an error's message as in an answer (decision Q92), since a command line can carry a secret pasted into it. The vault, a session's password, askpass and the master password live only in `roster serve` and never pass through the app; the serve methods that touch them (`vault.*`, `session.*`, `quick.*`, `host.add`, `host.save_login`, `changes.publish`) can't be granted at all, and a manifest that asks for one doesn't install.

### Asking roster serve

roster serve answers several requests at once, but a Plugin's question can still wait: for its turn (each Plugin has 2 calls into serve at a time, across reloads too, and all Plugins together 4, taken in the order asked, so one Plugin can't take serve from the others or from the app), or for `roster.yml` behind the app's own Publish, for a minute or two. `roster.serve.request` doesn't wait; the Plugin keeps answering the user, and `done` gets the answer when it comes:

```lua
roster.commands.add("count", { run = function()
  roster.serve.request("hosts.list", {}, function(r, err)
    if not r then return roster.notify(err, "warn") end
    roster.echo(#r.hosts .. " Hosts") -- an answer: it shows
  end)
end })
```

`done(result)` or `done(nil, why)` runs on the Plugin's thread as a call of its own. **The answer to a request made in a call the user started is part of that call:** `done` may open a view, ask a question (`roster.confirm`), copy or run a command line, and ask for `discover.start` or `discover.add`, as the call could. A request made in that `done` doesn't carry it further, and one made at load, on an event or from a timer never has it. At most 8 wait at once; an answer for a Plugin unloaded or reloaded since is dropped.

`roster.inventory.request(done)` does the same for the whole Inventory, with `inventory.read` and no `serve:` grant: `done(list)` gets `list.hosts` and `list.groups` from one `hosts.list`. The waiting reads (`roster.inventory.hosts()`, `.groups()`) read the Inventory once a call: both in one call are one question to serve, until a call into serve that can change something (a write, `mesh.cut`, …) in the same call.

`roster.serve.call` asks and waits. Waiting never counts against the Plugin (its budget, or being given up on), but the Plugin does nothing else meanwhile, and the user's next action in it waits too. One call (an action, a load, an event, an answer) may ask roster serve this way at most 100 times and wait 300 s in all, then it's an error: a loop of calls would keep serve from the app. Use it where the answer is needed there and then and serve is quick to give it; a `:check` section that needs serve answers later instead ([Health sections](#health-sections)).

**A job's progress is pushed.** A Mesh run, a Discover scan and (serve API 21) a Host's check are jobs in roster serve, and the `job_progress` event says when one starts, as it moves (at most five times a second) and when it ends: `{ kind, job, action, state, done, total, at }`. A Plugin hears a Mesh job only with `serve:mesh.job`, a scan only with `serve:discover.status`, and a check only with `serve:host.check_job`, the permissions it would poll them with, so the event tells it nothing new. `serve:host.check` alone isn't enough for a check: that call is only made in the user's call, never from a listener, while `host.check_job` is a read. The result isn't in it: ask `mesh.job`, `discover.status` or `host.check_job` once, when it ends. A check started with `roster.serve.request("host.check", { host = "esx-02", background = true }, …)` answers at once with its `job`.

```lua
roster.on("job_progress", function(e)
  if e.kind ~= "mesh" or e.job ~= following then return end
  roster.progress.set("mesh", { title = "Mesh " .. e.action, done = e.done, total = e.total })
  if e.state ~= "running" and e.state ~= "stopping" then
    roster.serve.request("mesh.job", { job = e.job, brief = true }, show_result)
  end
end)
```

**A check's result.** Every check of a Host is a job from serve API 21, the app's `:check HOST` (and a Plugin's `roster.cmd("check " .. host)`) too, so a Plugin granted `serve:host.check_job` hears each one end and asks for how it came out: `result` is `host.check`'s ([`CheckJob`](plugin-api.md#checkjob)). topology shows a Host down when its check fails this way.

```lua
roster.on("job_progress", function(e)
  if e.kind ~= "check" or e.state ~= "done" then return end
  roster.serve.request("host.check_job", { job = e.job }, function(j)
    if j and j.result then badge(j.host, j.result.ok and nil or "check failed") end
  end)
end)
```

A stopped check (`state` `"stopped"`, the vault locked under it) has a result too, with `ok` false and its later steps skipped: it says nothing about the Host, so ask only for `"done"`. Answers can come back in another order than the checks ended in: keep only the answer for a Host's latest check to end.

A roster serve older than API 20 sends none, so keep asking with a timer (`roster.every`) and `roster.serve.request`, one question out at a time, until the first `job_progress` comes; the first-party Plugins do that.

### The network

A Plugin that talks to a web service lists each site it needs, one permission each, and the install prompt shows every one of them, flagged:

```lua
permissions = { "terminal.read", "network:hooks.example.com", "network:*.status.example.org" },
```

| You write | It reaches |
|---|---|
| `network:api.example.com` | `https://api.example.com` on port 443, exactly: not `example.com`, not `x.api.example.com`, not plain http |
| `network:*.example.com` | any name under `example.com` (`a.example.com`, `a.b.example.com`), over https; **not** `example.com` itself, so list that too if you need it. `*.` only at the start, before two names or more (no `*.com`) |
| `network:http://api.example.com` | plain http to that name on port 80, and only that: anyone on the way can read and change it, and the prompt says so |
| `network:api.example.com:8443` | that name on port 8443 instead of 443 |
| `network:10.0.0.5`, `network:http://10.0.0.5:8080`, `network:[fd00::5]` | that address exactly: the only way to reach this computer, and one way to reach a private network |
| `network:private:nas.lan`, `network:private:http://appliance:8080` | a name on your private network (a homelab service), and only there: every address it resolves to must be private (`10.…`, `172.16–31.…`, `192.168.…`, `100.64–127.…`, IPv6 `fc00::/7`), never this computer, link-local or the internet. One label (`appliance`) is fine here. Not an address (that's a site of its own) and not a wildcard. The prompt says it reaches inside your network |
| `network:appliance.example.com#sha256:FINGERPRINT`, `network:private:appliance.lan:8443#sha256:…`, `network:10.0.0.5:8443#sha256:…` | an https site that trusts exactly one certificate, in place of the ones your computer trusts: for a self-signed appliance. `FINGERPRINT` is the certificate's SHA-256 as 64 lower-case hex digits, no colons (`openssl x509 -in cert.pem -noout -fingerprint -sha256`, then drop the colons and lower it). Never with plain `http://` or a wildcard. The prompt shows the start of the fingerprint |

Sites are written in lower case, with no path, user or password; a name is ASCII (punycode, `xn--…`, for others). A bare `network` doesn't install: it has to say where. One manifest can't name a name both as a private site and a public one, nor one site with two pins (or with and without one): which rule would hold? Another port is another site.

**A private site** (decision Q116) is for a name your network's DNS answers with an address inside it. roster looks the name up itself, refuses the request if any address it gives isn't private, and connects only to the addresses it checked, so the name can't be pointed outside, or at this computer, later. A public site never reaches it: `*.example.lan` doesn't cover `nas.example.lan` once that's a private site, on any port or scheme. A request to it never goes through `plugin_proxy`.

**A pinned certificate** (decision Q116) replaces your computer's trust for that one site, and nothing else: the certificate the site shows must hash to the pin and the site must prove it holds that certificate's key; its name, issuer and dates don't matter, so an appliance's certificate that expired still works, and one it made anew doesn't until the pin changes (an update with a new pin asks again, as for any new permission). The pinned site's requests run on a connection of their own: a redirect never leads to it, nor from it to anywhere else.

**Your proxy.** On a network that only leaves through a proxy, set `plugin_proxy = "http://10.0.0.5:3128"` in `init.lua` ([config.md](app/config.md#other)). It's yours, not a Plugin's: no manifest can set or see it, it never carries a user or password, and only requests to public names go through it (https as a tunnel the proxy can't read). Through the proxy, roster still looks the name up itself first and refuses it, as without a proxy, if any address is on this computer or a private network; only when this computer can't look the name up at all (a network where only the proxy resolves names) does it go to the proxy unchecked, and then the proxy decides where the name leads, and could be pointed at a different address than roster saw. A change to `plugin_proxy` reaches running Plugins at their next request once the Config reloads.

The requests run in roster's core, never in the app's window, and don't wait: `done` gets the answer later, as a call of its own. A redirect is followed only to a site the Plugin may reach. A name that resolves to an address on this computer or a private network (`localhost`, `10.…`, `192.168.…`, link-local, …) is refused, so a site can't be pointed inside your network later: list the address itself if that's what you mean. No cookies or credentials of roster's go along, and no proxy but `plugin_proxy`; a token of the Plugin's own goes in a header (from `roster.plugin.config`, say). At most 4 requests at once, a 256 KB body out, a 1 MB body back, 30 seconds each. An update that adds a site asks again, like any new permission; `:plugins` turns each site off on its own, and says under each one how many requests went there since roster started, how many got no answer (a request an unload or reload stopped counts as one), and when the last one went, asking again every few seconds while it's open: counts only, never a path, a query or a body. Removing the Plugin forgets them. What can go wrong is in [A Plugin's network requests](app/errors.md#a-plugins-network-requests).

## A Plugin's own files

Every Plugin has a data folder of its own, and `roster.storage` reads and writes files there by name. It needs no permission: the folder is the Plugin's, and nothing else is reachable through it.

```lua
local roster = require("roster")

-- What it saved last time, or a fresh start.
local state = roster.storage.read_json("state.json") or { seen = {} }

local function remember(line)
  state.seen[#state.seen + 1] = line
  roster.storage.write_json("state.json", state)   -- the whole file, at once
end

roster.storage.write("notes.txt", "plain text works too")
for _, name in ipairs(roster.storage.list()) do print(name) end   -- notes.txt, state.json
roster.storage.remove("notes.txt")
```

- **Where:** `plugin-data/NAME/` in the app's data folder, next to the State and the Packages' clones (`%LOCALAPPDATA%\dev.roster.app` on Windows, `~/.local/share/dev.roster.app` on Linux, `~/Library/Application Support/dev.roster.app` on macOS). Never the config folder, so it isn't in your dotfiles, and never on the network.
- **Names, not paths:** a file is a plain name (letters, digits, `-`, `_` and `.`, not starting with `.`; at most 100 characters), so there are no folders inside it, no `..` and no full paths. A link put there by hand (a symlink, or a junction on Windows) is never followed: reading, writing or removing it is an error, and so is a data folder that is itself a link.
- **Whole files, at once:** `write` and `write_json` replace the file through a temporary file and a rename, so a crash leaves the old content or the new, never half. `read` and `read_json` give `nil` for a file that isn't there.
- **Limits:** 1 MB a file, 10 MB and 1,000 files a folder. Going over is an error that names the limit, and the old file stays as it was. The time the disk takes doesn't count against your budget. `:plugins` shows how close each Plugin is, as it was when the panel opened: "Data: 2.1 MB in 34 files (of 10 MB, 1,000 files)", or "Data: none yet" before it writes anything. It counts what the limits count (a write's leftover temporary file too) from the folder's listing alone: it never opens a file, and never follows a link.
- **How long it's kept:** across reloads, updates, revoked permissions and the Plugin being stopped. `:plugins remove NAME` removes it, and `:packages clean` removes a Package's. It's named after the manifest's `name`, so renaming a Plugin starts it empty.

What can go wrong is in [A Plugin's files](app/errors.md#a-plugins-files). The built-in Folders keeps its Folders here, as `folders.json`.

## The `roster` module

`require("roster")` (also the global `roster`) is the whole API. **[The Plugin API](plugin-api.md)** is its reference: every function with its parameters, returns, errors, permission and an example, and every type with all its fields (`:help plugin-api`; `:help roster.inventory.host()` for one function, `:help roster-Host` for one type). In short:

| Area | Functions | Permission |
|---|---|---|
| The Plugin and the app | [`roster.plugin`](plugin-api.md#rosterplugin), [`roster.api_version`](plugin-api.md#rosterapi_version), [`roster.os`](plugin-api.md#rosteros), [`roster.has`](plugin-api.md#rosterhaspermission), [`roster.notify`](plugin-api.md#rosternotifytext-level-opts), [`roster.on`](plugin-api.md#rosteronevent-listener) | none |
| Timers | [`roster.defer`](plugin-api.md#rosterdeferms-fn), [`roster.every`](plugin-api.md#rostereveryms-fn), [`roster.cancel`](plugin-api.md#rostercanceltimer) | none |
| Commands and keys | [`roster.commands`](plugin-api.md#rostercommands), [`roster.keymap`](plugin-api.md#rosterkeymap) | none |
| What the app draws for you | [`roster.sidebar`](plugin-api.md#rostersidebar), [`roster.status`](plugin-api.md#rosterstatus), [`roster.toolbar`](plugin-api.md#rostertoolbar), [`roster.finders`](plugin-api.md#rosterfinders), [`roster.badges`](plugin-api.md#rosterbadges), [`roster.float`](plugin-api.md#rosterfloat), [`roster.views`](plugin-api.md#rosterviews), [`roster.details`](plugin-api.md#rosterdetails), [`roster.progress`](plugin-api.md#rosterprogress), [`roster.themes`](plugin-api.md#rosterthemes) | none |
| Asking, and acting for the user | [`roster.confirm`](plugin-api.md#rosterconfirmquestion), [`roster.cmd`](plugin-api.md#rostercmdline), [`roster.cmdline`](plugin-api.md#rostercmdlinetext), [`roster.echo`](plugin-api.md#rosterechotext-opts), [`roster.sessions.show`](plugin-api.md#rostersessionsshowsession-line) | none, in a call the user started |
| Its own files | [`roster.storage`](plugin-api.md#rosterstorage) ([above](#a-plugins-own-files)) | none |
| Help, health and tutorials | [`roster.help`](plugin-api.md#rosterhelp), [`roster.health`](plugin-api.md#rosterhealth) ([below](#health-sections)), [`roster.tutor`](plugin-api.md#rostertutor) | none |
| The clipboard | [`roster.clipboard`](plugin-api.md#rosterclipboard) | none, in a call the user started |
| Hosts | [`roster.inventory`](plugin-api.md#rosterinventory) | `inventory.read`, `inventory.write` |
| Sessions | [`roster.sessions.list`](plugin-api.md#rostersessionslist), [`roster.sessions.open`](plugin-api.md#rostersessionsopenhost), [`roster.terminal`](plugin-api.md#rosterterminal) | `inventory.read` or `terminal.read`, `sessions.open`, `terminal.write` |
| roster serve | [`roster.serve`](plugin-api.md#rosterserve) | `serve:<method>` |
| HTTP | [`roster.http`](plugin-api.md#rosterhttp) | `network:<site>` |

Everywhere a Plugin hands the app something to run (a row, a button, a finder item, a status segment, a toolbar control, a command), `run` is a function or a command line; a function runs in your Plugin when the user chooses the thing. It's told which thing that was: a [`HandlerContext`](plugin-api.md#handlercontext) such as `{ section = "pinned", row = "esx-02", action = 1 }` for a row's first button, `{ finder = "pinned", item = "3" }`, `{ toolbar = "alerts" }`, `{ progress = "sync" }` for its `cancel`, or `{ confirm = "yes" }`, with the Session on screen (`session`, `session_host`) when the Plugin has `inventory.read` or `terminal.read`. So one function can serve every row. A command line runs only if it's one of your own commands or one of [the few of roster's a Plugin may run](plugin-api.md#command-lines-a-plugin-may-run) (`finder`, `view`, `help`, `find`, `info`, `changes`, `session`, `next`, `prev`, `check` with `serve:host.check`, and `open` or `connect` with `sessions.open`); anything else, `:plugins grant …` above all, is refused with a notice when the user presses the button, whatever its label says. A key binding's line (`roster.keymap.set`) is checked the same way each time the key is pressed, and `:keys` shows it as `plugins run NAME LINE`. What a Plugin says follows [`ui.messages`](app/config.md#fonts-and-the-terminal) as roster's own messages do, like Neovim's: what went wrong and what was asked show, routine confirmations are quiet. A line on the message line (`roster.echo`) shows; mark a routine confirmation `roster.echo("Added esx-02 to Lab", { quiet = true })` and it shows only with `ui.messages = "all"`. A notice (`roster.notify`) that's a warning or an error shows; an info one is quiet unless it has buttons or says `{ quiet = false }`. Mark `quiet = false` on what the user asked for: the result of something they started (`roster.notify("Scan done: 12 Hosts answered, 3 new", "info", { quiet = false })`, "Applied: 3 Hosts changed."), an answer ("No alerts") and a refusal ("Keep a Host first: m on its row"). Leave it out for a routine confirmation when nothing went wrong ("Copied the line", "Dismissed 3 alerts"). Quiet, a screen reader still hears it, and `:messages` keeps every one of them. [Events](plugin-api.md#events) come through `roster.on`, and only what happens after the Plugin loads: read `roster.sessions.list()` at load for the Sessions already open, then follow `session_open` and `session_exit`. A Quick Connect Session's `host` is `nil` in them, since it isn't on a Host: don't badge it or make a row go to it. What you type into a Session is never an event, but the shell echoes it back, so it's in `terminal_output` like anything else the Session prints (recent-alerts skips a line that looks like a prompt and a command), unless the shell writes the marks of [shell integration](#shell-integration).

`terminal_output` is the lines a Session's terminal commits: the app runs each Session's output through a terminal of its own (never shown) and sends a line when the cursor moves past it, as it reads then. So there are no escape sequences, a progress bar arrives as it ended, and a wrapped line comes whole. A line drawn again with the same text in the same row isn't sent again: after the app resizes a Session (a panel, Focus, the window), ConPTY prints the whole screen again on Windows, and that isn't new output. What a full-screen program (`vim`, `top`, `less`) draws isn't sent at all.

A command can complete its arguments: `complete = function(arg) … end` gets what's typed after the command's name and returns whole arguments (`{ "add esx-02 " }`). The app asks as the user types and shows the last answer until the next comes, so keep it quick; it isn't a call the user started. A command's function hears where the Sidebar's cursor is: `host` (the Host under it, else the one on screen; with `inventory.read`), and `section` and `row` when it's on one of your own sections, so `␣ A` can act on the row it's on. `roster.cmdline("folder new ")` opens the command line with one of your commands typed in for the user to finish, and `roster.echo(text)` answers on the message line, as roster's own commands do (both only in a call the user started; `{ quiet = true }` for a routine confirmation, since api 4).

Sidebar rows can do what the app's own Folders do: `icon = "folder"`, `fold = true` (the rows after it with a higher `level` fold under it), `kind = "host"` with `host` (drawn as the Inventory draws that Host, with its state, address and buttons), `drop` (a Host dragged onto it runs the function with `dropped`), `drag_out` (run when the row is dragged out of the section), and a section's `count` and `drop`. A finder can be one of your sections' rows, with a `prompt` of its own (its title if left out): `roster.finders.set("folders", { title = "Find in the Folders", prompt = "Folders", section = "folders" })`.

A finder's `items` can be a function: it runs in your Plugin each time the finder opens, so a list that's costly to build, or changes often, is built only when someone looks. Until it first answers, the finder says "Loading…". It isn't a call the user started (another Plugin's `roster.cmd("finder …")` may have opened it); choosing one of its items is.

Timers (`roster.defer(ms, fn)` once, `roster.every(ms, fn)` again and again, `roster.cancel(timer)`) keep their clock in the app, which runs `fn` in your Plugin when it's time, on its own thread, like an action. A timer isn't something the user did, so it can't copy to the clipboard. Every timer ends with the Plugin: removing, reloading, revoking a permission (which reloads it) or its being stopped cancels them all.

Lua can't tell an empty list from an empty table of fields: `{}` reaches the app as `{}`, and the app takes it as an empty list wherever it wants one (`rows = {}`).

Text you hand the app (a label, a notice, a float's lines, a badge, what you copy) that isn't valid UTF-8, such as a line you cut in the middle of a character, is shown with `�` where it breaks; it isn't an error. A name that isn't (an id, a table key) is.

### A Plugin's tutorial

`roster.tutor.set` adds a tutorial: `:tutor ID` runs it on the demo Inventory ([the tutor](app/help.md#the-tutor)) and `:help tutor-ID` is its page. Its steps wait for the app's own events ([`StepMatch`](plugin-api.md#stepmatch)), such as your own command being run:

```lua
roster.tutor.set("alerts", {
  title = "Recent alerts",
  lessons = {
    { title = "See them", text = "Your Sessions' trouble, in one list.",
      steps = { { id = "run", text = "Run `:alerts`", on = { event = "command", id = "alerts" } } } },
  },
})
```

Your Plugin is loaded in the demo too, with the permissions the user granted it, so the tutorial can have them run it. The Plugins running in their workspace come along (local ones and Packages, from the clones they have); one stopped or waiting for a prompt's answer doesn't, and the demo never asks anything. Your Plugin's copy in their workspace keeps running behind the demo, untouched; the demo's copy is a second load, with its own Lua state, stopped when they leave. On the demo:

- **`roster.inventory`** sees the demo's Hosts (`demo-01` to `demo-06`), and the events name them. Write your steps and examples for those.
- **roster serve** answers only `hosts.list` and `host.get`. Any other method (`roster.inventory.update` and the other writes, `mesh.*`, `discover.*`) is refused with "METHOD isn't on the demo Inventory" ([errors](app/errors.md#a-plugin-on-the-demo-inventory)), after the usual permission checks.
- **`roster.http`** is there if they granted you a site, and checks each request as ever (a bad one is an error at once, and at most 4 go at a time), but nothing is sent: your function gets `nil` and "URL wasn't sent: the tutorial's demo reaches no network", as for a request that failed.
- **`roster.storage`** is a throwaway folder that starts empty and is removed when the demo ends; your real files aren't read or written.

A Plugin that fails to load in the demo gets its usual notice there, and the tutorial runs on. If the demo can't run Plugins at all, it says so in one notice and runs with roster's own (decision Q123).

### Shell integration

A shell can say where its prompt, the command line and each command's output start, and how the command ended, with **OSC 133** marks: escape sequences it prints, which terminals such as VS Code's, WezTerm and Windows Terminal read too. roster reads them from what the Session prints (never shown, never sent as text) and, for a Session whose shell writes them, it:

- says what each line of `terminal_output` is, as the marks put it: `kind` is `"prompt"` (a few lines after the prompt starts), `"input"` (the line typed at the prompt, the shell's echo of your command), `"output"` (what a command printed), or `nil` (no marks, or nothing they say). Lines of one kind come together, so a batch with several kinds is several events, in order. **Every line is still sent**: the marks only label lines, and a Plugin filters if it wants (recent-alerts skips `prompt` and `input` lines);
- sends [`command_done`](plugin-api.md#commanddoneevent) (`terminal.read`, since api 4) when a command ends, after the `terminal_output` with its last lines: `{ session, host, command, output, code }`, the command line as the shell showed it, what it printed (its last 16 KB) and its exit code. So a Plugin can react to a finished command (`code ~= 0`, a deploy that printed `done`) without cutting the output into commands itself.

```lua
roster.on("command_done", function(e)
  if e.code and e.code ~= 0 then
    roster.notify(("%s: %s failed (%d)"):format(e.host or "Quick Connect", e.command or "a command", e.code), "warn")
  end
end)
```

**The marks are a hint, not a guarantee.** They come from the Host, in its output, so anything the Host prints can forge or lose them (a `cat` of a file with them in it, a shell that marks prompts but never says a command ran). So roster never holds back or drops a line for them, and `kind` is advice: an `"output"` line may be an `ssh` or a nested shell echoing what you type into it, which the outer shell's marks can't tell apart. A shell without marks is read as before: no `kind`, and no `command_done`.

**What's typed.** `command` is read off the screen when the shell runs the command (the `C` mark), so a line you erase, or give up with Ctrl-C, is never a `command_done`. What the screen doesn't show (a password at a `sudo` or `ssh` prompt, which doesn't echo) is in neither event. A shell's echo of what you type is in `terminal_output` as it always was, now labelled `"input"`.

**roster reads; it writes only if you ask.** It reads the marks from what the Session prints. You turn them on in the shell on the Host (its own rc file, below), the way you'd set its prompt, or let roster send the shell a one-line hook after login ([Shell hooks](#shell-hooks-roster-sets-it-up), off unless you turn it on).

**When there's no `command_done`.** A nested shell with marks (`ssh` from a marked shell to a Host with integration) takes over: its commands come as `command_done`, and the `ssh` itself gets none, since its end can't be told from the nested shell's. Nor does `exit` or `logout`: a shell that exits sends no end mark for it, so the one that follows is another shell's. A `D` with no `C` (an empty line, Ctrl-C) isn't a command.

**Setting it up.** Put the snippet for the Host's shell at the **end** of its rc file (after a theme or framework sets the prompt), then open a new Session. A prompt tool or framework that writes OSC 133 marks already needs nothing. If `command` comes as `nil`, the shell isn't sending the `B` mark.

bash 4.4 or later (`PS0`), in `~/.bashrc`:

```bash
if [[ $- == *i* ]]; then
  __osc133_done() { local code=$?; printf '\e]133;D;%s\a' "$code"; return "$code"; }
  PROMPT_COMMAND="__osc133_done${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
  PS1='\[\e]133;A\a\]'"$PS1"'\[\e]133;B\a\]'
  PS0='\e]133;C\a'"$PS0"
fi
```

zsh, in `~/.zshrc`:

```zsh
if [[ -o interactive ]]; then
  __osc133_done() { printf '\e]133;D;%s\a' "$?" }
  __osc133_run() { printf '\e]133;C\a' }
  precmd_functions=(__osc133_done $precmd_functions)
  preexec_functions+=(__osc133_run)
  PS1=$'%{\e]133;A\a%}'"$PS1"$'%{\e]133;B\a%}'
fi
```

fish, in `~/.config/fish/config.fish` (fish 4 writes some of these marks itself; a mark sent twice counts once):

```fish
if status is-interactive
    function __osc133_prompt --on-event fish_prompt
        printf '\e]133;A\a'
    end
    functions -c fish_prompt __osc133_fish_prompt
    function fish_prompt
        __osc133_fish_prompt
        printf '\e]133;B\a'
    end
    function __osc133_run --on-event fish_preexec
        printf '\e]133;C\a'
    end
    function __osc133_done --on-event fish_postexec
        printf '\e]133;D;%s\a' $status
    end
end
```

PowerShell 7.3 or later (PSReadLine 2.2), in `$PROFILE`:

```powershell
if ($Host.Name -eq 'ConsoleHost') {
  $Global:__Osc133Prompt = $function:prompt
  function Global:prompt {
    $code = if ($?) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }
    "`e]133;D;$code`a`e]133;A`a$(& $Global:__Osc133Prompt)`e]133;B`a"
  }
  # Runs once a whole command is accepted (not on Enter in an unfinished one).
  Set-PSReadLineOption -AddToHistoryHandler {
    param($line)
    [Console]::Write("`e]133;C`a")
    [Microsoft.PowerShell.PSConsoleReadLine]::GetDefaultAddToHistoryOption($line)
  }
}
```

#### Shell hooks: roster sets it up

Instead of an rc file, roster can send a Session's shell **one line** after login that turns the marks on, and OSC 7 (the folder the shell is in), in **that shell process only**. Nothing is written on the Host: no rc file, no file at all, so the hook is gone when the shell exits and the next Session starts clean. It's **off** unless you turn it on:

- per Host, in `roster.yml`: `shell_hooks: true` on the Host, its group or `defaults` (`shell_hooks: false` keeps a Host out, say a group of network gear);
- for every Session in `init.lua`: `terminal = { shell_hooks = true }` (Quick Connect too; a Host's `shell_hooks: false` still wins), or `false` to never send it, whatever a Host says ([`terminal.shell_hooks`](app/config.md#fonts-and-the-terminal));
- for the Session on screen, now: `:integrate`, whatever those say. It answers once it knows: the marks are on; the line went but no marked prompt came back (the shell or its prompt framework doesn't take it); or why it sent nothing (no empty prompt roster knows, the shell marks its prompts already).

**When it's sent.** Once, when the login has gone quiet (0.4 s with nothing printed) at an empty prompt roster knows, within 20 seconds of the Session starting: a POSIX shell's `user@host:~$ `, `host# ` or `host% ` (the `$`, `#` or `%` right after the prompt's text, or a `$ ` on its own line), fish's `user@host ~> `, or PowerShell's `PS …> `. **Nothing is sent** if you've typed anything (keys that only move the cursor, and the terminal's own answers such as cursor, mode and mouse reports, don't count; the prompt is checked again anyway), if the shell already writes marks (`:integrate` still sends it then, and roster's marks go round the shell's own), or if the login shows anything else: a forced command, a menu (`Choice # `), a password prompt, a network appliance's CLI (`switch01#`, `user@router> `, `[admin@appliance] > `), ESXi's busybox shell (`[root@esx-02:~] `), tcsh's own prompt (`host:~ % `).

**What you see.** roster holds the shell's echo of the line back from the screen until the new prompt comes (its `A` and `B` marks, after zsh's end-of-line mark if it prints one), then draws that prompt where the old one was, so the screen looks as it did. A shell that runs the line and marks nothing (dash, busybox ash, ksh: the line does nothing there) or doesn't take it (tcsh or csh with a bash-like prompt prints an error) gets its echo and that short error cleared after 2 seconds, and the prompt is as it was. Anything else (more than a few lines, a different prompt), or you typing meanwhile, shows everything as the shell printed it. A Plugin with `terminal.read` sees the Session's output as it came, the echoed line included (with no `kind`), with the Session's token turned into dashes.

**Prompt frameworks.** bash's and zsh's marks go on from a hook that runs last at each prompt, which wraps the prompt again whenever it has lost them, so a framework that builds the prompt at every prompt (starship, oh-my-bash, oh-my-zsh) keeps them; the exit code comes from a hook that runs first. One that redraws its prompt itself after the prompt hooks (powerlevel10k's instant prompt or transient prompt) may still drop them: such frameworks have their own OSC 133 setting, and `:integrate` says when no marked prompt came back. fish's and PowerShell's wrap the prompt function they find.

**History.** Each line starts with a space, so a shell that leaves such lines out of its history does: bash with `HISTCONTROL=ignorespace` or `ignoreboth` (Debian and Ubuntu's default), zsh with `setopt HIST_IGNORE_SPACE`, fish always. PowerShell keeps it in its history. PowerShell's line writes the `C` mark from PSReadLine's history handler and then asks the handler that was there (yours, or PSReadLine's default, which keeps lines that look like secrets out of the history file), so what's saved is as before.

**Older bash.** bash before 4.4 has no `PS0`, so it gets no `C` mark: prompts and exit codes are marked, and `command_done` has no command line. The line works under `set -u`.

**The folder.** With OSC 7, a Session's row in the Sidebar shows the folder its shell is in (the last part of the path; the whole path in its tooltip, and in the tab's in the tab strip). A shell or prompt that writes OSC 7 itself shows it too. It's what the Host says, so it's a hint, like the marks.

**Exactly what's sent**, followed by Enter, with `NONCE` standing for the Session's token: 24 random hex digits, new for each Session (and each reconnect), which every mark carries as `roster=NONCE` so roster can tell its own shell's marks from any other shell's (decision Q131). A Plugin never sees it: roster takes it out of the output Plugins get. bash and zsh (one line: each half is eval'd only in its own shell, so another POSIX shell does nothing; the same snippets as above, plus OSC 7 at each prompt and the re-wrap):

```bash
 [ -n "${BASH_VERSION-}" ] && eval '__roster_d(){ local c=$?; printf "\e]133;D;%s;roster=NONCE\a\e]7;file://%s%s\a" "$c" "${HOSTNAME-}" "$PWD"; return $c; }; __roster_w(){ case $PS1 in *"roster=NONCE"*) ;; *) PS1="\[\e]133;A;roster=NONCE\a\]$PS1\[\e]133;B;roster=NONCE\a\]";; esac; }; case $BASH_VERSION in [1-4].*|5.0.*) PROMPT_COMMAND="__roster_d${PROMPT_COMMAND:+;$PROMPT_COMMAND};__roster_w";; *) PROMPT_COMMAND=(__roster_d ${PROMPT_COMMAND[@]+"${PROMPT_COMMAND[@]}"} __roster_w);; esac; case $BASH_VERSION in [1-3].*|4.[0-3].*) ;; *) PS0="\e]133;C;roster=NONCE\a${PS0-}";; esac'; [ -n "${ZSH_VERSION-}" ] && eval 'typeset -ga precmd_functions preexec_functions; __roster_d(){ printf "\e]133;D;%s;roster=NONCE\a\e]7;file://%s%s\a" $? "${HOST-}" "$PWD"; }; __roster_c(){ printf "\e]133;C;roster=NONCE\a"; }; __roster_w(){ [[ $PS1 == *"roster=NONCE"* ]] || PS1="%{$(printf "\e]133;A;roster=NONCE\a")%}$PS1%{$(printf "\e]133;B;roster=NONCE\a")%}"; }; precmd_functions=(__roster_d $precmd_functions __roster_w); preexec_functions+=(__roster_c)'
```

fish:

```fish
 function __roster_a --on-event fish_prompt; printf '\e]7;file://%s%s\a\e]133;A;roster=NONCE\a' $hostname $PWD; end; functions -c fish_prompt __roster_p; function fish_prompt; __roster_p; printf '\e]133;B;roster=NONCE\a'; end; function __roster_c --on-event fish_preexec; printf '\e]133;C;roster=NONCE\a'; end; function __roster_d --on-event fish_postexec; printf '\e]133;D;%s;roster=NONCE\a' $status; end
```

PowerShell (Windows PowerShell 5.1 too: it writes the escape character as `[char]27`):

```powershell
 $Global:__roster_p=$function:prompt; function Global:prompt { $c=if($?){0}elseif($LASTEXITCODE){$LASTEXITCODE}else{1}; $e=[char]27; $b=[char]7; $d='/'+($PWD.ProviderPath -replace '\\','/').TrimStart('/'); "$e]133;D;$c;roster=NONCE$b$e]7;file://$([Environment]::MachineName)$d$b$e]133;A;roster=NONCE$b$(& $Global:__roster_p)$e]133;B;roster=NONCE$b" }; try { $h=(Get-PSReadLineOption).AddToHistoryHandler; Set-PSReadLineOption -AddToHistoryHandler ({ param($l) [Console]::Write("$([char]27)]133;C;roster=NONCE$([char]7)"); if ($h) { $h.Invoke($l) } else { $true } }.GetNewClosure()) } catch {}
```

**Tested:** the bash line in bash 5 (CI runs it: with a prompt framework that sets the prompt at every prompt, under `set -u`, as a bash before 4.4, and in a POSIX shell that isn't bash, which it leaves alone); the PowerShell prompt function and history handler (with a handler of your own) in Windows PowerShell 5.1. The zsh, fish and PowerShell 7 lines follow the snippets above, which aren't tested in those shells either.

### Health sections

`roster.health.set` adds a section to `:check` (this Box's health, shown on `:help health`), as Neovim's `vim.health` does. With `check`, a function, each `:check` calls it and shows the lines it returns, under the section's title and your Plugin's name:

```lua
roster.health.set("recent-alerts", {
  title = "Recent alerts",
  check = function()
    if not roster.has("terminal.read") then
      return { { level = "warn", message = "terminal.read isn't granted, so no alerts", fix = "allow it in :plugins" } }
    end
    return { { level = "ok", message = #alerts .. " alerts since the app started" } }
  end,
})
```

Each line is a [`HealthCheck`](plugin-api.md#healthcheck): `ok`, `warn` or `error`, a message and an optional fix, shown as `OK`, `WARNING` and `ERROR` like roster's own. The function runs like any call into your Plugin: with your permissions, a quarter of a second of Lua, and `roster serve`'s answers not counted against it, so check what you can see locally and keep it quick. A check that needs roster serve returns `"later"` at once and answers with [`roster.health.answer`](plugin-api.md#rosterhealthanswercheck-lines) from the request's `done`, within 30 seconds, so it never waits for serve on your Plugin's thread:

```lua
check = function(e)
  roster.serve.request("discover.plan", { targets = { "10.0.0.0/30" } }, function(plan, err)
    roster.health.answer(e.check, plan and { { level = "ok", message = "can scan, with " .. plan.scanner } }
      or { { level = "error", message = err } })
  end)
  return "later"
end,
```
 One that raises, returns something that isn't a list of lines or `"later"`, or doesn't return within three seconds (or, after `"later"`, doesn't answer within 30) is an `ERROR` line of its own section, and the rest of `:check` goes on. Without `check`, `checks = { … }` shows those lines as you last set them.

### Types in your editor

[`examples/plugins/types/roster.lua`](../examples/plugins/types/roster.lua) declares the whole API for [lua-language-server](https://luals.github.io/), generated with the reference, so your editor completes `roster.` and checks what you hand the app. `:plugins types PATH` writes the copy for this app into your Plugin's folder as `types/roster.lua`, so it matches the API the app has; [Editor support](plugin-api.md#editor-support) says how to point the editor there; the example Plugins are annotated that way, and CI checks them with it.

## Views, tables and Host-details sections

A **view** is a side panel beside the terminal (`place = "panel"`, over it in Focus or a narrow window) or a full view over the whole window (`place = "full"`, as Topology is). **`place` is only where it opens first:** the user can make any view full window or dock it, and widen or narrow it (`␣ z`, `␣ <`, `␣ >`, its header's button, a drag of its edge), and that choice, kept in their State, and init.lua's `views.ID` win over yours ([Panels](app/keyboard.md#panels-docked-or-full-window)). So draw for both: a table or a graph takes whatever width it gets, and a narrow table scrolls sideways. It holds a few lines of text, facts (label and value, as a Host's details show them) and a table, top to bottom. `roster.views.set` adds it; it opens with `:view ID`, a key you bind to `view ID`, the `views` finder (`:view` alone), or `roster.views.open` in one of your actions or commands, never on its own at load or on an event. `Esc` closes it and puts the user back where they were. One view is open at a time. `roster.views.open(id, { select = ID })` opens it at a node of its graph (its cluster opens, and the node is centred) or a row of its table, even when it's already open: a Host-details section's button can so show its Host on your map, as Topology's **Show esx-01 on the map** does.

A **table**'s rows are plain data: an `id`, the `cells` by column, and optionally the `host` it's about and a `tone` (`"muted"`, `"warn"`, `"error"`). What a row can do belongs to the table: `open` for `Enter`, and `actions`, each with a one-letter `key` and a button on the selected row. A function there gets the row it ran on (`e.row`, `e.host`, `e.view`). The app sorts it (`s`, `S`, a heading's click), moves with `j`/`k`, `g g`/`G` and `Ctrl+D`/`Ctrl+U`, keeps the selection on its row, and draws only the rows on screen, so thousands stay smooth.

```lua
local found = {}
roster.views.set("discover", {
  title = "Discover",
  place = "panel",
  text = "Scanning 10.0.0.0/24",
  table = {
    columns = {
      { id = "address", label = "Address", kind = "data" },
      { id = "ports", label = "Ports", kind = "number" },
      { id = "title", label = "Title" },
    },
    sort = "address",
    empty = "Nothing found yet.",
    actions = {
      { label = "Keep", key = "a", icon = "add", run = function(e) found[e.row].keep = true end },
    },
  },
})
roster.commands.add("discover", { desc = "Scan a network", run = function() roster.views.open("discover") end })
roster.keymap.set("leader", "y d", "view discover")

-- As results come in: only the rows that changed.
local function arrived(host)
  found[host.address] = host
  roster.views.update("discover", {
    text = "Scanning 10.0.0.0/24: " .. host.percent .. "%",
    rows = { { id = host.address, cells = { address = host.address, ports = #host.ports, title = host.title } } },
  })
end
```

`roster.views.update` replaces a row whose `id` is there already where it stands, adds new ones at the end, takes away the ids in `remove`, and leaves the rest alone, so a scan doesn't send its whole table each time (a table holds up to 10,000 rows). `clear = true` takes every row away first, in one go (a new scan), and the update's `rows` fill the table again. It's plain data only: the table's functions stay those `roster.views.set` gave. Setting the view again replaces it all.

A **Host-details section** is the same text, facts and table in one Host's details (`:info HOST`), after roster's own, with your Plugin's name on it. Set it per Host, as a badge: `roster.details.set("mesh", "esx-02", { title = "Mesh", facts = { { label = "reach", value = "can reach 7 Hosts" } } })`; `nil` takes that Host's away, `roster.details.remove("mesh")` every Host's. A table action there gets the Host as `e.host`. A section holds no graph: at the panel's width a map is a few unnamed dots, so put the numbers in words there and the map in a full view.

**What the whole view or section does** goes on its heading, not on every row: `actions` beside `title` (at most 4, each a `label`, an `icon` and `run`), drawn as quiet icon buttons by the close button. A view's gets `{ view }`, a section's `{ section, host }`. Each may have a one-letter `key` (api 4, [`HeadAction`](plugin-api.md#headaction)) that runs it from anywhere in the view or section, unless the table or graph takes the key first: not one of a table's or graph's own keys, nor one of its actions' keys, nor another button's. The Mesh controls put Plan and Apply on their views' headings and Cut on each Host's Mesh section, which `x` runs. The icons are the row icons (`RowIcon`), with `plan` (a dashed arrow), `apply` (an arrow into a bar) and `cut` (an edge broken by a cross, as a cut edge is drawn in a graph) for these.

```lua
roster.views.set("mesh-plan", {
  title = "Mesh plan",
  place = "full",
  actions = {
    { label = "Apply", icon = "apply", run = apply },
    { label = "Plan again", icon = "plan", run = plan },
  },
  table = { … },
})
```

**A view when a job finishes.** A Plugin never opens a view on its own (only the user's call does), so a job that ran in the background (a Mesh plan, a scan) says it's done with a notice whose button opens it: `roster.notify("Plan ready: 4 Hosts would change", "info", { actions = { { label = "Show the plan", run = "view mesh-plan" } } })`. A notice's button runs a command line, as `roster.cmd` would, and the click is the user's. At most 2.

**A data column's long values are cut in the middle** (`server-10-1…77-203`), so names that differ only at the end stay told apart; a text column's are cut at the end. **There's no text field in a view**: ask for a value as an argument of your command (`:discover 10.0.0.0/24`), or open the command line with it half typed (`roster.cmdline("discover ")`), which completes and keeps its history.

Nothing in a view moves: it opens from a key as often as a click, as every side panel does, and a row that changes is simply changed.

### Graphs

A view can hold a **graph** instead of a table: nodes, edges and clusters, as plain data, which the app lays out and draws as roster's own network map (Topology is the first). A **node** has an `id`, a `label`, a `shape` (`"dot"`, `"ring"`, `"dashed"`, `"hollow"`, `"square"`, as roster draws key, password, unreviewed, ended and this Box), a `state` (`"live"` in the accent, `"down"` crossed out), a `mark` (`"warn"`, `"error"`) and a short `note`, the `cluster` it's in, the `host` it is, a `kind` and a `detail` line. An **edge** goes `from` one node or cluster `to` another, one way (`dir = "one"`, an arrow) or `"both"`, with a `style` (`"solid"`, `"dashed"`, `"dotted"`), a `tone` (`"live"`, `"muted"`, `"warn"`, `"error"`) and `cut = true` to draw it broken. An edge to a **cluster** reaches every node in it, so one edge stands for a group's Links; a cluster with `mesh = true` has every node reaching every other without an edge per pair. As with a table, what a node does belongs to the graph: `open` for `Enter` and `actions` with a key each, and a function there gets the node (`e.node`, `e.host`, `e.view`). An action's `when` names a node's own fields, as a table action's names cells: `when = { state = "live" }` (or a list, `{ kind = { "esxi", "linux" } }`) runs it, and shows its key, only on the nodes that match; any other field is refused (`when.colour: a node has no colour`).

```lua
roster.views.set("map", {
  title = "Map",
  place = "full",
  graph = {
    clusters = { { id = "lab", title = "lab", mesh = true }, { id = "web", title = "web" } },
    nodes = {
      { id = "box", label = "devbox", shape = "square" },
      { id = "esx-02", cluster = "lab", host = "esx-02", detail = "10.0.0.5", state = "live" },
      { id = "nas-01", cluster = "lab", host = "nas-01", shape = "ring", mark = "warn", note = "out of date" },
      { id = "web-1", cluster = "web", host = "web-1", state = "down" },
    },
    edges = {
      { from = "box", to = "lab" },
      { from = "box", to = "web" },
      { from = "lab", to = "web", dir = "both" },
      { from = "nas-01", to = "web-1", style = "dashed", cut = true },
    },
    open = function(e) roster.notify("would open " .. e.host) end,
    actions = {
      { label = "Check", key = "c", run = function(e) check(e.host) end },
    },
  },
})

-- A Session connects: the node turns live, and its edge from this Box draws in.
roster.views.update("map", {
  nodes = { { id = "web-1", cluster = "web", host = "web-1", state = "live" } },
  edges = { { id = "live:web-1", from = "box", to = "web-1", tone = "live" } },
})
```

The user moves with `h` `j` `k` `l` (or the arrows) to the nearest node that way, searches with `/` (for every word typed, as a table's filter; `n`/`N` go through the matches, and the rest is dimmed), filters with `f` (clusters, kinds or states, as many of each as they tick in a menu, and the rest is hidden), collapses a cluster to its count with `o` (`O` for all), zooms with `+` `-` and `0`, and pans with `H` `J` `K` `L` or a drag. `Esc` clears a search, then a filter, then closes the view. Selecting a node lights up what it can reach and what can reach it, however many hops away, and says how many; with `reach = "direct"` on the graph, only one hop away (a node's own edges, its cluster's, and its cluster's mesh). `t` turns the graph into a table of every node, then of every edge, so nothing is only in the drawing. Each node keeps its place between openings (the app saves positions and collapsed clusters in its State); a new node takes a free place in its cluster without moving the others, and the user can drag one somewhere else, or move it from the keyboard: `m`, then `h` `j` `k` `l` until `Enter` keeps the place or `Esc` puts it back. A Plugin can't use `m` as an action key. Above 300 nodes, clusters start collapsed unless one says otherwise (`collapsed = false`). A graph holds up to 5,000 nodes, 10,000 edges and 500 clusters. `roster.views.update` adds or replaces `nodes`, `edges` and `clusters` by `id`, and takes away nodes and clusters in `remove` (a node's edges go with it) and edges in `remove_edges`.

A **filter** shows only some of the graph and hides the rest: `filter = { clusters = { "lab" }, kinds = { "esxi" }, states = { "live", "warn" } }` keeps the nodes in one of those clusters, of one of those kinds and with one of those states or marks, each dimension that's given; edges with a hidden end, and clusters with no node left, are hidden too. Hidden nodes keep their places, and the reach counts are still the whole graph's: hiding a node doesn't change what it reaches. Set it in `roster.views.set` to open with it, or send a new one with `roster.views.update(id, { filter = { … } })` (as Topology's `:topology GROUP` does; `filter = {}` shows everything again): it replaces whatever the user picked. With `f` the user ticks as many clusters, kinds and states as they like; a dimension with several shows as "3 clusters" on its button, and one the Plugin named that the graph doesn't have (yet) is in the menu too, so it can be taken off. The only motion is an edge that turns live drawing in from its start, as a Session's does on connect, and not under reduced motion.

## Asking, progress, the toolbar and going places

What the first-party Plugins need around their views: Mesh controls asks before a Cut, Discover shows a long scan and lets you stop it, recent-alerts goes to the line that alerted. All of it is drawn by the app; the Plugin hands over data and functions.

```lua
-- A control in the toolbar, by the window's buttons.
roster.toolbar.set("scan", { label = "Scan a network", text = "Scan", icon = "map", run = "discover" })

-- Ask first. The app draws the question with your Plugin's name on it; only the user answers.
local function cut(e)
  roster.confirm({
    title = "Cut " .. e.host .. " from the Mesh?",
    text = "Its key is taken off every Host it can reach.",
    action = "Cut",
    danger = true,        -- the stronger form: the keys start on Cancel
    typed = e.host,       -- and the user types the Host's name first
    run = function() roster.serve.request("mesh.cut", { host = e.host, background = true }, function() end) end,
  })
end

-- Something long: how far it has got, and a way to stop it.
roster.progress.set("scan", { title = "Scanning 10.0.0.0/24", done = 40, total = 256,
  cancel = function() roster.serve.request("discover.stop", nil, function() end) end })
roster.progress.remove("scan")   -- when it's over

-- A section's own buttons, a float's buttons and links.
roster.sidebar.set("alerts", { title = "Alerts", rows = rows,
  actions = { { label = "Dismiss all", icon = "close", run = clear } } })
roster.float.open({ title = "esx-02", lines = { a.text },
  actions = { { label = "Go to the line", key = "g", run = function() roster.sessions.show(a.session, a.text) end } },
  links = { { label = "Runbook", url = "https://wiki.example.com/disk-full" } } })

-- Run a command line: your own finder, say.
roster.commands.add("alerts", { run = function() roster.cmd("finder alerts") end })
```

- **A question** (`roster.confirm`) is a panel like the app's own Remove Host question, with "Asked by" your Plugin under it. `run` is called only when the user confirms; `cancel`, if you give one, when they press `Esc` or Cancel. Nothing a Plugin does can answer it, and no other piece of a Plugin can look like it (a float or a view is always marked as the Plugin's). The plain form confirms with `Enter`; the stronger one (`danger`) starts on Cancel, so a stray `Enter` only declines, and with `typed` its button works only once that word is typed. Asking again replaces the question; the earlier one's `cancel` isn't called, since your Plugin asked the new one.
- **Progress** (`roster.progress`) shows in the status bar: the title, a hairline that fills as `done` reaches `total` (or an edge that travels along it when you only know it's going), the share, and a stop button when there's a `cancel`. `:cancel ID` (or `:cancel` alone, for the latest) does what the button does: the app calls `cancel` once and shows "stopping…" until you set or remove the progress. You may set it any time, from an event too. Several at once: the latest keeps its title longest, and in a narrow window the others show only their track and share. In Focus (or with the status bar hidden) progress sits in the top-right corner instead, with its stop button.
- **A toolbar control** (`roster.toolbar`) sits after roster's own controls. If `init.lua` picks the toolbar's controls (`modes.<mode>.toolbar`), list your control's id there to show it.
- **A section's buttons** go on its heading and show while the heading is selected, as the Inventory's do; at most four.
- **A float's buttons** are at its foot, each with a key while it has focus (`q` closes it, like `Esc`); **its links** open in the browser and show the address's host beside the label. Only `https://` and `http://` addresses.
- **`roster.cmd(line)`** runs a command line as if the user typed it.
- **`roster.sessions.show(session, line)`** goes to the Session with that id (the one events carry, so two Sessions to one Host are told apart) and, with `line`, opens the terminal's search on that text from the bottom, highlighted, so `Enter` goes on up and `Esc` closes it. A Session that has ended is said in a notice.

`roster.confirm`, `roster.cmd` and `roster.sessions.show`, like `roster.clipboard.copy` and `roster.views.open`, work **only in a call the user started**: something the user chose (a command, a key, a row's or button's action, a finder item, a toolbar control, a question's answer). At load, in an event listener or a timer they're errors, so a Plugin never asks, runs or moves you anywhere on its own; so are a finder's `items`, a `:check` section's `check` and a command's `complete`, which the app runs as it needs them, and a question's `cancel` run because another Plugin's question took its place. **The user's call carries one hop:** one of your commands that your `roster.cmd` runs from the user's call is still that call (a drop that runs `folder add` can answer with `roster.echo`), as the answer to a `roster.serve.request` made in it is; but a `roster.cmd` or a request made in either of those doesn't carry it on, so the command that line names runs as the app's call and can't copy, ask, run a line or act. A Plugin can't keep the user's call alive by chaining its own commands. A line naming one of your commands is never one of roster's that a Plugin may not run: a command you named `open` or `plugins` (which the app refuses anyway) doesn't make `roster.cmd("open …")` yours, and a command whose line runs itself, or two that run each other, stop with a notice. `roster.cmd` reaches only your own commands and [the commands of roster's that only show something](plugin-api.md#command-lines-a-plugin-may-run), each with the permission it needs: never `:plugins`, `:packages`, `:publish`, `:source`, the editor or the vault, nor another Plugin's commands, which would run with that Plugin's permissions.

A table's rows can be filtered: `/` in any table opens a filter that keeps the rows saying every word typed (`Enter` keeps it and goes back to the rows, `Esc` clears it). An action with `when = { state = "up" }` shows and runs only on the rows whose cells match, so Cut is there only on a Host that's up; a cell needn't be a column. And `roster.views.update` can change the table's `columns`, `sort` and `actions` as well as its rows: new actions' functions replace the old ones', and `open` stays as `roster.views.set` gave it.

## Limits

Your Plugin runs in its own Lua state, on its own thread, with the sandbox's libraries and `coroutine` (no `io`, no `os.execute`, `require` from its own folder only, and only files whose real path is inside it) and:

- **32 MB** of memory;
- **1 second** to run `init.lua`, and **a quarter of a second** for each call (a command, an action, an event, a `:check` section, an HTTP request's answer). Time spent waiting for roster serve doesn't count; an HTTP request or a `roster.serve.request` doesn't wait at all (8 serve requests waiting at once, at most); a coroutine's time is the call's. Running out can't be caught with `pcall` or `coroutine.resume`;
- at most 1,000 UI changes in one call, and 2,000 rows in a section, items in a finder, lines in a float or rows in one `set` or `update` of a table (10,000 in a table after updates). Text is cut to 500 characters (a help page to 200,000);
- a data folder of 1 MB a file and 10 MB in all, in at most 1,000 files ([its own files](#a-plugins-own-files));
- at most 100 calls into roster serve with `roster.serve.call` or `roster.inventory` in one call, waiting 300 s in all (`roster.inventory.hosts()` and `.groups()` in one call are one);
- at most 2 calls into roster serve at a time (4 for all Plugins together), queued in the order asked;
- at most 100 timers waiting at once; a deferred function waits at least 50 ms, and a repeating one at least a second between runs, counted from when the last run ended. A timer's run has a call's budget, and an error in it counts like any other.

An error shows a notice naming your Plugin with the file and line: `pinned: init.lua:12: attempt to index a nil value`. A call that fails changes nothing on screen, and nothing in the core either: the functions it replaced still run, and the timers and commands it added are gone (what it changed in its own Lua variables stays). An error while loading stops the Plugin; so does a third error after that, and so does a call that doesn't answer within two seconds of its budget (a long pattern match, say; waiting for roster serve isn't counted). When it stops, everything it added goes away and the rest of the app carries on. `:plugins` says why, and `:plugins reload NAME` tries again ([errors](app/errors.md#a-plugin-stops)).

## For roster's developers: how it's built

The Lua runs in roster-core (`crates/roster-core/src/plugin/`), never in the frontend, and it reaches roster only through `roster serve`'s methods its permissions name. Each call into a Plugin answers with the result and a list of **ops**: plain data such as `{ "op": "section", "id": "pinned", "spec": { … } }`, with each Lua function replaced by `{ "handler": N }`. The frontend (`app/src/plugins/`) checks every op (`ops.ts`), puts it into the registries with the Plugin's name as its source, and runs a handler with `:plugins call NAME N CONTEXT` (what ran it, as URI-encoded JSON, to which the manager adds the Session on screen when the Plugin may know it). A table's functions are called with the row instead (`{ row, host, view | section }`), and its rows carry no functions, so `roster.views.update` can change some of them without touching the rest; views and Host-details sections are the `views` and `details` registries (`app/src/view/views.ts`), drawn by `ViewContent.tsx` and `ui/DataTable.tsx` over the pure table model in `ui/table.ts`. A graph's functions are called with the node (`{ node, host, view }`, plus the Session on screen as any handler's context), and its nodes and edges are plain data too: `plugins/graphOps.ts` checks them, and `app/src/graph/` lays them out, keeps their places in the State and draws them on a canvas (ticket 77). A question, progress and toolbar control are the ops `confirm`, `progress` and `toolbar` (ticket 78); the question and progress live in the manager's snapshot, drawn by `PluginsPanel.tsx`, and the controls go into the toolbar registry. `roster.cmd` is the op `cmd`; a command line a Plugin hands over runs as `:plugins run NAME LINE`, and both pass `plugins/cmd.ts`, the app's side of the core's rule (`COMMANDS` in api.rs, in `plugin-api.json`). The one exception to "each call answers": an HTTP request's answer (`network`, `plugin/network.rs`) or a `roster.serve.request`'s (asked on a thread of its own) runs the Plugin's function on its own thread later, and the Tauri side sends what it did to the frontend as the `plugin-reply` event, applied like a call's reply. The host's wall clock for a call leaves out the time the Plugin's thread spent waiting for roster serve (`ServeWait` in `plugin/mod.rs`). Packages (ticket 24) are `crates/roster-core/src/package/`: git as a subprocess (`git.rs`), the clones in the app's data folder and `roster.lock`; the frontend loads one as the Plugin `package:NAME`, which the Tauri side turns into its clone and its settings from `init.lua` (`PluginHost::load_with`). A timer is an op too (`{ "op": "timer", "id", "ms", "every", "run" }`): the frontend keeps the clock and calls the handler back, and the core, which knows the handler is a timer, runs it as one (never as a call the user started). `terminal_output` comes from `committed.ts`, a terminal (xterm's, never opened) per Session, which also reads a shell's OSC 133 marks for `command_done` (an OSC handler on that terminal; nothing is written to the Session). `?fixture=recent-alerts` in a plain browser starts the app with recent-alerts installed and alerts in two Sessions, for looking at Plugin UI headless.

A Plugin's folders are `plugin/folder.rs` (decision Q93): `inside`, the one "stays inside its folder" rule the host reads every file of a Plugin's code through (and `config/lua.rs`'s `require`, and a Package's `dir`), and `Storage`, the data folder behind `roster.storage`, which the Tauri side places in the app's data folder (`PluginHost::set_data`) and removes with `plugin_forget` (`PluginHost::forget`) when the frontend removes a Plugin. `:plugins` asks `plugin_data` (`PluginHost::data_use`, `Storage::data_use`) for each Plugin's files and bytes once when it opens, not with the request counts every few seconds: it lists each folder, and a Plugin's data rarely changes while you look. The built-in Folders is `crates/roster-core/plugins/folders/init.lua`; the frontend hands it init.lua's Folders and, once, folders.yml's (`app/src/folders/file.ts`, `foldersSettings`) as its settings, and the fake Backend has the same Plugin in TypeScript (`app/src/backend/fakeFolders.ts`) for the UI tests and the browser. A command's `complete` (op field `complete`), `roster.echo` (op `echo`) and `roster.cmdline` (op `cmdline`) go through the manager like any op; the manager keeps each command's last completions and redraws when the next answer comes.

The API is declared once, in `crates/roster-core/src/plugin/api.rs` (decision Q89): each function, value, type and event with its parameters, returns, errors, permission and `Since`. `cargo run -p roster-core --example gen_plugin_api` writes [the reference](plugin-api.md), the stubs (`examples/plugins/types/roster.lua`) and the same as data (`crates/roster-core/tests/fixtures/plugin-api.json`, which the help's topics read). A change to the API isn't done until api.rs says it: `crates/roster-core/tests/plugin_api.rs` fails when the runtime has a function or value api.rs lacks (or the other way round) for any grants, or a generated file is stale; `app/src/plugins/api.test.ts` fails when `ops.ts` reads a field a type doesn't list; `tests/test_plugin_api.py` when a Host, group or service from roster serve has a field the Host type doesn't.

## See also

[The Plugin API](plugin-api.md) · [How far roster bends](app/extending.md) · [Your init.lua](app/config.md) · [Where secrets go](app/security.md) · [Plugins and Packages, as decided](adr/0006-lua-plugins-and-packages.md)
