# roster CLI reference

Everything the `roster` command reads and does: the `roster.yml` format, resources, password providers, `discover`, the commands, how Claude uses it, and the security model. The [README](../README.md) has the overview and the install; [serve-api.md](serve-api.md) has the JSON-RPC API the desktop app uses.

## Why it exists

- **One source of truth for the team.** The host list lives in git and the logins live in the shared vault. Adding a host takes one change to `roster.yml`, and rotating a password takes one vault edit. Every box picks the change up.
- **No passwords on disk.** Passwords are fetched from Bitwarden, 1Password, `pass`, KeePassXC, an environment variable or any command. They are kept in memory for one run and never written or printed. Each box gets its own SSH key, so you can revoke one box without touching the others.
- **Claude works on the network without seeing secrets.** `roster setup` writes `ROSTER.md`, which tells Claude which hosts exist and how to reach them. Claude uses `ssh`, `roster run` and `roster web`, and reads roster's data with `--json`: roster supplies the credentials and Claude sees only the output.
- **Scans become inventory safely.** `roster discover` turns an nmap sweep into `roster.yml` entries marked `reviewed: false`. Nothing logs in to them until a person has reviewed them.

## What `roster setup` does on a box

1. Creates an SSH key for that box, tagged with the box's name.
2. Records every host's fingerprint.
3. Installs the key on each host that accepts keys, using the password from your password manager once.
4. Writes SSH config entries, so `ssh orion-dev-01` just works.
5. Writes `ROSTER.md`, so Claude knows which hosts exist and how to reach them.
6. Applies the Mesh when `roster.yml` has one (not with `--only`; see [The Mesh](mesh.md)).

## roster.yml

**Your `roster.yml` is private.** It lives in your team's own private git repo (or only on your box), never in a public one and never in this repo. It names your Hosts, addresses, users and vault items, so it says a lot about your network even though it holds no passwords. roster itself stays generic: anything specific to your team (names, device types, groups) belongs in your `roster.yml`, not in roster's code.

Settings cascade `defaults` → group → host, with the most specific winning. Run `roster init` to get a fully commented example; there is also one at `examples/roster.example.yml`.

```yaml
defaults:
  user: admin
  auth: prompt

groups:
  orion:
    title: Product Orion              # describes the group itself
    product: orion                    # cascades to the hosts
    user: deploy
    auth: bw:Orion servers            # where the password lives
    hosts:
      orion-dev-01:
        ip: 10.0.1.15
        type: dev
        title: Orion - dev box (main)
        description: Shared dev environment; full stack under /srv/orion.
        web: "https://10.0.1.15:8443"
        services: { postgres: 5432 }

  network:
    enroll: false                      # switches/routers: no key, log in by password
    user: netops
    auth: op:Network gear
    hosts:
      net-sw-core-01: { ip: 10.0.0.2, type: switch, title: "Core switch, rack A" }
```

| Field | Meaning |
|---|---|
| `ip`, `port`, `user` | How to reach it over SSH (port defaults to 22). `user` is also the box's default login |
| `title`, `description`, `type`, `product` | Who the box is; searchable with `roster hosts --find` |
| `web` | Web UI URL; listed for Claude and checked by `roster check` |
| `services` | Other ports to know about and check, e.g. `{ postgres: 5432 }`, or long form with its own login (below) |
| `auth` | Where the password comes from (see below); the default for every service on the box |
| `ssh` | Optional `{ port, user, auth }` that override the defaults for SSH only |
| `enroll` | `true` installs a key (default); `false` for gear that only takes passwords |
| `reviewed` | `false` on scanned hosts; `setup` skips them until you flip it |
| `mesh` | `true` lets a group's Hosts reach each other (the [Mesh](mesh.md)); `false` keeps a group or Host out of it and out of every Link. Cascades like the rest |
| `mesh_dir` | Where a Mesh source keeps its key, known hosts, ssh config (and, on ESXi, `ROSTER.md`), in place of `~/.ssh/roster-mesh` or ESXi's datastore pick: an absolute path, on ESXi on a datastore. Cascades like the rest. See [`mesh_dir:`](mesh.md#esxi) |
| `seen_as` | The Host's other addresses (one or a list, addresses or networks) that a Mesh peer's `from=` takes beside its `ip`: for a jump Host on several networks or a Host behind NAT. On the Host only. See [`seen_as:`](mesh.md#other-addresses) |

Top-level `links:` add one-way Host-to-Host reach across groups: `- { from: HOST-OR-GROUP, to: HOST-OR-GROUP, both: true, via: HOST }` (`both` makes it two-way; `via` sends it through a jump Host with `ProxyJump`, and the peer's `from=` names that Host's address). See [The Mesh](mesh.md) and [Through a jump Host](mesh.md#through-a-jump-host).

### One login per box, overrides per service

A host's `user` + `auth` are its default login for everything on it. An `ssh:` block or a long-form service entry can override them. This is useful when a web UI uses a different account from SSH:

```yaml
      orion3:
        ip: 10.19.1.211
        user: admin                  # default login for every service on this box
        auth: "bw:orion3 db"
        ssh: { user: sshuser, auth: "bw:orion3 ssh" }      # SSH only; port defaults to 22
        services:
          https:
            port: 443                # url is derived (https://10.19.1.211) unless you give one
            user: webadmin
            auth: "bw:orion3 web"
            # verify: false          # self-signed certificate
          postgres: 5432             # short form: inherits admin / bw:orion3 db
```

- For SSH, the first match wins: the host's `ssh:` block, then the host's `port`/`user`/`auth`, then the group's `ssh:` block, then the group's keys, then `defaults:` in the same order.
- A service uses its own `user`/`auth` if it sets them, otherwise the host's default login.
- `ssh:` and `services:` work at host, group and `defaults:` level. Service entries with the same name merge field by field, so a group can define `modbus: { port: 502, user: mb }` and one host can override just its `auth`.
- A service accepts `port`, `url`, `scheme`, `user`, `auth`, `verify` and `login` (below). `web: "https://..."` still works and becomes a service named `web`.
- **One bad service entry doesn't stop the Inventory loading.** A service roster can't use (a bad port or url, an unknown setting or `login:` type, no port or url) is left out, and its Host stays with the rest of its services. `roster hosts`, `roster check` and `roster auth-check` print a warning on stderr for each one, naming the Host and the service, what's wrong and the fix; `roster info HOST` lists them under `problems`, and `roster web HOST SERVICE` on that service stops with the same words. Mistakes that aren't about one service (bad YAML, a Host listed twice, a Host without an ip or user, a bad SSH port, `services:` that isn't a mapping) still stop the load.
- `roster info HOST` shows each service's login as a reference (`webadmin, auth bw:orion3 web (own login)`), never the password. `roster auth-check` tests every reference in use, service ones included.

### Web APIs with stored logins: `roster web`

`roster web esxi GET /folder` or `roster web orion3 https GET /api/status` sends a request to that service, logged in with its `user`/`auth`. Without SERVICE it uses the host's web UI. The response status goes to stderr and the body to stdout.

- `login: basic` (default) sends HTTP Basic; `login: bearer` sends the `auth` value as a bearer token; `login: none` sends nothing. Generic HTML form logins aren't supported.
- `login: vsphere` (ESXi, vCenter) logs in through the SOAP API, sends the request with the session cookie, then logs out. Send SOAP bodies to `/sdk`, e.g. `roster web esxi POST /sdk -d @call.xml`. The right `SOAPAction` header is added for you.
- `login: unifi` (UniFi OS consoles: UDM, Cloud Key, UniFi OS Server) logs in through `/api/auth/login` and sends the request with the session cookie and CSRF token. The session is kept for up to 10 minutes (never past the token's expiry) in a private file under `$XDG_RUNTIME_DIR/roster/sessions/`, so a loop of calls logs in once instead of tripping UniFi OS's login limit (HTTP 429); if the console rejects a kept session, roster logs in again and retries once. Paths: `/api/...` for UniFi OS, `/proxy/network/api/s/default/...` for the Network app, e.g. `roster web unifi GET /proxy/network/api/s/default/stat/health`.
- `login: openvpnas` (OpenVPN Access Server admin API, port 943) logs in through `/api/auth/login/userpassword` and sends the token as `X-OpenVPN-As-AuthToken`. Access Server has no logout call, so the token just expires. Example: `roster web vpn admin GET /api/server/info`. The old XML-RPC `/RPC2` API is often locked down by the relay level, so use `/api/...`.
- `login: hub` (Hub web UI) logs in through `/api/auth/login` and sends the access token as a bearer token. The token expires after an hour; there is no logout call. Example: `roster web lab-hub2 GET /api/auth/me`.
- **Your own names for these:** if your team calls a login type something else, map your name to roster's at the top level of `roster.yml`, and use your name on the services:

  ```yaml
  web_login_names: { appliance: hub }     # your name: one of basic, bearer, vsphere, unifi, openvpnas, hub, none
  groups:
    lab:
      hosts:
        lab-hub2: { ip: 10.0.5.20, services: { web: { url: "https://10.0.5.20", login: appliance } } }
  ```

  `login: appliance` then works exactly like `login: hub`. Everything roster shows (`roster info`, `roster serve`'s Hosts, error messages) gives the type it resolved to (`hub`), so the behaviour is never in doubt; your own word stays in `roster.yml`, and edits made through `roster serve` leave it as it is. A name has to map to one of roster's types and can't be one of them, or the file doesn't load (the message names the key). A service whose `login:` is neither is left out with a warning, like any bad service entry.
- Only paths are accepted, and redirects are reported, not followed, so the credentials never go anywhere but the service's own address.
- The password, the token and the Authorization header are never printed. If a response happens to contain the password, it is masked.
- `verify: false` on the service (or `-k`) accepts a self-signed certificate.
- Hosts with `reviewed: false` are refused.

**Naming tip:** use `<product>-<role>-<nn>` (`orion-web-01`, `net-sw-core-01`). A product's boxes then sort together, and `ssh orion-<Tab>` shows only that product.

## Resources: secrets with no address

Some things need a secret but aren't hosts: a Wi-Fi network, a vendor portal, an API key. List them under `resources:` (next to `groups:`). Like everything else in `roster.yml`, they hold vault references, never values.

```yaml
resources:
  lab-guest:
    type: wifi
    ssid: Lab-Guest
    auth: "bw:wifi lab-guest"
    group: subnet-42
    title: Contoso guest Wi-Fi
```

Every resource has the same fields, plus the fixed fields of its type. Anything else is an error, so every resource of a type looks the same in every view.

| Type | Its own fields | Use for |
|---|---|---|
| (every type) | `title`, `description`, `group` (an existing group), `user`, `auth` | |
| `wifi` | `ssid` (required), `security` (`wpa2` default, `wpa3`, `wpa`, `wep`, `open`, `wpa2-enterprise`, `wpa3-enterprise`), `hidden` | Wi-Fi networks; `auth` is the password (not needed for `open`) |
| `account` | `url` (required) | Website, portal or SaaS logins |
| `secret` | none | API keys, license keys, PSKs |

- `roster resources` lists them (`--only NAME,TYPE,GROUP`, `--find TEXT`), and `roster info NAME` shows every field. Both show where the secret comes from, never the secret itself.
- `roster reveal NAME` prints the secret, for a person to type in. `roster reveal NAME --wifi` prints a `WIFI:T:WPA;S:…;P:…;;` string instead; pipe it to `qrencode -t ansiutf8` and phones can join by scanning it.
- `roster auth-check` checks resource references too, and ROSTER.md lists resources for Claude. Claude is told never to run `reveal` and to send the user to it instead.
- Old roster versions ignore `resources:`, so you can add it to a shared map before every box has upgraded.

## Password providers

`auth:` takes the form `PROVIDER:WHAT`. Passwords are fetched only when needed, kept in memory for that run, and never printed.

| auth | Source |
|---|---|
| `prompt` | Ask once per group when `setup` runs |
| `agent` | No password; an SSH key you already have gets in |
| `env:VAR` | Environment variable |
| `cmd:COMMAND` | Any command that prints the password |
| `bw:ITEM`, `bw:ITEM#FIELD` | Bitwarden CLI (login password, custom field, `#username`, `#notes`) |
| `op:ITEM`, `op:VAULT/ITEM#FIELD`, `op:op://…` | 1Password CLI |
| `kp:ENTRY`, `kp:GROUP/ENTRY`, `kp:ENTRY#FIELD` | KeePassXC (`keepassxc-cli`), a local `.kdbx` (entry password, `#username`, `#url`, `#notes`, or another attribute) |

**Naming vault items:** name each item `<roster host name> <what it opens>` (`orion3 ssh`, `esxi-02 ssh+web`, `shared hub web`, `wifi lab-guest`), and put the address in the item's URI field. The full convention is in [docs/adding-hosts.md](adding-hosts.md#2-add-the-logins-to-the-vault).

**Bitwarden:** run `bw login` once. A locked vault is unlocked once per run, using a master password prompt, `BW_PASSWORD`, or an existing `BW_SESSION`. For headless boxes, set `BW_CLIENTID`/`BW_CLIENTSECRET`.

**Where "Save to vault" puts new items** (ticket 35) is a setting, so every Box of a team behaves the same:

```yaml
providers:
  bw:
    save_to: personal                                                # the default
    # save_to: { organization: "My Team", collection: "Infra logins" }  # names or ids
  kp:
    save_to: { group: Hosts }                                        # KeePassXC: "personal" is the top level
```

The app's `init.lua` can set `vault.save_to` for its own Box, which wins, and the add-Host form's **Save to** can pick another place for one Host. A name that doesn't resolve is code `64` naming the setting; see `vault.targets` below. Team logins belong in a collection the team shares ([docs/adding-hosts.md](adding-hosts.md#2-add-the-logins-to-the-vault)).

**1Password:** use one of these:
- the 1Password app integration,
- `OP_SERVICE_ACCOUNT_TOKEN` for headless boxes,
- or `eval $(op signin)`.

Set a default vault under `providers: op: vault:`.

**KeePassXC** is the local-only option (decision Q41): no server and no account, one `.kdbx` file on this box. Install KeePassXC (it ships `keepassxc-cli`) and say where the database is:

```yaml
providers:
  kp:
    database: ~/roster.kdbx      # required; ~ and paths relative to roster.yml work
    key_file: ~/roster.keyx      # optional, used with the master password
    group: Hosts                 # optional: the group "Save to vault" adds entries to (default: the top level)
    recycle_bin: Recycle Bin     # optional: the group lookups skip (KeePassXC's default name)
```

A local database is this Box's own, so the app's `init.lua` can name it instead: `vault = { kp = { database = "~/roster.kdbx", key_file = "~/roster.keyx" } }` ([docs/app/config.md](app/config.md#the-vault)). It reaches `roster serve` through `vault.configure` and wins over `roster.yml`'s `database` and `key_file`.

`kp:ENTRY` finds the one entry titled exactly ENTRY in any group (code `33` if several are, `32` if none is); `kp:GROUP/ENTRY` is a path. `keepassxc-cli` has no session, so every lookup opens the database again with the master password, which it reads from its stdin, never from the command line. On a terminal roster asks for it once per run. Under `roster serve` the lock screen's `vault.unlock` checks it against the database and `serve` keeps it in memory until `vault.lock`. Tested with keepassxc-cli 2.8.0.

**Adding your own:**

- **Command template, no code:**
  ```yaml
  providers:
    vault:
      command: vault kv get -field={field} {item}   # auth: vault:secret/infra/web
  ```
- **Python plugin, for anything that needs login or unlock logic:** drop a `.py` file into `~/.config/roster/providers/` or a `providers/` folder next to `roster.yml`. `examples/providers/pass_store.py` is a complete, documented example for `pass`. Copy it to get started.

## Discover

```bash
roster discover 10.0.1.0/24 [more networks] [--write | --json] [--top-ports 1000] [--no-ping] [--os]
```

With nmap installed, discover collects open ports, service versions, web page titles, and hardware vendor. It uses these to guess each host's type: `server`, `db`, `network`, `bmc`, `windows`, or `appliance`. It then fills in a name, title, SSH port, web URL, services, and a description. Without nmap, it falls back to a built-in TCP scanner. Networks may be IPv4 or IPv6 (nmap scans the IPv6 ones in a run of their own, with `-6`), and an address two of them hold is scanned once. With nmap, it also counts the hosts that answered with none of the ports open (not with `--no-ping`, where nmap takes every address as up).

`--write` adds new hosts to a `discovered-YYYYMMDD` group with `reviewed: false`:
- It keeps your comments.
- It saves `roster.yml.bak`.
- It refuses to write a file that wouldn't load.
- It never overwrites hosts that are already in the file.

Let your security team know before scanning big ranges.

From the app, the first-party [discover](../plugins/discover/README.md) Plugin does the same scan through `roster serve` (`discover.*`, [serve-api.md](serve-api.md#discover-discoverplan-discoverstart-discoverstatus-discoverstop-discoveradd)): it asks first, shows what answers as it comes in, and adds the Hosts you keep as Pending changes, unreviewed (`:help discover` once it's installed).

## Commands

| Command | What it does |
|---|---|
| `init` | Write the commented example `roster.yml` |
| `discover CIDR…` | Scan networks; `--write` adds the results to `roster.yml` |
| `setup` | One-time per box: key, fingerprints, key install, SSH config, Claude files (`--only`, `--dry-run`) |
| `sync` | Rewrite the SSH config and Claude files after editing `roster.yml` |
| `check [HOST]` | Reachability of SSH, web UIs and services, and the Mesh's drift (without `--only`). With one HOST: why a Session to it would or wouldn't open, step by step (see [`roster check HOST`](#roster-check-host)). With `--box`: this Box's health, without connecting anywhere (see [`roster check --box`](#roster-check---box)) |
| `hosts [--find TEXT] [--all] [--long]` | The hosts and resources you can use: name, IP, user, logins (`ssh (key), web (admin), api`, `wifi`) and title. Unreviewed scanned hosts are hidden unless you pass `--all`, `--find` or `--only`. `--long` shows the full table (type, product, web URL, scan description) |
| `info NAME` | Everything about one host or resource; fuzzy names work (`roster info core switch`) |
| `resources [--find TEXT]` | List or search Wi-Fi networks, accounts and secrets that aren't hosts |
| `reveal NAME [--wifi]` | Print a resource's secret for a person to use (`--wifi`: a QR-ready `WIFI:` string) |
| `run [--sudo] HOST -- CMD` | Run a command; password-only hosts get their password from the provider. `--sudo` runs it as root, handing sudo the login's password (never shown) |
| `web HOST [SERVICE] METHOD PATH` | HTTP request to a host's web service, logged in with its stored credentials (`-d BODY`, `-H 'Name: value'`, `-k`) |
| `bw BW_ARGS…` | The Bitwarden CLI with this box's vault session from `~/.config/roster/bw-session` (never prompts), e.g. `roster bw list items --search proxmox` |
| `providers` | Available providers, whether their tools are installed, unknown ones in use |
| `auth-check` | Test every password source in use (SSH, services and resources) without printing anything secret |
| `revoke` | Remove this box's key from every host |
| `mesh [--dry-run] [--rotate HOST]` | Set up Host-to-Host access as `mesh:` and `links:` say, one Host at a time: a key made on each source, tagged entries on its peers. A Link's `via: HOST` goes through a jump Host (`ProxyJump`), tested through it. `--dry-run` shows the plan, `--rotate` replaces a Host's Mesh key. `mesh status` shows who reaches whom without connecting; `mesh cut HOST [-y]` takes a Host out everywhere at once and writes `mesh: false` for it as a Pending change; `--json` with `status` or `--dry-run`. See [The Mesh](mesh.md) |
| `serve` | The JSON-RPC API the desktop app talks to, on stdin/stdout (see [`roster serve` API](serve-api.md)) |
| `askpass PROMPT` | The `SSH_ASKPASS` helper for a `serve` password Session. ssh runs it, not you |
| `man [--install [--prefix DIR]]` | Show the `roster(1)` man page. `--install` copies it to `PREFIX/share/man/man1/roster.1`, next to `PREFIX/bin/roster` (`~/.local` after `uv tool install`), where `man roster` finds it; into a prefix you can't write to, it says so and exits 1 (pick `--prefix ~/.local`, or use sudo). `install.sh` does this for you |

`--only` accepts host names, groups, types and products: `roster check --only orion`, `roster setup --only switch,router`.

`--json` on `hosts`, `info`, `resources`, `check`, `discover` (its preview), `mesh status`, `mesh --dry-run`, `providers` and `auth-check` prints the same data as JSON for scripts and tools, never a secret: see [Machine-readable output](#machine-readable-output).

Config lookup order: `-c PATH`, then `$ROSTER_CONFIG`, then `./roster.yml`, then `~/.config/roster/roster.yml`.

The man page (`man roster`) is generated from this section, Machine-readable output, Files, Environment, Exit status, Examples and roster's own argument parser, so it never drifts from them: after changing either, run `uv run python -m roster.manpage` and commit `src/roster/roster.1`. A test fails until you do.

### `roster check HOST`

Runs the same diagnostics as the app's `:check HOST` (`host.check` below), in this order, and stops at the first failure:

| Step | Checks | Fails with |
|---|---|---|
| `inventory` | `roster.yml` loads, the Host is in it, it's reviewed, its user isn't `CHANGE-ME` | `1`, `2`, `20`, `30` |
| `ssh-config` | `ssh` is installed, and roster's ssh config has the Host's block exactly as `roster.yml` now says (stale, including one written before `IdentitiesOnly`: run `roster sync`) | `21` |
| `provider` | A password Login's provider is set up on this box and can answer | `31`, `11`, `12`, `14` |
| `vault-item` | The Login's vault item exists, is the only match, and has the password or `#FIELD` | `32`, `33`, `34`, `35` |
| `dns` | The Host's address resolves | `40` |
| `tcp` | The ssh port accepts a connection (5 s) | `41`, `42` |
| `host-key` | Over that same connection, the key the Host offers matches the one recorded in `~/.ssh/roster_known_hosts`. It's never recorded or accepted here | `43`, `44` |
| `auth` | One real login with the system ssh: `BatchMode` with the key, or one password prompt through askpass. `StrictHostKeyChecking=yes`, `ControlPath=none` | `45`, `46`, `47`, `36`, `48` |

Key Hosts skip `provider` and `vault-item`. Nothing touches the network once a local step has failed, and a whole check makes at most one TCP connection (port and host key) and one login, so it's safe to run against the 10.19.x rate limiter. It prints one line per step (`ok`, `FAIL` with the code, `skip`), then the fix and ssh's own message under a failure, and exits 1 if a step failed. It never prints a password.

```text
ok   inventory   root@10.0.0.6:22 (password login)
ok   ssh-config  Host esx
ok   provider    bw is ready
FAIL vault-item  [33] 2 vault items are named 'esx ssh' (ssh Login of esx): 'esx ssh' (edited 2026-09-01, ssh://10.0.0.6); 'esx ssh' (edited 2026-10-20, https://10.0.0.6)
                 fix: delete or rename the extra items in the vault, or use the item's id in auth:
skip dns         an earlier step failed
...
```

### `roster check --box`

This Box's health, like Neovim's `:checkhealth`: the same checks as the app's `:check` with no Host (`box.check`), a section at a time, each `ok`, `warn` or `error` with the fix and the `:help` topic that explains it. Every check is local. It reads files, looks on `PATH`, asks each vault CLI where it stands, and reads the infra repo's git as this Box last saw it. It never logs in to a Host, scans one or fetches, so it's safe to run any time; `roster check HOST` is the one that connects. It takes no HOST and no `--only`, never prints a password, and exits 1 if any check is an `error`.

| Section | Checks |
|---|---|
| roster | roster's version and Python's |
| Inventory | `roster.yml` is found and loads (its path, or the error and its line); Hosts waiting for review, Hosts with no SSH user, service entries left out |
| ssh | `ssh` is on `PATH`; roster's ssh config is written, included from `~/.ssh/config` and has every Host (else run `roster sync`); this Box's key exists if a Host uses key Logins; roster's known hosts has every Host's key |
| Vault | Each provider the Logins use: its CLI is installed, logged in, and locked or unlocked (from its own status command, as the lock screen asks it) |
| askpass | The askpass channel (the private socket password Sessions get their password through) opens on this Box |
| Infra repo | `roster.yml` is in a git repo, and whether it has Pending changes, other uncommitted files, or commits the upstream doesn't have (as last fetched) |

```text
ssh
  ok     ssh found: /usr/bin/ssh
  warn   1 Host not in roster's ssh config yet: nas
         fix: run `roster sync`
         help: E2

Vault
  ok     bw (9 Logins): logged in, locked; it asks for the master password when a Login needs it

1 warning, no errors
```

## Machine-readable output

The read commands take `--json`, for scripts, other tools and Claude: `hosts` (with `--only`, `--find`, `--all`), `info NAME`, `resources`, `check`, `check HOST`, `check --box`, `discover` (its preview, without `--write`), `mesh status`, `mesh --dry-run` (the plan), `providers` and `auth-check`. The CLI is roster's interface for other apps; `roster serve` is the desktop app's own backend, not a public API. With `--json`, stdout is one JSON document on one line, with no colour, table or warning, and the exit status is the same as without it.

- **Never a secret.** Logins are references: the provider and the item (`bw:esx-02 ssh`, `op:Lab/esx-02`, `prompt`, `agent`). A `cmd:` or `env:` reference says how a secret is fetched, and a password pasted into a `cmd:` line would show, so each one is cut to its kind (`cmd:`, `env:`) everywhere in the output, error messages and check messages included, the way Plugins get them: a `cmd:` one to the end of its line, an `env:` one its variable's name, wherever one starts a text or follows a space, a quote or one of `=:,({[`. An error message keeps a trailing `(code N)`. The cases both implementations are tested against are in `tests/vectors/redaction.json`. `auth-check --json` fetches every secret it tests and says only whether it was found. `reveal` has no `--json`: it's for a person.
- **One shape.** A Host, a group and a resource are the objects `roster serve` answers with (`hosts.list`, `host.get`; [the serve API](serve-api.md) lists their fields): every field `roster.yml` resolves to, with `ssh: {user, port, auth}`, `login: {user, auth}`, `services` by name, and `problems`, the service entries left out (the warnings the table prints on stderr).
- **A version.** `version` is the first field of every document, errors included. It is `1` now.
- **Errors** go to stderr as `{"version": 1, "error": {"code", "message", "fix"}}`, with nothing on stdout. The codes are `roster serve`'s: `1` `roster.yml` wasn't found or doesn't load (`fix` says where), `2` no Host or resource by that name, `3` any other refusal. Wrong arguments are code `3` too, with exit status 2. A refusal serve has its own code for keeps it: `121` too many addresses for `discover`, `110` a `--rotate` Host that isn't a Mesh source.
- **What's a breaking change:** removing or renaming a field, changing its type or what it means, or changing an exit status. Those come with a new `version` and a line under **Breaking** in [What's new](news.md). A new field or a new command with `--json` isn't one, so read the fields you need and ignore the rest.

| Command | stdout |
|---|---|
| `hosts --json` | `{version, hosts: [Host], resources: [resource], groups: {name: {title, description}}, hidden}`. Hosts and resources in `roster.yml` order, filtered as the table is; `hidden` counts the unreviewed Hosts left out (`--all` shows them). Exit 1 when `--find` matches nothing |
| `info NAME --json` | `{version, host: Host, group}` or `{version, resource: resource, group}`; `group` is `{name, title, description}`, or `null` for a resource with none |
| `resources --json` | `{version, resources: [resource]}`. Exit 1 when `--only` or `--find` matches nothing |
| `check --json` | `{version, hosts: [{name, ok, ssh, checks}], mesh, ok}`: `checks` is `{ssh: bool, SERVICE: bool, ...}`, `ssh` says what was tested (`login` with this Box's key, `port` for a password-only Host). `mesh` is the drift (the plan `roster mesh --dry-run` would show), or `null` with no Mesh or with `--only`. Exit 1 unless `ok` |
| `check HOST --json` | `{version, host, ok, steps: [{step, status, message, code?, fix?, details?, data?}]}`, as `host.check`: `status` is `ok`, `fail` or `skipped`. An unknown Host is a failed `inventory` step (code 2), not an error. Exit 1 unless `ok` |
| `check --box --json` | `{version, checks: [{section, level, message, fix?, topic?}], ok}`, as `box.check`: `level` is `ok`, `warn` or `error`. Exit 1 if one is an `error` |
| `discover CIDR... --json` | `{version, targets, addresses, ports, scanner, count, quiet, found: [Found], group}`: the preview, after the scan. `targets`, `addresses` (how many it visits), `ports` (how many) and `scanner` (`nmap` or `built-in`) as `discover.plan`; `count`, `quiet` and `found` as `discover.status` (a Found is `{address, name, type, hostname, title, web, known, added, vendor, os, mac, ports}`: `name` the name `--write` would give it, `null` when `known` names the Host already at that address; `added` is always `null` here). `group` is the group `--write` would add the new ones to. Not with `--write` (exit 2). Over 4,096 addresses without `--force`: error `121`. A `roster.yml` that's there but doesn't load (named by `-c`, `ROSTER_CONFIG` or found in the usual places): error `1` with its fix; with none at all (or `ROSTER_CONFIG` naming no file) it scans anyway |
| `mesh status --json` | `{version, links, excluded, reach, members, pending, cut_pending, out_of_date}`, as `mesh.status` |
| `mesh --dry-run --json` | `{version, applied: false, links, hosts: [{host, changes, status, error?}], excluded, reach, pending, already, warnings}`, as `mesh.plan`: it connects to the Hosts, one at a time, and changes nothing. Exit 1 if a Host is `pending` (didn't answer). `--json` goes with `status` and `--dry-run` only, never with an apply or `cut` |
| `providers --json` | `{version, providers: [{name, kind, help, tool, installed, used_by}], unknown, ok}`: `tool` is the CLI it runs (`null` for none, and `installed` `null` with it), `used_by` the groups whose Logins use it, `unknown` the providers `roster.yml` names that aren't set up. Exit 1 if there's one |
| `auth-check --json` | `{version, logins: [{group, auth, users, used_for: [{service, hosts}], status, error?}], ok}`: one row per Login reference and group; `status` is `ok` (a value was found; it isn't tested against a Host), `fail` (with `error`) or `ask` (`prompt`). Exit 1 if one failed |

Wrapped and cut short here (`...`); roster prints each document on one line:

```text
$ roster hosts --only esx-02 --json
{"version": 1, "hosts": [{"name": "esx-02", "group": "lab", "ip": "10.0.0.5", "user": "root", "port": 22,
  "enroll": false, "reviewed": true, "title": "Lab ESXi", "ssh": {"port": 22, "user": "root",
  "auth": "bw:esx-02 ssh"}, "services": {}, "problems": [], ...}], "resources": [],
  "groups": {"lab": {"title": "The lab", "description": ""}}, "hidden": 0}
$ roster check esx-02 --json
{"version": 1, "host": "esx-02", "ok": false, "steps": [{"step": "inventory", "status": "ok", "message": "root@10.0.0.5:22 (password login)"},
  ..., {"step": "tcp", "status": "fail", "code": 42, "message": "...", "fix": "..."}, ...]}
$ roster info nope --json
{"version": 1, "error": {"code": 2, "message": "unknown host or resource 'nope'", "fix": null}}   (on stderr, exit 1)
```

## Files

| File | What it is |
|---|---|
| `./roster.yml` | The Inventory: hosts, groups, resources and vault references, never passwords. roster looks for it in this order: `-c PATH`, `$ROSTER_CONFIG`, `./roster.yml`, `~/.config/roster/roster.yml` (`%APPDATA%\roster\roster.yml` on Windows) |
| `~/.config/roster/` | This box's roster folder (on Windows, `%APPDATA%\roster`, next to the app's `init.lua`): `roster.yml` if you keep it here, `providers/` for provider plugins, `bw-session` |
| `~/.config/roster/bw-session` | A saved Bitwarden session (`bw unlock --raw`), used only if only you can read it |
| `~/.ssh/roster_ed25519` | This box's SSH key (`key_path:` in `roster.yml` moves it), made by `roster setup` |
| `~/.ssh/roster_known_hosts` | Host keys recorded on first contact |
| `~/.ssh/config.d/roster` | The SSH config entries `roster setup` and `roster sync` write |
| `ROSTER.md`, `CLAUDE.md`, `.claude/settings.json` | What Claude reads, written next to `roster.yml` by `setup` and `sync` |
| `~/.config/roster/mesh.json` | What `roster mesh` couldn't finish (pending Hosts, cuts pending) and when it last applied, on this box |
| `~/.ssh/roster-mesh/` (or the Host's `mesh_dir:`; on ESXi, `.roster-mesh` on a datastore), `~/ROSTER.md` (on Hosts) | A Mesh source's key, known hosts, ssh config and its peers for Claude, written by `roster mesh` ([The Mesh](mesh.md)) |
| `$XDG_RUNTIME_DIR/roster/` | Short-lived private state: kept web logins and the askpass socket (on Windows, the askpass channel is a named pipe and its folder is in `%TEMP%`) |

## Environment

| Variable | What it does |
|---|---|
| `ROSTER_CONFIG` | The `roster.yml` to use when `-c` isn't given |
| `BW_SESSION`, `BW_PASSWORD` | An unlocked Bitwarden session, or the master password to unlock with |
| `BW_CLIENTID`, `BW_CLIENTSECRET` | A Bitwarden API key, for headless boxes |
| `OP_SERVICE_ACCOUNT_TOKEN` | A 1Password service account, for headless boxes |
| `XDG_RUNTIME_DIR` | Where roster keeps its short-lived private state |

## On Windows

roster also runs on Windows itself, without WSL, so the roster app works for teammates who don't use WSL.

- Install it with `uv tool install .` in the roster repo (it lands in `%USERPROFILE%\.local\bin`). That also installs `roster-askpass.exe` and `roster-askpass-login.exe`, the programs Windows' ssh runs to ask roster serve for a password; they do nothing on their own.
- roster uses Windows' built-in OpenSSH (`ssh.exe`, `ssh-keygen.exe`, `ssh-keyscan.exe`). `roster setup` writes the same files under `%USERPROFILE%\.ssh`, with forward slashes in the config, and without connection sharing (`ControlMaster`), which Windows' OpenSSH doesn't have.
- roster's own folder is `%APPDATA%\roster` (where the app's `init.lua` is too), so `roster.yml` can live there, as can `providers/` and `bw-session`.
- `roster run` waits for ssh and exits with its status (Windows has no `exec`).
- A vault CLI installed as a batch file (npm installs `bw` as `bw.cmd`) runs through `cmd.exe`, so roster won't pass it an argument with `"`, `%`, `^`, `&`, `|`, `<`, `>` or `!` in it: rename the item, or install the tool as an `.exe`.
- Signing the vault in from the app with a password or SSO drives `bw login` on a pseudoconsole (ConPTY, Windows 10 1809 or later), as Linux does on a PTY. For SSO, bw opens the sign-in page in your default browser itself, so the app has no link to show or copy.
- Commands that run a shell script on this machine (a `cmd:` provider, a provider's `command:`) run it with `cmd.exe`.

## Exit status

| Status | Meaning |
|---|---|
| `0` | Success |
| `1` | An error (roster prints it on stderr, starting `error:`), a check that failed, or a web request answered with HTTP 400 or above |
| `2` | Wrong arguments |
| `130` | Interrupted with Ctrl+C |

With `--json`, the status is the same, and an error is JSON on stderr ([Machine-readable output](#machine-readable-output)). `roster run` exits with the remote command's status, and `roster bw` with `bw`'s. `roster mesh` and `roster mesh cut` exit 1 while a Host is pending.

## Examples

```sh
roster init                              # write a commented roster.yml to start from
roster setup --dry-run                   # which hosts would get this box's key
roster hosts --find esx                  # search names, titles, types, addresses
roster info esx-02                       # everything about one host
roster check esx-02                      # why a Session to esx-02 would or wouldn't open
roster check --box                       # this Box's health: roster.yml, ssh, vault, infra repo
roster run esx-02 -- uptime              # run a command with the stored login
roster web esx-02 GET /api/status        # an HTTP request, logged in
roster discover 10.0.5.0/24              # scan a network, preview only
roster reveal lab-guest --wifi | qrencode -t ansiutf8
```

## How Claude uses it

`roster setup` and `roster sync` write three things:

- **`ROSTER.md`** holds the hosts table (or a summary for big inventories), how to connect, and rules. The rules tell Claude to:
  - never read keys or fetch passwords,
  - ask before changing state on a host,
  - ask you to unlock a locked password manager rather than trying itself,
  - leave unreviewed hosts alone,
  - run `roster check NAME --json` when a host doesn't respond, and report which step fails.

  It also tells Claude to use `--json` (`roster hosts --json`, `roster info NAME --json`, `roster check HOST --json`) when it needs to read roster's data rather than show it.
- **`CLAUDE.md`** gets an `@ROSTER.md` line added, and its existing content is kept.
- **`.claude/settings.json`** gets deny rules for reading and editing `~/.ssh`. These are a guardrail, not a wall.

For Bitwarden, `(umask 077; bw unlock --raw > ~/.config/roster/bw-session)` lets every roster run on this box use the unlocked vault, including Claude sessions that don't inherit your shell's environment, and `roster bw …` runs any other `bw` command with it. roster ignores the file unless only you can read it. `bw lock` ends the session, and the file goes stale with it.

For password-only gear, start Claude from a shell where your password manager is unlocked, for example `export BW_SESSION=$(bw unlock --raw)`. `roster run` can then fetch the password without Claude ever seeing it.

Web UIs: Claude won't type passwords into login pages. Sign in once in the browser Claude uses.

## Security model

- **Each box gets its own key.** The key is tagged `roster-managed:<box>` in `authorized_keys`, so `revoke` removes exactly that box's key, and running `setup` again replaces it cleanly. Keys tagged `fleet-managed` by the earlier script are recognized too.
- **The key has no passphrase,** so automation can use it. Anyone with access to the box can reach the fleet, so treat these boxes accordingly.
- **Host fingerprints are recorded on first contact** in `~/.ssh/roster_known_hosts`.
- **Passwords exist only in memory,** for one run.
- **`--json` output holds no secret:** Logins are references, and `cmd:` and `env:` ones are cut to their kind ([Machine-readable output](#machine-readable-output)).
- **Scanned hosts are never touched until you mark them reviewed.**
- **At larger scale,** consider an SSH certificate authority, so new boxes only need their key signed instead of installed everywhere.

## See also

[Set up a Box](new-box.md) · [Add your Hosts](adding-hosts.md) · [The roster serve API](serve-api.md) · [All the docs](README.md)
