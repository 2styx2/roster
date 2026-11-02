# Linux and WSLg (ticket 20)

The same app runs on Linux under X11, Wayland or WSLg (spec story 54). On Linux Tauri draws with **WebKitGTK 4.1**, not WebView2, so this page lists what differs, how to build or fetch the Linux app, how to run it with its own data, and how to measure it. `app/scripts/linux-run.sh` does each step.

## Build it, or take CI's

```bash
app/scripts/linux-run.sh build          # tauri build --no-bundle in this checkout → ~/.cache/roster-app-linux/bin/roster-app
app/scripts/linux-run.sh fetch [RUN_ID] # or CI's build: the artifact roster-app-linux (this branch's last green CI run, else dev's)
```

Building needs the WebKitGTK 4.1 development packages; `build` prints the command when they're missing:

| Distro | Build (once) | Run only (a fetched binary) |
|---|---|---|
| Fedora (also the WSL Fedora image) | `sudo dnf install -y webkit2gtk4.1-devel openssl-devel libxdo-devel librsvg2-devel libappindicator-gtk3-devel && sudo dnf group install -y development-tools` | `sudo dnf install -y webkit2gtk4.1 gtk3 libsoup3` |
| Debian, Ubuntu | `sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libxdo-dev librsvg2-dev libayatana-appindicator3-dev libssl-dev build-essential pkg-config` | `sudo apt-get install -y libwebkit2gtk-4.1-0 libgtk-3-0` |

CI builds the Linux app on every pull request (`App Linux release build` in `.github/workflows/ci.yml`, Ubuntu 22.04 like the release build, so its glibc runs on newer distros); `fetch` takes that binary and says which libraries are still missing (`ldd`). The release workflow also makes the `.AppImage` and `.deb` ([releasing.md](../../releasing.md)).

## Run it with its own data

```bash
app/scripts/linux-run.sh run              # opens a window; returns when it's closed
app/scripts/linux-run.sh run --example    # the real `roster serve` of this checkout, on a copy of examples/roster.example.yml
app/scripts/linux-run.sh stop             # a run left behind
```

The run never sees your own data. Everything lives in `~/.cache/roster-app-linux` (or `$ROSTER_APP_LINUX_DIR`): the app gets `HOME` and every XDG dir inside it, its own State (`ROSTER_APP_STATE_DIR`), and no `ROSTER_CONFIG`, so detection's probe finds no `roster.yml` (yours or `~/infra`'s), no `init.lua` and no vault session. By default `ROSTER_APP_ROSTER` is the stand-in serve (`app/scripts/perf/serve.py`): 1,284 made-up Hosts in 198.18.0.0/15, no vault, Sessions that print a busy log, and a Host named `latency` (below). No Host is ever reached. The app's output goes to `run.log` there.

Options for a window that misbehaves: `--x11` (`GDK_BACKEND=x11`: XWayland), `--no-dmabuf` (`WEBKIT_DISABLE_DMABUF_RENDERER=1`: a blank or grey window, common with NVIDIA and in VMs), `--no-compositing` (`WEBKIT_DISABLE_COMPOSITING_MODE=1`: no GPU compositing, so the terminal falls back to the DOM renderer, which is also a good test of the fallback).

**Under WSLg** the window is a Wayland window (or X11 with `--x11`) on the Windows desktop. WSLg's GL is Mesa: the GPU through `d3d12` where the distro's Mesa has it, else `llvmpipe` (software). The clipboard is shared with Windows. There's no desktop portal, so light/dark follows GTK's theme: run with `GTK_THEME=Adwaita:dark` to see the dark side.

## Measure it

```bash
app/scripts/linux-run.sh measure   # puts 1 MB of text on the clipboard, then runs as above
```

In the window: `␣ f`, type `latency`, Enter. That Session (`app/scripts/perf/latency.py`) measures the terminal path from inside: each measurement ends with a cursor-position request (CSI 6 n), which xterm.js answers only after it has parsed everything printed before it, so the time to the answer is the whole trip (PTY, core, IPC, xterm's parser and back) without devtools or window automation. WebKitGTK has no DevTools protocol like WebView2's, which is what `perf.sh windows` drives. It runs:

- **idle round trip**: 50 requests with nothing printed (a keystroke's echo, minus drawing);
- **2 MB coloured log**: how long xterm takes to take it in;
- **htop-like redraw**: 200 full screens at the window's size, every row rewritten in colour, timed per frame;
- **large paste**: it asks you to paste (Ctrl+Shift+V) and times the 1 MB from the first byte to the last, checking every byte arrived (`PERF_PASTE_KB` changes the size).

Then type `␣ :info` Enter and note the renderer and `Picker opened in N ms` (open the Picker a few times first; `:info` keeps the last). Close the window: `measure` prints the results as rows for [performance.md](../performance.md) (`linux-run.sh report` prints them again). Results are kept in `results/` as JSON.

The Picker and frame numbers can't come from inside a Session: the Picker's open time is the frontend's own (`app/src/picker/timing.ts`, decision Q86), and frame pacing needs a profiler (WebKit's inspector, `WEBKIT_INSPECTOR_SERVER`, in a debug build).

## What's different on WebKitGTK, and what the app does about it

| What | On Linux | Where |
|---|---|---|
| WebGL | The WebGL2 context can fail to start (no GPU, software GL, some VMs and WSLg setups) or be lost. The terminal then draws with xterm.js's DOM renderer, for good when it couldn't start and until it's next shown when it was lost; `:info` says which (`DOM (no WebGL here)`, `DOM (WebGL context lost)`) | `app/src/terminal/renderer.ts`, its tests and `App.terminal.test.tsx` |
| Light and dark | `theme = "auto"` follows `prefers-color-scheme`. Tauri (tao, with its default `dbus` feature) reads the desktop portal's colour scheme (GNOME, KDE) at start and on change and sets GTK's dark-theme preference, which WebKitGTK reports to the page. Without a portal (WSLg, bare window managers) it's GTK's theme | `app/src/theme/useTheme.ts`, `App.theme.test.tsx` |
| Shortcuts | The same as on Windows: Ctrl, no Windows-only key. WebKitGTK has no browser shortcuts of its own (no find bar, reload or zoom keys), so nothing needs turning off as on WebView2. An input method (IBus, Fcitx) owns the keys while it composes; Fcitx takes Ctrl+Space, the default Leader, so set another ([keyboard.md](../keyboard.md)) | `chordOf` in `app/src/keymap.ts` |
| Title bar | The app draws its own (`decorations: false`); on Wayland tao turns client-side decorations on so the compositor adds none. Dragging and double-click to maximize use Tauri's drag regions, which work on Linux; tao gives an undecorated window resize borders. Wayland doesn't let an app place its window, so the saved position is ignored there (the size is kept) | `app/src/chrome/TitleBar.tsx`, `roster-core/src/window.rs` |
| Fonts | Inter and Iosevka are bundled, so text looks the same everywhere. Installed fonts named in `terminal.font` are found by name (`:info` says which is in use) | `app/src/main.tsx`, `app/src/terminal/fonts.ts` |
| Scrollbars | WebKit may not know `scrollbar-width` and `scrollbar-color`; `::-webkit-scrollbar` rules give it the same thin, themed bars (Chromium ignores them where the standard properties are set) | `app/src/styles.css`, `styles.test.ts` |
| CSS | Nesting, `@starting-style`, `color-mix()` and `:has()` need WebKitGTK 2.44 or newer (Ubuntu 22.04 and later ship newer through updates). Older ones still work, without the entry transitions. Nothing the layout depends on uses `:has()`: which panel lies over which, the Sidebar's room and the terminal's minimum beside docked panels come from data attributes the app sets on the body (`data-full`, `data-sidebar`, `data-docked`, #176), so an older WebKitGTK only loses cosmetic touches | `app/src/styles.css` (Panels), `App.panels.test.tsx` |

## What to check by hand (the owner's runs)

On a Linux VM (X11 and Wayland sessions) and under WSLg, each with `linux-run.sh measure`:

1. The window opens, is the right size, moves by the title bar, maximizes on double-click, resizes from its edges, and its minimize, maximize and close buttons work.
2. `:info` names the renderer; with `--no-compositing` it says DOM and the terminal still draws.
3. Light/dark: switch the desktop's colour scheme (GNOME Settings → Appearance) while it runs; under WSLg start it with `GTK_THEME=Adwaita:dark`.
4. Keys: Ctrl+Space (unless an input method takes it), Ctrl+Shift+C / V, Ctrl+Shift+F, Ctrl+= / − / 0, F11. With IBus or Fcitx, compose a word in the Picker: Enter commits it and doesn't open a Host.
5. The measurements above, written into [performance.md](../performance.md) as a Linux column.
