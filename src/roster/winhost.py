"""Windows Hosts (T195, #375, decision Q174): adding, removing and checking this Box's key on an `os: windows` Host.

roster can't know which shell a Windows Host's sshd runs a command with (cmd.exe by default, PowerShell where the
DefaultShell is set), and the two parse a command line differently. So every command here is the same fixed one,
`powershell -NoProfile -NonInteractive -EncodedCommand <BOOTSTRAP>`, whose argument is base64 (no character either
shell, or a Box's ssh.cmd, acts on): the bootstrap reads the real script from stdin and runs it. Values the script needs
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
import subprocess

from .common import program_argv
from .errors import KEY_FILE, LOOKS_LIKE_WINDOWS, NOT_WINDOWS

# Reads the whole script from stdin, then runs it: a script given line by line (`-Command -`) runs as if typed, and
# its multi-line blocks would need blank lines to end them.
BOOTSTRAP = "$ErrorActionPreference='Stop'; $s=[Console]::In.ReadToEnd(); & ([scriptblock]::Create($s))"


def remote_command():
    """The command an `os: windows` Host is sent: the same every time, and holding nothing but the bootstrap."""
    encoded = base64.b64encode(BOOTSTRAP.encode("utf-16-le")).decode("ascii")
    return f"powershell -NoProfile -NonInteractive -EncodedCommand {encoded}"


def ps_literal(value):
    """VALUE as a PowerShell single-quoted string: nothing in it is expanded, and a ' is written ''."""
    value = str(value)
    if any(c in value for c in "\r\n\x00"):
        raise ValueError("a value for a Windows Host's script can't hold a line break")
    for q in "‘’‚‛":          # PowerShell reads these as quotes too
        value = value.replace(q, "'")
    return "'" + value.replace("'", "''") + "'"


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
    $acl = Get-Acl -LiteralPath $p
    $sid = [Security.Principal.SecurityIdentifier]
    $allowed = @($acl.GetAccessRules($true, $true, $sid) | Where-Object { "$($_.AccessControlType)" -eq 'Allow' } |
        ForEach-Object { [pscustomobject]@{ Sid = $_.IdentityReference.Value; Rights = "$($_.FileSystemRights)" } })
    [pscustomobject]@{ Owner = $acl.GetOwner($sid).Value; Protected = [bool]$acl.AreAccessRulesProtected;
                       Allowed = $allowed }
}

function Admin-AclProblem($p) {
    # what's wrong with the admin file's ACL against Microsoft's, or $null
    $a = Get-KeyFileAcl $p
    $others = @($a.Allowed | ForEach-Object { $_.Sid } | Where-Object { $_ -notin $Admins, $System } | Sort-Object -Unique)
    if ($others.Count) { return "it lets in $($others -join ', ') besides SYSTEM and Administrators" }
    foreach ($s in $Admins, $System) {
        if (-not ($a.Allowed | Where-Object { $_.Sid -eq $s -and $_.Rights -eq 'FullControl' })) {
            return "$s hasn't full control of it"
        }
    }
    if (-not $a.Protected) { return "it still inherits its folder's permissions" }
    return $null
}

function Set-AdminAcl($p) {
    # Microsoft's ACL for administrators_authorized_keys, by SID (localized Windows names the groups differently): it
    # only ever narrows who can use the file
    Icacls $p '/inheritance:r' '/grant:r' "*$($Admins):F" '/grant:r' "*$($System):F"
    $a = Get-KeyFileAcl $p
    foreach ($s in @($a.Allowed | ForEach-Object { $_.Sid } | Where-Object { $_ -notin $Admins, $System } |
                     Sort-Object -Unique)) {
        Icacls $p '/remove:g' "*$s"
    }
    $why = Admin-AclProblem $p
    if ($why) { Refuse "$p's permissions aren't Microsoft's after icacls: $why" }
}

function User-AclWarnings($p, $me) {
    $a = Get-KeyFileAcl $p
    $ok = @($me, $Admins, $System)
    $others = @($a.Allowed | ForEach-Object { $_.Sid } | Where-Object { $_ -notin $ok } | Sort-Object -Unique)
    if ($others.Count) {
        Say "WARN $p lets in $($others -join ', ') besides this account, SYSTEM and Administrators: sshd ignores a key file others can use. roster doesn't change permissions it didn't set: remove those entries"
    }
    if ($a.Owner -and $a.Owner -notin $ok) {
        Say "WARN $p is owned by $($a.Owner), not this account: sshd ignores it. Make this account its owner"
    }
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

function New-Text($text, $add) {
    # TEXT without this Box's lines, plus ADD: every other line kept as it was, line ends and all
    $nl = if ($text -match "`r`n") { "`r`n" } elseif ($text) { "`n" } else { "`r`n" }
    $out = -join @(foreach ($l in @($text -split '(?<=\n)')) {
        if ($l -eq '') { continue }
        if ($l.TrimEnd("`r", "`n") -cmatch $TagRe) { continue }
        $l
    })
    if ($out -and -not $out.EndsWith("`n")) { $out += $nl }
    if ($add) { $out += $add + $nl }
    return $out
}

function Write-Keys($p, $text) {
    # a temp file beside it, then moved into place: a run cut short leaves the old file whole. An existing file is
    # replaced (File.Replace keeps its permissions); a new one is moved in and gets its permissions after.
    $tmp = "$p.roster-new"
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
    try {
        [IO.File]::WriteAllBytes($tmp, $Latin1.GetBytes($text))
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

    if ($Mode -eq 'add') {
        $old = Read-Keys $mine
        $new = New-Text $old $Pub
        if ($mine -eq $userFile -and -not (Test-Path -LiteralPath $sshDir)) {
            New-Item -ItemType Directory -Path $sshDir | Out-Null
        }
        $created = $null -eq $old
        if ($created -or $new -cne $old) { Write-Keys $mine $new }
        if ($mine -eq $adminFile) { Set-AdminAcl $mine }
        elseif ($created) {
            Icacls $mine '/inheritance:r' '/grant:r' "*$($me):F" '/grant:r' "*$($System):F" '/grant:r' "*$($Admins):F"
        } else { User-AclWarnings $mine $me }
        Say "FILE $mine"
    } elseif ($Mode -eq 'remove') {
        # both files sshd could have read this account's keys from (it may have joined or left Administrators since)
        $files = @($userFile) + @(if ($isAdmin -and $adminFile) { $adminFile })
        foreach ($f in $files) {
            $old = Read-Keys $f
            if ($null -eq $old) { continue }
            $new = New-Text $old $null
            if ($new -ceq $old) { continue }
            Write-Keys $f $new
            if ($f -eq $adminFile) { Set-AdminAcl $f }
            Say "FILE $f"
        }
    } else {
        Say "FILE $mine"
        $text = Read-Keys $mine
        if ($null -eq $text) { Say "WARN $mine isn't there: sshd has no key for this account" }
        elseif (-not (@($text -split '\n' | Where-Object { $_.TrimEnd("`r") -cmatch $TagRe }).Count)) {
            Say "WARN $mine doesn't hold this Box's key"
        }
        if ($null -ne $text) {
            if ($mine -eq $adminFile) {
                $why = Admin-AclProblem $mine
                if ($why) { Say "WARN $mine's permissions aren't Microsoft's ($why): sshd ignores it. roster setup sets them" }
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
    """What the script said: the files it wrote or read, its warnings."""

    def __init__(self, files, warnings):
        self.files, self.warnings = files, warnings


def outcome(name, rc, out, err):
    """The script's answer from Host NAME as a Result; RuntimeError (with its code, when it has one) otherwise."""
    lines = [ln.rstrip("\r") for ln in out.splitlines()]
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
        return Result(files, warnings)
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
                           input=script(mode, tag_re).encode(), capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"{h['name']} didn't finish within {timeout} s") from None
    out, err = r.stdout.decode(errors="replace"), r.stderr.decode(errors="replace")
    if r.returncode == 255 and "ROSTER_OK" not in out:          # ssh's own failure: no login, no script
        raise RuntimeError(f"ssh {h['name']} failed: " + (err.strip()[:200] or "no message"))
    return outcome(h["name"], r.returncode, out, err)


def install(h, pub, tag_re, password):
    """Add this Box's key line PUB on Windows Host H, logging in with PASSWORD (paramiko; None: an agent's key)."""
    from .sshops import password_exec
    rc, out, err = password_exec(h, remote_command(), password, timeout=15, stdin=script("add", tag_re, pub))
    return outcome(h["name"], rc, out, err)
