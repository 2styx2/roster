# Roadmap

> **The app is frozen as of 2026-11-06** ([ADR 0011](../adr/0011-herdr-is-the-session-runtime.md)): nothing below is planned any more, and no new work goes into `app/` or `crates/`. Its replacement is [herdr](https://herdr.dev) with the roster mod, [herdr-roster](https://github.com/2styx2/herdr-roster). This page stays as the record of what was built.

We work in iterations. Each one ends with a hands-on check on the Windows machine, against real Hosts (one key-enrolled, one password-only, one unreviewed), before the next one starts. Tickets and their blockers are GitHub issues, one milestone per iteration: https://github.com/2styx2/roster/milestones.

| # | Iteration | Tickets | Done when |
|---|---|---|---|
| 1 | **Thin slice** | 01–08, 17, 26 | You can unlock, pick a Host, and get a working shell on both an enrolled and a password-only Host over the WSL backend, all from the keyboard |
| 2 | **Design pass + worst-case UI + Lua config + Focus mode** (`/emil-design-eng`, `/animate`, `/break-ui`) | 09, 27, 21, 22, 30 (themes), 31 (sign-in + 2FA), 29 (interface review: the user picks the fixes) | You're happy with how it looks and feels on Windows, and `init.lua` can restyle and rebind it with live reload |
| 2.5 | **One repo on GitHub** | — | roster-desk merged into roster under `app/` (ADR 0007) |
| 3 | **Inventory writes: verified adds, live two-way Sidebar editing** | 10–13, 28 | You can add or edit a Host, see the diff, Publish, and another Box picks the change up |
| 4 | **Quick Connect + "Save to vault" + local-only KeePassXC** → **Release `v0.1.0`** | 14–16, 25, 35–38, 41 | A new box reached by IP and password becomes a Vault item plus a Host |
| 5 | **Host details** | 18 | Detail panel, opening web services |
| 6 | **Other platforms** | 19–20 | Native Windows backend; Linux under X11, Wayland and WSLg |
| 7 | **Plugins and Packages** → **Release `v0.2.0`** | 23–24 | A Package from a git URL adds a command, a key and a theme. Built-in Folders run as an internal Plugin. Plugins can't reach secrets. |
| 8 | **First-party Plugins** (decision Q80: minimal core) | 40, 44, 50 | Topology view, Discover UI and mesh controls ship as optional Plugins on the Plugin API, drawn with the core's UI primitives, in **Release `v0.3.0`** |
| 9 | **Fast, scriptable access** (decisions Q110, Q112) → **Release `v0.3.0`** | 101, 102, 105, 107–109, 111 | `roster serve` answers concurrently with a job manager (cancel, check jobs), `--json` on the CLI's read commands never holds a secret, and routine messages are quiet |

**`v0.3.0`** follows `v0.2.0`: iterations 8 and 9, the follow-ups from their docs pass (116), and the round of open issues after them: password-prompt fill and nested ssh logins (119, 120), shell integration and opt-in shell hooks (94, 121), Plugin network sites, pins and a proxy (87), Plugins in `:tutor` (66), serve and askpass hardening (113), native Windows vault sign-in (63), docs website search (65), and the Neovim-style `init.lua` with an option reference (138–143). **`v0.4.0`** follows `v0.3.0`: a fixes round (the owner's rule: every fix before any new feature): flaky tests made deterministic (146), Plugin API 5's complete collections and the first-party Plugins on it (145, 149), the config follow-ups and `roster.o.get` (144), Folders drops before the built-in commands arrive (135), prompt-fill safety and sudo's `pwfeedback` (137, 154), Ctrl+V paste on Windows (152), serve syncing this Box after every Inventory change (150), and the docs, CI, shell-integration, graph and Packages follow-ups. The next Release isn't named yet.

Later, not planned yet: plugin HTML panels, split panes, broadcast input, SFTP, port forwarding, writing to other providers, MRs instead of pushing, macOS as a tested platform, code signing.
