"""Check that release archives ship THIRD-PARTY-NOTICES next to LICENSE (T170, docs/releasing.md).

The app binaries carry code ported from other projects (THIRD-PARTY-NOTICES lists it), and their licences
ask that the notice ship with every copy. release.yml runs this on the app's archives right after packing them:

    python3 scripts/check-release-notices.py out/*.zip out/*.tar.gz

In every .zip, .tar.gz or .tgz given, each folder that holds a LICENSE must hold a THIRD-PARTY-NOTICES too.
Exit 0 when all of them do, 1 when one doesn't, 2 on bad arguments. Standard library only (it runs on the
release runners' own Python).
"""

import sys
import tarfile
import zipfile
from pathlib import PurePosixPath

NOTICES = "THIRD-PARTY-NOTICES"


def names(archive):
    """Every member path in ARCHIVE, without a leading ./ ; None when it isn't a kind this reads."""
    a = str(archive)
    if a.endswith(".zip"):
        with zipfile.ZipFile(a) as z:
            raw = z.namelist()
    elif a.endswith((".tar.gz", ".tgz")):
        with tarfile.open(a, "r:gz") as t:
            raw = t.getnames()
    else:
        return None
    return {str(PurePosixPath(n.replace("\\", "/"))) for n in raw}


def missing(members):
    """The folders in MEMBERS that hold a LICENSE but no THIRD-PARTY-NOTICES ("." for the top)."""
    out = []
    for n in sorted(members):
        p = PurePosixPath(n)
        if p.name == "LICENSE" and str(p.with_name(NOTICES)) not in members:
            out.append(str(p.parent))
    return out


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if not argv:
        print("usage: check-release-notices.py ARCHIVE...", file=sys.stderr)
        return 2
    bad = 0
    for a in argv:
        members = names(a)
        if members is None:
            print(f"error: {a}: not a .zip, .tar.gz or .tgz", file=sys.stderr)
            return 2
        gaps = missing(members)
        for folder in gaps:
            where = "at its top" if folder == "." else f"in {folder}/"
            print(f"error: {a} has LICENSE but no {NOTICES} {where}: pack {NOTICES} next to LICENSE "
                  "(.github/workflows/release.yml)", file=sys.stderr)
        if gaps:
            bad = 1
        else:
            print(f"{a}: ok")
    return bad


if __name__ == "__main__":
    sys.exit(main())
