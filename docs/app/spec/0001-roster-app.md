# Spec 0001: the roster app

Status: ready-for-agent · Created 2026-10-29 · Vocabulary: roster `GLOSSARY.md` · Decisions: roster `docs/adr/0001`, `0002`

## Problem Statement

I spend my day getting into terminals on the hosts in our Inventory. roster already knows every Host, how to reach it and which Login opens it, but using it means typing `roster hosts --find`, remembering exact names, and switching between the CLI, a terminal, and a separate Bitwarden step whenever a box takes only a password. SecureCRT, Termius, Tabby and XPipe all make it easy to open tabs to hosts, but each keeps its own private list of saved sessions. None of them knows our team's Inventory, our naming rules for Vault items, or our review step for discovered hosts. When I log in to a new box with a password, nothing saves that login back into the Inventory and vault for next time.

## Solution

**The roster app** is a fast, keyboard-first desktop app that gets me into a terminal on any Host in a few keystrokes, using roster as its only backend.

**What it looks like**
- The terminal fills the window. A fuzzy picker finds Hosts by name, address, type or group.
- One thin tab strip holds the open Sessions.
- Side panels (host tree and Host details) stay closed until I ask for them.
- The window frame, shortcuts, fonts and light/dark theme follow the OS.
- Inside the window, the app has its own polished design and motion.

**How I drive it**
- Vim-style keys work everywhere outside the terminal.
- A leader key (Ctrl+Space by default) takes control back from the shell.
- Everything also works with the mouse.

**Vault and secrets**
- Starting the app asks for the vault master password, and that unlocks it.
- The app locks itself again when I'm idle.
- Passwords go from roster straight into `ssh`. The app never shows, stores or logs them.

**Changing the Inventory**
- I can add and edit Hosts from the app. Each change becomes a Pending change I can review as a diff, then Publish to the infra repo for the team.
- Quick Connect lets me reach a box that isn't in the Inventory. A "Save to vault" option turns a successful password login into a Bitwarden item plus a new Host.

**Where it runs**
- Windows, with roster either native or inside WSL.
- Linux, under X11, Wayland or WSLg.

We build it in iterations. Each one is tested by hand before the next starts:

1. **Thin slice.** `roster serve`, the app skeleton, the lock screen, the host picker, and terminal tabs over the WSL backend for both kinds of Host: key-enrolled and password-only.
2. **Design pass** on the slice, using `/emil-design-eng` and `/animate`.
3. **Inventory writes:** Pending changes, diff, Publish.
4. **Quick Connect** with "Save to vault".
5. **Side panels:** host tree and Host details, plus opening a Host's web services.
6. **Native Windows backend**, then the Linux build.

## User Stories

### Getting in: lock screen and vault

1. As the user, I want the app to open on a lock screen that asks for the master password of the Inventory's vault, so that one password unlocks both the app and my secrets.
2. As the user, I want to see a clear message when the master password is wrong, without a stack trace, so that I just try again.
3. As the user, I want to see what's wrong when the vault CLI isn't installed or isn't logged in on this Box, and the exact command to fix it, so that I'm never stuck on a blank screen.
4. As the user, I want the app to lock itself after 15 minutes idle, so that walking away from my desk doesn't leave the vault open.
5. As the user, I want to set the idle timeout in my Config, so that I can match it to how I work.
6. As the user, I want locking to really forget the vault session and every cached secret, so that "locked" means locked, not just hidden.
7. As the user, I want to lock the app on demand with a key or command, so that I can lock it before screen sharing.
8. As the user, I want my open Sessions to keep running while the app is locked, with their content hidden, so that locking doesn't kill long jobs.
9. As the user, I want to unlock with the master password and get my Sessions back exactly as they were, so that locking costs me nothing.

### Finding a Host

10. As the user, I want to open a fuzzy host picker with `<leader> f` or a click, so that any Host is a few keystrokes away.
11. As the user, I want the picker to match name, address, type, product, title and group, so that I can find a box by whatever I remember about it.
12. As the user, I want results ranked by match quality and then by how recently I used each Host, so that the box I want is usually first.
13. As the user, I want each result to show name, address, group and type, so that I can tell similar boxes apart.
14. As the user, I want Hosts with `reviewed: false` marked clearly and not connectable, so that I never log in to an unreviewed scan result by accident.
15. As the user, I want to move through results with `j`/`k` or Ctrl+N/Ctrl+P and the arrow keys, so that my vim habits work.
16. As the user, I want Enter to open a Session in a new tab, so that connecting is one key.
17. As the user, I want a separate key that connects in the current tab when it's idle, so that I don't pile up dead tabs.
18. As the user, I want Esc to close the picker and return focus to the terminal I came from, so that the picker never traps me.
19. As the user, I want the picker to open instantly, even with hundreds of Hosts, so that it feels like part of the terminal.

### Sessions and the terminal

20. As the user, I want a Session to a key-enrolled Host to open straight to a shell, so that it feels exactly like `ssh HOST`.
21. As the user, I want a Session to a password-only Host to log in by itself with the password from the vault, so that I never copy a password.
22. As the user, I want the password never to appear in the terminal, scrollback, logs or app state, so that my secrets stay as safe as with the CLI.
23. As the user, I want a failed login (wrong vault password, host down, host key mismatch) to show `ssh`'s own message in the tab plus a short explanation, so that I can fix it.
24. As the user, I want a host key mismatch to stop the connection, never ask me to accept, so that the app is no weaker than roster's own setup.
25. As the user, I want full terminal fidelity:
    - colors and 256/true color
    - mouse reporting
    - alternate screen
    - resize
    - Unicode and emoji
    - vim, htop and tmux working remotely

    so that the terminal never gets in my way.
26. As the user, I want every key, Esc included, to reach the remote shell while the terminal has focus, so that vim on the remote side works normally.
27. As the user, I want copy on selection or Ctrl+Shift+C, and paste with Ctrl+Shift+V or a right-click, so that clipboard use matches common Linux terminals.
28. As the user, I want to search the scrollback, so that I can find earlier output.
29. As the user, I want to zoom the terminal font in and out, so that I can read dense output.
30. As the user, I want typing to show up with no visible lag, so that it feels local even when the UI is busy.
31. As the user, I want several Sessions to the same Host, so that I can run a job in one and look around in another.
32. As the user, I want a tab to show clearly when its Session has ended, with a key to reconnect, so that dropped links are easy to recover.
33. As the user, I want closing a tab to end its `ssh` process cleanly, so that nothing is left running behind the app.

### Tabs and keyboard control

34. As the user, I want a thin tab strip showing each Session's Host name and state, so that I know what's open without losing terminal space.
35. As the user, I want `<leader> 1`–`9` to switch tabs and `gt`/`gT` to cycle them, so that I can move between Sessions without the mouse.
36. As the user, I want `<leader>` then `dd` (or a command) to close the current tab, so that closing works from the keyboard.
37. As the user, I want to click a tab to focus it, middle-click to close it and drag to reorder it, so that the mouse works as I'd expect.
38. As the user, I want a command line on `<leader> :`, with commands like `:connect HOST`, `:lock`, `:publish` and `:info`, so that every action is reachable by typing.
39. As the user, I want completion for commands and Host names in the command line, so that I don't have to remember exact names.
40. As the user, I want to change the leader key in my Config, so that it doesn't clash with anything I use.
41. As the user, I want to turn vim bindings off in my Config, so that the app also suits teammates who don't use vim.
42. As the user, I want every app action to also work from a menu or button, so that the mouse is a full alternative.
43. As the user, I want a key-binding help overlay on `<leader> ?`, so that I can discover shortcuts.

### Native feel and design

44. As the user, I want a custom title bar like Slack's, holding the app icon, tabs, Host search and my own minimize, maximize and close buttons, and still able to drag, snap and resize, so that the window looks like one designed app rather than a web page in a frame.
45. As the user, I want shortcuts to follow each platform's habits (Ctrl on Windows and Linux, ⌘ on macOS), so that muscle memory carries over.
46. As the user, I want the UI to follow the OS light/dark setting, so that it matches the rest of my desktop.
47. As the user, I want UI text in the system font and a configurable monospace font in the terminal, so that it reads like a native app.
48. As the user, I want motion to be quick, purposeful and interruptible, and switched off under the OS reduced-motion setting, so that the app feels responsive, never slow.
49. As the user, I want the app to remember window size, position and open panels, so that it opens the way I left it.

### Backends

50. As the user on Windows, I want the app to detect that roster and `~/infra` live in my WSL distro and use them, so that it works with no setup.
51. As the user, I want to set the Backend in my Config to Local or WSL: <distro>, so that I can use whichever install I trust.
52. As the user, I want a Session on the WSL backend to run `ssh` inside WSL, so that it uses the same ssh config, known_hosts and key that `roster setup` wrote there.
53. As the user, I want a clear message if the Backend can't start, for example roster missing or too old, or the Inventory not found, so that I know what to install or fix.
54. As the user on Linux, I want the same app to run under X11, Wayland or WSLg, so that I can use it anywhere with a display.
55. As the user on Windows without WSL, I want roster to run natively, so that teammates without WSL can use the app.

### Inventory writes and Publish

56. As the user, I want the app to pull the infra repo before letting me edit, so that I never edit a stale Inventory. (Decision Q88: the form opens at once and pulls in the background when the last pull is older than `pull_fresh_minutes`; the save waits for that pull.)
57. As the user, I want to add a Host by filling in name, address, group, type, user, Login and enroll, so that I don't have to hand-edit YAML.
58. As the user, I want to edit a Host's fields, so that I can fix titles, descriptions and Logins in place.
59. As the user, I want to mark a Host as reviewed, so that I can bring discovered Hosts into use from the app.
60. As the user, I want to point a Host's Login at a Vault item, with suggestions that follow the `<host> <what it opens>` naming, so that Inventory and vault stay consistent.
61. As the user, I want edits checked the same way the CLI loads `roster.yml`, so that I can never Publish an Inventory that won't load.
62. As the user, I want edits to keep the comments and layout of `roster.yml`, so that the file stays readable for the team.
63. As the user, I want to see all Pending changes as a diff before Publishing, so that I know exactly what I'm pushing.
64. As the user, I want to throw away Pending changes, so that experiments cost nothing.
65. As the user, I want Publish to commit with a message describing the change and push to infra `main`, so that every Box picks it up through `roster-pull`.
66. As the user, I want Publish to stop and tell me when the remote has moved or the push fails, so that I never overwrite a teammate's change.
67. As the user, I want this Box's ssh config and Claude files rewritten (`roster sync`) after a Publish, so that new Hosts work here straight away.

### Quick Connect and "Save to vault"

68. As the user, I want to type `user@address` (optionally `:port`) in the picker or `:connect` to open a Session to a box that isn't in the Inventory, so that one-off boxes are as easy as known ones.
69. As the user, I want Quick Connect to ask for the password in a masked field that goes straight to `ssh`, so that password-only boxes work too.
70. As the user, I want a "Save to vault" checkbox on that password prompt, so that next time I don't need the password.
71. As the user, I want saving to happen only after the login succeeds, so that a mistyped password is never stored.
72. As the user, I want to be asked for a Host name, pre-filled from the box's hostname, so that the new Host is named the way I want.
73. As the user, I want the Vault item created as `<host> ssh`, with the username in the username field and the address in the URI field, so that it follows `docs/adding-hosts.md`.
74. As the user, I want the new Host added as a Pending change with `auth: "bw:<host> ssh"`, `reviewed: true` and `enroll: false`, so that I can Publish it with my other edits.
75. As the user, I want a clear error, and no Pending change, if a Vault item with that name already exists, so that I never create the duplicate that breaks lookups.
76. As the user, I want the same "Save to vault" checkbox when an existing Host with `auth: prompt` asks for a password, so that I can fill in placeholder Logins as I go.
77. As the user, I want "Save to vault" to appear only when the Inventory's provider can write, which is Bitwarden in v1, so that the app never offers what it can't do.

### Config (`init.lua`)

81. As the user, I want to configure the app in a Lua file, `init.lua`, the way I configure WezTerm or Neovim, so that my setup is code I can keep in my dotfiles.
82. As the user, I want to set the terminal and UI fonts, font size, colors and theme from `init.lua`, so that the app looks the way I like.
83. As the user, I want to rebind any key to any app action in `init.lua`, so that the keymap fits my habits.
84. As the user, I want saving `init.lua` to apply the change straight away without a restart, so that tweaking is fast.
85. As the user, I want a mistake in `init.lua` to show the file and line, while the last good config stays active, so that a typo never breaks the app.
86. As the user, I want to use Lua logic, such as picking a font by OS or a theme by time of day, so that one file works on all my machines.
87. As the user, I want a documented example `init.lua` covering every option, so that I can discover what's configurable.

### Sidebar, Folders and a configurable shell (decisions Q29–Q35)

88. As the user, I want open Sessions listed in a left Sidebar, the way SecureCRT's Session Manager or an editor's file tree does it, so that I see everything that's open at a glance instead of squinting at tabs.
89. As the user, I want the Session on screen marked with a raised highlight (lighter fill, thin outline) rather than an underline, so that the selection is clear but quiet.
90. As the user, I want to put Hosts into my own Folders, such as "Lab ESXi" or "Daily", kept on my Box and never pushed to the team, so that I can organise my day without touching the Inventory.
91. As the user, I want a bare title bar with just the logo and minimize, maximize and close, so that the window is calm and everything else lives in the Sidebar.
92. As the user, I want to hide the status bar and the helper key hints, and see every key binding in one panel that reads from my Config, so that the screen stays clean and I can still look things up.
93. As the user, I want every default (theme colours, fonts, Sidebar or tabs, status bar, title bar contents, keys) to be changeable from `init.lua`, so that the app is as configurable as my editor.

94. As the user, I want two view modes toggled with `␣ m`: Standard (the default, with the Sidebar), and Focus (true fullscreen, with Neovim-style Leader keys and Telescope-like fuzzy finders for Sessions (`␣ b`) and Hosts (`␣ f`), and an optional tmux-style session bar). That way I can live in the terminal when I want to, without losing anything roster can do.
95. As the user, I want my own shell config (`.bashrc`, prompt, `LS_COLORS`, vim and truecolor colour schemes) to render exactly as it does in any good terminal, so that the roster app never fights my setup.

96. As the user, I want to install Packages (Plugins from git repos) by listing them in `init.lua`, pinned to a commit, the way lazy.nvim does it, so that I can add features other people wrote.
97. As a Plugin author, I want a Lua API to add commands, key bindings, themes, Sidebar sections, finder sources, status segments and event hooks, the same registries the built-in features use, so that a Plugin can do anything the app does.
98. As the user, I want Plugins never to see passwords, and never to Publish Inventory changes without me, so that installing a Package can't leak secrets or change the team's Inventory behind my back.

99. As the user, I want a Host to be added, and its password saved to my vault, only after a test login with exactly that address, user and password has succeeded, so that the Inventory and the vault never fill up with typos, dead boxes or wrong passwords.

100. As the user, I want to add, remove and rename Hosts and groups right in the Sidebar, with each change written to `roster.yml` (as Pending changes), and I want edits I make to `roster.yml` or `folders.yml` in vim to show up in the Sidebar straight away, so that the file and the app never disagree.
101. As the user, I want every screen to look right with worst-case data (long names, hundreds of Hosts, empty lists, narrow windows), so that the app never looks broken on a real network.

### Host details and web services

78. As the user, I want a toggleable side panel with the host tree grouped like the Inventory, folded with `h`/`l`, so that I can browse when I don't know what I'm looking for.
79. As the user, I want a Host detail panel showing what `roster info` shows (address, type, product, description, services, which Vault item each Login uses, enroll and reviewed), so that I can understand a box without the CLI.
80. As the user, I want to open any of a Host's web services in my default browser from the detail panel or a command, so that I can reach web UIs as fast as shells.

## Implementation Decisions

**Architecture** (ADR 0001, ADR 0002)
- There are two codebases:
  - **roster** (Python) gains a `serve` command and a few supporting capabilities.
  - **The roster app** (then roster-desk) was a separate local repo, and now lives in the roster repo's `app/` (decision Q56, ADR 0007): a Tauri app with a Rust core and a React + Vite + TypeScript frontend.
- The roster app never reads `roster.yml`, a vault, or a password. All Inventory knowledge and all secrets stay in roster.
- The Rust core owns process management, the PTYs and the window. The frontend owns everything you see.

**`roster serve`: the backend API**
- Speaks JSON-RPC 2.0 over stdin/stdout, one JSON object per line. Logging goes to stderr only.
- Exactly one `serve` process per app launch. It exits when stdin closes.
- Returns the objects roster already builds when it loads the Inventory: Host (with its resolved ssh block, services, login, group, reviewed, enroll and the text fields), group, and resource. There is no new schema.
  - Login references (`bw:...`) are returned as references only. A method never returns a secret value.
- Methods for iteration 1:
  - `inventory.info`: path, Box name, host count, provider names, roster version, API version.
  - `hosts.list`: all Hosts and groups.
  - `host.get`: one Host by name.
  - `vault.status`: locked, unlocked, not-logged-in or missing-cli, plus which provider.
  - `vault.unlock`: takes the master password as a parameter.
  - `vault.lock`
  - `session.prepare`: given a Host name, checks it's reviewed and returns what the app needs to launch a Session, without any secret: the `ssh` command line and the environment to set, including the askpass helper and a one-time askpass token. It refuses unreviewed Hosts with the same message as `roster run`.
- Methods for later iterations:
  - `inventory.pull`, `host.add`, `host.update`, `host.review`
  - `changes.diff`, `changes.discard`, `changes.publish`
  - `vault.create_item`
  - `quick.prepare`, `quick.save`
- Errors are JSON-RPC errors with a stable `code` and a user-facing `message`. They reuse roster's existing wording, such as the bw "not logged in" and "several items match" messages.
- `vault.unlock` hands the master password to the provider through the existing environment-variable unlock path, never on a command line. The resulting session key lives only in this process's memory. It is never written to the bw-session file.
- `vault.lock` clears the provider state, the cached secrets and the session key, and runs the provider's own lock.
- The API has a version number. The app checks it at startup and refuses a roster that's too old, with an upgrade message.

**The askpass channel** (refines ADR 0002)
- Askpass is the one exception to stdio-only. While `serve` runs, it listens on a private local channel: a Unix socket in a user-only runtime directory on Linux and WSL, and a named pipe restricted to the user on native Windows (iteration 6).
- `session.prepare` creates a one-time token tied to one Host's ssh Login. It expires when used, after 60 seconds, or on lock.
- The askpass helper is a roster command (`roster askpass`), so it runs wherever `ssh` runs, inside WSL on the WSL backend. ssh invokes it with the token in its environment. It sends the token over the channel, gets the password, and prints it to ssh.
  - It answers only password prompts. Host-key confirmation or any other prompt is refused, so the connection fails safely.
- Sessions set `SSH_ASKPASS_REQUIRE=force` and `NumberOfPasswordPrompts=1`. Key-enrolled Hosts use `BatchMode=yes`, so a broken key fails loudly instead of falling back to a prompt.
- The password goes from the provider to `serve`, over the channel, to the helper, and into ssh. It never passes through the Rust core or the frontend.

**The app's Rust core**
- **Backend runner:** starts `roster serve` (natively, or as `wsl.exe -d <distro> -- roster serve`), handles JSON-RPC calls from the frontend, and restarts or reports a dead backend.
- **Backend detection on Windows:** use a WSL distro if roster is on its PATH there and its Inventory resolves. Otherwise fall back to native roster. The Config can override this.
- **Session manager:** opens a PTY (ConPTY on Windows) running the ssh command from `session.prepare`, wrapped in `wsl.exe` on the WSL backend. It streams output to and input from the frontend, handles resize, closes cleanly, and reports exit status. One PTY per Session, with Session IDs owned by the core.
- **Idle lock timer:** counts input across all windows and Sessions. On timeout it calls `vault.lock` and tells the frontend to show the lock screen. Session PTYs keep running.
- **Config:** `init.lua` in the user config dir, run with mlua, with no Settings screen (ADR 0004, ticket 21). **State** (window, recent Hosts) is a separate app-managed file. Neither ever holds secrets.

**The app's frontend**
- React + TypeScript, built with Vite.
- **The terminal:** xterm.js with the WebGL renderer, falling back to xterm 6's DOM renderer when WebGL is missing (xterm 6 dropped the canvas renderer) (likely on WebKitGTK and WSLg).
- **One typed backend interface:** a TypeScript client wraps every Tauri command and event (backend calls, Session I/O, lock events). All UI code goes through it, and it's the seam the UI tests fake.
- **Keyboard model:** two focus modes.
  - *Terminal mode* sends every key to the PTY except the leader chord.
  - *App mode* (after the leader, or when the picker, a panel or the command line has focus) applies vim bindings.

  The bindings live in one keymap table, with options for the leader key and vim on or off, that the Config overrides.
- **App state** is a small store: Sessions, tabs, picker, lock state, and the resolved Config. It holds no secrets. The master password field clears as soon as the unlock call returns.
- **Picker:** a client-side fuzzy match over the `hosts.list` result. Recent-use order is kept in the State file.
- **Visual design and motion:** come from the design pass in iteration 2, using `/emil-design-eng` and `/animate`. Iteration 1 uses plain, tidy defaults.

**Inventory writes** (iteration 3)
- Every write is a `serve` method. It edits `roster.yml` text in place and keeps comments, the same way `discover --write` does today. It refuses any result that wouldn't load, and keeps the `.bak`.
- Pending changes are the uncommitted diff in the infra working tree. Publish runs commit + push to `main`, refuses a non-fast-forward with a clear message, then runs `roster sync`.

**Quick Connect** (iteration 4)
- `quick.prepare` sets up a Session for `user@address[:port]` with no Inventory entry. The password typed in the app is sent once to `serve`, which holds it under the askpass token.
- `quick.save` runs only after the app sees the Session reach a shell. It creates the Vault item through the provider's new "create" capability (Bitwarden only), then adds the Host as a Pending change. If the item name already exists, it creates nothing.
- **Unknown host keys:** an address that isn't in the Inventory has no recorded fingerprint. `quick.prepare` scans the host key first, the way `record_fingerprints` does, and the app shows the fingerprint and asks me to confirm before connecting.

## Testing Decisions

- **Good tests** drive the system through its public seam and check behavior I can see: responses, errors, files written, processes started. They don't check internals.
- **Seam 1: `roster serve`'s JSON-RPC protocol** (the main backend seam). pytest starts `roster serve` as a subprocess, writes JSON-RPC requests, and checks the responses. It uses the existing fake `bw`/`op`/`pass` CLIs and the isolated-HOME fixture. Coverage:
  - unlock with the right and wrong password
  - lock clears secrets
  - `hosts.list` matches what `roster hosts` shows
  - `session.prepare` refuses unreviewed Hosts
  - an askpass token can be used once only and expires
  - no response ever contains a secret (assert the fake vault's passwords never appear in stdout)

  Prior art: `test_providers.py` and `test_cli.py`.
- **Seam 2: the askpass channel.** A test asks `serve` for a token, runs `roster askpass` as ssh would, and checks it prints the password once, refuses a reused token, and refuses non-password prompts.
- **Seam 3: the frontend's typed backend interface.** UI behavior is tested with Vitest and Testing Library against a fake backend that implements the same interface. Coverage:
  - lock and unlock flow
  - picker filtering and ranking
  - keyboard model: leader, modes, vim keys, Esc
  - tab lifecycle
- **Rust core:** a few integration tests. The backend runner talks to a stub `serve` script. The session manager runs a stub command in a PTY and checks I/O, resize and exit.
- **No real network in automated tests.** Each iteration ends with a manual check on my Windows machine against real Hosts: one key-enrolled, one password-only, one unreviewed. Later iterations also cover the Linux VM.
- roster's existing checks (`ruff`, `pytest`) must keep passing. The roster app gets matching checks: `tsc --noEmit`, the linter, Vitest, `cargo test`.

## Out of Scope

- Split panes, sending one command to many Hosts, broadcast input
- SFTP and file transfer
- Running `discover` from the app
- Port forwarding and tunnel management
- Session logging to disk
- Serial and telnet
- RDP and VNC
- macOS builds (left possible, not targeted)
- Writing to 1Password, `pass` or other providers (Bitwarden only)
- Creating Vault items other than Quick Connect's `<host> ssh`
- Merge requests instead of a direct push on Publish
- Vim-style editing inside form fields
- A Settings screen (the Config file is the only way to configure; ADR 0004)
- Lua event hooks, custom commands and Picker sources in the *Config itself* (v1 Config is values plus key bindings). These arrive with the Plugin API in iteration 7 (ADR 0006).
- Plugin-supplied HTML/JS panels (ADR 0006)
- Mobile
- Sync or accounts of our own
- Packaging, installers, auto-update and distribution to the team
- Open-sourcing and licensing

## Further Notes

- **Competitors.** XPipe is the closest existing tool: a cross-platform connection hub that reads passwords from Bitwarden. The roster app differs in having a team Inventory kept in git, per-service Logins, a review gate for discovered Hosts, and secrets that the frontend never sees. Those are what's worth protecting if this is ever open-sourced.
- **Linux webview risk.** On Linux, Tauri uses WebKitGTK. The terminal's WebGL path and typing latency need checking on Linux in the first week of the Linux iteration.
- **Askpass and the ADRs.** The askpass channel is a deliberate, narrow exception to ADR 0001's stdio-only rule. If it grows beyond askpass, write a new ADR.
- **Tauri ADR.** Record the choice of Tauri over Electron as the roster app's first ADR. Tauri gives a small, fast app with a Rust core, at the cost of WebKitGTK on Linux.
- **Watch the scope.** This is a personal tool first. Choose what feels best to use every day over what would sell.
