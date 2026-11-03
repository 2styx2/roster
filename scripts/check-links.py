"""Check the external links in the docs (ticket 53, decision Q85), like Neovim's lintdocurls.

Run weekly by .github/workflows/links.yml (and by hand from its Run workflow button), never on a pull
request: it's slow, and other people's sites are flaky. Relative links are checked on every PR already
(tests/test_docs.py, app/src/help/lint.test.ts). From a clone:

    python3 scripts/check-links.py                       # prints the dead links; exits 1 if there are any
    python3 scripts/check-links.py --report dead.md      # also writes them as the standing issue's body

It checks every http(s) link in docs/**/*.md, README.md, CONTRIBUTING.md, GLOSSARY.md and app/README.md,
outside code. Made-up and private addresses are skipped (example.com and the like, IP addresses, localhost,
.lan/.local/.internal names), and so are placeholders a sentence describes (http://HOST:PORT, https://…), so
it only ever fetches, and prints, the docs' own public URLs.

A link is dead when the site answers 404, 410 or a 5xx, or can't be reached at all (DNS, refused, TLS, no
answer in 20 s), twice. 401, 403, 429 and the like are a site turning robots away, not a dead link.
Standard library only.
"""

import argparse
import concurrent.futures
import ipaddress
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parent.parent
TIMEOUT = 20
AGENT = "Mozilla/5.0 (compatible; roster-docs-linkcheck; +https://github.com/2styx2/roster)"

URL = re.compile(r"https?://[^\s<>()\[\]`'\"|]+")
# Hosts that are examples, or private, by their name.
MADE_UP = re.compile(r"(^|\.)(example\.(com|org|net)|localhost)$|\.(example|invalid|test|local|lan|internal|home)$")


def docs(root=ROOT):
    """The files the check reads: the same as tests/test_docs.py's relative-link check."""
    return [*root.glob("docs/**/*.md"), root / "README.md", root / "CONTRIBUTING.md", root / "GLOSSARY.md",
            root / "app/README.md"]


def public(url):
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if not host or MADE_UP.search(host) or "…" in host:
        return False                    # https://…: a placeholder, not a site
    try:
        _ = parts.port                  # raises on a port that isn't a number
    except ValueError:
        return False                    # http://HOST:PORT: a placeholder's port
    try:
        ipaddress.ip_address(host)
        return False                    # an address in an example, never a site of its own
    except ValueError:
        return True


def urls(text):
    """The public web links in a Markdown text, in order, once each, outside fenced code and code spans."""
    text = re.sub(r"^(```|~~~).*?^\1", "", text, flags=re.S | re.M)
    text = re.sub(r"`[^`\n]*`", "", text)
    out = []
    for m in URL.finditer(text):
        url = m.group(0).rstrip(".,;:!?*_")
        if public(url) and url not in out:
            out.append(url)
    return out


def ascii_url(url):
    """The URL as it goes on the wire: an international name in IDNA, other letters percent-encoded (an
    http request line can't carry them as they are). What's already encoded stays as it is."""
    p = urlsplit(url)
    host = p.hostname.encode("idna").decode("ascii") if p.hostname else ""
    netloc = f"{host}:{p.port}" if p.port else host
    keep = "/%:@!$&'()*+,;=~-._?#[]"
    return urlunsplit((p.scheme, netloc, quote(p.path, safe=keep), quote(p.query, safe=keep + "/"),
                       quote(p.fragment, safe=keep)))


def fetch(url):
    """The HTTP status the URL answers with (after redirects), or why it couldn't be reached."""
    try:
        url = ascii_url(url)
    except (UnicodeError, ValueError) as e:  # a name IDNA refuses: no site has it
        return str(e) or type(e).__name__
    for method in ("HEAD", "GET"):          # some sites refuse HEAD: ask again with GET
        req = urllib.request.Request(url, method=method, headers={"User-Agent": AGENT, "Accept": "*/*"})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return r.status
        except urllib.error.HTTPError as e:
            if method == "HEAD" and e.code in (403, 404, 405, 501):
                continue
            return e.code
        except urllib.error.URLError as e:
            return str(getattr(e, "reason", e)) or type(e).__name__
        except Exception as e:              # a timeout, a reset connection
            return str(e) or type(e).__name__
    return None


def verdict(answer):
    """Why the link is dead, or None when it isn't."""
    if isinstance(answer, int):
        return f"HTTP {answer}" if answer in (404, 410) or answer >= 500 and answer != 999 else None
    return answer or None


def status(url, fetch=fetch):
    """verdict, with a second try for a link that fails once (a flaky site, a slow DNS)."""
    return verdict(fetch(url)) and verdict(fetch(url))


def check(root=ROOT, fetch=fetch):
    """{url: (why, [files])} for every dead link."""
    where = {}
    for doc in sorted(docs(root), key=lambda p: p.as_posix()):         # the same order on Windows
        if doc.exists():
            for url in urls(doc.read_text(encoding="utf-8")):
                where.setdefault(url, []).append(doc.relative_to(root).as_posix())
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        whys = dict(zip(where, pool.map(lambda u: status(u, fetch), where), strict=True))
    return {url: (why, where[url]) for url, why in whys.items() if why}


def report(dead, run_url=None):
    """The standing issue's body: one row per dead link."""
    lines = [
        "The weekly check of the docs' external links (`scripts/check-links.py`, run by "
        "`.github/workflows/links.yml`) found links that don't work. Fix or drop each one; the next run "
        "updates this issue, and closes it when they all work.",
        "",
        "| Link | Why | In |",
        "|---|---|---|",
        *(f"| {url} | {why} | {', '.join(f'`{f}`' for f in files)} |" for url, (why, files) in sorted(dead.items())),
    ]
    if run_url:
        lines += ["", f"From [this run]({run_url})."]
    return "\n".join(lines) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description="Check the docs' external links.")
    ap.add_argument("--report", type=Path, help="write the dead links here, as the standing issue's body")
    ap.add_argument("--run-url", help="the workflow run, for the report")
    args = ap.parse_args(argv)
    dead = check()
    for url, (why, files) in sorted(dead.items()):
        print(f"dead: {url} ({why}) in {', '.join(files)}")
    if args.report:
        args.report.write_text(report(dead, args.run_url) if dead else "", encoding="utf-8")
    print(f"{len(dead)} dead link(s)" if dead else "every link works")
    return 1 if dead else 0


if __name__ == "__main__":
    sys.exit(main())
