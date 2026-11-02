# Roster

Roster is the team's shared map of the network: which hosts exist, how to reach them, and which vault login opens each one. It has two faces: the `roster` CLI (`src/roster/`) and the roster app, the desktop app in `app/`. Both use the same words.

## Language

**Inventory**:
The team's one list of hosts and resources, kept in `roster.yml` in the infra repo.
_Avoid_: config, host list, map file

**Host**:
A machine or device recorded in the Inventory, saved with its address, type, services and logins.
_Avoid_: session (SecureCRT's word for this), server, node

**Box**:
A machine that runs roster and connects to Hosts from there, such as a laptop, a jump host or a Claude box.
_Avoid_: client, workstation

**Session**:
One live terminal connection from a Box to a Host. A Host can have several Sessions open at once.
_Avoid_: connection profile, saved session

**Host key**:
The key a Host's sshd proves itself with. roster keeps the ones it trusts in its known hosts (`~/.ssh/roster_known_hosts`), recorded by `roster setup`, a verified add or edit, or a Session's question "roster hasn't seen this Host's key before" (Q60). A key that differs from the recorded one is never accepted. A Quick Connect's key, confirmed when you connect, is trusted for that Session only and never recorded there (Q67).
_Avoid_: fingerprint (that's the key's SHA256 digest, what the user compares), server key

**Login**:
A pointer from a Host, or one of its services, to the vault item that opens it. A Login never contains the password itself.
_Avoid_: credential, account (an account is a kind of resource)

**Vault item**:
One entry in the team's password manager, named `<host> <what it opens>`.
_Avoid_: secret, entry, password

**Save to**:
Where "Save to vault" puts a new Vault item: the personal vault, an organization's collection (Bitwarden), or a group (KeePassXC). Set by `save_to` in `roster.yml` (the team's default) and `init.lua` (this Box's), and chosen per Host in the add form.
_Avoid_: destination, location, folder (a Folder is the app's grouping of Hosts)

**Quick Connect**:
Opening a Session to an address that isn't a Host in the Inventory yet: `user@address[:port]`, typed in the Picker or after `:connect`. If you choose to save it, it becomes a Host with its own Vault item.
_Avoid_: ad-hoc session, direct connect

**Pending change**:
An edit to the Inventory made on this Box that hasn't been Published yet.
_Avoid_: draft, unsaved edit

**Publish**:
Committing the Pending changes and pushing them to the infra repo, so every Box picks them up.
_Avoid_: save, sync (sync means rewriting a Box's ssh config from the Inventory)

**Mesh**:
Host-to-Host access that one Box sets up: Hosts in a meshed group, or joined by a Link, can log in to each other with their own keys. Nothing is installed on the Hosts.
_Avoid_: VPN, tailnet, fleet

**Link**:
A one-way (or `both`) permission in the Inventory for one Host or group to reach another across groups or networks.
_Avoid_: route, peering

**Password peer**:
A Host in the Mesh that takes no key (`enroll: false`, appliances): its peers' ssh asks the person for its password, and roster never copies one to a Host.
_Avoid_: password host (that's how the Box logs in to it), appliance

**Cut**:
Taking one Host out of the Mesh at once, on every Host in parallel (`roster mesh cut HOST`), without waiting for a Publish; it leaves `mesh: false` for that Host as a Pending change.
_Avoid_: revoke (that removes the Box's own key), ban

**Mesh job**:
A plan, apply or cut that roster serve runs in the background (`background: true`), so the app or a Plugin follows it (`mesh.job`) and can stop it (`mesh.stop`) instead of waiting minutes for an answer. One at a time. A kind of **Job**.
_Avoid_: task, background run

**Job**:
Background work roster serve owns: a Mesh run, a Discover scan or a Host's check. It has a kind and an id, a state, progress, a result and a stop, pushes its progress (`job.progress`, the Plugins' `job_progress`), and is stopped and recorded when serve exits. One of each kind at a time (a check: one per Host).
_Avoid_: task, worker (serve's workers answer requests; a Job runs beside them)

## The app

The desktop app's own words, on top of the ones above (which mean the same thing in the app).

**Backend**:
The roster install the app drives on this machine: either Local (roster on the same OS as the app) or WSL: <distro>.
_Avoid_: server, engine

**Picker**:
The fuzzy-search overlay for finding a Host, or typing a Quick Connect address, and opening a Session.
_Avoid_: launcher, search box, palette

**Leader**:
The one key chord that takes control back from a terminal so the next keys go to the app.
_Avoid_: prefix, hotkey

**Terminal mode**:
The focus state where every key, except the Leader, goes to the Session's shell.
_Avoid_: insert mode

**App mode**:
The focus state where keys drive the app (the Picker, tabs, panels, the command line) using the keymap.
_Avoid_: normal mode, command mode

**Prompt fill**:
Typing a Host's password from the vault at sudo's prompt for its login user in its Session, when the user presses the fill key (`␣ p`); only at a prompt that doesn't echo, and only one that's provably the Session's own Host's (decision Q129), or the Host a nested ssh provably went to (decision Q131).
_Avoid_: autofill, auto-type

**Hook token**:
The random value, new for each Session attempt, that roster's shell hooks put on every OSC 133 mark (`roster=…`); a mark with it is provably the Session's own shell's, since no other machine sees it (decision Q131). Plugins never get it.
_Avoid_: nonce (in user-facing text), session key

**Nested ssh**:
An `ssh` the user runs inside a Session, to another Host. roster follows one to an Inventory Host only with the shell's marks, shows it as the Session's breadcrumb (`esx-01 ─ esx-02`) until that ssh ends, and may fill that Host's login and sudo prompts (decision Q131).
_Avoid_: jump (that's ssh's `-J`, which roster refuses), hop chain

**Lock**:
The state where the vault is forgotten and every Session's content is hidden. The vault master password ends it.
_Avoid_: logout, sleep

**Sign out**:
Signing the vault CLI out of its account on this Box (`vault.logout`), so a different account can sign in. Everything the Lock forgets is forgotten first, and the CLI's local copy of the vault goes too. Only for a provider with accounts (Bitwarden).
_Avoid_: logout (for the Lock), switch user

**Config**:
The user's `init.lua`: code that sets fonts, colors, keys and options, layered over the built-in defaults.
_Avoid_: settings, preferences, profile

**State**:
What the app remembers on its own between runs, such as window size, open panels and recently used Hosts. It's never written in the Config.
_Avoid_: settings, cache

**Sidebar**:
The left pane listing open Sessions, the user's Folders and the Inventory tree. It's the default way to see and switch Sessions.
_Avoid_: tab strip, session manager, explorer

**Host details**:
The side panel, opposite the Sidebar, that shows what `roster info HOST` shows: address, type, product, description, services, the Vault item each Login uses (by name), enrolled and reviewed. A **web service** is one of a Host's services with an http or https URL; the panel and `:open SERVICE` open it in the default browser.
_Avoid_: inspector, properties, host info (`:info` alone is the app's own info)

**Folder**:
A personal grouping of Hosts in the Sidebar (for example "Lab ESXi"), kept on this Box and never in the Inventory.
_Avoid_: group (that's the Inventory's own grouping, shared by the team), favorite, collection

**Theme**:
A named set of colour tokens. The Config can pick one, change any token, or define a new one.
_Avoid_: skin, colour scheme

**View**:
A panel a Plugin adds (`roster.views`), opened with `:view ID`: a side panel beside the terminal, or a full view over the whole window. Its `place` is where it opens first; the user can dock it or make it full window, as any panel (`␣ z`). It holds text, facts and a table whose rows are plain data, or a graph (nodes, edges and clusters, also plain data). Not a View mode.
_Avoid_: page, screen, window

**View mode**:
How much of the app shows around the terminal: **Standard** (Sidebar and title bar) or **Focus** (fullscreen, fuzzy finders, optional session bar).
_Avoid_: layout, zen mode, presentation mode

**Panel**:
Anything that opens beside the terminal: `:help`, Host details, the forms, `:check`, `:plugins`, a Plugin's View. Docked at a width you choose (`␣ <`, `␣ >`, a drag of its edge) or full window (`␣ z`), remembered per panel.
_Avoid_: drawer, split (roster has none), sidebar (that's the Sidebar)

**Message line**:
The line at the bottom that answers a command: errors, warnings, answers and results that need attention. Routine confirmations are quiet unless `ui.messages = "all"`; `:messages` lists the recent ones, quiet ones too.
_Avoid_: toast, notification (a Plugin's notice is one), status bar

**Health**:
How this Box stands for roster, as `:check` with no Host (or `roster check --box`) finds it: a section at a time (`roster.yml`, ssh, the vault, askpass, the infra repo, `init.lua`, the font, and each Plugin's own section), each check OK, WARNING or ERROR with its fix. Every check is local; checking one Host is `:check HOST`.
_Avoid_: diagnostics (that's `:check HOST`), doctor, status page

**Help topic**:
A name `:help` opens: a page (`options`), an entry on one (`terminal.size`, `:connect`, `E13`), a guide's heading (`config#the-sandbox`) or another name for one (`roster.yml`). The topic finder (`␣ ?`) lists them all, and `:help all` lists them A to Z.
_Avoid_: tag (Neovim's word; fine in code, not in the UI), help article, doc id

**Demo Inventory**:
The made-up Inventory `:tutor` runs on (`demo-01` to `demo-06`): the fake Backend the tests use, whose Sessions are pretend shells in the app, under a "Demo Inventory" banner. Nothing done there reaches a network, a vault, `roster.yml` or your State, except the tutorial's progress. Your running Plugins load there too, with their grants, against the demo's Hosts, offline, with throwaway files (decision Q123).
_Avoid_: sandbox (that's `init.lua`'s), playground, test mode

**Tutorial**:
What `:tutor` runs: lessons with steps that tick themselves from what the app does (a command run, a Session opened, a help page followed), shown as a help page (`:help tutor`). roster ships one; Plugins can add more.
_Avoid_: walkthrough, tour, onboarding

**Plugin**:
A folder of Lua code (a manifest, `roster-plugin.lua`, and `init.lua`) that extends the app through its registries (commands, keys, themes, Sidebar sections, finder sources, status segments, badges, floats, views (tables and graphs), Host-details and `:check` sections, toolbar controls, questions and progress, help pages, event hooks), with its own data folder and only the permissions the user granted. It never sees secrets.
_Avoid_: extension, addon, mod

**Permission**:
What a Plugin may do beyond adding its own UI (`inventory.read`, `terminal.read`, `serve:<method>`, `network:<site>`, …): asked for in its manifest, granted at install, revoked in `:plugins`. None reaches a secret.
_Avoid_: scope, capability, right

**Package**:
A Plugin fetched from a git repo, named in the Config (`packages`) and pinned to a commit in the lock file, `roster.lock`, next to `init.lua`. The Plugin is the repo's top folder, or the folder `dir` names (`plugins/topology`). A **first-party Plugin** is one in roster's own repo, under `plugins/`, installed as a Package like any other (decision Q94).
_Avoid_: bundle, module

**Provider**:
The password manager a Login's reference points into (Bitwarden, 1Password, `pass`, KeePassXC, …). roster asks it for one secret at a time and never keeps a vault of its own.
_Avoid_: vault (the provider's own store), backend (that's the roster install the app drives)
