"""The filter between `bw list items` and roster (decision Q191, the owner's ruling of 2026-11-04).

`bw list items` prints every item whole: its password, TOTP seed, notes and custom fields too. Bitwarden's CLI has no
way to list only names. So roster never reads that output itself: bw's stdout is connected straight to this script's
stdin (an OS pipe between the two child processes), and roster reads only what this script prints.

What it prints, one JSON object a line, for each login item (type 1): {"id", "name", "uris", "username"}, nothing
else. A value of the wrong type is left out (an empty name, no URIs, no username). It writes nothing anywhere else:
no file, no log, and on stderr only one of two fixed lines, never anything it read:
  exit 2  "not a list of items"   (not JSON, not a list, not UTF-8)
  exit 3  "too many items"        (over the cap: the first argument, in bytes; default CAP)

Standard library only, and roster runs it as `python -I -S` (no site, no user or current folder on sys.path, no
PYTHON* variables), so nothing but this file and the standard library runs with the vault's items in memory."""

import json
import sys

CAP = 64 * 1024 * 1024          # bytes of bw output; a vault of thousands of items is a few MB


def keep(item):
    """The one row roster may see for ITEM, or None when it isn't a login item."""
    if not isinstance(item, dict) or item.get("type", 1) != 1:
        return None
    login = item.get("login")
    login = login if isinstance(login, dict) else {}
    uris = login.get("uris")
    uris = [u["uri"] for u in uris if isinstance(u, dict) and isinstance(u.get("uri"), str)] \
        if isinstance(uris, list) else []
    name, username, item_id = item.get("name"), login.get("username"), item.get("id")
    return {"id": item_id if isinstance(item_id, str) else "", "name": name if isinstance(name, str) else "",
            "uris": uris, "username": username if isinstance(username, str) else None}


def main(argv):
    cap = int(argv[1]) if len(argv) > 1 else CAP
    data = sys.stdin.buffer.read(cap + 1)
    if len(data) > cap:
        del data
        sys.stderr.write("too many items\n")
        return 3
    try:
        items = json.loads(data.decode("utf-8"))
    except Exception:                                   # never the error's text: it quotes what it read
        items = None
    del data
    if not isinstance(items, list):
        sys.stderr.write("not a list of items\n")
        return 2
    out = sys.stdout
    for item in items:
        row = keep(item)
        if row is not None and row["id"]:
            out.write(json.dumps(row) + "\n")
    out.flush()
    return 0


if __name__ == "__main__":
    try:
        code = main(sys.argv)
    except BaseException:                               # a traceback would show the line it failed on, and values
        sys.stderr.write("not a list of items\n")
        code = 2
    sys.exit(code)
