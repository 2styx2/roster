#!/usr/bin/env python3
# A stand-in Windows Host's file permissions (tests/fakes/ssh, FAKE_HOSTS with a `windows` marker): the Host's
# icacls.exe and Get-Acl are PowerShell functions that call this, so the same fake runs under pwsh on Linux and
# powershell.exe on Windows. State: DIR/NAME/acls.json, {"DEV:INODE": {protected, owner, allow: [{sid, rights,
# inherited, type}]}}, keyed by the file itself, so an ACL follows the file through a rename, as NTFS's does
# (File.Move, and File.Replace, whose new file takes its place). A file with no entry has what it would inherit
# (under programdata: SYSTEM, Administrators, and Authenticated Users read; elsewhere: the user, SYSTEM,
# Administrators). Every icacls run is logged to DIR/NAME/icacls.log ("PATH ARGS"); with DIR/NAME/icacls-noop, icacls
# says it worked and changes nothing.
#   acl.py get PATH              the file's ACL as JSON
#   acl.py icacls PATH ARGS...   /setowner *SID, /inheritance:r, /grant:r *SID:F, /remove:g *SID
import json
import os
import sys

ME = "S-1-5-21-1000-1000-1000-1001"
root = os.environ["FAKE_HOST_ROOT_NATIVE"]
state_file = os.path.join(root, "acls.json")
state = json.load(open(state_file)) if os.path.exists(state_file) else {}


def key(p):
    st = os.stat(p)
    return f"{st.st_dev}:{st.st_ino}"


def inherited(p):
    norm = os.path.normcase(os.path.abspath(p))
    if norm.startswith(os.path.normcase(os.path.abspath(os.path.join(root, "programdata")))):
        sids = [("S-1-5-18", "FullControl"), ("S-1-5-32-544", "FullControl"), ("S-1-5-11", "ReadAndExecute")]
        owner = "S-1-5-32-544"
    else:
        sids = [(ME, "FullControl"), ("S-1-5-18", "FullControl"), ("S-1-5-32-544", "FullControl")]
        owner = ME
    return {"protected": False, "owner": owner,
            "allow": [{"sid": s, "rights": r, "inherited": True, "type": "Allow"} for s, r in sids]}


cmd, path, *rest = sys.argv[1:]
if not os.path.exists(path):
    print(f"{path}: The system cannot find the file specified.", file=sys.stderr)
    sys.exit(2)
acl = state.get(key(path)) or inherited(path)
if cmd == "get":
    print(json.dumps(acl))
    sys.exit(0)
open(os.path.join(root, "icacls.log"), "a").write(" ".join([path, *rest]) + "\n")
if os.path.exists(os.path.join(root, "icacls-noop")):
    print("processed file: " + path)
    sys.exit(0)
i = 0
while i < len(rest):
    a = rest[i]
    if a == "/inheritance:r":
        acl["protected"] = True
        acl["allow"] = [e for e in acl["allow"] if not e.get("inherited")]
    elif a == "/setowner":
        acl["owner"] = rest[i + 1].lstrip("*")
        i += 1
    elif a in ("/grant:r", "/remove:g"):
        sid, _, perm = rest[i + 1].lstrip("*").partition(":")
        acl["allow"] = [e for e in acl["allow"] if e["sid"] != sid or e.get("type", "Allow") != "Allow"]
        if a == "/grant:r":
            acl["allow"].append({"sid": sid, "rights": {"F": "FullControl"}.get(perm, perm), "inherited": False,
                                 "type": "Allow"})
        i += 1
    else:
        print(f"Invalid parameter \"{a}\"", file=sys.stderr)
        sys.exit(87)
    i += 1
state[key(path)] = acl
json.dump(state, open(state_file, "w"))
print("processed file: " + path)
