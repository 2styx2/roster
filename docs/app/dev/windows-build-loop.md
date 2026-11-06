# Windows build loop from the WSL checkout (verified 2026-10-29)

Verified with a throwaway `create-tauri-app@4.7.5 --template react-ts` probe (tauri 2.12.5, @tauri-apps/cli 2.12.4, vite 8.3.5) on Windows 10.0.26200, cargo 1.96 msvc, node 26.3 / npm 11.16. The probe dir has been deleted. Nothing was installed globally. Side effects: crates are cached in `C:\Users\you\.cargo\registry` (~350 MB, the normal cargo cache), and the WSL npm cache.

## Recipe

Source of truth: the roster checkout in WSL (e.g. `~/work/roster`). Build copy: `%LOCALAPPDATA%\roster-app-dev\src` = `/mnt/c/Users/you/AppData/Local/roster-app-dev/src`. The copy holds the Cargo workspace (the root `Cargo.toml`, `crates/`, `app/`, `examples/`), not the Python CLI; the app's npm project is `src\app`, and cargo builds into the workspace's `src\target`.

```bash
# 1. one-way sync (rsync is in WSL; ~0.7 s for a small tree): what app/scripts/app-sync.sh does
rsync -a --delete \
  --include /Cargo.toml --include /Cargo.lock --include /rustfmt.toml --include /.gitattributes \
  --include /LICENSE --include /THIRD-PARTY-NOTICES \
  --include /app/ --include /crates/ --include /examples/ --exclude '/*' \
  --exclude .git --exclude node_modules --exclude /target --exclude dist \
  --exclude app/src-tauri/gen \
  ~/work/roster/ /mnt/c/Users/you/AppData/Local/roster-app-dev/src/

# 2. run Windows tools; ALWAYS cd to /mnt/c first (see gotchas)
cd /mnt/c && cmd.exe /c 'cd /d %LOCALAPPDATA%\roster-app-dev\src\app && npm ci'
cd /mnt/c && cmd.exe /c 'cd /d %LOCALAPPDATA%\roster-app-dev\src\app && npm run tauri dev'      # long-running
cd /mnt/c && cmd.exe /c 'cd /d %LOCALAPPDATA%\roster-app-dev\src\app && npm run tauri build -- --no-bundle'
```

## Measured timings

| Step | Time |
|---|---|
| `npm install` (scaffold deps) on Windows-local dir | 22 s |
| `tauri dev` cold (349 crates) until the window opens | 1 m 21 s |
| `tauri dev` warm restart | Vite 0.2 s, cargo ~7 s |
| Edit `app/src/*.tsx` in WSL → rsync → Vite HMR in the window | ~1 s (HMR fires on the rsync write) |
| Edit `app/src-tauri/src/*.rs` in WSL → rsync → auto rebuild and relaunch | 6.8 s compile |
| `tauri build --no-bundle` (release, lto, codegen-units=1) cold | 2 m 20 s, 4.4 MB exe |
| `tauri build --debug --no-bundle`, workspace layout (see testing.md) | 59 s cold |

Scripted (ticket 03; renamed from `scripts/win-*.sh` when the app joined the roster repo): `app/scripts/app-sync.sh`, `app/scripts/app-dev.sh [--ci]` (passes `ROSTER_APP_ROSTER` and `ROSTER_APP_WSL_DISTRO` through `WSLENV`), `app/scripts/app-build.sh [--run] [--installer] [--ci]` (the release copy `roster-app-release`), `app/scripts/app-stop.sh [--release]`. `app-dev.sh` and `app-build.sh` run `npm ci` on their own when the copy has no `node_modules` or `package-lock.json` changed since the last install; `--ci` forces it. The scripts still read the old `ROSTER_DESK_*` env var names when the new ones aren't set. `app/scripts/perf.sh windows` builds and runs its own copy (`roster-app-perf`) with its own Config (`APPDATA`), State (`ROSTER_APP_STATE_DIR`) and WebView2 profile, against a stand-in serve ([performance.md](../performance.md)).

## Gotchas (all observed)

- **The UNC cwd breaks cmd.exe.** If bash's cwd is under `/home` or `/tmp`, cmd.exe prints "UNC paths are not supported. Defaulting to Windows directory." and runs in `C:\Windows`. So `cd /mnt/c &&` first, then `cd /d %LOCALAPPDATA%\...` inside the cmd string. Don't build on `\\wsl.localhost\...`: npm scripts run via cmd.exe can't take a UNC cwd, and file I/O over 9p is slow.
- **PATH is fine.** `cmd.exe /c` from WSL inherits the Windows user PATH: `cargo`, `node`, `npm` resolve to `C:\Users\you\.cargo\bin` and `C:\Program Files\nodejs`. No vcvars is needed; cargo finds MSVC itself.
- **Killing the WSL-side command orphans the Windows processes.** After stopping the bash/cmd.exe job, `node.exe` (vite and the tauri CLI) and the app exe kept running and held port 1420, so the next `tauri dev` would fail with `strictPort`. Stop them by path:
  ```bash
  cd /mnt/c && powershell.exe -NoProfile -Command '$d="$env:LOCALAPPDATA\roster-app-dev"; Get-CimInstance Win32_Process | ? { $_.CommandLine -like "*$d*" -or $_.ExecutablePath -like "$d*" } | % { Stop-Process -Id $_.ProcessId -Force }'
  ```
  This is `app/scripts/app-stop.sh`. Closing the app window ends `tauri dev` cleanly (exit 0).
- **`tauri dev` can be launched from WSL and keeps running.** Run it as a background job (agents: `run_in_background`, then poll the log for `Running \`target\debug\...exe\``). Its stdout is cargo progress full of `\r`; filter it with `tr '\r' '\n' | grep -v Building`.
- **File watching works across the sync.** rsync writes to the NTFS dir and Windows raises native change events: Vite HMR and the tauri CLI's `app/src-tauri` watcher both fired. `--verbose` shows "File app/src-tauri\src\lib.rs changed. Rebuilding application...". Just re-run rsync, or loop it with `inotifywait -r -e close_write` in WSL.
- **Files that only exist on the Windows side.** Builds create `app/src-tauri/gen/` and `Cargo.lock`. `--delete` would wipe them, so exclude `app/src-tauri/gen`, and **commit `Cargo.lock` and `package-lock.json` in WSL** so they sync in. Use `npm ci` on Windows so it never rewrites the lockfile, because changes made on the Windows side are lost on the next sync. A package-lock made by npm in WSL works on Windows because it records the win32 optional packages.
- **Line endings.** rsync copies LF bytes as they are. Vite, tsc and cargo don't care. Add `.gitattributes` with `* text=auto eol=lf` so a future Windows git clone can't introduce CRLF.
- **The window pops up on the developer's desktop.** `tauri dev` opens a real window on the Windows session, so warn the user before an agent launches it.
- **Bundling** (`tauri build` without `--no-bundle`) downloads WiX/NSIS on first use. This wasn't tested. Use `--no-bundle` for the dev loop.
- **Starting another distro can break interop for all of WSL** (observed 2026-10-29). Running anything in `OracleLinux_9` (systemd on) cleared `/proc/sys/fs/binfmt_misc/WSLInterop`, and then every `cmd.exe` from Fedora failed with "Exec format error". `wsl --shutdown` fixes it, or re-register the entry as root. Meanwhile `/init /mnt/c/Windows/System32/cmd.exe …` still works, and the `app/scripts/app-*.sh` fall back to it. The app's Backend detection stops at the first distro that has roster and an Inventory, and the default distro comes first, so it normally starts no other distro.
- **Driving the real window from an agent** (ticket 06): export `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>` and `WEBVIEW2_USER_DATA_FOLDER=%LOCALAPPDATA%\<win dir>\webview` and list both in `WSLENV`. Without its own data folder, WebView2 refuses to start (`HRESULT 0x8007139F`) while another roster app window runs with different browser arguments. The CDP port listens on Windows' `127.0.0.1` only, which WSL can't reach, so drive it with a small Node script run by Windows `node` (built-in `fetch` + `WebSocket`: `Runtime.evaluate`, `Input.insertText`, `Input.dispatchKeyEvent`, `Page.captureScreenshot`).
- **A stale Rust build after a sync** (observed 2026-10-29): `rsync -a` keeps the source's mtime, so a file synced while cargo is compiling can look older than cargo's fingerprint and never be rebuilt (the app then says `Command vault_status not found`). `touch` the changed `.rs` files in WSL and sync again.
- **Env vars into cmd.exe:** `set "X=a b"` inside a `cmd.exe /c '…'` string gets its quotes escaped as `\"` by interop and sets the wrong name. Export the variable in bash and list it in `WSLENV` instead.
