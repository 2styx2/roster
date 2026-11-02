# First-party Plugins

Plugins the roster project writes and looks after, for features only some people need: roster's core stays small (decision Q80), and these are optional. Here now:

| Plugin | What it adds | Install (`dir =`) |
|---|---|---|
| [`mesh`](mesh/README.md) | The Mesh's controls: each Host's reach, "Mesh out of date", plan and apply, Cut, Links through a jump Host | `plugins/mesh` |
| [`discover`](discover/README.md) | Scan a network from the app, review what answered, and add the Hosts you keep as Pending changes, unreviewed. The scan runs in `roster serve` (`discover.*`) | `plugins/discover` |
| [`topology`](topology/README.md) | The Topology view: this Box, every Host by group and the Mesh as a map, what each Host can reach every hop away, live Sessions, Check and Cut from a node | `plugins/topology` |

## What first-party means

A first-party Plugin is an ordinary Plugin (decisions Q81 and Q94). It uses the same public Plugin API as anyone's ([docs/plugins.md](../docs/plugins.md)), installs the same way, as a Package, asks for its permissions in the same prompt, and gets no back doors. **None is bundled in the app**: you get one only by naming it in `init.lua`. Three things set it apart:

- **It lives here**, in roster's own repo, one folder each: `plugins/NAME/`, with `roster-plugin.lua`, `init.lua`, a `README.md`, and any `lua/NAME/` modules (the layout of [`examples/plugins/recent-alerts`](../examples/plugins/recent-alerts)).
- **It's tested in CI** with the core, on every pull request and release (see below).
- **It's security-reviewed** before it's merged and on every change (the checklist below).

## Install one

Name it in `init.lua` as a Package from roster's repo, with `dir` set to its folder:

```lua
roster.packages.add({ "https://github.com/2styx2/roster", dir = "plugins/NAME" })
```

Then `:source`. The app clones the repo into its own data folder, loads the Plugin from `plugins/NAME` and asks first, showing the repo, the folder, the commit and every permission. Allow pins the commit in `roster.lock`, next to `init.lua`, like any Package. The Package is named after the folder (`NAME`); `name = "…"` names it something else.

- **Which version:** as written, the repo's default branch as it is today, and `:packages update` moves you on. Add `tag = "vX.Y.Z"` (a roster release that has the Plugin) to stay on the commit that release was tested at.
- **Updates:** `:packages update` shows only what changed in that Plugin's folder; commits elsewhere in the repo aren't an update to it.
- **Several:** each one is a line of its own. Each has its own clone and its own line in `roster.lock`, so one can be updated without the others.
- **Removing:** take the line out of `init.lua` and run `:packages clean`, or `:plugins remove NAME`.

## Tested in CI

A first-party Plugin's tests run in the jobs that test the core (`.github/workflows/ci.yml`); there's no separate pipeline to forget.

| Job | What it runs on `plugins/` |
|---|---|
| App Rust (`cargo test`) | `crates/roster-core/tests/first_party.rs` installs every folder here as a Package with `dir = "plugins/NAME"` (from a local git repo, no network), checks its manifest names it after its folder, and loads it through the Plugin host the app uses, with the permissions it asks for. The Plugin's own tests go next to it, in `crates/roster-core/tests/plugin_NAME.rs`: drive it through the host as [`recent_alerts.rs`](../crates/roster-core/tests/recent_alerts.rs) does (install, every slot it fills, what it can't reach, revoking, an update that asks for more) |
| App frontend (`npm run check`) | Its UI tests, in `app/src/plugins/NAME.test.ts(x)`, against the fake Backend; a recorded transcript of the real Lua (as recent-alerts does) keeps the stand-in honest |
| Plugin types (lua-language-server) | Every `.lua` file here, checked against the Plugin API's generated stubs (`.luarc.json` points at `examples/plugins/types`) |

To run them locally: `cargo test --test first_party`, `cargo test --test plugin_NAME`, `npm run check` in `app/`, and `lua-language-server --check plugins --checklevel=Hint`.

## Security review

Every first-party Plugin is reviewed like the core before it's merged, and again on any change that adds a permission, a serve method or a new way in for outside data. The reviewer goes through this list and says so in the pull request:

- [ ] **Least permission.** Each permission in `roster-plugin.lua` is needed for something the README says it does, and the README's "Permissions" section says why. No `serve:` method it doesn't call.
- [ ] **Nothing secret.** It never asks for, stores, logs or shows a password, key or token, and never puts terminal output (with `terminal.read`) anywhere it outlives the app or leaves the Box.
- [ ] **Changes go through the user.** Anything it changes goes through the APIs that show it first: Inventory edits as Pending changes (`inventory.write`), and a `serve:` method that changes something only after a confirmation the user answers.
- [ ] **No network it doesn't need.** Every `network:` site is one it calls, and the README says why; no `http://` unless the service has nothing else.
- [ ] **Acts only on the user's call.** Every flagged serve method, `inventory.write` call and `roster.cmd` runs from an action, command, finder item, toolbar control or a question's answer, never at load, on an event or from a timer (the core refuses it there anyway).
- [ ] **Outside data is data.** Text from Hosts, Sessions or the Inventory is shown as text, never run as Lua (`load`) or treated as a command; patterns from it are escaped.
- [ ] **Bounded.** It keeps no unbounded list in memory (alerts, history) and does nothing heavy per `terminal_output` event; it stays inside the host's limits ([Limits](../docs/plugins.md#limits)).
- [ ] **Without its permissions** it still loads and says what it's missing, rather than failing.
- [ ] **No files outside its folder.** No symlinks, nothing generated at install, no submodules (git won't fetch them anyway).
- [ ] **Tests** cover what it can't reach as well as what it does, and run in CI as above.
- [ ] **Docs:** its README (what it adds, permissions, install snippet), a `:help NAME` page, and a line in `docs/news.md`.

## See also

[Writing a Plugin](../docs/plugins.md) · [Packages](../docs/plugins.md#packages) · [`packages` in init.lua](../docs/app/config.md#packages) · Decisions Q80, Q81 and Q94 in [decisions.md](../docs/app/decisions.md)
