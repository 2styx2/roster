#!/bin/sh
# Install what roster needs at run time and to build, like a package manager
# would: the system packages through apt, dnf or pacman, then the Bitwarden
# CLI (not in distro repositories) into ~/.local/bin, pinned and checked
# against its SHA-256. Safe to run again: only what's missing is installed.
#
#   sh scripts/deps.sh          (or `make deps`)
# $missing is a list of package names, split into words on purpose.
# shellcheck disable=SC2086
set -eu

# The Bitwarden CLI release roster is tested with, and its SHA-256 digests
# (from the GitHub release's asset list).
BW_VERSION=2026.9.1
BW_SHA256_x86_64=84289eaf59d691f04242605112f21b00e8dba65acdedbc60dde001a2860f2097
BW_SHA256_aarch64=c451c773378a6f1f041ea26568a897b285a8656bee16a16e4914ce9e40fb7c79

say() { echo "deps: $*"; }
as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }

# 1. System packages: ssh, keyutils (keyctl), fzf, curl, tmux, bash-completion,
#    git and unzip; make and a C compiler, which building roster needs.
if command -v apt-get >/dev/null; then
	pkgs="openssh-client keyutils fzf curl tmux bash-completion git unzip make gcc"
	missing=$(for p in $pkgs; do dpkg -s "$p" >/dev/null 2>&1 || echo "$p"; done)
	if [ -n "$missing" ]; then
		say "apt: installing" $missing
		as_root apt-get update -qq
		as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $missing
	fi
elif command -v dnf >/dev/null; then
	pkgs="openssh-clients keyutils fzf curl tmux bash-completion git unzip make gcc"
	missing=$(for p in $pkgs; do rpm -q "$p" >/dev/null 2>&1 || echo "$p"; done)
	if [ -n "$missing" ]; then
		say "dnf: installing" $missing
		as_root dnf install -y -q --allowerasing $missing
	fi
elif command -v pacman >/dev/null; then
	pkgs="openssh keyutils fzf curl tmux bash-completion git unzip make gcc"
	missing=$(for p in $pkgs; do pacman -Q "$p" >/dev/null 2>&1 || echo "$p"; done)
	if [ -n "$missing" ]; then
		say "pacman: installing" $missing
		as_root pacman -S --needed --noconfirm $missing
	fi
else
	say "no apt-get, dnf or pacman: install by hand: ssh, keyutils, fzf, curl, tmux, bash-completion, git, unzip, make, gcc"
	exit 1
fi

# 2. The Bitwarden CLI, when no `bw` is on PATH.
if command -v bw >/dev/null; then
	say "bw $(bw --version 2>/dev/null) is already installed"
else
	case $(uname -m) in
	x86_64) zip=bw-linux-$BW_VERSION.zip sum=$BW_SHA256_x86_64 ;;
	aarch64 | arm64) zip=bw-linux-arm64-$BW_VERSION.zip sum=$BW_SHA256_aarch64 ;;
	*) say "no Bitwarden CLI build for $(uname -m): install bw by hand"; exit 1 ;;
	esac
	tmp=$(mktemp -d)
	trap 'rm -rf "$tmp"' EXIT
	say "bw: downloading $zip"
	curl -fsSL -o "$tmp/$zip" \
		"https://github.com/bitwarden/clients/releases/download/cli-v$BW_VERSION/$zip"
	echo "$sum  $tmp/$zip" | sha256sum -c --quiet - ||
		{ say "bw: $zip doesn't match its SHA-256; not installed"; exit 1; }
	unzip -q -o "$tmp/$zip" -d "$tmp"
	mkdir -p "$HOME/.local/bin"
	install -m 755 "$tmp/bw" "$HOME/.local/bin/bw"
	say "bw $BW_VERSION installed in ~/.local/bin; run \`bw login\` once"
fi

# 3. The Rust toolchain builds roster; it isn't a distro package here.
command -v cargo >/dev/null ||
	say "no cargo: install Rust with rustup (https://rustup.rs), then \`make install\`"
say "done"
