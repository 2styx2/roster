#!/usr/bin/env bash
# install.sh, update.sh and uninstall.sh on a fresh box, in a throwaway container: the whole life of a new user's
# roster, checked at each step. Needs podman or docker, and the network (apt or dnf, astral.sh, Bitwarden).
#
#   scripts/test-install.sh            Ubuntu 24.04
#   scripts/test-install.sh fedora     Fedora 43
#
# The box starts with nothing but sudo and a user. A stand-in Host on the same box (sshd on 127.0.0.1:2222, user
# "target", its password in $LAB_PW for an `env:` login) and the team's map (a git repo with roster.yml and
# bin/roster-pull) let `roster setup` install a real key and `uninstall.sh` take it off again.
#   1. install.sh --yes --infra-repo   then a new login shell: roster, ROSTER_CONFIG, `ssh lab-01`, cron, man page
#   2. install.sh again                runs update.sh; nothing added twice
#   3. update.sh --yes
#   4. uninstall.sh --yes              the key is off the Host and nothing of roster's is left (uv and bw stay)
#   5. uninstall.sh again              a clean no-op
set -uo pipefail

if [[ ${1:-} == --inside ]]; then           # ---- in the container, as the new user, in ~/roster
    fails=0
    check() { if eval "$2"; then echo "  PASS $1"; else echo "  FAIL $1"; fails=$((fails + 1)); fi; }
    sudo mkdir -p /run/sshd && sudo /usr/sbin/sshd -p 2222 -o PasswordAuthentication=yes
    sudo sh -c '(service cron start || service crond start || crond || cron) >/dev/null 2>&1'
    git config --global user.email lab@example.com; git config --global user.name lab
    git config --global init.defaultBranch main
    mkdir -p /tmp/map/bin && cd /tmp/map || exit 1
    printf '%s\n' 'groups:' '  lab:' '    hosts:' '      lab-01:' '        ip: 127.0.0.1' '        port: 2222' \
        '        user: target' '        auth: env:LAB_PW' '        type: dev' > roster.yml
    printf '%s\n' '#!/bin/sh' 'cd "$(dirname "$0")/.." && git pull --ff-only -q && roster sync' > bin/roster-pull
    chmod +x bin/roster-pull && git init -q && git add -A && git commit -qm map && git clone -q --bare . /tmp/map.git
    cd ~/roster || exit 1
    export LAB_PW=lab-pass-123
    shell() { bash -lc "cd /; $1" 2>/dev/null; }
    host_keys() { sudo grep -c roster-managed ~target/.ssh/authorized_keys 2>/dev/null; }

    echo "== 1. install.sh --yes"
    ./install.sh --yes --infra-repo file:///tmp/map.git; check "install.sh exits 0" '[[ $? == 0 ]]'
    check "a new shell finds roster" '[[ $(shell "command -v roster") == ~/.local/bin/roster ]]'
    check "ROSTER_CONFIG is set" '[[ $(shell "echo \$ROSTER_CONFIG") == ~/infra/roster.yml ]]'
    check "roster hosts lists lab-01" 'shell "roster hosts" | grep -q "^lab-01 "'
    check "ssh lab-01 logs in with the key" '[[ $(shell "ssh -o BatchMode=yes lab-01 whoami") == target ]]'
    check "the Host has this box's key" '[[ $(host_keys) == 1 ]]'
    check "the cron job is there" 'crontab -l | grep -q bin/roster-pull'
    check "man page installed" '[[ -f ~/.local/share/man/man1/roster.1 ]]'
    # Ubuntu's image is minimized: its man is a stand-in, the real one man.REAL
    check "man roster finds it" '[[ $(shell "m=man; [ -x /usr/bin/man.REAL ] && m=/usr/bin/man.REAL; \$m -w roster") == ~/.local/share/man/man1/roster.1 ]]'
    check "roster --help lists the commands" 'shell "roster --help" | grep -q "^Every day:"'
    check "bw installed" '[[ -x ~/.local/bin/bw ]]'

    echo "== 2. install.sh again (roster is there: it runs update.sh)"
    out=$(./install.sh --yes --infra-repo file:///tmp/map.git); check "exits 0" '[[ $? == 0 ]]'
    check "it hands over to update.sh" 'grep -q "already installed on this box: updating it with ./update.sh" <<<"$out"'
    check "one ROSTER_CONFIG line" '[[ $(grep -c "# roster: ROSTER_CONFIG" ~/.bashrc) == 1 ]]'
    check "one cron job" '[[ $(crontab -l | grep -c bin/roster-pull) == 1 ]]'

    echo "== 3. update.sh --yes"
    ./update.sh --yes; check "update.sh exits 0" '[[ $? == 0 ]]'

    echo "== 4. uninstall.sh --yes"
    ./uninstall.sh --yes; check "uninstall.sh exits 0" '[[ $? == 0 ]]'
    check "the key is off the Host" '[[ $(host_keys) == 0 ]]'
    check "roster is gone" '! shell "command -v roster"'
    check "no cron job" '! crontab -l 2>/dev/null | grep -q roster-pull'
    check "no ROSTER_CONFIG line" '! grep -q ROSTER_CONFIG ~/.bashrc ~/.profile'
    check "nothing of roster in ~/.ssh" '[[ -z $(ls -A ~/.ssh 2>/dev/null) ]]'
    check "no man page, state or cache" '[[ ! -e ~/.local/share/man/man1/roster.1 && ! -e ~/.config/roster && ! -e ~/.cache/roster ]]'
    check "the map stays, without ROSTER.md" '[[ -f ~/infra/roster.yml && ! -e ~/infra/ROSTER.md ]]'

    echo "== 5. uninstall.sh again"
    ./uninstall.sh --yes >/dev/null; check "exits 0" '[[ $? == 0 ]]'

    echo; (( fails )) && { echo "$fails checks FAILED"; exit 1; }; echo "all checks passed"; exit 0
fi

# ---- on this machine: build the fresh box, copy roster's files in (as the Release tarball has them), run the above
distro=${1:-ubuntu}
run=$(command -v podman || command -v docker) || { echo "needs podman or docker" >&2; exit 2; }
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
case $distro in
    ubuntu) from=docker.io/library/ubuntu:24.04
            prep="apt-get update && apt-get install -y --no-install-recommends sudo ca-certificates openssh-server cron git man-db" ;;
    fedora) from=registry.fedoraproject.org/fedora:43
            prep="dnf install -y sudo openssh-server cronie git man-db" ;;
    *) echo "unknown distro: $distro (ubuntu or fedora)" >&2; exit 2 ;;
esac
# openssh-server (for the stand-in Host) brings the ssh client with it; install.sh still installs python3, curl,
# uv, unzip and bw from nothing
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
printf '%s\n' "FROM $from" \
    "RUN $prep && useradd -m -s /bin/bash newuser && echo 'newuser ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/newuser \\" \
    " && useradd -m -s /bin/bash target && echo 'target:lab-pass-123' | chpasswd && (ssh-keygen -A >/dev/null 2>&1 || true)" \
    "USER newuser" "WORKDIR /home/newuser" > "$tmp/Containerfile"
"$run" build -q -t "roster-install-test:$distro" -f "$tmp/Containerfile" "$tmp" >/dev/null || exit 1
tar -C "$root" --transform 's,^,roster/,' -cf "$tmp/roster.tar" \
    pyproject.toml uv.lock .python-version README.md install.sh update.sh uninstall.sh src examples
cp "${BASH_SOURCE[0]}" "$tmp/test-install.sh"
chmod -R a+rX "$tmp"                        # mktemp's 700: the container's user is someone else
"$run" run --rm -v "$tmp:/t:ro,Z" "roster-install-test:$distro" \
    bash -c 'tar -xf /t/roster.tar -C ~ && cd ~/roster && bash /t/test-install.sh --inside'
