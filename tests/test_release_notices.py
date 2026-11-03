"""scripts/check-release-notices.py and release.yml (T170, #321): every release archive that ships LICENSE ships
THIRD-PARTY-NOTICES next to it, since the app binaries carry code ported from other projects (wcwidth.rs, MIT).
Here the script runs on made-up archives, and release.yml must pack the notices and run the script."""
import importlib.util
import io
import json
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


# T180 (#343): the installers (.exe, .msi, .deb, .AppImage, .dmg, .app) carry both files too. Tauri puts
# bundle.resources on disk with the installed app, and bundle.licenseFile is the licence the installer shows.

TAURI_CONF = ROOT / "app/src-tauri/tauri.conf.json"
BOTH = {"../../LICENSE": "LICENSE", "../../THIRD-PARTY-NOTICES": "THIRD-PARTY-NOTICES"}


def test_the_app_bundle_config_carries_license_and_notices():
    assert rn.config_gaps(TAURI_CONF) == []


def test_a_bundle_config_without_the_notices_names_what_is_missing(tmp_path):
    conf = tmp_path / "tauri.conf.json"
    conf.write_text('{"bundle": {"resources": {"../../LICENSE": "LICENSE"}, "licenseFile": "../../LICENSE"}}')
    assert rn.config_gaps(conf) == ["bundle.resources has no ../../THIRD-PARTY-NOTICES (as THIRD-PARTY-NOTICES)"]
    conf.write_text('{"bundle": {"resources": %s}}' % json.dumps(BOTH))
    assert rn.config_gaps(conf) == ["bundle.licenseFile isn't ../../LICENSE"]
    # A list keeps the ../../ in the installed path (_up_/_up_/LICENSE): the files must sit at the top.
    conf.write_text('{"bundle": {"resources": ["../../LICENSE", "../../THIRD-PARTY-NOTICES"], "licenseFile": "../../LICENSE"}}')
    assert len(rn.config_gaps(conf)) == 2
    conf.write_text('{"bundle": {}}')
    assert len(rn.config_gaps(conf)) == 3


def test_the_script_checks_a_bundle_config_given_with_config(tmp_path, capsys):
    good = tmp_path / "good.json"
    good.write_text('{"bundle": {"resources": %s, "licenseFile": "../../LICENSE"}}' % json.dumps(BOTH))
    assert rn.main(["--config", str(good)]) == 0
    bad = tmp_path / "bad.json"
    bad.write_text('{"bundle": {}}')
    assert rn.main(["--config", str(bad)]) == 1
    assert "THIRD-PARTY-NOTICES" in capsys.readouterr().err


def test_an_unpacked_installer_must_hold_both_files_side_by_side(tmp_path, capsys):
    good = tmp_path / "deb"
    (good / "usr/lib/Roster").mkdir(parents=True)
    (good / "usr/lib/Roster/LICENSE").write_text("made-up\n")
    (good / "usr/lib/Roster/THIRD-PARTY-NOTICES").write_text("made-up\n")
    assert rn.main([str(good)]) == 0
    assert "usr/lib/Roster" in capsys.readouterr().out
    none = tmp_path / "nsis"
    (none / "bin").mkdir(parents=True)
    apart = tmp_path / "dmg"
    (apart / "a").mkdir(parents=True)
    (apart / "b").mkdir()
    (apart / "a/LICENSE").write_text("made-up\n")
    (apart / "b/THIRD-PARTY-NOTICES").write_text("made-up\n")
    assert rn.main([str(good), str(none), str(apart)]) == 1
    err = capsys.readouterr().err
    assert str(none) in err and str(apart) in err and str(good) not in err


def test_release_yml_checks_every_installer_it_builds_and_dry_runs_on_bundle_config_changes():
    wf = yaml.safe_load((ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8"))
    for name, job in app_jobs().items():
        checks = [s for s in job["steps"] if s.get("name", "").startswith("Installers carry")]
        assert checks and all("scripts/check-release-notices.py" in s["run"] for s in checks), \
            f"release.yml job {name} doesn't check its unpacked installers"
        unpacked = "\n".join(s["run"] for s in checks)
        for installer in ("-setup.exe", ".msi", ".deb", ".AppImage", ".dmg", "Roster.app"):
            assert installer in unpacked, f"release.yml job {name} doesn't check its {installer}"
    on = wf[True] if True in wf else wf["on"]
    assert "app/src-tauri/tauri.conf.json" in on["pull_request"]["paths"]
