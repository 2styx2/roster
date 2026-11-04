"""`roster init`'s ways to get an Inventory (T212): the commented example (still the default), a blank one, a copy of
a roster.yml, a clone of the team's repo, Hosts imported from an ssh config; a file already there is kept, and a new
one can be named beside it. Temp HOMEs and folders only: an ssh config here is always a file the test wrote."""

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
    assert "can't read" in str(e.value.code)
    assert not (isolated["work"] / "roster.yml").exists()


def test_import_reads_this_homes_ssh_config_by_default(isolated, capsys):
    ssh = isolated["home"] / ".ssh"                         # the test's own HOME, never the real one
    ssh.mkdir()
    (ssh / "config").write_text("Host esx-02\n  HostName 10.0.0.6\n  User root\n")
    code, out, _ = run(capsys, "init", "--inventory", "ssh-config")
    assert code == 0 and "from ~/.ssh/config" in out
    print_text = (isolated["work"] / "roster.yml").read_text()
    assert "esx-02: {ip: 10.0.0.6, user: root}" in print_text
    assert 'title: From "~/.ssh/config"' in print_text or "title: From ~/.ssh/config" in print_text


# ---------------------------------------------------------------- the app's first run, through serve (inventory.create)

def test_serve_with_no_inventory_makes_a_blank_one_and_names_it(serve, isolated):
    """T212: the app's first-run dialog. serve, with no roster.yml anywhere, writes one (ADR 0001: never the app),
    and names it so the next serve finds it."""
    s = serve()
    assert s.call("inventory.info")["error"]["code"] == 1
    folder = isolated["home"] / "infra"
    r = s.call("inventory.create", {"how": "blank", "folder": str(folder)})["result"]
    target = folder / "roster.yml"
    assert r == {"path": str(target.resolve()), "name": "infra", "how": "blank", "hosts": 0, "restart": True}
    assert load_config(target)["hosts"] == {}
    assert inventories.load().active == "infra" and inventories.path_of("infra") == target.resolve()
    s2 = serve()                                            # the restarted serve finds it
    assert s2.call("inventory.info")["result"]["path"] == str(target.resolve())


def test_serve_imports_a_file_and_takes_a_name(serve, isolated, tmp_path):
    src = tmp_path / "theirs.yml"
    src.write_text("groups:\n  lab:\n    user: root\n    hosts:\n      esx: 10.0.0.5\n")
    s = serve()
    folder = isolated["home"] / "lab"
    r = s.call("inventory.create", {"how": "file", "source": str(src), "folder": str(folder), "name": "work"})
    assert r["result"]["hosts"] == 1 and r["result"]["name"] == "work"
    assert (folder / "roster.yml").read_text() == src.read_text()


def test_serve_says_why_it_cannot_make_one(serve, isolated, tmp_path):
    s = serve()
    folder = str(isolated["home"] / "infra")
    bad = tmp_path / "broken.yml"
    bad.write_text("groups: [\n")
    for params, code in [({"how": "file", "source": str(bad), "folder": folder}, 171),
                         ({"how": "repo", "source": "-uoops", "folder": folder}, -32602),
                         ({"how": "nonsense", "folder": folder}, -32602),
                         ({"how": "blank", "folder": "relative/dir"}, -32602),
                         ({"how": "blank"}, -32602),
                         ({"how": "file", "folder": folder}, -32602),
                         ({"how": "blank", "folder": folder, "name": "bad name"}, -32602)]:
        err = s.call("inventory.create", params)["error"]
        assert err["code"] == code, (params, err)
    assert not (isolated["home"] / "infra" / "roster.yml").exists()
    assert not inventories.load().inventories


def test_serve_never_makes_one_while_it_has_one(serve, write_config, isolated):
    path = write_config("groups:\n  lab:\n    user: root\n    hosts:\n      esx: 10.0.0.5\n")
    s = serve("-c", str(path))
    err = s.call("inventory.create", {"how": "blank", "folder": str(isolated["home"] / "infra")})["error"]
    assert err["code"] == 170 and str(path) in err["message"]
    assert not (isolated["home"] / "infra").exists()


def test_serve_clones_without_asking_anything(serve, isolated, tmp_path, monkeypatch):
    for k, v in {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@x", "GIT_COMMITTER_NAME": "t",
                 "GIT_COMMITTER_EMAIL": "t@x", "GIT_CONFIG_NOSYSTEM": "1"}.items():
        monkeypatch.setenv(k, v)
    team = tmp_path / "team"
    team.mkdir()
    (team / "roster.yml").write_text("groups:\n  lab:\n    user: root\n    hosts:\n      esx: 10.0.0.5\n")
    for args in (["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-qm", "map"]):
        subprocess.run(["git", "-C", str(team), *args], check=True, capture_output=True)
    s = serve()
    err = s.call("inventory.create", {"how": "repo", "source": str(tmp_path / "nope"),
                                      "folder": str(isolated["home"] / "other")})["error"]
    assert err["code"] == 172 and err["data"]["fix"]
    folder = isolated["home"] / "infra"
    r = s.call("inventory.create", {"how": "repo", "source": str(team), "folder": str(folder)})["result"]
    assert r["how"] == "repo" and r["hosts"] == 1
    err = s.call("inventory.create", {"how": "blank", "folder": str(isolated["home"] / "more")})["error"]
    assert err["code"] == 170                               # one made: this serve makes no other
