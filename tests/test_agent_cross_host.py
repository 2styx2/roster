"""R4 (#556): `roster agent send|read|wait` from a remote Host (box-a) to an Agent on another remote Host (box-b) go
over the Mesh (`ssh box-b hc ...` with the Mesh's ssh config and key), and to a Hub Agent through herdr's call-back to
the Hub terminal that started box-a's work. roster runs here as box-a: its herdr-core is the stand-in hc (FAKE_HC_STATE)
holding the directory copy the Hub wrote (`you`: box-a); box-b is a stand-in Host (FAKE_HOSTS), whose own stand-in hc
answers `ssh box-b hc ...`."""

from pathlib import Path

import pytest
from conftest import POSIX_SH, WINDOWS, FakeHc

from roster.cli import main
from roster.mesh import MARK

# The other Host runs the stand-in hc (a Python script) from its sh by the script's #! line, which Windows' sh can't; a
# remote Host that runs herdr-core is Unix anyway (herdr-core's --via and the Mesh's scripts are sh).
over_the_mesh = pytest.mark.skipif(WINDOWS or POSIX_SH is None, reason="the stand-in Host runs hc by its #! line")


def directory(you: str = "box-a") -> dict:
    """The Agent directory the Hub hub-01 wrote into box-a's core."""
    return {"version": 1, "hub": "hub-01", "you": you, "updated": "2026-11-06T10:00:00Z",
            "machines": [{"name": "box-a", "state": "connected"}, {"name": "box-b", "state": "connected"}],
            "agents": [{"address": "box-b/t2", "host": "box-b", "terminal": "t2", "app": "claude-code",
                        "status": "idle", "label": "", "folder": "/srv/app", "parent": "t3",
                        "started": "2026-11-06T09:00:00Z"}]}


class World:
    """box-a (this machine: `here`), box-b (a stand-in Host with its own hc: `b`), and the Mesh between them."""

    def __init__(self, here: FakeHc, hosts: Path, home: Path) -> None:
        self.here, self.hosts, self.home = here, hosts, home
        (hosts / "box-b").mkdir(parents=True)
        self.b = FakeHc(hosts / "box-b" / "hc")
        self.b.name("box-b")

    def link(self, peer: str = "box-b", *, password: bool = False) -> None:
        """The Mesh's ssh config on box-a, as `roster mesh` writes it, with a Link to PEER (key, or password-only)."""
        d = self.home / ".ssh" / "roster-mesh"
        d.mkdir(parents=True, exist_ok=True)
        auth = ("    PubkeyAuthentication no\n    PreferredAuthentications password,keyboard-interactive\n" if password
                else f"    IdentityFile {d}/id_ed25519\n    IdentitiesOnly yes\n")
        (d / "config").write_text(f"# Written by roster mesh for box-a (owner box-1): the Hosts box-a reaches.\n\n"
                                  f"Host {peer}\n    HostName 10.0.0.6\n    User dev\n    Port 22\n"
                                  f"    UserKnownHostsFile {d}/known_hosts\n    StrictHostKeyChecking yes\n{auth}\n")
        (self.home / ".ssh" / "config").write_text(f"{MARK}\nInclude {d}/config\n")

    def connections(self) -> list[str]:
        f = self.hosts / "connections"
        return f.read_text().splitlines() if f.exists() else []


@pytest.fixture
def world(hc, tmp_path, monkeypatch):
    hc.name("box-a")
    hc.set_doc("roster.agents", directory())
    hosts = tmp_path / "hosts"
    monkeypatch.setenv("FAKE_HOSTS", str(hosts))
    monkeypatch.setenv("FAKE_SH", POSIX_SH or "/bin/sh")
    return World(hc, hosts, Path.home())


def agent(capsys, *argv):
    rc = main(["agent", *argv])
    out, err = capsys.readouterr()
    return rc, out, err


def refused(capsys, *argv):
    with pytest.raises(SystemExit) as e:
        main(["agent", *argv])
    capsys.readouterr()
    return str(e.value)


# ---------------------------------------------------------------- box-a -> box-b over the Mesh

@over_the_mesh
def test_send_to_an_agent_on_another_host_goes_over_the_mesh(world, capsys):
    world.link()
    world.b.terminal("t2", app="claude-code", status="idle")
    rc, out, _ = agent(capsys, "send", "box-b/t2", "the schema changed, pull dev")
    assert rc == 0
    assert out.strip() == "sent to box-b/t2 (it was idle)"
    assert world.b.sent("t2") == ["the schema changed, pull dev"]
    assert "start box-b" in world.connections()
    assert not any(c.split()[1] == "send" for c in world.here.calls())     # box-a's own core typed nothing


@over_the_mesh
def test_text_reaches_the_other_host_exactly_as_given(world, capsys):
    world.link()
    world.b.terminal("t2", app="claude-code", status="idle")
    text = """it's "done": $HOME `id` ; rm -rf / && echo *"""
    assert agent(capsys, "send", "box-b/t2", text)[0] == 0
    assert world.b.sent("t2") == [text]


@over_the_mesh
def test_read_and_wait_over_the_mesh(world, capsys):
    world.link()
    world.b.terminal("t2", app="claude-code", status="working")
    world.b.screen("t2", "> migrating\n3 of 9 tables\n")
    rc, out, _ = agent(capsys, "read", "box-b/t2", "--lines", "20")
    assert (rc, out) == (0, "> migrating\n3 of 9 tables\n")
    assert "hc read t2 --lines 20 --json" in world.b.calls()
    world.b.waits("t2", {"terminal": "t2", "ended": True, "reason": "status", "status": "idle", "turn": 4,
                         "children": []})
    rc, out, _ = agent(capsys, "wait", "box-b/t2", "--timeout", "60")
    assert (rc, out.strip()) == (0, "box-b/t2 is idle")
    assert "hc wait t2 --timeout 60 --json" in world.b.calls()


@over_the_mesh
def test_label_over_the_mesh(world, capsys):
    world.link()
    world.b.terminal("t2", app="claude-code", status="working")
    assert agent(capsys, "label", "box-b/t2", "review the migration")[0] == 0
    assert world.b.labels("t2") == {"roster.label": "review the migration"}


def test_without_a_mesh_link_the_error_names_the_link_to_add(world, capsys):
    world.b.terminal("t2", app="claude-code", status="idle")
    text = refused(capsys, "send", "box-b/t2", "hi")
    assert "box-b/t2 can't be reached from box-a" in text and "no Mesh Link from box-a to box-b" in text
    assert "{ from: box-a, to: box-b }" in text and "roster mesh" in text
    assert world.connections() == [] and world.b.sent("t2") == []


def test_a_password_only_link_cant_carry_a_message(world, capsys):
    world.link(password=True)
    world.b.terminal("t2", app="claude-code", status="idle")
    text = refused(capsys, "send", "box-b/t2", "hi")
    assert "password" in text and "box-b" in text and "enroll" in text
    assert world.connections() == []


@over_the_mesh
def test_a_host_that_doesnt_answer_says_so(world, capsys):
    world.link()
    (world.hosts / "box-b" / "down").write_text("")
    text = refused(capsys, "send", "box-b/t2", "hi")
    assert "box-b didn't answer over the Mesh" in text and "Connection timed out" in text
    assert "roster agents" in text


@over_the_mesh
def test_an_unknown_agent_on_the_other_host_is_a_plain_error(world, capsys):
    world.link()
    world.b.terminal("t2", app="claude-code", status="idle")
    text = refused(capsys, "send", "box-b/t9", "hi")
    assert "no Agent at box-b/t9" in text
    assert world.b.sent("t9") == []


@over_the_mesh
def test_a_host_without_herdr_core_says_so(world, capsys, monkeypatch, tmp_path):
    world.link()
    bin_ = tmp_path / "bin"                          # what sh says there when there's no hc to run
    bin_.mkdir()
    (bin_ / "hc").write_text("#!/bin/sh\necho 'sh: 1: hc: not found' >&2\nexit 127\n")
    (bin_ / "hc").chmod(0o755)
    monkeypatch.setenv("FAKE_HOST_PATH", str(bin_))
    text = refused(capsys, "read", "box-b/t2")
    assert "herdr-core isn't installed on box-b" in text


def test_this_hosts_own_name_in_the_directory_is_this_machine(world, capsys):
    world.here.name("box-a.lab")                    # the core's own name isn't the one the Hub gave the machine
    world.here.terminal("t5", app="claude-code", status="idle")
    assert agent(capsys, "send", "box-a/t5", "hi")[0] == 0
    assert world.here.sent("t5") == ["hi"]
    assert world.connections() == []


# ---------------------------------------------------------------- box-a -> the Hub, by herdr's call-back

def test_send_to_the_hub_agent_that_started_this_work_goes_by_the_call_back(world, capsys):
    world.here.peer("hub-01", calls_me="box-a")
    world.here.peer_terminal("hub-01", "t3", app="claude-code", status="idle")
    rc, out, _ = agent(capsys, "send", "hub-01/t3", "box-a is done: 12 passed")
    assert rc == 0
    assert out.strip() == "sent to hub-01/t3 (it was idle)"
    assert world.here.peer_sent("hub-01", "t3") == ["box-a is done: 12 passed"]
    assert "hc send hub-01/t3 box-a is done: 12 passed --json" in world.here.calls()
    assert world.connections() == []


def test_read_and_wait_on_the_hub_agent(world, capsys):
    world.here.peer("hub-01", calls_me="box-a")
    world.here.peer_terminal("hub-01", "t3", app="claude-code", status="working")
    assert agent(capsys, "read", "hub-01/t3")[0] == 0
    rc, out, _ = agent(capsys, "wait", "hub-01/t3")
    assert (rc, out.strip()) == (0, "hub-01/t3 is working")


def test_a_hub_agent_that_didnt_start_this_work_is_out_of_reach(world, capsys):
    world.here.peer("hub-01", calls_me="box-a")      # hub-01/t7 started nothing here: herdr gives no call-back right
    text = refused(capsys, "send", "hub-01/t7", "hi")
    assert "hub-01/t7 can't be reached from box-a" in text and "started" in text
    assert "on the Hub" in text


def test_a_hub_that_isnt_connected_says_so(world, capsys):
    world.here.peer("hub-01", calls_me="box-a", down=True)
    world.here.peer_terminal("hub-01", "t3", app="claude-code", status="idle")
    text = refused(capsys, "send", "hub-01/t3", "hi")
    assert "hub-01 isn't connected to box-a now" in text and "try again" in text


def test_label_on_a_hub_agent_is_refused_before_herdr_is_asked(world, capsys):
    world.here.peer("hub-01", calls_me="box-a")
    world.here.peer_terminal("hub-01", "t3", app="claude-code", status="idle")
    text = refused(capsys, "label", "hub-01/t3", "x")
    assert "only send, read and wait" in text
    assert not any(c.split()[1] == "label" for c in world.here.calls())


def test_a_machine_with_no_directory_yet_says_how_to_get_one(hc, capsys):
    hc.name("web-01")                               # no sync has reached it: it can't know the Hub or its peers
    text = refused(capsys, "send", "db-01/t2", "hi")
    assert "db-01/t2 can't be reached from web-01" in text and "roster agents sync" in text


def test_the_directory_copy_is_what_names_the_hub(world, capsys):
    world.here.set_doc("roster.agents", {**directory(), "hub": "hub-02"}, version=2)
    world.here.peer("hub-02", calls_me="box-a")
    world.here.peer_terminal("hub-02", "t1", app="claude-code", status="idle")
    assert agent(capsys, "send", "hub-02/t1", "hi")[0] == 0
    assert world.here.peer_sent("hub-02", "t1") == ["hi"]
