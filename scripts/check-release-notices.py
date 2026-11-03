"""Check that the app's downloads ship THIRD-PARTY-NOTICES next to LICENSE (T170, T180, docs/releasing.md).

The app binaries carry code ported from other projects (THIRD-PARTY-NOTICES lists it), and their licences
ask that the notice ship with every copy. release.yml runs this on the app's archives right after packing them,
and on each installer unpacked into a folder:

    python3 scripts/check-release-notices.py out/*.zip out/*.tar.gz
    python3 scripts/check-release-notices.py unpacked/deb unpacked/appimage
    python3 scripts/check-release-notices.py --config app/src-tauri/tauri.conf.json

In every .zip, .tar.gz or .tgz given, each folder that holds a LICENSE must hold a THIRD-PARTY-NOTICES too.
A folder given (an installer unpacked, or an installed app) must have both, side by side, somewhere in it.
--config checks the Tauri config bundles both into every installer. Exit 0 when all of them do, 1 when one
doesn't, 2 on bad arguments. Standard library only (it runs on the release runners' own Python).
"""

import json
import os
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


def config_gaps(path):
    """What the Tauri config at PATH lacks for the installers to carry LICENSE and THIRD-PARTY-NOTICES.

    bundle.resources must map each from the repo root (../../ from app/src-tauri) to the top of the app's
    resources, where every installer puts it on disk, and bundle.licenseFile must be LICENSE (the licence the
    Windows installers show)."""
    with open(path, encoding="utf-8") as f:
        bundle = json.load(f).get("bundle", {})
    resources = bundle.get("resources")
    resources = resources if isinstance(resources, dict) else {}
    out = [f"bundle.resources has no ../../{n} (as {n})" for n in ("LICENSE", NOTICES)
           if resources.get(f"../../{n}") != n]
    if bundle.get("licenseFile") != "../../LICENSE":
        out.append("bundle.licenseFile isn't ../../LICENSE")
    return out


def together(folder):
    """The first folder under FOLDER (itself included) that holds both LICENSE and THIRD-PARTY-NOTICES."""
    for dirpath, _dirs, files in sorted(os.walk(folder)):
        if "LICENSE" in files and NOTICES in files:
            return dirpath
    return None


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if not argv or argv[0] == "--config" and len(argv) != 2:
        print("usage: check-release-notices.py ARCHIVE|FOLDER... | --config TAURI_CONF", file=sys.stderr)
        return 2
    if argv[0] == "--config":
        gaps = config_gaps(argv[1])
        for g in gaps:
            print(f"error: {argv[1]}: {g}: the installers must carry LICENSE and {NOTICES}", file=sys.stderr)
        if not gaps:
            print(f"{argv[1]}: ok")
        return 1 if gaps else 0
    bad = 0
    for a in argv:
        if os.path.isdir(a):
            found = together(a)
            if found is None:
                print(f"error: {a} has no folder with both LICENSE and {NOTICES}: the installer must carry them "
                      "(bundle.resources in app/src-tauri/tauri.conf.json)", file=sys.stderr)
                bad = 1
            else:
                print(f"{a}: ok ({found})")
            continue
        members = names(a)
        if members is None:
            print(f"error: {a}: not a .zip, .tar.gz, .tgz or folder", file=sys.stderr)
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
