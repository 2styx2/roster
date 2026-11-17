# roster

> One small Rust binary. It replaced the Python CLI and desktop app, now archived at [2styx2/roster-archive](https://github.com/2styx2/roster-archive); the numbering carries on from its v0.7.0.

## Install

roster ships as source only. On a fresh machine, one script installs everything:
- the dependencies, through apt, dnf or pacman, plus the Bitwarden CLI and Rust;
- roster itself, at its latest release;
- its bash completion and man page.

```sh
curl -fsSL https://raw.githubusercontent.com/2styx2/roster/main/scripts/bootstrap.sh -o bootstrap.sh
less bootstrap.sh && sh bootstrap.sh
```

From a clone: `make deps` installs the dependencies, and `make install` installs roster, its completion and its man page into `~/.local` (or `sudo make install PREFIX=/usr/local`). If Tab doesn't complete `roster` in a new shell, `make autocomplete` installs the completion and sources it from `~/.bashrc` (once; `make uninstall` takes the line out).

By default `roster setup` also tells Claude about your Hosts and lets it log in to them without asking: it writes an import of ROSTER.md and allow rules (including auto mode's) into your own `~/.claude`, and on each Mesh Host into the login user's and root's. Put `claude: false` at the top of `roster.yml` to leave Claude's settings alone (and take out what roster added).

Then follow the **[tutorial](docs/tutorial.md)**: install, first setup, daily use, adding Hosts from Bitwarden, and a 30-minute outline for teaching it. `roster.1` (`man ./roster.1`) is the reference for every command and flag.

Your password manager knows the secrets. roster knows your network: the team's Hosts in one `roster.yml`, logins from the vault, and a terminal-first CLI that does one job per command and composes with fzf, tmux and ssh.

## Commands

| Command | What it does |
|---|---|
| `roster pick` | fzf picker over every Host: Enter opens a new tmux window, ctrl-v a split, Tab-marked Hosts synchronized panes; outside tmux, connects right here |
| `roster ls [--json] [--long] [FILTER]` | list Hosts; FILTER matches names, groups, types or products |
| `roster ssh HOST [ARGS]` | ssh to a Host; password-only gear gets its password from the vault, never shown |
| `roster run [--json] [--sudo] TARGET -- CMD` | run a command on Hosts and groups in parallel, each line labelled by Host; `--sudo` runs it as root |
| `roster check [--json] [TARGET]` | can each Host be reached: DNS, port, then login, with ssh's own error |
| `roster web HOST [SERVICE] METHOD PATH` | call a Host's web API with its stored login (a password or a token login), which curl gets on stdin |
| `roster sync` | import new `HOST ssh` logins from Bitwarden, then rewrite the ssh config, ROSTER.md and Claude files; touches no Host, quick enough for cron |
| `roster add NAME --ip ADDR [...]` / `roster add --from-vault ITEM` | add a Host without hand-editing roster.yml (duplicates of an existing login are refused) |
| `roster setup [--dry-run] [--undo]` | install your key on Hosts, record their host keys and build the Mesh (Hosts that reach each other); `--undo` takes it all back |
| `roster vault unlock` / `lock` | unlock Bitwarden for 12 h (kept in the kernel keyring, never on disk) |
| `roster NAME` | runs a `roster-NAME` plugin from PATH (`roster help plugins`) |
| `roster`, `roster -h`, `roster --version` | usage and version |

roster is its own tool; tmux is optional. `contrib/roster.tmux` binds `prefix + g` to the picker in a popup (Tab marks several Hosts for synchronized panes). Edit it to use another key.

## License

Apache-2.0. See [LICENSE](LICENSE).
