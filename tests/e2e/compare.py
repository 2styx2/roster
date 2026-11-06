"""Compare two recordings of the end-to-end suite (scripts/e2e.sh --compare REF; docs/development.md, "End-to-end
suite"): the same steps run by two rosters, each in fresh sandboxes against fresh stand-in Hosts. What differs from
run to run (sandbox paths, key material, fingerprints, times, tokens) is normalised first, so every difference left
is a difference in what roster did: exit codes, stdout, stderr, --json, serve's answers and notifications, and the
files it wrote on the Box and on the Hosts.

    python tests/e2e/compare.py BASE.jsonl HEAD.jsonl [--out DIFF.txt]

Exit 0 when the two agree, 1 with a unified diff of each step that doesn't."""

from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

RULES = [
    # how each roster names itself where it writes its own command line (ROSTER.md): its own venv's python
    (re.compile(r"(?:/[\w.+-]+)+/\.venv/bin/python3? -m roster"), "roster"),
    (re.compile(r"(?:/[\w.+-]+)+/\.venv/lib/"), "<VENV>/lib/"),          # a traceback's frames
    # a sandbox's folder (sandbox_root: e2e-MODULE-XXXXXXXX), wherever it is
    (re.compile(r"(?:/[\w.+-]+)*/e2e-[a-z_]+-[a-z0-9_]{8}"), "<ROOT>"),
    (re.compile(r"(?:/[\w.+-]+)*/(?:tmp|rostere2e)/[\w.-]*roster[\w.-]*-[a-z0-9_]{6,}"), "<TMP>"),
    (re.compile(r"roster-askpass-\d+-[\w]{8}"), "roster-askpass-<ID>"),    # serve's askpass folder
    (re.compile(r"(?<=vault-seen/)[0-9a-f]{16}"), "<ID>"),                 # named after the sandbox's path
    (re.compile(r"-----BEGIN [A-Z ]+-----.*?-----END [A-Z ]+-----", re.S), "<PRIVATE KEY>"),
    (re.compile(r"AAAA[0-9A-Za-z+/]{30,}={0,2}"), "<KEY>"),
    (re.compile(r"\|1\|[0-9A-Za-z+/=]+\|[0-9A-Za-z+/=]+"), "<HASHED>"),
    (re.compile(r"SHA256:[0-9A-Za-z+/]{43}"), "<FP>"),
    (re.compile(r"MD5(?::[0-9a-f]{2}){16}"), "<FP>"),
    # which of a Host's keys is "the recorded" one follows ssh-keyscan's order, which varies from run to run
    (re.compile(r"(?<=the recorded )(?:ssh-ed25519|ecdsa-sha2-nistp\d+|ssh-rsa)(?= key)"), "<KEYTYPE>"),
    (re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}| UTC)?"), "<TIME>"),
    (re.compile(r"\b20\d{2}-\d{2}-\d{2}(?:-\d{6})?\b"), "<DATE>"),
    (re.compile(r"\b20\d{2}(?:0\d|1[0-2])[0-3]\d\b"), "<DATE>"),
    (re.compile(r"<DATE>-\d{6}\b"), "<DATE>"),
    (re.compile(r"\b\d{9,11}(?:\.\d+)?\b"), "<EPOCH>"),
    (re.compile(r"\b[0-9a-f]{32,}\b"), "<HEX>"),
    (re.compile(r'(?<=")(?!ed25519")[0-9a-f]{7,12}(?=")'), "<SHA>"),       # a short commit id in JSON
    (re.compile(r"\b\d+(?:\.\d+)? ?(?:ms|seconds?|s)\b"), "<DURATION>"),
    (re.compile(r"(?<=cm-)[\w.]+"), "<CM>"),
]
# Lines a command prints for each Host as its workers finish them ("  ok    lab-01"): their order is the race's
PARALLEL = re.compile(r"^  \w+ +\S+$")


def normal(text: str) -> str:
    for rx, to in RULES:
        text = rx.sub(to, text)
    return text


def unrace(text: str) -> str:
    """TEXT with each run of PARALLEL lines sorted."""
    out: list[str] = []
    run: list[str] = []
    for line in text.split("\n"):
        if PARALLEL.match(line):
            run.append(line)
            continue
        out += sorted(run) + [line]
        run = []
    return "\n".join(out + sorted(run))


def file_text(name: str, text: str | None) -> str:
    if text is None:
        return "<absent>"
    text = normal(text)
    name = re.sub(r" \(\d{4}\)$", "", name)          # the file's mode
    if "known_hosts" in name:                   # ssh-keyscan's order
        text = "\n".join(sorted(text.split("\n")))
    if name.endswith(".lock"):                  # the pid that holds it
        text = re.sub(r"^\d+$", "<PID>", text, flags=re.M)
    return text


VOLATILE = {"ROSTER_ASKPASS_TOKEN"}         # keys whose value is new every time (a one-time token)


def shape(value):
    """VALUE with every string normalised, and dict keys sorted (json.dumps sorts them)."""
    if isinstance(value, str):
        return normal(value)
    if isinstance(value, list):
        return [shape(v) for v in value]
    if isinstance(value, dict):
        return {k: "<VOLATILE>" if k in VOLATILE else shape(v) for k, v in value.items()}
    return value


def load(path: Path) -> tuple[dict[str, list[str]], list[str]]:
    """Each step's normalised record (a step run twice keeps both, in order), and the steps in order."""
    steps: dict[str, list[str]] = defaultdict(list)
    order: list[str] = []
    notes: dict[str, list[str]] = defaultdict(list)
    for line in path.read_text().splitlines():
        rec = json.loads(line)
        kind, step = rec.pop("kind"), rec.pop("step")
        if kind == "note":
            # notifications interleave with answers as threads finish: compared as a set per serve, in order of
            # method and content, never by when they came
            note = shape(rec["note"])
            if note.get("method") == "job.progress" and note.get("params", {}).get("state") == "running":
                continue                # how many of a job's steps it reports while running is the clock's
            notes[step].append(json.dumps(note, sort_keys=True))
            continue
        if kind == "files":
            rendered = "\n".join(f"--- {normal(k)}\n{file_text(k, v)}" for k, v in sorted(rec["files"].items()))
        else:
            rec = shape(rec)
            rendered = render(kind, rec)
        key = f"{kind}:{step}"
        if key not in steps:
            order.append(key)
        steps[key].append(rendered)
    for step, lines in notes.items():
        key = f"notes:{step}"
        order.append(key)
        steps[key].append("\n".join(sorted(set(lines))))
    return steps, order


def render(kind: str, rec: dict) -> str:
    if kind == "run":
        out = rec.get("out", "")
        try:
            out = json.dumps(json.loads(out), indent=1, sort_keys=True)     # --json: one key a line
        except (ValueError, TypeError):
            out = unrace(out)
        err = unrace(rec.get("err", ""))
        return f"$ {' '.join(rec['argv'])}\nexit {rec['code']}\n--- stdout\n{out}\n--- stderr\n{err}"
    return json.dumps(rec, indent=1, sort_keys=True)


def compare(base: Path, head: Path) -> list[str]:
    a, a_order = load(base)
    b, b_order = load(head)
    report: list[str] = []
    for key in a_order + [k for k in b_order if k not in a]:
        left, right = a.get(key, []), b.get(key, [])
        if left == right:
            continue
        lt = "\n=====\n".join(left) if left else "<step not run>"
        rt = "\n=====\n".join(right) if right else "<step not run>"
        diff = difflib.unified_diff(lt.splitlines(), rt.splitlines(), f"base {key}", f"head {key}", lineterm="", n=2)
        report.append("\n".join(diff))
    return report


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("base", type=Path)
    ap.add_argument("head", type=Path)
    ap.add_argument("--out", type=Path)
    args = ap.parse_args(argv)
    report = compare(args.base, args.head)
    text = "\n\n".join(report)
    if args.out:
        args.out.write_text(text + "\n")
    print(text if report else "the two runs agree on every step")
    if report:
        print(f"\n{len(report)} steps differ", file=sys.stderr)
    return 1 if report else 0


if __name__ == "__main__":
    sys.exit(main())
