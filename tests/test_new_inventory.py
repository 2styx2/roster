"""`roster init`'s ways to get an Inventory (T212): the commented example (still the default), a blank one, a copy of
a roster.yml, a clone of the team's repo, Hosts imported from an ssh config; a file already there is kept, and a new
one can be named beside it. Temp HOMEs and folders only: an ssh config here is always a file the test wrote."""

import os
import stat
import subprocess

import pytest

from roster import inventories
from roster.cli import main
from roster.config import load_config
from roster.example import EXAMPLE_CONFIG

SSH_CONFIG = """\
# my ssh config
Include ~/.ssh/config.d/*
Host *
  ServerAliveInterval 30
  User nobody-everywhere

Host web-01 web
  HostName 10.0.0.5
  User admin
  Port 2222

Host pi
  hostname=10.0.0.9
  IdentityFile "~/.ssh/id pi"
  ProxyCommand ssh -W %h:%p jump-secret-token
  PasswordAuthentication yes

Host *.lab !bad ?x
  User x

Host nas
  # just a name, resolved by DNS

Match host esx-02
  User root

Host esx-02
  HostName esx-02.example.com
  user ROOT
  Port 22
"""


def run(capsys, *argv):
    code = main(list(argv))
    out = capsys.readouterr()
    return code, out.out, out.err


def test_init_still_writes_the_commented_example_by_default(isolated, capsys):
    code, out, _ = run(capsys, "init")
    assert code == 0 and (isolated["work"] / "roster.yml").read_text() == EXAMPLE_CONFIG


@pytest.mark.parametrize("flag", [["--blank"], ["--inventory", "blank"]])
def test_init_blank_writes_a_short_file_that_loads(isolated, capsys, flag):
    code, out, _ = run(capsys, "init", *flag)
    path = isolated["work"] / "roster.yml"
    text = path.read_text()
    assert code == 0 and len(text.splitlines()) < 20 and "NO PASSWORDS" in text
    cfg = load_config(path)
    assert cfg["hosts"] == {} and list(cfg["groups"]) == ["servers"]
    assert "roster discover" in text and "#" in text.split("hosts:")[1]     # a Host to copy, commented out
    assert "optional" in out and "git -C . init" in out                    # offered, never required


def test_a_file_already_there_is_kept(isolated, capsys):
    path = isolated["work"] / "roster.yml"
    path.write_text("groups: {}\n")
    with pytest.raises(SystemExit) as e:
        main(["init", "--blank"])
    assert "already exists" in str(e.value.code) and "--name" in str(e.value.code)
    assert path.read_text() == "groups: {}\n"


def test_a_new_one_beside_it_as_a_named_inventory(isolated, capsys):
    (isolated["work"] / "roster.yml").write_text("groups: {}\n")
    home = isolated["home"] / "home-net" / "roster.yml"
    code, out, _ = run(capsys, "-c", str(home), "init", "--blank", "--name", "home")
    assert code == 0 and load_config(home)["hosts"] == {}
    assert inventories.path_of("home") == home.resolve() and "named home" in out
    assert (isolated["work"] / "roster.yml").read_text() == "groups: {}\n"


def test_import_a_roster_yml_copies_it_once_it_loads(isolated, capsys, tmp_path):
    src = tmp_path / "theirs.yml"
    src.write_text("groups:\n  lab:\n    user: root\n    hosts:\n      esx: 10.0.0.5\n")
    target = isolated["work"] / "new" / "roster.yml"
    code, out, _ = run(capsys, "-c", str(target), "init", "--inventory", f"file:{src}")
    assert code == 0 and target.read_text() == src.read_text() and "esx" in load_config(target)["hosts"]


def test_import_refuses_a_file_that_does_not_load(isolated, capsys, tmp_path):
    src = tmp_path / "broken.yml"
    src.write_text("groups: [\n")
    target = isolated["work"] / "roster.yml"
    with pytest.raises(SystemExit) as e:
        main(["init", "--inventory", f"file:{src}"])
    assert "doesn't load" in str(e.value.code) and not target.exists()
    with pytest.raises(SystemExit) as e:
        main(["init", "--inventory", f"file:{tmp_path / 'nope.yml'}"])
    assert "no file" in str(e.value.code)


@pytest.mark.parametrize("spec", ["file:", "repo:", "nonsense", "repo:-uoption"])
def test_a_bad_inventory_spec_is_a_usage_error(isolated, capsys, spec):
    with pytest.raises(SystemExit) as e:
        main(["init", "--inventory", spec])
    assert e.value.code == 2 and "--inventory" in capsys.readouterr().err
    assert not (isolated["work"] / "roster.yml").exists()


def test_clone_the_team_repo(isolated, capsys, tmp_path, monkeypatch):
    for k, v in {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@x", "GIT_COMMITTER_NAME": "t",
                 "GIT_COMMITTER_EMAIL": "t@x", "GIT_CONFIG_NOSYSTEM": "1"}.items():
        monkeypatch.setenv(k, v)
    team = tmp_path / "team"
    team.mkdir()
    (team / "roster.yml").write_text("groups:\n  lab:\n    user: root\n    hosts:\n      esx: 10.0.0.5\n")
    for args in (["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-qm", "map"]):
        subprocess.run(["git", "-C", str(team), *args], check=True, capture_output=True)
    target = isolated["home"] / "infra" / "roster.yml"
    code, out, _ = run(capsys, "-c", str(target), "init", "--inventory", f"repo:{team}")
    assert code == 0 and "esx" in load_config(target)["hosts"]
    from roster import store
    assert store.at(target).kind == "repo"
    with pytest.raises(SystemExit) as e:                    # the folder isn't empty now
        main(["-c", str(target.with_name("other.yml")), "init", "--inventory", f"repo:{team}"])
    assert "isn't empty" in str(e.value.code)


def test_import_hosts_from_an_ssh_config(isolated, capsys, tmp_path):
    conf = tmp_path / "ssh_config"
    conf.write_text(SSH_CONFIG)
    before = conf.read_bytes()
    target = isolated["work"] / "roster.yml"
    code, out, _ = run(capsys, "init", "--inventory", f"ssh-config:{conf}")
    assert code == 0
    assert conf.read_bytes() == before                                      # never changed
    cfg = load_config(target)
    hosts = cfg["hosts"]
    assert sorted(hosts) == ["esx-02", "nas", "pi", "web", "web-01"]        # wildcards, negations, Match: skipped
    assert (hosts["web-01"]["ip"], hosts["web-01"]["user"], hosts["web-01"]["port"]) == ("10.0.0.5", "admin", 2222)
    assert hosts["pi"]["ip"] == "10.0.0.9" and hosts["pi"]["auth"] == "agent"     # IdentityFile: an ssh key
    assert hosts["nas"]["ip"] == "nas" and hosts["esx-02"]["user"] == "ROOT"      # a Match's User isn't applied
    text = target.read_text()
    assert "~/.ssh/id pi" in text                                           # a comment, so you see which key
    for secret_ish in ("jump-secret-token", "PasswordAuthentication", "ServerAliveInterval", "nobody-everywhere"):
        assert secret_ish not in text
    assert "5 Hosts" in out and "skipped" in out


def test_import_from_an_ssh_config_with_no_hosts_still_writes_a_blank_one(isolated, capsys, tmp_path):
    conf = tmp_path / "ssh_config"
    conf.write_text("Host *\n  User x\n")
    code, out, _ = run(capsys, "init", "--inventory", f"ssh-config:{conf}")
    assert code == 0 and load_config(isolated["work"] / "roster.yml")["hosts"] == {}
    assert "no Host" in out


def test_import_from_a_missing_ssh_config(isolated, capsys, tmp_path):
    with pytest.raises(SystemExit) as e:
        main(["init", "--inventory", f"ssh-config:{tmp_path / 'none'}"])
    assert "no file at" in str(e.value.code)
    assert not (isolated["work"] / "roster.yml").exists()


def test_import_reads_this_homes_ssh_config_by_default(isolated, capsys):
    ssh = isolated["home"] / ".ssh"                         # the test's own HOME, never the real one
    ssh.mkdir()
    (ssh / "config").write_text("Host esx-02\n  HostName 10.0.0.6\n  User root\n")
    code, out, _ = run(capsys, "init", "--inventory", "ssh-config")
    assert code == 0 and "from ~/.ssh/config" in out
    print_text = (isolated["work"] / "roster.yml").read_text()
    assert "esx-02: {ip: 10.0.0.6, user: root}" in print_text
    assert 'title: "From ~/.ssh/config"' in print_text


# ---------------------------------------------------------------- PR #409's review: S2, C1, C2, L1-L4, L7

posix_only = pytest.mark.skipif(os.name == "nt", reason="modes and symlinks as POSIX has them")


@posix_only
@pytest.mark.parametrize("how", ["blank", "file", "ssh-config"])
def test_every_new_inventory_is_private(isolated, capsys, tmp_path, how):
    """S2: whatever the umask, a new roster.yml is 0600; a 0600 file imported stays 0600."""
    src = tmp_path / "src"
    src.write_text("groups:\n  lab:\n    user: root\n    hosts:\n      esx: 10.0.0.5\n"
                   if how == "file" else "Host esx-02\n  HostName 10.0.0.6\n")
    src.chmod(0o600)
    spec = {"blank": "blank", "file": f"file:{src}", "ssh-config": f"ssh-config:{src}"}[how]
    old = os.umask(0o022)
    try:
        assert main(["init", "--inventory", spec]) == 0
    finally:
        os.umask(old)
    assert stat.S_IMODE((isolated["work"] / "roster.yml").stat().st_mode) == 0o600


@posix_only
def test_a_dangling_roster_yml_symlink_counts_as_there(isolated, capsys, tmp_path):
    """L7: a roster.yml symlink to nothing is kept (170), never a traceback, never written through."""
    (isolated["work"] / "roster.yml").symlink_to(tmp_path / "nowhere.yml")
    with pytest.raises(SystemExit) as e:
        main(["init", "--blank"])
    assert "already exists" in str(e.value.code) and not (tmp_path / "nowhere.yml").exists()


@pytest.mark.parametrize("word", ["yes", "no", "on", "off", "null", "true", "~", "010", "1_000", "0123", "0x1f",
                                  "1e3", "12:30", "1.0"])
def test_import_keeps_every_name_and_user_as_written(isolated, capsys, tmp_path, word):
    """C1: YAML would read these as something else (a bool, null, a number); the import quotes them."""
    import re
    name = word if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", word) else "h-x"
    conf = tmp_path / "ssh_config"
    conf.write_text(f"Host {name}\n  HostName 10.0.0.5\n  User {word}\n")
    assert main(["init", "--inventory", f"ssh-config:{conf}"]) == 0
    hosts = load_config(isolated["work"] / "roster.yml")["hosts"]
    assert list(hosts) == [name] and hosts[name]["user"] == word


def test_one_bad_host_is_skipped_with_why_not_the_whole_import(isolated, capsys, tmp_path):
    """L2: a Host roster can't take (a % in User) is skipped and named; the others are imported."""
    conf = tmp_path / "ssh_config"
    conf.write_text("Host good\n  HostName 10.0.0.5\n  User admin\nHost bad\n  HostName 10.0.0.6\n  User %u\n"
                    "Host spaced\n  HostName 'a b'\n")
    code, out, _ = run(capsys, "init", "--inventory", f"ssh-config:{conf}")
    assert code == 0 and list(load_config(isolated["work"] / "roster.yml")["hosts"]) == ["good"]
    assert "bad (" in out and "%" in out and "spaced (" in out


def test_an_ssh_config_path_with_odd_characters_still_imports(isolated, capsys, tmp_path):
    """L1: the path goes into a comment and the group's title: a ': ' or ' #' can't break or cut it."""
    d = tmp_path / "a: b #c"
    d.mkdir()
    conf = d / "cfg"
    conf.write_text("Host esx-02\n  HostName 10.0.0.6\n  User root\n")
    assert main(["init", "--inventory", f"ssh-config:{conf}"]) == 0
    cfg = load_config(isolated["work"] / "roster.yml")
    assert cfg["groups"]["imported"]["title"] == f"From {conf}"


def test_a_control_character_in_the_ssh_config_path_is_refused(isolated, capsys, tmp_path):
    """L1: a newline in the path would put a line of YAML into roster.yml."""
    with pytest.raises(SystemExit) as e:
        main(["init", "--inventory", f"ssh-config:{tmp_path}/x\nkey_path: /tmp/evil"])
    assert "control character" in str(e.value.code)
    assert not (isolated["work"] / "roster.yml").exists()


@pytest.mark.parametrize("text,why", [("", "no groups"), ("grups:\n  lab: {}\n", "no groups"),
                                      ("services:\n  web:\n    image: nginx\n", "no groups"),
                                      ("- a\n- b\n", "isn't a roster.yml"), ("Host x\n  User y\n", "isn't a roster.yml")])
def test_import_refuses_a_file_that_is_not_an_inventory(isolated, capsys, tmp_path, text, why):
    """C2: an empty file, a typo'd groups:, a docker-compose.yml or an ssh config passed as file: isn't one."""
    src = tmp_path / "src.yml"
    src.write_text(text)
    with pytest.raises(SystemExit) as e:
        main(["init", "--inventory", f"file:{src}"])
    assert why in str(e.value.code), e.value.code
    assert not (isolated["work"] / "roster.yml").exists()


def test_import_refuses_a_huge_or_special_file(isolated, capsys, tmp_path):
    """L3: not a regular file, or past the size cap."""
    big = tmp_path / "big"
    big.write_text("#" * (2 * 1024 * 1024))
    with pytest.raises(SystemExit) as e:
        main(["init", "--inventory", f"ssh-config:{big}"])
    assert "too big" in str(e.value.code)
    with pytest.raises(SystemExit) as e:
        main(["init", "--inventory", f"file:{tmp_path}"])
    assert "no file" in str(e.value.code)


def test_a_clone_url_never_shows_its_credentials(isolated, capsys, tmp_path):
    """L4: https://user:TOKEN@host/... in an error is shown without the TOKEN."""
    target = isolated["home"] / "infra" / "roster.yml"
    with pytest.raises(SystemExit) as e:
        main(["-c", str(target), "init", "--inventory", f"repo:file://me:s3cret-token@{tmp_path}/nope"])
    assert "s3cret-token" not in str(e.value.code) and "git couldn't clone" in str(e.value.code)
    assert "s3cret-token" not in capsys.readouterr().err


@pytest.mark.parametrize("text", ["", "# nothing\n", "grups:\n  lab:\n    hosts: {}\n",
                                  "groups:\n  lab:\n    host:\n      esx: 10.0.0.5\n",
                                  "services:\n  web:\n    image: nginx\n",
                                  "groups:\n  lab:\n    hosts: {}\nkey_pth: ~/.ssh/k\n"])
def test_no_hosts_loads_only_in_the_blank_shape(write_config, text):
    """C2: 0 Hosts is valid only as `roster init --blank` writes it (groups:, each group with hosts:, no unknown
    keys), so a typo, an empty file or another YAML file still fails to load, and sync keeps this Box's ssh config."""
    path = write_config(text)
    with pytest.raises(SystemExit) as e:
        load_config(path)
    assert "defines no hosts" in str(e.value.code)


@pytest.mark.parametrize("text", ["groups:\n  servers:\n    hosts:\n", "groups:\n  a:\n    hosts: {}\n  b:\n    hosts:\n",
                                  "groups: {}\n", "key_path: ~/.ssh/k\ngroups:\n  servers:\n    title: x\n    hosts: {}\n"])
def test_the_blank_shape_loads(write_config, text):
    assert load_config(write_config(text))["hosts"] == {}


@pytest.mark.parametrize("text", ["- a\n- b\n", "just text\n", "42\n"])
def test_a_roster_yml_that_isnt_a_mapping_is_a_clean_error(write_config, text):
    with pytest.raises(SystemExit) as e:
        load_config(write_config(text))
    assert "isn't a mapping" in str(e.value.code)


def test_sync_keeps_this_boxs_ssh_config_when_a_pull_brings_an_empty_looking_file(write_config, isolated, capsys):
    """C2: before, 'defines no hosts' kept every Box's ssh config; a typo'd file still does."""
    path = write_config("groups:\n  lab:\n    user: root\n    hosts:\n      esx: 10.0.0.5\n")
    assert main(["-c", str(path), "sync"]) == 0
    ssh = isolated["home"] / ".ssh" / "config.d" / "roster"
    before = ssh.read_text()
    path.write_text("grups:\n  lab:\n    user: root\n    hosts:\n      esx: 10.0.0.5\n")
    with pytest.raises(SystemExit):
        main(["-c", str(path), "sync"])
    assert ssh.read_text() == before and "esx" in before
