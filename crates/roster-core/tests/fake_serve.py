"""Stand-in for `roster serve` in roster-core's tests. JSON-RPC 2.0, one object per line.

The first argument picks a behaviour:
  ok                 answers inventory.info / hosts.list / host.get / session.prepare like roster api 1 (pve's
                     Login is auth: prompt: 39 until a password comes, save: true adds held: "h1", ticket 16)
  old-api            inventory.info reports api_version 0
  unknown-key        session.prepare refuses with 44 until host.trust_key records esxi-02's key (host.scan_key shows it)
  quick              quick.prepare (Quick Connect, ticket 14): FINGERPRINT goes through, any other is 23; a
                     password gets an askpass token in env, and the password itself is never echoed back;
                     save: true (ticket 15) adds held: "q1" and the LocalCommand options
  no-inventory       every method returns error code 1, like serve without a roster.yml
  unknown-command    exits 2 at once with argparse's "invalid choice: 'serve'" (a roster from before serve)
  reverse            holds two requests, then answers them in reverse order
  shuffle            as serve's workers do (API 20): holds four requests, then answers them 3rd, 1st, 4th, 2nd, with a
                     job.progress notification before each answer
  die-on-hosts       exits without answering hosts.list
  locked             session.prepare for a password Host refuses with 14 (vault locked)
  missing-item       session.prepare for a password Host refuses with 32 (no such vault item), data.near/fix
  notify             before answering inventory.watch, sends an inventory.changed notification
  bad-prepare        session.prepare for a password Host answers a numeric askpass token (a malformed result)
  bad-fill           session.fill answers a numeric password (a malformed result)
  old-login          session.prepare leaves out `login`, as serve before API 25
  nested             inventory.info reports api_version 26 (session.fill's `hop`, ticket 120)
  fill-25            inventory.info reports api_version 25: session.fill without `hop`, which it would ignore
  hang               never answers host.get; a `$/cancel` (ticket 108) is echoed back as the notification
                     test.cancelled {params, had_id} so a test can see the client sent it
  checks             speaks API 21: host.check {background: true} starts a check job (counted in inventory.info's
                     `checks`), host.check_job says running twice, then done with the waiting form's result
  stuck-check HOW    as checks, but the check never ends; host.check {background: true} says `joined: true` when HOW
                     is `joined` (serve API 22), and each jobs.stop is counted in inventory.info's `stops`
  slow-exit FILE     once stdin closes, takes 1.5 s to wind down (as serve stopping a Mesh job and recording
                     it), then writes FILE and exits on its own
Arguments after it are echoed back by inventory.info as `argv`, so tests can see what was passed.
"""
import json
import sys

mode = sys.argv[1] if len(sys.argv) > 1 else "ok"
if mode == "unknown-command":
    print("usage: roster [-h] [--version] [-c CONFIG] {init,setup,hosts} ...", file=sys.stderr)
    print("roster: error: argument cmd: invalid choice: 'serve' (choose from init, setup, hosts)", file=sys.stderr)
    sys.exit(2)

HOSTS = [
    {"name": "esxi-02", "ip": "10.19.77.10", "group": "lab", "type": "esxi", "product": "", "title": "ESXi lab",
     "reviewed": True},
    {"name": "scan-1", "ip": "10.19.77.99", "group": "lab", "type": "linux", "product": "", "title": "",
     "reviewed": False},
    {"name": "sw-core", "ip": "10.19.1.2", "group": "lab", "type": "switch", "product": "", "title": "",
     "reviewed": True, "password": True},
]
# An auth: prompt Host (ticket 16), only for session.prepare (hosts.list keeps its three).
PROMPTED = {"name": "pve", "ip": "10.19.1.9", "group": "lab", "type": "linux", "product": "", "title": "",
            "reviewed": True, "prompt": True}

# A password Session's token: a new one per session.prepare, like roster's (tests check it never
# shows up in Debug or errors, and that every open asks for a fresh one).
TOKEN = "tok-3b1f9e2a7c-"
minted = 0
FILL_PASSWORD = "fill-pw-9d2e"   # session.fill's (ticket 119): tests check it's never in Debug or errors
FINGERPRINT = "SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8"
trusted = mode != "unknown-key"
CHECKED = {"host": "esxi-02", "ok": True, "steps": [{"step": "inventory", "status": "ok", "message": "root@10.19.77.10"}]}
checks, polls, stops = [], [], []


def login_of(h):
    """session.prepare's `login` (API 25): what the Session connects to; none from an old serve."""
    return {} if mode == "old-login" else {"login": {"address": h["ip"], "port": 22, "user": "root"}}


def answer(req):
    global minted, trusted
    m = req["method"]
    if mode == "no-inventory":
        return {"error": {"code": 1, "message": "no roster.yml found here or in ~/.config/roster/",
                          "data": {"path": None, "roster_version": "0.1.0", "api_version": 1}}}
    if m == "inventory.info":
        return {"result": {"path": "/home/u/infra/roster.yml", "box": "box1", "host_count": len(HOSTS),
                           "providers": ["bw"], "roster_version": "0.1.0",
                           "api_version": 0 if mode == "old-api" else 21 if mode == "checks"
                           else 22 if mode == "stuck-check" else 26 if mode == "nested"
                           else 25 if mode == "fill-25" else 1,
                           "argv": sys.argv[2:], "checks": checks, "stops": stops}}
    if m == "host.check":
        p = req.get("params", {})
        if p.get("background") is True and mode in ("checks", "stuck-check"):
            checks.append(p["host"])
            joined = {"joined": sys.argv[2] == "joined"} if mode == "stuck-check" else {}
            return {"result": {"kind": "check", "job": f"check-{len(checks)}", "action": "check", "state": "running",
                               "done": 0, "total": 8, "at": None, "host": p["host"], **joined}}
        if "background" in p:
            return {"error": {"code": -32602, "message": "an older serve has no background check"}}
        return {"result": CHECKED}
    if m == "host.check_job":
        polls.append(req["params"]["job"])
        if len(polls) < 3 or mode == "stuck-check":
            return {"result": {"kind": "check", "job": req["params"]["job"], "state": "running", "done": len(polls),
                               "total": 8, "at": "dns", "host": "esxi-02"}}
        return {"result": {"kind": "check", "job": req["params"]["job"], "state": "done", "done": 8, "total": 8,
                           "at": None, "host": "esxi-02", "result": CHECKED}}
    if m == "jobs.stop":
        stops.append(req["params"])
        return {"result": {**req["params"], "stopping": True}}
    if m == "hosts.list":
        if mode == "die-on-hosts":
            sys.exit(5)
        return {"result": {"hosts": HOSTS, "groups": {"lab": {"title": "Lab", "description": ""}}}}
    if m == "host.get":
        for h in HOSTS:
            if h["name"] == req.get("params", {}).get("name"):
                return {"result": h}
        return {"error": {"code": 2, "message": f"unknown host {req['params'].get('name')!r}"}}
    if m == "host.scan_key":
        return {"result": {"host": "esxi-02", "address": "10.19.77.10", "port": 22, "key_type": "ssh-ed25519",
                           "fingerprint": FINGERPRINT, "recorded": "match" if trusted else "none"}}
    if m == "host.trust_key":
        if req["params"].get("fingerprint") != FINGERPRINT:
            return {"error": {"code": 23, "message": "esxi-02's host key changed while roster was asking - nothing was recorded"}}
        was, trusted = trusted, True
        return {"result": {"host": "esxi-02", "address": "10.19.77.10", "port": 22, "key_type": "ssh-ed25519",
                           "fingerprint": FINGERPRINT, "recorded": not was}}
    if m == "quick.prepare":
        p = req.get("params", {})
        label = f"{p.get('user')}@{p.get('address')}:{p.get('port')}"
        if p.get("fingerprint") != FINGERPRINT:
            return {"error": {"code": 23, "message": f"{label}'s host key changed while roster was asking - not connecting",
                              "data": {"asked": p.get("fingerprint"), "offered": FINGERPRINT}}}
        base = ["/usr/bin/ssh", "-o", "StrictHostKeyChecking=yes", "-o", "HostKeyAlias=roster-quick-q1"]
        common = {"host": label, "quick": "q1", "user": p.get("user"), "address": p.get("address"),
                  "port": p.get("port"), "key_type": "ssh-ed25519", "fingerprint": FINGERPRINT}
        tail = ["-p", str(p.get("port")), "-l", p.get("user"), "--", p.get("address")]
        if "password" not in p:
            return {"result": {"argv": [*base, "-o", "BatchMode=yes", *tail], "env": {}, "auth": "key", **common}}
        minted += 1
        held = {"held": "q1"} if p.get("save") is True else {}
        local = ["-o", "PermitLocalCommand=yes", "-o", "LocalCommand=/run/user/1000/roster-askpass-x1/logged-in"] if held else []
        return {"result": {"argv": [*base, "-o", "NumberOfPasswordPrompts=1", *local, *tail], "auth": "password", **common, **held,
                           "env": {"SSH_ASKPASS": "/run/user/1000/roster-askpass-x1/askpass",
                                   "SSH_ASKPASS_REQUIRE": "force",
                                   "ROSTER_ASKPASS_SOCKET": "/run/user/1000/roster-askpass-x1/sock",
                                   "ROSTER_ASKPASS_TOKEN": f"{TOKEN}{minted}"}}}
    if m == "session.prepare":
        name = req.get("params", {}).get("host")
        h = next((h for h in [*HOSTS, PROMPTED] if h["name"] == name), None)
        if h is None:
            return {"error": {"code": 2, "message": f"unknown host {name!r}"}}
        if not h["reviewed"]:
            return {"error": {"code": 20, "message": f"{name} is not reviewed yet (reviewed: false in roster.yml) - not logging in"}}
        if not trusted:
            return {"error": {"code": 44, "message": f"roster hasn't seen {name}'s host key before",
                              "data": {"address": h["ip"], "port": 22}}}
        p = req.get("params", {})
        if h.get("prompt"):
            if "password" not in p:
                return {"error": {"code": 39, "message": f"{name}'s Login is auth: prompt - type its password",
                                  "data": {"user": "root", "address": h["ip"], "port": 22}}}
            minted += 1
            held = {"held": "h1"} if p.get("save") is True else {}
            return {"result": {
                "argv": ["/usr/bin/ssh", "-o", "NumberOfPasswordPrompts=1", name],
                "env": {"SSH_ASKPASS": "/run/user/1000/roster-askpass-x1/askpass", "SSH_ASKPASS_REQUIRE": "force",
                        "ROSTER_ASKPASS_SOCKET": "/run/user/1000/roster-askpass-x1/sock",
                        "ROSTER_ASKPASS_TOKEN": f"{TOKEN}{minted}"},
                "host": name, "auth": "password", **held}}
        if h.get("password"):
            if mode == "locked":
                return {"error": {"code": 14, "message": "Bitwarden vault is locked - unlock it first"}}
            if mode == "missing-item":
                return {"error": {"code": 32, "message": f"no vault item named '{name} shh' (ssh Login of {name})",
                                  "data": {"near": [f"{name} ssh"], "fix": "fix the name in auth:"}}}
            if mode == "bad-prepare":
                return {"result": {"argv": ["/usr/bin/ssh", name], "host": name, "auth": "password",
                                   "env": {"SSH_ASKPASS_REQUIRE": "force", "ROSTER_ASKPASS_TOKEN": 987654321}}}
            minted += 1
            return {"result": {
                "argv": ["/usr/bin/ssh", "-o", "StrictHostKeyChecking=yes", "-o", "NumberOfPasswordPrompts=1",
                         "-o", "PreferredAuthentications=password,keyboard-interactive", name],
                "env": {"SSH_ASKPASS": "/run/user/1000/roster-askpass-x1/askpass", "SSH_ASKPASS_REQUIRE": "force",
                        "ROSTER_ASKPASS_SOCKET": "/run/user/1000/roster-askpass-x1/sock",
                        "ROSTER_ASKPASS_TOKEN": f"{TOKEN}{minted}"},
                "host": name, "auth": "password", **login_of(h)}}
        return {"result": {"argv": ["/usr/bin/ssh", "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes", name],
                           "env": {}, "host": name,
                           "auth": "key", **login_of(h)}}
    if m == "session.fill":
        # ticket 119: sw-core's Login answers a sudo prompt; anything else is 130, locked is 14
        p = req.get("params", {})
        if mode == "locked":
            return {"error": {"code": 14, "message": "Bitwarden vault is locked - unlock it first"}}
        if (p.get("address"), p.get("port"), p.get("user")) != ("10.19.1.2", 22, "root"):
            return {"error": {"code": 130, "message": "won't fill on sw-core: sw-core changed since this Session connected",
                              "data": {"prompt": None}}}
        if p.get("hop") is not None:
            # ticket 120: a nested ssh to esxi-02, as the app resolved it
            if p["hop"] != {"host": "esxi-02", "address": "10.19.1.3", "port": 22, "user": "root"} or \
                    not str(p.get("prompt", "")).startswith("root@esxi-02's"):
                return {"error": {"code": 130, "message": "won't fill on esxi-02: changed since this ssh started",
                                  "data": {"prompt": None}}}
            return {"result": {"host": "esxi-02", "login": "ssh", "password": FILL_PASSWORD}}
        if p.get("host") != "sw-core" or not str(p.get("prompt", "")).startswith("[sudo]"):
            return {"error": {"code": 130, "message": f"won't fill on {p.get('host')}: not a prompt roster fills",
                              "data": {"prompt": None}}}
        if mode == "bad-fill":
            return {"result": {"host": "sw-core", "login": "ssh", "password": 31337}}
        return {"result": {"host": "sw-core", "login": "ssh", "password": FILL_PASSWORD}}
    return {"error": {"code": -32601, "message": f"unknown method {m!r}"}}


held = []
for line in sys.stdin:
    req = json.loads(line)
    if mode == "reverse":
        held.append(req)
        if len(held) < 2:
            continue
        reqs, held = list(reversed(held)), []
    elif mode == "shuffle":
        held.append(req)
        if len(held) < 4:
            continue
        reqs, held = [held[2], held[0], held[3], held[1]], []
        for i, r in enumerate(reqs):
            print(json.dumps({"jsonrpc": "2.0", "method": "job.progress",
                              "params": {"kind": "mesh", "job": 1, "action": "apply", "state": "running", "done": i,
                                         "total": 4, "at": None}}), flush=True)
            print(json.dumps({"jsonrpc": "2.0", "id": r["id"], **answer(r)}), flush=True)
        continue
    else:
        reqs = [req]
    for r in reqs:
        if r["method"] == "$/cancel":
            if mode == "hang":
                print(json.dumps({"jsonrpc": "2.0", "method": "test.cancelled",
                                  "params": {"params": r.get("params"), "had_id": "id" in r}}), flush=True)
            continue
        if mode == "hang" and r["method"] == "host.get":
            continue
        if mode == "notify" and r["method"] == "inventory.watch":
            print(json.dumps({"jsonrpc": "2.0", "method": "inventory.changed", "params": {"applied": True}}), flush=True)
            print(json.dumps({"jsonrpc": "2.0", "id": r["id"], "result": {"watching": True}}), flush=True)
            continue
        print(json.dumps({"jsonrpc": "2.0", "id": r["id"], **answer(r)}), flush=True)

if mode == "slow-exit":
    import time
    time.sleep(1.5)
    with open(sys.argv[2], "w") as f:
        f.write("exited on its own\n")
