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
- **In Rust, the same.** A slow `init.lua` waits for a module the test writes (`held_loader` in `tests/config.rs`), not for a loop calibrated to take 600 ms. A test that isn't about the Plugin limits gives the host generous ones (`unhurried()`): the defaults (1 s a load, 250 ms a call) are wall-clock time, and a loaded machine pauses a process for longer than that.
- **In the Python tests, the same.** A notification from serve is waited for (`Live.note()` in `tests/test_live.py`, 20 s only as the ceiling), and what it promises in time (an outside edit seen within a second) is checked from the watcher's own settings, not with a stopwatch. A stand-in Host the test needs mid-step waits for the test to let it go (`DIR/NAME/hold` in `tests/fakes/ssh`), not a `slow` file it hopes is slow enough; `wait_for` in `tests/test_mesh.py` fails with the last answer when its ceiling (100 s, for the Windows runner) runs out. A check that runs after a test's fixtures have ended is a module-scoped fixture's teardown (`tests/test_temp_dirs.py`), never a second test that has to run after the first in the same xdist worker.
- **Prove absence and order with a marker, not a quiet spell (T161).** "Nothing more came in 0.6 s" passes on a machine that hadn't got round to sending it. Hand the test the clock instead: `Looks` in `tests/test_live.py` lets serve's watcher take N looks at `roster.yml` and returns once it's waiting again, so "told once" is checked after looks that would have told it again. A gap between two writes is timed where they're written (the `Tap` writer in session.rs's tests), never where a stand-in reads them late. A Mesh test that needs a step under way waits for the stand-in ssh's `start NAME` line in `DIR/connections` while the Host is held; that the step was cut short, not waited for, is the `end NAME` that never comes. A promise in time (serve exits within the app's `EXIT_GRACE`) is checked from serve's own waits (`DRAIN_WAIT + CLOSE_WAIT`), as the watcher's is. In Rust a call that might never return runs under `within_ceiling` (`tests/plugin.rs`), a stand-in serve is held on a gate (`Held`) rather than given a delay, and a sleep is used only as a lower bound ("held past the Plugin's budget"). Tests that read a manifest use `common::read_manifest`, with a minute to read it, not the default second.
- **A performance budget is a test of its own, run on request on an idle machine.** It times the machine as much as the code, so it fails under load however fast the code is. What the code does stays in an ordinary test that always runs; the budget is `budget(…)` (`src/test-budget.ts`), run with `ROSTER_PERF=1 npm test` in `app/`, or `#[ignore]` in Rust, run with `cargo test -p roster-core -- --ignored` (the Topology and Mesh Plugins'). Run them before and after a change to the graph's drawing or layout, the Picker's search, the table's updates, or the Topology or Mesh Plugin.
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

## End to end: copy and paste (headless Chromium)

`app/e2e/` (T158, #294) runs roster's real `TerminalView` (xterm.js, `terminal/input.ts`, `terminal/clipboard.ts`) in headless Chromium, with real key and mouse events and the browser's own paste. `npm run e2e` in `app/` (CI's App frontend job runs it after `npm run check`, which needs no browser).

```text
app/e2e/
  vitest.config.ts     Vitest in Node; one file at a time
  server.ts            globalSetup: Vite (the app's vite.config.ts) on a free port, the URL by inject("url")
  index.html, harness.tsx  the page: TerminalView with a fake Session (records every byte sent) and a
                       clipboard the test sets and reads; `window.e2e`
  browser.ts           playwright-core: the browser, the page, typed calls into window.e2e, drag, right-click,
                       raw DevTools key events (Ctrl+м, AltGr)
  copy-paste.e2e.ts    every path in #294
```

- **The browser** is the Chromium headless shell that `playwright-core` (pinned in `package-lock.json`) names: `npx playwright-core install --only-shell chromium` once (CI adds `--with-deps`). `$CHROME` picks another binary.
- **It looks like Windows.** The page's `navigator.platform` and user agent are WebView2's, so xterm.js runs its Windows handling (AltGr as Ctrl+Alt); one group opens a Linux page for the off-Windows keys (decision Q138).
- **Deterministic (T146's rules).** Every wait is for an event: a chunk sent to the Session (`sentCount`), a clipboard write (`copiedCount`), xterm having parsed output (`output` resolves in its write callback). "Nothing else was sent" is checked after `settled()` (a 0 ms timer: every event, microtask and the paste the key fired have run). The one timer in the code a test must get past, copy-on-select's 120 ms, runs on Playwright's page clock (`page.clock.runFor`).
- **Secrets.** Each test's clipboard texts are checked against every console line of the page; the password test also checks the screen, the DOM and storage.
- **Skipped tests** name the issue they wait for (`#293`: OSC 52 writes, right-click under mouse reporting) or the question they ask; remove `skip` when it lands.
- **What it can't show:** WebView2, ConPTY, keys another program injects (SendInput) and real programs: [copy-paste-checklist.md](copy-paste-checklist.md), by hand on the Windows build.

## Commands for the README

`npx tsc --noEmit` · `npx eslint .` · `npx vitest run` · `npm run e2e` · `cargo test` (WSL: core only)
