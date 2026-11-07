"""R6 (#558): `roster ssh HOST`, an interactive ssh session to a Host. Key Hosts get the system ssh as `ssh HOST`
would run it; password-only Hosts get their Login's password from the vault through the askpass channel, never on
stdout, stderr or a command line. Problems roster can see before connecting (vault locked, item missing) are refused
with their code and fix; a Host that doesn't answer gets roster's cause and fix after ssh's own words.

Nothing connects: the login is the stand-in ssh (tests/fakes/ssh), which asks SSH_ASKPASS for the password as real
ssh does (FAKE_SSH_PROMPT / FAKE_SSH_PASSWORD), and the vault is the stand-in bw."""

import pytest
from conftest import ALL_SECRETS, SECRET

from roster.cli import main

INVENTORY = """\
groups:
  lab:
    user: root
    enroll: false
    hosts:
      esx: {ip: 10.0.0.6, auth: "bw:esx ssh"}
      typo: {ip: 10.0.0.6, auth: "bw:esx shh"}
      keyed: {ip: 10.0.0.7, enroll: true}
"""


@pytest.fixture
def lab(write_config, vault, capfd, monkeypatch, tmp_path):
    """roster.yml written and synced (each Host has its ssh-config alias), the stand-in ssh logging its runs."""
    write_config(INVENTORY)
    assert main(["sync", "--no-vault"]) == 0
    capfd.readouterr()
    log = tmp_path / "ssh.log"
    monkeypatch.setenv("FAKE_LOG", str(log))
    monkeypatch.setenv("FAKE_SSH_PROMPT", "root@10.0.0.6's password: ")
    monkeypatch.setenv("FAKE_SSH_PASSWORD", SECRET)
    lab = type("Lab", (), {})()
    lab.runs = lambda: [ln for ln in (log.read_text().splitlines() if log.exists() else []) if ln.startswith("ssh ")]
    return lab


def no_secret_in(*texts):
    return not [s for s in ALL_SECRETS for t in texts if s in t]


def test_a_password_host_logs_in_with_the_vault_password_through_askpass(lab, capfd, monkeypatch):
    monkeypatch.setenv("BW_PASSWORD", "hunter2")
    assert main(["ssh", "esx"]) == 0
    out, err = capfd.readouterr()
    assert no_secret_in(out, err)
    assert len(lab.runs()) == 1
    run = lab.runs()[0]
    assert run.endswith(" esx") and "NumberOfPasswordPrompts=1" in run
    assert no_secret_in(run)


def test_a_key_host_runs_plain_ssh_and_passes_its_exit_code_on(lab, capfd, monkeypatch):
    monkeypatch.delenv("FAKE_SSH_PROMPT")
    monkeypatch.setenv("FAKE_SSH_STDERR", "")
    monkeypatch.setenv("FAKE_SSH_EXIT", "3")            # the remote shell's last exit code
    assert main(["ssh", "keyed"]) == 3
    assert lab.runs() == ["ssh keyed"]
    assert "roster:" not in capfd.readouterr().err


def test_a_locked_vault_is_refused_with_its_fix_before_ssh_starts(lab, capfd):
    with pytest.raises(SystemExit) as e:
        main(["ssh", "esx"])
    text = str(e.value)
    assert "[14]" in text and "roster vault unlock" in text
    assert lab.runs() == []


def test_a_missing_vault_item_is_refused_with_its_fix(lab, capfd, monkeypatch):
    monkeypatch.setenv("BW_PASSWORD", "hunter2")
    with pytest.raises(SystemExit) as e:
        main(["ssh", "typo"])
    text = str(e.value)
    assert "[32]" in text and "'esx shh'" in text and "fix the name in typo's auth: in roster.yml" in text
    assert lab.runs() == []


def test_a_host_that_doesnt_answer_gets_sshs_words_then_the_cause_and_fix(lab, capfd, monkeypatch):
    monkeypatch.delenv("FAKE_SSH_PROMPT")
    said = "ssh: connect to host 10.0.0.7 port 22: Connection timed out"
    monkeypatch.setenv("FAKE_SSH_STDERR", said)
    assert main(["ssh", "keyed"]) == 255
    err = capfd.readouterr().err.splitlines()
    assert err[0] == said
    assert err[1].startswith("roster: [") and "keyed has never answered at 10.0.0.7" in err[1]
    assert "check keyed's ip: in roster.yml" in err[1]
    assert len(lab.runs()) == 1                         # one attempt, never a retry


def test_a_password_the_host_refuses_names_the_vault_item_never_the_value(lab, capfd, monkeypatch):
    monkeypatch.setenv("BW_PASSWORD", "hunter2")
    monkeypatch.setenv("FAKE_SSH_PASSWORD", "something-else")
    assert main(["ssh", "esx"]) == 255
    out, err = capfd.readouterr()
    assert "Permission denied" in err and "vault item 'esx ssh' doesn't log in to esx" in err
    assert no_secret_in(out, err)


def ssh_config(isolated, text):
    """TEXT added to the user's own ~/.ssh/config (after roster's Include)."""
    config = isolated["home"] / ".ssh" / "config"
    config.write_text((config.read_text() if config.exists() else "") + "\n" + text)


@pytest.mark.parametrize(("jump", "prompt", "who"), [
    ("jump-01", "ops@10.0.0.99's password: ", "ops@10.0.0.99"),
    ("jump-01", "(ops@10.0.0.99) Password: ", "ops@10.0.0.99"),
    ("jump-01", "ops@jump-01's password: ", "ops@jump-01"),
    ("ops@10.0.0.99", "ops@10.0.0.99's password: ", "ops@10.0.0.99")])
def test_a_jump_host_asking_for_a_password_never_gets_this_hosts(lab, capfd, monkeypatch, isolated, jump, prompt, who):
    """ssh runs a ProxyJump's ssh with its own environment, askpass and all: a prompt that names the jump Host's
    login (by its address or its name) is refused, and its token isn't spent on it."""
    ssh_config(isolated, f"Host esx\n    ProxyJump {jump}\nHost jump-01\n    HostName 10.0.0.99\n    User ops\n")
    monkeypatch.setenv("BW_PASSWORD", "hunter2")
    monkeypatch.setenv("FAKE_SSH_PROMPT", prompt)
    monkeypatch.setenv("FAKE_SSH_PASSWORD", "")         # what the jump would get: nothing, if roster refuses it
    assert main(["ssh", "esx"]) == 255
    err = capfd.readouterr().err
    assert "roster askpass: [36]" in err and f"ssh asked for {who}'s password" in err
    assert no_secret_in(err)


@pytest.mark.parametrize("prompt", ["root@10.0.0.6's password: ", "root@esx's password: ",
                                    "root@esx-hostkey's password: ", "(root@esx.lab.example) Password: "])
def test_the_hosts_own_prompt_is_answered_under_its_address_name_or_alias(lab, capfd, monkeypatch, isolated, prompt):
    """ssh names the login in its prompt by the HostKeyAlias, or the HostName as it resolved it (an address, or a
    canonical name): whichever it is, the Host's own prompt gets its password, even behind a jump Host."""
    ssh_config(isolated, "Host esx\n    HostKeyAlias esx-hostkey\n    ProxyJump ops@10.0.0.99\n")
    monkeypatch.setenv("BW_PASSWORD", "hunter2")
    monkeypatch.setenv("FAKE_SSH_PROMPT", prompt)
    assert main(["ssh", "esx"]) == 0
    out, err = capfd.readouterr()
    assert "roster askpass:" not in err and no_secret_in(out, err)


def test_a_host_behind_a_jump_host_keeps_the_proxyjump_its_ssh_config_gives(lab, capfd, monkeypatch, isolated):
    """The jump is ssh's: roster runs `ssh ALIAS` and overrides none of ProxyJump, ProxyCommand or the config file,
    so a `ProxyJump` for the Host in ~/.ssh/config applies (a jump Host that takes this Box's key)."""
    config = isolated["home"] / ".ssh" / "config"
    config.write_text((config.read_text() if config.exists() else "") + "\nHost esx keyed\n    ProxyJump jump-01\n")
    monkeypatch.setenv("BW_PASSWORD", "hunter2")
    assert main(["ssh", "esx"]) == 0
    run = lab.runs()[0].split()
    assert not [a for a in run if a in ("-J", "-F", "-W") or a.lower().startswith(("proxyjump", "proxycommand"))]
    assert run[-1] == "esx"
    assert no_secret_in(*capfd.readouterr())


def test_an_unknown_host_and_one_not_synced_yet_are_refused_before_ssh(lab, capfd, write_config):
    with pytest.raises(SystemExit) as e:
        main(["ssh", "nope"])
    assert "unknown host 'nope'" in str(e.value)
    write_config(INVENTORY + "      new-01: {ip: 10.0.0.8, enroll: true}\n")
    with pytest.raises(SystemExit) as e:
        main(["ssh", "new-01"])
    assert "[21] new-01 isn't in this Box's ssh config yet" in str(e.value) and " sync` writes it" in str(e.value)
    assert lab.runs() == []
