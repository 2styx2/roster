# Adding hosts and their logins

The usual flow for bringing a new network or box into roster: scan it, review it, point each host at its vault item, then prove each login works. Passwords stay in the vault the whole time. `roster.yml` only gets the item's name.

`roster.yml` may be a plain file (your own, on this Box) or a file in your team's git repo: every step here works the same on both ([A plain file or a team repo](cli-reference.md#a-plain-file-or-a-team-repo)). No `roster.yml` yet? `roster init --blank` writes a short, empty one, and `roster init --inventory ssh-config` starts it from the Hosts in your `~/.ssh/config` ([A new Inventory](cli-reference.md#a-new-inventory)).

## 1. Scan the network

```bash
cd ~/infra
roster discover 10.0.0.0/24             # preview, nothing written
roster discover 10.0.0.0/24 --write     # adds a discovered-YYYYMMDD group
roster discover 10.0.0.0/24 --json      # the preview as JSON, for a script
```

`--write` does the following:

- Adds new hosts to the group with `reviewed: false`, `user: CHANGE-ME` (unless `defaults:` sets a user) and `auth: prompt`.
- Keeps your comments and saves what it replaced as `roster.yml.bak` (beside it; in a team repo, in its git dir, so it's never committed).
- Never overwrites hosts that are already in the file.
- Refuses to write a file that wouldn't load.

Each host gets a guessed `type`, a `title` from its web page, its services, and a description of every open port.

From the app, the first-party [discover](../plugins/discover/README.md) Plugin does the same scan: `:discover 10.0.0.0/24`, keep the Hosts you want, and they're added unreviewed: as Pending changes for you to Publish in a team repo, saved straight to a plain file.

Tell your security team before scanning big ranges.

## 2. Add the logins to the vault

Make one vault item per distinct login. Several hosts can point at the same item.

**Name it `<roster host name> <what it opens>`**, so the item name and the host in `roster.yml` match:

| Login | Item name | Example |
|---|---|---|
| SSH | `<host> ssh` | `orion3 ssh` |
| Web UI | `<host> web` | `vpn-02 web` |
| API or another service | `<host> <service key>` | `esxi-02 api` |
| One password for several things | join them with `+` | `esxi-02 ssh+web` |
| Shared by several boxes | `shared <role> <what>` | `shared hub web` |
| Resource (Wi-Fi, account, secret) | `<type> <name>` | `wifi lab-guest` |

- **Use the host name exactly as `roster.yml` spells it**: lowercase, not shortened. `hub2 ssh` and `lab-hub2 ssh` are different machines. If you rename a host, rename its items too.
- **Put the address in the item's URI field, not in its name.** Names then stay put when an address changes, and you can still look up the IP.
- **Put the username in the item's username field.** roster reads it as `#username`.
- **Names must be unique.** roster looks items up by exact name, so two items with the same name make both logins fail with `several Bitwarden items match`.

**Team logins belong where the team can see them.** An item in your personal Bitwarden vault works only for you: a teammate's Box looks the same `bw:orion3 ssh` up and finds nothing. Put logins that everyone uses into an organization collection the team shares, and keep the personal vault for what's yours. "Save to vault" (the app's add-Host form) follows a setting, so the team can agree on it once in `roster.yml`:

```yaml
providers:
  bw:
    save_to: { organization: "My Team", collection: "Infra logins" }   # names or ids; default: personal
```

A Box can choose otherwise in the app's `init.lua` (`roster.o.vault.save_to = "personal"`), and the form's **Save to** choice wins over both for one Host. It lists your personal vault and the collections of the organizations you're in. A name that doesn't match is an error naming the setting (code `64`). Bitwarden's CLI doesn't say which collections you may only read, so one of those is refused when you save (`65`), nothing is left behind, and it's no longer offered.

**KeePassXC (local only).** With no team password manager, the same names go into a local `.kdbx` as entry titles: `kp:orion3 ssh` finds the entry titled `orion3 ssh` in any group (outside the recycle bin), and `kp:Lab/orion3 ssh` names its path. Put the address in the entry's URL field and the user in its username field (`#username`, `#url`). Titles must be unique across the whole database, and can't contain `/`. Tell roster where the database is on this box:

```yaml
providers:
  kp:
    database: ~/roster.kdbx         # ~ and paths relative to roster.yml work
    key_file: ~/roster.keyx          # optional: a key file as well as the master password
    group: Hosts                     # optional: where "Save to vault" puts new entries (default: the top)
```

`save_to: { group: Hosts }` says the same as `group: Hosts` and wins over it; the app's `init.lua` can set `vault.kp.database` and `vault.save_to` for its own Box.

A local database isn't shared: every box (or person) keeps its own, so `auth-check` passes only where those entries exist.

To see what's in the vault without exposing passwords (Bitwarden):

```bash
bw sync
bw list items | jq -r '.[] | [.revisionDate[0:16], .name, (.login.username // "-"), ([.login.uris[]?.uri] | join(" "))] | @tsv' | sort -r | head -20
bw get item "esxi-02 ssh+web" | jq -r '.login.uris[].uri'      # one item's address
```

Going the other way, `roster info HOST` shows a host's address and which item each of its logins uses.

## 3. Work out which box is which

Discovered hosts are named by address (`server-10-0-0-202`), and several can share a web title. Ways to tell them apart before any login:

| Clue | How |
|---|---|
| TLS certificate name | `echo \| openssl s_client -connect IP:443 2>/dev/null \| openssl x509 -noout -subject -ext subjectAltName` |
| Same machine on two addresses | Compare SSH host keys: `ssh-keyscan -t ed25519 IP1 IP2 \| ssh-keygen -lf -`. Matching fingerprints mean one box. |
| Real hostname | After a login works: `roster run HOST -- hostname` |

Certificates can mislead: a cert copied from another box names that box. The SSH host key and the hostname after login are the reliable clues.

## 4. Fill in the hosts

For each host you're bringing in, set its login and mark it reviewed:

```yaml
      server-10-0-0-202:
        reviewed: true
        user: ops
        auth: "bw:lab-hub3 ssh"
        enroll: false            # password logins for now; true = setup installs the key
        ip: "10.0.0.202"
        ...
```

- **`enroll: true`** for Linux servers you want key logins on. `roster setup` installs this box's key using the vault password once.
- **`enroll: false`** for gear that only takes passwords: switches, routers, ESXi (it keeps root keys outside `~/.ssh`), and appliances. Logins then go through `roster run`.
- **`os: windows`** for a Windows Host with OpenSSH Server (Windows 10/11, Server 2019 and later): `setup`, `revoke`, `check` and `run` then run PowerShell there instead of `sh`, and the Mesh leaves it out. See [Windows Hosts](#windows-hosts).
- A different login for the web UI or API goes in a service entry:

```yaml
        services:
          https: { url: "https://10.0.0.206", verify: false }
          api:   { url: "https://10.0.0.206", verify: false, login: vsphere }   # ESXi / vCenter SOAP API
          admin: { port: 8443, user: webadmin, auth: "bw:esxi-02 admin" }        # its own login
```

- If your team has its own word for one of roster's `login:` types, map it once at the top of `roster.yml` and keep using it: `web_login_names: { appliance: hub }` makes `login: appliance` work exactly like `login: hub`. roster shows the type it resolved to (`hub`). Details in [cli-reference.md](cli-reference.md#web-apis-with-stored-logins-roster-web).
- **`shell_hooks: true`** (on a host, its group or `defaults`) lets the roster app send the host's shell one line after login that marks its prompts and says its folder, in that shell only: nothing is written on the host. Off unless set; `shell_hooks: false` keeps a host out, say network gear. It must be `true` or `false`. What's sent, and when not: [Shell hooks](plugins.md#shell-hooks-roster-sets-it-up).
- A typo in a service entry (a port, a url, a `login:` type) doesn't break the file for everyone: that one service is left out, and `roster hosts`, `check` and `auth-check` warn about it with the fix. `roster info HOST` lists it under `problems`.

- Rename hosts to something people will search for, ideally the box's real hostname (`lab-hub3`, `esxi-02`). Set a real `title` and fix the guessed `type`. Don't shorten names: `hub2` and `lab-hub2` are different machines. Hosts you're not bringing in can stay `reviewed: false`. roster leaves them alone.

## 5. Test every login

```bash
roster auth-check --only discovered-20261012     # every vault reference resolves ("ok")
roster setup --only HOST1,HOST2                  # records fingerprints, installs keys on enroll: true hosts
roster run HOST -- hostname                      # SSH password login
ssh HOST hostname                                # SSH key login (enroll: true)
roster web HOST [SERVICE] GET /path              # web API with basic or bearer auth
roster web ESXI api POST /sdk -d @/tmp/ct.xml    # vSphere login (see docs/new-box.md for ct.xml)
roster sync                                      # refresh ROSTER.md and the SSH config
```

What the errors mean:

| Message | Meaning |
|---|---|
| `host key not recorded` | `roster setup --only HOST` hasn't been run for it yet, or the SSH port didn't answer when it ran |
| `no answer on SSH port` | SSH is off or filtered. ESXi often switches SSH off: enable it under Host → Actions → Services. |
| `login refused (wrong user or password?)` | Wrong item, wrong user, or a different box from the one you think. Check the host key (step 3). |
| `warning: HOST service 'NAME': ... - left out` | That service entry has a mistake roster can't work around, so the rest of the Host loads without it. The `fix:` line under it says what to change. |
| bw "locked" / session expired | Run `(umask 077; bw unlock --raw > ~/.config/roster/bw-session)` again |
| `KeePassXC database is locked and there's no terminal to ask` | Run roster in a terminal (it asks for the master password once per run), or unlock in the app |
| `KeePassXC database … isn't there` | Fix `providers: kp: database:` in `roster.yml`, or create the database in KeePassXC |
| `[155] HOST looks like a Windows Host` | Its shell said `'sh' is not recognized`: set `os: windows` for it (see [Windows Hosts](#windows-hosts)), `roster sync`, then run it again |
| `[157] … is UTF-16` / `… starts with a byte order mark` | A Windows Host's key file sshd can't read. roster won't re-encode it (that would turn on every key in it): save it as ASCII, then run `setup` again |
| `warning: [154] HOST has type: windows but no os:` | roster treats it as a POSIX Host. Set `os: windows` if it's Windows |
| `[159] HOST is a Windows Host (os: windows), which has no sudo over ssh` | `roster run --sudo` on Windows: log in as an account in Administrators and run it without `--sudo` |
| `[161] the command isn't PowerShell, so nothing ran` | `roster run` on a Windows Host runs PowerShell: rewrite it, or wrap cmd.exe's syntax in `cmd /c '…'` |
| Port 22 accepts connections but sends no SSH banner, on many Hosts at once | A network IPS or rate limiter between this Box and the Hosts, not the Hosts: probe a neighbouring Host, or wait a few minutes and retry with fewer `workers:`. Don't retry in a loop. List a network that has one in [`rate_limited:`](cli-reference.md#networks-with-an-ssh-rate-limiter), so a Host there that doesn't answer says so |

## Windows Hosts

roster adds its key to a Windows Host that runs Microsoft's OpenSSH Server (Windows 10 1809 and later, Server 2019 and later) once `roster.yml` says it's Windows:

```yaml
  dcs:
    os: windows            # on the group, a Host, or defaults; any case
    user: admin
    auth: "bw:dc-01 ssh"
    hosts:
      dc-01: { ip: 10.0.0.5, type: windows }
```

- **`os:`** is `windows` or `posix` (the default: unset is `posix`). It cascades like `mesh:` (`defaults` → group → Host). `type:` stays a free label: a Host with `type: windows` and no `os:` gets warning 154 suggesting `os: windows`, and is still treated as POSIX. `roster discover` writes `os: windows` for the Hosts it takes for Windows.
- **What runs there.** sshd hands a command line to the Host's DefaultShell: cmd.exe when none is set (Windows' default), or PowerShell when it is. roster works with both and relies on neither: every command is the same `powershell -NoProfile -NonInteractive -EncodedCommand …`, whose argument is base64 (nothing either shell reads specially, far under cmd's 8191-character limit), and the real script goes on stdin, so no key, tag or password is ever in a command line. Windows' OpenSSH never passes on the end of stdin once more than 4096 bytes have gone through, so roster sends the script's length first and the Host reads exactly that much, never waiting for the end. A password is only the login's. Nothing on the Host needs an OpenSSH newer than 8.1, or PowerShell newer than Windows PowerShell 5.1.
- **A new Host has no admin file yet.** That's the usual case: `setup` creates `administrators_authorized_keys` and sets its permissions; sshd ignores it until they're right, so the key works only once they are.
- **Which file.** An account in Administrators (SID S-1-5-32-544 in `whoami /groups`) uses the file the Host's `sshd_config` gives `Match Group administrators`, by default `%ProgramData%\ssh\administrators_authorized_keys`; anyone else `%USERPROFILE%\.ssh\authorized_keys`. roster reads `sshd_config` on the Host and refuses (error 157) anything else that changes where sshd looks (another `AuthorizedKeysFile`, an `Include`, a relative path), rather than guess.
- **A key in the admin file logs in as every administrator on that Host**, not only the `user:` roster set it up for: Windows' administrators share that one file (Microsoft's design). `setup` and `check` say so for such a Host.
- **What changes in it.** Only this Box's line (the one ending `roster-managed:BOX`, trailing spaces and all); every other byte stays. It's written ASCII with no BOM. A UTF-16 or BOM file is refused (error 157), never re-encoded.
- **How it's written.** To a temp file beside it with a random name, made new (never one that's already there), which gets its final permissions while it's still empty; only then do the keys go in, and it replaces the file (or is moved into place). A cut-short run leaves the old file whole.
- **Permissions only narrow, and never turn on keys someone else put there.** sshd ignores a key file others can write. So an existing admin file that anyone besides SYSTEM, Administrators and this account can write, or that isn't owned by SYSTEM or Administrators, is refused (157) and left exactly as it is: making it trusted would turn on whatever they wrote in it, for every administrator. Check every line in it and fix its permissions yourself, then run `setup` again. The same goes for a key folder (`%ProgramData%\ssh`, `%USERPROFILE%\.ssh`) others can write in, or that isn't owned by SYSTEM or Administrators (or, for `.ssh`, this account). Otherwise the admin file gets Microsoft's ACL, set by SID so it works on any language: SYSTEM and Administrators with full control, inheritance removed, any other entry taken out, Administrators as owner; roster reads it back afterwards. A user file roster creates gets this account, SYSTEM and Administrators, read back the same way. An existing user file's ACL is never changed: when others can write it, sshd ignores it, and `setup` and `check` say so (warning 157) for you to fix. Others who can only read a key file are fine.
- **`roster revoke`** cleans both files an administrator's key could be in (the account may have joined or left Administrators since). An account that is no longer an administrator can't open the admin file: revoke warns that this Box's key may still be there, logging in as every administrator, so an administrator removes the line ending `roster-managed:BOX` (or runs `roster revoke` as one).
- **`roster check`** logs in with `exit 0` (the same in sh, cmd.exe and PowerShell), then, on a Windows Host whose key works, reads its key file and warns (157) about what sshd could ignore it for. A login refused on a shared connection ("No existing session") is error 158, not a key problem: roster's ssh config turns connection sharing off (`ControlMaster no`) for `os: windows` Hosts.
- **Elevation.** An administrator's ssh session must be able to write `%ProgramData%\ssh`; if `setup` says access is denied there, log in once on the console and check the account is in Administrators.
- **`roster run HOST -- CMD` runs CMD under PowerShell**, always, whatever the Host's DefaultShell (cmd.exe or PowerShell), so it behaves the same on every Windows Host: the same launch line as `setup`'s, with CMD in the script on stdin as data, never in a command line (non-ASCII text arrives as written, UTF-8). Write it as you would at a PowerShell prompt: `roster run dc-01 -- Get-Service sshd`, `roster run dc-01 -- 'Get-ChildItem C:\Temp | Select-Object -First 5'`. For cmd.exe's syntax, say so: `roster run dc-01 -- cmd /c 'dir /s C:\Temp'`. A command that isn't PowerShell (Windows PowerShell 5.1 has no `&&`) runs nothing: error 161 with PowerShell's own words.
  - **Exit code:** CMD's own `exit N`; 1 for a terminating error (`throw`); otherwise, when its last statement failed, that native command's exit code (`$LASTEXITCODE`), or 1 for a cmdlet (even one told `-ErrorAction Ignore`). A native command that wrote to stderr but exited 0 succeeded. A CMD that ends with `return`, `break` or `continue` has no last statement to judge: a native command's nonzero code if one set it, else 1 if anything wrote an error, else 0. 255 means roster got no exit code back (ssh failed, or roster's script didn't run the command) and says so. The code is exact under either DefaultShell: sshd's PowerShell turns any failure into 1, so roster doesn't use what ssh says. CMD runs in a PowerShell of its own on the Host, whose exit code roster's script sends back as the last line on stderr (with a key made for that run, which CMD never sees, so nothing CMD prints can fake it), and roster doesn't show that line. A code over 255 is 1 on a Linux or macOS Box, which can't pass one on (Windows' are 32-bit).
  - **Output** comes back as text as it's written: stdout, and on stderr errors, warnings (`WARNING: …`) and a native command's stderr; `Write-Host` goes to stdout. PowerShell's own text is UTF-8; an old console program's non-ASCII bytes (its code page's) may not survive. A password Host's output arrives when the command ends, as on any Host.
  - **stdin** carries the script (its length first: Win32-OpenSSH never ends stdin past 4096 bytes); CMD's own stdin is empty and closed, so a program that reads it gets an end at once. A command can be up to 781,104 bytes (about 760 KB; the script with it is at most 1 MB).
  - **`--sudo` is refused** (error 159) before the vault is asked: Windows has no sudo over ssh. Log in as an account in Administrators, whose ssh session is already elevated.
- **The Mesh leaves Windows Hosts out** (code 160): its scripts are sh. A meshed group or a Link that names one isn't an error: the rest of the Mesh is set up, and `roster mesh --dry-run`, `mesh status` and `check` list it under "left out" with the reason. See [The Mesh](mesh.md#windows-hosts).

## Limits to know about

- **Generic form logins aren't supported by `roster web`.** Most appliance web UIs fall in this group, so use a browser for those. Supported: HTTP Basic, bearer tokens, `login: vsphere` (ESXi, vCenter), `login: openvpnas` (OpenVPN Access Server admin), `login: hub` (Hub web UI) and `login: unifi` (UniFi OS consoles: `services: { web: { url: "https://IP", verify: false, login: unifi } }`).
- **Old network gear** that offers SSH protocol 1.99 or old key exchange algorithms may need legacy options. Gear with telnet only can't be reached through roster.
- **Unreviewed hosts are refused** by `run`, `web` and `setup`, on purpose.

## 6. Share it

A plain file of your own needs nothing more: every edit is in it already. For a team repo, commit and push the updated `roster.yml` to [yourteam/infra](https://example.com/yourteam/infra) (`:publish` in the app does it for the app's edits). Every box picks it up with `~/infra/bin/roster-pull`; add `--setup` to install keys on new key hosts. Vault items need to be shared with them (a shared Bitwarden collection or 1Password vault), or `auth-check` will fail on their box.

## Adding a login to a host that's already on the map

1. Create the vault item (named as in step 2, address in its URI field) in the shared collection.
2. Find the host by address: `grep -n "10.0.0.XX" ~/infra/roster.yml`.
3. Set `auth: "bw:<item>"` on the host, on its `ssh:` block, or on one service. A scanned host also gets its real name and `reviewed: true` (step 4).
4. `roster auth-check --only HOST`, then `roster run HOST -- hostname` (step 5).
5. Commit and push (step 6).

## A separate sudo password

The app's fill key (`␣ p`, [keyboard](app/keyboard.md)) types a Host's password at sudo's prompt in its Session. It uses the Host's ssh Login. When the Host's sudo password is a different one, or the Host logs in with a key and has no password in the vault, point `sudo:` at its own vault item, a reference like any `auth:`:

```yaml
      esx-02:
        ip: 10.0.0.5
        auth: agent
        sudo: { auth: "bw:esx-02 sudo" }
```

`sudo:` cascades from `defaults:` and groups like `ssh:`, and takes only `auth`. It must be a vault reference: `prompt`, `agent`, `key` and `none` have no password to fill. `su` is never filled: its `Password:` doesn't say whose password it wants. How the password travels, and when roster won't fill: [security.md](app/security.md#filling-a-password-prompt).

## Things that aren't hosts

A Wi-Fi network, a vendor portal or an API key goes under `resources:` instead of a group. It gets a fixed set of fields per type (`wifi`, `account`, `secret`) and an `auth:` vault reference, just like a host. See [Resources](cli-reference.md#resources-secrets-with-no-address) in the CLI reference. Check it with `roster auth-check --only <name>` and `roster info <name>`.

## See also

[Set up a Box](new-box.md) · [The roster command](cli-reference.md#rosteryml) · [Connection errors](app/errors.md)
