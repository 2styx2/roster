# Setting up roster on a new box

Use this to give another machine (your laptop, a teammate's box, a jump host, a box where Claude runs) the same access to the network. Each box gets its own SSH key, and passwords always come from the shared vault, so there's nothing secret to copy around.

You need three things:

1. **roster itself**: this repository.
2. **An Inventory, `roster.yml`**: the host list. It holds hosts, users and vault item names, but no passwords. It's either your team's, in its git repo ([yourteam/infra](https://example.com/yourteam/infra)), or a plain file of your own on this Box; roster works the same with both ([A plain file or a team repo](cli-reference.md#a-plain-file-or-a-team-repo)).
3. **Access to the vault** the `roster.yml` points at, with the same items (`bw:...`, `op:...`).

**Shortcut:** `./install.sh` in the roster checkout does steps 1–6 for you, plus `ROSTER_CONFIG`, Tab completion for roster in your shell and an auto-update cron job. It asks before each stage, and how to start your Inventory when its folder has none: a blank one (the default, so `--yes` alone makes one), a copy of a `roster.yml` you have, a clone of your team's repo, or the Hosts in `~/.ssh/config`. `--inventory blank|file:PATH|repo:URL|ssh-config[:PATH]` picks one without asking (`--infra-repo URL` is `repo:URL`). A `roster.yml` already there is kept; it can add a new one beside it as a named Inventory instead. After a new one it offers `git init` too, never required. `./update.sh` and `./uninstall.sh` beside it do [Keeping it up to date](#keeping-it-up-to-date) and [Removing a box](#removing-a-box). The rest of this page is what they do, done by hand.

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
roster man --install       # puts its man page in ~/.local/share/man/man1, next to it
roster --help              # if not found: export PATH="$HOME/.local/bin:$PATH"
man roster                 # the manual
```

Tab completion (`roster ho<Tab>` is `roster hosts`, `roster run <Tab>` lists your Hosts): add `eval "$(roster completion bash)"` to `~/.bashrc` (`zsh` in `~/.zshrc`; for fish, `roster completion fish > ~/.config/fish/completions/roster.fish`). `install.sh` does this without asking; `--no-completion` leaves it off. See [Tab completion](cli-reference.md#tab-completion).

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

A plain file needs no git: the app's edits, `roster discover --write` and `roster mesh cut` save straight to it, and there's nothing to publish. `git init` in its folder is optional, for history you commit yourself. A `roster.yml` that's already there is never replaced: make the new one in another folder with `--name NAME` to name it beside the first ([A new Inventory](cli-reference.md#a-new-inventory)).

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
mkdir -p ~/.config/roster
(umask 077; bw unlock --raw > ~/.config/roster/bw-session)
```

roster only uses the session file if only you can read it (mode 600). When the vault locks or the session expires, roster tells you; rerun the `bw unlock` line. `bw lock` ends the session. `roster bw …` then runs other `bw` commands with that session, read-only unless `--write` ([`roster bw`](cli-reference.md#roster-bw): first-time setup, changing a password, what roster can and can't see).

**1Password:** use the desktop app integration, `eval $(op signin)`, or `OP_SERVICE_ACCOUNT_TOKEN` on a headless box.

## 5. Check that every credential can be found

```bash
roster providers           # the password manager you use should say [tool found]
roster auth-check          # every vault reference should say "ok"; nothing secret is printed
```

`auth-check` only checks that a value exists. The next step checks it against the hosts.

## 6. Run setup

```bash
roster setup --dry-run     # shows what it would do
roster setup
```

On this box, setup does the following:

1. Creates `~/.ssh/roster_ed25519`, tagged with this box's name (`box_name:` in roster.yml, or the hostname). Give each Box a name no other Box uses: two Boxes with the same name (a hostname every machine of that image has, such as `ubuntu`, `raspberrypi` or `localhost`, or a cloned VM) are one owner to roster, so each one's `roster setup` (as it installs its key) and `roster revoke` take the other's key off the Hosts they share, and each one's `roster mesh` takes the other's Mesh entries ([Whose Mesh it is](mesh.md#whose-mesh-it-is)). `roster check --box` warns about a common default name; it can't see the other Boxes, so a name two of them share by chance isn't caught. Set `box_name:` before the first `roster setup`. To rename a Box that's already set up: run `roster revoke` first, under the old name (it also takes a same-named Box's key, so that Box runs `roster setup` again), then set `box_name:` and run `roster setup` again. Changing `box_name:` alone doesn't re-tag the Box's key on its Hosts, and `roster revoke` then looks only for the new name's tag, so it would leave the old key there.
2. Records each host's fingerprint in `~/.ssh/roster_known_hosts`.
3. Installs the key on every `enroll: true` host that doesn't accept it yet. It logs in once with the vault password to do this.
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

`ssh pi` then works for a Host in either one (the active one's wins if both have that name), and `roster check --box` warns if the same machine is in both. `ROSTER.md` (and the `CLAUDE.md` import) is written for this Box: it marks Hosts another Inventory's name shadows here, so keep it out of the shared repo (add `ROSTER.md` to its `.gitignore`). See [Named Inventories](cli-reference.md#named-inventories).

## Keeping it up to date

`./update.sh` in the roster checkout does the first two lines: it pulls the checkout, reinstalls roster with its man page, pulls the map and runs `roster sync`. By hand:

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

Then delete `~/.ssh/roster_ed25519*`, `~/.ssh/config.d/roster*`, `~/.ssh/roster-inventories/` and `~/.config/roster/bw-session` (and `~/.config/roster/inventories.json` if you named Inventories). `roster revoke --all` covers every named Inventory and the unnamed one; plain `roster revoke` covers only the Inventory it runs on (`roster --inv home revoke`). Its summary lists the files to delete.

## See also

[Add your Hosts](adding-hosts.md) · [The roster command](cli-reference.md) · [Getting started with the app](app/start.md)
