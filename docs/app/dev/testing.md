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
- **A performance budget is a test of its own, run on request on an idle machine.** It times the machine as much as the code, so it fails under load however fast the code is. What the code does stays in an ordinary test that always runs; the budget is `budget(…)` (`src/test-budget.ts`), run with `ROSTER_PERF=1 npm test` in `app/`, or `#[ignore]` in Rust, run with `cargo test -p roster-core --test plugin_topology -- --ignored`. Run them before and after a change to the graph's drawing or layout, the Picker's search, or the Topology Plugin.

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

## Commands for the README

`npx tsc --noEmit` · `npx eslint .` · `npx vitest run` · `cargo test` (WSL: core only) · `npx playwright test`
