# roster

> One small Rust binary. It replaced the Python CLI and desktop app, now archived at [2styx2/roster-archive](https://github.com/2styx2/roster-archive); the numbering carries on from its v0.7.0.

## Install

roster ships as source only. With a stable Rust toolchain:

```sh
cargo install --locked --git https://github.com/2styx2/roster --root ~/.local
```

Then `roster sync`, and see `roster.1` (`man ./roster.1`) for everything else.

Your password manager knows the secrets. roster knows your network: the team's Hosts in one `roster.yml`, logins from the vault, and a terminal-first CLI that does one job per command and composes with fzf, tmux and ssh.

## Commands

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
