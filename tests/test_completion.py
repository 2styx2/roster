"""Shell completion (T214): `roster help --completion SHELL` prints a thin script for that shell, and the script asks the hidden
helper `roster __complete SHELL :CURRENT WORD...` what fits. The helper reads only the local roster.yml and the named
Inventories' list: no network, no vault, and a missing or broken file completes nothing."""

import pytest
from conftest import WINDOWS, posix_shell

from roster.cli import main

CONFIG = """\
groups:
  web:
    hosts:
      web-01: {ip: 10.0.0.5, user: admin}
      web-02: {ip: 10.0.0.6, user: admin}
  db:
    hosts:
      db-01: {ip: 10.0.0.7, user: admin}
resources:
  lab-guest: {type: wifi, ssid: lab-guest, password: env:WIFI_PW}
"""


def complete(capsys, *words, sh="bash"):
    """What the helper offers for the command line WORDS, the last one the word being completed."""
    *before, current = words
    assert main(["__complete", sh, f":{current}", "roster", *before]) == 0
    out = capsys.readouterr()
    assert out.err == ""
    return out.out.splitlines()


@pytest.fixture
def config(write_config, monkeypatch):
    path = write_config(CONFIG)
    monkeypatch.setenv("ROSTER_CONFIG", str(path))
    return path


def test_a_command_prefix_completes_to_the_command(capsys):
    assert complete(capsys, "ho") == ["hosts"]


def test_a_host_argument_completes_host_names(capsys, config):
    assert complete(capsys, "run", "web") == ["web-01", "web-02"]
    assert complete(capsys, "check", "") == ["db-01", "web-01", "web-02"]


def test_hosts_name_takes_a_host_or_a_resource(capsys, config):
    assert complete(capsys, "hosts", "") == ["db-01", "lab-guest", "web-01", "web-02"]
    assert complete(capsys, "hosts", "web-01", "") == []        # the other words are fuzzy search words


def test_vault_reveal_takes_only_resources(capsys, config):
    assert complete(capsys, "vault", "") == ["bw", "lock", "op", "reveal", "status", "sync", "targets", "unlock"]
    assert complete(capsys, "vault", "reveal", "") == ["lab-guest"]


def test_the_internal_commands_and_the_old_names_are_not_offered(capsys):
    offered = complete(capsys, "")
    assert "serve" not in offered and "askpass" not in offered
    assert not {"info", "bw", "providers", "auth-check", "man", "completion", "resources", "reveal"} & set(offered)
    assert len(offered) == 14


def test_help_completes_the_commands(capsys):
    assert complete(capsys, "help", "va") == ["vault"]
    assert complete(capsys, "help", "--completion", "") == ["bash", "fish", "powershell", "zsh"]


def test_only_completes_the_last_name_of_a_comma_list(capsys, config):
    assert complete(capsys, "hosts", "--only", "w") == ["web", "web-01", "web-02"]
    assert complete(capsys, "setup", "--only", "db,web-") == ["db,web-01", "db,web-02"]
    assert complete(capsys, "hosts", "--only=d") == ["--only=db", "--only=db-01"]


def test_mesh_completes_its_actions_then_a_host(capsys, config):
    assert complete(capsys, "mesh", "") == ["cut", "leftovers", "status"]
    assert complete(capsys, "mesh", "cut", "d") == ["db-01"]
    assert complete(capsys, "mesh", "--rotate", "d") == ["db-01"]


def test_setup_rotate_completes_hosts_only_after_host(capsys, config):
    """T240 (#469, 6): setup --rotate is a bare flag (the Box key); --host names what it covers."""
    assert complete(capsys, "setup", "--rotate", "") == []
    assert complete(capsys, "setup", "--rotate", "--host", "w") == ["web-01", "web-02"]
    assert "--rotate" in complete(capsys, "setup", "--r")


def test_options_complete_after_a_dash(capsys):
    assert complete(capsys, "hosts", "--l") == ["--long"]
    assert "--config" in complete(capsys, "--c")
    assert complete(capsys, "help", "--completion", "") == ["bash", "fish", "powershell", "zsh"]


def test_a_command_before_its_options_and_after_roster_s_own(capsys, config, tmp_path):
    other = tmp_path / "other.yml"
    other.write_text("groups:\n  lab:\n    hosts:\n      lab-01: {ip: 10.0.0.9, user: u}\n")
    assert complete(capsys, "-c", str(other), "run", "") == ["lab-01"]
    assert complete(capsys, f"--config={other}", "run", "") == ["lab-01"]
    assert complete(capsys, "-c", str(other), "ho") == ["hosts"]


def test_nothing_after_double_dash_or_for_free_text(capsys, config):
    assert complete(capsys, "run", "web-01", "--", "") == []
    assert complete(capsys, "hosts", "--find", "") == []
    assert complete(capsys, "vault", "bw", "") == []


def test_paths_are_left_to_the_shell(capsys):
    assert complete(capsys, "-c", "") == [":files"]
    assert complete(capsys, "help", "--man", "--prefix", "") == [":dirs"]


def test_inventory_names_complete(capsys, tmp_path):
    for name in ("work", "home"):
        (tmp_path / f"inv-{name}").mkdir()
        (tmp_path / f"inv-{name}" / "roster.yml").write_text(CONFIG)
        assert main(["inv", "add", name, str(tmp_path / f"inv-{name}" / "roster.yml")]) == 0
    capsys.readouterr()
    assert complete(capsys, "--inv", "") == ["home", "work"]
    assert complete(capsys, "inv", "use", "w") == ["work"]


def test_inv_add_completes_no_name_for_the_new_inventory(capsys, tmp_path):
    """`inv add NAME PATH` names a new Inventory: offering the existing names there only invites a clash (#420)."""
    (tmp_path / "inv-work").mkdir()
    (tmp_path / "inv-work" / "roster.yml").write_text(CONFIG)
    assert main(["inv", "add", "work", str(tmp_path / "inv-work" / "roster.yml")]) == 0
    capsys.readouterr()
    assert complete(capsys, "inv", "add", "") == []
    assert complete(capsys, "inv", "add", "w") == []
    assert complete(capsys, "inv", "add", "home", "") == [":files"]
    assert complete(capsys, "inv", "remove", "") == ["work"]


def test_a_missing_roster_yml_completes_no_names(capsys, tmp_path, monkeypatch):
    monkeypatch.setenv("ROSTER_CONFIG", str(tmp_path / "nowhere.yml"))
    assert complete(capsys, "run", "") == []
    assert complete(capsys, "ho") == ["hosts"]               # commands still do


@pytest.mark.parametrize("text", ["groups: [unclosed", "just a string\n", "groups:\n  web: 5\n", "\x00\xff"])
def test_a_broken_roster_yml_completes_no_names_and_prints_no_error(capsys, write_config, monkeypatch, text):
    monkeypatch.setenv("ROSTER_CONFIG", str(write_config(text)))
    assert complete(capsys, "run", "") == []


def test_a_broken_inventory_list_completes_nothing(capsys, isolated):
    from roster import named
    named.list_file().parent.mkdir(parents=True, exist_ok=True)
    named.list_file().write_text("{not json")
    assert complete(capsys, "--inv", "") == []


def test_a_malformed_call_prints_nothing(capsys):
    for argv in (["__complete"], ["__complete", "tcsh", ":x", "roster"], ["__complete", "bash", "x", "roster"]):
        assert main(argv) == 0
        assert capsys.readouterr() == ("", "")


def test_the_other_shells_get_descriptions(capsys):
    assert complete(capsys, "ho", sh="fish")[0].startswith("hosts\tlist the Hosts and resources")
    assert complete(capsys, "hosts", "--lo", sh="zsh")[0].startswith("--long\tfull table")


def test_completion_imports_no_ssh_library(config):
    import subprocess
    import sys
    code = ("import sys; from roster.cli import main; main(['__complete', 'bash', ':', 'roster', 'run']); "
            "print(' '.join(sorted(sys.modules)))")
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=60)
    assert r.stdout.startswith("db-01\nweb-01\nweb-02\n")
    loaded = r.stdout.splitlines()[-1].split()
    assert not [m for m in loaded if m.startswith(("paramiko", "roster.serve", "roster.sshops_"))]


# ---- the scripts, in the real shells (each one that's installed: CI installs zsh and fish; bash and pwsh are there)

def shim(tmp_path):
    """A `roster` on PATH that runs this checkout's roster with this Python, as the installed command would."""
    import sys
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    if WINDOWS:
        (bin_dir / "roster.cmd").write_text(f'@"{sys.executable}" -m roster %*\r\n')
    else:
        (bin_dir / "roster").write_text(f'#!/bin/sh\nexec "{sys.executable}" -m roster "$@"\n')
        (bin_dir / "roster").chmod(0o755)
    return bin_dir


def script(shell):
    from roster.completion import SCRIPTS
    return SCRIPTS[shell]


@pytest.fixture
def shell_env(config, tmp_path):
    import os
    return {**os.environ, "PATH": f"{shim(tmp_path)}{os.pathsep}{os.environ['PATH']}"}


def test_roster_help_completion_prints_the_script_for_a_shell(capsys):
    assert main(["help", "--completion", "bash"]) == 0
    assert "complete -F _roster roster" in capsys.readouterr().out
    with pytest.raises(SystemExit):
        main(["help", "--completion", "tcsh"])


def run_shell(argv, env, tmp_path, **kw):
    import subprocess
    return subprocess.run(argv, env=env, cwd=tmp_path, capture_output=True, text=True, timeout=120,
                          stdin=subprocess.DEVNULL, **kw)


def bash_complete(line, env, tmp_path):
    """COMPREPLY for LINE (the cursor at its end), the way bash's programmable completion calls _roster."""
    import shutil
    if not shutil.which("bash") or WINDOWS:
        pytest.skip("needs bash")
    (tmp_path / "roster.bash").write_text(script("bash"))
    test = ('source ./roster.bash; read -ra COMP_WORDS <<< "$LINE"; [[ $LINE == *" " ]] && COMP_WORDS+=("");'
            ' COMP_CWORD=$(( ${#COMP_WORDS[@]} - 1 )); COMP_LINE=$LINE; COMP_POINT=${#LINE}; _roster;'
            ' printf "%s\\n" "${COMPREPLY[@]}"')
    r = run_shell(["bash", "--norc", "--noprofile", "-c", test], {**env, "LINE": line}, tmp_path)
    assert r.returncode == 0, r.stderr
    return [x for x in r.stdout.splitlines() if x]


def test_bash_completes_a_command_and_a_host(shell_env, tmp_path):
    assert bash_complete("roster ho", shell_env, tmp_path) == ["hosts"]
    assert bash_complete("roster run web", shell_env, tmp_path) == ["web-01", "web-02"]
    assert bash_complete("roster hosts --lo", shell_env, tmp_path) == ["--long"]


def test_bash_hands_a_path_to_its_own_file_completion(shell_env, tmp_path):
    (tmp_path / "team.yml").write_text("")
    assert bash_complete("roster -c tea", shell_env, tmp_path) == ["team.yml"]


@posix_shell
def test_bash_registers_the_completion_for_roster(shell_env, tmp_path):
    (tmp_path / "roster.bash").write_text(script("bash"))
    r = run_shell(["bash", "--norc", "--noprofile", "-c", "source ./roster.bash && complete -p roster"], shell_env,
                  tmp_path)
    assert r.stdout.strip() == "complete -F _roster roster"


def test_fish_completes_a_command_and_a_host(shell_env, tmp_path):
    import shutil
    if not shutil.which("fish"):
        pytest.skip("needs fish")
    (tmp_path / "roster.fish").write_text(script("fish"))

    def fish(line):
        r = run_shell(["fish", "--no-config", "-c", f"source ./roster.fish; complete -C '{line}'"], shell_env, tmp_path)
        assert r.returncode == 0, r.stderr
        return r.stdout.splitlines()
    assert [x.split("\t")[0] for x in fish("roster ho")] == ["hosts"]
    assert [x.split("\t")[0] for x in fish("roster run web")] == ["web-01", "web-02"]


def test_zsh_offers_a_command_and_a_host(shell_env, tmp_path):
    import shutil
    if not shutil.which("zsh"):
        pytest.skip("needs zsh")
    (tmp_path / "roster.zsh").write_text(script("zsh"))
    # compdef and compadd stand in for zsh's completion system: what _roster hands it is what zsh would list
    test = ('compdef() { print -r -- "compdef $*" }; compadd() { local -a w; w=("${@[(r)--,-1]}"); '
            'print -rl -- "${(@)w[2,-1]}" }; source ./roster.zsh; words=(${(z)LINE}); [[ $LINE == *" " ]] && '
            'words+=(""); CURRENT=${#words}; PREFIX=${words[CURRENT]}; _roster')
    r = run_shell(["zsh", "-f", "-c", test], {**shell_env, "LINE": "roster ho"}, tmp_path)
    assert r.stdout.splitlines() == ["compdef _roster roster", "hosts"], r.stderr
    r = run_shell(["zsh", "-f", "-c", test], {**shell_env, "LINE": "roster run "}, tmp_path)
    assert r.stdout.splitlines()[1:] == ["db-01", "web-01", "web-02"], r.stderr


def test_powershell_completes_a_command_and_a_host(shell_env, tmp_path):
    import shutil
    pwsh = shutil.which("pwsh")
    if not pwsh:
        pytest.skip("needs pwsh")
    (tmp_path / "roster.ps1").write_text(script("powershell"))

    def tab(line):
        cmd = (f". ./roster.ps1; (TabExpansion2 -inputScript '{line}' -cursorColumn {len(line)}).CompletionMatches |"
               " ForEach-Object { $_.CompletionText }")
        r = run_shell([pwsh, "-NoProfile", "-NonInteractive", "-Command", cmd], shell_env, tmp_path)
        assert r.returncode == 0, r.stderr
        return r.stdout.splitlines()
    assert tab("roster ho") == ["hosts"]
    assert tab("roster run web") == ["web-01", "web-02"]
    assert tab("roster run ") == ["db-01", "web-01", "web-02"]
