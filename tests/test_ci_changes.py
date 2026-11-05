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
    # pyproject's addopts already has -q: one -q more would print counts per file, not the tests
    r = subprocess.run([sys.executable, "-m", "pytest", "--collect-only", "-p", "no:cacheprovider",
                        "tests/test_ci_changes.py", *args], cwd=ROOT, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stdout + r.stderr
    tests = [line for line in r.stdout.splitlines() if "::" in line]
    assert tests or "--shard" in args, r.stdout
    return tests


def test_shards_split_the_suite_with_nothing_lost_or_run_twice():
    every = collected()
    shards = [collected("--shard", f"{k}/3") for k in (1, 2, 3)]
    assert sorted(sum(shards, [])) == sorted(every)


def test_shards_balance_the_recorded_times_not_the_count(tmp_path):
    every = collected()
    slow, rest = every[0], every[1:]
    times = tmp_path / "durations.json"
    times.write_text(json.dumps({slow: 100.0, **{t: 0.5 for t in rest}}))
    shards = [collected("--shard", f"{k}/3", "--shard-durations", str(times)) for k in (1, 2, 3)]
    assert sorted(sum(shards, [])) == sorted(every)
    assert [slow] in shards                     # 100 s alone; the 0.5 s tests share the other two shards
    a, b = (s for s in shards if s != [slow])
    assert abs(len(a) - len(b)) <= 1


def test_each_test_also_costs_a_second_of_its_own_so_quick_ones_spread_out_too(tmp_path):
    # Each test costs about a second beyond its recorded time on the Windows runner:
    # PR #455's first run gave one shard 1,376 quick tests, 693 s, against 369 slow ones, 409 s.
    every = collected()
    times = tmp_path / "durations.json"
    times.write_text(json.dumps({t: 0.0 for t in every}))
    shards = [collected("--shard", f"{k}/3", "--shard-durations", str(times)) for k in (1, 2, 3)]
    assert sorted(sum(shards, [])) == sorted(every)
    assert all(abs(len(s) - len(every) / 3) < 1 for s in shards)


def test_a_shard_runs_its_longest_tests_first_so_no_worker_is_left_with_one_at_the_end(tmp_path):
    every = collected()
    times = tmp_path / "durations.json"
    times.write_text(json.dumps({t: float(i) for i, t in enumerate(every)}))   # the last collected is the longest
    for k in (1, 2, 3):
        shard = collected("--shard", f"{k}/3", "--shard-durations", str(times))
        assert shard == sorted(shard, key=every.index, reverse=True)


def test_a_test_with_no_recorded_time_counts_as_the_average(tmp_path):
    every = collected()
    times = tmp_path / "durations.json"
    # Two known tests of 30 s, and a stale name: every new test counts 30 s, so the count splits evenly.
    times.write_text(json.dumps({every[0]: 30.0, every[1]: 30.0, "tests/test_gone.py::test_old": 30.0}))
    shards = [collected("--shard", f"{k}/3", "--shard-durations", str(times)) for k in (1, 2, 3)]
    assert sorted(sum(shards, [])) == sorted(every)
    assert all(abs(len(s) - len(every) / 3) < 1 for s in shards)


def test_without_a_timing_file_each_test_counts_the_same(tmp_path):
    every = collected()
    shards = [collected("--shard", f"{k}/3", "--shard-durations", str(tmp_path / "none.json")) for k in (1, 2, 3)]
    assert sorted(sum(shards, [])) == sorted(every)
    assert all(abs(len(s) - len(every) / 3) < 1 for s in shards)


def test_store_durations_writes_each_tests_seconds_from_every_worker(tmp_path):
    import subprocess
    import sys
    out = tmp_path / "durations.json"
    r = subprocess.run([sys.executable, "-m", "pytest", "-p", "no:cacheprovider", "-n", "2", "tests/test_ci_changes.py",
                        "-k", "main_writes or every_python", "--store-durations", str(out)],
                       cwd=ROOT, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stdout + r.stderr
    times = json.loads(out.read_text())
    assert sorted(times) == ["tests/test_ci_changes.py::test_main_runs_every_python_off_a_pull_request",
                             "tests/test_ci_changes.py::test_main_writes_the_github_outputs"]
    assert all(isinstance(t, float) and 0 <= t < 60 for t in times.values())


def test_the_nightly_merges_the_shards_times_into_one_file_and_says_how_even_they_ran(tmp_path):
    spec = importlib.util.spec_from_file_location("shard_durations", ROOT / "scripts" / "shard_durations.py")
    assert spec and spec.loader
    shard_durations = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(shard_durations)
    a, b, out = tmp_path / "a.json", tmp_path / "b.json", tmp_path / "out.json"
    a.write_text(json.dumps({"tests/test_b.py::test_y": 40.0, "tests/test_a.py::test_x": 2.123}))
    b.write_text(json.dumps({"tests/test_c.py::test_z": 30.5}))
    summary = tmp_path / "summary.md"
    assert shard_durations.main([str(out), str(a), str(b), "--summary", str(summary)]) == 0
    assert json.loads(out.read_text()) == {"tests/test_a.py::test_x": 2.1, "tests/test_b.py::test_y": 40.0,
                                           "tests/test_c.py::test_z": 30.5}
    assert list(json.loads(out.read_text())) == sorted(json.loads(out.read_text()))
    text = summary.read_text()
    assert "| 1 | 2 | 42 s |" in text and "| 2 | 1 | 30 s |" in text and "3 tests, 73 s" in text
