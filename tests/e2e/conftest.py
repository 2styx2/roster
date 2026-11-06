"""The end-to-end suite (docs/development.md, "End-to-end suite"): skipped unless ROSTER_E2E=1 and podman or docker is
here."""

import os
import shutil
from pathlib import Path

import pytest

from . import e2e_lab as world

HERE = Path(__file__).parent


def pytest_configure(config):
    config.addinivalue_line("markers", "e2e: the end-to-end suite (real sshd in containers; ROSTER_E2E=1)")


def pytest_collection_modifyitems(config, items):
    on, why = world.enabled()
    for item in items:
        if Path(str(item.fspath)).parent == HERE:
            item.add_marker(pytest.mark.e2e)
            item.add_marker(pytest.mark.timeout(600))
            if not on:
                item.add_marker(pytest.mark.skip(reason=why))


@pytest.fixture(scope="session")
def image():
    world.Lab().build()


@pytest.fixture(scope="module")
def lab(image):
    """Fresh stand-in Hosts for one module: new host keys, nothing in any authorized_keys."""
    hosts = world.Lab()
    try:
        for name in world.HOSTS:
            hosts.start(name)
        yield hosts
    finally:
        hosts.close()


@pytest.fixture(scope="module")
def box(request):
    """A sandbox Box for one module, removed afterwards (kept with ROSTER_E2E_KEEP=1)."""
    # short: ssh's ControlPath (HOME/.ssh/cm-HASH.RANDOM) must fit a Unix socket's 107 bytes
    root = world.sandbox_root(request.module.__name__.rsplit(".", 1)[-1].removeprefix("test_").split("_")[0])
    b = world.Box.make(root, {"LAB_PW": world.PASSWORDS["lab"], "WEB_PW": "web-pass-1"})
    yield b
    b.close()
    if os.environ.get("ROSTER_E2E_KEEP") != "1":
        shutil.rmtree(root, ignore_errors=True)
