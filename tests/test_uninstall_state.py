"""uninstall.sh removes every file roster itself keeps in its own folder (~/.config/roster), and only asks about the
rest. Its list is shell globs; context.FILES and key_created_file are where roster names those files."""

import fnmatch
import re
from pathlib import Path

from roster import context

UNINSTALL = Path(__file__).resolve().parent.parent / "uninstall.sh"


def removed_globs() -> list[str]:
    """The globs of the `mine=()` loop: roster's state in $CONF_DIR."""
    text = UNINSTALL.read_text().replace("\\\n", " ")
    loop = next(line for line in text.splitlines() if line.lstrip().startswith("for p in") and "$CONF_DIR" in line
                and "mine+=" in line)
    return re.findall(r'"\$CONF_DIR"/(\S+?)(?=\s|;)', loop)


def roster_state_names() -> list[str]:
    names = ["key-created", context.key_created_file().name]
    for f in context.FILES.values():
        if f.folder is context.user_config_dir:
            names += [f.unnamed, f.named.format("work"), f.named.format("work") + ".removed-20260101T000000"]
    return names


def test_uninstall_removes_every_file_roster_keeps_in_its_folder():
    globs = removed_globs()
    missing = [n for n in roster_state_names() if not any(fnmatch.fnmatch(n, g) for g in globs)]
    assert not missing, f"uninstall.sh's mine=() loop doesn't remove {missing}: add a glob for each"


def test_it_never_removes_what_a_user_puts_there():
    globs = removed_globs()
    for yours in ("roster.yml", "init.lua", "providers", "notes.txt"):
        assert not any(fnmatch.fnmatch(yours, g) for g in globs), yours
