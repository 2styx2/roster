# Performance: what the app costs, and the budgets

Ticket T38 (issue #50). How much CPU, memory, wake-ups and frame time the app uses idle and busy, what was fixed, and the budgets a change has to stay inside. Measure with `app/scripts/perf.sh`; every number here came from it.

## How to measure

```bash
app/scripts/perf.sh windows --build   # the release build on Windows (opens a window on the desktop)
app/scripts/perf.sh browser           # the frontend in Chromium: renders, timers, heap
app/scripts/perf.sh serve             # the real `roster serve`, idle
app/scripts/linux-run.sh measure      # the Linux build under WSLg, X11 or Wayland (opens a window): terminal latency
```

- **windows** builds a release `roster-app.exe` in its own copy (`%LOCALAPPDATA%\roster-app-perf`, or `$ROSTER_APP_WIN_DIR`) and runs it with its own Config (`APPDATA`), State (`ROSTER_APP_STATE_DIR`) and WebView2 profile under that copy, against a stand-in `roster serve` (`app/scripts/perf/serve.py`): 1,284 made-up Hosts at addresses in 198.18.0.0/15 (the benchmarking range), no vault, and Sessions whose shell prints a busy coloured log (`PERF_RATE` lines a second, default 100) through the real path: PTY, `wsl.exe`, ConPTY, the IPC channel, xterm.js. It never reaches an Inventory, a vault or a Host. (Detection's probe still finds the user's `roster.yml` and passes `-c PATH`; the stand-in ignores it.) `app/scripts/perf/drive.mjs`, run by Windows' node, drives the window over the DevTools protocol: idle, opening 12 Sessions through the Picker, busy, typing in the Picker, Focus mode, closing every Session, idle again. It samples every process the app started (PowerShell: CPU time, working set, private bytes, thread context switches as wake-ups) and serve and the shells in WSL (`/proc`), each sample timed where it's taken. Frame intervals are measured separately, after each CPU window, because asking for every frame makes the webview draw at the display's rate. At the end it kills the process tree it started, then `app-stop.sh` for that copy. `PERF_PROFILE=1` adds the webview main thread's top functions; `PERF_JSON=1` prints JSON.
- **browser** runs Vite and the fake Backend's `perf` fixture (`?fixture=perf&sessions=12&rate=100`: the worst case's 1,284 Hosts, no vault, Sessions whose fake shell prints the same log) in Playwright's Chromium. A minimal React DevTools hook counts commits and which components rendered; timer and frame callbacks are counted; the heap is read after a forced GC. Headless Chromium draws WebGL in software, so its busy % is mostly that; read its script %, renders and heap, and take CPU from the Windows run.
- **Linux** ([dev/linux.md](dev/linux.md), ticket 20): WebKitGTK has no DevTools protocol to drive, so the stand-in serve's `latency` Host measures from inside its Session (idle round trip, a 2 MB log, an htop-like redraw, a 1 MB paste) and `:info` gives the renderer and the Picker's open time. `linux-run.sh report` prints the rows for a Linux column here.
- **serve** starts this checkout's `roster serve` on a copy of `examples/roster.example.yml` and counts its threads' context switches for `PERF_SECONDS` (default 10), without and with `inventory.watch`.

## Before and after

Windows 11, release build, 24 logical processors, a 240 Hz display, the 1,284-Host Inventory, 12 Sessions each printing 100 lines a second (1,200 lines/s in all). CPU is in % of one core, summed over every process the app started (`roster-app.exe`, the WebView2 processes, `wsl.exe` and `conhost.exe` per Session, serve and the shells in WSL). **Before** is `dev` at 93560a2; **#63** is `dev` at 9a0a133 (PR #63, `sectionBuilder()`: a Session event rebuilds only the Sidebar's Sessions section); **after** is this branch on top of 9a0a133 (it was rebased onto PR #65 after measuring; #65 only adds a little string work per output chunk while a Session opens or offers "Save to vault", and wasn't re-measured).

| Windows | Before | #63 | After |
|---|---:|---:|---:|
| Idle, 15 s after start: CPU | 0.9 % | 0.8 % | 1.2 % |
| Idle, 15 s after start: wake-ups | 24/s | 22/s | 29/s |
| Busy: CPU, all processes | 121.8 % | 115.5 % | **42.8 %** |
| Busy: CPU, webview renderer | 105.2 % (saturated) | 103.5 % | **22.6 %** |
| Busy: frame interval p50 / p95 | 575 / 592 ms | 562 / 571 ms | **4.2 / 4.3 ms** |
| Busy: DOM nodes | 340,848 | 236,737 | **49,317** |
| Busy: private bytes, all / renderer | 1,543 / 1,045 MB | 1,528 / 1,033 MB | **1,054 / 571 MB** |
| Busy: lines taken (1,200 asked) | 1,197/s | 1,199/s | 1,196/s |
| Typing in the Picker while busy: CPU | 122.8 % | 124.2 % | **55.5 %** |
| Focus mode while busy: CPU | 121.0 % | 150.9 % | **52.3 %** |
| Every Session closed: CPU / wake-ups | 0.1 % / 27/s | 0.2 % / 26/s | 0.0 % / 17/s |
| Every Session closed: JS heap / private bytes | 19.9 / 764 MB | 13.7 / 718 MB | 13.8 / 532 MB |

| Browser (Chromium, dev build) | Before | #63 | After |
|---|---:|---:|---:|
| Opening 12 Sessions: Sidebar `Row` renders | 33,918 | **1,618** | 1,618 |
| Busy: script time | 6.8 % | 6.5 % | **1.4 %** |
| Idle: timer callbacks, frames, React commits | 0 | 0 | 0 |
| Per key typed in the Picker | 8 renders (`Cap` 4, `Keys` 3, `Picker` 1) | same | same |
| Per key typed in a terminal, per output chunk | 0 renders | 0 | 0 |

| `roster serve`, idle | Before | After |
|---|---:|---:|
| Without `inventory.watch` | 5.0 wake-ups/s | **0.0** |
| With `inventory.watch` (the app always starts it) | 10.0 wake-ups/s | **1.9** |

The numbers move a few points between runs on a desktop that's doing other things; the busy ones moved from ~120 % to ~45 % in every run.

## What was costly, and the fixes

1. **Hidden terminals redrew on every scroll** (the big one). Only the Session on screen gets the WebGL renderer (ticket 27: a browser keeps about 16 WebGL contexts); the others fall back to xterm.js's DOM renderer inside a `display: none` pane. xterm.js 6 pauses a hidden terminal's renderer, but each scroll also refreshes the selection, and that path redraws every row straight away, pause or not. Each redraw measures characters against a hidden box, which always reads 0 and so is never cached: a forced style recalculation per character. With 11 busy hidden Sessions the webview's main thread was saturated (frames every ~575 ms, the UI unusable). **Fix:** a hidden terminal holds its Session's output and takes it in one write when it's shown (`app/src/terminal/hold.ts`). Output that asks the terminal something (a cursor-position or device-status request, device attributes, a mode or version query, an OSC colour query, any DCS) goes through at once with what was held before it, so ConPTY's start-up question and programs that wait for an answer are never stuck behind a hidden tab; 256 KB held also goes through, so a long-hidden busy Session doesn't pile up.
2. **Every Session event re-rendered the whole Inventory** in the Sidebar (1,284 rows). Fixed by PR #63 (`sectionBuilder()`), measured here: 33,918 → 1,618 `Row` renders while 12 Sessions open.
3. **`roster serve` polled while idle.** The askpass channel's accept loop woke every 0.2 s to drop expired tokens and run serve's tick (which forgets held passwords past `HOLD_FOR`); it now sleeps until a connection, the next expiry, the tick's next due time, or a nudge (a new token or held password), so a typed password still leaves memory on time (`tests/test_serve.py`, `tests/test_quick_save.py`). The `roster.yml` watcher looks every 0.5 s and steps to 0.2 s only while a save settles, so an outside edit still shows within a second.

Also checked and fine: no timers, intervals or animation frames at idle; no React render per keystroke in a terminal or per output chunk (the store outside React only notifies on tab changes); the idle lock re-checks the clock once at the deadline instead of rescheduling on input; Config watching uses the OS's file events (`notify`), not polling; closing every Session gives back the DOM nodes, listeners and JS heap (within 1 MB of idle).

## Budgets

A change that goes over one of these needs a reason in its pull request. Measure with `app/scripts/perf.sh`.

| What | Budget | Now |
|---|---|---|
| Idle (no Sessions), all processes | ≤ 2 % of a core, ≤ 50 wake-ups/s | 0.0–1.2 %, 17–29/s |
| Idle frontend | no timers, intervals, animation frames or React commits | none |
| `roster serve` idle | ≤ 0.5 wake-ups/s; ≤ 3/s with `inventory.watch` | 0.0; 1.9 |
| 12 Sessions × 100 lines/s, all processes | ≤ 60 % of a core; renderer ≤ 35 % | 42.8 %; 22.6 % |
| … frame interval | p95 ≤ 17 ms (one 60 Hz frame) | 4.3 ms (240 Hz display) |
| … keeping up | lines taken = lines printed | 1,196 of 1,200/s |
| … DOM nodes | ≤ 60,000 | 49,317 |
| React renders per key in the Picker | ≤ 10 components | 8 |
| React renders per terminal key or output chunk | 0 | 0 |
| Opening a Session | re-renders the Sessions section, not the Inventory (≤ 200 `Row` renders) | ~135 |
| Memory per Session | ≈ 2 KB per scrollback line at a wide window + ≤ 1 MB replay | see below |
| After closing every Session | JS heap within 2 MB of idle; DOM nodes within 100 of idle | +0 MB (13.8 vs 15.5); +11 |
| App JS, minified | ≤ 2,410 KB raw, ≤ 720 KB gzipped | 2,195 KB; 654 KB (2026-11-01) |
| App CSS, minified | ≤ 85 KB raw, ≤ 15.5 KB gzipped | 75 KB; 13.8 KB; 83.3 KB (2026-11-02) |
| Docs website's `search.js` (every page loads it), minified | ≤ 12 KB raw | 9.8 KB; 3.8 KB gzipped |
| Docs website's `search-index.js` (loaded when the search box is first used) | ≤ 275 KB gzipped | 756 KB raw; 221 KB gzipped; 253 KB gzipped (2026-11-02) |

**Memory per Session.** xterm.js keeps every line at the terminal's full width, so a Session's memory grows with its scrollback, not with what it printed: about 2 KB per line in the measured window, so a full default scrollback of 10,000 lines (`terminal.scrollback`, [config.md](config.md)) is about 20 MB per Session, plus up to 1 MB of output kept to replay into a terminal that attaches again (`tabs.ts`). 12 busy Sessions after ~40 s (about 4,000 lines each) held 144 MB of JS heap; 50 full Sessions would be about 1 GB. `terminal.scrollback = 3000` cuts that by more than two thirds.

### Bundle size

The docs website's search has budgets of its own (the last two rows above): `npm run docs` stops when `search.js` is over its budget, and `app/src/docs-site/site.test.ts` fails when the index is. The index is every page's text, so it grows with the docs; a page loads it only when someone uses the search box. It was raised from 250 KB to 275 KB on 2026-11-02, when the docs of shell hooks and the prompt fill took it past 250 KB: it's text the reader asked to search, loaded once, so it follows the docs rather than trimming them. The CSS raw budget went from 83 KB to 85 KB the same day, when a nested ssh's breadcrumb (ticket 120) took it to 83.3 KB: dev's own build was already a few hundred bytes under it, and 2 KB more leaves room for the next small feature without hiding a stylesheet dependency.

The app's JS and CSS are checked on every pull request: CI builds the frontend (`vite build`) and `scripts/check-bundle-size.py` adds up every `.js` and `.css` file in `app/dist/assets`, minified as shipped and gzipped, and fails when a total is over the budget above. Run it yourself after `npx vite build` in `app/`: `python3 scripts/check-bundle-size.py`. It counts every chunk the build writes, the fake Backend's included; fonts and icons aren't counted (they change only when a font does). A KB is 1,000 bytes, as Vite prints them. The webview reads the files from disk, so the raw size is what it parses; gzipped is there to compare with other projects and catches a dependency that's large but repetitive. The budgets sit about 10 % above the build of 2026-10-31 (JS: of 2026-11-01, when the Plugin API reference and its types, both bundled for `:help`, grew by the typed `mesh.*` and `discover.*` results, ticket 100), so a feature of a few KB passes and a new dependency of a hundred doesn't go unnoticed: a change that goes over raises the budget in the script and in the table above, with the reason in its pull request. Most of the JS is the app itself with the guides `:help` bundles (they're text, so they gzip well), React and xterm.js.

## Left as is, and why

- **The default scrollback (10,000 lines, about 20 MB per full Session).** Lowering it is a product choice (Windows Terminal keeps 9,001); it's documented here and `terminal.scrollback` changes it.
- **One IPC message per PTY read.** Each chunk of output is one `eval` in the webview, plus a fetch when it's 1 KB or more (Tauri's channel). That is most of the busy wake-ups (`roster-app.exe` ~2,900/s, the WebView2 browser process ~3,500/s for 12 Sessions printing every 50 ms). Coalescing reads in the core wouldn't merge bursts 50 ms apart, and its CPU is small (`roster-app.exe` 3.4 %); worth measuring with a flood (`PERF_RATE=5000`) before changing.
- **A hidden busy Session still redraws once per 256 KB** (one redraw instead of one per frame): about 4.5 % of the busy main thread. Raising the limit trades memory for it.
- **A visible terminal with `renderer = "dom"`** still redraws every row on each scroll (the same xterm.js path, but on screen its character widths are cached). An upstream xterm.js issue; the default WebGL renderer isn't affected.
- **WebView2's private bytes after closing every Session** stay above idle (532 vs 362 MB): GPU-process and V8 heap reserves the webview keeps, not the app's objects (the JS heap and DOM are back to idle). Same before and after.
- **Two Windows processes per Session** (`wsl.exe` and its `conhost.exe`, about 20 MB of working set together): how a WSL Session runs under ConPTY (`docs/app/dev/tauri-pty-wsl.md`).
