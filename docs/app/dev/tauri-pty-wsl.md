# PTY and child processes from the Tauri core on Windows (verified 2026-10-29)

Crates as of 2026-10: `tauri 2.12.5`, `tauri-build 2.7.4`, `portable-pty 0.9.0` (released 2025-02, still the latest; it's the wezterm crate and uses ConPTY on Windows), `windows-sys 0.61.2`, `serde_json 1.0.154`, `tokio 1.54.1`. Everything marked **verified** ran on this machine: Windows 10.0.26200, WSL 2.7.3, FedoraLinux-44.

## 1. Session PTY: `wsl.exe` inside ConPTY

```rust
let pair = native_pty_system().openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })?;
let mut cmd = CommandBuilder::new("wsl.exe");
cmd.args(["-d", distro, "--cd", "~", "--exec", "ssh", "-o", "BatchMode=yes", host]);
cmd.env("K", "V");                         // on wsl.exe's own process, never in the argv
cmd.env("WSLENV", "<existing>:K/u");        // so it crosses into Linux (see section 2)
let child = pair.slave.spawn_command(cmd)?;   drop(pair.slave);
let reader = pair.master.try_clone_reader()?;  // blocking Read: give it its own std::thread
let writer = pair.master.take_writer()?;       // keystrokes from xterm onData
pair.master.resize(PtySize { .. })?;           // on xterm onResize
```

Verified behaviour:
- **ConPTY writes `ESC[6n` (a cursor-position request) first, and the child doesn't start until the terminal answers.** Without an answer the probe hung forever. In the app, xterm.js answers it automatically once output is piped into it and `onData` goes back to the writer, so the input path must work before anything else does. **In Rust tests on Windows, write `b"\x1b[1;1R"` to the writer right after spawning.** Linux PTYs don't do this.
- portable-pty 0.9 opens ConPTY with `RESIZE_QUIRK | WIN32_INPUT_MODE`, so the output starts with `ESC[?9001h ESC[?1004h` (win32-input-mode and focus reporting). xterm.js ignores 9001. Plain VT input still worked: `read` got the typed line.
- **Resize works end to end.** `stty size` inside WSL went from `24 80` to `40 120`. After a resize ConPTY repaints the whole screen (`ESC[8;40;120t`, then a full redraw). That's expected, so set `windowsPty` in xterm (see xterm-setup.md).
- The exit code comes through: `exit 7` gave `ExitStatus { code: 7 }`.
- **The reader doesn't reach EOF when the child exits.** It only ends once the master is dropped (ClosePseudoConsole). So on exit: `child.wait()` on a thread → drop writer and master → join the reader.
- **Closing the tab:** both `child.kill()` (TerminateProcess on wsl.exe) and dropping the master ended the Linux process. No `sleep` was left in WSL either way. Closing the master gives wsl.exe exit code `0xC000013A`; report that as "closed", not as an error.

## 2. wsl.exe argument and environment rules (verified)

- **`wsl.exe -d D -- a b c` joins the arguments and runs them through the default shell**, so `$x` gets expanded and quoting is lost (`echo:$l` came out as `echo:`). **Always use `--exec`**, which passes argv as given (`[a b][$HOME][;x]` survived). Never build shell strings.
- **Windows env vars don't reach Linux** unless they're listed in `WSLENV` (`FOO` was empty, then `FOO=bar` with `WSLENV=FOO`). The env that `session.prepare` returns (SSH_ASKPASS, ROSTER_ASKPASS_TOKEN…), plus `TERM=xterm-256color` and `COLORTERM=truecolor`, is set on wsl.exe's own process and its names are appended to `WSLENV` with `/u` (Windows to WSL only), e.g. `WSLENV=<existing>:TERM/u:COLORTERM/u:ROSTER_ASKPASS_SOCKET/u:ROSTER_ASKPASS_TOKEN/u:SSH_ASKPASS/u:SSH_ASKPASS_REQUIRE/u`. No `/p`: the values are Linux paths and must not be translated. An existing entry for one of those names is replaced. **Never pass env values as `--exec env K=V`** (the first version did): wsl.exe's command line lives as long as the Session, any process can read it, and process-creation auditing logs it, so the askpass token would leak. `crates/roster-core/src/session.rs` (`session_command`, `wslenv`).
- **The cwd defaults to the Windows cwd translated** (`/mnt/c`). Pass `--cd ~`.
- **PATH under `--exec`, and even `bash -lc`, lacks `~/.local/bin`**, and that's where `roster` lives (`~/.local/bin/roster`). Fedora's `.bashrc` returns early when non-interactive. Only `bash -ic` found it. So: at detection time, resolve the absolute path once (`--exec bash -lc 'PATH=$HOME/.local/bin:$PATH; command -v roster'`) and spawn `--exec /abs/roster serve`. **roster side:** `session.prepare` must put an absolute path in `SSH_ASKPASS`.
- **`ROSTER_CONFIG` from `~/.profile` never reaches `--exec` children either** (Fedora's `bash -l` reads `~/.bash_profile`, not `~/.profile`). So detection also finds the `roster.yml`, by asking roster (`roster inv which` from `$HOME`, ticket 115; a roster too old to answer, or one that finds none, falls back to `$ROSTER_CONFIG`, `~/roster.yml`, `~/.config/roster/roster.yml`, `~/infra/roster.yml`) and starts `<roster> -c <path> serve` (ticket 03, `crates/roster-core/src/detect.rs`).
- **`wsl.exe -l -q` prints UTF-16LE.** Set `WSL_UTF8=1` in the Command's env and it prints UTF-8 (verified), or decode it with `String::from_utf16`.
- **Probing a distro boots it, and booting a distro can break the whole WSL VM.** On 2026-10-29 starting OracleLinux_9 let its `systemd-binfmt` delete `/proc/sys/fs/binfmt_misc/WSLInterop` for the shared VM, so `cmd.exe`/`wsl.exe` from every distro failed with "Exec format error". So detection reads `wsl.exe -l -v` (`[*] NAME STATE VERSION`, `*` = default; the header and STATE words are localized, so rows are recognized by the trailing version number and only the literal `Running` counts as running), probes the default distro first (starting it is fine), then only Running distros, and never starts a stopped non-default one; `docker-desktop*` is skipped. `ROSTER_APP_WSL_DISTRO=<name>` probes only that distro, starting it if needed. The "roster wasn't found" error lists the stopped distros it skipped and names that variable.

## 3. `roster serve`: long-lived child, piped stdio, no console flash

```rust
use std::os::windows::process::CommandExt;
const CREATE_NO_WINDOW: u32 = 0x0800_0000; // windows_sys::Win32::System::Threading::CREATE_NO_WINDOW
let mut c = std::process::Command::new("wsl.exe");
c.args(["-d", distro, "--cd", "~", "--exec", roster_abs, "serve"])
 .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
 .creation_flags(CREATE_NO_WINDOW);
```
Verified: a line written to stdin came back on stdout, stderr was separate, and closing stdin made the child exit 0. A release Tauri exe is a GUI-subsystem app (`windows_subsystem = "windows"`), so without `CREATE_NO_WINDOW` every wsl.exe child opens a console window. The PTY children don't need the flag because ConPTY gives them a console. Read stdout with a line reader on a thread (or `tokio::process` with `kill_on_drop(true)`) and match JSON-RPC ids to pending oneshot senders.

## 4. Streaming output to the frontend: `tauri::ipc::Channel`

The Tauri docs (v2.tauri.app/develop/calling-frontend) say events are JSON-only and "not designed for low latency or high throughput", while channels are "fast and ordered". Pattern:

```rust
#[tauri::command]
fn session_open(host: String, on_output: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>) -> Result<u32, String>
// reader thread:
on_output.send(tauri::ipc::InvokeResponseBody::Raw(buf[..n].to_vec()))?;
```
```ts
const ch = new Channel<ArrayBuffer>(); ch.onmessage = (b) => term.write(new Uint8Array(b));
await invoke("session_open", { host, onOutput: ch });
```
- Send `InvokeResponseBody::Raw(Vec<u8>)`, as in the tauri 2.12.5 source (`ipc/channel.rs`, `ipc/mod.rs`). A bare `Vec<u8>` goes through the `Serialize` impl and becomes a JSON number array. Don't split UTF-8 yourself: xterm's `write(Uint8Array)` decodes across chunk boundaries.
- Coalesce reads with an 8–16 KiB buffer. Send the exit status as a separate small event or channel message.
- Input: `invoke("session_write", { id, data })` with xterm's `onData` string, plus `session_resize { id, cols, rows }`.
