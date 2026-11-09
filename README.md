# roster (Rust)

> **Pre-release rewrite.** This replaces [2styx2/roster](https://github.com/2styx2/roster) (Python CLI + desktop app) with one Rust binary. Until it covers daily use, the old roster stays the one to run.

Your password manager knows the secrets. roster knows your network: the team's Hosts in one `roster.yml`, logins from the vault, and a terminal-first CLI that does one job per command and composes with fzf, tmux and ssh.

## Commands (planned)

| Command | What it does |
|---|---|
| `roster` | fzf picker over every Host; opens the pick in a new tmux window (Ctrl-Enter: a split), or right here outside tmux |
| `roster ls [filter]` | list Hosts (`--json` for scripts and Claude) |
| `roster ssh HOST` | interactive ssh; password-only gear gets its password from the vault, never shown |
| `roster run <host\|group> -- CMD` | run a command on one Host or a whole group, output labelled by Host |
| `roster web HOST …` | call a Host's web API with its stored login, without showing it |
| `roster check HOST` | why a Host can't be reached, step by step |
| `roster add HOST` / `roster scan CIDR` | add one Host, or sweep a network for new ones |
| `roster setup [--undo]` | keys, ssh config and the Mesh (Hosts reach each other) in one idempotent step |
| `roster vault unlock\|lock` | unlock the vault once a day |
| `roster watch [group]` | live view: up/down, ping, load, RAM, disk, failed services |

roster is its own tool; tmux is optional. `contrib/roster.tmux` binds `prefix + g` to the picker in a popup (Tab marks several Hosts for synchronized panes). Edit it to use another key.

## License

Apache-2.0. See [LICENSE](LICENSE).
