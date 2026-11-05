"""The guard in conftest.py (T247): a test that runs the real bw, op or keepassxc-cli from PATH instead of the stand-ins
in tests/fakes fails, naming itself. Proved by a pytest run of its own, under a copy of conftest.py and the stand-ins,
whose tests try: run each tool from os.environ's PATH (and swallow its failure, as install.sh's `bw --version
2>/dev/null` does), or through the `fakes` fixture, which must still pass."""
import os
import shutil
import subprocess
import sys
from pathlib import Path

TESTS = Path(__file__).parent

TRIES = '''
import os
import shutil
import subprocess

import pytest


@pytest.mark.parametrize("tool", ["bw", "op", "keepassxc-cli"])
def test_runs_the_real(tool):
    found = shutil.which(tool)          # by PATHEXT on Windows, as roster finds a tool (bw.cmd from npm)
    if found:
        subprocess.run([found, "--version"], capture_output=True, env={**os.environ})     # its failure swallowed


def test_runs_the_stand_in(fakes):
    assert subprocess.run([shutil.which("bw"), "--version"], capture_output=True).returncode == 0
'''


def test_a_test_that_runs_a_real_vault_cli_from_path_fails_naming_itself(tmp_path):
    inner = tmp_path / "inner"
    inner.mkdir()
    shutil.copy(TESTS / "conftest.py", inner / "conftest.py")
    shutil.copytree(TESTS / "fakes", inner / "fakes")
    (inner / "test_tries.py").write_text(TRIES)
    env = {k: v for k, v in os.environ.items() if k.upper() != "PYTEST_ADDOPTS"}     # no -n from the outer run
    r = subprocess.run([sys.executable, "-m", "pytest", "-p", "no:cacheprovider", "-rA", "test_tries.py"], cwd=inner,
                       env=env, capture_output=True, text=True, timeout=110)
    out = r.stdout + r.stderr
    assert r.returncode != 0, out
    for tool in ("bw", "op", "keepassxc-cli"):
        assert f"test_tries.py::test_runs_the_real[{tool}] ran a real {tool} from PATH" in out, out
    assert "PASSED test_tries.py::test_runs_the_stand_in" in out, out
