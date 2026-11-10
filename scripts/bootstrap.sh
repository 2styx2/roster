#!/bin/sh
# Install roster on a fresh machine: git, Rust (rustup) when missing, the
# source at its latest release, every dependency (scripts/deps.sh), then the
# binary, bash completion and man page (`make install`, into ~/.local).
#
#   curl -fsSL https://raw.githubusercontent.com/2styx2/roster/main/scripts/bootstrap.sh -o bootstrap.sh
#   less bootstrap.sh          # read it first
#   sh bootstrap.sh
#
# ROSTER_SRC: where the source goes (default ~/src/roster; an existing
# checkout there is updated). ROSTER_REF: a tag or branch instead of the
# latest release.
# $need is a list of command names, split into words on purpose.
# shellcheck disable=SC2086
set -eu

say() { echo "bootstrap: $*"; }
as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }
src=${ROSTER_SRC:-$HOME/src/roster}

# 1. git and curl, to fetch the source and Rust: only the ones missing (a
#    RHEL-family curl-minimal already gives `curl`, and full curl conflicts).
need=$(for c in git curl; do command -v "$c" >/dev/null || echo "$c"; done)
if [ -n "$need" ]; then
	say "installing" $need
	if command -v apt-get >/dev/null; then
		as_root apt-get update -qq
		as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $need ca-certificates
	elif command -v dnf >/dev/null; then
		as_root dnf install -y -q --allowerasing $need
	elif command -v pacman >/dev/null; then
		as_root pacman -Sy --needed --noconfirm $need
	else
		say "install git and curl by hand, then run this again"
		exit 1
	fi
fi

# 2. The source, at the latest release (or ROSTER_REF).
if [ -d "$src/.git" ]; then
	say "updating $src"
	git -C "$src" fetch -q --tags origin
else
	say "cloning into $src"
	git clone -q https://github.com/2styx2/roster "$src"
fi
ref=${ROSTER_REF:-$(git -C "$src" tag --list 'v*' --sort=-v:refname | head -1)}
git -C "$src" -c advice.detachedHead=false checkout -q "$ref"
say "roster source at $ref"

# 3. Every dependency, like a package manager would.
sh "$src/scripts/deps.sh"

# 4. Rust, to build roster: rustup's own installer, minimal profile.
if ! command -v cargo >/dev/null && [ ! -x "$HOME/.cargo/bin/cargo" ]; then
	say "installing Rust with rustup"
	curl -fsSL https://sh.rustup.rs | sh -s -- -y -q --profile minimal
fi
PATH=$HOME/.cargo/bin:$HOME/.local/bin:$PATH
export PATH

# 5. Build and install the binary, bash completion and man page.
make -C "$src" install

cat <<EOF

roster $(roster --version | cut -d' ' -f2) is installed. Next:
  1. Open a new terminal (for Tab completion and ~/.local/bin on PATH).
  2. bw login                       once, then: roster vault unlock
  3. Point roster at your Inventory, e.g. in ~/.bashrc:
       export ROSTER_CONFIG=\$HOME/infra/roster.yml
  4. roster sync, then roster setup --dry-run
See $src/docs/tutorial.md.
EOF
