# Testing layout (verified in WSL 2026-10-29)

## Rust: logic in a crate with no tauri dependency

```text
roster/                      # the repo root is the Cargo workspace
  Cargo.toml                 # [workspace] resolver="3", members=["app/src-tauri","crates/roster-core"],
                             #   default-members=["crates/roster-core"]
  Cargo.lock                 # committed (it syncs to the Windows build copy)
  crates/roster-core/        # NO tauri: backend runner (JSON-RPC client), session manager, keymap-free logic
    src/{lib,rpc,backend,session,wsl}.rs
    tests/pty.rs             # integration tests with stub commands
  app/src-tauri/             # thin: #[tauri::command] wrappers, Channel plumbing, window setup
```

Verified: with `default-members` set to the core crate, a plain `cargo test` in WSL builds and tests only `roster-core`, including a real `portable-pty` round trip: `sh -c 'read l; stty size; echo got:$l; exit 3'`, resize to 40×120, exit code 3. That took 10 s cold. `cargo check -p <tauri crate>` in WSL **fails**: webkit2gtk is missing and a build script panics. So agents in WSL run `cargo test` (or `-p roster-core`), and never `--workspace`. GitHub Actions installs the WebKitGTK and D-Bus dev packages on its Ubuntu runner, so CI also runs clippy on the Tauri crate (`.github/workflows/ci.yml`). On Windows, `tauri build` with this workspace layout works (59 s debug cold). Output goes to the **workspace** `target/`, not `app/src-tauri/target/`.

Design the seams so the core is testable:
- `trait Transport { spawn(argv, env) -> (stdin, stdout lines) }`. The real one runs `wsl.exe --exec …`; the test one runs `python3 tests/fake_serve.py` or an in-memory pair. The JSON-RPC client is tested against a fake that answers `inventory.info` with an old version, an error object, out-of-order ids, and the child exiting mid-call.
- Build the PTY command from a pure function: `fn session_argv(backend, prepared) -> Vec<String>`. Unit-test the `wsl.exe --exec ssh …` shape, with the env on the process and named in `WSLENV`, never in the argv. That's where the wsl.exe quoting bugs live (see tauri-pty-wsl.md).
- The session manager emits output through a `Fn(Vec<u8>)` sink, not a Tauri Channel. app/src-tauri adapts it to `InvokeResponseBody::Raw`.
- PTY tests: on Linux use `sh`. If they ever run on Windows, answer ConPTY's `ESC[6n` with `\x1b[1;1R` first, or the child never starts. Gate them with `#[cfg(unix)]` for now.

## Frontend unit tests: Vitest + Testing Library + jsdom

Verified versions: vitest 5.0.5, jsdom 30.1.3, @testing-library/react 16.3.3, @testing-library/user-event 14.6.8, @testing-library/jest-dom 7.0.1, react 19.3.1, @vitejs/plugin-react 6.1.2. (create-tauri-app pins typescript ~6.0.3. TS 7.0.2 is out; pick one deliberately and record it in an ADR.)

```ts
// vitest.config.ts (or a test block in vite.config.ts)
export default defineConfig({ plugins: [react()],
  test: { environment: "jsdom", setupFiles: ["./src/test-setup.ts"] } });
// app/src/test-setup.ts
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react"; import { afterEach } from "vitest";
afterEach(() => cleanup());
window.matchMedia ??= ((q: string) => ({ matches: false, media: q, onchange: null, addListener() {},
  removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
```
- Verified: a picker test (type to filter, then Esc closes) passes with `userEvent.type` / `userEvent.keyboard("{Escape}")`.
- **xterm in jsdom:** without the `matchMedia` stub, `term.open()` throws `this._parentWindow.matchMedia is not a function`. With it, open, write and dispose work (DOM renderer, so never load WebglAddon in tests). Even so, keep the terminal behind a `TerminalView` component, and in picker and tab tests substitute a stub.

### Tests that pass on a busy machine too (T146)

The checks run beside other work (a full `npm run check` next to `cargo test`, CI runners shared with other jobs), so a test never depends on how fast the machine is:

- **Wait for what you expect, not for a while.** `findBy*`, `waitFor` and `expect.poll` return as soon as it's there; their ceiling (`asyncUtilTimeout`, 10 s, in `src/test-setup.ts`) and a test's (30 s, `testTimeout` in `vite.config.ts`) are only how long a broken test takes to say so. A fake that takes time (a pull, a Session's open) is held until the test lets it go (`ready(…, { held: true })` and `release()` in `App.pull.test.tsx`), or the test lets the fake's 0 ms steps run out (`settle` in `session/tabs.test.ts`), rather than sleeping a few milliseconds and hoping.
- **In Rust, the same.** A slow `init.lua` waits for a module the test writes (`held_loader` in `tests/config.rs`), not for a loop calibrated to take 600 ms. A test that isn't about the Plugin limits gives the host generous ones (`common::unhurried()`): the defaults (1 s a load, 250 ms a call) are wall-clock time, and a loaded machine pauses a process for longer than that. A test that is about one limit gives the others generously, so it meets the one it's about (T165: the Plugin that allocates ran out of time before memory; T167: init.lua's memory and size tests, which get `unhurried()` in `tests/config.rs`, a minute of Lua and wall-clock time). A test that watches the config dir takes its watcher through `watch_alone` (`tests/config.rs`), one at a time in the binary: each is an inotify instance, 128 a user on Linux, and many test binaries at once with four watchers each ran out (T167).
- **In the Python tests, the same.** A notification from serve is waited for (`Live.note()` in `tests/test_live.py`, 20 s only as the ceiling), and what it promises in time (an outside edit seen within a second) is checked from the watcher's own settings, not with a stopwatch. A stand-in Host the test needs mid-step waits for the test to let it go (`DIR/NAME/hold` in `tests/fakes/ssh`), not a `slow` file it hopes is slow enough; `wait_for` in `tests/test_mesh.py` fails with the last answer when its ceiling (100 s, for the Windows runner) runs out. A check that runs after a test's fixtures have ended is a module-scoped fixture's teardown (`tests/test_temp_dirs.py`), never a second test that has to run after the first in the same xdist worker.
- **Prove absence and order with a marker, not a quiet spell (T161).** "Nothing more came in 0.6 s" passes on a machine that hadn't got round to sending it. Hand the test the clock instead: `Looks` in `tests/test_live.py` lets serve's watcher take N looks at `roster.yml` and returns once it's waiting again, so "told once" is checked after looks that would have told it again. A gap between two writes is timed where they're written (the `Tap` writer in session.rs's tests), never where a stand-in reads them late. A Mesh test that needs a step under way waits for the stand-in ssh's `start NAME` line in `DIR/connections` while the Host is held; that the step was cut short, not waited for, is the `end NAME` that never comes. A promise in time (serve exits within the app's `EXIT_GRACE`) is checked from serve's own waits (`DRAIN_WAIT + CLOSE_WAIT`), as the watcher's is. In Rust a call that might never return runs under `within_ceiling` (`tests/plugin.rs`), a stand-in serve is held on a gate (`Held`) rather than given a delay, and a sleep is used only as a lower bound ("held past the Plugin's budget"). Tests that read a manifest use `common::read_manifest`, with a minute to read it, not the default second. A PTY stand-in (`tests/pty_fill.rs`, T164) is waited for, never slept on: `shown` returns once the output ends with what the stand-in prints last (the core's screen takes in each chunk before the sink gets it, so the fill sees all of it), `report` once its own `got:[…]` line is in, output a test wants mid-fill waits on the test's go (`Sig`, `$SIG/go`), and a key or resize meant for the probe goes once the stand-in says it has read the probe's first key (`$SIG/read`). A stand-in that records what it read stops at a key the test sends after the fill (`DONE`), not after its input has been quiet a while. Their ceilings (`CEILING`) are a minute, and the fill's own wait in these tests is generous (2 s), since a stand-in echoes from `sh`. A test that needs to know a reload has begun gives it an init.lua that's a named pipe (`reading_the_config_never_waits_for_a_reload_in_progress` in `tests/config.rs`, T165): the reload's read opens it only once the test opens the other end, so the test needs no hook in `Loader` and no sleep. A Plugin whose behaviour depends on `os.time()` (recent-alerts' quiet spell) runs on a clock the test holds, patched into the test's copy of the Plugin, never on a sleep through the spell. That a call answers while serve is held is the answer coming at all, under `common::within_ceiling`, not a stopwatch. That a stream of saves still reloads is the reload coming while the test's writer keeps writing (it stops only once the reload is in), not a stopwatch; how soon is an `#[ignore]` budget. A Plugin test that waits for its requests' answers (`settle` in `tests/plugin_topology.rs`, `settled` in `tests/plugin_discover.rs`) waits for `PluginHost::requests` to reach 0, then takes the replies already in: the host hands an answer's reply to the listener before the answer stops counting, so there's no quiet spell to wait out. The Config watcher's "one save, one call" and "this is ignored" run on a clock the test holds (`HeldWatcher` in `tests/config.rs`, over `config::watch_held` in the `test-hooks` feature, T184): a save's quiet never runs out by itself, and the calls are counted once the watcher has seen a marker file written after the save (inotify keeps one queue, in order) and the clock has been moved past a save's longest wait. An answer a stand-in serve must give late waits on a gate the test opens once the other answer has run (`held_check` in `tests/plugin_topology.rs`), never on a sleep. What a library does on its own schedule isn't the core's to promise: hyper can open a second connection for the hop after a redirect while the one whose body was read is still on its way back to its pool, so `a_redirect_on_the_same_site_reuses_its_connection` (`tests/network.rs`) asks again until a request comes on the redirect's connection instead of counting connections. A test server knows a connection by what it carried, not by when it was accepted: on a busy machine another test's client can reach a port the OS has handed out again.
- **A performance budget is a test of its own, run on request on an idle machine.** It times the machine as much as the code, so it fails under load however fast the code is. What the code does stays in an ordinary test that always runs; the budget is `budget(…)` (`src/test-budget.ts`), run with `ROSTER_PERF=1 npm test` in `app/`, or `#[ignore]` in Rust, run with `cargo test -p roster-core -- --ignored` (the Topology and Mesh Plugins', init.lua's big loads in `tests/config_api.rs`, whose results an ordinary test checks with limits no loaded machine runs into, and the reload under a stream of saves in `tests/config.rs`). Run them before and after a change to the graph's drawing or layout, the Picker's search, the table's updates, the Topology or Mesh Plugin, or init.lua's loader (`roster.o` and the collections).
- **CI runs the budgets once a week** (`.github/workflows/perf.yml`, Mondays, and by hand from the Actions tab), never on a pull request, so they gate nothing. A red run there means: time it again on an idle machine, before and after the change it points at.

### The fake backend (the seam from ticket 03)

```ts
export interface Backend {            // app/src/backend/types.ts: the ONE typed client
  info(): Promise<InventoryInfo>; listHosts(): Promise<HostList>;
  vaultStatus(): Promise<VaultStatus>; /* … */ openSession(host: string, onOutput: (b: Uint8Array) => void): Promise<SessionHandle>;
}
// app/src/backend/tauri.ts uses invoke/Channel; app/src/backend/fake.ts uses fixtures (hundreds of hosts, unreviewed ones, error modes)
export const backend: Backend = isTauri() ? tauriBackend() : fakeBackend(fixtureFromUrl());
```
- `isTauri()` from `@tauri-apps/api/core` (2.12.4) checks `globalThis.isTauri`. Only lazy-import the tauri backend module when it's true.
- Tests render `<App backend={fakeBackend(fixtures)}/>` (inject through props or context; no module mocking). `@tauri-apps/api/mocks` `mockIPC` exists if you want to test `tauri.ts` itself.
- The fake's `openSession` can echo input and emit scripted bytes, which is enough for tab and keyboard tests.

## Plain browser + Playwright screenshots

- `npm run dev` (Vite) in WSL serves the app. With no Tauri globals, `isTauri()` is false, so the fake backend loads. Choose a scenario with a query param (`?fixture=many-hosts`, `?fixture=locked`, `?fixture=roster-too-old`).
- Verified: the create-tauri-app React frontend served by `vite` in WSL loads in Playwright's Chromium (Chromium 1248 is already in `~/.cache/ms-playwright`). Use a fixed port. Keep 1420 for `tauri dev` (strictPort) on Windows and use, say, 5179 for browser runs, so they never collide.
- `@playwright/test` 1.64.1: `webServer: { command: "npm run dev -- --port 5179 --strictPort", url: "http://localhost:5179" }` and `await expect(page).toHaveScreenshot()`. WebGL in headless Chromium wasn't tested. Force the DOM renderer for stable pixel diffs (`?renderer=dom`).
- These screenshots are Chromium, not WebView2 or WebKitGTK. Real-window checks still go through the Windows build loop (windows-build-loop.md).

## End to end (headless Chromium)

`app/e2e/` runs copy and paste (T158, #294), a Host row's menu (T173, below) and dragging in a graph (T179, below). For copy and paste it runs roster's real `TerminalView` (xterm.js, `terminal/input.ts`, `terminal/clipboard.ts`) in headless Chromium, with real key and mouse events and the browser's own paste. `npm run e2e` in `app/` (CI's App frontend job runs it after `npm run check`, which needs no browser).

```text
app/e2e/
  vitest.config.ts     Vitest in Node; one file at a time
  server.ts            globalSetup: Vite (the app's vite.config.ts) on a free port, the URL by inject("url")
  index.html, harness.tsx  the page: TerminalView with a fake Session (records every byte sent) and a
                       clipboard the test sets and reads; `window.e2e`
  browser.ts           playwright-core: the browser, the page, typed calls into window.e2e, drag, right-click,
                       raw DevTools key events (Ctrl+м, AltGr)
  copy-paste.e2e.ts    every path in #294
  host-menu.e2e.ts     a Host row's menu in the whole app (index.html, `?fixture=many-hosts`, T173)
  graph-drag.e2e.ts    dragging a node and a collapsed cluster in a graph (`?fixture=plugin-graph`, T179)
```

- **The Host row menu** (`host-menu.e2e.ts`, T173, #324) opens the whole app (`inject("appUrl")`) on the fake Backend at a narrow (420×520) and a wide (1600×1000) window. On a Host row scrolled to the Sidebar's top and one at its bottom, it right-clicks the row's left and right ends and presses the Menu key and Shift+F10 on the App-mode cursor. Each time the menu must be inside the window with all four corners its own pixels (nothing cut off or on top of it), next to its row (at the pointer, or under the row; above it at the bottom), and focused (the menu from the pointer, its first item from a key). It waits for the opening transition to finish before it measures.

- **Dragging in a graph** (`graph-drag.e2e.ts`, T179, #341) opens the whole app on `?fixture=plugin-graph` (640 Hosts in 16 collapsed clusters) and drags with real pointer events on the real canvas, which jsdom can't (it has no canvas, so the camera is never set). It reads what's drawn from the canvas's own calls (an init script records each frame's circles and text: a collapsed cluster is a circle of `STAND_IN_RADIUS` with its title under it, the selection ring is a frame's last circle). A collapsed cluster, and then a node in an opened one, is panned near the right edge and dragged: the press mustn't move the view (#341: it recentred it), the dropped one must be under the pointer, a cluster dropped on a neighbour must push it aside and nothing else, and after closing and opening the view again both must be drawn where they were left (relative to clusters that didn't move, as the camera is fitted afresh; a fixture's State is never saved, so it's the app's State that keeps them). A click with no drag must still bring what it selected in from the edge.

- **The browser** is the Chromium headless shell that `playwright-core` (pinned in `package-lock.json`) names: `npx playwright-core install --only-shell chromium` once (CI adds `--with-deps`). `$CHROME` picks another binary.
- **It looks like Windows.** The page's `navigator.platform` and user agent are WebView2's, so xterm.js runs its Windows handling (AltGr as Ctrl+Alt); one group opens a Linux page for the off-Windows keys (decision Q138).
- **Deterministic (T146's rules).** Every wait is for an event: a chunk sent to the Session (`sentCount`), a clipboard write (`copiedCount`), xterm having parsed output (`output` resolves in its write callback). "Nothing else was sent" is checked after `settled()` (a 0 ms timer: every event, microtask and the paste the key fired have run). The one timer in the code a test must get past, copy-on-select's 120 ms, runs on Playwright's page clock (`page.clock.runFor`).
- **Secrets.** Each test's clipboard texts are checked against every console line of the page; the password test also checks the screen, the DOM and storage.
- **Skipped tests** name the issue they wait for (`#293`: OSC 52 writes, right-click under mouse reporting) or the question they ask; remove `skip` when it lands.
- **What it can't show:** WebView2, ConPTY, keys another program injects (SendInput) and real programs: [copy-paste-checklist.md](copy-paste-checklist.md), by hand on the Windows build.

## Commands for the README

`npx tsc --noEmit` · `npx eslint .` · `npx vitest run` · `npm run e2e` · `cargo test` (WSL: core only)
