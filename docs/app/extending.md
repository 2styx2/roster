# How far roster bends

roster is built from registries: lists of commands, keys, Themes, finders and the rest, each entry marked with where it came from. The built-in features register into them the same way your `init.lua` does, and the way Plugins do. So whatever the app does with them, you can change, and every list in help shows each entry's source (`builtin`, `init.lua`, or a Plugin's name), so you can always see what came from you.

Two lines never move, whatever the Config: secrets never reach the app's UI, the Config or a Plugin, and a change to the Inventory only ever becomes a Pending change that you review and Publish.

## The registries

| Registry | What's in it | What `init.lua` does with it today | Where it's listed |
|---|---|---|---|
| Commands | Every action: `:connect`, `:theme`, `:help`… A key, a typed line and a button all run one | Binds keys to any command line | [Commands](commands) |
| Key bindings | The keymap, per context: after the Leader, the Sidebar, the Picker, the command line, the terminal, everywhere | `keys`, `leader`, `vim`, `roster.keymap.set` | [Key bindings](keys), `␣ K` |
| Themes | Colour tokens for the UI and the terminal | `theme`, `themes`, `colors`, `roster.themes.define`; `:config import-terminal` makes one from Windows Terminal | [Themes](themes) |
| Layout | Each view mode's pieces: title bar, Sidebar, session bar, status bar, toolbar, fullscreen | `modes.standard`, `modes.focus`, `default_mode`, `sessions` | [Your init.lua](config.md#layout) |
| Sidebar sections | Sessions, Folders, the Inventory, and Plugins' | `modes.<mode>.sidebar.sections` picks and orders them | [Your init.lua](config.md#layout) |
| Status bar segments | Backend, Box, Hosts (the built-in `hosts` Plugin), path, Pending changes, hints, mode, and Plugins' | `modes.<mode>.statusbar` picks and orders them | [Your init.lua](config.md#layout) |
| Toolbar controls | Sidebar, Find, Quick Connect, Add Host, Changes, Publish, and five more you can turn on | `modes.<mode>.toolbar` picks and orders them | [Your init.lua](config.md#layout) |
| Finders | Fuzzy lists over Sessions, Hosts, the tree, Themes, help topics | Binds keys to `finder SOURCE` | [Finders](finders) |
| Folders | Your own grouping of Hosts | `folders` (read-only in the app); the app's own are kept by the built-in Folders Plugin ([plugins.md](../plugins.md#a-plugins-own-files)) | [Your init.lua](config.md#folders) |
| Errors | Every error, with where it lives and the fix | Read-only for now | [Connection errors](errors) |
| Help pages | These pages | Plugins add pages (`roster.help.set`); `init.lua` can't | [roster help](index) |
| Views | Panels and full views: `:help`, Host details, the forms, `:plugins`, and Plugins' views | `views.ID.place` and `width`, `panel.width`; `:panel reset` puts them back | [Panels](keyboard.md#panels-docked-or-full-window) |
| Health sections | What `:check` with no Host checks: the app and `roster serve`, roster's own sections, `init.lua`, the terminal font, and Plugins' | A Plugin adds a section whose checks run on each `:check` (`roster.health.set`), like Neovim's `vim.health` | [Health](health), [Health sections](../plugins.md#health-sections) |

## Plugins

A Plugin is Lua, run by the same Lua runtime as `init.lua`, that adds to these same registries: its own commands, keys, Themes, Sidebar sections, status segments, toolbar controls, finders, badges on Hosts, floating windows, views (tables and graphs), sections of a Host's details, questions, progress, notices, help pages and `:check` sections, plus events such as "a Session opened" and roster serve's job progress. It gets only the functions for the permissions you granted, and `:plugins` revokes them at once. Plugins add no HTML: they hand the core data and actions, and the core draws them in roster's style. What they can never do: see a secret, or Publish by themselves. The status bar's Host count and the Sidebar's Folders are written as Plugins, on the same API ([plugins.md](../plugins.md)).

A Package is a Plugin fetched from a git repo and pinned to a commit in `roster.lock`, the way lazy.nvim works ([Packages](../plugins.md#packages)). The core stays small: features only some people need are optional Plugins that roster provides, built on exactly this API: [the Mesh controls](../../plugins/mesh/README.md), [Discover](../../plugins/discover/README.md) and [Topology](../../plugins/topology/README.md) ([First-party Plugins](../plugins.md#first-party-plugins)).

## See also

[Writing a Plugin](../plugins.md) · [Recipes](recipes.md) · [Your init.lua](config.md) · [Options](options) · [Keyboard](keyboard.md)
