"""Windows: read a file only if it's this user's alone (#411), the Windows half of common.read_private.

Windows has no mode bits, so "only you can read it" is the file's security descriptor: its owner must be this user
(the SID roster's askpass pipe names, winpipe.user_sid), or SYSTEM or Administrators (who can take any file anyway,
and own what an elevated administrator's shell creates), as for a key folder on a Windows Host (winhost.py), and its
DACL may let nobody but this user, SYSTEM and Administrators open it, the ACL a file in your own %APPDATA% inherits
and the one roster gives a key file it creates on a Windows Host (this account, SYSTEM, Administrators; winhost.py). A
deny entry only narrows, so it's fine; an allow entry for OWNER RIGHTS is the owner, already checked; an allow entry
for anyone else (Users, Everyone, Authenticated Users, another account), one roster can't read, or no DACL at all
(everyone may) is refused.

The file is opened once, without following a link or any other reparse point (FILE_FLAG_OPEN_REPARSE_POINT, then the
handle's attributes say whether it is one), and its owner, DACL and text all come from that one handle, so it can't be
swapped between the check and the read.

The ctypes parts load on first use, so the rules (problem) can be tested anywhere.
"""

import ctypes
import functools
import os

from .common import NotPrivate

SYSTEM, ADMINISTRATORS = "S-1-5-18", "S-1-5-32-544"
OWNER_RIGHTS = "S-1-3-4"                    # whoever owns the file, checked on its own
ACCESS_ALLOWED, ACCESS_ALLOWED_CALLBACK = 0x00, 0x09                     # SID right after the mask
ACCESS_DENIED_TYPES = {0x01, 0x06, 0x0A, 0x0C}                           # denied, object, callback, callback object
INHERIT_ONLY = 0x08                                                      # applies to children, not this file

GENERIC_READ = 0x80000000
FILE_SHARE_READ = 0x00000001
OPEN_EXISTING = 3
FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT = 0x10, 0x400
SE_FILE_OBJECT = 1
OWNER_SECURITY_INFORMATION, DACL_SECURITY_INFORMATION = 0x1, 0x4
ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND = 2, 3


def problem(owner, aces, me):
    """Why a file owned by OWNER whose DACL is ACES (a list of (type, flags, sid), or None for no DACL) isn't ME's
    alone, or None if it is. A SID of None is an entry roster couldn't read."""
    if owner not in (me, SYSTEM, ADMINISTRATORS):
        return "isn't yours (another account owns it)"
    if aces is None:
        return "has no access list, so everyone may open it"
    for kind, flags, sid in aces:
        if kind in ACCESS_DENIED_TYPES or flags & INHERIT_ONLY:
            continue
        if kind not in (ACCESS_ALLOWED, ACCESS_ALLOWED_CALLBACK) or sid is None:
            return "has an access entry roster can't check"
        if sid not in (me, SYSTEM, ADMINISTRATORS, OWNER_RIGHTS):
            return f"can be opened by others ({sid})"
    return None


def read_private(path):
    """PATH's text if it's this user's alone; FileNotFoundError if there's nothing there, NotPrivate otherwise."""
    if not os.path.lexists(path):
        raise FileNotFoundError(path)
    api = _api()
    from . import winpipe
    handle = api.CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, None, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT,
                             None)
    if handle in (None, api.INVALID_HANDLE_VALUE):
        err = ctypes.get_last_error()  # pyright: ignore[reportAttributeAccessIssue] - Windows only
        if err in (ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND):
            raise FileNotFoundError(path)
        raise NotPrivate(f"{path} can't be opened ({ctypes.FormatError(err).strip()})")  # pyright: ignore[reportAttributeAccessIssue]
    fd = None
    try:
        attrs = _attributes(api, handle, path)
        if attrs & FILE_ATTRIBUTE_REPARSE_POINT:
            raise NotPrivate(f"{path} is a link (roster never follows one here)")
        if attrs & FILE_ATTRIBUTE_DIRECTORY:
            raise NotPrivate(f"{path} isn't a plain file")
        owner, aces = _security(api, handle, path)
        why = problem(owner, aces, winpipe.user_sid())
        if why:
            raise NotPrivate(f"{path} {why}")
        import msvcrt
        fd = msvcrt.open_osfhandle(handle, os.O_RDONLY)  # pyright: ignore[reportAttributeAccessIssue] - Windows only
        with os.fdopen(fd, "rb") as f:                   # closes the handle too
            return f.read().decode("utf-8", "replace")
    finally:
        if fd is None:
            api.CloseHandle(handle)


def _attributes(api, handle, path):
    info = api.BY_HANDLE_FILE_INFORMATION()
    if not api.GetFileInformationByHandle(handle, ctypes.byref(info)):
        raise NotPrivate(f"{path}'s attributes can't be read")
    return info.dwFileAttributes


def _security(api, handle, path):
    """The owner SID and the DACL's entries of the file open as HANDLE (see problem)."""
    owner, dacl, sd = ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p()
    err = api.GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                              ctypes.byref(owner), None, ctypes.byref(dacl), None, ctypes.byref(sd))
    if err:
        raise NotPrivate(f"{path}'s permissions can't be read ({ctypes.FormatError(err).strip()})")  # pyright: ignore[reportAttributeAccessIssue]
    try:
        who = _sid_text(api, owner)
        if not dacl.value:
            return who, None
        count = ctypes.cast(dacl, ctypes.POINTER(api.ACL)).contents.AceCount
        aces = []
        for i in range(count):
            ace = ctypes.c_void_p()
            if not api.GetAce(dacl, i, ctypes.byref(ace)):
                aces.append((-1, 0, None))
                continue
            header = ctypes.cast(ace, ctypes.POINTER(api.ACE_HEADER)).contents
            sid = None
            if header.AceType in (ACCESS_ALLOWED, ACCESS_ALLOWED_CALLBACK):
                sid = _sid_text(api, ctypes.c_void_p((ace.value or 0) + 8))   # header (4 bytes), mask (4), then the SID
            aces.append((header.AceType, header.AceFlags, sid))
        return who, aces
    finally:
        api.LocalFree(sd)


def _sid_text(api, sid):
    from ctypes import wintypes
    text = wintypes.LPWSTR()
    if not sid.value or not api.ConvertSidToStringSidW(sid, ctypes.byref(text)):
        return None
    try:
        return text.value
    finally:
        api.LocalFree(text)


@functools.lru_cache(maxsize=1)
def _api():
    """kernel32's and advapi32's calls read_private makes, typed, loaded once (Windows only)."""
    from ctypes import wintypes
    WinDLL = ctypes.WinDLL  # pyright: ignore[reportAttributeAccessIssue] - Windows only
    kernel32 = WinDLL("kernel32", use_last_error=True)
    advapi32 = WinDLL("advapi32", use_last_error=True)

    def fn(dll, name, restype, *argtypes):
        f = getattr(dll, name)
        f.restype, f.argtypes = restype, argtypes
        return f

    class BY_HANDLE_FILE_INFORMATION(ctypes.Structure):
        _fields_ = [("dwFileAttributes", wintypes.DWORD), ("ftCreationTime", wintypes.FILETIME),
                    ("ftLastAccessTime", wintypes.FILETIME), ("ftLastWriteTime", wintypes.FILETIME),
                    ("dwVolumeSerialNumber", wintypes.DWORD), ("nFileSizeHigh", wintypes.DWORD),
                    ("nFileSizeLow", wintypes.DWORD), ("nNumberOfLinks", wintypes.DWORD),
                    ("nFileIndexHigh", wintypes.DWORD), ("nFileIndexLow", wintypes.DWORD)]

    class ACL(ctypes.Structure):
        _fields_ = [("AclRevision", ctypes.c_ubyte), ("Sbz1", ctypes.c_ubyte), ("AclSize", wintypes.WORD),
                    ("AceCount", wintypes.WORD), ("Sbz2", wintypes.WORD)]

    class ACE_HEADER(ctypes.Structure):
        _fields_ = [("AceType", ctypes.c_ubyte), ("AceFlags", ctypes.c_ubyte), ("AceSize", wintypes.WORD)]

    H, D, B, P = wintypes.HANDLE, wintypes.DWORD, wintypes.BOOL, ctypes.c_void_p
    import types
    ns = types.SimpleNamespace()
    ns.BY_HANDLE_FILE_INFORMATION, ns.ACL, ns.ACE_HEADER = BY_HANDLE_FILE_INFORMATION, ACL, ACE_HEADER
    ns.INVALID_HANDLE_VALUE = H(-1).value
    ns.CreateFileW = fn(kernel32, "CreateFileW", H, wintypes.LPCWSTR, D, D, P, D, D, H)
    ns.CloseHandle = fn(kernel32, "CloseHandle", B, H)
    ns.GetFileInformationByHandle = fn(kernel32, "GetFileInformationByHandle", B, H,
                                       ctypes.POINTER(BY_HANDLE_FILE_INFORMATION))
    ns.LocalFree = fn(kernel32, "LocalFree", P, P)
    ns.GetSecurityInfo = fn(advapi32, "GetSecurityInfo", D, H, ctypes.c_int, D, ctypes.POINTER(P), ctypes.POINTER(P),
                            ctypes.POINTER(P), ctypes.POINTER(P), ctypes.POINTER(P))
    ns.GetAce = fn(advapi32, "GetAce", B, P, D, ctypes.POINTER(P))
    ns.ConvertSidToStringSidW = fn(advapi32, "ConvertSidToStringSidW", B, P, ctypes.POINTER(wintypes.LPWSTR))
    return ns
