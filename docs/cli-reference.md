# roster CLI reference

Everything the `roster` command reads and does: the `roster.yml` format, resources, password providers, `discover`, the commands, how Claude uses it, and the security model. The [README](../README.md) has the overview and the install; [serve-api.md](serve-api.md) has the JSON-RPC API the desktop app uses.

## Why it exists

- **One source of truth for the team.** The host list lives in git and the logins live in the shared vault. Adding a host takes one change to `roster.yml`, and rotating a password takes one vault edit. Every box picks the change up.
- **No passwords on disk.** Passwords are fetched from Bitwarden, 1Password, `pass`, KeePassXC, an environment variable or any command. They are kept in memory for one run and never written or printed. Each box gets its own SSH key, so you can revoke one box without touching the others.
- **Claude works on the network without seeing secrets.** `roster setup` writes `ROSTER.md`, which tells Claude which hosts exist and how to reach them. Claude uses `ssh`, `roster run` and `roster web`, and reads roster's data with `--json`: roster supplies the credentials and Claude sees only the output.
- **Scans become inventory safely.** `roster discover` turns an nmap sweep into `roster.yml` entries marked `reviewed: false`. Nothing logs in to them until a person has reviewed them.

## What `roster setup` does on a box

1. Creates an SSH key for that box, tagged with the box's name: one per key type its Hosts use (`key_type:`, Ed25519 unless set; see [FIPS Hosts](adding-hosts.md#fips-hosts)).
2. Records every host's fingerprint.
3. Installs the key on each host that accepts keys, using the password from your password manager once. On an `os: windows` Host, in the file its sshd reads ([Windows Hosts](adding-hosts.md#windows-hosts)); on ESXi, in `/etc/ssh/keys-USER/authorized_keys`, ESXi's own file, kept across a reboot.
4. Writes SSH config entries, so `ssh orion-dev-01` just works.
5. Writes `ROSTER.md`, so Claude knows which hosts exist and how to reach them.
6. Applies the Mesh when `roster.yml` has one (not with `--only`; see [The Mesh](mesh.md)).

## Rotating the Box key: `roster setup --rotate`

`roster setup --rotate` replaces this Box's own key (the Box key, tagged `roster-managed:<box>`) on every Host roster set up, without a moment where the Box can't log in. A Mesh key is another key: `roster mesh --rotate HOST` replaces those, and `setup --rotate` never touches one. Rotate on a schedule or a policy, after a Box may have leaked its key, after copying a VM, or when someone leaves.

1. It makes the new key beside the old (`~/.ssh/roster_ed25519.new`), of the same type and with the same tag, so the Box's name, `key-name` and the Mesh's owner don't change.
2. On each Host, one connection at a time (for networks with an SSH rate limiter): the old key logs in and adds the new key's line, then the new key logs in alone to prove it.
3. Only when every Host it reached proved the new key does anything go: the new key moves into `key_path:`, the ssh config follows, and on each Host, over the new key, this Box's other key lines (each matched by its public key **and** a `roster-managed` tag; never a `roster-mesh:` line, never a line without a roster tag) are taken off. A Host that refused the new key (208) stops the run there: nothing is removed anywhere, the old key stays the key, and running it again once that's fixed goes on.
4. The old private key and its `.pub` are deleted once every Host has lost its line. Until then a Host it couldn't reach (or whose cleanup failed) is **pending**: the old key stays as `~/.ssh/roster_ed25519.old`, this Box's ssh config offers that Host both keys (new, then old) so `ssh NAME` and the Mesh still log in, and `roster check`, `check --box` and plain `roster setup` say `Box key rotation pending on N Hosts` (206) until it's done. `roster setup --rotate` again finishes the pending Hosts.
5. With the rotation complete, setup applies the Mesh as usual (over the new key, without `--rotate`).

`--host NAME` narrows it to a Host or a group (the rest stay pending until a run reaches them); it takes no Host word of its own (`roster setup --rotate esx-02` is an error, never a rotation of everything). `--dry-run` shows what it would do and changes nothing. A Host whose `key_type:` changed in `roster.yml` gets its new type's key and loses the other type's line in the same pass; `--key-type TYPE` with `--rotate` only checks that `roster.yml` gives the Hosts TYPE. Named Inventories that share the key file are rotated together, every one's Hosts getting the new key before any old line goes (the run says so). A Host whose key file has no roster line of the old key (a line written by hand) is said per Host: remove such a line yourself. Windows Hosts go through the same key script, in the file their sshd reads; `enroll: false` Hosts have no key and are skipped.

The rotation keeps a record of what it's doing (`~/.config/roster/key-rotation`): the key files it rotates and the keys it made. A `roster_ed25519.new` or `.old` it didn't make (a backup of your own, say) stops it, naming the file: roster never uses, swaps in or deletes a key file it didn't make, so move such a file away. A run stopped part way is finished by the next one, a swap stopped between its two renames included. If a run's new key (`roster_ed25519.new`) is gone when the next one starts (deleted, or moved aside after a refusal), that run makes another and says so; the record keeps the gone key's public half, and its line is taken off the Hosts it reached with the old key's, so a moved file never keeps logging in. If the record can't be read, `roster check` says so and exits 1, and this Box's ssh config offers every Host both keys until it's sorted out.

Each connection uses a one-Host ssh config of roster's own (`ssh -F`: the Host's address, user and port, roster's known hosts, exactly one key), so the proof is that key alone. It carries the options your own ssh config gives that Host name that decide whether it can be reached at all, as `ssh -G NAME` reports them: `HostKeyAlgorithms`, `PubkeyAcceptedAlgorithms`, `KexAlgorithms`, `Ciphers`, `MACs` and `ProxyCommand`; a `ProxyJump` becomes a `ProxyCommand` running `ssh -W` through the jump host with your own config (in roster's one-Host file the jump host would have no settings). Your `IdentityFile`, `User`, `HostName` and known hosts are never taken.

Once no Host of any Inventory on this Box uses a key type any more, nor holds its line as roster last left them (after `key_type:` changed and `setup` or `setup --rotate` finished on every Host), roster deletes that type's key (`retired key  ~/.ssh/roster_ed25519 (ed25519): …`). Never an Inventory's own key (`key_path:`, the top-level type's), a key without a roster tag, or anything while a rotation is under way or another Inventory's `roster.yml` doesn't load.

Keys are deleted with a plain delete, not overwritten first: on an SSD or a copy-on-write filesystem (btrfs, ZFS, APFS) an overwrite lands on new blocks and leaves the old ones, so it would promise what it can't do. Full-disk encryption is what protects a deleted key there.

**One run at a time.** `setup` (with `--rotate` or without), `revoke` and every Mesh run that writes (`roster mesh`, `mesh cut`, `cut --all`, `mesh leftovers --remove`, and the app's `mesh.apply` and `mesh.cut`) hold one lock for this Box (`~/.config/roster/run.lock`), whichever Inventory they change, as each rewrites `authorized_keys` on the Hosts and two Inventories can hold the same Host. A second one waits a few seconds, then stops with `[205] another roster run (setup --rotate, pid 4242) is changing Hosts: wait for it`. Read-only runs (`check`, `--dry-run`, `mesh status`) never wait. A lock whose run died is free at once (the system lets go of it with the process).

**Key age.** `key_max_age:` (top level of `roster.yml`, on by default at `365d`: the strict end of NIST SP 800-57 Part 1's one-to-two-year cryptoperiod for a private authentication key) makes `roster check --box` (and the app's Health page) warn once this Box's key is older (207), naming `roster setup --rotate`. It takes days (`90d`, or a plain number), weeks (`52w`) or years (`1y`, 365 days), up to `10y`, or `off`. The age is counted from when roster made or rotated the key (`~/.config/roster/key-created`), or the key file's own time for a key made before. roster only warns: it never rotates by itself.

## roster.yml

**Your `roster.yml` is private.** It lives in your team's own private git repo (or only on your box), never in a public one and never in this repo. It names your Hosts, addresses, users and vault items, so it says a lot about your network even though it holds no passwords. roster itself stays generic: anything specific to your team (names, device types, groups) belongs in your `roster.yml`, not in roster's code.

Settings cascade `defaults` → group → host, with the most specific winning. Run `roster init` to get a fully commented example (`roster init --blank` for a short, empty one; [A new Inventory](#a-new-inventory) has the other ways); there is also one at `examples/roster.example.yml`. It may be a plain file or a file in your team's git repo: [A plain file or a team repo](#a-plain-file-or-a-team-repo).

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
| `os` | `windows` for a Windows Host with OpenSSH Server: `setup`, `revoke` and `check` run PowerShell there (the script on stdin) and use the key file sshd reads for that account, and its ssh config shares no connection (`ControlMaster no`). `posix`, or unset, for everything else. Any case; cascades like the rest. `type:` stays a free label: `type: windows` with no `os:` gets warning 154. See [Windows Hosts](adding-hosts.md#windows-hosts) |
| `key_type` | The SSH key type this Box logs in to it with: `ed25519` (the default), `ecdsa` (P-384; `ecdsa-256`, `ecdsa-384`, `ecdsa-521` pick the curve) or `rsa` (3072 bits; `rsa-BITS` for 3072 to 16384, never fewer). Any case. At the top level it's this Box's own key's type (the key at `key_path:`, `~/.ssh/roster_<type>` unless set); on `defaults`, a group or a Host it cascades like the rest, so one FIPS Host doesn't take every Host off Ed25519. Each other type's key is `roster_<type>` beside `key_path:`. An unknown value stops the load, naming the allowed ones. A Mesh source's Mesh key is made of its type too (T245). See [FIPS Hosts](adding-hosts.md#fips-hosts) |
| `mesh` | `true` lets a group's Hosts reach each other (the [Mesh](mesh.md)); `false` keeps a group or Host out of it and out of every Link. Cascades like the rest |
| `mesh_dir` | Where a Mesh source keeps its key, known hosts, ssh config (and, on ESXi, `ROSTER.md`), in place of `~/.ssh/roster-mesh` or ESXi's datastore pick: an absolute path, on ESXi on a datastore. Cascades like the rest. See [`mesh_dir:`](mesh.md#esxi) |
| `seen_as` | The Host's other addresses (one or a list, addresses or networks) that a Mesh peer's `from=` takes beside its `ip`: for a jump Host on several networks or a Host behind NAT. On the Host only. See [`seen_as:`](mesh.md#other-addresses) |

Top-level `key_max_age:` is how old this Box's key may get before `roster check --box` warns that it's due a rotation: `365d` unless set, `90d`, `52w`, `1y`, or `off` ([Rotating the Box key](#rotating-the-box-key-roster-setup---rotate)).

Top-level `links:` add one-way Host-to-Host reach across groups: `- { from: HOST-OR-GROUP, to: HOST-OR-GROUP, both: true, via: HOST }` (`both` makes it two-way; `via` sends it through a jump Host with `ProxyJump`, and the peer's `from=` names that Host's address). See [The Mesh](mesh.md) and [Through a jump Host](mesh.md#through-a-jump-host).

### Networks with an SSH rate limiter

Some networks have a rate limiter (an IPS, a firewall rule) that stops answering SSH for a few minutes after many connections. If yours does, list those networks at the top level of `roster.yml`, so a Host there that doesn't answer gets a fix that says so:

```yaml
rate_limited: [10.0.0.0/8, 192.0.2.7, '2001:db8::/32']   # networks or single addresses; quote IPv6 ones. Empty (the default): none
```

When `roster check HOST`, a Host key scan, Quick Connect or a test login gets no answer (code 42), the fix then reads `10.0.0.5 is in 10.0.0.0/8 (rate_limited: in roster.yml): its SSH rate limiter stops answering for a few minutes after many connections, so wait a few minutes, don't retry in a loop`. A Host whose `ip:` is a name is matched by the address `roster check`'s `dns` step resolved it to (`nas.example.com (10.0.0.9) is in 10.0.0.0/8 ...`). An address outside the listed networks gets no rate-limiter hint; with no list, or a name with no resolved address to match (a key scan, Quick Connect or a test login, which have no `dns` step), the fix says a rate limiter on the network can cause this. Quote an IPv6 entry (`'2001:db8::/32'`): unquoted, YAML reads some as a number (`1:2:3:4:5:6:7:8`) and can't read others at all (`::1`). A network's address can't have host bits set (`10.0.0.0/8`, not `10.0.0.1/8`), and an entry that isn't a network or an address stops the load, naming the key. The app's Session panel never reads `roster.yml`, so it always gives the generic hint; its `:check HOST` names the network.

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
- **One bad service entry doesn't stop the Inventory loading.** A service roster can't use (a bad port or url, an unknown setting or `login:` type, no port or url) is left out, and its Host stays with the rest of its services. `roster hosts`, `roster check` and `roster check --auth` print a warning on stderr for each one, naming the Host and the service, what's wrong and the fix; `roster hosts HOST` lists them under `problems`, and `roster web HOST SERVICE` on that service stops with the same words. Mistakes that aren't about one service (bad YAML, a Host listed twice, a Host without an ip or user, a bad SSH port, `services:` that isn't a mapping) still stop the load.
- `roster hosts HOST` shows each service's login as a reference (`webadmin, auth bw:orion3 web (own login)`), never the password. `roster check --auth` tests every reference in use, service ones included.

### Web APIs with stored logins: `roster web`

`roster web esxi GET /folder` or `roster web orion3 https GET /api/status` sends a request to that service, logged in with its `user`/`auth`. Without SERVICE it uses the host's web UI. The response status goes to stderr and the body to stdout.

- `login: basic` (default) sends HTTP Basic; `login: bearer` sends the `auth` value as a bearer token; `login: none` sends nothing. Generic HTML form logins aren't supported.
- `login: vsphere` (ESXi, vCenter) logs in through the SOAP API, sends the request with the session cookie, then logs out. Send SOAP bodies to `/sdk`, e.g. `roster web esxi POST /sdk -d @call.xml`. The right `SOAPAction` header is added for you.
- `login: unifi` (UniFi OS consoles: UDM, Cloud Key, UniFi OS Server) logs in through `/api/auth/login` and sends the request with the session cookie and CSRF token. The session is kept for up to 10 minutes (never past the token's expiry) in a private file (`0600`, in a `0700` folder) under `$XDG_RUNTIME_DIR/roster/sessions/`, or `~/.cache/roster/sessions/` where there's no `$XDG_RUNTIME_DIR` (macOS, Windows, some containers), so a loop of calls logs in once instead of tripping UniFi OS's login limit (HTTP 429); if the console rejects a kept session, roster logs in again and retries once. Paths: `/api/...` for UniFi OS, `/proxy/network/api/s/default/...` for the Network app, e.g. `roster web unifi GET /proxy/network/api/s/default/stat/health`.
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

  `login: appliance` then works exactly like `login: hub`. Everything roster shows (`roster hosts HOST`, `roster serve`'s Hosts, error messages) gives the type it resolved to (`hub`), so the behaviour is never in doubt; your own word stays in `roster.yml`, and edits made through `roster serve` leave it as it is. A name has to map to one of roster's types and can't be one of them, or the file doesn't load (the message names the key). A service whose `login:` is neither is left out with a warning, like any bad service entry.
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
    title: Lab guest Wi-Fi
```

Every resource has the same fields, plus the fixed fields of its type. Anything else is an error, so every resource of a type looks the same in every view.

| Type | Its own fields | Use for |
|---|---|---|
| (every type) | `title`, `description`, `group` (an existing group), `user`, `auth` | |
| `wifi` | `ssid` (required), `security` (`wpa2` default, `wpa3`, `wpa`, `wep`, `open`, `wpa2-enterprise`, `wpa3-enterprise`), `hidden` | Wi-Fi networks; `auth` is the password (not needed for `open`) |
| `account` | `url` (required) | Website, portal or SaaS logins |
| `secret` | none | API keys, license keys, PSKs |

- `roster hosts --resources` lists them (`--only NAME,TYPE,GROUP`, `--find TEXT`), and `roster hosts NAME` shows every field. Both show where the secret comes from, never the secret itself.
- `roster vault reveal NAME` prints the secret, for a person to type in. `roster vault reveal NAME --wifi` prints a `WIFI:T:WPA;S:…;P:…;;` string instead; pipe it to `qrencode -t ansiutf8` and phones can join by scanning it.
- `roster check --auth` checks resource references too, and ROSTER.md lists resources for Claude. Claude is told never to run `roster vault reveal` and to send the user to it instead.
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

**The vault isn't watched:** roster sees an item added or changed elsewhere only after a sync. `roster vault sync` is the way: it syncs each vault that keeps a local copy and says what changed ([The vault isn't watched](#the-vault-isnt-watched-roster-vault-sync)); `roster vault status` lists the providers here, their state and when each last synced.

**Bitwarden:** run `bw login` (or `roster vault bw --write -- login`) once; [`roster vault bw`](#roster-vault-bw) has the first-time setup, changing a password, and what roster can and can't see. A locked vault is unlocked once per run, using a master password prompt, `BW_PASSWORD`, or an existing `BW_SESSION`; [`roster vault unlock`](#staying-unlocked-roster-vault-unlock) keeps it unlocked for every run on this Box. For headless boxes, set `BW_CLIENTID`/`BW_CLIENTSECRET`.

**1Password:** turn on the 1Password app's CLI integration (Settings > Developer), or `eval $(op signin)` or `OP_SERVICE_ACCOUNT_TOKEN` on a headless box. [`roster vault op`](#roster-vault-op) runs op itself, read-only unless `--write`, and says what roster can and can't see. `roster add --from-vault` reads an `op:` item's URL and username, never its password.

**Where "Save to vault" puts new items** (ticket 35) is a setting, so every Box of a team behaves the same:

```yaml
providers:
  bw:
    save_to: personal                                                # the default
    # save_to: { organization: "My Team", collection: "Infra logins" }  # names or ids
  kp:
    save_to: { group: Hosts }                                        # KeePassXC: "personal" is the top level
```

The app's `init.lua` can set `vault.save_to` for its own Box, which wins, and the add-Host form's **Save to** (or `roster add --save-to-vault --save-to TARGET`) can pick another place for one Host. A name that doesn't resolve is code `64` naming the setting; see `vault.targets` below. Team logins belong in a collection the team shares ([docs/adding-hosts.md](adding-hosts.md#2-add-the-logins-to-the-vault)).

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

## Adding one Host: `roster add`

```bash
roster add NAME --ip ADDR [--user USER] [--auth REF] [--group GROUP] [--enroll | --no-enroll] [--os windows|posix]
           [--title TEXT] [--type TEXT] [--port N] [--from-vault] [--setup] [--dry-run] [-y]
roster add NAME --ip ADDR --user USER --save-to-vault [--save-to TARGET] [--provider bw|kp] [--group GROUP] [...]
           [--setup] [--dry-run] [-y]
roster add --from-vault [--all] [--json] [--mark-seen] [--no-sync] [--group GROUP] [--setup] [--dry-run] [-y]
```

`roster add` puts one Host you already know into `roster.yml`, reviewed, the way the app's add-Host form does: it's the same code (serve's `host.add`), so the two check and write a Host the same way.

- **Where:** under `--group`, an existing group or a new one (made after the last group, and said so); without it, the first group in the file. Only the new Host's lines are added: comments, order and quoting stay byte for byte, and it's written only if the result loads to exactly that Host with nothing else changed. A team repo's `roster.yml` gets it as a Pending change (the note says so: publish it from the app, or commit it); a plain file is saved in place, `roster.yml.bak` beside it ([A plain file or a team repo](#a-plain-file-or-a-team-repo)). It says what it wrote (`backup`, `wrote`), then syncs this Box as `roster sync` does (its ssh config and Claude files), as `roster discover --write` and `roster mesh cut` do: `ssh NAME` works straight away. If the sync fails, the Host stays written and a `warning:` on stderr says why and to run `roster sync`.
- **What it refuses**, writing nothing: a bad name (letters, digits, `. _ -`), a bad address (not an IPv4 or IPv6 address or a DNS name, e.g. a URL; names may hold `_`, as Quick Connect's do, and an IPv6 zone is letters, digits, `_`, `.` and `-`), a name another Host has (81, naming its group), an address and SSH port another Host has (184, naming that Host; `::1` and `0:0::1` are the same address: give `--port` for a second sshd on one machine). Values the Host would inherit anyway (its group's `user:`, `auth:`, `enroll:`) aren't written on it.
- **Asking:** in a terminal it asks for what's missing: the group (the first one is the default), the address, and whether to install this Box's key (`enroll`, the group's setting is the default). With `-y`/`--yes`, or without a terminal, it never asks (not even for the vault's master password with `--from-vault`): a value with a default takes it, and one without (the address; a user or Login when neither the group nor `defaults:` sets one) is an error naming its flag (185).
- **`--from-vault`** (with `--auth bw:ITEM` or `op:ITEM`): fills `--ip` from the item's URI and `--user` from its username, never reading its password. roster first checks that ITEM names exactly one item (`bw get item` with its output thrown away unread, so the password stays in bw), then reads just the two fields (`bw get uri`, `bw get username`). The URI may be a bare address (`10.0.0.5`, `fe80::1`, `nas:2222`) or an `ssh`, `sftp`, `http` or `https` URL; only a bare or `ssh`/`sftp` URI's port becomes `--port`, and only when the address came from the vault too. Any other scheme (`androidapp://`, `mailto:`) gives no address, and roster says so. Flags you give win. Several items matching the name need the item's id in `--auth` (the Bitwarden app shows it; roster won't list them, as that would read their passwords), and an item name starting with `-` is refused before bw runs. **1Password** has no field-only read of an item's URL, so roster takes every item's overview from `op item list` (no password or other concealed value: id, title, vault, URLs and a subtitle roster ignores; `--vault` when `op:VAULT/ITEM` or the provider's `vault:` names one), finds the one ITEM names by its id or title (any case; several, logins or not, need the id: 33), takes its primary URL without any `user:password@`, then its username by that id (`op item get ID --fields label=username`, never `--reveal`; a concealed field there is left out). Providers that can't give these fields without the password (`kp`, `pass`, `env`, ...) are refused (186): give `--ip` and `--user` (or list them with `roster add --from-vault`, below).
- **`--save-to-vault`**: makes the Host's vault item too, as the app's **Save to vault** does (the same code). roster asks for the Host's password on the terminal, twice and hidden, then saves it as the item `NAME ssh` (the [naming convention](adding-hosts.md#2-add-the-logins-to-the-vault)) with the user in its username field and `ssh://ADDR[:PORT]` in its URI field, then writes the Host with `auth: PROVIDER:NAME ssh` (`bw:new-01 ssh`). The password never comes from an argument, an environment variable or a pipe, and is never printed, logged or put on a command line: it reaches Bitwarden inside the item's JSON on `bw create`'s stdin, and KeePassXC on `keepassxc-cli add -p`'s stdin. In order: every check above (nothing is asked yet), the vault unlocked if it's locked and the place to save checked there (so a `--save-to` it doesn't have is refused, naming `--save-to`, before the password is typed), the password, the item, then `roster.yml`, then the vault's sync (`bw sync`, so other Boxes see the item at their next sync), then this Box's sync. The item goes where `save_to:` says (roster.yml's `providers: NAME: save_to:` or the app's `vault.save_to`, see [Where "Save to vault" puts new items](#password-providers)); **`--save-to`** picks another place for this run: `personal`, Bitwarden's `ORGANIZATION/COLLECTION` (names or ids; split at the first `/`) or a KeePassXC `GROUP`. **`--provider`** picks the vault (default: the vault with a master password that `roster.yml`'s Logins use most, as the app's). A locked vault is unlocked once, as anywhere else: in a terminal roster first notes that unlocking Bitwarden here locks the roster app, asks the master password before the new one, and offers to keep it unlocked ([Staying unlocked](#staying-unlocked-roster-vault-unlock)). `-y` still asks the password, and a locked vault's master password (it skips the other questions). If the vault's refusal of the item repeats the password in any form, its words are withheld. Refused, with nothing saved or written: no terminal, or one that can't hide what's typed (223), the two passwords differ or none was typed (224), a vault that can't save (61: 1Password, `env`, `pass`, ...; make the item yourself and give `--auth`), an item of that name already there (60: give `--auth PROVIDER:NAME ssh` to use it), a `--save-to` or `save_to:` that isn't there (64), `--auth` or `--from-vault` with it (a usage error). If writing `roster.yml` fails after the item is saved, it says so and names the item (225): no Host points at it, so delete it in the vault (or keep it and run `roster add NAME --auth PROVIDER:NAME ssh`). `--dry-run` shows the item it would make (name, URI, username, where) beside the lines, asks nothing and saves nothing.
- **`--setup`**: then runs setup for that Host alone (its host key, and this Box's key on it when `enroll` is true; never another Host, even one whose group, type or product is NAME) and `roster check NAME` (a Session to it would open, step by step), and ends with how each went; it exits 1 if either failed. Without it, roster add prints `roster setup --host NAME` and `roster check NAME` as the next step (`--host` is that Host alone, as `--setup`'s is).
- **`--dry-run`** prints what the write would change (`+` the lines it adds, `-` one it replaces, such as a group's `hosts: {}`) and writes nothing.

### Vault items not in roster.yml: `roster add --from-vault`

With `--from-vault` and no NAME, roster add lists the vault items no Login in `roster.yml` names yet, marks the ones that are new since the last run, and in a terminal walks through adding each one. Put a login in the vault, then run it:

```text
$ roster add --from-vault
synced       bw (the previous sync was 3 hours ago)

new          bw:nas-01 ssh
Add it as nas-01  10.0.0.50 port 2200, user admin? [Y/n/edit/skip]
```

- **Which vaults:** each vault `roster.yml` uses (any `auth:` in it: Hosts, groups, `defaults:`, services, `sudo:`, resources) that can list its items without roster reading a password: Bitwarden (`bw`), 1Password (`op`) and KeePassXC (`kp`). Others (`pass`, a `providers:` command, a plugin) are said and skipped; none at all is 188.
- **Synced first:** Bitwarden's vault is synced (`bw sync`) so an item saved a minute ago is there, and roster says how long ago the sync before it was. `--no-sync` skips it.
- **Which items:** login items no `auth:` names by its exact name or id (any case), or for KeePassXC its path or title. New ones are those no earlier run marked seen; `--all` lists every one. Each row suggests a Host: the name from the item's name (`nas-01 ssh` and `nas-01 ssh+web` give `nas-01`; another name has what a name can't hold made `-`), the address and SSH port from its URI (as `--from-vault` reads one, above), the user from its username, and the Login: `bw:NAME`, or `bw:ID` when two items share the name.
- **Never a password.** Bitwarden's CLI has no listing without secrets, so roster pipes `bw list items` straight into its own small filter process, which passes on only each item's id, name, URIs (without a `user:password@` in them), username and revision date; roster never reads what bw prints (decision Q191). Every other Bitwarden listing goes through the same filter: a `bw:` Login that matches several items or none (its near-name suggestions are names only), and saving a new item (#443). 1Password: `op item list`, then `op item get ID --fields label=username` (never `--reveal`) for an item not in `roster.yml`. KeePassXC: `keepassxc-cli ls -R -f`, the entry paths only (its `show` resolves placeholders such as `{PASSWORD}` in a URL or user name, so roster doesn't run it): the walk asks a KeePassXC item's address and user. An item name with a control or escape character is shown and written by its id.
- **The walk** (a terminal, without `-y` or `--json`): `Y` (or Enter) adds the item as shown, through the same checks, write and sync as `roster add NAME` (it asks the group and `enroll` as there; `--group` answers the first for every item), then asks whether to set that Host up now (setup for it alone, then `roster check`; `--setup` does it without asking). `edit` asks the name, address and user first; an item with no username (every KeePassXC one) is asked its user (Enter keeps the group's). `n` adds nothing and marks it seen; `skip` leaves it for next time. An add that's refused is said, and the walk goes on; roster add then exits 1. The end of input stops it. `--dry-run` shows each add without writing.
- **A list:** with `-y`, or without a terminal, it only lists (never adds); `--json` prints `{version, items, unmapped, new}` ([Machine-readable output](#machine-readable-output)).
- **Seen:** what a walk added or you answered `n` to is remembered as seen, per Inventory, in roster's config folder (`vault-seen/`, mode 0600: the items' ids and names only). `--mark-seen` marks every item listed. A list, `-y` and `--json` mark nothing, so a script can ask again.
- **Locked:** it never asks for a master password, not even in a terminal: a locked vault is 14, with how to unlock it (`roster vault bw --write -- unlock`, or the [session file](new-box.md)). KeePassXC has no session to reuse, so give the address and user yourself there (`roster add NAME --ip ADDR --user USER --auth kp:ENTRY`).
- **`roster check --box`** shows the count from the last run (`3 vault items aren't in roster.yml; roster add --from-vault`) without asking the vault.

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
- It then syncs this Box, as `roster sync` does (its ssh config and Claude files). If that fails, the hosts stay written and a `warning:` on stderr says why and to run `roster sync`.

Let your security team know before scanning big ranges.

From the app, the first-party [discover](../plugins/discover/README.md) Plugin does the same scan through `roster serve` (`discover.*`, [serve-api.md](serve-api.md#discover-discoverplan-discoverstart-discoverstatus-discoverstop-discoveradd)): it asks first, shows what answers as it comes in, and adds the Hosts you keep as Pending changes, unreviewed (`:help discover` once it's installed).

## Commands

`roster -v` (or `--version`) prints roster's version. `roster` on its own (or `roster help`, or `roster --help`) exits 0 and lists the 14 commands you type, in groups (Start here, Every day, Inventory and access, Vault and help), with the command lines you'll type most. Everything else is an action or a flag of one of them. `roster help COMMAND` (or `roster COMMAND --help`) shows a command's options and examples, each one checked against the parser by a test. A mistyped command or option gets the nearest real one (`roster hots`: did you mean `hosts`?), and a usage error names the `--help` to read. A usage error never repeats a value you typed (a session token in the wrong place, a word in an unknown option, a clone URL given to `init --inventory`): it names the place (`argument COMMAND`, `argument --port`) and what goes there, and exits 2. `serve` and `askpass` are run by the app and by ssh, not by hand: they work, but the overview and Tab completion leave them out. Older names still work for now; see [Old command names](#old-command-names).

| Command | What it does |
|---|---|
| `init [--blank \| --inventory HOW] [--name NAME]` | Write the commented example `roster.yml` (to `-c PATH`, else `./roster.yml`), or a new Inventory: `--blank` (same as `--inventory blank`) a short one with an empty group and a Host to copy commented out; `--inventory file:PATH` a copy of that `roster.yml`, once it loads; `repo:URL` a `git clone` of the team's repo into `roster.yml`'s folder (empty or new); `ssh-config[:PATH]` the Hosts in `~/.ssh/config` (or PATH): see [A new Inventory](#a-new-inventory). A file already there is kept (170): make the new one in another folder, and `--name NAME` names it (`roster inv add`) |
| `add NAME --ip ADDR […]` | Add one Host you already know to `roster.yml`, reviewed, and syncs this Box, the way the app's add-Host form does (the same code): under `--group` (new or existing; default the first), with `--user`, `--auth`, `--enroll`/`--no-enroll`, `--os`, `--title`, `--type`, `--port`. Asks in a terminal for what's missing; `-y` never asks. `--from-vault` fills the address and user from the `--auth` item, never its password; `--save-to-vault` saves its password (asked twice on the terminal) as a new vault item `NAME ssh` first and points `auth:` at it (`--save-to`, `--provider`); `--setup` then runs setup and check for it; `--dry-run` writes nothing. See [Adding one Host](#adding-one-host-roster-add) |
| `add --from-vault […]` | The vault items no Login in `roster.yml` names, the new ones since the last run marked (synced first; `--no-sync`), and in a terminal a walk adding each [Y/n/edit/skip] the `roster add NAME` way; `--all` every one, `--json` the list, `--mark-seen`. Never reads a password. See [Vault items not in roster.yml](#vault-items-not-in-rosteryml-roster-add---from-vault) |
| `discover CIDR…` | Scan networks; `--write` adds the results to `roster.yml`, then syncs this Box as `roster sync` does |
| `setup` | One-time per box: key, fingerprints, key install, SSH config, Claude files (`--only`, `--host NAME`, `--dry-run`, `--key-type TYPE`, `--rotate`). `--rotate` replaces the Box key on every Host, the new one proven on each before the old one's line goes ([Rotating the Box key](#rotating-the-box-key-roster-setup---rotate)); plain `setup` exits 1 while a rotation is pending. Each Host gets the key of its own `key_type:` (one key per type on this Box, made on first need); a Host whose key type changed gets the new key, and loses the old one only once the new one logs in. `--host NAME --key-type TYPE` tries TYPE on that Host for this run, over `roster.yml` (it needs `--host`): its line goes in beside this Box's line of `roster.yml`'s type, which stays, so the next `roster sync` (which writes `roster.yml`'s type back) still logs in; another try takes the one before off; set `key_type:` to keep it ([FIPS Hosts](adding-hosts.md#fips-hosts)). Where the key already works, a line of this Box's of another type that `~/.config/roster/key-types` records there (a `--key-type` try's, a cleanup that failed) is taken off over the key login (T245). A type change puts the new key's line in, tests it, and only then takes the old type's line off; a Host that refuses the new type keeps the old line. `--host NAME` is exactly the Host by that name, never a group, type or product NAME that `--only NAME` would take too; like `--only` it leaves the Mesh to `roster mesh`. After a rename, it re-tags this Box's key where it works; a Host where another key's line already has the new name fails with 190 and is left as it is, unless `--force` |
| `sync` | Rewrite the SSH config and Claude files after editing `roster.yml`, and sync the vault too, as `vault sync` does (`--no-vault`: the map only). It touches no Host, and ends with what changed and, when something is left, `next:` and the command for it ([When your vault changes](#when-your-vault-changes)). A vault it couldn't sync (locked, offline) is said, never a failure. A Host taken out of `roster.yml` gets a note that this Box's key may still be on it |
| `check [HOST \| --box \| --auth]` | `check`: can this Box reach every Host? `check HOST`: why a Session to one would fail, step by step. `check --box`: this Box's own health, connecting nowhere. `check --auth`: every Login's password source answers. In detail: reachability of SSH (a login running `exit 0`, the same in sh, cmd.exe and PowerShell), web UIs and services, and the Mesh's drift (without `--only`); on an `os: windows` Host whose key works, warnings (157) about its key file. With one HOST: why a Session to it would or wouldn't open, step by step (see [`roster check HOST`](#roster-check-host)). With `--box`: this Box's health, without connecting anywhere (see [`roster check --box`](#roster-check---box)). With `--auth` (was `auth-check`): test every password source in use (SSH, services and resources), connecting to no Host and printing nothing secret; `--only` narrows it, and it takes no HOST or `--box`. `--host NAME` (again for more) checks exactly those Hosts, never a group or type by the name: the line `roster setup` ends with names them. A failed key login gets a line of its own under the table: its cause and its one fix (`new-01: [211] no key on new-01 yet: roster setup --host new-01`, a Host that never answered at its address (209) or stopped answering (210), a key taken off there (212), an account locked or expired (213), a rate limiter or sshd's `PerSourcePenalties` (215)); a Host setup never finished shows `ssh:todo`, not FAIL. One login per Host, never a retry; once a rate limiter drops one (215), the Hosts behind the same one (`rate_limited:` network, else the /24) aren't tried, and each says so. A to-do still makes `check` exit 1 |
| `hosts [NAME…] [--resources] [--find TEXT] [--all] [--long]` | The Hosts and resources in `roster.yml` that you can use: name, IP, user, logins (`ssh (key), web (admin), api`, `wifi`) and title. Unreviewed scanned hosts are hidden unless you pass `--all`, `--find` or `--only`. `--long` shows the full table (type, product, web URL, scan description). `hosts NAME` (was `info`): everything about one Host or resource (for a key Host, `key`: its key type and this Box's key file for it); fuzzy names work (`roster hosts core switch`), and it takes none of the list's flags. `hosts --resources` (was `resources`): only the Wi-Fi networks, accounts and secrets that aren't Hosts, with `--only` taking resource names, types or groups and `--find` searching every field |
| `run [--sudo] HOST -- CMD` | Run a command; password-only hosts get their password from the provider. A Host not in this Box's ssh config yet names `roster sync`; on a Host setup hasn't put this Box's key on (by its record), a failed login in ssh's own words is followed by its cause and fix (`roster: [211] no key on new-01 yet: roster setup --host new-01`); a Login whose vault item is gone, doubled or locked says so with its code and fix. `--sudo` tells sudo's refusals apart: not in sudoers, sudo wanting a terminal (requiretty), or the Login's password refused (a sudo password that differs). `--sudo` runs it as root, handing sudo the login's password (never shown). On an `os: windows` Host CMD always runs under PowerShell, whatever its DefaultShell, with its exit code passed on; `--sudo` there is refused (159). See [Windows Hosts](adding-hosts.md#windows-hosts) |
| `web HOST [SERVICE] METHOD PATH` | HTTP request to a host's web service, logged in with its stored credentials (`-d BODY`, `-H 'Name: value'`, `-k`) |
| `revoke [--all]` | Remove this box's key from every host (its line under any name it had, found by its public key: the key is one per Box, so revoking one Inventory also takes it off a machine another Inventory lists, under any `box_name:`, and says so: `roster setup` for that Inventory puts it back, or use `--all`); it names this box's files to delete (with `~/.config/roster/key-name*`, the name setup recorded for its key's lines) only once every Host of this `roster.yml` has lost the key (never with `--only`, never another `roster.yml`'s `config.d/roster`, and never a key file another Inventory on this Box uses too: that one is kept, with a note naming the Inventory, 221), and exits 1 when a Host was skipped or none was reached. `--all`: from every Inventory's Hosts on this box (each named one and the unnamed one) at once, with one question and one summary; a Host `ssh NAME` doesn't reach (left out, or its Inventory not synced here) is skipped and said. See [Named Inventories](#named-inventories). An unnamed `roster.yml` in a folder that looks like a token, which the ssh config names only by the sha256 of its path, is revoked with the others when it's `$ROSTER_CONFIG`, `./roster.yml` or a named Inventory's file; otherwise it's skipped, never named, and `roster -c PATH revoke --yes` revokes it without renaming its folder. On an `os: windows` Host it cleans both files an administrator's key could be in. A Host it couldn't revoke is listed with why |
| `mesh [--dry-run] [--rotate HOST]` | Set up Host-to-Host access as `mesh:` and `links:` say, one Host at a time: a key made on each source, tagged entries on its peers. A Link's `via: HOST` goes through a jump Host (`ProxyJump`), tested through it. `--dry-run` shows the plan, `--rotate` replaces a Host's Mesh key. `mesh status` shows who reaches whom without connecting; `mesh cut HOST [-y]` takes a Host out everywhere at once and writes `mesh: false` for it as a Pending change, then syncs this Box as `roster sync` does; `mesh cut --all [-y]` takes this Box's Mesh entries (and an older roster's untagged ones) off every Host and leaves `roster.yml` as it is (before removing roster: [Uninstalling roster](mesh.md#uninstalling-roster)); `mesh leftovers` (was `--find-leftovers`) lists the Mesh entries on every Host that this `roster.yml` doesn't ask for (and files by a Mesh key's name in the Mesh's folders that aren't a key roster made, which it never removes), changing nothing, and `mesh leftovers --remove [-y]` (was `--remove-leftovers`) removes them after a question (an older roster's may be another Box's: [Whose Mesh it is](mesh.md#whose-mesh-it-is)); `--json` with `status` or `--dry-run`. See [The Mesh](mesh.md) |
| `inv list\|add NAME PATH\|use NAME\|remove NAME\|which` | Named Inventories, one of them active: list them (`*` marks the active one), name one, make one the active one, forget one (its file stays), or print the `roster.yml` roster uses. See [Named Inventories](#named-inventories) |
| `vault` | roster's own views of the vault, one action each (below); plain `roster vault` lists them. One home per provider: `vault bw` is Bitwarden's own CLI, `vault op` 1Password's |
| `vault status [--json]` | (Was `providers`.) The password providers here (built-in, plugins, `roster.yml`'s), whether their tools are installed and which groups use them, unknown ones in use (exit 1), then each vault's state (installed, logged in, locked or unlocked: the same checks as [`roster check --box`](#roster-check---box)'s Vault section, one source) and when `roster vault sync` last synced each one that syncs ("last synced 3 h ago", or "never synced by roster") |
| `vault sync` | Sync every vault `roster.yml`'s Logins use that keeps a local copy (Bitwarden: `bw sync`; 1Password and the others ask their server or file each time, so it says they need none), then say what changed since the last sync: the items added and changed by name, the removed ones by count. Never a password: see [The vault isn't watched](#the-vault-isnt-watched-roster-vault-sync). Nothing changed: `up to date`. An item added that no Login in `roster.yml` names ends it with `next: roster add --from-vault`, at every sync until `roster.yml` names it or `roster add --from-vault` has listed it. Exits 1 if a sync failed, saying when roster last synced it |
| `vault unlock [PROVIDER]` | Unlock Bitwarden and keep it unlocked for every roster run on this Box: asks the master password (it goes to `bw` in an environment variable, never on a command line), then saves the session key in `~/.config/roster/bw-session` (a new file renamed into place, mode 0600; a file there that's a symlink or isn't yours is refused, 202). It lasts until `roster vault lock`, `bw lock`, or the roster app's lock. Already unlocked by a working saved session: says so, asks nothing; a working `BW_SESSION` in your shell is saved as it is, with no new unlock (which would lock it and the app). Bitwarden only for now (203 for `kp`, which keeps no session, and `op`). It ends with the `next:` line `roster sync` would give, when something is left (a `roster setup` the locked vault held up). See [Staying unlocked](#staying-unlocked-roster-vault-unlock) |
| `vault lock [PROVIDER]` | `bw lock`, then remove `~/.config/roster/bw-session` (even if bw failed or isn't installed; each is reported on its own). bw keeps one unlock at a time, so every bw session on this Box is locked, the roster app's too. Bitwarden only for now (203) |
| `vault reveal NAME [--wifi]` | (Was `reveal`.) Print a resource's secret for a person to type in, not for Claude (`--wifi`: a QR-ready `WIFI:` string) |
| `vault bw [--write] -- BW_ARGS…` | (Was `bw`.) The Bitwarden CLI itself with this box's vault session from `~/.config/roster/bw-session` (never prompts, except `login` and `unlock`), e.g. `roster vault bw -- list items --search web-01`. Read-only unless `--write`: commands that change the vault, write a file on this Box or act on the account need it, and commands roster doesn't know are refused. roster never reads what bw prints. See [`roster vault bw`](#roster-vault-bw) |
| `vault op [--write] -- OP_ARGS…` | The 1Password CLI itself with your op sign-in (the 1Password app's CLI integration, or an `OP_SESSION_*` or `OP_SERVICE_ACCOUNT_TOKEN` in your shell), e.g. `roster vault op -- item list --vault Infra`. Read-only unless `--write`: commands that change the vault or the account, or write a file on this Box, need it; `op run`, `--session` and `--config` are refused; commands roster doesn't know are refused. roster never reads what op prints. See [`roster vault op`](#roster-vault-op) |
| `help [COMMAND…] [--man [--install [--prefix DIR]]] [--completion SHELL]` | `roster help`: the overview. `roster help COMMAND` (`help vault bw`): that command's options and examples, as `--help`. `--man` (was `man`): show the `roster(1)` man page; with `--install` it copies it to `PREFIX/share/man/man1/roster.1`, next to `PREFIX/bin/roster` (`~/.local` after `uv tool install`), where `man roster` finds it; into a prefix you can't write to, it says so and exits 1 (pick `--prefix ~/.local`, or use sudo). `install.sh` does this for you. `--completion bash\|zsh\|fish\|powershell` (was `completion`): print Tab completion for that shell: commands (`roster ho<Tab>` is `roster hosts`), their actions and options, and the names roster knows here: Host names (`roster run <Tab>`, `check`, `hosts`, `web`, `mesh cut`), groups (`--only`, `discover --group`, `add --group`), resources (`vault reveal`, `hosts`) and named Inventories (`--inv`, `inv use`). `install.sh` turns it on for bash, zsh and fish by itself. See [Tab completion](#tab-completion) |
| `serve` | Internal, run by the app: the JSON-RPC API the desktop app talks to, on stdin/stdout (see [`roster serve` API](serve-api.md)) |
| `askpass PROMPT` | Internal, run by ssh: the `SSH_ASKPASS` helper for a `serve` password Session |

`--only` accepts host names, groups, types and products: `roster check --only orion`, `roster setup --only switch,router`. To set up one Host whose name is also a group, type or product, `roster setup --host NAME` takes that Host alone.

`--json` on `hosts` (and `hosts NAME`, `hosts --resources`), `add --from-vault`, `check` (and `check HOST`, `check --box`, `check --auth`), `discover` (its preview), `mesh status`, `mesh --dry-run` and `vault status` prints the same data as JSON for scripts and tools, never a secret: see [Machine-readable output](#machine-readable-output).

Config lookup order: `-c PATH`, then `--inv NAME`, then `$ROSTER_CONFIG`, then `./roster.yml`, then the active named Inventory, then `~/.config/roster/roster.yml`. `--inv NAME` (before the command: `roster --inv home sync`) runs one command against the named Inventory NAME.

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

Key Hosts skip `provider` and `vault-item`. Nothing touches the network once a local step has failed, and a whole check makes at most one TCP connection (port and host key) and one login, so it's safe to run against a network's SSH rate limiter (a no-answer's fix names the network when it's in [`rate_limited:`](#networks-with-an-ssh-rate-limiter)). It prints one line per step (`ok`, `FAIL` with the code, `skip`), then the fix and ssh's own message under a failure, and exits 1 if a step failed. It never prints a password.

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
| ssh | `ssh` is on `PATH`; roster's ssh config is written, included from `~/.ssh/config` and has every Host (else run `roster sync`); this Box's key exists if a Host uses key Logins; roster's known hosts has every Host's key; this Box's name isn't an OS image's default hostname (`ubuntu`, `raspberrypi`, `localhost`, …) that another Box likely shares (row 222) |
| Vault | Each provider the Logins use: its CLI is installed, logged in, and locked or unlocked (from its own status command, as the lock screen asks it) |
| askpass | The askpass channel (the private socket password Sessions get their password through) opens on this Box |
| Infra repo | How `roster.yml` is kept: a plain file (a note, never a warning: every edit saves straight to it), or committed in a git repo with a remote, and then whether it has Pending changes, other uncommitted files, or commits the upstream doesn't have (as last fetched). See [A plain file or a team repo](#a-plain-file-or-a-team-repo) |

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

### `roster vault bw`

`roster vault bw [--write] -- BW_ARGS…` (was `roster bw`, which still works) runs the Bitwarden CLI with this Box's unlocked vault, so a script, another terminal or a Claude session doesn't have to unlock it again. The session comes from `~/.config/roster/bw-session` (used only if it's yours alone: not a symlink, owned by you, only you can read it) or a `BW_SESSION` in your shell, and goes to `bw` in its environment, never on its command line. bw's input and output are your terminal's: roster never reads, keeps or logs what bw prints. It adds `--nointeraction`, so bw never waits for an answer, except for `login` and `unlock`, which ask for the master password themselves. It exits with bw's status (decision Q178).

**Read-only unless you say so.** Read-only means bw changes nothing in the vault and writes no file on this Box. roster checks bw's command against a list and refuses anything else before bw starts:

| Commands | Run |
|---|---|
| `list`, `get`, `status`, `sync`, `generate`, `encode`, `help`, `completion`, `update` | as they are (`sync` updates bw's own copy of the vault) |
| `create`, `edit`, `delete`, `restore`, `move`, `share`, `confirm`, `import`, `send`, `device-approval`; `export` (it writes the whole vault out), `receive` (it saves a Send from anyone's link), `get attachment` (`attachment` in any case, anywhere after `get`) and any command with `--output` (they write a file) | only with `--write` (else error 164) |
| `login`, `logout`, `unlock`, `lock`, `config` (the account, not the items) | only with `--write` (else error 164) |
| `serve` | never: it would hand the unlocked vault to every program on this Box that reaches its port (error 166). Run `bw serve` yourself if you need it |
| anything else (a newer bw's command, a typo) | never (error 165): the list fails closed |

`--write` is roster's, so it goes before bw's command (`roster vault bw --write -- edit item …`, or among bw's options before it, ahead of the `--`); after the command it's refused (165) rather than guessed at. bw's own options before its command (`--pretty`, `--raw`, `--response`, `--quiet`, `--cleanexit`, `--nointeraction`, `--version`) run, as in `roster vault bw -- --pretty list items`; any other option there is refused (165). `roster vault bw --help` is roster's help, `roster vault bw -- --help` bw's. `--session` is refused anywhere (166): roster passes the session in bw's environment, and on a command line other programs can read it. `roster vault bw -- --help edit` still needs `--write`; `roster vault bw -- help edit` doesn't. A refusal names bw's command only when it's one roster knows, and never repeats bw's arguments. roster's `--nointeraction` goes before any `--` among them, so it's always bw's option. On Windows `bw.exe` and npm's `bw.cmd` both work, with the batch file's limits ([On Windows](#on-windows)).

**First-time setup on a Box:**

```bash
roster vault bw --write -- login             # once; bw asks for your email and master password itself
roster vault unlock                          # saves the session in ~/.config/roster/bw-session (0600)
roster vault bw -- status                    # "unlocked"
roster setup
```

On a headless Box, sign in with an API key instead: `export BW_CLIENTID=… BW_CLIENTSECRET=…; roster vault bw --write -- login --apikey`. `roster vault lock` ends the session and removes the file; `roster vault bw --write -- lock` (or `logout`) ends it too, and the file goes stale with it. `roster vault bw --write -- unlock` still works as before: it prints the new key and saves nothing.

### Staying unlocked: `roster vault unlock`

A terminal unlock lasts for that run only: roster keeps the session key in its own memory, so the next `roster run` asks for the master password again. To stay unlocked on this Box, save the session (T241, decision Q203):

```text
$ roster vault unlock
  Bitwarden master password:
unlocked until `roster vault lock`, `bw lock`, or the roster app's lock: saved in ~/.config/roster/bw-session, so other roster runs on this Box don't ask. Any program running as you can use it to read the vault until then
$ roster vault lock
locked; removed ~/.config/roster/bw-session
```

- **The session file** is `~/.config/roster/bw-session` (`%APPDATA%\roster\bw-session` on Windows). `vault unlock` writes it whole or not at all (a new file beside it, mode 0600 under umask 077, renamed over the old one), replacing an expired key. A file already there that isn't yours alone (a symlink, another user's, not a plain file, others may read it), or a `~/.config/roster` that isn't (a folder, or a link you own to one, owned by you that nobody else may write to), or one above it up to your home folder that isn't (yours or root's, nobody else may write to it unless it's sticky, as `/tmp`), is refused before the password is asked (202; Linux and macOS, where the file is made, read back and renamed through one open handle on the folder), and a session file in such a folder is ignored when read: remove such a file yourself, or fix the folder's permissions (`chmod go-w`) first. A working `BW_SESSION` in your shell is saved as it is, without a new unlock. The key is never printed, logged, put on a command line or in `--json`; the master password goes to `bw` in an environment variable and is never stored.
- **The trade-off:** while it's saved, any program running as you can use the file to read the whole vault. That's why it's a command you run, and why `vault lock` removes it.
- **After a terminal unlock** (not with `--json`, not with `BW_PASSWORD`, not under the app), roster asks once, on the terminal as the password prompt is (so `2>/dev/null` doesn't hide it; with no controlling terminal it isn't asked): `Keep the vault unlocked for other roster runs on this Box? [y/N]`. Yes saves it as `vault unlock` does, once `bw status` says the key still works (another run's unlock meanwhile replaces it: then nothing is saved, and the note says why); No (or Enter) prints `note: this unlock lasts for this run only; to stay unlocked on this Box: roster vault unlock`. It isn't asked when a working saved session is there (nothing is asked then).
- **It expires** when the vault is locked: `roster vault lock`, `bw lock`, another `bw unlock` (bw keeps one unlock at a time, so a new one makes the earlier key stop working), and the roster app's lock or unlock (`roster serve` runs `bw lock` and `bw unlock`; the app locks at its lock key, its idle lock and a window load while unlocked). The next run then says `note: the saved Bitwarden session in ~/.config/roster/bw-session has expired (locked since it was saved, e.g. by the roster app's lock or a bw lock/unlock); roster vault unlock saves a new one`. The reverse holds too: `roster vault unlock`, or a terminal unlock, locks the app.
- **`roster vault status` and `roster check --box`** say which it is: `saved session: none (every run asks)`, `saved, working`, `saved, expired` (a warning, fixed by `roster vault unlock`), `saved, ignored` with why (a file roster won't use), or `unknown (bw status failed)`. Their `--json` has it as the check's `saved_session`: `none`, `working`, `expired`, `ignored` or `unknown`. The app's `box.check` never has it: `roster serve` never reads the file.
- **Bitwarden only for now:** KeePassXC keeps no session (each run opens the database with its password), and 1Password's `op signin` keeps its own; `roster vault unlock kp` or `op` says so (203).

**Changing a Host's password:** change it on the Host first, then the vault item roster looks up (its `auth: "bw:esx-02 ssh"`). The Bitwarden app or web vault does it by hand. From a terminal, keep the new password off every command line: type it into a variable only `jq` gets, and let bw read the item on its stdin.

```bash
id=$(roster vault bw -- get item "esx-02 ssh" | jq -r .id)
read -rs NEWPW                               # type the new password; nothing is echoed
roster vault bw -- get item "$id" | NEWPW="$NEWPW" jq '.login.password = env.NEWPW' | roster vault bw -- encode \
  | roster vault bw --write -- edit item "$id"
unset NEWPW
roster check esx-02                          # the stored Login works again
```

Other Boxes get it at their next unlock (roster runs `bw sync` then) or with `roster vault bw -- sync`.

**What roster can and can't see:**

- **It sees** the arguments you give it, to check bw's command (it never prints, logs or keeps them), the session key it passes to bw, and bw's exit status.
- **It never sees** what bw prints (a password from `get`, an item's JSON, the key from `unlock --raw`), what you type at bw's prompts (the master password at `login` and `unlock` goes straight to bw), or what you pipe into bw. Nothing is captured, so nothing can end up in roster's logs or errors. (Outside `roster vault bw`: [`roster add --from-vault`](#vault-items-not-in-rosteryml-roster-add---from-vault) pipes `bw list items` into roster's own filter process and reads only each item's id, name, URIs, username and revision date (as `roster vault sync` does). Resolving a `bw:` Login that matches several items or none, and saving a new item, still read `bw list items` in roster itself, for now.)
- **The session reaches only bw:** never a command line, never another program (no 1Password variable in your shell, `OP_SESSION_*`, `OP_SERVICE_ACCOUNT_TOKEN` or any other `OP_*`, is passed to bw either).
- **What roster can't protect:** whoever runs `roster vault bw -- get` reads its output, a Claude session included; read-only doesn't mean nothing secret. bw's arguments are on its command line, where other programs on this Box can read them (`ps`), so never put a password there: pipe it in, as above.

### `roster vault op`

`roster vault op [--write] -- OP_ARGS…` runs the 1Password CLI, `op`, the way [`roster vault bw`](#roster-vault-bw) runs bw (decision Q197). op signs in through the 1Password app's CLI integration (Windows Hello, Touch ID or your system login), or an `OP_SESSION_*` (from `eval $(op signin)`) or `OP_SERVICE_ACCOUNT_TOKEN` in your shell; roster keeps no 1Password session of its own here, so op gets that sign-in in its environment, never on its command line. op's input and output are your terminal's: roster never reads, keeps or logs what op prints. It exits with op's status.

**Read-only unless you say so.** Read-only means op changes nothing in the vault or the account and writes no file on this Box. op's commands are words (`op item get`, `op vault user grant`), checked against [1Password's CLI reference](https://developer.1password.com/docs/cli/reference/) before op starts:

| Commands | Run |
|---|---|
| `item get`, `item list`, `item template get`, `item template list`, `read`, `inject`, `document get`, `document list`, `vault get`, `vault list`, `vault user list`, `vault group list`, `user get`, `user list`, `group get`, `group list`, `group user list`, `account get`, `account list`, `connect server get`, `connect server list`, `connect token list`, `plugin inspect`, `plugin list`, `service-account ratelimit`, `whoami`, `completion`, `help`; a group alone (`op item`) prints its help | as they are |
| `item create`, `edit`, `delete`, `move`, `share`; `document create`, `edit`, `delete`; `vault`, `user`, `group` and `connect` changes (`create`, `edit`, `delete`, `grant`, `revoke`, `confirm`, `provision`, `suspend`, …); `service-account create`, `events-api create`, `plugin init`, `plugin clear`; `update` and `connect server create` (they write a file here), and any command with `--out-file` or `-o` (`read`, `inject`, `document get`, `item template get`) | only with `--write` (else error 196) |
| `signin`, `signout`, `account add`, `account forget` (the account, not the items) | only with `--write` (else error 196) |
| `run`, `plugin run`, and `--session` or `--config` anywhere | never (error 198): `run` and `plugin run` start another program with your sign-in and secrets in its environment, a session token on a command line is readable by other programs, and `--config` points op at another folder of accounts and sign-ins. Run op yourself if you need them |
| anything else (a newer op's command, an alias such as `ls`, a typo) | never (error 197): the list fails closed |

The command is the words right after `--`, written out in full before any option: `roster vault op -- item get esx-02 --vault Infra`, not `item --vault Infra get` (refused, 197), so op can't take a word roster read as an argument for its command. Before the command only op's own options that take no value run (`--debug`, `--no-color`, `--iso-timestamps`, `-h`/`--help`); put the rest (`--account`, `--format`, `--vault`, ...) after it, where op takes them too. `--write` is roster's, so it goes before op's command (`roster vault op --write -- item edit …`); after it, it's refused (197). `-o` counts in any short-option cluster (`-fo PATH`). A refusal names op's command only when it's one roster knows, and never repeats op's arguments.

```bash
roster vault op -- whoami                               # which account op is signed in to
roster vault op -- item list --vault Infra --categories Login
roster vault op -- item get "esx-02 ssh" --fields label=username
roster vault op --write -- item edit "esx-02 ssh" --vault Infra --title "esx-02 ssh (old)"
```

**What roster can and can't see:**

- **It sees** the arguments you give it, to check op's command (it never prints, logs or keeps them), and op's exit status.
- **It never sees** what op prints (a password from `read` or `item get --reveal`, an item's JSON, the token `signin --raw` prints), what you type at op's prompts, or what you pipe into op.
- **The sign-in reaches only op:** roster adds none (op's own is in your shell or the 1Password app), and no Bitwarden variable in your shell (`BW_SESSION`, `BW_CLIENTSECRET`, `BW_PASSWORD` or any other `BW_*`) is passed to op, as no `OP_*` is passed to bw.
- **What roster can't protect:** whoever runs `roster vault op -- read` reads its output, a Claude session included; read-only doesn't mean nothing secret. op's arguments are on its command line, where other programs on this Box can read them, so never put a password there (`item edit … password=…` does): use the 1Password app, or a template file op reads (`--template`).

### The vault isn't watched: `roster vault sync`

roster doesn't watch the vault. An item added or changed in the Bitwarden app, the web vault or on another Box reaches this Box's copy only at a sync, so roster sees it only after one: `roster vault sync` is the way. It syncs every vault `roster.yml`'s Logins use that keeps a local copy (Bitwarden's `bw sync`; 1Password, KeePassXC and a `providers:` command read their server or file each time, so it says they need none), then says what changed since the last `roster vault sync`:

```text
$ roster vault sync
  ok    bw: synced; since the last sync, 1 added: nas-02 ssh; 1 changed: esx-02 ssh; 2 removed
next: roster add --from-vault (1 new vault item not in roster.yml)
```

`roster sync` runs the same sync (unless `--no-vault`) and puts it on its last line with the map's changes.

Added and changed items are named, removed ones only counted. To tell, it keeps a snapshot per vault in `~/.config/roster/vault-sync/PROVIDER.json` (0600): each login item's id and revision date and when it was taken, never a name, password or any other value. The items come from the same listing as [`roster add --from-vault`](#vault-items-not-in-rosteryml-roster-add---from-vault), which never reads a password. The first sync only counts the items; a sync that fails leaves the snapshot as it was, says when roster last synced it, and exits 1. `roster vault status` says when each vault last synced ("last synced 3 h ago; run `roster vault sync` for what changed"), from the snapshot, without asking the vault. `roster vault bw -- sync` still runs bw's own sync, the raw passthrough, without the report; `roster add --from-vault` syncs first by itself.

### When your vault changes

After a vault or map change there's no set order. Each command catches up what it needs or ends with `next:` and the command that does.

| Command | Catches up | Names when something's missing |
|---|---|---|
| `roster sync` | The map and, unless `--no-vault`, the vault | `roster setup --host NAME`, `roster add --from-vault`, `roster vault unlock` |
| `roster setup` | This Box's key on each Host; its lookup syncs the vault | Each Host it couldn't finish and why; `roster check --host` |
| `roster check` | Nothing: one login per Host | Each failure's cause and fix (no key yet is a to-do) |
| `roster run HOST -- CMD` | Nothing | `roster sync`, `roster setup --host NAME`, a vault item gone or doubled |
| `roster vault sync` | The vault alone | `roster add --from-vault` for a new item; offline, when it last synced |
| `roster vault unlock` | Bitwarden, kept unlocked | What the locked vault held up |

In a terminal, `sync` asks for the master password once, after warning that unlocking locks the roster app. `update.sh` syncs the map only.

### Old command names

The 14 commands came from regrouping older ones (decision Q194). Each old name still works, hidden from `roster --help`, the man page and Tab completion, and says its new form once on stderr; `roster completion`, which an older rc line runs at every shell start, says nothing. With `--json` it says nothing either, so stderr stays JSON. They go away in a later Release ([Deprecated names](deprecated.md#deprecated-in-06)).

| Old | New |
|---|---|
| `roster auth-check [--only LIST]` | `roster check --auth [--only LIST]` |
| `roster info NAME` | `roster hosts NAME` |
| `roster resources` | `roster hosts --resources` |
| `roster providers` | `roster vault status` |
| `roster reveal NAME` | `roster vault reveal NAME` |
| `roster bw ARGS` | `roster vault bw -- ARGS` |
| `roster man [--install]` | `roster help --man [--install]` |
| `roster completion SHELL` | `roster help --completion SHELL` |
| `roster mesh --find-leftovers` | `roster mesh leftovers` |
| `roster mesh --remove-leftovers` | `roster mesh leftovers --remove` |

## A plain file or a team repo

An Inventory is one `roster.yml`, and roster works the same whether it's a plain file or a file in your team's git repo. Which one is decided per file, each time roster writes it:

- **A team repo**: `roster.yml` is committed in a git work tree that has a remote. The app's edits (and `roster add`, `roster discover --write`, `roster mesh cut`) are Pending changes: `:changes` shows them, `:publish` commits `roster.yml` alone and pushes it, `:discard` puts it back, and the app pulls before an edit form. The backup of what an edit replaced is kept in the repo's git dir (`.git/roster/roster.yml.bak`), never in the work tree.
- **A plain file**: anything else (not in a git repo, git not installed, not committed yet, or a repo with no remote to publish to). Every edit is saved straight to the file; there's nothing to pull, discard or publish, and nothing asks for git. The backup is `roster.yml.bak` beside it (in the git dir when it's in a repo).

`roster check --box` (and the app's `:check`) says which, in its Infra repo section. `git init` in the folder is optional: it gives you history to commit by hand, and edits still save in place until the repo has a remote.

## A new Inventory

`roster init` writes the commented example, as always. `roster init --inventory HOW` (or `install.sh --inventory HOW`) gets a new Inventory one of four ways, without a question:

| HOW | What you get |
|---|---|
| `blank` (or `--blank`) | A short `roster.yml` that loads: a header and an empty group `servers` with a Host to copy commented out. A `roster.yml` with no Hosts loads only in this shape (`groups:`, each group with `hosts:`, no unknown top-level key), so an empty file or a typo'd `grups:` is still an error |
| `file:PATH` | A copy of the `roster.yml` at PATH, made only once it has `groups:` and loads (171 if not). To use it where it is instead, point roster at it (`-c PATH`, `ROSTER_CONFIG`, `roster inv add`) |
| `repo:URL` | `git clone URL` into the folder `roster.yml` goes in, which must be empty or new (172); the clone must have `roster.yml` at its top (171). A team repo from the start |
| `ssh-config[:PATH]` | The Hosts in `~/.ssh/config` (or PATH), in a group `imported`: each `Host` block's names, with its `HostName` (its address), `User`, `Port`, and `auth: agent` when it has an `IdentityFile` (named in a comment). Wildcards (`*`, `?`), negations (`!`) and `Match` blocks are skipped, `Include` isn't followed, and no other setting is read, so nothing secret is copied. The ssh config itself is only read, never changed (173 if it can't be). A Host with no `User` gets your login name, as ssh does |

The new file goes to `-c PATH`, else `./roster.yml`, and is private (mode 0600). Every backup roster keeps of it (`roster.yml.bak`) has its mode, and a `.bak` that's a symlink is replaced, never written through. A `repo:` URL's credentials never show in roster's output, and are taken out of the clone's `origin` URL after it (use a credential helper for a token). One that's already there is kept as it is (170): to start another beside it, give another folder and a name, `roster -c ~/home-net/roster.yml init --blank --name home`, which names it as `roster inv add` does. Then run `roster setup`. A `-c PATH` that looks like a token (24 or more letters, digits and `+ / = _ -` in all, or 24 or more of `+ = _ . -`, letters and digits between two `/`; a name ending `.yml`, `.yaml` or `.yml.example` never counts) is refused and not repeated, even where that folder is already there (in an absolute path, only the folders up to the current folder or your home folder are left out of the test): an op session token typed as `roster -cTOKEN init` would otherwise become a file named after it.

## Named Inventories

One person may have several Inventories: the team's for work, and their own for home (a Raspberry Pi, the router). They stay separate files (one file would show your home hosts to your teammates and mix two sets of vaults). Name each one on your Box; one is active:

```sh
roster inv add work ~/infra/roster.yml       # the first one named becomes the active one
roster inv add home ~/home-net/roster.yml
roster inv list                              # * work  /home/you/infra/roster.yml
roster --inv home setup                      # one command against home; work stays active
roster inv use home                          # home is the active one now
```

- **Which file roster uses.** `-c PATH`, `--inv NAME`, `$ROSTER_CONFIG`, `./roster.yml`, the active named Inventory, then `~/.config/roster/roster.yml`. `roster inv which` prints the file roster would use; the app asks roster the same. With no named Inventories nothing changes.
- **This Box's files, one set per Inventory.** `setup` and `sync` write each named Inventory's own ssh config (`~/.ssh/roster-inventories/NAME`) and known_hosts (`~/.ssh/roster_known_hosts-NAME`), and `ROSTER.md` next to its `roster.yml`, so syncing home never touches work's. `~/.ssh/config` includes one file, `~/.ssh/config.d/roster.inventories`, that holds every Inventory's Hosts, the active one's first: `ssh pi` works for a Host in any of them. When two have a Host by the same name, only the active one's is there (ssh would offer the other's key too), the warning below says so, and roster won't `run`, `check` or `setup` the other one by that name until its Inventory is the active one. The same goes for an Inventory not synced on this Box (`roster --inv home …` or `-c PATH` before its first `sync` here) and a Host added since the last `sync`: `run`, `check`, `revoke` and the Mesh never `ssh` a name that isn't in that Inventory's part of this Box's ssh config, and say to sync first. A `roster.yml` that isn't named shares one ssh config file (`~/.ssh/config.d/roster`) with every other unnamed one, so `roster -c B.yml …` reaches no Host by name while that file was last written from another `roster.yml`: `roster -c B.yml sync` writes it for B. This Box keeps one key for all of them.
- **The same machine in two Inventories** is a warning, never an error. `roster check --box`, `setup` and `sync` compare host-key fingerprints, Host names and addresses across your named Inventories: rows 188-195 of the [error catalog](app/errors.md#named-inventories).
- **Host keys carry over.** Each Inventory you name starts with a copy of `~/.ssh/roster_known_hosts`, so nothing is trusted on first use again. `roster inv remove NAME` forgets the name and its ssh config and sets its known_hosts aside (`roster_known_hosts-NAME.removed-…`); its `roster.yml` stays. After removing the last one, run `roster sync`.
- **Mesh state, one per Inventory.** What `roster mesh` remembers (pending Hosts, cuts pending, the last apply) is `~/.config/roster/mesh-NAME.json` for a named Inventory and `mesh.json`, as always, for one that isn't named, so a Host name in two Inventories never mixes their Meshes. Naming the Inventory the Box's `mesh.json` is from moves it there, once, when all of these hold: roster's unnamed ssh config was last written from that file, every Host the state names is in it, and its last complete apply was of that file's Mesh as it is now. Otherwise `inv add` says it stays with the unnamed Inventory, and why (move it by hand if it is that file's). `roster inv remove NAME` sets its Mesh state aside (`mesh-NAME.json.removed-…`).
- **Removing this Box from them all.** `roster revoke` works on one Inventory (`roster --inv home revoke`). The key is one per Box, so it also takes the key off a machine another Inventory lists (under any `box_name:`), and says so (`note: nas-1: also took this Box's key line tagged roster-managed:…`); run `roster setup` for that Inventory to put it back, or use `revoke --all`. `roster revoke --all` removes this Box's key from every named Inventory's Hosts and the unnamed one's (the file roster's unnamed ssh config was last written from), with one question and one summary. It reaches each Host by the name `ssh NAME` takes to that Inventory's Host: a left-out Host is skipped (the other Inventory's Host by that name is revoked with its own), and so is an Inventory not synced on this Box, which it says, exiting 1. When anything was skipped or failed, it says to revoke those first instead of naming the files to delete; the unnamed one is labelled `(unnamed)`.
- Names are letters, digits, `.` `_` `-`, not ending with a dot, and two names can't differ only in letter case (they'd share files on Windows and macOS). An unknown name is repeated in the error (`no Inventory named 'hom'`), unless it looks like a token (24 or more letters, digits and `+ / = _ . -`): then it's "no Inventory named that (not repeated)". The list lives in `~/.config/roster/inventories.json` (`%APPDATA%\roster\inventories.json` on Windows), never in `init.lua` or a `roster.yml`. Each Inventory keeps its own folder, as `ROSTER.md` is written next to it.

## Machine-readable output

The read commands take `--json`, for scripts, other tools and Claude: `hosts` (with `--only`, `--find`, `--all`), `add --from-vault` (no NAME: the list), `hosts NAME`, `hosts --resources`, `check`, `check HOST`, `check --box`, `check --auth`, `discover` (its preview, without `--write`), `mesh status`, `mesh --dry-run` (the plan) and `vault status`. The CLI is roster's interface for other apps; `roster serve` is the desktop app's own backend, not a public API. With `--json`, stdout is one JSON document on one line, with no colour, table or warning, and the exit status is the same as without it.

- **Never a secret.** Logins are references: the provider and the item (`bw:esx-02 ssh`, `op:Lab/esx-02`, `prompt`, `agent`). A `cmd:` or `env:` reference says how a secret is fetched, and a password pasted into a `cmd:` line would show, so each one is cut to its kind (`cmd:`, `env:`) everywhere in the output, error messages and check messages included, the way Plugins get them: a `cmd:` one to the end of its line, an `env:` one its variable's name, wherever one starts a text or follows a space, a quote or one of `=:,({[`. An error message keeps a trailing `(code N)`. The cases both implementations are tested against are in `tests/vectors/redaction.json`. `check --auth --json` fetches every secret it tests and says only whether it was found. `vault reveal` has no `--json`: it's for a person.
- **One shape.** A Host, a group and a resource are the objects `roster serve` answers with (`hosts.list`, `host.get`; [the serve API](serve-api.md) lists their fields): every field `roster.yml` resolves to, with `ssh: {user, port, auth}`, `login: {user, auth}`, `services` by name, and `problems`, the service entries left out (the warnings the table prints on stderr).
- **A version.** `version` is the first field of every document, errors included. It is `1` now.
- **Errors** go to stderr as `{"version": 1, "error": {"code", "message", "fix"}}`, with nothing on stdout. The codes are `roster serve`'s: `1` `roster.yml` wasn't found or doesn't load (`fix` says where), `2` no Host or resource by that name, `3` any other refusal. Wrong arguments are code `3` too, with exit status 2. A refusal serve has its own code for keeps it: `121` too many addresses for `discover`, `110` a `--rotate` Host that isn't a Mesh source, `140` an `--inv` that isn't a named Inventory, and one printed as `error: [N] ...` without `--json` is code `N`, its message without the `[N]`.
- **What's a breaking change:** removing or renaming a field, changing its type or what it means, or changing an exit status. Those come with a new `version` and a line under **Breaking** in [What's new](news.md). A new field or a new command with `--json` isn't one, so read the fields you need and ignore the rest.

| Command | stdout |
|---|---|
| `add --from-vault --json` | `{version, items: [{provider, id, name, auth, new, host?, address?, port?, user?, note?}], unmapped, new}`: the new items (every one with `--all`) no Login names, the Host each suggests and the Login to write; `unmapped` and `new` count them all. Never a value. Errors: `14` locked, `187` the listing failed, `188` no vault to list |
| `hosts --json` | `{version, hosts: [Host], resources: [resource], groups: {name: {title, description}}, hidden}`. Hosts and resources in `roster.yml` order, filtered as the table is; `hidden` counts the unreviewed Hosts left out (`--all` shows them). Exit 1 when `--find` matches nothing |
| `hosts NAME --json` | `{version, host: Host, group}` or `{version, resource: resource, group}`; `group` is `{name, title, description}`, or `null` for a resource with none |
| `hosts --resources --json` | `{version, resources: [resource]}`. Exit 1 when `--only` or `--find` matches nothing |
| `check --json` | `{version, hosts: [{name, ok, ssh, checks, problem}], mesh, ok}`: `checks` is `{ssh: bool, SERVICE: bool, ...}`, `ssh` says what was tested (`login` with this Box's key, `port` for a password-only Host). `problem` is a failed key login's cause, `{code, message, fix}` (codes 209-215, or the `check HOST` step codes; `null` when it logged in): the same words as the plain output, never a value. `mesh` is the drift (the plan `roster mesh --dry-run` would show), or `null` with no Mesh or with `--only`. `rotation_pending`, `rotation_problems` (T240) and `key_type_drift` (`{host: why}`, 219: a Host holding this Box's line of another type than `roster.yml`'s, T245) fail it too. Exit 1 unless `ok` |
| `check HOST --json` | `{version, host, ok, steps: [{step, status, message, code?, fix?, details?, data?}]}`, as `host.check`: `status` is `ok`, `fail` or `skipped`. An unknown Host is a failed `inventory` step (code 2), not an error. Exit 1 unless `ok` |
| `check --box --json` | `{version, checks: [{section, level, message, fix?, topic?, saved_session?}], ok}`, as `box.check`: `level` is `ok`, `warn` or `error`; `saved_session` on a Bitwarden Vault check is `none`, `working`, `expired`, `ignored` or `unknown` ([Staying unlocked](#staying-unlocked-roster-vault-unlock); never in `box.check`). Exit 1 if one is an `error` |
| `discover CIDR... --json` | `{version, targets, addresses, ports, scanner, count, quiet, found: [Found], group}`: the preview, after the scan. `targets`, `addresses` (how many it visits), `ports` (how many) and `scanner` (`nmap` or `built-in`) as `discover.plan`; `count`, `quiet` and `found` as `discover.status` (a Found is `{address, name, type, hostname, title, web, known, added, vendor, os, mac, ports}`: `name` the name `--write` would give it, `null` when `known` names the Host already at that address; `added` is always `null` here). `group` is the group `--write` would add the new ones to. Not with `--write` (exit 2). Over 4,096 addresses without `--force`: error `121`. A `roster.yml` that's there but doesn't load (named by `-c`, `ROSTER_CONFIG` or found in the usual places): error `1` with its fix; with none at all (or `ROSTER_CONFIG` naming no file) it scans anyway |
| `inv list --json` | `{version, active, inventories: [{name, path, active, exists}]}`, as `inventories.list` |
| `inv which --json` | `{version, path, name, exists}`: the `roster.yml` roster uses and its name among the named Inventories (`null` if it isn't one). Exit 1 if it isn't there |
| `mesh status --json` | `{version, links, excluded, reach, members, pending, cut_pending, out_of_date, warnings}`, as `mesh.status` |
| `mesh --dry-run --json` | `{version, applied: false, links, hosts: [{host, changes, status, error?}], excluded, reach, pending, already, warnings}`, as `mesh.plan`: it connects to the Hosts, one at a time, and changes nothing. Exit 1 if a Host is `pending` (didn't answer). `--json` goes with `status` and `--dry-run` only, never with an apply or `cut` |
| `vault status --json` | `{version, providers: [{name, kind, help, tool, installed, used_by}], unknown, ok, vault: [{section, level, message, fix?, topic?, saved_session?}], last_sync: {provider: time}}`: `vault` is the Vault section of `check --box --json`, `last_sync` when `roster vault sync` last synced each provider that syncs (`null`: never); `tool` is the CLI it runs (`null` for none, and `installed` `null` with it), `used_by` the groups whose Logins use it, `unknown` the providers `roster.yml` names that aren't set up. Exit 1 if there's one |
| `check --auth --json` | `{version, logins: [{group, auth, users, used_for: [{service, hosts}], status, error?}], ok}`: one row per Login reference and group; `status` is `ok` (a value was found; it isn't tested against a Host), `fail` (with `error`) or `ask` (`prompt`). Exit 1 if one failed |

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
$ roster hosts nope --json
{"version": 1, "error": {"code": 2, "message": "unknown host or resource 'nope'", "fix": null}}   (on stderr, exit 1)
```

## Tab completion

`install.sh` turns it on without asking (`--no-completion` leaves it off): a line marked `# roster: completion` in `~/.bashrc` and `~/.zshrc` (each one that's there, and your login shell's), and fish's `~/.config/fish/completions/roster.fish`. `uninstall.sh` removes them. By hand, one line in your shell's startup file:

| Shell | Line |
|---|---|
| bash (`~/.bashrc`) | `eval "$(roster help --completion bash)"` |
| zsh (`~/.zshrc`, after `compinit`) | `eval "$(roster help --completion zsh)"` |
| fish | `roster help --completion fish > ~/.config/fish/completions/roster.fish` (once) |
| PowerShell (`$PROFILE`) | `roster help --completion powershell \| Out-String \| Invoke-Expression` |

Each script is short: on every Tab it asks roster (`roster __complete`, hidden) what fits, and roster answers from its own command list, so a new command or option completes without a new script. Names come from the local `roster.yml` (the one `-c` or `--inv` on that line picks, else the usual lookup) and the named Inventories' list, read as plain YAML: no network, no vault, nothing written. A missing or broken `roster.yml` completes no names, and no error is shown. A path (`-c`, `inv add NAME PATH`) is the shell's own file completion, and the new name in `inv add NAME` completes nothing (an existing one would only clash). Only the commands you type are offered: not `serve` or `askpass`, and not the [old names](#old-command-names). The marked line `install.sh` writes runs `roster help --completion bash`, falling back to the older `roster completion bash`, so a box (or a dotfile shared with one) that still has an older roster keeps completing. A line from an older `install.sh` (`roster completion bash` alone) still works, silently; `./update.sh` rewrites roster's own marked line to the new one once the new roster is installed (if that install failed, the line stays as it is), and says so when it can't write the file.

## Files

| File | What it is |
|---|---|
| `./roster.yml` | The Inventory: hosts, groups, resources and vault references, never passwords. roster looks for it in this order: `-c PATH`, `--inv NAME`, `$ROSTER_CONFIG`, `./roster.yml`, the active named Inventory, `~/.config/roster/roster.yml` (`%APPDATA%\roster\roster.yml` on Windows) |
| `~/.config/roster/` | This box's roster folder (on Windows, `%APPDATA%\roster`, next to the app's `init.lua`): `roster.yml` if you keep it here, `providers/` for provider plugins, `bw-session` |
| `~/.config/roster/bw-session` | A saved Bitwarden session (`bw unlock --raw`), used only if it's yours alone: not a symlink, owned by you, and only you can read it (on Windows: owned by you, and nobody but you, SYSTEM and Administrators may open it) |
| `~/.ssh/roster_ed25519` | This box's SSH key (`key_path:` in `roster.yml` moves it), made by `roster setup` |
| `~/.ssh/roster_ecdsa`, `roster_rsa`, `roster_<type>` | This box's key of another key type, for the Hosts whose `key_type:` asks for it, beside `key_path:` (one per type, the same `roster-managed:<box>` tag), made by `roster setup` on first need ([FIPS Hosts](adding-hosts.md#fips-hosts)) |
| `~/.ssh/roster_ed25519.new`, `.old` | During a Box key rotation: the new key before it takes `key_path:`'s place, and the old one, kept only while a Host is pending, then deleted ([Rotating the Box key](#rotating-the-box-key-roster-setup---rotate)) |
| `~/.config/roster/key-rotation` | The Hosts a Box key rotation is pending on (a named Inventory's: `key-rotation-NAME`); gone once it's done |
| `~/.config/roster/key-types` | The key types of this Box's lines on each Host, as `roster setup` (and a rotation) last left them (a named Inventory's: `key-types-NAME`; T245): `check` and `sync` warn (219) when a Host holds another type than `roster.yml`'s, and `revoke` takes its Hosts off |
| `~/.config/roster/setup-left` | The Hosts the last `roster setup` that reached them didn't finish, by name (a named Inventory's: `setup-left-NAME`), so `sync` and `vault unlock` name `roster setup --host` for them; gone once none is left |
| `~/.config/roster/key-created` | When roster made or rotated each of this Box's keys, for `key_max_age:` |
| `~/.config/roster/run.lock` | The lock one run that changes Hosts at a time holds, one for every Inventory on this Box: its pid and command, nothing secret (`run-NAME.lock`, an older roster's lock per Inventory, isn't used any more) |
| `~/.ssh/roster_known_hosts` | Host keys recorded on first contact (a named Inventory's: `~/.ssh/roster_known_hosts-NAME`) |
| `~/.ssh/config.d/roster` | The SSH config entries `roster setup` and `roster sync` write (a named Inventory's: `~/.ssh/roster-inventories/NAME`). Its first line names the `roster.yml` it was written from; one in a folder that looks like a token as `the roster.yml at that path (not repeated), sha256 of its path DIGEST`: a digest of the path, so roster knows the file again, neither a secret nor a checksum of the file's content |
| `~/.ssh/config.d/roster.inventories` | With named Inventories: what `~/.ssh/config` includes, every Inventory's Hosts with the active one's first (a name an earlier one has is left out) |
| `~/.config/roster/vault-sync/PROVIDER.json` | What `roster vault sync` compares against (0600): each login item's id and revision date and when it was taken, never a name or value ([The vault isn't watched](#the-vault-isnt-watched-roster-vault-sync)) |
| `~/.config/roster/inventories.json` | The named Inventories and which one is active (`roster inv`) |
| `~/.config/roster/vault-seen/` | Per `roster.yml`, the vault items `roster add --from-vault` has seen (0600): ids and names, never a value |
| `~/.config/roster/inventory.create.lock` | Held while the app's first run makes an Inventory, so two windows can't both make one |
| `ROSTER.md`, `CLAUDE.md`, `.claude/settings.json` | What Claude reads, written next to `roster.yml` by `setup` and `sync` |
| `~/.config/roster/mesh.json` | What `roster mesh` couldn't finish (pending Hosts, cuts pending) and when it last applied, on this box (a named Inventory's: `~/.config/roster/mesh-NAME.json`) |
| `~/.ssh/roster-mesh/` (or the Host's `mesh_dir:`; on ESXi, `.roster-mesh` on a datastore), `~/ROSTER.md` (on Hosts) | A Mesh source's key, known hosts, ssh config and its peers for Claude, written by `roster mesh` ([The Mesh](mesh.md)) |
| `$XDG_RUNTIME_DIR/roster/` | Short-lived private state: kept web logins and the askpass socket (on Windows, the askpass channel is a named pipe and its folder is in `%TEMP%`). Without `$XDG_RUNTIME_DIR`, kept web logins go in `~/.cache/roster/sessions/`, which survives a logout: each one is deleted when it's found expired (10 minutes at most) or rejected |

## Environment

| Variable | What it does |
|---|---|
| `ROSTER_CONFIG` | The `roster.yml` to use when neither `-c` nor `--inv` is given (it comes before the active named Inventory) |
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
- roster finds every program it runs (`ssh`, `bw`, `git`, `nmap`, …) on `PATH` alone, never in the current folder, which Windows itself looks in first: a `bw.exe` or `ssh.cmd` in the folder you start roster from is never run. A relative `PATH` entry (empty, `.`, or `\tools` with no drive) is skipped for the same reason, and only `.com`, `.exe`, `.bat` and `.cmd` count. roster also sets `NoDefaultCurrentDirectoryInExePath=1` for itself, so a `cmd:` provider or a `providers:` command, which `cmd.exe` runs, and the programs roster starts don't look there either. git is `git.exe` when there is one, ahead of a `git.cmd` shim.
- `bw-session` is used only if it's yours alone: owned by you (or Administrators), not a link, and nobody but you, SYSTEM and Administrators may open it (what a file in your own `%APPDATA%` gets). One you've shared with others, say with Everyone or Users, is ignored with a warning.
- Write `bw-session` as plain text, in PowerShell: `bw unlock --raw | Set-Content -Encoding ascii -NoNewline $env:APPDATA\roster\bw-session`. A file Windows PowerShell 5.1's `>` wrote (UTF-16) or one with a UTF-8 byte-order mark works too; one that isn't a session key (anything but plain ASCII) is ignored with a warning.
- A vault CLI installed as a batch file (npm installs `bw` as `bw.cmd`) runs through `cmd.exe`, so roster won't pass it an argument with `"`, `%`, `^`, `&`, `|`, `<`, `>` or `!` in it: rename the item, or install the tool as an `.exe`.
- Signing the vault in from the app with a password or SSO drives `bw login` on a pseudoconsole (ConPTY, Windows 10 1809 or later), as Linux does on a PTY. For SSO, bw opens the sign-in page in your default browser itself, so the app has no link to show or copy, and `ROSTER_NO_BROWSER` can't stop it opening there.
- Commands that run a shell script on this machine (a `cmd:` provider, a provider's `command:`) run it with `cmd.exe`.

## Exit status

| Status | Meaning |
|---|---|
| `0` | Success |
| `1` | An error (roster prints it on stderr, starting `error:`), a check that failed, or a web request answered with HTTP 400 or above |
| `2` | Wrong arguments |
| `130` | Interrupted with Ctrl+C |

With `--json`, the status is the same, and an error is JSON on stderr ([Machine-readable output](#machine-readable-output)). `roster run` exits with the remote command's status, `roster vault bw` with `bw`'s, and `roster vault op` with `op`'s. `roster mesh` and `roster mesh cut` (`--all` too) exit 1 while a Host is pending, and `mesh leftovers [--remove]` when a Host didn't answer. `roster check` and `roster revoke` exit 1 when a Host was skipped (`ssh NAME` doesn't reach it from this Box) or none was checked or revoked. A `roster discover --write` or `roster mesh cut` whose sync of this Box failed afterwards keeps its edit and its exit status, and says so on stderr: ``warning: this Box's ssh config didn't follow roster.yml (why): run `roster sync` on this box``.

## Examples

```sh
roster init                              # write a commented roster.yml to start from
roster init --blank                      # ... or a short, empty one (--inventory ssh-config: your ~/.ssh/config's Hosts)
roster setup --dry-run                   # which hosts would get this box's key
roster hosts --find esx                  # search names, titles, types, addresses
roster hosts esx-02                      # everything about one host
roster check esx-02                      # why a Session to esx-02 would or wouldn't open
roster check --box                       # this Box's health: roster.yml, ssh, vault, infra repo
roster run esx-02 -- uptime              # run a command with the stored login
roster web esx-02 GET /api/status        # an HTTP request, logged in
roster add nas-01 --ip 10.0.5.50 --auth bw:nas-01 --setup   # one Host you know, then set it up
roster discover 10.0.5.0/24              # scan a network, preview only
roster vault reveal lab-guest --wifi | qrencode -t ansiutf8
```

## How Claude uses it

`roster setup` and `roster sync` write three things:

- **`ROSTER.md`** holds the hosts table (or a summary for big inventories), how to connect, and rules. The rules tell Claude to:
  - never read keys or fetch passwords,
  - ask before changing state on a host,
  - ask you to unlock a locked password manager rather than trying itself,
  - leave unreviewed hosts alone,
  - run `roster check NAME --json` when a host doesn't respond, and report which step fails.

  It also tells Claude to use `--json` (`roster hosts --json`, `roster hosts NAME --json`, `roster check HOST --json`) when it needs to read roster's data rather than show it.
- **`CLAUDE.md`** gets an `@ROSTER.md` line added, and its existing content is kept.
- **`.claude/settings.json`** gets deny rules for reading and editing `~/.ssh`. These are a guardrail, not a wall.

For Bitwarden, `(umask 077; bw unlock --raw > ~/.config/roster/bw-session)` lets every roster run on this box use the unlocked vault, including Claude sessions that don't inherit your shell's environment, and `roster vault bw …` runs other `bw` commands with it, read-only unless `--write` ([`roster vault bw`](#roster-vault-bw)). roster ignores the file, with a warning, unless it's yours alone: a plain file, not a symlink, owned by you, that only you can read. `bw lock` ends the session, and the file goes stale with it.

For password-only gear, start Claude from a shell where your password manager is unlocked, for example `export BW_SESSION=$(bw unlock --raw)`. `roster run` can then fetch the password without Claude ever seeing it.

Web UIs: Claude won't type passwords into login pages. Sign in once in the browser Claude uses.

## Security model

- **Each box gets its own key** (one per key type its Hosts use: `key_type:`, Ed25519 unless set). Every one is tagged `roster-managed:<box>` in `authorized_keys`, so `revoke` removes this box's lines of every type, and running `setup` after a Host's type changed puts the new key in place of the old one; running `setup` again replaces it cleanly. Both also find this box's own public key under an earlier name (`box_name:` changed), with options before it or not: `setup` re-tags it in place, `revoke` removes it, and a line with another key is never touched; renaming onto a name another key's line has on a Host stops there (190) unless `setup --force`. Keys tagged `fleet-managed` by the earlier script are recognized too.
- **The key has no passphrase,** so automation can use it. Anyone with access to the box can reach the fleet, so treat these boxes accordingly.
- **Rotate it.** `roster setup --rotate` puts a new key on every Host, proves it there, takes the old key's lines off and deletes the old private key; `check --box` warns once the key is older than `key_max_age:` (365 days unless set). See [Rotating the Box key](#rotating-the-box-key-roster-setup---rotate).
- **Host fingerprints are recorded on first contact** in `~/.ssh/roster_known_hosts`.
- **Passwords exist only in memory,** for one run.
- **`--json` output holds no secret:** Logins are references, and `cmd:` and `env:` ones are cut to their kind ([Machine-readable output](#machine-readable-output)).
- **Scanned hosts are never touched until you mark them reviewed.**
- **At larger scale,** consider an SSH certificate authority, so new boxes only need their key signed instead of installed everywhere.

## See also

[Set up a Box](new-box.md) · [Add your Hosts](adding-hosts.md) · [The roster serve API](serve-api.md) · [All the docs](README.md)
