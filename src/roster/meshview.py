"""The Mesh as the command line shows it: a plan, an apply or `roster check`'s drift as text, a cut that isn't
finished, and the Mesh apply `roster setup` and `setup --rotate` run (mesh.run, then its lines)."""

import sys

from . import mesh
from .common import plural, say

LINK_WORDS = {"ok": "ok", "untested": "ok (port not tested: no nc or bash there)", "unreachable": "UNREACHABLE",
              "no-host-key": "NO HOST KEY", "no-via": "NO LINK TO ITS HOP", "pending": "pending", "skipped": "skipped"}
BROKEN_LINKS = ("unreachable", "no-host-key", "no-via")


def broken(drift):
    """Whether `roster check` fails for the Mesh: a Host pending, one changed since roster wrote it, a link broken."""
    return bool(drift["pending"] or any(h["changes"] for h in drift["hosts"])
                or any(x["status"] in BROKEN_LINKS for x in drift["links"]))


def show_mesh(r, drift=False):
    """A plan or an apply as text: the links, what changes where, what's left out, what's unfinished."""
    links = r["links"]
    if not drift:
        say(f"links        {plural(len(links), 'link')} "
            f"({sum(x['kind'] == 'key' for x in links)} key, {sum(x['kind'] == 'password' for x in links)} password)")
        def pair(x):
            return f"{x['from']} -> {x['to']}" + (f" via {x['via']}" if x.get("via") else "")
        width = max((len(pair(x)) for x in links), default=0)
        for x in links:
            word = LINK_WORDS[x["status"]]
            word = "ok (hop not tested)" if x["status"] == "untested" and x.get("via") else word
            why = f" - {x['why']}" if x.get("why") and (x["status"] != "untested" or x.get("via")) else ""
            note = " (ssh asks the person for the password)" if x["kind"] == "password" and x["status"] == "ok" else ""
            say(f"  {pair(x):<{width}} {x['kind']:<9}{word}{note}{why}")
    else:
        for x in links:
            if x["status"] in BROKEN_LINKS:
                say(f"  link {x['from']} -> {x['to']}: {x['why']}")
    changed = [h for h in r["hosts"] if h["changes"]]
    if changed:
        say("mesh drift (on the Hosts, not what roster wrote):" if drift else
            "changes" if r["applied"] else "would change")
        for h in changed:
            say(f"  {h['host']}: {', '.join(h['changes'])}")
    if r["excluded"] and not drift:
        say("left out: " + ", ".join(f"{n} ({why})" for n, why in r["excluded"].items()))
    for w in r["warnings"]:
        say(f"warning: {w}")
    if r["pending"]:
        say(f"pending on {plural(len(r['pending']), 'Host')} (finished by the next `roster mesh` once they answer):")
        for n, why in r["pending"].items():
            say(f"  {n}: {why}")
    warn_cut(r.get("cut_pending") or {})


def warn_cut(cut):
    for host, peers in cut.items():
        print(f"WARNING: CUT PENDING ON {plural(len(peers), 'HOST').upper()}: {', '.join(peers)} - {host}'s cut isn't "
              "finished there; `roster mesh cut " + host + "` again, or `roster mesh`, once they answer",
              file=sys.stderr, flush=True)
        say(f"cut pending on {plural(len(peers), 'Host')} for {host}: {', '.join(peers)}")


def apply(cfg):
    """The Mesh applied, its lines said: {host: why} for what it left pending."""
    r = mesh.run(cfg, apply=True, say=say)
    show_mesh(r)
    return r["pending"]
