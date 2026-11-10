# roster tutorial: install, set up, use

roster gets you, your team and Claude onto any Host in your network quickly and safely:

- your Hosts are listed in one `roster.yml`;
- their logins live in Bitwarden;
- roster connects the two through the tools you already have: ssh, fzf, tmux and curl.

This guide takes a new person from nothing to daily use in about 20 minutes. The reference for every command and flag is the man page, `man ./roster.1`. Every name and address below is made up.

- [1. What you need](#1-what-you-need)
- [2. Install](#2-install)
- [3. Point roster at your Inventory](#3-point-roster-at-your-inventory)
- [4. Unlock the vault](#4-unlock-the-vault)
- [5. First setup](#5-first-setup)
- [6. Daily use](#6-daily-use)
- [7. Adding Hosts](#7-adding-hosts)
- [8. Keep every Box up to date automatically](#8-keep-every-box-up-to-date-automatically)
- [9. The Mesh: Hosts that reach each other](#9-the-mesh-hosts-that-reach-each-other)
- [10. How your secrets are kept](#10-how-your-secrets-are-kept)
- [11. Troubleshooting](#11-troubleshooting)
- [12. Leaving](#12-leaving)
- [Teaching it: a 30-minute session](#teaching-it-a-30-minute-session)

## Words used here

- **Host:** a machine or device in `roster.yml` (a VM, a switch, a hypervisor).
- **Box:** the machine you run roster on (your laptop, or a WSL install).
- **Inventory:** the `roster.yml` file. A team usually keeps it in a git repo.
- **Box key:** your Box's own ssh key, `~/.ssh/roster_ed25519`. `roster setup` installs it on Hosts.
- **Password Host:** gear that takes no keys (`enroll: false`). roster logs in with the vault password, which you never see.
- **Mesh:** Hosts that can ssh to each other.

## 1. What you need

Linux or WSL with apt (Debian, Ubuntu), dnf (Fedora, RHEL) or pacman (Arch). The installer brings everything else:

- **OpenSSH:** `ssh`, `ssh-keygen` and `ssh-keyscan`.
- **`keyctl`** (keyutils), which keeps the unlocked vault in kernel memory.
- **`fzf`**, for the picker, and **`curl`**, for `roster web`.
- **`tmux`**, for windows and panes, and **bash-completion**, for Tab.
- **git, make and a C compiler**, to build roster.
- **The Bitwarden CLI, `bw`:** Bitwarden's own build, pinned and checked against its SHA-256. Log in once with `bw login`.
- **A Rust toolchain**, installed with [rustup](https://rustup.rs) if you don't have one.

## 2. Install

roster ships as source only: you build it yourself, from code you can read.

### A fresh machine: one script

```sh
curl -fsSL https://raw.githubusercontent.com/2styx2/roster/main/scripts/bootstrap.sh -o bootstrap.sh
less bootstrap.sh           # read it first
sh bootstrap.sh
```

It runs these steps:

1. installs git and curl;
2. clones roster into `~/src/roster` at the latest release;
3. installs every dependency (`make deps`; it uses sudo for the system packages);
4. installs Rust with rustup if `cargo` is missing;
5. runs `make install`.

Run it again at any time: it only adds what's missing.

### By hand

```sh
git clone https://github.com/2styx2/roster ~/src/roster
cd ~/src/roster
make deps                   # system packages (apt, dnf or pacman) and bw
make install                # into ~/.local, no sudo
roster --version            # roster 0.7.11
```

`make install` puts three files under `~/.local`:

- `bin/roster`;
- `share/bash-completion/completions/roster`;
- `share/man/man1/roster.1`.

`~/.local/bin` must be on your `PATH` (it is on most systems). Open a new terminal, then try `roster <Tab>` and `man roster`.

- **For every user on the machine:** `sudo make install PREFIX=/usr/local`.
- **A specific release:** `git checkout vX.Y.Z` first. `make install` exists from v0.7.1; for v0.7.0, use the `cargo install` line below.
- **To update:** `git pull`, then `make install` again.
- **To remove all three:** `make uninstall`, with the same `PREFIX`.

Without a clone, `cargo install --locked --git https://github.com/2styx2/roster --root ~/.local` installs only the binary.

For tmux, add this to `~/.tmux.conf`. It makes `prefix` then `g` open the picker (`roster pick`) in a popup:

```
source-file ~/src/roster/contrib/roster.tmux
```

## 3. Point roster at your Inventory

roster looks for `roster.yml` in this order:

1. `-c FILE`;
2. `$ROSTER_CONFIG`;
3. `./roster.yml`;
4. `~/.config/roster/roster.yml`.

A team normally shares one Inventory in a git repo. Clone it and point roster at it:

```sh
git clone git@git.example.com:ops/infra.git ~/infra
echo 'export ROSTER_CONFIG=$HOME/infra/roster.yml' >> ~/.bashrc
```

A small `roster.yml` looks like this:

```yaml
defaults:
  user: admin
  reviewed: false          # Hosts found by a scan stay hands-off until reviewed

groups:
  lab:
    mesh: true             # lab Hosts can ssh to each other
    hosts:
      box-a: {ip: 10.0.0.5, auth: "bw:box-a ssh", reviewed: true}
      box-b: {ip: 10.0.0.6, auth: "bw:box-b ssh", reviewed: true}
  network:
    enroll: false          # switches: password logins, no keys
    hosts:
      sw-01: {ip: 10.0.0.2, user: netops, auth: "bw:sw-01 ssh", reviewed: true}
```

`auth:` says where a Host's password comes from:

| `auth:` | Where the password comes from |
|---|---|
| `bw:ITEM` | The Bitwarden item's password. `bw:ITEM#username`, or `#FIELD` for a custom field, also work. |
| `cmd:COMMAND` | The first line a command prints. This is how other password managers plug in, e.g. `cmd:op read op://Vault/item/password`. |
| `env:VAR` | An environment variable. |
| `prompt` | Asked once, at your terminal. |
| `agent`, `key`, `none` | No password: your own ssh key gets in. |

You rarely edit this file by hand: section 7 shows how Hosts get added for you.

## 4. Unlock the vault

Run this once a day, **in your own terminal**, because it asks for your master password:

```sh
roster vault unlock         # Bitwarden master password: ...
```

The unlock lasts 12 hours. `roster vault lock` ends it early.

## 5. First setup

```sh
roster sync                 # write ~/.ssh config for every Host; touches no Host
roster setup --dry-run      # show what setup would do on each Host
roster setup                # do it
```

`roster sync` writes three things:

- `~/.ssh/config.d/roster`, with one `Host` block per Host;
- an `Include` line for it in `~/.ssh/config`;
- `ROSTER.md` and `CLAUDE.md` next to `roster.yml`, which tell Claude how to reach the network.

After that, plain `ssh box-a` works everywhere, as does any tool that speaks ssh: `scp`, `rsync`, git, or an editor's remote mode.

`roster setup` then works through the Hosts:

- it makes your Box key if you don't have one;
- it records each Host's host key;
- once per Host, it logs in with the vault password and installs your key;
- it builds the Mesh.

From then on you log in with your key. Run it again whenever Hosts are added: a rerun only does what's missing.

## 6. Daily use

```sh
roster pick                  # fuzzy-pick a Host and connect
roster ls                    # every Host: name, group, address, access, title
roster ls lab                # filter by name, group, type or product
roster ssh box-a             # connect (Password Hosts too: the password goes in for you)
roster run lab -- uptime     # run on every Host in a group, in parallel
roster run box-a,sw-01 -- hostname
roster run --sudo lab -- systemctl restart nginx   # as root: roster gives sudo its password
roster check                 # can I reach every Host? DNS, port, login
roster check box-a           # why can't I reach this one?
roster web box-a GET /api/health   # call a Host's web API with its stored login
roster web box-a api POST /api/v1/jobs -d '{"name": "backup"}'   # name the service, send a body
```

`run --sudo` takes the sudo password from the Host's `sudo: {auth: REF}` (set it on the Host, its group or `defaults`, like any other field), else from its `auth`. With `auth: key` (no password), it runs `sudo -n`, which works where sudoers says `NOPASSWD`.

In the picker:

- **Enter** opens the Host in a new tmux window;
- **ctrl-v** opens it in a split;
- **Tab** marks several Hosts, which then open in synchronized panes, so you type into all of them at once.

Outside tmux, the picker connects right where you are.

Scripts and Claude can read JSON instead: `roster ls --json`, `roster run --json` and `roster check --json`.

### Web APIs with a token login

Many web apps log in with "POST a user name and password, get a token back", then want that token on every request. `login: token` does that for any such app: roster POSTs `{"username": USER, "password": PASSWORD}` as JSON, takes the token from the reply, and sends it as `Authorization: Bearer TOKEN`. The fields, all optional, cover apps that name things differently:

| Field | Default | What it is |
|---|---|---|
| `login_path` | `/api/auth/login` | where to POST the login |
| `token_field` | `access_token` | the reply's token field; `data.token` reaches into a nested one |
| `user_field` | `username` | the user name's key in the JSON body |
| `password_field` | `password` | the password's key in the JSON body |
| `token_header` | `Authorization` | the header for the token, sent as `Bearer TOKEN`; any other header gets the bare token |

`login: hub` is `login: token` with all the defaults. `web_login_names`, at the top of `roster.yml`, gives a login type another name, so a group of alike apps can say what they are:

```yaml
web_login_names: {acme: hub}          # login: acme is a token login, default fields
groups:
  lab:
    hosts:
      box-a:
        ip: 10.0.0.5
        services:
          web: {url: "https://10.0.0.5", verify: false, login: acme, user: admin, auth: "bw:acme web"}
          api: {url: "https://10.0.0.5:8443", login: token, login_path: /v2/session,
                token_field: data.token, token_header: X-Auth-Token, user: ops, auth: "bw:box-a api"}
```

Then `roster web box-a GET /api/v1/status` logs in and calls the API. The password and the token go to curl on its stdin and never show. A service whose `login` roster doesn't know is left out, so `roster web` says it has no such service.

## 7. Adding Hosts

There are two ways, and neither needs you to edit `roster.yml`.

### From Bitwarden (the usual way)

1. In the Bitwarden web vault, create a **Login** item:
   - **Name:** `HOSTNAME ssh`, e.g. `box-c ssh`. A suffix like `box-c ssh+root` works too.
   - **Username:** the login user.
   - **Password:** the login password.
   - **URI:** the address: `ssh://10.0.0.9`, `ssh://ops@10.0.0.9:2222`, `10.0.0.9:2222` or just `10.0.0.9`. The default port is 22.
   - **Folder** (optional): becomes the Host's group in `roster.yml`, e.g. `Lab Servers` becomes `lab-servers`. Without a folder, it goes in the `vault` group.
2. Run `roster sync`, or let the cron (section 8) do it. You'll see:

   ```
   imported box-c from the vault (group lab-servers)
   ```

The Host is now in `roster.yml`, in your ssh config and in Tab completion: `ssh box-c` works. Run `roster setup` to install your key on it.

An item with no usable address is skipped, and the reason is printed. Fix the URI in Bitwarden and the next sync picks it up. The Host's password is never read during the import: only the item's name, folder, username and URI.

### From the command line

```sh
roster add box-d --ip 10.0.0.12 --group lab --user admin --auth "bw:box-d ssh"
roster add sw-02 --ip 10.0.0.3 --group network --enroll=false   # a Password Host
roster add --from-vault "wiki admin" --name wiki-01 --group apps   # one item, any name
```

`add` keeps every comment and line in `roster.yml` as it was, checks that the result still loads, and syncs. If anything is wrong, it writes nothing.

Hosts added either way are marked `reviewed: true`: adding one is its review. Hosts that arrived another way and still say `reviewed: false` are listed as `unreviewed` and left alone by `setup` and `run` until someone sets `reviewed: true`.

## 8. Keep every Box up to date automatically

When the Inventory lives in a team repo, a small script on each Box keeps it current:

1. pull the repo;
2. `roster sync`, which imports new vault Hosts and rewrites the ssh config;
3. commit and push any imported Hosts, so every other Box gets them.

```sh
#!/usr/bin/env bash
# ~/infra/bin/roster-pull: run from cron every 15 minutes.
set -euo pipefail
cd ~/infra
export PATH="$HOME/.local/bin:$PATH"
git pull --rebase --autostash --quiet
roster sync
if ! git diff --quiet -- roster.yml; then
    git commit --quiet -m "roster.yml: Hosts imported from the vault" -- roster.yml
    git push --quiet || echo "roster-pull: push failed; committed locally" >&2
fi
```

```sh
crontab -e
*/15 * * * * $HOME/infra/bin/roster-pull >> $HOME/.cache/roster-pull.log 2>&1
```

While the vault is unlocked (section 4), cron's `roster sync` can import too. While it's locked, cron still keeps the ssh config current and says `vault import skipped`.

## 9. The Mesh: Hosts that reach each other

`mesh: true` on a group lets its Hosts ssh to each other. `links:` reach across groups:

```yaml
links:
  - {from: lab, to: storage}                 # every lab Host reaches every storage Host
  - {from: box-a, to: nas-01, both: true}    # and back
```

`roster setup` applies it:

- each Host gets its own key, made on the Host, so the private key never leaves it;
- each peer accepts that key only from that Host's address;
- every line roster writes is tagged with your Box, and roster only ever changes lines that carry its own tag.

`roster setup --dry-run` shows who will reach whom first.

## 10. How your secrets are kept

- **Never shown or written down.** Passwords never appear on screen, in logs, in `--json`, in a file, or in a command line, where other users could see them with `ps`.
- **ssh logins:** ssh gets the password from roster through a one-time socket (askpass).
- **Web logins:** curl gets the login on its stdin, a token login's JSON body and token too.
- **sudo passwords:** `run --sudo` writes the password to ssh's stdin, where sudo reads it, and shows it as `********` if a command prints it.
- **The unlocked vault:** it lives in the kernel keyring, never on disk, and expires after 12 hours. Processes running as you can read it; other users can't. That access is what lets your cron import from the vault.
- **Claude:** it gets `ROSTER.md` and may run roster commands, but its settings block it from reading `~/.ssh`, and roster never prints a secret.

## 11. Troubleshooting

| You see | It means | Do |
|---|---|---|
| `roster: vault unlock: wrong master password` | Bitwarden refused the master password. | Run it again; `bw login` again if the account changed. |
| `roster: vault unlock: can't ask for the password: no terminal` | No terminal to ask on (a script, or an editor's command box). | Run `roster vault unlock` in a real terminal. |
| `roster: vault unlock: no master password given` | Enter came before the password. | Run it again. |
| `roster: vault unlock: keyctl isn't installed, …` | keyutils is missing, so the unlock can't be kept. | `sudo apt install keyutils`. |
| `roster: HOST: no vault item named "X"` | No Bitwarden item has that name. | Fix the `auth: bw:X` name, or use `bw:ID` with the item's id. |
| `roster: sync: vault import skipped: Bitwarden is locked` | The 12-hour unlock ran out, or was never done. | `roster vault unlock`. |
| `skipped vault item 'X ssh': its first URI has no address` | The item's URI is empty or unusable. | Put the address in the item's URI. |
| A Host shows `unreviewed` | `defaults` say `reviewed: false`, and nobody has reviewed it. | Set `reviewed: true` on it once you trust it. |
| `roster: HOST: can't reach 10.0.0.5:22 (timed out)` | Network, firewall or VPN. | `roster check HOST` shows each step; fix the route. roster can't. |
| `roster: HOST: ssh isn't listening on 10.0.0.5:22` | The Host is up but refuses ssh on that port. | Check the Host's `port`, and that sshd runs there. |
| `roster: HOST: the Box key isn't accepted for admin` | The key isn't installed, or the account changed. | `roster setup`, or fix the Host's `user`. |
| `roster: HOST: the host key of 10.0.0.5:22 has changed since roster recorded it` | The Host was rebuilt, or something sits in between. | If it was rebuilt: the `ssh-keygen -R` line in the hint, then `roster setup`. |
| `roster: HOST: sudo rejected the password from bw:ITEM` | The sudo password in that item is wrong. | Update the item, or give the Host its own `sudo: {auth: "bw:ITEM"}`. |
| `roster: HOST: sudo needs a password` | The Host's `auth` is a key, and sudoers wants a password. | Give the Host `sudo: {auth: "bw:ITEM"}`. |
| `token login to /api/auth/login: login refused (HTTP 401)` | The app refused the user name or password. | Check the service's `user` and `auth` item; if the app names its fields differently, set `user_field`, `password_field` or `login_path`. |
| `token login to …: no access_token in the reply` | The app logged in but keeps its token under another name. | Set `token_field`, such as `token` or `data.token`. |
| `the certificate of https://… isn't trusted` | A self-signed or private certificate. | If you trust it: `verify: false` on the service, or `roster web -k`. |
| `roster: pick: fzf isn't installed` | The picker needs fzf. | `sudo apt install fzf`. |
| `roster: no Inventory: …` | No `./roster.yml` or `~/.config/roster/roster.yml`. | Write one, or name it with `-c FILE` or `ROSTER_CONFIG=FILE`. |

## 12. Leaving

```sh
roster setup --undo --dry-run   # what would go
roster setup --undo             # remove your key and Mesh entries from every Host, and roster's files from your Box
```

`--undo` keeps your Box key and prints where it is, so you can delete it yourself. Other people's keys, and lines roster didn't write, are never touched.

## Teaching it: a 30-minute session

1. **Why (3 minutes).** Many Hosts and many passwords: roster keeps the map, Bitwarden keeps the secrets, and nobody pastes passwords any more.
2. **Install together (7 minutes).** Section 2, then `roster --version`.
3. **Inventory and unlock (5 minutes).** Section 3: show `roster ls`. Section 4: everyone runs `roster vault unlock`.
4. **First setup (5 minutes).** `roster sync`, then `ssh <Tab>` to show the names complete. Then `roster setup --dry-run` and `roster setup`.
5. **Daily use (5 minutes).** The picker, `roster pick` (Enter, ctrl-v, Tab), `roster run lab -- uptime`, and `roster check`.
6. **Add a Host live (5 minutes).** Create a `demo-01 ssh` item in Bitwarden, run `roster sync`, then `ssh demo-01`. Delete the item afterwards and remove the Host's line from `roster.yml`.

Hand out section 11 as a cheat sheet.
