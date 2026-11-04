"""Windows Hosts (T195, #375, decision Q174): adding, removing and checking this Box's key on an `os: windows` Host.

roster can't know which shell a Windows Host's sshd runs a command with (cmd.exe by default, PowerShell where the
DefaultShell is set), and the two parse a command line differently. So every command here is the same fixed one,
`powershell -NoProfile -NonInteractive -EncodedCommand <BOOTSTRAP>`, whose argument is base64 (no character either
shell, or a Box's ssh.cmd, acts on): the bootstrap reads the real script from stdin (framed: its length, then its
bytes, never waiting for EOF) and runs it. Values the script needs
(this Box's public key line, its tag) go in that script, never in argv, and a secret never goes in at all: a password
Host's password is only paramiko's login (sshops.password_exec).

The script picks the file sshd reads this account's keys from: an account in Administrators (SID S-1-5-32-544 in
`whoami /groups`, deny-only too) uses the file sshd_config's `Match Group administrators` names (the stock one is
%ProgramData%\\ssh\\administrators_authorized_keys), everyone else %USERPROFILE%\\.ssh\\authorized_keys. It follows only
what it understands of sshd_config: anything else is refused, never guessed. It changes only the lines that end in this
Box's tag, keeps every other byte as it was, writes ASCII with no BOM to a temp file beside the key file and moves it
into place (a cut-short run leaves the old file whole), and refuses a UTF-16 or BOM file rather than re-encode it
(that would turn on every key in it, which sshd ignores today). ACLs only ever narrow: the admin file always gets
Microsoft's (SYSTEM and Administrators, full control, inheritance removed, set by SID) and is checked after; a user file
gets an ACL only when roster creates it (this account, SYSTEM, Administrators); an existing one is never changed, only
reported when others can use it (sshd ignores such a file).

What the script prints, one per line: `FILE <path>` (a file it wrote, or read for check), `WARN <text>`, then
`ROSTER_OK`; or `REFUSED <text>` (the key file, code 157), `ERROR <text>`, or `NOT_WINDOWS` (code 156)."""

import base64
import re
import subprocess

from .common import program_argv
from .errors import KEY_FILE, LOOKS_LIKE_WINDOWS, NOT_WINDOWS

# Reads the whole script from stdin, then runs it: a script given line by line (`-Command -`) runs as if typed, and
# its multi-line blocks would need blank lines to end them.
# Win32-OpenSSH (8.1 and 9.5, measured on real Hosts) never delivers EOF on a child's stdin once more than 4096 bytes
# have passed, so nothing here waits for EOF: the script goes as "<its length in bytes>\n<the bytes>" (framed), and the
# bootstrap reads that line, then exactly that many bytes, decodes them as UTF-8 whatever the Host's code page (the
# script is ASCII anyway: ps_literal), and runs them. A length line that isn't digits, is over 1 MB, or bytes that come
# short run nothing (ERROR). $ProgressPreference keeps PowerShell's progress records ("#< CLIXML") off stderr.
MAX_SCRIPT = 1 << 20
BOOTSTRAP = (
    "$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop'; "
    "function F { [Console]::Out.WriteLine('ERROR the script came malformed or short on stdin'); exit 3 }; "
    "$in=[Console]::OpenStandardInput(); $h=''; "
    "while (($c=$in.ReadByte()) -ne 10) { if ($c -lt 48 -or $c -gt 57 -or $h.Length -ge 7) { F }; $h+=[char]$c }; "
    f"$n=[int]('0'+$h); if ($n -lt 1 -or $n -gt {MAX_SCRIPT}) {{ F }}; "
    "$b=New-Object byte[] $n; $o=0; "
    "while ($o -lt $n) { $r=$in.Read($b,$o,$n-$o); if ($r -le 0) { F }; $o+=$r }; "
    "& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($b)))")


def framed(script):
    """SCRIPT as it goes on stdin: its length in bytes on a line, then the script (ASCII, so length in chars too)."""
    data = script.encode()
    if len(data) > MAX_SCRIPT:
        raise ValueError("a Windows Host's script is over 1 MB")
    return f"{len(data)}\n{script}"


def remote_command():
    """The command an `os: windows` Host is sent: the same every time, and holding nothing but the bootstrap."""
    encoded = base64.b64encode(BOOTSTRAP.encode("utf-16-le")).decode("ascii")
    return f"powershell -NoProfile -NonInteractive -EncodedCommand {encoded}"


def ps_literal(value):
    """VALUE as a PowerShell single-quoted string: nothing in it is expanded, and a ' is written ''. Printable ASCII
    only (ValueError otherwise): PowerShell also ends a literal at a Unicode quote, and a byte the Host's code page
    reads as one (0x91, 0x92 in CP 1252) must never get there."""
    value = str(value)
    if not all(" " <= c <= "~" for c in value):
        raise ValueError("a value for a Windows Host's script must be printable ASCII")
    return "'" + value.replace("'", "''") + "'"


def clean(text):
    """TEXT from a Host, safe to print: a control character (a terminal escape) becomes ?."""
    return re.sub(r"[\x00-\x1f\x7f-\x9f]", "?", text)


SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$Admins = 'S-1-5-32-544'; $System = 'S-1-5-18'
$Latin1 = [Text.Encoding]::GetEncoding(28591)       # one char per byte: what roster doesn't change stays byte for byte
function Say($s) { [Console]::Out.WriteLine($s) }
function Refuse($s) { throw ('REFUSED ' + $s) }

function Icacls {
    # its output and exit code, with no PowerShell error for what it writes on stderr
    $ErrorActionPreference = 'Continue'
    $out = & icacls.exe @args 2>&1 | ForEach-Object { "$_" }
    if ($LASTEXITCODE -ne 0) { Refuse ("icacls " + ($args -join ' ') + " failed: " + ($out -join ' ')) }
}

function Get-KeyFileAcl($p) {
    # P's owner, whether it inherits, and its allow and deny entries, by SID
    $acl = Get-Acl -LiteralPath $p
    $sid = [Security.Principal.SecurityIdentifier]
    $rules = @($acl.GetAccessRules($true, $true, $sid) | ForEach-Object {
        [pscustomobject]@{ Sid = $_.IdentityReference.Value; Rights = "$($_.FileSystemRights)";
                           Type = "$($_.AccessControlType)" } })
    [pscustomobject]@{ Owner = $acl.GetOwner($sid).Value; Protected = [bool]$acl.AreAccessRulesProtected;
                       Allowed = @($rules | Where-Object { $_.Type -eq 'Allow' });
                       Denied = @($rules | Where-Object { $_.Type -eq 'Deny' }) }
}

function Can-Write($rights) {
    # do these rights (FileSystemRights' names, or a number for generic rights) let their holder change the file (its
    # data, attributes, permissions, owner) or delete it?
    if ("$rights" -match '^-?\d+$') {
        $mask = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x2000000 -bor 0x10000000 -bor 0x40000000
        return [bool]([int64]"$rights" -band $mask)
    }
    return [bool]("$rights" -match 'FullControl|Modify|Write|CreateFiles|AppendData|CreateDirectories|ChangePermissions|TakeOwnership|Delete')
}

function Writers($a, $ok) {
    # the SIDs, other than OK's, that may write P (or change its permissions)
    @($a.Allowed | Where-Object { $_.Sid -notin $ok -and (Can-Write $_.Rights) } | ForEach-Object { $_.Sid } |
      Sort-Object -Unique)
}

function Assert-Folder($dir, $me, $owners) {
    # others who can write in the key file's folder, or own it (an owner can change its permissions at will), could
    # swap or seed the file roster writes there
    $a = Get-KeyFileAcl $dir
    $w = Writers $a @($me, $Admins, $System)
    if ($w.Count) {
        Refuse "$dir lets $($w -join ', ') write in it, so others could put keys in the file roster writes there. Take their write access off that folder first"
    }
    if ($a.Owner -notin $owners) {
        Refuse "$dir is owned by $($a.Owner), who could let others write in it, so others could put keys in the file roster writes there. Make $($owners -join ' or ') its owner first"
    }
}

function Assert-AdminFileTrusted($p, $me) {
    # sshd ignores an admin file others can write, or someone else owns; making it trusted now would turn on whatever
    # they put in it, for every administrator. So it's refused, untouched
    $a = Get-KeyFileAcl $p
    $w = Writers $a @($me, $Admins, $System)
    if ($w.Count) {
        Refuse "$p lets $($w -join ', ') write it, so others could have put keys in it (sshd ignores it as it is). Check every line in it, set its permissions to SYSTEM and Administrators only, then run setup again"
    }
    if ($a.Owner -notin $Admins, $System) {
        Refuse "$p is owned by $($a.Owner), not SYSTEM or Administrators, so others could have put keys in it. Check every line in it, make Administrators its owner, then run setup again"
    }
}

function Admin-AclProblem($p) {
    # what's wrong with the admin file's ACL against Microsoft's, or $null
    $a = Get-KeyFileAcl $p
    $others = @($a.Allowed | ForEach-Object { $_.Sid } | Where-Object { $_ -notin $Admins, $System } | Sort-Object -Unique)
    if ($others.Count) { return "it lets in $($others -join ', ') besides SYSTEM and Administrators" }
    foreach ($s in $Admins, $System) {
        if (-not ($a.Allowed | Where-Object { $_.Sid -eq $s -and $_.Rights -match 'FullControl' })) {
            return "$s hasn't full control of it"
        }
    }
    $denied = @($a.Denied | ForEach-Object { $_.Sid } | Where-Object { $_ -in $Admins, $System } | Sort-Object -Unique)
    if ($denied.Count) { return "it denies $($denied -join ', ') some access (sshd reads it as SYSTEM)" }
    if (-not $a.Protected) { return "it still inherits its folder's permissions" }
    if ($a.Owner -notin $Admins, $System) { return "it's owned by $($a.Owner)" }
    return $null
}

function Set-AdminAcl($p) {
    # Microsoft's ACL for administrators_authorized_keys, by SID (localized Windows names the groups differently), and
    # Administrators as its owner: it only ever narrows who can use the file
    Icacls $p '/setowner' "*$($Admins)"
    Icacls $p '/inheritance:r' '/grant:r' "*$($Admins):F" '/grant:r' "*$($System):F"
    $a = Get-KeyFileAcl $p
    foreach ($s in @($a.Allowed | ForEach-Object { $_.Sid } | Where-Object { $_ -notin $Admins, $System } |
                     Sort-Object -Unique)) {
        Icacls $p '/remove:g' "*$s"
    }
    $why = Admin-AclProblem $p
    if ($why) { Refuse "$p's permissions aren't Microsoft's after icacls: $why" }
}

function Set-UserAcl($p, $me) {
    # a user file roster makes: this account, SYSTEM and Administrators, nothing inherited; read back by SID
    Icacls $p '/inheritance:r' '/grant:r' "*$($me):F" '/grant:r' "*$($System):F" '/grant:r' "*$($Admins):F"
    $a = Get-KeyFileAcl $p
    $others = @($a.Allowed | ForEach-Object { $_.Sid } | Where-Object { $_ -notin $me, $Admins, $System })
    $mine = $a.Allowed | Where-Object { $_.Sid -eq $me -and $_.Rights -match 'FullControl' }
    $denied = @($a.Denied | Where-Object { $_.Sid -in $me, $System })
    if ($others.Count -or -not $mine -or $denied.Count -or -not $a.Protected) {
        Refuse "$p's permissions aren't what roster set (this account, SYSTEM and Administrators) after icacls"
    }
}

function User-AclWarnings($p, $me) {
    # an existing user file is never changed: what would make sshd ignore it is only said
    $a = Get-KeyFileAcl $p
    $ok = @($me, $Admins, $System)
    $w = Writers $a $ok
    if ($w.Count) {
        Say "WARN $p lets $($w -join ', ') write it, besides this account, SYSTEM and Administrators: sshd ignores a key file others can change. roster doesn't change permissions it didn't set: take their write access off it"
    }
    if ($a.Owner -and $a.Owner -notin $ok) {
        Say "WARN $p is owned by $($a.Owner), not this account: sshd ignores it. Make this account its owner"
    }
    $denied = @($a.Denied | ForEach-Object { $_.Sid } | Where-Object { $_ -in $me, $System } | Sort-Object -Unique)
    if ($denied.Count) { Say "WARN $p denies $($denied -join ', ') some access: sshd (SYSTEM) may not read it" }
}

function Read-Keys($p) {
    # the file's text (one char per byte), or $null when it isn't there; a file sshd can't read is refused
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { return $null }
    $b = [IO.File]::ReadAllBytes($p)
    if ($b.Length -ge 2 -and (($b[0] -eq 0xFF -and $b[1] -eq 0xFE) -or ($b[0] -eq 0xFE -and $b[1] -eq 0xFF))) {
        Refuse "$p is UTF-16: sshd can't read it, and roster won't re-encode it (that would turn on every key in it). Save it as ASCII (or UTF-8 with no BOM) first"
    }
    if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) {
        Refuse "$p starts with a byte order mark: sshd can't read its first line, and roster won't re-encode it. Save it as ASCII (or UTF-8 with no BOM) first"
    }
    if ([Array]::IndexOf($b, [byte]0) -ge 0) {
        Refuse "$p holds NUL bytes (UTF-16 with no BOM?): sshd can't read it, and roster won't re-encode it"
    }
    return $Latin1.GetString($b)
}

function Is-Mine($line) { return $line.TrimEnd() -cmatch $TagRe }

function New-Text($text, $add) {
    # TEXT without this Box's lines, plus ADD: every other line kept as it was, line ends and all
    $nl = if ($text -match "`r`n") { "`r`n" } elseif ($text) { "`n" } else { "`r`n" }
    $out = -join @(foreach ($l in @($text -split '(?<=\n)')) {
        if ($l -eq '') { continue }
        if (Is-Mine $l) { continue }
        $l
    })
    if ($out -and -not $out.EndsWith("`n")) { $out += $nl }
    if ($add) { $out += $add + $nl }
    return $out
}

function Write-Keys($p, $text, $secure) {
    # A temp file beside P, with a name no one can guess, made with CreateNew (one that's there already is never
    # opened); SECURE (a script block) gives it its final permissions, and checks them, while it's still empty; then
    # the keys go in, and it replaces P (File.Replace keeps P's permissions) or is moved into place. A run cut short
    # leaves the old file whole.
    $tmp = "$p.roster-" + [guid]::NewGuid().ToString('N')
    $fs = [IO.File]::Open($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $fs.Dispose()
    try {
        if ($secure) { & $secure $tmp }
        $bytes = $Latin1.GetBytes($text)
        $fs = [IO.File]::Open($tmp, [IO.FileMode]::Truncate, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $fs.Write($bytes, 0, $bytes.Length) } finally { $fs.Dispose() }
        if (Test-Path -LiteralPath $p) { [IO.File]::Replace($tmp, $p, [NullString]::Value) }
        else { [IO.File]::Move($tmp, $p) }
    } catch {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        throw
    }
}

function Admin-KeyFile {
    # the file sshd_config's `Match Group administrators` gives Administrators, or $null when it gives none. Whatever
    # else would change where sshd looks is refused: roster never guesses which file sshd reads
    $cfg = Join-Path (Join-Path $env:ProgramData 'ssh') 'sshd_config'
    if (-not (Test-Path -LiteralPath $cfg -PathType Leaf)) {
        Refuse "$cfg isn't there, so roster can't tell which file sshd reads keys from"
    }
    $match = $null; $file = $null
    foreach ($raw in [IO.File]::ReadAllLines($cfg)) {
        $line = ($raw -replace '#.*$', '').Trim()
        if (-not ($line -match '^(\S+?)(?:\s*=\s*|\s+)(.*)$')) { continue }
        $kw = $Matches[1].ToLowerInvariant(); $val = $Matches[2].Trim()
        if ($kw -eq 'include') {
            Refuse "sshd_config has Include $($val): roster doesn't follow included files, so it can't tell which key file sshd reads"
        }
        if ($kw -eq 'match') { $match = $val; continue }
        if ($kw -ne 'authorizedkeysfile') { continue }
        $val = $val.Trim('"')
        if ($null -eq $match) {
            if ($val -notin '.ssh/authorized_keys', '.ssh\authorized_keys') {
                Refuse "sshd_config sets AuthorizedKeysFile $val for every account: roster follows only the stock .ssh/authorized_keys"
            }
        } elseif ($match -match '^group\s+administrators$') {
            if ($file -or $val -match '\s|%') {
                Refuse "sshd_config's Match Group administrators names more than one key file, or one with %-tokens: roster follows only one plain path"
            }
            $file = $val.Replace('__PROGRAMDATA__', $env:ProgramData)
            if (-not [IO.Path]::IsPathRooted($file)) {
                Refuse "sshd_config's Match Group administrators names a relative key file ($val): roster follows only a full path"
            }
        } else {
            Refuse "sshd_config sets AuthorizedKeysFile under 'Match $match': roster follows only Match Group administrators"
        }
    }
    return $file
}

function Main {
    if ($env:OS -ne 'Windows_NT') { Say 'NOT_WINDOWS'; return }
    # Administrators by SID, in any state (deny-only too: a filtered token is still an admin's to sshd)
    $groups = @(& whoami.exe /groups /fo csv /nh)
    if ($LASTEXITCODE -ne 0) { throw "whoami /groups failed" }
    $isAdmin = [bool](@($groups | ConvertFrom-Csv -Header Name, Type, SID, Attributes |
                        Where-Object { $_.SID -eq $Admins }).Count)
    $user = @(& whoami.exe /user /fo csv /nh)
    if ($LASTEXITCODE -ne 0) { throw "whoami /user failed" }
    $me = ($user | ConvertFrom-Csv -Header Name, SID | Select-Object -First 1).SID
    if (-not $me) { throw "whoami /user didn't name this account's SID" }
    $adminFile = Admin-KeyFile
    $sshDir = Join-Path $env:USERPROFILE '.ssh'
    $userFile = Join-Path $sshDir 'authorized_keys'
    $mine = if ($isAdmin -and $adminFile) { $adminFile } else { $userFile }
    $adminSecure = { param($f) Set-AdminAcl $f }
    $userSecure = { param($f) Set-UserAcl $f $me }

    if ($Mode -eq 'add') {
        if ($mine -eq $adminFile) {
            Assert-Folder (Split-Path -Parent $adminFile) $me @($Admins, $System)
            if (Test-Path -LiteralPath $adminFile) { Assert-AdminFileTrusted $adminFile $me }
        } else {
            if (-not (Test-Path -LiteralPath $sshDir)) { New-Item -ItemType Directory -Path $sshDir | Out-Null }
            Assert-Folder $sshDir $me @($me, $Admins, $System)
        }
        $old = Read-Keys $mine
        $new = New-Text $old $Pub
        $created = $null -eq $old
        $secure = if ($mine -eq $adminFile) { $adminSecure } elseif ($created) { $userSecure } else { $null }
        # an existing user file's ACL, as it is (File.Replace keeps it): never changed, only said
        if ($mine -ne $adminFile -and -not $created) { User-AclWarnings $mine $me }
        if ($created -or $new -cne $old) { Write-Keys $mine $new $secure }
        if ($mine -eq $adminFile) { Set-AdminAcl $mine; Say 'SCOPE admins' }
        Say "FILE $mine"
    } elseif ($Mode -eq 'remove') {
        # both files sshd could have read this account's keys from (it may have joined or left Administrators since)
        $files = @($userFile) + @(if ($isAdmin -and $adminFile) { $adminFile })
        foreach ($f in $files) {
            $old = Read-Keys $f
            if ($null -eq $old) { continue }
            $new = New-Text $old $null
            if ($new -ceq $old) { continue }
            if ($f -eq $adminFile) {
                Assert-Folder (Split-Path -Parent $f) $me @($Admins, $System)
                Assert-AdminFileTrusted $f $me
                Write-Keys $f $new $adminSecure
                Set-AdminAcl $f
            } else {
                Assert-Folder (Split-Path -Parent $f) $me @($me, $Admins, $System)
                Write-Keys $f $new $null
            }
            Say "FILE $f"
        }
        if ($adminFile -and -not $isAdmin) {
            Say "WARN this account isn't in Administrators now, so roster can't look in $adminFile. If it was an administrator when this Box's key was added, the key may still be there, and it logs in as every administrator: have an administrator remove the line ending in this Box's tag, or run roster revoke as one"
        }
    } else {
        Say "FILE $mine"
        if ($mine -eq $adminFile) { Say 'SCOPE admins' }
        $text = Read-Keys $mine
        if ($null -eq $text) { Say "WARN $mine isn't there: sshd has no key for this account" }
        elseif (-not (@($text -split '\n' | Where-Object { Is-Mine $_ }).Count)) {
            Say "WARN $mine doesn't hold this Box's key"
        }
        if ($null -ne $text) {
            if ($mine -eq $adminFile) {
                $why = Admin-AclProblem $mine
                if ($why) { Say "WARN $mine's permissions aren't Microsoft's ($why). roster setup sets them, unless others could write it" }
            } else { User-AclWarnings $mine $me }
        }
    }
    Say 'ROSTER_OK'
}

try { Main } catch {
    $m = "$($_.Exception.Message)" -replace '\s+', ' '
    if ($m.StartsWith('REFUSED ')) { Say $m } else { Say "ERROR $m" }
}
"""

MODES = ("add", "remove", "check")


def script(mode, tag_re, pub=""):
    """The PowerShell script for MODE (add PUB, remove, or check this Box's key, matched by TAG_RE): sent on stdin."""
    if mode not in MODES:
        raise ValueError(mode)
    header = f"$Mode = {ps_literal(mode)}\n$Pub = {ps_literal(pub)}\n$TagRe = {ps_literal(tag_re)}\n"
    return header + SCRIPT


def looks_windows(text):
    """Is TEXT what a Windows Host says to a POSIX command (cmd.exe's or PowerShell's 'sh' is not recognized)?"""
    low = text.lower()
    return ("'sh' is not recognized" in low or "the term 'sh' is not recognized" in low
            or "sh : the term 'sh'" in low)


def windows_hint(name):
    """The error for a POSIX script a Windows Host couldn't run (code 155)."""
    return (f"[{LOOKS_LIKE_WINDOWS}] {name} looks like a Windows Host (its shell says 'sh' is not recognized): set "
            f"os: windows for it (or its group) in roster.yml, run `roster sync`, then try again")


class Result:
    """What the script said: the files it wrote or read, its warnings, and whether the file is the administrators'
    (a key there logs in as every administrator on the Host: Microsoft's design)."""

    def __init__(self, files, warnings, admins=False):
        self.files, self.warnings, self.admins = files, warnings, admins


def admins_note(name):
    return (f"a key in this file logs in as every administrator on {name}, not only this Login's user (Windows' "
            "administrators share one key file)")


def outcome(name, rc, out, err):
    """The script's answer from Host NAME as a Result; RuntimeError (with its code, when it has one) otherwise.
    Everything the Host said is cleaned of control characters first."""
    lines = [clean(ln.rstrip("\r")) for ln in out.splitlines()]
    out, err = "\n".join(lines), " ".join(clean(ln) for ln in err.splitlines())
    files = [ln[5:] for ln in lines if ln.startswith("FILE ")]
    warnings = [ln[5:] for ln in lines if ln.startswith("WARN ")]
    for ln in lines:
        if ln.startswith("REFUSED "):
            raise RuntimeError(f"[{KEY_FILE}] {ln[8:]} - nothing was changed there")
        if ln.startswith("ERROR "):
            raise RuntimeError(ln[6:][:300])
        if ln == "NOT_WINDOWS":
            raise RuntimeError(not_windows(name))
    if "ROSTER_OK" in lines:
        return Result(files, warnings, "SCOPE admins" in lines)
    said = (err or out).strip()
    low = said.lower()
    if "powershell" in low and ("not found" in low or "no such file" in low):
        raise RuntimeError(not_windows(name))
    raise RuntimeError(f"no answer from the script on {name} (exit {rc}): " + (said[:200] or "nothing printed"))


def not_windows(name):
    return (f"[{NOT_WINDOWS}] {name} has os: windows, but it has no PowerShell or isn't Windows: nothing was "
            "changed. Fix os: for it in roster.yml")


def over_key(h, mode, tag_re, timeout=60):
    """Run MODE's script on key Host H with this Box's key (`ssh NAME`, never a shared connection): a Result, or
    RuntimeError."""
    try:
        r = subprocess.run(program_argv(["ssh", "-o", "BatchMode=yes", "-o", "ControlPath=none", h["name"],
                                         remote_command()]),
                           input=framed(script(mode, tag_re)).encode(), capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"{h['name']} didn't finish within {timeout} s") from None
    out, err = r.stdout.decode(errors="replace"), r.stderr.decode(errors="replace")
    if r.returncode == 255 and "ROSTER_OK" not in out:          # ssh's own failure: no login, no script
        raise RuntimeError(f"ssh {h['name']} failed: " + (err.strip()[:200] or "no message"))
    return outcome(h["name"], r.returncode, out, err)


def install(h, pub, tag_re, password):
    """Add this Box's key line PUB on Windows Host H, logging in with PASSWORD (paramiko; None: an agent's key)."""
    from .sshops import password_exec
    rc, out, err = password_exec(h, remote_command(), password, timeout=15, stdin=framed(script("add", tag_re, pub)))
    return outcome(h["name"], rc, out, err)
