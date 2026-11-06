"""T191 (#363): which networks have an SSH rate limiter is the team's setting, `rate_limited:` in roster.yml (a
list of networks, empty by default), not an address range in roster. A Host that doesn't answer gets the
rate-limiter hint for its own network only when the list names it; with no list, the hint is the generic one."""

import re
from pathlib import Path

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
      named: {ip: nas.example.com, auth: "bw:esx ssh"}
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


@pytest.fixture
def resolves(monkeypatch):
    """nas.example.com resolves to ADDRS (what the dns step sees), every other name as before."""
    real = diagnose.socket.getaddrinfo

    def set_addrs(*addrs):
        def fake(host, port, *a, **k):
            if host != "nas.example.com":
                return real(host, port, *a, **k)
            return [(diagnose.socket.AF_INET6 if ":" in x else diagnose.socket.AF_INET, diagnose.socket.SOCK_STREAM,
                     6, "", (x, port)) for x in addrs]
        monkeypatch.setattr(diagnose.socket, "getaddrinfo", fake)
    return set_addrs


def test_a_name_that_resolves_into_a_listed_network_gets_its_hint(times_out, resolves):
    """The dns step already resolved the name: the hint matches that address, not the name (#420)."""
    resolves("192.0.2.99", "10.0.0.9")
    out = times_out("rate_limited: [10.0.0.0/8]\n", "named")
    assert SPECIFIC in out and "10.0.0.0/8" in out and "10.0.0.9" in out and "nas.example.com" in out
    assert GENERIC not in out


def test_a_name_that_resolves_outside_the_listed_networks_gets_no_hint(times_out, resolves):
    resolves("192.0.2.99")
    out = times_out("rate_limited: [10.0.0.0/8]\n", "named")
    assert SPECIFIC not in out and "is the Host up" in out


def test_a_name_with_no_list_still_gets_the_generic_hint(times_out, resolves):
    resolves("10.0.0.9")
    assert GENERIC in times_out("", "named")


# #404 review N2: no code anywhere decides by a fixed address range, as diagnose.py once did. What gives one away: an
# address prefix as a literal ("10.0." with the trailing dot), a prefix comparison against a dotted literal, a
# shell pattern (10.0.*) or a regex anchored on one (^10\.0\.). A whole network as a literal ("10.0.0.0/8") is
# fine: help text and examples have those, and the list a team gives is one. The first number has two digits or
# three, as every private and documentation range's has: a version's (5.0.*, /^1\.0\./) has one.
FIXED_RANGE = re.compile(
    r"""["'`]\d{2,3}\.(?:\d{1,3}\.){0,2}["'`]"""                                          # "10.0."
    r"""|(?:startswith|startsWith|starts_with)\(\s*[rb]?["'`]\d{2,3}\.(?:\d{1,3}\.?){0,2}["'`]"""  # ip.startswith("10.0
    r"""|(?<![\w.\\/-])\d{2,3}\.(?:\d{1,3}\.){0,2}\*"""                                  # [[ $ip == 10.0.* ]]
    r"""|\^\(?\d{2,3}\\\.""")                                                             # /^10\.0\./
CODE = {".py", ".sh", ".ts", ".tsx", ".js", ".mjs", ".rs", ".lua", ".ps1"}
ROOT = Path(__file__).parent.parent
# the code that ships, and the tests and stand-ins beside it (a stand-in that matched on a range would hide one)
WHERE = ["src", "tests", "scripts", "app/src", "app/scripts", "app/src-tauri/src", "crates", "install.sh",
         "update.sh", "uninstall.sh", "install-lib.sh"]


def code_files():
    for w in WHERE:
        p = ROOT / w
        for f in [p] if p.is_file() else p.rglob("*"):
            if f.suffix in CODE and f.is_file() and not ({"node_modules", "target"} & set(f.parts)) and \
                    f != Path(__file__):            # this file: its examples of what to catch
                yield f


@pytest.mark.parametrize("line", [
    'if h["ip"].startswith("10.19."):',
    "return ip.startsWith('10.19.') ? limiter : generic;",
    'if ip.starts_with("10.19.") {',
    'case $ip in 10.19.*) echo limited ;; esac',
    "if (/^10\\.19\\./.test(ip)) {",
    'PREFIX = "192.168."',
])
def test_the_check_for_a_fixed_range_sees_each_way_of_writing_one(line):
    assert FIXED_RANGE.search(line)


@pytest.mark.parametrize("line", [
    'rate_limited: [10.0.0.0/8, 192.0.2.7]',
    '{"ip": "10.0.0.5"}',
    "ipaddress.ip_network(entry, strict=False)",
    'assert first.starts_with("2 ")',
    'version = "0.5.1"',
    'if not x.startswith("10.0.0.30 ")',
    'case $BASH_VERSION in [1-4].*|5.0.*)',
    'expect(text).toMatch(/^1\\.0\\.0/);',
    '"--ref", "v0.5.*"',
    'name: /esxi-2-001.*current/',
    'toHaveTextContent(/2026-09-01.*ssh:/)',
])
def test_the_check_for_a_fixed_range_lets_addresses_and_networks_be(line):
    assert not FIXED_RANGE.search(line)


def test_no_fixed_address_range_is_hard_coded_anywhere():
    files = list(code_files())
    assert len(files) > 100 and ROOT / "src/roster/diagnose.py" in files
    hits = [f"{f.relative_to(ROOT)}:{n}: {line.strip()}" for f in files
            for n, line in enumerate(f.read_text(encoding="utf-8", errors="replace").splitlines(), 1)
            if FIXED_RANGE.search(line)]
    assert not hits, "a fixed address range in code: " + "\n".join(hits)


def test_only_a_network_with_host_bits_set_is_told_about_host_bits(write_config):
    with pytest.raises(SystemExit) as e:
        load_config(write_config("rate_limited: [10.0.0.1/8]\n" + HOSTS))
    assert "host bits" in str(e.value.code) and "10.0.0.0/8" in str(e.value.code)
    with pytest.raises(SystemExit) as e:
        load_config(write_config("rate_limited: [not-a-network]\n" + HOSTS))
    assert "host bits" not in str(e.value.code)


def test_an_unquoted_ipv6_address_read_as_a_number_says_to_quote_it(write_config):
    """YAML 1.1 reads 1:2:3:4:5:6:7:8 unquoted as a base-60 number."""
    with pytest.raises(SystemExit) as e:
        load_config(write_config("rate_limited: [1:2:3:4:5:6:7:8]\n" + HOSTS))
    assert "quote" in str(e.value.code)
    assert load_config(write_config("rate_limited: ['1:2:3:4:5:6:7:8']\n" + HOSTS))["rate_limited"] == \
        ["1:2:3:4:5:6:7:8/128"]
