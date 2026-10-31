# Writing a Plugin

A Plugin is a folder of Lua that adds to roster the way the app's own features do: commands, key bindings, Themes, Sidebar sections, finders, status segments, badges on Hosts, floating windows, notices and help pages. It runs in the same sandbox as your `init.lua` ([config.md](app/config.md#the-sandbox)), and it only gets the functions for the permissions you granted it. It never sees a password, the vault or what you type at a login prompt, and it can't Publish (ADR 0006, decision Q81).

A Plugin draws nothing itself. It hands the app data (rows, text, items) and the app draws them in roster's own style, with its keys and Theme, so a Plugin looks native and can't do anything else on screen.

## A first Plugin

[`examples/plugins/recent-alerts`](../examples/plugins/recent-alerts) is the worked example, built the way an author outside roster would build one: it watches what your Sessions print and lists the lines with `ERROR`, `panic` or `disk full` in a Sidebar section, with a badge on each Host that has some, a status segment with the count, a finder, a floating window with an alert's details, a notice when one arrives, `:alerts` and `:alerts clear`, a Leader key from its settings and its own help page. It asks for one permission, `terminal.read`. Copy the folder to start your own; its [README](../examples/plugins/recent-alerts/README.md) is the template for yours. [`examples/plugins/pinned`](../examples/plugins/pinned) is a smaller one that reads the Inventory.

```
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
  api = 2,                      -- the roster.api_version it's written for
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
local function granted(p)
  for _, g in ipairs(roster.plugin.permissions) do if g == p then return true end end
end
if granted("terminal.read") then
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
- **Ask only for what you need**, and keep working without it: check `roster.plugin.permissions`, and say what's missing (its section reads "Allow terminal.read in :plugins to see alerts.").
- **`terminal_output` comes in batches**, so a line can be split across two of them: keep each Session's unfinished end until the rest arrives.
- **Keys after the Leader that roster uses are refused** (`a` is Folders', `f` the Picker's; `:keys` lists them all), with a notice. Make yours a setting.
- **Do things in a fixed order** (sort what comes from `pairs`), so the same state makes the same changes.

`:plugins install ~/plugins/recent-alerts` installs it. To share it, push the folder to a git repo: others name it in `init.lua` as a [Package](#packages). A path is `~/…`, a full path, or a folder under the config folder (`plugins/pinned`).

## Installing and trusting

- **`:plugins install PATH`** reads the manifest and asks first: who wrote it, where it's from (unverified), and every permission it asks for, with the risky ones flagged and explained. Cancel (`Esc`) installs nothing.
- **An update that asks for a new permission asks again** at the next start. Until you answer, it doesn't run. "Not now" runs it without the new permission.
- **`:plugins`** lists every Plugin: whether it's running or why it stopped, its permissions as switches, and what it did lately. Turning a switch off takes the permission away at once: the Plugin is loaded again without it, with no restart. Turning it on grants it.
- **`:plugins remove NAME`** unloads it and takes everything it added away. **`:plugins reload NAME`** loads it again, after you've changed it or once it was stopped.
- `:plugins revoke NAME PERMISSION` and `:plugins grant NAME PERMISSION` do what the switches do.

What you granted is kept in the app's State, which neither `init.lua` nor a Plugin can write.

Every Plugin is made the same way, with the same API, the same prompts and the same install path. The one built into the app, `hosts` (the status bar's Host count), is written on this API too: `:plugins` lists it, and revoking its permission takes the count away.

## Packages

A Package is a Plugin from a git repo, named in `init.lua` and pinned to a commit, the way lazy.nvim does it for Neovim ([config.md](app/config.md#packages)):

```lua
packages = {
  { "someone/recent-alerts", tag = "v1.2.0", config = { patterns = { "ERROR", "panic" } } },
  "https://git.example.com/team/roster-extras.git",
},
```

- **Nothing installs that isn't named there.** At start, and on `:source` after you change the list, the app clones each new one into its own data folder (next to the State, never the config folder) and asks first, with the same prompt as `:plugins install`: who wrote it, its git URL and commit as the unverified source, and every permission. Cancel removes the clone and installs nothing; it asks again at the next start while `init.lua` still names it.
- **`roster.lock`**, next to `init.lua`, pins each installed Package's commit. Put it in your dotfiles with `init.lua`: on another machine the app clones exactly those commits (and asks, since what you granted is per Box). With the clones and the lock in place, the app starts without the network.
- **`:packages`** lists them: the commit each is at, what `init.lua` asks for, and whether it runs.
- **`:packages update`** fetches each one and shows what's new before anything changes: the commits, the diff, and any permission the new version asks for. Enter updates (and grants what it newly asks for); Esc keeps the version it has.
- **`:packages clean`** removes the clones and lock lines of Packages `init.lua` no longer names, with everything they added. **`:plugins remove NAME`** takes one out at once, clone and lock line included.
- **`config`** is a table of settings the Package reads as `roster.plugin.config` (a `config = function() … end` as in lazy.nvim isn't possible: the Package's code runs in a Lua state of its own, which a function from `init.lua` can't move into).

The app runs your system's `git` (it must be installed) with no shell, no credentials of roster's and no way to ask for any: a private repo works when your own git setup (an ssh agent, say) already gets in. Only `https`, `ssh` and `file` URLs, no submodules, and no hooks.

## Permissions

A function a permission gives isn't there without it: `roster.inventory` is `nil` until `inventory.read` is granted. Each of them checks the grant again when it's called.

| Permission | What it adds | Why it's flagged |
|---|---|---|
| none | Commands, keys, Themes, Sidebar sections, status segments, finders, badges, floats, notices, help pages, the `lock` and `unlock` events | |
| `inventory.read` | `roster.inventory.hosts()`, `roster.inventory.host(name)`: Hosts with their Login *references* (a vault item's name, never its password); the events that name a Host | |
| `inventory.write` | `roster.inventory.update(host, changes)`, `rename(host, to)`, `move(host, group)`, `review(host, reviewed)`: as Pending changes, which you review and Publish | Can change Hosts |
| `sessions.open` | `roster.sessions.open(host)`, as `:connect HOST` | Can open Sessions on your Hosts |
| `terminal.read` | The `terminal_output` event: what your Sessions print | Sees everything your Sessions print, including anything a server echoes back. A password you type at a prompt that echoes it would be visible too |
| `terminal.write` | `roster.terminal.send(session, text)` | Can type into your Sessions, as if you typed it |
| `serve:METHOD` | `roster.serve.call(method, params)` for that method only: `inventory.info`, `hosts.list`, `host.get`, `host.check`, `changes.diff`, and the `mesh.*` and `discover.*` methods | Any method that can change something (`mesh.apply`, `mesh.cut`, …): everything but `inventory.info`, `hosts.list`, `host.get`, `changes.diff`, `mesh.status` and `mesh.plan` |

No permission reaches a secret. The vault, a session's password, askpass and the master password live only in `roster serve` and never pass through the app; the serve methods that touch them (`vault.*`, `session.*`, `quick.*`, `host.add`, `host.save_login`, `changes.publish`) can't be granted at all, and a manifest that asks for one doesn't install. `network` isn't available yet.

## The `roster` module

`require("roster")` (also the global `roster`) is the whole API. **[The Plugin API](plugin-api.md)** is its reference: every function with its parameters, returns, errors, permission and an example, and every type with all its fields (`:help plugin-api`; `:help roster.inventory.host()` for one function, `:help roster-Host` for one type). In short:

| Area | Functions | Permission |
|---|---|---|
| The Plugin and the app | [`roster.plugin`](plugin-api.md#rosterplugin), [`roster.api_version`](plugin-api.md#rosterapi_version), [`roster.os`](plugin-api.md#rosteros), [`roster.notify`](plugin-api.md#rosternotifytext-level), [`roster.on`](plugin-api.md#rosteronevent-listener) | none |
| Commands and keys | [`roster.commands`](plugin-api.md#rostercommands), [`roster.keymap`](plugin-api.md#rosterkeymap) | none |
| What the app draws for you | [`roster.sidebar`](plugin-api.md#rostersidebar), [`roster.status`](plugin-api.md#rosterstatus), [`roster.finders`](plugin-api.md#rosterfinders), [`roster.badges`](plugin-api.md#rosterbadges), [`roster.float`](plugin-api.md#rosterfloat), [`roster.themes`](plugin-api.md#rosterthemes) | none |
| Help, health and tutorials | [`roster.help`](plugin-api.md#rosterhelp), [`roster.health`](plugin-api.md#rosterhealth), [`roster.tutor`](plugin-api.md#rostertutor) | none |
| The clipboard | [`roster.clipboard`](plugin-api.md#rosterclipboard) | none, in a call the user started |
| Hosts | [`roster.inventory`](plugin-api.md#rosterinventory) | `inventory.read`, `inventory.write` |
| Sessions | [`roster.sessions`](plugin-api.md#rostersessions), [`roster.terminal`](plugin-api.md#rosterterminal) | `sessions.open`, `terminal.write` |
| roster serve | [`roster.serve`](plugin-api.md#rosterserve) | `serve:<method>` |

Everywhere a Plugin hands the app something to run (a row, a button, a finder item, a status segment, a command), `run` is a function or a command line; a function runs in your Plugin when the user chooses the thing. [Events](plugin-api.md#events) come through `roster.on`; a Quick Connect Session's `host` is `nil` in them, since it isn't on a Host: don't badge it or make a row go to it. What you type into a Session is never an event, but the shell echoes it back, so it's in `terminal_output` like anything else the Session prints (recent-alerts skips a line that looks like a prompt and a command).

After the app resizes a Session (a panel, Focus, the window), the Session may print its screen again: ConPTY does on Windows, and full-screen programs redraw. The app keeps that repaint out of `terminal_output` for a second (lines it already sent you lately are left out; new ones still come), so a Plugin that counts lines doesn't count them twice.

Text you hand the app (a label, a notice, a float's lines, a badge, what you copy) that isn't valid UTF-8, such as a line you cut in the middle of a character, is shown with `�` where it breaks; it isn't an error. A name that isn't (an id, a table key) is.

A tutorial (`roster.tutor.set`) runs on the demo Inventory, where your Plugin isn't loaded: a step can wait for your command being run there, but your command won't do anything there yet. Its steps wait for the app's own events ([`StepMatch`](plugin-api.md#stepmatch)).

### Types in your editor

[`examples/plugins/types/roster.lua`](../examples/plugins/types/roster.lua) declares the whole API for [lua-language-server](https://luals.github.io/), generated with the reference, so your editor completes `roster.` and checks what you hand the app. [Editor support](plugin-api.md#editor-support) says how to point it there; the example Plugins are annotated that way, and CI checks them with it.

## Limits

Your Plugin runs in its own Lua state, on its own thread, with the sandbox's libraries (no `io`, no `os.execute`, `require` from its own folder only) and:

- **32 MB** of memory;
- **1 second** to run `init.lua`, and **a quarter of a second** for each call (a command, an action, an event). Time spent waiting for roster serve doesn't count. Running out can't be caught with `pcall`;
- at most 1,000 UI changes in one call, and 2,000 rows in a section, items in a finder or lines in a float. Text is cut to 500 characters (a help page to 200,000).

An error shows a notice naming your Plugin with the file and line: `pinned: init.lua:12: attempt to index a nil value`. An error while loading stops the Plugin; so does a third error after that, and so does a call that doesn't answer within two seconds of its budget (a long pattern match, say). When it stops, everything it added goes away and the rest of the app carries on. `:plugins` says why, and `:plugins reload NAME` tries again.

## For roster's developers: how it's built

The Lua runs in roster-core (`crates/roster-core/src/plugin/`), never in the frontend, and it reaches roster only through `roster serve`'s methods its permissions name. Each call into a Plugin answers with the result and a list of **ops**: plain data such as `{ "op": "section", "id": "pinned", "spec": { … } }`, with each Lua function replaced by `{ "handler": N }`. The frontend (`app/src/plugins/`) checks every op (`ops.ts`), puts it into the registries with the Plugin's name as its source, and runs a handler with `:plugins call NAME N`. Packages (ticket 24) are `crates/roster-core/src/package/`: git as a subprocess (`git.rs`), the clones in the app's data folder and `roster.lock`; the frontend loads one as the Plugin `package:NAME`, which the Tauri side turns into its clone and its settings from `init.lua` (`PluginHost::load_with`).

The API is declared once, in `crates/roster-core/src/plugin/api.rs` (decision Q89): each function, value, type and event with its parameters, returns, errors, permission and `Since`. `cargo run -p roster-core --example gen_plugin_api` writes [the reference](plugin-api.md), the stubs (`examples/plugins/types/roster.lua`) and the same as data (`crates/roster-core/tests/fixtures/plugin-api.json`, which the help's topics read). A change to the API isn't done until api.rs says it: `crates/roster-core/tests/plugin_api.rs` fails when the runtime has a function or value api.rs lacks (or the other way round) for any grants, or a generated file is stale; `app/src/plugins/api.test.ts` fails when `ops.ts` reads a field a type doesn't list; `tests/test_plugin_api.py` when a Host, group or service from roster serve has a field the Host type doesn't.

## See also

[The Plugin API](plugin-api.md) · [How far roster bends](app/extending.md) · [Your init.lua](app/config.md) · [Where secrets go](app/security.md) · [Plugins and Packages, as decided](adr/0006-lua-plugins-and-packages.md)
