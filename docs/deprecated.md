# Deprecated names

Old names that still work, and what replaces each one, newest Release first. Use the new name: an old one goes away in a later Release, and [What's new](news.md) says when, under **Removed**. `:help` on an old name lands on its row here, so a name in your fingers or an old script still finds its way.

An old name stays for at least one minor Release after the one that deprecates it: deprecated in 0.1, it works through 0.2 at least. When `init.lua` sets a deprecated option, roster still applies it under its new name and warns, naming the replacement and the row here.

## Deprecated in 0.4

### Plugin API

| Old | New | Notes |
|---|---|---|
| A removal of something the Plugin never added doing nothing (`roster.themes.remove`, `roster.keymap.del`, any collection's `remove`, `roster.views.update`/`open`/`close` of an unknown view), and a key context that isn't one refused with a notice | An error at the Plugin's line; check first with the collection's `has` | For a Plugin whose manifest says `api = 4` or older, nothing changes. Raise it to `api = 5` and each such call is an error, as in `init.lua` ([plugin-api.md](plugin-api.md#errors)) |

## Deprecated in 0.3

### App

| Old | New | Notes |
|---|---|---|
| `folders.yml` | The Folders Plugin's own data (`plugin-data/folders/folders.json`); hand-written Folders in `init.lua`'s `folders` | Its Folders move in once, at the first start; after that the app doesn't read, write or watch it, and `:check` says it's still there. `:source` and `auto_reload` no longer reload it. Delete it once your Folders look right ([config.md](app/config.md#foldersyml)) |
| `folder:NAME` (a Folder's id for `:fold`) | `folders:NAME` | A Folder's row is the Folders Plugin's now. `:fold folder:NAME` still folds it, and a Folder folded before stays folded (the app moves its id) |
| `roster.themes.define(id, …)` a second time for one id (the later call won) | `roster.themes.update(id, fields)` | In `init.lua` a Theme is defined once: a second `define` of its id, or one of a bundled Theme's id, is an error naming both lines and saying to use `update`, which changes yours or a bundled one ([config.md](app/config.md#the-roster-table)). A Config that defined a Theme in a base module and again in an override module changes the second to `update` |

### Plugin API

| Old | New | Notes |
|---|---|---|
| `roster.keymap.set(context, keys, false)` | `roster.keymap.del(context, keys)` | Since `roster.api_version` 3 it takes the Plugin's own binding off, as `del` does; in 2 it claimed the keys with no action |

## Deprecated in 0.1

### CLI

Nothing.

### App

| Old | New | Notes |
|---|---|---|
| `ROSTER_DESK_ROSTER` | `ROSTER_APP_ROSTER` | The command that runs roster, for development. Read only when the new one isn't set |
| `ROSTER_DESK_WSL_DISTRO` | `ROSTER_APP_WSL_DISTRO` | The one WSL distro to use. Read only when the new one isn't set |

### init.lua options

Nothing.

### serve API

Nothing.

### Keys

| Old | New | Notes |
|---|---|---|
| `␣ ?` (Key bindings) | `␣ K` | `␣ ?` finds a help topic now. `keys = { leader = { ["?"] = "keys" } }` in `init.lua` brings the old key back |

## See also

[What's new](news.md) · [Key bindings](keys) · [Options](options)
