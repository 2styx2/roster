# Setting up roster on a new box

Use this to give another machine (your laptop, a teammate's box, a jump host, a box where Claude runs) the same access to the network. Each box gets its own SSH key, and passwords always come from the shared vault, so there's nothing secret to copy around.

You need three things:

1. **roster itself**: this repository.
2. **The team's `roster.yml`**: the host list. It holds hosts, users and vault item names, but no passwords. It lives in [yourteam/infra](https://example.com/yourteam/infra).
3. **Access to the vault** the `roster.yml` points at, with the same items (`bw:...`, `op:...`).

**Shortcut:** `./install.sh` in the roster checkout does steps 1–6 for you, plus `ROSTER_CONFIG`, Tab completion for roster in your shell and an auto-update cron job. It asks before each stage, and for your team's map repo (or pass `--infra-repo GIT-URL`, which `--yes` needs to clone it). It installs the newest Release (the highest `vX.Y.Z` tag that `origin` has, asked for first), whatever branch your checkout is on, from a clean copy unpacked into `~/.local/share/roster/source/` (kept, because uv's record of the install points there; the next install removes the one before): your checkout is never switched, pulled or changed. `--ref REF` installs a tag or one of `origin`'s branches instead (`--ref dev`); with no Release tag it takes `origin`'s default branch, and offline it installs the checkout as it is and says so. It never installs an older roster over a newer one without a yes (under `--yes` it keeps the newer one; `--allow-downgrade` or `--ref` installs it anyway). It ends by printing the roster it installed and where from (`Installed roster 0.5.0 from ~/roster (v0.5.0, commit 1a2b3c4)`).

**Installing or updating.** On a box that's set up (roster and uv, a map in `ROSTER_CONFIG`, and the cron job when the map has `bin/roster-pull`), `./install.sh` is an update: it says so and runs `./update.sh` with the same `--yes`, `--dry-run`, `--prefix`, `--no-completion` and `--allow-downgrade`. A box that isn't finished (the first run had no map yet, a stage failed, or it was installed before install.sh set up cron) gets every stage again, each skipping what's done: run `./install.sh --infra-repo GIT-URL` again after a first `--yes` without one, and it clones the map and finishes. `--finish` runs every stage on a set-up box too. A "no" to the cron job or `--no-completion` is kept in `~/.config/roster/install-choices`, so later runs (and `update.sh`) don't ask or add it again; delete the line to change your mind. Update with `./update.sh`, not `uv tool upgrade`. `./update.sh` and `./uninstall.sh` beside it do [Keeping it up to date](#keeping-it-up-to-date) and [Removing a box](#removing-a-box). The rest of this page is what they do, done by hand.

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

The team's map lives in the [infra repo](https://example.com/yourteam/infra):

```bash
git clone git@example.com:yourteam/infra.git ~/infra
cd ~/infra                 # roster reads ./roster.yml; run roster commands from here
```

No git access? Copy `roster.yml` into `~/infra/` by hand instead. You'll then need to copy it again whenever it changes.

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

1. Creates `~/.ssh/roster_ed25519`, tagged with this box's name (`box_name:` in roster.yml, or the hostname).
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

Then delete `~/.ssh/roster_ed25519*`, `~/.ssh/config.d/roster*`, `~/.ssh/roster-inventories/` and `~/.config/roster/bw-session` (and `~/.config/roster/inventories.json` if you named Inventories). `roster revoke --all` covers every named Inventory and the unnamed one; plain `roster revoke` covers only the Inventory it runs on (`roster --inv home revoke`). Its summary lists the files to delete.

## See also

[Add your Hosts](adding-hosts.md) · [The roster command](cli-reference.md) · [Getting started with the app](app/start.md)
