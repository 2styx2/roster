"""CI's path filter (T232, decision Q196): which jobs a pull request's changed files run."""
from __future__ import annotations

import importlib.util
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("ci_changes", ROOT / "scripts" / "ci_changes.py")
assert _spec and _spec.loader
ci_changes = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ci_changes)

ALL = {"cli", "windows", "frontend", "rust", "release"}


def run(*files: str) -> set[str]:
    return ci_changes.areas("pull_request", list(files))


def test_a_push_a_tag_or_the_schedule_runs_everything():
    for event in ("push", "schedule", "workflow_dispatch"):
        assert ci_changes.areas(event, []) == ALL
        assert ci_changes.areas(event, ["docs/news.md"]) == ALL


def test_a_cli_only_pr_skips_the_app_and_the_release_builds():
    assert run("src/roster/cli.py", "tests/test_cli.py") == {"cli", "windows"}
    assert run("pyproject.toml", "uv.lock") == {"cli", "windows"}


def test_an_app_only_pr_skips_windows_python_and_the_release_builds():
    # The Linux suite still runs: tests/ cross-check app/src (guideText.ts, backend/types.ts, ...).
    assert run("app/src/App.tsx") == {"cli", "frontend", "rust"}


def test_the_release_builds_run_only_for_what_they_build():
    assert "release" in run("app/src-tauri/src/main.rs")
    assert "release" in run("app/src-tauri/tauri.conf.json")
    assert "release" in run("crates/roster-core/src/rpc.rs")
    assert "release" in run("Cargo.lock")
    assert "release" in run("app/package-lock.json")
    assert run(".github/workflows/release.yml") == {"release"}
    assert "release" not in run("app/src/App.tsx", "src/roster/cli.py")


def test_rust_changes_run_the_rust_jobs_and_whatever_reads_the_core():
    assert run("crates/roster-core/src/rpc.rs") == {"cli", "frontend", "rust", "release"}
    assert run("plugins/mesh/init.lua") == {"frontend", "rust"}


def test_docs_only_runs_the_jobs_that_check_the_docs():
    assert run("docs/news.md") == {"cli", "frontend", "rust"}
    assert run("README.md", "GLOSSARY.md") == {"cli", "frontend", "rust"}


def test_shared_files_and_ci_itself_run_everything():
    assert run(".github/workflows/ci.yml") == ALL
    assert run("scripts/check-bundle-size.py") == ALL
    assert run("tests/vectors/redaction.json") == {"cli", "windows", "frontend", "rust"}
    assert run("something/new.txt") == ALL          # an unknown path: everything, to be safe


def test_both_sides_run_the_union():
    assert run("src/roster/serve.py", "app/src/App.tsx") == {"cli", "windows", "frontend", "rust"}


def test_other_workflows_run_nothing_here():
    assert run(".github/workflows/docs.yml") == set()


def test_main_writes_the_github_outputs(tmp_path):
    files = tmp_path / "files"
    files.write_text("src/roster/cli.py\n\n")
    out = tmp_path / "out"
    assert ci_changes.main(["--event", "pull_request", "--files", str(files), "--output", str(out)]) == 0
    lines = dict(line.split("=", 1) for line in out.read_text().splitlines())
    assert lines["cli"] == "true" and lines["windows"] == "true"
    assert lines["frontend"] == "false" and lines["rust"] == "false" and lines["release"] == "false"
    assert json.loads(lines["python"]) == ["3.12"]


def test_main_runs_every_python_off_a_pull_request(tmp_path):
    out = tmp_path / "out"
    assert ci_changes.main(["--event", "push", "--output", str(out)]) == 0
    lines = dict(line.split("=", 1) for line in out.read_text().splitlines())
    assert json.loads(lines["python"]) == ["3.10", "3.12", "3.13"]
    assert all(lines[a] == "true" for a in ALL)


def collected(*args: str) -> list[str]:
    import subprocess
    import sys
    r = subprocess.run([sys.executable, "-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider",
                        "tests/test_ci_changes.py", *args], cwd=ROOT, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stdout + r.stderr
    return [line for line in r.stdout.splitlines() if "::" in line]


def test_shards_split_the_suite_with_nothing_lost_or_run_twice():
    every = collected()
    shards = [collected("--shard", f"{k}/3") for k in (1, 2, 3)]
    assert sorted(sum(shards, [])) == sorted(every)
    assert all(abs(len(s) - len(every) / 3) < 1 for s in shards)   # every 3rd test: even, slow files spread out
# CI timing probe (T232): a CLI-only change.
