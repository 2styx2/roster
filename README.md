# roster

> One small Rust binary. It replaced the Python CLI and desktop app, now archived at [2styx2/roster-archive](https://github.com/2styx2/roster-archive); the numbering carries on from its v0.7.0.

## Install

roster ships as source only. With a stable Rust toolchain, `make install` builds roster and installs the binary, bash completion and man page into `~/.local` (or `sudo make install PREFIX=/usr/local`):

```sh
git clone https://github.com/2styx2/roster && cd roster
make install
```

Then follow the **[tutorial](docs/tutorial.md)**: install, first setup, daily use, adding Hosts from Bitwarden, and a 30-minute outline for teaching it. `roster.1` (`man ./roster.1`) is the reference for every command and flag.

Your password manager knows the secrets. roster knows your network: the team's Hosts in one `roster.yml`, logins from the vault, and a terminal-first CLI that does one job per command and composes with fzf, tmux and ssh.

## Commands

| Command | What it does |
|---|---|
| `roster pick` | fzf picker over every Host: Enter opens a new tmux window, ctrl-v a split, Tab-marked Hosts synchronized panes; outside tmux, connects right here |
| `roster ls [--json] [--long] [FILTER]` | list Hosts; FILTER matches names, groups, types or products |
| `roster ssh HOST [ARGS]` | ssh to a Host; password-only gear gets its password from the vault, never shown |
| `roster run [--json] TARGET -- CMD` | run a command on Hosts and groups in parallel, each line labelled by Host |
| `roster check [--json] [TARGET]` | can each Host be reached: DNS, port, then login, with ssh's own error |
| `roster web HOST [SERVICE] METHOD PATH` | call a Host's web API with its stored login, which curl gets on stdin |
| `roster sync` | import new `HOST ssh` logins from Bitwarden, then rewrite the ssh config, ROSTER.md and Claude files; touches no Host, quick enough for cron |
| `roster add NAME --ip ADDR [...]` / `roster add --from-vault ITEM` | add a Host without hand-editing roster.yml (duplicates of an existing login are refused) |
| `roster setup [--dry-run] [--undo]` | install your key on Hosts, record their host keys and build the Mesh (Hosts that reach each other); `--undo` takes it all back |
| `roster vault unlock` / `lock` | unlock Bitwarden for 12 h (kept in the kernel keyring, never on disk) |
| `roster NAME` | runs a `roster-NAME` plugin from PATH (`roster help plugins`) |
| `roster`, `roster -h`, `roster --version` | usage and version |

roster is its own tool; tmux is optional. `contrib/roster.tmux` binds `prefix + g` to the picker in a popup (Tab marks several Hosts for synchronized panes). Edit it to use another key.

## License

Apache-2.0. See [LICENSE](LICENSE).
