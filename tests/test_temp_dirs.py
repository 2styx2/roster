"""Tests leave nothing in the temp dir (ticket 109): a serve's askpass folder, a stand-in Host's `mktemp`, anything
made with tempfile goes into a folder of the test's own, deleted when the test ends (conftest.py's `isolated`)."""

import os
import tempfile
from pathlib import Path

from roster import askpass

REAL_TEMP = Path(tempfile.gettempdir()).resolve()     # at import, before any test's fixture ran
made = {}


def test_what_a_test_makes_in_the_temp_dir_is_in_a_folder_of_its_own():
    here = Path(tempfile.gettempdir())
    assert here.resolve() != REAL_TEMP
    assert os.environ["TMPDIR"] == str(here)
    made["askpass"] = Path(askpass.runtime_dir())          # where serve puts its socket when $XDG_RUNTIME_DIR can't
    made["mkdtemp"] = Path(tempfile.mkdtemp(prefix="roster-test-"))
    assert all(p.parent == here for p in made.values())
    assert len(str(made["askpass"] / "socket")) < 100      # still short enough for a Unix socket


def test_and_that_folder_is_gone_once_the_test_ends():
    assert made, "runs after the test above"
    assert [p for p in made.values() if p.exists()] == []
