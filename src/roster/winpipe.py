"""Windows named pipes for the askpass channel (roster/askpass.py), when roster runs natively on Windows.

serve's end is a pipe only this user can open: its security descriptor names this user's SID as the owner and as the
one entry in a protected DACL (nothing inherited, no Administrators, no SYSTEM), every instance refuses remote
clients, and the first instance is created with FILE_FLAG_FIRST_PIPE_INSTANCE, so serve fails rather than share a name
someone else made first. The name has 128 random bits. The helper's end opens it with SECURITY_IDENTIFICATION, so the
pipe's server can't act as the helper's user (a squatter learns nothing it could use). serve also checks each client's
process: its token's user must be serve's own (client_sid), on top of the DACL (ticket 63).

One exchange per connection, in byte mode, as on the Unix socket: the client writes a line, serve answers and
disconnects, and the client reads to the end. Reads and writes can time out: a timeout cancels the blocked call
(CancelSynchronousIo) and raises TimeoutError.

Stdlib only (ctypes), like askpass.py: ssh runs the helper for every prompt.
"""

import ctypes
import functools
import threading
from ctypes import wintypes

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)

PIPE_ACCESS_DUPLEX = 0x00000003
FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000
PIPE_TYPE_BYTE = PIPE_READMODE_BYTE = PIPE_WAIT = 0x00000000
PIPE_REJECT_REMOTE_CLIENTS = 0x00000008
PIPE_UNLIMITED_INSTANCES = 255
GENERIC_READ, GENERIC_WRITE = 0x80000000, 0x40000000
OPEN_EXISTING = 3
SECURITY_SQOS_PRESENT, SECURITY_IDENTIFICATION = 0x00100000, 0x00010000
TOKEN_QUERY, TOKEN_USER_CLASS = 0x0008, 1
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
THREAD_TERMINATE = 0x0001
SDDL_REVISION_1 = 1
ERROR_BROKEN_PIPE, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED = 109, 231, 535
ERROR_NO_DATA, ERROR_PIPE_NOT_CONNECTED, ERROR_OPERATION_ABORTED = 232, 233, 995
INVALID_HANDLE_VALUE = wintypes.HANDLE(-1).value
BUFFER = 4096


class SECURITY_ATTRIBUTES(ctypes.Structure):
    _fields_ = [("nLength", wintypes.DWORD), ("lpSecurityDescriptor", wintypes.LPVOID),
                ("bInheritHandle", wintypes.BOOL)]


def _api(dll, name, restype, *argtypes):
    f = getattr(dll, name)
    f.restype, f.argtypes = restype, argtypes
    return f


H, D, B, P = wintypes.HANDLE, wintypes.DWORD, wintypes.BOOL, wintypes.LPVOID
CreateNamedPipeW = _api(kernel32, "CreateNamedPipeW", H, wintypes.LPCWSTR, D, D, D, D, D, D,
                        ctypes.POINTER(SECURITY_ATTRIBUTES))
ConnectNamedPipe = _api(kernel32, "ConnectNamedPipe", B, H, P)
DisconnectNamedPipe = _api(kernel32, "DisconnectNamedPipe", B, H)
CreateFileW = _api(kernel32, "CreateFileW", H, wintypes.LPCWSTR, D, D, P, D, D, H)
WaitNamedPipeW = _api(kernel32, "WaitNamedPipeW", B, wintypes.LPCWSTR, D)
ReadFile = _api(kernel32, "ReadFile", B, H, P, D, ctypes.POINTER(D), P)
WriteFile = _api(kernel32, "WriteFile", B, H, P, D, ctypes.POINTER(D), P)
FlushFileBuffers = _api(kernel32, "FlushFileBuffers", B, H)
CloseHandle = _api(kernel32, "CloseHandle", B, H)
GetCurrentProcess = _api(kernel32, "GetCurrentProcess", H)
OpenProcess = _api(kernel32, "OpenProcess", H, D, B, D)
GetNamedPipeClientProcessId = _api(kernel32, "GetNamedPipeClientProcessId", B, H, ctypes.POINTER(wintypes.ULONG))
GetCurrentThreadId = _api(kernel32, "GetCurrentThreadId", D)
OpenThread = _api(kernel32, "OpenThread", H, D, B, D)
CancelSynchronousIo = _api(kernel32, "CancelSynchronousIo", B, H)
LocalFree = _api(kernel32, "LocalFree", P, P)
OpenProcessToken = _api(advapi32, "OpenProcessToken", B, H, D, ctypes.POINTER(H))
GetTokenInformation = _api(advapi32, "GetTokenInformation", B, H, ctypes.c_int, P, D, ctypes.POINTER(D))
ConvertSidToStringSidW = _api(advapi32, "ConvertSidToStringSidW", B, P, ctypes.POINTER(wintypes.LPWSTR))
ConvertStringSecurityDescriptorToSecurityDescriptorW = _api(
    advapi32, "ConvertStringSecurityDescriptorToSecurityDescriptorW", B, wintypes.LPCWSTR, D, ctypes.POINTER(P),
    ctypes.POINTER(D))


def _fail(err=None):
    raise ctypes.WinError(ctypes.get_last_error() if err is None else err)


@functools.lru_cache(maxsize=1)
def user_sid():
    """This process's user, as a string SID (S-1-5-21-...); read once (it can't change), so checking each askpass
    client costs one token read, the client's."""
    return process_sid(GetCurrentProcess())


def process_sid(process):
    """The user of the process whose handle is PROCESS, as a string SID; OSError if it can't be read."""
    token = H()
    if not OpenProcessToken(process, TOKEN_QUERY, ctypes.byref(token)):
        _fail()
    try:
        size = D()
        GetTokenInformation(token, TOKEN_USER_CLASS, None, 0, ctypes.byref(size))
        if not size.value:
            _fail()
        buf = ctypes.create_string_buffer(size.value)
        if not GetTokenInformation(token, TOKEN_USER_CLASS, buf, size, ctypes.byref(size)):
            _fail()
        sid = ctypes.cast(buf, ctypes.POINTER(ctypes.c_void_p))[0]     # TOKEN_USER.User.Sid
        text = wintypes.LPWSTR()
        if not ConvertSidToStringSidW(sid, ctypes.byref(text)):
            _fail()
        try:
            return text.value
        finally:
            LocalFree(text)
    finally:
        CloseHandle(token)


def client_sid(conn):
    """The user of the process at the other end of serve's connected pipe CONN (GetNamedPipeClientProcessId, then
    that process's token), as a string SID; OSError if it can't be told (the client has gone, say)."""
    pid = wintypes.ULONG()
    if not GetNamedPipeClientProcessId(conn.handle, ctypes.byref(pid)):
        _fail()
    process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
    if not process:
        _fail()
    try:
        return process_sid(process)
    finally:
        CloseHandle(process)


def only_user_sddl(sid):
    """The security descriptor serve's pipe gets: owned by SID, and a protected DACL whose one entry gives SID full
    access. Nobody else (other users, Administrators, SYSTEM, a network logon) can open or add an instance."""
    return f"O:{sid}D:P(A;;GA;;;{sid})"


class Conn:
    """One end of a connected pipe: recv and sendall like a socket's, held to settimeout's limit."""

    def __init__(self, handle, server=False):
        self.handle, self.server, self.timeout = handle, server, None

    def settimeout(self, seconds):
        self.timeout = seconds

    def _limited(self, call):
        """CALL(), cancelled (TimeoutError) if it blocks longer than the timeout."""
        if self.timeout is None:
            return call()
        thread = OpenThread(THREAD_TERMINATE, False, GetCurrentThreadId())
        lock, state = threading.Lock(), {"in_flight": True, "fired": False}

        def cancel():
            # Only while CALL is still running: the timer can fire as it returns, and CancelSynchronousIo would then
            # cancel this thread's next I/O instead
            with lock:
                if state["in_flight"]:
                    state["fired"] = True
                    CancelSynchronousIo(thread)

        timer = threading.Timer(self.timeout, cancel)
        timer.start()
        try:
            return call()
        except OSError as e:
            if state["fired"] and getattr(e, "winerror", None) == ERROR_OPERATION_ABORTED:
                raise TimeoutError("timed out") from None
            raise
        finally:
            with lock:
                state["in_flight"] = False
            timer.cancel()
            timer.join()                    # cancel() is done with the thread's handle before it's closed
            CloseHandle(thread)

    def recv(self, size):
        """Up to SIZE bytes; b"" once the other end has closed."""
        def read():
            buf, got = ctypes.create_string_buffer(size), D()
            if not ReadFile(self.handle, buf, size, ctypes.byref(got), None):
                err = ctypes.get_last_error()
                if err in (ERROR_BROKEN_PIPE, ERROR_PIPE_NOT_CONNECTED):
                    return b""
                _fail(err)
            return buf.raw[:got.value]
        return self._limited(read)

    def sendall(self, data):
        def write():
            view = memoryview(bytes(data))
            while view:
                part = view[:BUFFER].tobytes()
                chunk, done = (ctypes.c_char * len(part)).from_buffer_copy(part), D()
                if not WriteFile(self.handle, chunk, len(part), ctypes.byref(done), None):
                    _fail()
                view = view[done.value:]
        self._limited(write)

    def close(self):
        if self.handle is None:
            return
        if self.server:
            FlushFileBuffers(self.handle)         # the client reads all of the answer before the disconnect
            DisconnectNamedPipe(self.handle)
        CloseHandle(self.handle)
        self.handle = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


class Server:
    """serve's end: a pipe NAME only this user can open. accept() blocks until a client connects; close() from another
    thread makes a blocked accept() raise OSError."""

    def __init__(self, name):
        self.name, self.closed = name, False
        sd = P()
        if not ConvertStringSecurityDescriptorToSecurityDescriptorW(only_user_sddl(user_sid()), SDDL_REVISION_1,
                                                                    ctypes.byref(sd), None):
            _fail()
        self._sd = sd
        self._sa = SECURITY_ATTRIBUTES(ctypes.sizeof(SECURITY_ATTRIBUTES), sd, False)
        self._lock = threading.Lock()
        self._waiting = self._instance(first=True)     # the name is ours before anyone is told it

    def _instance(self, first=False):
        flags = PIPE_ACCESS_DUPLEX | (FILE_FLAG_FIRST_PIPE_INSTANCE if first else 0)
        mode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS
        h = CreateNamedPipeW(self.name, flags, mode, PIPE_UNLIMITED_INSTANCES, BUFFER, BUFFER, 0,
                             ctypes.byref(self._sa))
        if h == INVALID_HANDLE_VALUE:
            _fail()
        return h

    def accept(self):
        with self._lock:
            h = self._waiting
        if h is None:
            raise OSError("the askpass pipe is closed")
        if not ConnectNamedPipe(h, None):
            err = ctypes.get_last_error()
            if err not in (ERROR_PIPE_CONNECTED, ERROR_NO_DATA):    # ERROR_NO_DATA: came and went already
                _fail(err)
        with self._lock:
            if self.closed:
                raise OSError("the askpass pipe is closed")
            self._waiting = self._instance()
        return Conn(h, server=True)

    def close(self):
        """Stop accepting: wake a blocked accept() by connecting to the waiting instance, then close it."""
        with self._lock:
            if self.closed:
                return
            self.closed = True
        try:
            connect(self.name, timeout=1).close()
        except OSError:
            pass
        with self._lock:
            h, self._waiting = self._waiting, None
        if h is not None:
            CloseHandle(h)
        LocalFree(self._sd)


def connect(name, timeout):
    """The client's end of pipe NAME, waiting up to TIMEOUT seconds while every instance is busy."""
    import time
    deadline = time.monotonic() + timeout
    while True:
        h = CreateFileW(name, GENERIC_READ | GENERIC_WRITE, 0, None, OPEN_EXISTING,
                        SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, None)
        if h != INVALID_HANDLE_VALUE:
            return Conn(h)
        err = ctypes.get_last_error()
        left = deadline - time.monotonic()
        if err != ERROR_PIPE_BUSY or left <= 0:
            _fail(err)
        WaitNamedPipeW(name, max(1, min(100, int(left * 1000))))
