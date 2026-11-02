# `roster serve` API

`roster serve` is the backend for the desktop app (the roster app, [`app/`](../app/README.md)). It speaks JSON-RPC 2.0 on stdin/stdout, one JSON object per line, answers several requests at once (API 20; [Ordering, locks and jobs](#ordering-locks-and-jobs)), and exits with code 0 when stdin closes. It is the app's backend, not a public API: scripts and other tools use the CLI's `--json` ([Machine-readable output](cli-reference.md#machine-readable-output)). Its one other channel is the private askpass socket for password Sessions (below). Only responses go to stdout; warnings and logs go to stderr. It finds `roster.yml` the same way every other command does (`-c PATH`, `$ROSTER_CONFIG`, ...).

Results are the objects roster builds when it loads `roster.yml`, with no extra schema. Logins come back as references (`bw:esxi-02 ssh+web`), never as values.

**Deadlines.** The slow methods have an overall deadline (`serve.py`'s `DEADLINES`): `host.add` 100 s, `changes.publish` 110 s, `inventory.pull`, `host.check`, `host.verify_login`, `vault.create_item`, `quick.save` and `host.save_login` 45 s. Every git, vault CLI and ssh step inside gets what's left of it as its own timeout, and a step that runs out fails cleanly like any other timeout. A few steps still run once it's past, so the outcome is known and clean: undoing a commit, checking whether a push that timed out got there, and taking a new Vault item back out (at most `AFTER_DEADLINE`, 40 s, in all). The app waits longer than deadline plus that for each method (`CALL_SECS` in `crates/roster-core/src/backend.rs`; a test checks the two tables agree), so `serve` answers before the app gives up. If the app gives up anyway (a stalled box), it asks what happened before it says anything (`app/src/backend/afterTimeout.ts`): after `host.add`, whether the Host is in the Inventory (`host.get`); after `changes.publish`, whether the Pending changes are gone and `changes.diff`'s `last_commit` is on the upstream. Both wait for the slow call: a write holds `roster.yml` for its whole request, `changes.diff` takes it too, and the check after `host.add` asks `host.get` with `settled: true`, which waits for it (API 20; a serve before that answered in order, which waited anyway).

## Ordering, locks and jobs

**Ordering** (API 20, decision Q112). serve reads each request and hands it to a worker: 8 of them for every method, and 2 more of their own for the quick reads (`inventory.info`, `hosts.list`, `host.get` without `settled`, `mesh.status`, `mesh.job`, `mesh.stop`, `discover.plan`, `discover.status`, `discover.stop`, `jobs.list`, `jobs.stop`, `inventory.watch`, `vault.forget_typed`, `host.check_job`), which touch only what serve holds in memory, and `vault.unlock` has a lane of its own (API 21), so an unlock never waits behind 8 busy workers. So a quick read answers at once while a Publish, a `host.check` or a waiting Mesh plan runs, and **answers can come back in another order than the requests went out**: match them by `id`. Each answer and each notification is one whole line. Before API 20 serve answered one request at a time, in order.

**Locks.** What must not overlap is held by a lock per resource, never by the order of requests. Each method claims what it needs before it starts (`LOCKS` in `serve.py`), always in this order:

| Resource | Held alone by | Shared by |
|---|---|---|
| `roster.yml` (the file, its git repo and the loaded Inventory) | every write, for the whole request: `host.update`, `.remove`, `.rename`, `.move`, `.review`, `.add`, `quick.save`, `host.save_login`, `group.new`, `.rename`, `.delete`, `discover.add`, `changes.diff`, `.discard`, `.publish`, `inventory.pull`, `.reload`; a Mesh cut while it writes `mesh: false`; the watcher while it reloads an outside edit; `host.get {settled: true}`; and any method reloading `roster.yml` (only while it reloads) | nothing |
| the vault | `vault.unlock`, `.login`, `.configure`; `vault.lock` and `.logout` after they forgot every secret (below) | every method that looks a secret up, makes a Vault item or mints an askpass token: `session.prepare`, `quick.prepare`, a `host.check`'s job, `host.verify_login`, `host.add`, `quick.save`, `host.save_login`, `vault.status`, `.targets`, `.create_item`, `.undo_create` |

Two writes to `roster.yml` never interleave, and a Publish commits exactly what was written before it; a write sent during it waits and lands after it as a new Pending change. `vault.lock` and `vault.logout` never wait to start and never answer `4`: they forget every secret, askpass token, held typed password and sign-in at once, so a lookup from then on finds the vault locked, then wait (with no limit) for the requests that already hold one, and forget again what those held or made meanwhile; a running `host.check` is stopped at its next step rather than waited for (API 21), and shares the vault only while a step of a password Login fetches a secret or mints a token (API 22), so neither a lock nor an unlock waits for the rest of it. The other requests sharing the vault are waited for: each ends within its deadline or its vault CLI's timeout, and stopping one could half-write an item. Once `vault.lock` answers, none is left. `vault.status` waits for an unlock sent before it, queued or running, so the app's check after an unlock it stopped waiting for sees what the unlock did (API 21). Making or deleting a Vault item (`vault.create_item`, `.undo_create`, and the saves of `host.add`, `quick.save` and `host.save_login`) goes to each vault one at a time, inside the shared vault lock: the vault CLIs aren't known to take two writes at once (API 21). A reload of `roster.yml` for a read waits for a write at most what's left of its request's deadline, and a Mesh cut's `mesh: false` write says in its `change` when `roster.yml` stayed busy (the cut itself happened). A method waits for a lock at most what's left of its deadline (50 s for one without a deadline, under the app's 60 s); a lock still held then is code `4` ("roster.yml is busy: changes.publish is still running - nothing was done", `data.busy`, `data.method`), and nothing was done.

**Jobs.** Background work is a job: a Mesh run (`mesh.plan`, `mesh.apply`, `mesh.cut`, with `background: true` or without, when the request waits for its job), a Discover scan (`discover.start`) and a Host's check (`host.check`, API 21). A job has a `kind` (`mesh`, `discover`, `check`), an id within it (`job`: the Mesh's job number, the scan's `scan-N`, the check's `check-N`, as `mesh.job`, `discover.status` and `host.check_job` name them), an `action` (`plan`, `apply`, `cut`, `scan`, `check`), a `state` (`running`, `stopping`, then `done`, `stopped` or `failed`), progress (`done` of `total`, `at` the Host it's on), and a result or `error` (`{code, message, data?}`). One job of a kind runs at a time (`111`, `120`); a check, one per Host (asking again while one runs joins it; one that is only stopping doesn't count, API 22). `jobs.list` lists each kind's latest (each Host's latest check); `jobs.stop` stops one as `mesh.stop` or `discover.stop` would. **When stdin closes**, serve refuses every request still queued (`3`, "roster serve is closing": it never runs) and gives the running ones up to 1 s to answer; then it ends a sign-in in progress (its `bw login` too) and stops every running job at once (a Mesh job ends its ssh and records in `mesh.json` what it didn't do; a scan's nmap is killed), waits up to 0.8 s for them together, logs each to stderr (`serve: closing: mesh 2 (apply) stopped at 3 of 12`), and exits: within the app's 3 s grace (`EXIT_GRACE` in `rpc.rs`).

**Notifications.** A job sends `job.progress` when it starts, at most 5 times a second while it moves (the latest always gets out), and when it ends. It never carries the result, which can be megabytes: ask the kind's own method (`mesh.job`, `discover.status`, `host.check_job`) once it has ended. A check's `at` is the step it's on and `host` the Host it checks; it never carries a step's message.

```json
{"jsonrpc": "2.0", "method": "job.progress", "params": {"kind": "mesh", "job": 3, "action": "apply", "state": "running", "done": 4, "total": 12, "at": "orion-2"}}
```

The app hands each one to the Plugins as their `job_progress` event ([Plugins](plugins.md#asking-roster-serve)): a Mesh job to a Plugin granted `serve:mesh.job`, a scan to one granted `serve:discover.status`, a check to one granted `serve:host.check_job` (API 21).

**Cancelling** (API 21, decision Q112). `$/cancel {id}` stops a request sent earlier. serve answers it on the thread that reads requests, ahead of every worker, so it works while all of them are busy. The app's core sends it as a notification (no `id` of its own, so no answer) whenever it stops waiting for an answer. What it stops:

| Where the request is | What `$/cancel` does |
|---|---|
| queued (every worker busy) | it never runs; it answers `5` |
| waiting for a lock (`roster.yml`, the vault) or for an unlock sent before it | it stops waiting at once and answers `5`; nothing was done |
| running: `host.check`, or `mesh.plan`, `mesh.apply`, `mesh.cut` waiting for their job | the job stops at its next step or Host, as `jobs.stop` would; the request answers with what was done. A check stops only if no other request waits for it and none asked for it with `background: true` (API 22): a request that joined another's check leaves it running and answers when it ends |
| running: anything else | nothing: it runs to its end, so nothing is half-written, and its answer says what it did (the app's check after a timeout, `host.get {settled: true}` or `vault.status`, sees it) |
| `vault.lock`, `vault.logout` | never cancelled: locking always succeeds |

A Plugin can never send `$/cancel` (it isn't a method a Plugin may be granted), and the ids it would need are the core's own.

<!-- BEGIN generated:methods $/cancel -->

| Method | Params | Result | Errors | Since API |
|---|---|---|---|---|
| `$/cancel` | `{id}` (the request's own `id`) | `{id, cancelled, was}`: `was` is where it was (`queued`, `waiting`, `running`), or `null` when serve has no such request (answered already, or never sent) | `-32602` | 21 |

<!-- END generated:methods -->

<!-- BEGIN generated:methods jobs.list jobs.stop -->

| Method | Params | Result | Errors | Since API |
|---|---|---|---|---|
| `jobs.list` | none | `{jobs: [{kind, job, action, state, done, total, at, host?, error?}]}`: `kind` is `mesh`, `discover` or `check` (API 21), `job` its id there (the Mesh's job number, the scan's `scan-N`, the check's `check-N`), `host` the Host a check checks, `state` `running`, `stopping`, `done`, `stopped` or `failed`. The same shape as the `job.progress` notification |  | 20 |
| `jobs.stop` | `{kind, job}` | `{kind, job, stopping}`: `stopping: false` when that job isn't running (over, or not the latest) | `-32602` | 20 |

<!-- END generated:methods -->

<!-- BEGIN generated:methods inventory.info hosts.list host.get -->

| Method | Params | Result | Errors | Since API |
|---|---|---|---|---|
| `inventory.info` | none | `{path, box, host_count, providers: [names], roster_version, api_version}` |  | 1 |
| `hosts.list` | none | `{hosts: [Host, ...], groups: {name: {title, description}}, error}`, hosts in `roster.yml` order. `error` (API 8) is `null`, or why `roster.yml` as it is now doesn't load while these are the last good ones |  | 1 |
| `host.get` | `{name}` (exact Host name) | one Host | `2` | 1 |
| `host.get` | `{name, settled: true}` | the Host once no write to `roster.yml` is under way: it waits for one as another write would (the app's check after a `host.add` it stopped waiting for) | `2`, `4` | 20 |

<!-- END generated:methods -->

A Host has `name`, `group`, `ip`, `ssh: {user, port, auth}`, `login: {user, auth}` (the default for its services), `services: {name: {port, url, scheme, user, auth, verify, login, override}}` (`login` is the resolved type, never a `web_login_names` alias), `problems: [{service, message, fix}]` (service entries left out because roster can't use them; empty when there are none), `web`, `enroll`, `reviewed`, `title`, `description`, `type`, `product`, `mac`, plus the older flat `user`, `port` and `auth`.

## Sessions: `session.prepare`

<!-- BEGIN generated:methods session.prepare -->

| Method | Params | Result | Errors | Since API |
|---|---|---|---|---|
| `session.prepare` | `{host}` (exact Host name) | key-enrolled: `{argv: [/abs/path/ssh, "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes", NAME], env: {}, host: NAME, auth: "key", login}`; password-only: `{argv: [/abs/path/ssh, "-o", "StrictHostKeyChecking=yes", "-o", "NumberOfPasswordPrompts=1", "-o", "PreferredAuthentications=password,keyboard-interactive", NAME], env: {SSH_ASKPASS, SSH_ASKPASS_REQUIRE: "force", ROSTER_ASKPASS_SOCKET, ROSTER_ASKPASS_TOKEN}, host: NAME, auth: "password", login}`. `login` (API 25) is `{address, port, user}`, what the Session connects to, for `session.fill` | `2`, `20`, `21`, `22`, `30`, `11`, `12`, `14`, `31`-`35`, `39`, `44` | 1 |
| `session.prepare` | `{host, password, save?}` (an `auth: prompt` Host) | a password Session whose askpass token holds the typed `password`; with `save: true`, also `held`, the logged-in script as `LocalCommand` and `-o ControlPath=none` (below) | `-32602`, `22`, `61`, `44` | 13 |

<!-- END generated:methods -->

`session.prepare` tells the app what to start in a PTY to open a Session. It never holds a secret. The app runs `argv` exactly as given, with `env` added (on WSL: `wsl.exe -d DISTRO --cd ~ --exec env K=V ... ARGV...`). `argv[0]` is an absolute path, because PATH under `wsl.exe --exec` is minimal.

The command is the same one `roster run` uses: `ssh -o BatchMode=yes NAME`, where `NAME` is the `Host` alias that `roster setup` / `roster sync` write to `~/.ssh/config.d/roster`. The key, user, port, `known_hosts` and connection sharing all come from that config, so a Session behaves exactly like `ssh NAME` in a terminal (ADR 0002). There's no fallback to `-i KEY -p PORT user@ip`. Without roster's config there's no recorded host key and no installed key either, so `session.prepare` refuses with code `21` and says to run `roster sync`, or `roster setup` on a box that isn't set up yet. A failed login after that (host down, key not installed) is ssh's own message in the tab.

It refuses unreviewed Hosts with the same message as `roster run`, and Hosts whose user is still discover's `CHANGE-ME` (code `30`).

**`auth: prompt` Hosts (ticket 16, API 13).** A Host whose ssh Login is `auth: prompt` has no password roster can look up. `session.prepare {host}` refuses it with `39` and `data: {user, address, port}` (after the host-key check, so `44` comes first), and the app asks for the password. `session.prepare {host, password, save?}` then answers a password Session whose askpass token holds the typed password, like a vault password (once, 60 s, forgotten by `vault.lock`). `password` and `save` for any other Host are `-32602`. With `save: true`, the password is held for "Save to vault" exactly as Quick Connect's is (`held`, the logged-in script as `LocalCommand`, `session.logged_in`), and ssh gets `-o ControlPath=none` so it really logs in with that password instead of reusing a shared connection:

<!-- BEGIN generated:methods host.save_login -->

| Method | Params | Result | Errors | Since API |
|---|---|---|---|---|
| `host.save_login` | `{held, item?, provider?, save_to?}` | `{changed: true, host, backup, item, warnings}`: the Vault item `item` (default `<host> ssh`, the user and `ssh://address[:port]` in it), then the Host's Login set to `<provider>:<item>` as a Pending change, written like `host.update` (comments and every other byte kept; an inherited `auth: prompt` gets an `auth:` of the Host's own). The item is taken back out if the Host can't be changed. `75` if the Host's address, user, port or Login changed since that Session logged in | `75`, `66`, `67`, `60`-`65`, `14` | 13 |

<!-- END generated:methods -->

**Host keys (ticket 36, decision Q60).** An app Session never trusts a host key on its own. `-o StrictHostKeyChecking=yes` on the command line wins over the `StrictHostKeyChecking accept-new` in roster's Host block, which `roster ssh`, `roster run` and a plain `ssh NAME` keep. So the key must already be in `~/.ssh/roster_known_hosts`: recorded by `roster setup`, a verified add or edit, or the app's question. When there's none for the Host's address, `session.prepare` refuses with `44` and `data: {address, port}`, after every other check (so a vault problem is reported first) and before an askpass token is minted. The app then asks: `host.scan_key {host}` fetches the key (one connection, key exchange only), the user compares the fingerprint, and `host.trust_key {host, fingerprint}` records it. `host.trust_key` fetches the key again and records it only if the Host still offers exactly that fingerprint (`23` otherwise, nothing recorded). A key that differs from a recorded one is never trusted there (`43`); in a Session, ssh refuses it (Q44).

<!-- BEGIN generated:methods host.scan_key host.trust_key -->

| Method | Params | Result | Errors | Since API |
|---|---|---|---|---|
| `host.scan_key` | `{host}` (exact Host name) | `{host, address, port, key_type, fingerprint, recorded: none\|match\|changed}`: as the `{address, port?}` form, for the Host's address and port | `2`, `40`-`42` | 11 |
| `host.scan_key` | `{address, port?}` | `{address, port, key_type, fingerprint, recorded: none\|match\|changed}`: the host key the address offers, and how it compares with the one in `~/.ssh/roster_known_hosts`. One connection, key exchange only: never logs in, never records anything | `40`-`42` | 6 |
| `host.trust_key` | `{host, fingerprint}` (`SHA256:...`, the one the user was shown) | `{host, address, port, key_type, fingerprint, recorded}`: `recorded: true` when it added the key, `false` when that key was already recorded. `43` a different key is recorded, `23` the Host offers another key now; nothing is recorded on any error | `43`, `23`, `40`-`42` | 11 |

<!-- END generated:methods -->

**Quick Connect (ticket 14, decision Q67).** A Session to `user@address[:port]`, a box that isn't in the Inventory. The app shows the key `host.scan_key {address, port}` fetched (above), then sends the fingerprint the user confirmed, with the password they typed (or none):

<!-- BEGIN generated:methods quick.prepare -->

| Method | Params | Result | Errors | Since API |
|---|---|---|---|---|
| `quick.prepare` | `{user, address, port?: 22, fingerprint, password?, save?}` | `{argv, env, host, auth, quick, user, address, port, key_type, fingerprint, held?}`: `argv` is `[/abs/path/ssh, "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=<serve's own file>", "-o", "GlobalKnownHostsFile=/dev/null", "-o", "HostKeyAlias=roster-quick-<quick>", "-o", "UpdateHostKeys=no", "-o", "ControlPath=none", "-o", "ConnectTimeout=10", ...auth options, "-p", PORT, "-l", USER, "--", ADDRESS]`; with a password, `auth: "password"`, the password options and the askpass `env` of a password Session; without, `auth: "key"`, `BatchMode=yes` and `env: {}`. `host` is `user@address` (`:port` when it isn't 22). `quick` is serve's id for this Quick Connect. `-32602` bad params (a user or address ssh could read as an option, no `SHA256:` fingerprint, an empty password, `save` without a password), `61` `save` with a provider that can't save, `43` the key differs from one roster recorded for the address, `23` it isn't the one the user was shown | `-32602`, `61`, `40`-`42`, `43`, `23`, `21`, `22` | 12 |

<!-- END generated:methods -->

**Save to vault (ticket 15, decision Q68, API 13).** With `save: true` (and a password), `serve` also holds the typed password in memory under `held` (the same id as `quick`) so it can be saved once the Session has logged in with it, and `argv` gets `-o PermitLocalCommand=yes -o LocalCommand=<the askpass channel's logged-in script>`. ssh runs a LocalCommand only after it has logged in; the script reports the Session's askpass token over the channel, and `serve` counts it only if that token is the one that handed this password to ssh. Then it sends the notification `{"jsonrpc": "2.0", "method": "session.logged_in", "params": {"held": ID}}`, and the save can go ahead:

<!-- BEGIN generated:methods quick.save vault.forget_typed -->

| Method | Params | Result | Errors | Since API |
|---|---|---|---|---|
| `quick.save` | `{quick, name, group, item?, title?, provider?, save_to?}` | `{added: true, host, backup, item, warnings}`, like `host.add`'s: the Vault item `item` (default `<name> ssh`), with the user in its username field and `ssh://address[:port]` in its URI field, then the Host `name` in `group` with `ip`, `user`, `port`, `auth: "<provider>:<item>"`, `reviewed: true` and `enroll: false`, as a Pending change, then the host key the user confirmed for the Session recorded for it in `~/.ssh/roster_known_hosts` (never a fresh scan; a failure there is a `warning`) | `80`, `81`, `74`, `60`-`62`, `64`, `65`, `14`, `66`, `67` | 13 |
| `vault.forget_typed` | `{held}` | `{forgotten}`: `serve` forgets the typed password it held (the Session ended without saving, or the offer was turned down). Never fails |  | 13 |

<!-- END generated:methods -->

`quick.save` refers to the Quick Connect's id and never takes the password again. It checks the name and group as text first (`80`, `81`, `74`), then makes the item (`60` a name that's taken, `61`, `62`, `64`, `65`, `14`), then writes the Host; if that fails, the item is taken back out (`data.undone`, or `data.left`), as `host.add` does. `66`: the Session hasn't logged in with the password (yet, or the box refused it); `67`: nothing is held for that id. A held password is forgotten after one save, by `vault.forget_typed`, by `vault.lock`, and 10 minutes after it was typed (`HOLD_FOR`, enforced by serve on its own, not only at the next call); at most 64 are held at once (`HELD_LIMIT`; a new one forgets the oldest). What `quick.save` needs of the Quick Connect (the box and the key the user confirmed) is kept with the held password and goes with it; a Quick Connect without `save` leaves nothing in serve's memory. A failed save keeps it, so another name can be tried. It never appears in a response, an error, the log (which says `askpass: root@10.0.0.5: logged in`), `roster.yml` or the Pending change.


`quick.prepare` fetches the key again (key exchange only, never a login) and trusts it for this Session only: it goes into a known-hosts file in the askpass channel's user-only directory, under that alias, and never into `~/.ssh/roster_known_hosts`. Its line stays there while serve runs (ssh may check the key again when it re-keys a long Session, and serve isn't told when a Session ends); the directory goes when serve exits. A typed password is held under a one-time askpass token, like a vault password (60 s, once, forgotten by `vault.lock`), and never appears in a response, an error or the log. Nothing is written to `roster.yml`.

### Password Sessions: the askpass channel

A Host with `enroll: false` whose ssh Login is a vault reference (not `agent`/`key`/`none`) gets a password Session. The password goes from the provider to `serve`, over a private socket, to `roster askpass`, and into `ssh`. It never passes through the app.

- On Windows (roster running natively, ticket 19), the channel is a named pipe, `\\.\pipe\roster-askpass-<32 random hex digits>`, that only this user can open: its owner is the user's SID and its DACL has that SID and nothing else (protected, so nothing is inherited: no Administrators, no SYSTEM), every instance refuses remote clients, and serve creates the first instance with `FILE_FLAG_FIRST_PIPE_INSTANCE`, so it fails rather than share a name someone else made. The helper opens it with `SECURITY_IDENTIFICATION`, so the pipe's server can't act as the user. serve also checks each client's process (`GetNamedPipeClientProcessId`, then its token's user) is this user's, on top of the DACL, and refuses one it can't tell (ticket 63). `SSH_ASKPASS` is `roster-askpass.exe` (Windows' ssh runs only a program, never a script), installed next to roster; without it, a password Session is refused with `22`. The rest below is the same.
- While `serve` runs, it listens on a Unix socket in a fresh directory: `$XDG_RUNTIME_DIR/roster-askpass-PID-XXXXXXXX/`, named for the serve that owns it (or the temp dir if there's no runtime dir, or `/tmp` if the temp dir's path leaves the socket's path no room). The directory is `0700` and the socket is `0600`. `serve` also checks that the peer's uid is its own, and removes the directory however it ends (stdin closed, even mid-request; SIGTERM, SIGHUP or SIGINT; a second signal doesn't cut that short). Only SIGKILL, or the interpreter dying, can leave it behind, so a starting `serve` removes this user's folders whose serve is gone (ticket 113): only real directories (a link is never followed or removed), only this user's, only holding what serve puts there, and only when no serve listens on the socket (so a pid from a container sharing `/tmp` isn't taken for dead). A folder from before this, with no pid in its name, goes once its socket is dead. Next to the socket is `askpass`, a `0700` two-line script that runs `<serve's python> -I -m roster.askpass`. `SSH_ASKPASS` has to be one absolute executable, because ssh runs it without a shell or your login PATH.
- `session.prepare` resolves the Login first, inside `serve`: the provider is set up, the vault answers, and the vault item exists, is the only match and has the password (or `#FIELD`). Whatever is wrong comes back as its own code before ssh starts: `31` provider not set up, `14` locked, `11` not logged in, `12` no CLI, `32` no such item, `33` several items, `34` no password or field, `35` the provider failed some other way. The password stays in `serve`'s memory; the result never holds it. Then it mints a random one-time token tied to that Host's ssh Login. The token is spent on first use (even if the lookup then fails), and it expires after 60 seconds or on `vault.lock`. Unlocking again doesn't bring it back, so open the Session again.
- The `env` to add to the ssh command:

  | Variable | Value |
  |---|---|
  | `SSH_ASKPASS` | absolute path of the `askpass` script |
  | `SSH_ASKPASS_REQUIRE` | `force`: use the helper even with a terminal and no `DISPLAY` (OpenSSH 8.4+; `DISPLAY` isn't needed) |
  | `ROSTER_ASKPASS_SOCKET` | the socket's path (on Windows, the pipe's name) |
  | `ROSTER_ASKPASS_TOKEN` | the one-time token |

- When ssh prompts, it runs `roster askpass PROMPT`. The helper answers only these prompts, compared whole and ignoring case and extra spaces: `user@host's password:`, `Password:`, `(user@host) Password:` and `Password for user@host:`. Every other prompt is refused: host-key `yes/no`, key passphrases, verification codes, and `New password:` / `(current) UNIX password:` from an expired-password change. The helper reports the prompt's text (never an answer) to `serve`, which logs it, doesn't spend the token, and gives back the reason. For an allowed prompt, the helper sends the token and prints the password to ssh. Whenever the helper doesn't print a password, it writes one line to the terminal (ssh's stderr) and exits 1, so ssh fails; with `NumberOfPasswordPrompts=1` ssh then stops with its own `Permission denied`. The line is what the app's classifier reads:

  ```text
  roster askpass: [CODE] REASON
  ```

  `CODE` is one of the codes below, and `REASON` is the same wording `session.prepare` gives for it:

  | Code | Line, for example |
  |---|---|
  | `36` | `roster askpass: [36] esx asked something roster won't answer: 'New password:' - log in by hand once to deal with it` |
  | `37` | `roster askpass: [37] the askpass token is used up, expired or cleared by a lock - open the Session again` |
  | `38` | `roster askpass: [38] can't reach roster serve (Connection refused)` |
  | `32`, `33`, `34`, `35`, `14`, ... | the vault item went away (or the vault was locked) between `session.prepare` and ssh's prompt, e.g. `roster askpass: [32] no vault item named 'esx ssh' (ssh Login of esx) - did you mean: 'esx root'` |
- `serve`'s stderr records each use (`askpass: esx: password handed to ssh`, `askpass: esx: refused an unexpected prompt: 'New password:'`, or why it refused), never the password.
- The protocol is one exchange per connection. The helper sends `TOKEN\n`, or `prompt TOKEN PROMPT\n` for a prompt it won't answer (the prompt on one line, at most 300 characters). `serve` replies `ok\nPASSWORD` or `no CODE\nREASON` and closes the connection. The logged-in script (ssh's LocalCommand for a Session whose password is held for "Save to vault") sends `login TOKEN\n`, and `serve` replies `ok\n` or `no\n`; it prints nothing and never fails the Session.
- `ROSTER_ASKPASS_TTL` (seconds, given to `serve`) can shorten the 60-second lifetime, for tests. It can't lengthen it.

### Filling a password prompt: `session.fill`

A Host Session can ask for a password again once it's logged in. When the user presses the fill key at sudo's prompt (ticket 119, decision Q129), the app's core asks serve which password answers it and types it into that Session's PTY. This is the one method whose result holds a secret: the core asks only for that key press, hands it to no one (not the frontend, a log or a Plugin; a Plugin's serve allow-list has no `session.*`), and types it only once it has checked that the prompt doesn't echo ([security.md](app/security.md#filling-a-password-prompt)).

<!-- BEGIN generated:methods session.fill -->

| Method | Params | Result | Errors | Since API |
|---|---|---|---|---|
| `session.fill` | `{host, address, port, user, prompt}` (exact Host name; what its Session connected to, from `session.prepare`'s `login`; the cursor's line) | `{host, login: "ssh"\|"sudo", password}` | `-32602`, `1`, `2`, `20`, `30`, `130`, `131`, `11`, `12`, `14`, `31`-`35` | 25 |
| `session.fill` | `{host, address, port, user, prompt, hop: {host, address, port, user}}` (a nested ssh in the Session: the Inventory Host the app resolved it to, from the command line the shell's marks gave, and the address, port and user it resolved; the Session's own Host is still checked as above) | `{host, login, password}` for the `hop` Host: its ssh Login for its own `USER@HOST's password:`, its sudo for sudo's; 130 if that Host isn't reviewed-and-unchanged as the app resolved it | `-32602`, `2`, `20`, `30`, `130`, `131` | 26 |

<!-- END generated:methods -->

`prompt` is the line at the Session's cursor, as the Host printed it, so it's the Host's word: it can narrow what's filled, never widen it, and only a prompt that is provably this Host's own is filled. `[sudo] password for USER:` with USER the Host's ssh user takes its `sudo: {auth: REF}` from `roster.yml` when it has one, else its ssh Login; `USER@HOST's password:` (a nested ssh) takes the ssh Login only for the ssh user at the Host's own name or address (never `localhost`, which a tunnel can point anywhere). A bare `Password:` or `Password for USER:` (su asks for root's, a login for anyone's) says nothing roster can check, so it's `130` like a prompt for another Host or account and anything that isn't a password prompt (a key's passphrase, a code); a Login with no saved password (`agent`, `key`, `none`, `prompt`) is `131`. `address`, `port` and `user` are what the Session connected to, from `session.prepare`'s `login` (API 25): when the Host has been edited since, serve refuses with `130`, since it may be another box now. The vault codes are `session.prepare`'s, naming the `sudo Login` when it's that one. serve's log names the method only.

**A nested ssh (API 26, ticket 120, decision Q131).** When the Session runs `ssh` to another Inventory Host and the shell's marks gave the command line, the app resolves where it went and sends it as `hop`: that Host's name and the address, port and user it resolved from the Inventory. serve still checks the Session's own Host as above, then that the `hop` Host exists (`2`), is reviewed (`20`) and still has that address, port and user (`130`: edited since the ssh started, it may be another box); the prompt is then judged against that Host as it would be for its own Session (its ssh Login for `USER@HOST's password:` at its own name or address, its sudo for sudo's prompt), and `host` in the result is that Host. The app sends `hop` only when it can prove where the ssh went; serve can't see the Session, so it judges only what it's told against the Inventory.

| Code | Meaning |
|---|---|
| `130` | `session.fill`: the prompt isn't one roster fills (not sudo's for the ssh user or ssh's for that user at this Host; a bare `Password:`), it asks for another Host or account, or the Host changed since the Session connected. `data.prompt`: `sudo`, `su`, `ssh` or `null`. Nothing was looked up |
| `131` | `session.fill`: the Login that would answer has no saved password (`auth: agent`, `key`, `none` or `prompt`); a `sudo: {auth}` in `roster.yml` gives a Host one for sudo's prompt |

## Diagnostics: `host.check`

<!-- BEGIN generated:methods host.check host.check_job -->

| Method | Params | Result | Errors | Since API |
|---|---|---|---|---|
| `host.check` | `{host, background?}` (exact Host name; `background` since API 21) | `{host, ok, steps: [{step, status, message, code?, fix?, details?, data?}, ...]}`; with `background: true` the job: `{kind: "check", job, action: "check", state, done, total, at, host, joined}`: `joined` (API 22) is true when it joined a check already running, which only its starter should stop | `-32602`, `4`, `5` | 2 |
| `host.check_job` | `{job}` (`check-N`) | `{kind: "check", job, action, state, done, total, at, host, error?, result?}`: `result` (once `state` is `done` or `stopped`) is `host.check`'s; a stopped check's later steps are `skipped` and `ok` is false | `-32602`, `49` | 21 |

<!-- END generated:methods -->

It runs the steps of [`roster check HOST`](cli-reference.md#roster-check-host) in order: `inventory`, `ssh-config`, `provider`, `vault-item`, `dns`, `tcp`, `host-key`, `auth`. Every step is in `steps`, in that order. `status` is `ok`, `fail` or `skipped`; after the first `fail`, every later step is `skipped` with no network touched, and a key Host's `provider` and `vault-item` are `skipped` too. A failed step has the `code` (from the tables below), roster's `message` naming the Host, the `fix` in a sentence and, where there is one, the raw text under `details` (ssh's stderr, the resolver's error). `data` carries what the code's row says: `near`, `matches`, `line`, or for `43` the `recorded` and `offered` SHA256 fingerprints. A whole check makes at most one TCP connection and one login attempt. The password login goes through `serve`'s askpass channel like a Session's. `host.check` itself only fails for bad params (`-32602`), or `4` when its job couldn't share the vault in time; a `roster.yml` that doesn't load is a failed `inventory` step.

Since API 21 a check is a job (kind `check`, one per Host at a time): it sends `job.progress` as each step starts (`done` of 8, `at` the step), and `vault.lock` stops it at its next step (the rest `skipped`, "the check was stopped", and `ok` false). The waiting form answers as it always did. `background: true` answers at once with the job, so no worker waits for the check; `host.check_job {job}` (a quick read) says where it is, with `result` once it's over. The app's core uses the background form when serve speaks API 21, and asks `host.check_job` until it's over. When it gives up on a check (past its 90 s) it stops it with `jobs.stop` only if it started it: the background answer's `joined` (API 22) says whether the ask joined a check already running. `host.check_job` finds a check that ended even after a newer check of its Host has started (serve keeps the last 32 a newer one replaced).

`api_version` is currently 26 (2 added `host.check` and codes 30-48; 3 added `vault.login`, `vault.status`'s `sign_in` and codes 50-59; 4 added `vault.create_item`, `vault.undo_create`, `can_write` and codes 60-63; 5 added `inventory.pull`, `host.verify_login`, `host.update`, `changes.diff`, `changes.discard` and codes 70-75; 6 added `host.scan_key`, `host.add`, `host.review` and codes 80-81; 7 added `changes.publish`, codes 90-96, `changes.diff`'s `message` and `groups`, and `data.details` on errors; 8 added the Live Inventory: `host.remove`, `host.rename`, `host.move`, `group.new`, `group.rename`, `group.delete`, `inventory.reload`, `inventory.watch`, the `inventory.changed` notification, `hosts.list`'s `error`, and codes 100-103; 9 added `host.review`'s `reviewed: false`; 10 added `vault.configure`, `vault.targets`, `save_to` on `vault.create_item` and `host.add`, `target` in their results, `vault.status`'s `save_to`, and codes 64-65; 11 made Sessions check host keys strictly: `session.prepare`'s `StrictHostKeyChecking=yes` and its `44`, `host.scan_key {host}`, `host.trust_key` and code `23`; 12 added Quick Connect: `quick.prepare`; 13 added "Save to vault" after a Session's login: `quick.prepare`'s `save` and `held`, `quick.save`, `vault.forget_typed`, the `session.logged_in` notification, and codes 66-67; for `auth: prompt` Hosts, `session.prepare`'s `password`, `save` and `held`, code 39 and `host.save_login`; 14 added `vault.logout`, `vault.status`'s `account` and `can_sign_out`, and codes 15-16; 15 added the Mesh: `mesh.*` and code 110; 16 added `box.check`; 17 added Mesh jobs: `background` on `mesh.plan`, `mesh.apply` and `mesh.cut`, `mesh.job`, `mesh.stop` and code 111; 18 added Discover: `discover.*` and codes 120-123; 19 added `mesh.status`'s `grouped`; 20 answers requests concurrently, in any order, with locks per resource: code 4, `jobs.list`, `jobs.stop`, the `job.progress` notification and `host.get`'s `settled`; 21 added `$/cancel` and code 5, `host.check`'s job (`background`, `host.check_job`, code 49), the unlock's own lane, `vault.status` waiting for an unlock sent before it, and Vault items made one at a time per vault; 22 added `host.check`'s `joined`, a cancelled check stopping only when nothing else waits for it, a check that's only stopping not counting as running, and a password Login's check sharing the vault only while it fetches a secret; 23 signs bw in on native Windows with a password or SSO (`vault.login` on a pseudoconsole, the `sso` step's `url` `null`); 24 added `mesh.cut`'s `warnings`; 25 added `session.fill`, roster.yml's `sudo:` and codes 130-131; 26 added `session.fill`'s `hop`, for a nested ssh to an Inventory Host). It goes up when a method or a result changes in a way the app has to know about. The app should refuse a roster whose `api_version` is too old.

Errors are JSON-RPC errors. The `code` is stable; the `message` uses roster's usual wording, names the Host, and is ready to show to a person. Where roster knows the fix, `data.fix` says it in a sentence. Ranges: 1-9 general, 10-19 the vault, 20-29 `session.*`, 30-39 a Host's Login and askpass, 40-49 the network and the Host (`host.check`), 50-59 signing the vault in (`vault.login`), 60-69 saving to the vault (`vault.create_item`, `quick.save`, `host.save_login`), 70-79 editing the Inventory, 80-89 adding a Host (`host.add`), 90-99 publishing (`changes.publish`), 100-109 the Live Inventory (removing, renaming and moving Hosts and groups). When roster has another program's raw words (git's, ssh's), `data.details` carries them. [`docs/app/errors.md`](app/errors.md) is the catalog the codes come from.

| Code | Meaning |
|---|---|
| `1` | The Inventory didn't load: no `roster.yml`, or it's invalid (including a Host with no user at all). Every method that needs it returns this, and `serve` keeps running. `data` has `path` (or `null`), `roster_version`, `api_version`, `fix`, and `line` for a YAML error. |
| `2` | Unknown host (`host.get`, `session.prepare`) |
| `3` | Any other refusal roster would print as `error: ...` on the command line |
| `4` | A lock this request needs (`roster.yml`, the vault) was held by another request past this one's wait: `data.busy` says which, `data.method` by what. Nothing was done; try again once it has finished (API 20, [Locks](#ordering-locks-and-jobs)) |
| `5` | `$/cancel` stopped the request before it did anything (it was queued, or waiting for a lock): "host.add was cancelled before it did anything". Nothing was done (API 21, [Cancelling](#ordering-locks-and-jobs)) |
| `20` | `session.prepare`: the Host isn't reviewed (`reviewed: false`); same message as `roster run` |
| `21` | `session.prepare`: this box can't run `ssh NAME` yet. Either there's no `ssh` on PATH, or the Host isn't in roster's ssh config (run `roster sync`, or `roster setup`) |
| `22` | `session.prepare`, `quick.prepare`: a password Session (or any Quick Connect), but the process has no askpass channel. Only seen when serve's code is used in-process, never from `roster serve` |
| `23` | `host.trust_key`, `quick.prepare`: the Host (or Quick Connect box) offers another key than the one the user was asked about; `data.asked` and `data.offered` are the two fingerprints. Nothing was recorded or started |
| `11`, `12`, `14` | `session.prepare` for a password-only Host whose vault isn't logged in, isn't installed, or is locked (see [Vault](#vault-the-lock-screen)) |
| `39` | `session.prepare`: the Host's ssh Login is `auth: prompt`, so the app asks for its password (`data.user`, `data.address`, `data.port`) and sends it back as `password` (API 13) |
| `30` | The Host's ssh user is discover's placeholder `CHANGE-ME`: "no SSH user for esx (user: CHANGE-ME in roster.yml)" |
| `31` | The Login's provider isn't set up on this box: "keeper's ssh Login uses 'keeper:', which isn't set up on this box". `data.provider` |
| `32` | No vault item by that name: "no vault item named 'esx shh' (ssh Login of esx) - did you mean: 'esx ssh'". `data.near` lists similar item names (names only) |
| `33` | Several vault items match: "2 vault items are named 'esx ssh' (ssh Login of esx): ...". `data.matches` is `[{name, revised, uris}]`: names, last-edited dates and URIs, never a value |
| `34` | The item has no password, or no such `#FIELD`: "vault item 'esx ssh' has no password (ssh Login of esx)". `data.field` |
| `35` | The provider failed some other way; the message is the provider's |
| `36` | askpass: the Host asked something roster won't answer (an expired password, an OTP); the prompt is in the message |
| `37` | askpass: the token is used up, expired or cleared by `vault.lock` |
| `38` | askpass: the helper couldn't reach `serve` |
| `40` | `host.check`: the address doesn't resolve |
| `41` | `host.check`: the ssh port refused the connection |
| `42` | `host.check`: no answer in time. For 10.19.x the fix mentions the rate limiter (wait a few minutes) |
| `43` | `host.check`: the Host's key isn't the recorded one. Never accepted automatically |
| `44` | `host.check`, `session.prepare`: no recorded host key for the Host. From `session.prepare`, `data` has its `address` and `port`, for the app to ask about the key |
| `45` | `host.check`: the Host refused the password for that user |
| `46` | `host.check`: the Host refused this box's key |
| `47` | `host.check`: the Host cut the connection after too many key attempts. roster's ssh config sets `IdentitiesOnly yes` for key and password Hosts (and `PubkeyAuthentication no` for password Hosts) so the agent's keys can't use up the Host's tries; an older config fails the `ssh-config` step instead |
| `48` | `host.check`: the login failed some other way; `details` has ssh's message |
| `49` | `host.check_job`: no check by that id in this serve (or a newer check of its Host replaced it) (API 21) |
| `50`-`59` | `vault.login`: see [Signing in](#signing-in-vaultlogin) |
| `70` | `roster.yml` isn't committed in a git repo (or git isn't installed), so it has no Pending changes |
| `71` | `inventory.pull`: uncommitted changes, Pending changes or other files (`data.files`) |
| `72` | `inventory.pull`: this box's branch and its upstream have diverged (`data.ahead`, `data.behind`) |
| `73` | `inventory.pull`: the fetch or the fast-forward failed; `details` has git's message |
| `74` | `host.update`: the result wouldn't load, loads differently than asked, or changes another entry; nothing written |
| `75` | `host.update`: the address, user or Login changed without a `host.verify_login` of those values that just succeeded |
| `80` | `host.add`: a bad name, group, address, user or port, or no user to log in as (none given, none inherited). `data.field` names it; the message is roster's (`bad host name 'a b' (use letters, digits, . _ -)`) |
| `81` | `host.add`: a Host by that name is already in the Inventory: "host 'esx' is already in the Inventory (group lab)". `data.group` |
| `90` | `changes.publish`: no Pending changes, nothing to publish |
| `91` | `changes.publish`: other files in the infra repo are uncommitted too (`data.files`); nothing published |
| `92` | `changes.publish`: someone published `roster.yml` to the upstream since this box pulled (`data.behind`); nothing published |
| `93` | `changes.publish`: this box has commits of its own that aren't on the upstream (`data.ahead`); roster pushes only its own |
| `94` | `changes.publish`: the branch has no upstream to push to |
| `95` | `changes.publish`: git refused the commit (no identity, a hook); `details` has git's message; the Pending changes are kept |
| `96` | `changes.publish`: the push failed or was rejected (`data.rejected`: the upstream moved meanwhile); the commit is undone, the Pending changes are kept |
| `100` | `host.rename`, `group.new`, `group.rename`: that name is already a Host's or a group's (`data.kind`, `data.group`) |
| `101` | No group by that name in `roster.yml` (`data.group`); the message lists the groups |
| `102` | `group.delete`: the group still has Hosts and no `to` says where they go (`data.hosts`) |
| `103` | `host.move`, `group.delete`: the Host would come out different in its new group (a service or Login it inherits there that roster can't write on the Host); `data.fields` |
| `-32700` | Not valid JSON |
| `-32600` | Not a JSON-RPC 2.0 request object (batches aren't supported) |
| `-32601` | Unknown method |
| `-32602` | Bad params, e.g. `host.get` without a `name` |
| `-32603` | Unexpected failure inside roster; details go to stderr |

Requests without an `id` (notifications) run but get no reply. `serve` sends three notifications of its own: `inventory.changed` (see [The Live Inventory](#the-live-inventory-hosts-and-groups-and-outside-edits)), only after `inventory.watch`; `session.logged_in` (see Quick Connect's "Save to vault"), only for a Session that holds a typed password to save; and `job.progress` (API 20, see [Jobs](#ordering-locks-and-jobs)), for each job.

## This Box's health: `box.check`

<!-- BEGIN generated:methods box.check -->

| Method | Params | Result | Errors | Since API |
|---|---|---|---|---|
| `box.check` | none | `{checks: [{section, level, message, fix?, topic?}, ...], ok, roster_version, api_version}` |  | 16 |

<!-- END generated:methods -->

The checks of [`roster check --box`](cli-reference.md#roster-check---box), in section order: `roster`, `inventory`, `ssh`, `vault`, `askpass`, `repo` (a newer roster may add sections; the app shows one it doesn't know under its id). `level` is `ok`, `warn` or `error`; `fix` says what to do in a sentence; `topic` is a `:help` topic that explains it (an error catalog row such as `E6`, or a command such as `:publish`). `ok` is false when any check is an `error`. Every check is local: files, `PATH`, each vault CLI's own status, the infra repo's git with no fetch. Nothing logs in to a Host or touches the network. It reads `roster.yml` as it is now without applying it, so a file that doesn't load is an `inventory` error while `hosts.list` still answers with the last good Inventory. `askpass` says whether this `serve`'s askpass channel is open. No check carries a secret: Logins are counted by provider, never looked up. `box.check` never fails; with no `roster.yml`, the `inventory` check says so.

## Editing: Pending changes

A Pending change is an edit to `roster.yml` made on this box and not Published yet: `roster.yml`'s uncommitted diff in the infra repo (a git clone). These methods need `roster.yml` committed in a git repo (`70` otherwise). Publishing commits and pushes them (`changes.publish`).

<!-- BEGIN generated:methods inventory.pull host.verify_login host.update changes.diff changes.discard changes.publish -->

| Method | Params | Result | Errors | Since API |
|---|---|---|---|---|
| `inventory.pull` | none | `{updated, upstream, commits, ahead, from?, to?, message?}`: the repo fast-forwarded to its upstream (`upstream: null` when the branch has none: nothing to pull). Refuses uncommitted changes (`71`, `data.files`) and a diverged branch (`72`, `data.ahead`/`behind`); a failed fetch is `73`. Never merges, rebases or stashes | `70`-`73` | 5 |
| `host.verify_login` | `{host, changes}` | `{host, ok, steps}` like `host.check`, with steps `user`, `provider`, `vault-item`, `dns`, `tcp`, `host-key`, `auth`, run against the Host as `changes` would leave it | `2` | 5 |
| `host.update` | `{host, changes}` | `{changed, host, backup, warnings}`: the edit written into `roster.yml`, `host` as it loads now, `backup` the file as it was, `warnings` what failed after the write (recording a moved Host's key) | `2`, `70`, `74`, `75` | 5 |
| `changes.diff` | none | `{path, repo, diff, hosts: [{host, change: changed\|added\|removed, fields}], groups: [{group, change}], count, message, last_commit}`: git's diff of `roster.yml` against the last commit, the commit message `changes.publish` would write, and `last_commit: {commit, subject, upstream, pushed}` (the branch's last commit, and whether its upstream has it as this box last fetched) | `70` | 5 |
| `changes.discard` | none | `{discarded, backup}`: `roster.yml` back as the last commit has it (index and working tree) | `70` | 5 |
| `changes.publish` | `{message?}` | `{commit, upstream, message, hosts, groups: [{group, change}], pulled, sync: {ok, error?, fix?}}`: commits `roster.yml` alone and pushes it to the branch's upstream, then runs `roster sync` | `1`, `70`, `73`, `90`-`96` | 7 |

<!-- END generated:methods -->

`changes` is `{field: value}` with fields `title`, `description`, `type` (text, one line), `ip`, `user`, `auth` (strings) and `port` (a number). `host.update` edits `roster.yml` as text, like `discover --write`: only the changed values' text changes, so comments, order, quoting and every other entry stay byte for byte. `user`, `port` and `auth` go into the Host's `ssh:` block if it has one; a short `name: 10.0.0.1` entry grows into a block when it needs more than its address. The result must load, must load to exactly the values asked for, and must leave every other Host, group and resource as it was (`74` otherwise, nothing written). What it replaced is kept as `roster.yml.bak` in the repo's git dir (`.git/roster/`), never in the working tree. Every write and pull loads `roster.yml` again, so `hosts.list` shows the file as it now is.

**Publishing (ticket 12, decision Q13).** `changes.publish` refuses when there's nothing pending (`90`), when another file in the infra repo is uncommitted (`91`; `folders.yml` and anything personal never go in), and when `roster.yml` doesn't load (`1`). It fetches first (`73` if that fails). New upstream commits that leave `roster.yml` alone are fast-forwarded over (`pulled` counts them); if someone else published `roster.yml` meanwhile (`92`) or this box has commits of its own (`93`), it stops. It commits `roster.yml` only, with `message` if given, else one naming every Host and group that changed (`roster: change esx (title), add web-01`; past 72 characters the subject gives the counts and the body lists them). The author is whatever git identity the infra repo has; roster never sets one. It pushes `HEAD` to the upstream branch, never forced; a rejected or failed push (`96`) undoes the commit, so the Pending changes stay as they were. A push that doesn't finish within 60 s is stopped (its whole process group), and roster fetches to see whether it got there anyway: if the upstream has the commit, it's a Publish like any other; if not, the commit is undone (`96`, `data.timed_out`, `data.landed: false`); if even that fetch fails, the commit is undone too and the error says roster couldn't tell (`data.landed: null`), with how to check. Then it runs `roster sync` (ssh config and the Claude files); a failed sync doesn't undo the Publish and shows in `sync`.

**Verified changes (decision Q43).** A change to `ip`, `port`, `user` or `auth` is refused (`75`) unless `host.verify_login` with exactly those values succeeded in the last 10 minutes; the success is used up by the save. The test login makes one TCP connection and one login attempt (a password Login is looked up from the vault into roster's memory; a key Host uses this box's roster key, except when the change is to its Login: a new `auth` is always tested with itself, its vault item found, unique and with a password, and that password used for the login, because the key says nothing about it). The host key must match one recorded in `~/.ssh/roster_known_hosts`, for the new address or, for a Host that moved, its current one; it's never accepted. For a Host that moved, the key it was verified with is recorded for the new address once `host.update` has written the edit (and only then), so its first Session there finds it instead of trusting whatever answers; a failure to record it is in `host.update`'s `warnings`. A Host with no stored Login (`auth: prompt`, `agent`, `none`) gets every step but the login.

## Adding a Host: `host.add`

The key a new address offers comes from `host.scan_key {address, port?}` (its second row under [Host keys](#sessions-sessionprepare)), for the user to confirm before the first login.

<!-- BEGIN generated:methods host.add host.review -->

| Method | Params | Result | Errors | Since API |
|---|---|---|---|---|
| `host.add` | `{name, group, address, user?, port?, type?, title?, description?, enroll?, auth? \| password + item?, host_key?, provider?, save_to?}` | `{added: true, host, backup, verify, item, warnings}`: `host` as `roster.yml` has it now, `verify` the test login (`{host, ok, steps}`, or `null` without a Login), `item` the Vault item it made (`{provider, id, name, target}`, or `null`) | `80`, `81`, `74`, `61`, `11`, `12`, `14`, `30`-`35`, `40`-`48`, `60`, `62`, `64`, `65` | 6 |
| `host.review` | `{host, reviewed?}` | `{changed, host, backup}`: `reviewed: true` set on that Host and nothing else (`changed: false` if it already was). `reviewed: false` (API 9) un-reviews it, for a review made by mistake: where the Host's own `reviewed: true` sits over an unreviewed group or defaults, its line is taken out again, so the text goes back to what it was | `2`, `70`, `74` | 6 |

<!-- END generated:methods -->

`host.add` writes the Host into `roster.yml` as text at the end of its group (or in a new group after the last one), like `host.update`: comments and every other entry stay byte for byte, a group of one-line `{ip: ...}` entries gets one more, and only what the Host doesn't inherit from its group or `defaults:` is written. The result must load with exactly the values asked for and nothing else changed (`74` otherwise). It's a Pending change, with the backup in `.git/roster/`.

**Verified adds (decision Q43).** A Host with a Login gets one test login before anything is written. The Login is either `auth`, an existing vault reference (`bw:esx-02 ssh`, looked up into roster's memory), or `password`, typed into the form, with `item` the Vault item to save it as (default `<name> ssh`, see [docs/adding-hosts.md](adding-hosts.md)) in `provider` (default: the one `vault.status` names) and `save_to` (where in it; default: the setting, see `vault.create_item`). In order:

1. The name, group and user are checked and the add is tried as text (`80`, `81`, `74`), before the network. For a typed password, the provider must be able to save (`61`) and be unlocked (`14`, `11`, `12`).
2. The test login, as `host.verify_login`'s steps (`user`, `provider`, `vault-item`, `dns`, `tcp`, `host-key`, `auth`): one connection and one attempt with the password, even for `enroll: true` (this Box's key isn't on the new Host yet). The host key must be the recorded one for the address, or, for an address with none, the `host_key` fingerprint the user confirmed after `host.scan_key`. Without either it's `44`; a different key is `43`, and no login is tried. A failed step is the error: its own code (`40`-`48`, `30`-`35`), the message "esx-02 wasn't added: ... - nothing was saved", and `data.step` and `data.steps`.
3. For a typed password, the Vault item (`vault.create_item`'s rules: `60` if the name is taken, `62` if the vault refuses, `64`/`65` for a `save_to` that isn't there or is read-only). The password then leaves roster's memory.
4. The Host, written into `roster.yml` with `reviewed: true`. If this fails in any way (an edit that wouldn't load, a full disk, an unwritable `.git/roster/`), the Vault item from step 3 is deleted again: the error says "the vault item 'esx-02 ssh' was taken back out" and has `data.undone`, or, if even that fails, `data.left` with the item to delete by hand.
5. A host key confirmed with `host_key` is recorded in `~/.ssh/roster_known_hosts`, so Sessions and later test logins find it. The Host is already written by now, so a failure here doesn't undo the add: it succeeds with the failure in `warnings` (a list of sentences, empty when all went well).

The typed password is never in a response, an error, stderr, `roster.yml` or the Pending change; only the item's name is. A Host **without** a Login (no `auth`, no `password`, and none inherited) is added `reviewed: false` with no network at all, as `discover` adds Hosts; `host.review` (or `reviewed: true` by hand) lets it be opened.

## The Live Inventory: Hosts and groups, and outside edits

Removing, renaming and moving Hosts and adding, renaming and deleting groups (ticket 28, decision Q45). Each is a text edit of `roster.yml` like `host.update`: only the entry's own lines change (from its key's line through its value's last line, comments on those lines included), every other byte stays, and the result must load to exactly what was asked, with nothing else changed (`74` otherwise, nothing written). Each is a Pending change with the backup in `.git/roster/`. A `roster.yml` that doesn't load right now refuses them with `1` and its line. A bad name is `80`, an unknown Host `2`.

<!-- BEGIN generated:methods host.remove host.rename host.move group.new group.rename group.delete inventory.reload inventory.watch -->

| Method | Params | Result | Errors | Since API |
|---|---|---|---|---|
| `host.remove` | `{host}` | `{removed, group, backup}`: the Host's entry taken out, and every `links:` entry that names it. Its group stays, even empty. **Never touches the vault**: its vault item, if any, stays | `1`, `2`, `70`, `74` | 8 |
| `host.rename` | `{host, to}` | `{changed, host, backup}`: only its key changes, and its name in `links:`. Its vault item keeps its name. `100` if `to` is taken | `1`, `2`, `70`, `74`, `80`, `100` | 8 |
| `host.move` | `{host, group}` | `{changed, host, pinned, backup}`: its lines cut and added at the end of `group`'s `hosts:`, re-indented. What it inherited from its old group (user, port, Login, `enroll`, `reviewed`, `mesh`, `type`, …) and wouldn't from the new one is written on the Host (`pinned` names those fields), so it stays the same Host; a Host with no `mesh:` anywhere takes the new group's. `101` no such group, `103` if it would still come out different | `1`, `2`, `70`, `74`, `101`, `103` | 8 |
| `group.new` | `{name, title?}` | `{group, backup}`: `NAME:` with `hosts: {}` (and its `title:`) after the last group. `100` if taken | `1`, `70`, `74`, `80`, `100` | 8 |
| `group.rename` | `{group, to}` | `{changed, group, backup}`: only its key changes, and its name in `links:`; its Hosts follow. `100` if taken | `1`, `70`, `74`, `80`, `100`, `101` | 8 |
| `group.delete` | `{group, to?}` | `{deleted, moved, to, backup}`: the group's entry taken out, and every `links:` entry that names it. A group that still has Hosts is refused (`102`, `data.hosts`) unless `to` names the group they move to first (as `host.move` moves them) | `1`, `70`, `74`, `101`-`103` | 8 |
| `inventory.reload` | none | `{changed, host_count, error}`: `:source` for `roster.yml`, read again now |  | 8 |
| `inventory.watch` | `{auto}` | `{watching, auto, path?}`: start noticing outside edits of `roster.yml`; `auto` (the app's `auto_reload`) applies them |  | 8 |

<!-- END generated:methods -->

**Reloading is Neovim-style (decision Q58).** An edit made outside the app (in vim, a `git pull` in a terminal) isn't applied by itself unless the app asked for it with `inventory.watch {auto: true}`. `serve` looks at `roster.yml` every 0.2 s (its size, time and inode, so an editor that saves by renaming a new file over it counts too); a change that has settled and differs from what `serve` last loaded (its own writes don't count) is sent as a JSON-RPC notification, a message with no `id`:

```json
{"jsonrpc": "2.0", "method": "inventory.changed", "params": {"applied": true, "error": null}}
```

With `auto`, `applied` is `true`: `serve` loaded it, within a second of the save. Without, `applied` is `false` and the edit waits for `inventory.reload` (`:source`); it's reported once. **A file that doesn't load keeps the last good Inventory**: `hosts.list` keeps answering with it, plus `error: {message, path, line?, fix}` (catalog row 1), and so do the notification and `inventory.reload`. It recovers by itself once the file loads again. `hosts.list`'s `error` is `null` while the file loads.

## Vault: the lock screen

`serve` starts locked, and only `vault.unlock` unlocks it. At startup it drops any `BW_PASSWORD` and `BW_SESSION` it inherited, and providers stop unlocking by themselves: no bw-session file, no `BW_PASSWORD`, no prompt. The master password goes to the provider in an environment variable, never on a command line. The session key stays in `serve`'s memory and is never written to the bw-session file. Neither ever appears in a response or on stderr.

<!-- BEGIN generated:methods vault.status vault.unlock vault.lock -->

| Method | Params | Result | Errors | Since API |
|---|---|---|---|---|
| `vault.status` | none | `{provider, status, message?, sign_in?, account?, can_sign_out, save_to?, providers: [{provider, status, message?, sign_in?, account?, can_sign_out}, ...]}` |  | 1 |
| `vault.unlock` | `{password, provider?}` | `{provider, status: "unlocked"}` | `10`-`13` | 1 |
| `vault.lock` | none | `{locked: [names]}`. Never fails |  | 1 |

<!-- END generated:methods -->

- `vault.status`: `providers` lists every provider the Host Logins use (ssh and services), sorted by name. `provider` and `status` describe the vault the lock screen unlocks: the most used of those providers that takes a master password (`bw` or `kp`). If none does, `provider` is `null` and `status` is `unsupported`.
- `status` is one of:
  - `locked`
  - `unlocked`
  - `not-logged-in`: the CLI isn't logged in on this box (KeePassXC: no database set in `providers: kp:` or init.lua's `vault.kp`, or the file isn't there)
  - `missing-cli`: the CLI isn't installed
  - `unsupported`: no master password, e.g. `env` or `prompt`

  For `not-logged-in` and `missing-cli`, `message` says what to run or install. For `not-logged-in`, a provider the app can sign in (`bw`) also has `sign_in: {methods: ["password", "apikey", "sso"], server}`, where `server` is what `bw config server` is set to (`null`: bitwarden.com). See `vault.login` below.
- `account` (API 14, `locked` or `unlocked`, when the CLI says): the account the CLI is signed in to, `{email, server}`, `server` being what `bw config server` is set to (`null`: bitwarden.com). The lock screen names it in "Use a different account". Taken from the same `bw status` as `status`: no extra call.
- `can_sign_out` (API 14): whether `vault.logout` can sign this provider's CLI out (`bw` only; KeePassXC, `pass`, `env` and `cmd` have no account).
- `save_to` (when `provider` can save): where "Save to vault" goes by default, as set and not looked up (no vault call): `{setting, from}`, `from` being `init.lua`, `roster.yml` or `default` (the personal vault).
- `vault.unlock` unlocks `provider`, or by default the one `vault.status` names. For KeePassXC that's one `keepassxc-cli ls` with the master password (and the key file, if set) to check it; `serve` then holds the password in memory, since `keepassxc-cli` has no session.
- `vault.lock` forgets every cached secret, session key, held master password and askpass token, then runs the provider's own lock (`bw lock`; KeePassXC has nothing to run). It locks the providers `vault.unlock` opened and those the Inventory uses. `locked` names the ones that have a lock of their own. It never fails; if a provider's lock fails, a warning goes to stderr. After it, any lookup reports code `14` until the next `vault.unlock`.

| Code | Meaning |
|---|---|
| `10` | Wrong master password: `Bitwarden unlock failed (wrong master password?)`, `KeePassXC unlock failed (wrong master password or key file?)` |
| `11` | The vault CLI isn't logged in on this box. The message says what to run, e.g. ``Bitwarden CLI isn't logged in on this box - run `bw login` once``. For KeePassXC: no database set, the database or the key file isn't there (`KeePassXC database /home/you/roster.kdbx isn't there - ...`) |
| `12` | The vault CLI isn't installed: `` `bw` is not installed on this box (...) ``, `` `keepassxc-cli` is not installed on this box (...) `` |
| `13` | The provider has no master password, or no Host Login uses one |
| `14` | A secret was needed but the vault is locked: `Bitwarden vault is locked - unlock it first`, `KeePassXC database is locked - unlock it first` |
| `15`, `16` | `vault.logout`: already signed out, or `bw logout` failed (see [Signing out](#signing-out-vaultlogout)) |

## This Box's settings: `vault.configure`

The app sends what its `init.lua` says about the vault at start, before `vault.status`, and again after every `:source` ([docs/app/config.md](app/config.md#the-vault)). These are this Box's own settings, and they win over `roster.yml`'s `providers:`, which are the team's.

<!-- BEGIN generated:methods vault.configure -->

| Method | Params | Result | Errors | Since API |
|---|---|---|---|---|
| `vault.configure` | `{save_to?, kp?: {database?, key_file?}}` | `{configured: true, locked: [names], refused: [{setting, message}]}` | `-32602` | 10 |

<!-- END generated:methods -->

- Each call replaces the last one. A setting it leaves out (or `{}`) goes back to `roster.yml`'s. `serve` keeps them across `roster.yml` reloads.
- Paths and choices only, never a secret: a key that isn't listed here refuses the whole call (`-32602`), so nothing else can ride along. A value roster can't use (a path that isn't absolute or `~/…`, such as a Windows path; a `save_to` of the wrong shape) is left out on its own, as if `init.lua` didn't set it, and named in `refused` (`setting` is `kp.key_file`, `save_to`; `message` says why); the other settings still apply. A path is on the Box `roster serve` runs on (inside WSL for a WSL Backend).
- `save_to` is where "Save to vault" goes by default on this Box (ticket 35), the same shape as `roster.yml`'s: `"personal"` goes to every provider, a collection to Bitwarden, a group to KeePassXC.
- `kp.database` and `kp.key_file` are KeePassXC's (ticket 41). When one changes, the master password `serve` held for the old database is forgotten, along with every cached value: `locked` names the providers that were unlocked and aren't now, so the app shows its lock screen again. A database that isn't there is `vault.status`'s `not-logged-in`, and the message names `vault.kp.database in init.lua`.

## Signing in: `vault.login`

A new Box's vault CLI isn't logged in (`vault.status`: `not-logged-in`). `vault.login` signs it in from the app, a step at a time, and leaves the vault unlocked. [`docs/app/dev/vault-auth.md`](app/dev/vault-auth.md) has the research: which methods each CLI can do, and why it works this way.

<!-- BEGIN generated:methods vault.login -->

| Method | Params | Result | Errors | Since API |
|---|---|---|---|---|
| `vault.login` | `{action: "start", method: "password", email, password, server?, provider?}` | the first step | `10`, `12`, `13`, `51`-`54`, `57`, `59` | 3 |
| `vault.login` | `{action: "start", method: "apikey", client_id, client_secret, server?}` | `master_password` | `12`, `13`, `52`-`54`, `57`-`59` | 3 |
| `vault.login` | `{action: "start", method: "sso", identifier?, server?}` | `sso` | `12`, `13`, `51`, `53`, `54`, `56`, `57`, `59` | 3 |
| `vault.login` | `{action: "answer", login, ...the step's answer}` | the next step | `10`, `50`-`53`, `55`, `56`, `59` | 3 |
| `vault.login` | `{action: "cancel"}` | `{cancelled: true \| false}` |  | 3 |

<!-- END generated:methods -->

`action` defaults to `start`. `server` is `cloud` (bitwarden.com), `eu` (`https://vault.bitwarden.eu`), or a self-hosted `https://` URL. Leave it out to keep what `bw config server` says; roster only runs `bw config server` when that changes. A `start` ends any sign-in in progress, and so do `cancel`, `vault.lock`, and 10 minutes without an answer. Every result has `step` and `login`, the sign-in's id, which `answer` sends back:

| `step` | Also has | Answer with |
|---|---|---|
| `two_factor_method` | `methods: [{index, id, kind, name}]` in bw's order. `kind` is `authenticator`, `email`, `yubikey` or `other`; `id` is bw's method number (0, 1, 3). FIDO2 and Duo never appear: the CLI can't do them | `{method: index}` |
| `two_factor_code` | `method` (as above, or `null` when the account has one method and bw picked it), `sent: true` when bw has just emailed the code | `{code}` |
| `new_device_code` | `email`: Bitwarden emailed a one-time code because this Box is new | `{code}` |
| `sso` | `url` to open in a browser (roster opens it on the Box too: `wslview`, `explorer.exe` on WSL, else `xdg-open`), `expires_in` seconds (5 minutes). On native Windows `url` is `null` (API 23): bw opens the page in the default browser itself, with PowerShell's `Start` by its full path, which roster can't stand in for, so there's no link to hand over; roster knows bw opened it when Windows' TCP table shows bw listening on its callback port (`8065`-`8070`); it never binds or connects to the port | `{}`: waits up to 20 s for the browser, then answers `sso` again (with the time left) or the next step |
| `master_password` | after an API key or SSO, which only log in: the vault still needs the master password | `{password}` |
| `done` | `provider`, `status: "unlocked"` | |

How it works, and what never happens to a secret:
- `bw login` can't take a new-device code from a flag, and it's one-shot. So the password and SSO flows run `bw login` on a PTY and type at bw's own prompts. The bw process lives between calls. On native Windows the terminal is a pseudoconsole (ConPTY, API 23; before, those two flows answered `59` there), with bw and everything it starts in a job object that ends them with the sign-in; bw's stdout is that console too, so `--raw`'s session key is the last line it shows.
- The master password goes to bw in an environment variable (`--passwordenv`). The API key goes in `BW_CLIENTID` and `BW_CLIENTSECRET`. The email and every code are typed at bw's prompts. None of them is ever in a command line (`--code` and a positional password are never used), and none ever appears in a response or on stderr. An error quotes bw's own words with every value the person typed cut out.
- A wrong code ends the bw process. roster holds the master password in memory for the sign-in's life, so it runs bw again itself and answers code `50`, with `data.step` set to the step to show next. The person types only a new code. For Email and new-device codes, that sends a fresh one, and the message says so.
- A failure with `data.step` (`50`, and `10` at `master_password`) keeps the sign-in going: show that step again. Any other failure ends it.

| Code | Meaning |
|---|---|
| `10` | The email or master password wasn't accepted: "Bitwarden didn't accept that email and master password (on bitwarden.com)". At the `master_password` step, the usual unlock message, with `data.step` |
| `12` | `bw` isn't installed |
| `13` | The provider has no sign-in roster can drive. For `op`: "1Password signs in through its desktop app, not here: turn on ... "Integrate with 1Password CLI" ..., or set OP_SERVICE_ACCOUNT_TOKEN for a service account" |
| `50` | The two-step or new-device code was wrong or expired (the server doesn't tell those apart). `data.step` and `data.login`: carry on there |
| `51` | The CLI can't do the account's two-step method, which happens when FIDO2 and Duo are its only methods: "... sign in with an API key instead, or add an authenticator app, email or YubiKey OTP as a second method in the web vault". Also SSO for accounts with trusted-device or passkey (PRF) decryption, in bw's words |
| `52` | The server refused: too many attempts. Wait a few minutes |
| `53` | The server didn't answer (DNS, refused, TLS, no answer in 40 s): "can't reach the Bitwarden server vault.example.com (...)" |
| `54` | The CLI is already logged in on this box, so unlock instead. To switch account, `vault.logout` first (API 14) |
| `55` | No sign-in in progress: finished, cancelled, replaced by a newer `start`, or 10 minutes without an answer |
| `56` | SSO failed in the browser, or wasn't finished within 5 minutes |
| `57` | `server` isn't `cloud`, `eu` or an `http(s)://` URL |
| `58` | The API key wasn't accepted, or it's an organization key (the CLI takes only personal ones) |
| `59` | The sign-in failed some other way; the message has bw's words |

`ROSTER_SSO_TIMEOUT` (seconds, given to `serve`) can shorten the 5-minute SSO wait, for tests, and `ROSTER_NO_BROWSER=1` stops roster from opening the link on the Box.

## Signing out: `vault.logout`

The Bitwarden CLI holds one account at a time, so signing in to another one means signing this one out first (ticket 42, API 14). The app asks first, naming the account (`vault.status`'s `account`).

<!-- BEGIN generated:methods vault.logout -->

| Method | Params | Result | Errors | Since API |
|---|---|---|---|---|
| `vault.logout` | `{provider?}` | `{provider, status: "not-logged-in", message?, sign_in, can_write, can_sign_out, signed_out: {email, server} \| null}` | `13`, `15`, `16` | 14 |

<!-- END generated:methods -->

- `provider` defaults to the one `vault.status` names. It works locked or unlocked.
- Everything `vault.lock` forgets is forgotten **before** the CLI logs out: askpass tokens (spent or not), typed passwords held for "Save to vault", every cached value, a sign-in in progress, the session key and KeePassXC's held master password, for every provider. Then it runs `bw logout` (no `bw lock` first: logging out ends the session anyway). `bw logout` removes the account and the CLI's local copy of the vault; the server setting stays.
- The result is where the vault stands now, as `vault.status` would describe it (`sign_in` included, so the app can show the full sign-in form straight away), plus `signed_out`: the account it was, or `null` if `bw status` didn't name one. It takes one `bw status`, before the logout, and builds the result from it (the server setting survives the logout), so signing out costs two `bw` calls, not four.
- Nothing secret is in a command line, a response or the log.

| Code | Meaning |
|---|---|
| `13` | The provider has no account to sign out of; roster doesn't try. KeePassXC: "KeePassXC has no account to sign out of: it opens a local database file. To use another one, change vault.kp.database in init.lua"; `env`, `cmd`: "provider 'env' has no account to sign out of - its Logins come from this box itself". Nothing was forgotten |
| `15` | The CLI isn't signed in, so there's no account to sign out of: "the Bitwarden CLI isn't signed in on this box - there's no account to sign out of". `data.fix`: sign in from the lock screen. Everything was forgotten anyway |
| `16` | `bw logout` failed some other way; the message has bw's words. `data.fix`: see the message; `roster bw logout` in a terminal shows the same. Everything was forgotten anyway |

## Saving to the vault: `vault.create_item`

"Save to vault" (the add-Host form, Quick Connect) creates the Vault item a new Login points at. The order is: verify the login, create the Vault item, then add the Pending change. If that last step fails, `vault.undo_create` takes the item back out, so nothing stray is left.

<!-- BEGIN generated:methods vault.create_item vault.undo_create vault.targets -->

| Method | Params | Result | Errors | Since API |
|---|---|---|---|---|
| `vault.create_item` | `{name, password, username?, uri?, provider?, save_to?}` | `{provider, id, name, target}` | `14`, `60`-`62`, `64`, `65` | 4 |
| `vault.undo_create` | `{id}` (from `vault.create_item`) | `{provider, id}` | `14`, `62`, `63` | 4 |
| `vault.targets` | `{provider?}` | `{provider, targets: [{id, kind, label, organization?, collection?, save_to}], default, from, problem}` | `14` | 10 |

<!-- END generated:methods -->

- `vault.create_item` makes a login item: `name` (`<host> <what it opens>`, [docs/adding-hosts.md](adding-hosts.md)), `username` in its username field, the password, and the address in its URI field (`uri`, e.g. `ssh://10.0.0.5`). `provider` defaults to the one `vault.status` names. It runs `bw sync` first, then refuses a name an item already has exactly (code `60`), because Logins look items up by exact name. A longer name, like `esx ssh+web` next to `esx ssh`, is a different item.
- Only providers whose `can_write` is `true` in `vault.status` (`bw` and `kp`) can save. Every other provider answers `61`.
- **Where it goes** (ticket 35): `save_to` is `"personal"`, `{organization, collection}` (Bitwarden; names or ids) or `{group}` (KeePassXC); any other shape is `-32602`. Left out, it's the setting: `init.lua`'s `vault.save_to` (through `vault.configure`), else `roster.yml`'s `providers: NAME: save_to:` (KeePassXC: also its `group:`), else the personal vault. `target` in the result is where it went: `{id, kind, label, organization?, collection?}`.
- **Bitwarden collections:** roster looks the names up with `bw list organizations` (only ones you're confirmed in) and `bw list collections`, and puts `organizationId` and `collectionIds` in the item, which `bw create item` (2026.9.1) creates right there: no `bw move` or `bw share`. A name that matches nothing, or several, is `64`, and the message names the setting (`providers: bw: save_to: organization: in roster.yml`, `vault.save_to.collection in init.lua`, `save_to.collection` for a choice). bw's CLI doesn't say which collections you may only read, so roster checks the new item: one that came back outside the collection was refused it, and is deleted again (`65`; if even that fails, the message says to delete it by hand). That collection is then left out of `vault.targets` until the vault is locked.
- `vault.targets` lists where the vault can save, in the provider's order: Bitwarden's personal vault and every collection of the organizations you're confirmed in; KeePassXC's top level and every group outside the recycle bin. `default` is the id of the setting's target and `from` where it's set (`init.lua`, `roster.yml`, or `null` for the built-in personal vault). A setting that doesn't resolve doesn't fail the list: `default` is `null` and `problem` is `{code, message, fix}` (64 or 65). It needs the vault unlocked (`14`).
- **KeePassXC:** the entry goes into the `group` set under `providers: kp:` (default: the top level), with the username and the URL field. Its title must not be any entry's title already, in any group outside the recycle bin (`60`), because `kp:TITLE` looks titles up across groups; a title with `/` is `62`. `keepassxc-cli add -p` reads the master password and then the entry's password from its stdin. The `id` is the entry's path (`Hosts/esx-02 ssh`). `vault.undo_create` runs `keepassxc-cli rm`, which moves it to the recycle bin (or deletes it, in a database without one). A timed-out `add` is checked the same way as Bitwarden's.
- The password goes to `bw create item` as base64 JSON on its stdin (what `bw encode` makes; bw 2026.9.1 reads stdin when no argument is given). It is never on a command line, and never in a response, an error or stderr. bw prints the new item back, password included, and roster keeps only its id.
- If `bw create item` doesn't answer in time, it's stopped, and roster syncs and looks the name up: Bitwarden may have saved it anyway. An item with that exact name (there was none just before) counts as made, so it's returned, can be undone, and `host.add` goes on with it; no such item is `62` saying nothing was saved; and if even the lookup fails, `62` says roster couldn't check and names the item to look for. It never says "nothing was saved" while the item is there.
- `vault.undo_create` deletes only items this `serve` created and hasn't undone yet (`63` for any other id), so it can't be pointed at an existing item. Bitwarden moves the item to its trash (`bw delete item ID`, not `--permanent`), where it can be restored for 30 days.
- While the vault is locked, both answer `14`.

| Code | Meaning |
|---|---|
| `60` | An item named exactly that already exists. `data.matches`: `[{name, revised, uris}]` |
| `61` | The provider can only read Logins: "provider 'op' can't save to the vault - ..." |
| `62` | The vault CLI refused the create or delete (no rights to the collection, an organization policy, the server). The message has bw's words with any value cut out |
| `63` | `vault.undo_create`: this `serve` didn't create that item, or it's already undone |
| `64` | `save_to` names an organization, collection or group that isn't there (or a shape the provider doesn't have); the message names the setting to fix |
| `65` | `save_to` names a collection you may only read; nothing was left behind |
| `66` | `quick.save`, `host.save_login`: the Session hasn't logged in with the typed password (yet, or the box refused it); nothing is saved |
| `67` | `quick.save`, `host.save_login`: no typed password is held for that id: never asked for (`save`), already saved, or forgotten (`vault.forget_typed`, `vault.lock`, 10 minutes) |

## The Mesh: `mesh.plan`, `mesh.apply`, `mesh.cut`, `mesh.status`

Host-to-Host access set up from this Box (API 15; [The Mesh](mesh.md)). The app's controls for it are a first-party Plugin; these are the methods it calls. `mesh.plan` and `mesh.apply` connect to each Host they need one at a time (deadline 240 s; a Host they don't get to in time is pending), `mesh.cut` to every Host at once (60 s). `mesh.status` never connects. Every one reads `roster.yml` afresh, so a file that doesn't load is `1`.

**Jobs** (API 17). With `background: true`, `mesh.plan`, `mesh.apply` and `mesh.cut` answer at once with the job's number and run in a thread of serve's own, with no overall deadline, so serve answers other requests meanwhile and nothing waits minutes for a Mesh of many Hosts. `mesh.job` says how far the job has got (`done` of `total` Hosts, `at` the one it's on) and, once it's over, its result or error, exactly as the method would have answered. `mesh.stop` stops it before its next Host: the Hosts it hadn't got to are pending (`stopped: …`), as with a deadline, and the next run finishes them. One Mesh run at a time: another `mesh.plan`, `mesh.apply` or `mesh.cut`, in the background or not, is `111` until it's over. serve keeps the latest job only. When serve's stdin closes (the app quitting) with a job running, it stops at once rather than finish its Host's step: that step's ssh is ended, the Host is pending (`serve closed: stopped part way`), the Hosts it hadn't got to are pending (`stopped: …`), and an apply records it all in `mesh.json` before serve exits, so the next run finishes them. Each file on a Host is replaced whole, so a step cut short leaves it as before or after, never half written. Since API 20 every Mesh run is a job, waiting or not ([Jobs](#ordering-locks-and-jobs)), and pushes `job.progress`. The Mesh controls Plugin ([plugins/mesh](../plugins/mesh/README.md)) runs everything in the background and follows its job by those (polling `mesh.job` once a second only from a serve before API 20).

<!-- BEGIN generated:methods mesh.plan mesh.apply mesh.cut mesh.status mesh.job mesh.stop -->

| Method | Params | Result | Errors | Since API |
|---|---|---|---|---|
| `mesh.plan` | `{rotate?: [host], background?: bool}` (`background` since API 17) | a Mesh result with `applied: false`: what `mesh.apply` would do. Changes nothing anywhere. With `background: true`, `{job, action, total}` at once, and the result comes in `mesh.job` | `1`, `110`, `111` | 15 |
| `mesh.apply` | `{rotate?: [host], background?: bool}` (`background` since API 17) | a Mesh result with `applied: true`; `rotate` replaces those sources' keys everywhere. With `background: true`, `{job, action, total}` at once, and the result comes in `mesh.job` | `1`, `110`, `111` | 15 |
| `mesh.cut` | `{host, background?: bool}` (`background` since API 17) | `{host, confirmed: [host], pending: {host: why}, warnings: [text], change}`: HOST's key off every peer and every peer's off HOST, at once. `warnings` (since API 24): what roster left on HOST's own side, an earlier `mesh_dir:` that still holds a Mesh key (roster never removes one), one sentence each. `change` is the `mesh: false` written for HOST as a Pending change: `{written: true, backup}` (`backup: null` and a `note` when `roster.yml` isn't in a git repo), `{written: false, note}` when it already was, or `{written: false, error, fix}` when it couldn't be written (the cut still happened). With `background: true`, `{job, action, total, host}` at once, and the result comes in `mesh.job` | `1`, `2`, `111` | 15 |
| `mesh.status` | `{brief?: bool, grouped?: bool}` (`brief` since API 17, `grouped` since API 19) | `{links, excluded, reach, members, pending, cut_pending, out_of_date}`: the Links as `roster.yml` asks for them (no `status`), `members` the Hosts roster visits, `out_of_date: true` when `roster.yml` changed the Mesh since the last complete apply on this Box. `brief: true` keeps it small when every pair of hundreds of Hosts is a Link: `links` only those worth a look (with a `via`, `no-via` marked), at most 1000 (`links_more` counts the rest), and `link_count`, `link_statuses` and `reached` for the rest. `grouped: true` (for a map, such as the Topology Plugin's, that draws who reaches whom) keeps every Link but says each meshed group once: `meshed: {group: [host]}`, the Hosts of each meshed group that reach each other both ways (two or more, in `roster.yml` order), and `links` without the pairs those cover, so 2,000 meshed Hosts are 2,000 names, not 98,000 Links. Not with `brief` | `-32602` | 15 |
| `mesh.job` | `{job?, brief?: bool}` | `{job, action, host?, state, done, total, at, stopped, result?, error?}`, or `null` when there's no job (or `job` isn't the latest). `state` is `running`, `done` (with `result`, as the method itself returns it; `brief` makes a plan's or apply's as small as `mesh.status`'s brief) or `failed` (with `error`: `{code, message, data?}`, as an error response's). `done` of `total` Hosts so far; `at` the Host it's on. `stopped`: `mesh.stop` asked it to stop; the Hosts it hadn't got to are pending |  | 17 |
| `mesh.stop` | `{job}` | `{job, stopping}`: `stopping: false` when that job isn't running (over already, or not the latest) |  | 17 |

<!-- END generated:methods -->

A Mesh result is `{applied, links, hosts, excluded, reach, pending, already, warnings, cut_pending}`:

- `links`: `[{from, to, kind, status, why?, via?, skip?}]`. `kind` is `key` or `password` (the peer asks for a password). `via` is the Host the source goes through to the peer (a Link's `via:`; `mesh.status` has it too). `status` is `ok`; `untested` (written, but the source has no `nc` or bash to test the port with, or a hop couldn't be tested); `unreachable` (the source can't reach the peer's ssh port, or a hop can't: left out); `no-host-key` (this Box recorded no host key for the peer, or for its `via` Host: left out); `no-via` (the source has no Link to the `via` Host: left out); `pending` (the source, or the `via` Host, didn't answer); `skipped` (`skip: "password-source"`: roster doesn't write on a password Host). `why` says it in words.
- `hosts`: `[{host, status, changes, error?}]` for every Host visited. `status` is `same`, `would-change` (plan), `changed` (apply) or `pending` (with `error`). `changes` are short phrases: `make key`, `replace key`, `write ssh config`, `write known_hosts`, `write ROSTER.md`, `write Include in ~/.ssh/config`, `add key from orion-2`, `remove key from orion-2`, `replace key from orion-2`, `remove id_ed25519`, ....
- `excluded`: `{host: why}` for Hosts kept out (`not reviewed (reviewed: false)`, `mesh: false`).
- `reach`: `{source: how many Hosts it reaches}`, counting the Links that work.
- `pending`: `{host: why}`, Hosts that didn't answer; `already`: nothing to change and nothing pending ("already in the mesh"); `warnings`: words to show (a `ROSTER.md` that isn't roster's, a Host that left `roster.yml`); `cut_pending`: `{host: [peers]}` from earlier cuts not yet finished.
- **Grouped** (API 19, `grouped: true` on `mesh.status`): for a map that draws who reaches whom, such as the Topology Plugin ([plugins/topology](../plugins/topology/README.md)). `meshed: {group: [host]}` names each meshed group's Hosts that reach each other both ways (two or more, in `roster.yml` order; a password Host among them is a peer, reached and never reaching), and `links` leaves out the pairs those cover (two Hosts of one meshed group, without a `via`), so 2,000 meshed Hosts are 2,000 names and not 98,000 Links. Everything else is as without it. Not with `brief` (`-32602`).
- **Brief** (API 17, `brief: true` on `mesh.status` and `mesh.job`): for a Mesh of hundreds of Hosts, where every pair in a meshed group is a Link (500 Hosts make 249,500). `links` keeps only those worth a look: with a `via` (in `mesh.status`, one whose source has no Link to its `via` Host is already `no-via`, which needs no connection to know), or with a status other than `ok`, `untested` or `skipped`; at most 1000, and `links_more` counts the rest. `link_count` is how many there are, `link_statuses` `{status: n}` (`asked` for `mesh.status`'s untested ones), `reached` `{host: how many Hosts reach it}`, and `reach` counts the Links that work. Each Host's `changes` is cut to 10, with `more` counting the rest.

| Code | Meaning |
|---|---|
| `110` | `rotate` names a Host that isn't a Mesh source, so it has no Mesh key to replace. `data.hosts`. Nothing connected |
| `111` | A Mesh job (`background: true`) is still running: `data.job` and `data.action` say which. Wait for it (`mesh.job`) or stop it (`mesh.stop`). Nothing connected |

## Discover: `discover.plan`, `discover.start`, `discover.status`, `discover.stop`, `discover.add`

A scan of a network from this Box, as `roster discover` does it (API 18; decision Q100). The app's UI for it is the first-party Plugin [`plugins/discover`](../plugins/discover/README.md); these are the methods it calls. The scan runs in `roster serve`, on a thread of its own, never in the app or a Plugin: `discover.start` answers at once, and the scan goes on while serve answers other requests. It visits the addresses a batch at a time (32 with nmap, 64 with the built-in scanner), so `discover.status` says how far it has got and hands over what it found as it finds it, and `discover.stop` ends it between batches (nmap is killed mid-batch). A scan is a job (API 20, [Jobs](#ordering-locks-and-jobs)): it pushes `job.progress` after each batch. One scan at a time; ending `roster serve` stops it. Targets may be IPv4 or IPv6 (nmap scans each family in batches of its own, IPv6 with `-6`), and an address two targets hold is visited once (`10.0.0.7` beside `10.0.0.0/24` is dropped from `targets`). A scan is the same as `roster discover`'s: nmap with service versions and web page titles when it's installed, else roster's own TCP connect scan with SSH banners and reverse DNS, on `roster discover`'s port list unless `ports` says otherwise, and at most 4,096 addresses unless `force` (then 65,536, a /16). Nothing is written until `discover.add`, which adds the picked Hosts in a new group, `reviewed: false`, as a Pending change: you review them and Publish.

<!-- BEGIN generated:methods discover.plan discover.start discover.status discover.stop discover.add -->

| Method | Params | Result | Errors | Since API |
|---|---|---|---|---|
| `discover.plan` | `{targets: [network], ports?, force?}`: networks or addresses (`10.0.0.0/24`); `ports` a list such as `"22,80,443"` (`roster discover`'s default list if left out); `force` allows up to `max` addresses | `{targets, addresses, ports, scanner, limit, max}`: the targets as written back (without one another covers: an address is visited once), how many addresses they hold, how many ports, `"nmap"` or `"built-in"` (no nmap: roster's own TCP connect scan), and the most addresses without and with `force` (4,096 and 65,536) | `-32602`, `121` | 18 |
| `discover.start` | as `discover.plan` | the new scan's `discover.status`: `{scan, state: "running", targets, scanner, done: 0, total, ...}` | `1`, `-32602`, `120`, `121` | 18 |
| `discover.status` | `{scan?, since?}`: the scan's id (the latest if left out); `since` skips the first that many found | `{scan, state, targets, scanner, done, total, count, quiet, found: [Found], error}`. `state` is `running`, `stopping`, `done`, `stopped` or `failed` (`error` says why); `done` of `total` addresses visited; `count` how many were found in all (pass it as the next `since`); `quiet` how many answered with none of the ports open (nmap only: the built-in scanner can't tell a quiet Host from no Host, so it's 0 there). A Found is `{address, name, type, hostname, title, web, known, added, vendor, os, mac, ports: [{port, name, product, title}]}`: `name` the name it would be added as (`null` when `known` names the Host already at that address), `type` the guessed kind, `added` the name `discover.add` gave it | `-32602`, `122` | 18 |
| `discover.stop` | `{scan?}` | `{scan, stopping}`: `stopping: false` when it had ended already. `discover.status` says `stopped` once it has | `122` | 18 |
| `discover.add` | `{scan, addresses: [address], group?}`: `group` is new (`discovered-YYYYMMDD` if left out) | `{group, added: [{address, name}], backup}` | `1`, `-32602`, `70`, `74`, `100`, `122`, `123` | 18 |

<!-- END generated:methods -->

| Code | Meaning |
|---|---|
| `120` | `discover.start`: a scan is going already. `data.scan` is its id |
| `121` | More addresses than a scan visits: 4,096, or 65,536 with `force`. `data: {addresses, limit, max}` |
| `122` | No scan by that id in this `roster serve` (or none has started): ids don't outlive serve |
| `123` | `discover.add`: an address the scan didn't find, or one in the Inventory or added already. `data.addresses`. Nothing was written |

## See also

[The roster command](cli-reference.md) · [Connection errors](app/errors.md) · [The app's architecture](app/architecture.md)
