# Setting up roster on a new box

Use this to give another machine (your laptop, a teammate's box, a jump host, a box where Claude runs) the same access to the network. Each box gets its own SSH key, and passwords always come from the shared vault, so there's nothing secret to copy around.

You need three things:

1. **roster itself**: this repository.
2. **An Inventory, `roster.yml`**: the host list. It holds hosts, users and vault item names, but no passwords. It's either your team's, in its git repo ([yourteam/infra](https://example.com/yourteam/infra)), or a plain file of your own on this Box; roster works the same with both ([A plain file or a team repo](cli-reference.md#a-plain-file-or-a-team-repo)).
3. **Access to the vault** the `roster.yml` points at, with the same items (`bw:...`, `op:...`).

**Shortcut:** `./install.sh` in the roster checkout does steps 1–6 for you, plus `ROSTER_CONFIG`, Tab completion for roster in your shell and an auto-update cron job. It asks before each stage, and how to start your Inventory when its folder has none: a blank one (the default, so `--yes` alone makes one), a copy of a `roster.yml` you have, a clone of your team's repo, or the Hosts in `~/.ssh/config`. `--inventory blank|file:PATH|repo:URL|ssh-config[:PATH]` picks one without asking (`--infra-repo URL` is `repo:URL`). A `roster.yml` already there is kept; it can add a new one beside it as a named Inventory instead. After a new one it offers `git init` too, never required. It installs the newest Release (the highest `vX.Y.Z` tag that `origin` has, asked for first), whatever branch your checkout is on, from a clean copy unpacked into `~/.local/share/roster/source/` (kept, because uv's record of the install points there; the next install removes the one before): your checkout is never switched, pulled or changed. `--ref REF` installs a tag or one of `origin`'s branches instead (`--ref dev`); with no Release tag it takes `origin`'s default branch, and offline it installs the checkout as it is and says so. It never installs an older roster over a newer one without a yes (under `--yes` it keeps the newer one; `--allow-downgrade` or `--ref` installs it anyway). It ends by printing the roster it installed and where from (`Installed roster 0.5.0 from ~/roster (v0.5.0, commit 1a2b3c4)`).

**Installing or updating.** On a box that's set up (roster and uv, an Inventory roster finds (`ROSTER_CONFIG`, the active named Inventory, or `~/.config/roster/roster.yml`; a team repo's or a plain one, a blank one included) that's still there, and the cron job when the map has `bin/roster-pull`), `./install.sh` is an update: it says so and runs `./update.sh` with the same `--yes`, `--dry-run`, `--prefix`, `--no-completion` and `--allow-downgrade`. A box that isn't finished (a stage failed, or it was installed before install.sh set up cron) gets every stage again, each skipping what's done. A first `--yes` with no `--inventory` makes a blank Inventory, so the box is set up; to add the team's repo beside it later: `roster -c ~/team/roster.yml init --inventory repo:GIT-URL --name work`. `--finish` runs every stage on a set-up box too. On a box with no init system (a container: no systemd or `service`) it starts the cron daemon itself and says nothing starts it again after a restart; with no cron daemon to start it skips the job and says to run `bin/roster-pull` yourself. A "no" to the cron job or `--no-completion` is kept in `~/.config/roster/install-choices`, so later runs (and `update.sh`) don't ask or add it again; delete the line to change your mind. Update with `./update.sh`, not `uv tool upgrade`. `./update.sh` and `./uninstall.sh` beside it do [Keeping it up to date](#keeping-it-up-to-date) and [Removing a box](#removing-a-box). The rest of this page is what they do, done by hand.

## 1. Prerequisites

- Linux, macOS or WSL with Python 3.10 or newer; or Windows itself (see [On Windows](cli-reference.md#on-windows))
- The OpenSSH client (`ssh`, `ssh-keygen`, `ssh-keyscan`); on Windows, the one built in (Settings, Optional features, OpenSSH Client)
- [uv](https://docs.astral.sh/uv/): `curl -LsSf https://astral.sh/uv/install.sh | sh`
- Your password manager's CLI:
  - Bitwarden: `npm install -g @bitwarden/cli`, or the standalone binary from https://bitwarden.com/help/cli/ (on Windows the standalone `bw.exe` is better: npm's `bw.cmd` is a batch file, which roster passes nothing unusual to)
  - 1Password: https://developer.1password.com/docs/cli/get-started/
- Network access to the subnets in `roster.yml`
- Optional: `nmap`, if this box will run `roster discover`

## 2. Install roster

```bash
git clone git@github.com:2styx2/roster.git
cd roster
uv tool install .          # puts `roster` in ~/.local/bin
roster help --man --install  # puts its man page in ~/.local/share/man/man1, next to it
roster --help              # if not found: export PATH="$HOME/.local/bin:$PATH"
man roster                 # the manual
```

Tab completion (`roster ho<Tab>` is `roster hosts`, `roster run <Tab>` lists your Hosts): add `eval "$(roster help --completion bash)"` to `~/.bashrc` (`zsh` in `~/.zshrc`; for fish, `roster help --completion fish > ~/.config/fish/completions/roster.fish`). `install.sh` does this without asking; `--no-completion` leaves it off. See [Tab completion](cli-reference.md#tab-completion).

No git access on that box? Use `git archive --format=zip -o roster.zip HEAD` on a box that has it, copy the zip over, unzip it, and run `uv tool install .` inside.

## 3. Put the host list in place

**The team's repo.** The team's map lives in the [infra repo](https://example.com/yourteam/infra):

```bash
git clone git@example.com:yourteam/infra.git ~/infra     # or: roster -c ~/infra/roster.yml init --inventory repo:URL
cd ~/infra                 # roster reads ./roster.yml; run roster commands from here
```

No git access? Copy `roster.yml` into `~/infra/` by hand instead (`roster -c ~/infra/roster.yml init --inventory file:PATH` copies it once it loads). You'll then need to copy it again whenever it changes.

**A plain file of your own.** No team repo, or your own machines? Start one:

```bash
roster -c ~/infra/roster.yml init --blank                  # a short, empty one to add Hosts to
roster -c ~/infra/roster.yml init --inventory ssh-config   # or the Hosts already in ~/.ssh/config (it isn't changed)
```

A plain file needs no git: the app's edits, `roster add`, `roster discover --write` and `roster mesh cut` save straight to it, and there's nothing to publish. `git init` in its folder is optional, for history you commit yourself. A `roster.yml` that's already there is never replaced: make the new one in another folder with `--name NAME` to name it beside the first ([A new Inventory](cli-reference.md#a-new-inventory)).

roster looks for its config in this order: `-c PATH`, `--inv NAME`, `$ROSTER_CONFIG`, `./roster.yml`, the active named Inventory, `~/.config/roster/roster.yml`. To run roster from any directory, name it (`roster inv add work ~/infra/roster.yml`, see step 9), or add this to `~/.bashrc` (and `~/.zshrc` if you use zsh):

```bash
export ROSTER_CONFIG="$HOME/infra/roster.yml"
```

## 4. Unlock the vault

**Bitwarden**

```bash
bw login                   # once. Headless box: export BW_CLIENTID=... BW_CLIENTSECRET=...; bw login --apikey
bw sync

# let every roster run on this box (including Claude sessions) use the unlocked vault
roster vault unlock        # asks the master password once, saves the session in ~/.config/roster/bw-session (0600)
```

`roster vault unlock` keeps the vault unlocked until `roster vault lock`, `bw lock`, or the roster app's lock (bw keeps one unlock at a time, so the app's lock or unlock makes the saved session expire; the next run says so). While it's saved, any program running as you can use it to read the vault: that's the trade-off, so lock it when you're done ([Staying unlocked](cli-reference.md#staying-unlocked-roster-vault-unlock)). Without it, a terminal unlock lasts for one run, and roster asks afterwards whether to keep it. By hand, the same file: `(umask 077; bw unlock --raw > ~/.config/roster/bw-session)`.

On Windows, in PowerShell (the folder is `%APPDATA%\roster`):

```powershell
New-Item -ItemType Directory -Force $env:APPDATA\roster | Out-Null
bw unlock --raw | Set-Content -Encoding ascii -NoNewline $env:APPDATA\roster\bw-session
```

`Set-Content -Encoding ascii` writes the key as plain text. Windows PowerShell 5.1's `>` writes UTF-16 instead, and PowerShell 7's UTF-8; roster reads both (with or without a byte-order mark, and without the line end), and ignores, with a warning, a file that isn't a session key.

roster only uses the session file if it's yours alone: a plain file (not a symlink or a hard link), owned by you, that only you can read (mode 600); otherwise it warns and ignores it. Its folder is checked too: `~/.config/roster` (or a link you own to a folder) must be owned by you, and nobody else may write to it; otherwise the file is ignored and `roster vault unlock` refuses (202). On Windows the same holds through the file's owner and permissions: owned by you (or Administrators), and nobody but you, SYSTEM and Administrators may open it, as a file in your own `%APPDATA%` is. When the vault locks or the session expires, roster tells you; run `roster vault unlock` again. `roster vault status` says whether the saved session is there and works. `bw lock` ends the session. `roster vault bw …` then runs other `bw` commands with that session, read-only unless `--write` ([`roster vault bw`](cli-reference.md#roster-vault-bw): first-time setup, changing a password, what roster can and can't see).

**1Password:** use the desktop app integration, `eval $(op signin)`, or `OP_SERVICE_ACCOUNT_TOKEN` on a headless box.

## 5. Check that every credential can be found

```bash
roster vault status        # the password manager you use should say [tool found]
roster check --auth        # every vault reference should say "ok"; nothing secret is printed
```

`roster check --auth` only checks that a value exists. The next step checks it against the hosts.

## 6. Run setup

```bash
roster setup --dry-run     # shows what it would do
roster setup
```

On this box, setup does the following:

1. Creates `~/.ssh/roster_ed25519`, tagged with this box's name (`box_name:` in roster.yml, or the hostname). Give each Box a name no other Box uses: two Boxes with the same name (a hostname every machine of that image has, such as `ubuntu`, `raspberrypi` or `localhost`, or a cloned VM) are one owner to roster, so each one's `roster setup` (as it installs its key) and `roster revoke` take the other's key off the Hosts they share, and each one's `roster mesh` takes the other's Mesh entries ([Whose Mesh it is](mesh.md#whose-mesh-it-is)). `roster check --box` warns about a common default name; it can't see the other Boxes, so a name two of them share by chance isn't caught. Set `box_name:` before the first `roster setup` if you can. To rename a Box that's already set up, set `box_name:` and run `roster setup`: it re-tags this Box's key line under the new name on every Host where the key works (`ok    nas-1 (re-tagged)`), found by this Box's own public key, so another Box's line, even one with the old name, is never touched. Until every key Host has been re-tagged (one down, or `--only`), the next `roster setup` re-tags the rest, and `roster revoke` finds the key under either name all along. On ESXi, setup, the re-tag and `roster revoke` use ESXi's own key file, `/etc/ssh/keys-USER/authorized_keys` (the one its sshd reads, kept across a reboot); a new one gets mode `1600`, as ESXi's own. `user:` must be the account as ESXi names it (`id -un` there): on a mismatch setup and revoke fail that Host and say both names, as the key would go to a folder sshd doesn't read. Where the key works from a line you wrote yourself, setup says it found no line and names the file it looked in (`note  nas-1: the key works, but no roster-managed line for it is in ~/.ssh/authorized_keys …`): change or remove that line by hand. The re-tag keeps a line's options (`from="…"` before the key) and its line end (a CRLF too), keeps one copy where there were two, and never touches another Box's line under the old name. A Host where another key's line already has the new name is another Box's name: this Box's setup and revoke would take that line too (one name, one owner), so setup leaves that Host as it is and fails it with [190](app/errors.md#a-boxs-key); give this Box another name, or run `roster setup --force` to go ahead.
2. Records each host's fingerprint in `~/.ssh/roster_known_hosts`.
3. Installs the key on every `enroll: true` host that doesn't accept it yet. It logs in once with the vault password to do this. Hosts are set up in parallel, except Host entries with the same address, port and `user:` (two names for one machine, or an account several entries share): they share one `authorized_keys`, so setup changes it for one at a time, and each one's `key_type:` keeps its own line there.
4. Writes `~/.ssh/config.d/roster`, so `ssh <name>` works.
5. Writes `ROSTER.md`, `CLAUDE.md` and `.claude/settings.json` in the folder you ran it from.
6. Applies the Mesh when `roster.yml` has one ([The Mesh](mesh.md)).

Hosts with `reviewed: false` are skipped. If a host fails (no answer, wrong password), the rest carry on. Fix it, then run `roster setup` again: hosts that already work are skipped.

## 7. Test

```bash
roster check --box                        # this Box's health, nothing connected
roster hosts                              # what you can reach: name, IP, user, logins
roster check                              # SSH, web UIs and service ports on every host
ssh <key-host> hostname                   # key login
roster run <password-host> -- hostname    # password login (switches, ESXi, appliances)
roster run --sudo <host> -- id            # as root: prints uid=0(root)
roster web <host> [service] GET /path     # web API with the service's stored login
```

For ESXi or vCenter (`login: vsphere`), a read-only call that proves the login works:

```bash
echo '<urn:CurrentTime><urn:_this type="ServiceInstance">ServiceInstance</urn:_this></urn:CurrentTime>' > /tmp/ct.xml
roster web <esxi-host> api POST /sdk -d @/tmp/ct.xml      # HTTP 200 with <returnval>...
```

## 8. Use it with Claude

```bash
cd ~/infra && claude
```

`CLAUDE.md` imports `ROSTER.md`, so Claude knows the hosts and reaches them through `ssh`, `roster run` and `roster web` without seeing passwords, and reads roster's data with `--json` ([Machine-readable output](cli-reference.md#machine-readable-output)). After editing `roster.yml`, run `roster sync` to refresh `ROSTER.md` and the SSH config.

## 9. Optional: add your own Inventory

Keep your own machines (a Raspberry Pi at home, the router) in an Inventory of your own, in its own private repo or folder, rather than in the team's: teammates would see them, and every teammate's `roster setup` would try to reach them. Name both on this Box; one is active:

```bash
roster inv add work ~/infra/roster.yml       # the team's; the first one named is the active one
roster inv add home ~/home-net/roster.yml    # your own, with its own vault Logins
roster --inv home setup                      # its own ssh config, known_hosts and ROSTER.md; work's stay as they are
roster inv list                              # * marks the active one; `roster inv use home` switches
```

Add a machine you know with one command, in the Inventory you name: `roster --inv home add pi --ip 10.0.0.30 --auth prompt --setup` ([One Host you already know](adding-hosts.md#one-host-you-already-know)).

`ssh pi` then works for a Host in either one (the active one's wins if both have that name), and `roster check --box` warns if the same machine is in both. `ROSTER.md` (and the `CLAUDE.md` import) is written for this Box: it marks Hosts another Inventory's name shadows here, so keep it out of the shared repo (add `ROSTER.md` to its `.gitignore`). See [Named Inventories](cli-reference.md#named-inventories).

## Keeping it up to date

`./update.sh` in the roster checkout does the first two lines: it brings the checkout up to date, reinstalls roster from it with its man page, pulls the map and runs `roster sync`. It also turns on Tab completion where `install.sh` would (a box installed before it did gets it), and says when the map's auto-update cron job is missing (`./install.sh` sets it up). It never installs an older roster over the one this box has without a yes (`--allow-downgrade` to do it anyway). It ends by printing the roster it installed and where from (branch, commit, tag), as `install.sh` does.

The checkout is what it installs, so first it looks at it: it fetches (quietly; offline it carries on with what the clone last fetched), and when your branch is behind its upstream it offers to fast-forward it (`git pull --ff-only`, default yes; under `--yes` it does). It never switches branches and never pulls over uncommitted changes or a branch with commits of its own: then, or when you say no, it says it is installing an older roster. A checkout on no branch (a tag) is installed as it is, and a checkout older than the newest Release tag it can see gets a warning naming that tag. By hand:

```bash
cd ~/roster && git pull && uv tool install --force .     # new roster version
~/infra/bin/roster-pull                                  # new host list (git pull + roster sync)
roster setup                                             # new key hosts get this box's key
```

## Removing a box

`./uninstall.sh` in the roster checkout does all of this, in this order: the Mesh and this box's key off the hosts first, then the cron job, the shell startup lines (and fish's completion file), the files below, the vault session, roster and its man page, and the `ROSTER.md` next to `roster.yml`. While a host still has the key (it was down), it keeps the key, the ssh config and roster, so running it again finishes. `--keep-hosts` leaves the hosts alone, and `--purge` also removes `bw`, the `~/.local/bin` PATH line and the config folder (never one with changes not pushed, under `--yes`). By hand:

```bash
roster mesh cut --all      # this box's Mesh entries off every host (with a Mesh)
roster revoke --all        # removes this box's key from every host, in every Inventory here
```

Then delete this box's keys (`~/.ssh/roster_ed25519*` and, with `key_type:`, `roster_ecdsa*`, `roster_rsa*` and the others beside it, a rotation's `.old` and `.new` included, and a `key_path:` of another name if roster made it), `~/.ssh/config.d/roster*`, `~/.ssh/roster-inventories/` and what roster wrote in `~/.config/roster`: everything there but your `roster.yml` and `providers/` (the vault session `bw-session`, the Mesh state `mesh*.json`, `inventories.json`, the run lock `run*.lock`, the key's `key-name*`, `key-types*` and `key-created`, `vault-sync/` and `vault-seen/`). `uninstall.sh` removes a key only when it's this box's (the private key is yours alone, gives its `.pub`, and that `.pub` carries this box's `roster-managed:` tag), never a key of your own, and says which `roster_*` files it kept and why (the files to delete name the tag that vouched for each key; a `key_path:` like `~/.ssh/id_ed25519` is asked about on its own, default no, even when roster made it); under `--keep-hosts` it says the keys still log in to the hosts and keeps them unless you say yes. It keeps a key rotation's record (`key-rotation*`) while a `~/.ssh/roster_*.old` or `.new` key it didn't remove is still there: the record is what says roster made that key; delete both once no host holds it. `roster revoke --all` covers every named Inventory and the unnamed one; plain `roster revoke` covers only the Inventory it runs on (`roster --inv home revoke`). Its summary lists the files to delete.

## See also

[Add your Hosts](adding-hosts.md) · [The roster command](cli-reference.md) · [Getting started with the app](app/start.md)
