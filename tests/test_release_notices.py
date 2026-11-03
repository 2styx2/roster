"""scripts/check-release-notices.py and release.yml (T170, #321): every release archive that ships LICENSE ships
THIRD-PARTY-NOTICES next to it, since the app binaries carry code ported from other projects (wcwidth.rs, MIT).
Here the script runs on made-up archives, and release.yml must pack the notices and run the script."""
import importlib.util
import io
import tarfile
import zipfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("check_release_notices", ROOT / "scripts" / "check-release-notices.py")
rn = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rn)


def tgz(path, names):
    with tarfile.open(path, "w:gz") as t:
        for name in names:
            data = b"made-up\n"
            info = tarfile.TarInfo(name)
            info.size = len(data)
            t.addfile(info, io.BytesIO(data))
    return path


def zip_(path, names):
    with zipfile.ZipFile(path, "w") as z:
        for name in names:
            z.writestr(name, "made-up\n")
    return path


def test_an_archive_with_license_and_notices_side_by_side_passes(tmp_path, capsys):
    a = tgz(tmp_path / "roster-app-0.0.0-linux-x64.tar.gz", ["roster-app", "LICENSE", "THIRD-PARTY-NOTICES"])
    b = zip_(tmp_path / "roster-app-0.0.0-windows-x64.zip", ["roster-app.exe", "LICENSE", "THIRD-PARTY-NOTICES"])
    c = tgz(tmp_path / "roster-app-0.0.0-macos.tar.gz",
            ["./Roster.app/Contents/MacOS/roster-app", "./LICENSE", "./THIRD-PARTY-NOTICES"])
    assert rn.main([str(a), str(b), str(c)]) == 0


def test_an_archive_with_license_but_no_notices_fails_and_names_it(tmp_path, capsys):
    ok = zip_(tmp_path / "ok.zip", ["roster-app.exe", "LICENSE", "THIRD-PARTY-NOTICES"])
    bad = tgz(tmp_path / "roster-app-0.0.0-linux-x64.tar.gz", ["roster-app", "LICENSE"])
    assert rn.main([str(ok), str(bad)]) == 1
    err = capsys.readouterr().err
    assert "roster-app-0.0.0-linux-x64.tar.gz" in err and "THIRD-PARTY-NOTICES" in err and "ok.zip" not in err


def test_the_notices_must_sit_next_to_license_not_elsewhere(tmp_path, capsys):
    bad = tgz(tmp_path / "a.tar.gz", ["LICENSE", "docs/THIRD-PARTY-NOTICES"])
    assert rn.main([str(bad)]) == 1


def test_no_archives_or_an_unknown_kind_is_a_usage_error(tmp_path, capsys):
    assert rn.main([]) == 2
    (tmp_path / "x.dmg").write_bytes(b"\0")
    assert rn.main([str(tmp_path / "x.dmg")]) == 2


def app_jobs():
    """release.yml's jobs that build the app binary (they run `tauri build`)."""
    wf = yaml.safe_load((ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8"))
    jobs = {name: job for name, job in wf["jobs"].items()
            if any("tauri build" in s.get("run", "") for s in job.get("steps", []))}
    assert jobs, "release.yml has no job that runs `tauri build`"
    return jobs


def test_every_release_step_that_packs_license_into_an_app_archive_packs_the_notices_too():
    for name, job in app_jobs().items():
        for step in job["steps"]:
            run = step.get("run", "")
            licence = run.count("LICENSE")
            assert run.count("THIRD-PARTY-NOTICES") == licence, \
                f"release.yml job {name}, step {step.get('name')!r}: names LICENSE {licence} times but " \
                f"THIRD-PARTY-NOTICES {run.count('THIRD-PARTY-NOTICES')} times"


def test_release_yml_checks_the_app_archives_it_packed():
    for name, job in app_jobs().items():
        runs = [s.get("run", "") for s in job["steps"]]
        collect = max(i for i, r in enumerate(runs) if "LICENSE" in r)
        assert any("scripts/check-release-notices.py" in r for r in runs[collect + 1:]), \
            f"release.yml job {name} doesn't run scripts/check-release-notices.py after packing"
    wf = yaml.safe_load((ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8"))
    on = wf[True] if True in wf else wf["on"]          # YAML 1.1 reads a bare `on` as true
    assert "scripts/check-release-notices.py" in on["pull_request"]["paths"]


def test_the_notices_file_exists_and_releasing_md_says_when_to_update_it():
    assert "wcwidth.rs" in (ROOT / "THIRD-PARTY-NOTICES").read_text(encoding="utf-8")
    text = (ROOT / "docs/releasing.md").read_text(encoding="utf-8")
    assert "THIRD-PARTY-NOTICES" in text and "check-release-notices.py" in text
