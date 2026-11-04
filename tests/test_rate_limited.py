"""T191 (#363): which networks have an SSH rate limiter is the team's setting, `rate_limited:` in roster.yml (a
list of networks, empty by default), not an address range in roster. A Host that doesn't answer gets the
rate-limiter hint for its own network only when the list names it; with no list, the hint is the generic one."""

import pytest
from test_serve import synced

from roster import diagnose
from roster.cli import main
from roster.config import load_config

HOSTS = """\
groups:
  lab:
    user: root
    enroll: false
    hosts:
      limited: {ip: 10.0.0.5, auth: "bw:esx ssh"}
      other: {ip: 192.0.2.10, auth: "bw:esx ssh"}
"""

SPECIFIC = "rate limiter"
GENERIC = "a rate limiter on the network can cause this"


def test_no_list_is_an_empty_one(write_config):
    assert load_config(write_config(HOSTS))["rate_limited"] == []


def test_the_list_holds_networks_and_single_addresses(write_config):
    cfg = load_config(write_config("rate_limited: [10.0.0.0/8, 192.0.2.7, '2001:db8::/32']\n" + HOSTS))
    assert cfg["rate_limited"] == ["10.0.0.0/8", "192.0.2.7/32", "2001:db8::/32"]


@pytest.mark.parametrize("value", ["[10.0.0.0/33]", "[not-a-network]", "10.0.0.0/8", "[10.0.0.1/8]"])
def test_a_bad_entry_stops_the_load_naming_the_key(write_config, value):
    with pytest.raises(SystemExit) as e:
        load_config(write_config(f"rate_limited: {value}\n" + HOSTS))
    assert "rate_limited" in str(e.value.code)


@pytest.fixture
def times_out(write_config, capsys, vault, isolated, monkeypatch):
    """`roster check HOST` against a roster.yml whose Hosts never answer on their ssh port."""
    def run(header, host):
        synced(write_config, capsys, header + HOSTS)
        monkeypatch.setenv("BW_PASSWORD", "hunter2")

        def no_answer(*_a, **_k):
            raise TimeoutError("timed out")
        monkeypatch.setattr(diagnose.socket, "create_connection", no_answer)
        assert main(["check", host]) == 1
        out = capsys.readouterr().out
        fail = [ln for ln in out.splitlines() if ln.startswith("FAIL")]
        assert fail and fail[0].startswith("FAIL tcp") and "[42]" in fail[0]
        return out
    return run


def test_a_host_in_a_listed_network_gets_the_rate_limiter_hint(times_out):
    out = times_out("rate_limited: [10.0.0.0/8]\n", "limited")
    assert SPECIFIC in out and "10.0.0.0/8" in out and "rate_limited:" in out
    assert "don't retry in a loop" in out and GENERIC not in out


def test_a_host_outside_the_listed_networks_gets_no_hint(times_out):
    out = times_out("rate_limited: [10.0.0.0/8]\n", "other")
    assert SPECIFIC not in out and "is the Host up" in out


def test_with_no_list_a_timeout_gets_the_generic_hint(times_out):
    out = times_out("", "limited")
    assert GENERIC in out and "don't retry in a loop" in out and "rate_limited:" not in out


def test_the_scan_of_a_listed_address_names_its_network(monkeypatch):
    """host.scan_key, Quick Connect and Add reach an address with no Host behind it yet: the list still applies."""
    def no_answer(*_a, **_k):
        raise TimeoutError("timed out")
    monkeypatch.setattr(diagnose.socket, "create_connection", no_answer)
    h = {"name": "10.0.0.66", "ip": "10.0.0.66", "ssh": {"port": 22}}
    with pytest.raises(diagnose.Problem) as e:
        diagnose.scan_key(h, ["10.0.0.0/8"])
    assert e.value.code == 42 and "10.0.0.0/8" in (e.value.fix or "")
    with pytest.raises(diagnose.Problem) as e:
        diagnose.scan_key(h)
    assert GENERIC in (e.value.fix or "")


def test_a_name_rather_than_an_address_gets_the_generic_hint():
    assert GENERIC in diagnose.unreachable_fix({"ip": "nas.example.com"}, ["10.0.0.0/8"])


def test_no_address_range_is_left_in_roster():
    """The hint used to come from one network's fixed prefix (#363)."""
    import inspect
    assert "10.19" not in inspect.getsource(diagnose)
