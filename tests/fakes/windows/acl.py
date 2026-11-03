#!/usr/bin/env python3
# A stand-in Windows Host's file permissions (tests/fakes/ssh, FAKE_HOSTS with a `windows` marker): the Host's
# icacls.exe and Get-Acl are PowerShell functions that call this, so the same fake runs under pwsh on Linux and
# powershell.exe on Windows. State: DIR/NAME/acls.json, {full path: {protected, owner, allow: [{sid, rights,
# inherited}]}}; a file it has no entry for has what it would inherit (programdata: SYSTEM, Administrators, and
# Authenticated Users read; the profile: the user, SYSTEM, Administrators). Every icacls run is logged to
# DIR/NAME/icacls.log, one line of its arguments each.
#   acl.py get PATH              the file's ACL as JSON
#   acl.py icacls PATH ARGS...   /inheritance:r, /grant:r *SID:F, /remove:g *SID
import json
import os
import sys

ME = "S-1-5-21-1000-1000-1000-1001"
root = os.environ["FAKE_HOST_ROOT_NATIVE"]
state_file = os.path.join(root, "acls.json")
state = json.load(open(state_file)) if os.path.exists(state_file) else {}


def key(p):
    return os.path.normcase(os.path.abspath(p))


def inherited(p):
    if key(p).startswith(key(os.path.join(root, "programdata"))):
        sids = [("S-1-5-18", "FullControl"), ("S-1-5-32-544", "FullControl"), ("S-1-5-11", "ReadAndExecute")]
        owner = "S-1-5-32-544"
    else:
        sids = [(ME, "FullControl"), ("S-1-5-18", "FullControl"), ("S-1-5-32-544", "FullControl")]
        owner = ME
    return {"protected": False, "owner": owner,
            "allow": [{"sid": s, "rights": r, "inherited": True} for s, r in sids]}


cmd, path, *rest = sys.argv[1:]
acl = state.get(key(path)) or inherited(path)
if cmd == "get":
    print(json.dumps(acl))
    sys.exit(0)
open(os.path.join(root, "icacls.log"), "a").write(" ".join(rest) + "\n")
if not os.path.exists(path):
    print(f"{path}: The system cannot find the file specified.", file=sys.stderr)
    sys.exit(2)
i = 0
while i < len(rest):
    a = rest[i]
    if a == "/inheritance:r":
        acl["protected"] = True
        acl["allow"] = [e for e in acl["allow"] if not e["inherited"]]
    elif a in ("/grant:r", "/remove:g"):
        sid, _, perm = rest[i + 1].lstrip("*").partition(":")
        acl["allow"] = [e for e in acl["allow"] if e["sid"] != sid]
        if a == "/grant:r":
            acl["allow"].append({"sid": sid, "rights": {"F": "FullControl"}.get(perm, perm), "inherited": False})
        i += 1
    else:
        print(f"Invalid parameter \"{a}\"", file=sys.stderr)
        sys.exit(87)
    i += 1
state[key(path)] = acl
json.dump(state, open(state_file, "w"))
print("processed file: " + path)
