"""Tests leave nothing in the temp dir (ticket 109): a serve's askpass folder, a stand-in Host's `mktemp`, anything
made with tempfile goes into a folder of the test's own, deleted when the test ends (conftest.py's `isolated`)."""

import os
import tempfile
from pathlib import Path

import pytest

from roster import askpass

REAL_TEMP = Path(tempfile.gettempdir()).resolve()     # at import, before any test's fixture ran


@pytest.fixture(scope="module")
def gone_once_the_test_ends():
    """What the test below makes, checked after its `isolated` has ended. Module-scoped, so it's torn down after the
    test's own fixtures, in the same worker: not a second test that only works if it runs after the first in the same
    xdist worker (T151)."""
    made = {}
    yield made
    assert made, "the test filled it in"
    assert [p for p in made.values() if p.exists()] == [], "the test's temp folder outlived it"


def test_what_a_test_makes_in_the_temp_dir_is_in_a_folder_of_its_own_and_gone_once_it_ends(gone_once_the_test_ends):
    made = gone_once_the_test_ends
    here = Path(tempfile.gettempdir())
    assert here.resolve() != REAL_TEMP
    assert os.environ["TMPDIR"] == str(here)
    made["askpass"] = Path(askpass.runtime_dir())          # where serve puts its socket when $XDG_RUNTIME_DIR can't
    made["mkdtemp"] = Path(tempfile.mkdtemp(prefix="roster-test-"))
    assert all(p.parent == here for p in made.values())
    assert len(str(made["askpass"] / "socket")) < 100      # still short enough for a Unix socket
