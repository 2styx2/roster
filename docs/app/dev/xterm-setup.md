# xterm.js setup for the roster app (checked 2026-10-29)

## Packages (npm, current)

| Package | Version | Note |
|---|---|---|
| `@xterm/xterm` | 6.0.0 | `import "@xterm/xterm/css/xterm.css"` |
| `@xterm/addon-webgl` | 0.19.0 | `new WebglAddon(preserveDrawingBuffer?)`, `onContextLoss` |
| `@xterm/addon-fit` | 0.11.0 | |
| `@xterm/addon-search` | 0.16.0 | |
| `@xterm/addon-clipboard` | 0.2.0 | OSC 52 only (remote apps setting the clipboard) |
| `@xterm/addon-unicode11`, `@xterm/addon-web-links` | 0.9.0, 0.12.0 | optional |
| ~~`@xterm/addon-canvas`~~ | 0.7.0 (2024), peer `^5` | **removed in 6.0** |

Old unscoped `xterm` / `xterm-addon-*` names are dead. Use `@xterm/*`. The addons ship ESM (`lib/*.mjs`), so Vite is fine with them.

## The "canvas fallback" in ticket 05 doesn't exist any more

The xterm 6.0.0 release notes (#5105) say the canvas addon "no longer exists and we recommend using either the DOM renderer or WebGL". The fallback is now **the built-in DOM renderer**, which is what you get when no renderer addon is loaded. Update ticket 05 and ADR 0003's wording when the scaffold lands.

```ts
const term = new Terminal({
  allowProposedApi: true,              // needed by unicode11 / search decorations
  scrollback: 10000,
  windowsPty: isWindows ? { backend: "conpty", buildNumber } : undefined, // this box: 26200 (>=21376 keeps reflow)
  macOptionIsMeta: true,
});
term.open(el);                         // el must be visible and have a size
const fit = new FitAddon(); term.loadAddon(fit); fit.fit();
let renderer: "webgl" | "dom" = "dom";
try {
  const webgl = new WebglAddon();
  webgl.onContextLoss(() => { webgl.dispose(); /* now on DOM renderer */ });
  term.loadAddon(webgl); renderer = "webgl";
} catch { /* no WebGL2: stay on DOM */ }
new ResizeObserver(() => fit.fit()).observe(el);   // then send term.cols/rows to session_resize (debounce ~50ms)
term.onResize(({ cols, rows }) => resizeSession(id, cols, rows));
```
Load WebGL **after** `open()`. `:info` names the renderer in use, and why it isn't WebGL (`app/src/terminal/renderer.ts`, ticket 20; [linux.md](linux.md)). Set `windowsPty` whenever the PTY is ConPTY, including the WSL backend, because ConPTY sits in the middle. The build number comes from Rust: `roster_core::platform::windows_build()` (`RtlGetVersion`) through the `platform_info` command, 10.0.**26200** here (ticket 08).

## Keys: everything goes to the shell except the leader

`attachCustomKeyEventHandler(ev => boolean)` runs before xterm processes a key, for keydown, keypress **and** keyup. `false` means xterm ignores the event and does **not** call preventDefault, so the browser's default still runs. `true` means xterm handles it: it sends the byte and cancels the event. Esc (`\x1b`) and Ctrl+W (`\x17`) are sent by xterm by default, so leave them as `true`. **Ctrl+Space would otherwise send NUL (`\x00`)**, so catch it on every event type:

```ts
term.attachCustomKeyEventHandler((ev) => {
  const isLeader = ev.ctrlKey && !ev.altKey && !ev.metaKey && ev.code === "Space";
  if (isLeader) {
    ev.preventDefault();
    if (ev.type === "keydown" && !ev.repeat) keymap.enterLeader();   // app mode
    return false;
  }
  if (ev.type === "keydown" && ev.ctrlKey && ev.shiftKey && (ev.code === "KeyC" || ev.code === "KeyV")) {
    ev.preventDefault();                       // copy selection / paste via term.paste(text)
    void (ev.code === "KeyC" ? copySelection() : pasteFromClipboard());
    return false;
  }
  return true;
});
```
- Match on `ev.code`, not `ev.key`. `key` for Ctrl+Space varies with keyboard layout and IME.
- While in leader/app mode, call `term.blur()` or give a hidden element focus so the next key (`f`) doesn't reach the PTY. Put focus back with `term.focus()` on Esc.
- **WebView2 browser accelerators** (Ctrl+F, Ctrl+P, Ctrl+R/F5, Ctrl+±, F12/Ctrl+Shift+C, Back/Forward) are on by default. wry 0.57 has `with_browser_accelerator_keys(false)`, but **tauri 2.12.5 doesn't expose it** (grepped tauri, tauri-runtime-wry and tauri-utils). Turn it off in `setup` through `webview.with_webview(|w| …controller().CoreWebView2()?.Settings()?.cast::<ICoreWebView2Settings3>()?.SetAreBrowserAcceleratorKeysEnabled(false))` (needs the `webview2-com` / `windows` crates). That leaves Ctrl+C/V/X/A/Z, which xterm already sends to the PTY because it preventDefaults them. Checked with real keys in ticket 08 (SendKeys after a real click into the window; CDP's `Input.dispatchKeyEvent` skips the browser's accelerator handling, so it proves nothing here): Ctrl+R reaches bash, F5 doesn't reload, Ctrl+F opens no find bar, Ctrl+Shift+C opens no devtools, and Ctrl+= reaches the app's zoom. Page zoom is off by default in tauri (`zoomHotkeysEnabled: false` → WebView2's `IsZoomControlEnabled`).

## Clipboard in WebView2 (tauri 2.12.5 source)

- `navigator.clipboard.writeText` works in a focused secure context. `tauri://` and `http://tauri.localhost` both count.
- **`readText` needs permission.** wry auto-allows `CLIPBOARD_READ` only when the webview was built with `clipboard: true`, and that defaults to **false**. There's no `tauri.conf.json` key for it in v2. Either create the main window in Rust with `WebviewWindowBuilder::new(..).enable_clipboard_access()`, or use `tauri-plugin-clipboard-manager` 2.5.0 (`@tauri-apps/plugin-clipboard-manager` 2.5.0, which needs `clipboard-manager:allow-read-text` and `allow-write-text` in capabilities). Use the plugin: it behaves the same on WebKitGTK too.
- For paste, use `term.paste(text)`. It applies bracketed-paste mode.
- Ctrl+V on Windows (`terminal.pasteIfText`, decision Q138, `app/src/terminal/input.ts`): the key handler returns `false` for the keydown **without** `preventDefault`, so xterm sends no ^V and the WebView runs its own paste: a `paste` event on xterm's textarea, at once (before the keyup and a 0 ms timer, checked in headless Chromium), with the clipboard as it is at the key. A capture listener on the container lets a paste with `text/plain` through to xterm's own paste listener (`preventDefault` only, so the text isn't also inserted into the textarea) and turns one with no text that follows the key into `\x16`. No paste event by the next turn: `\x16`. Never `readText` here: an async read could hang, lose order, or paste a clipboard a tool already put back. A repeat keydown is prevented. Chords on letters also match by `code` (Ctrl+м is Ctrl+V).
- Select-to-copy is the `term.onSelectionChange` handler plus `term.getSelection()`. Right-click to paste is a `contextmenu` listener on the container that calls `preventDefault`. xterm 6 has no copy-on-select option, so write it yourself.

## Search

`const search = new SearchAddon(); term.loadAddon(search); search.findNext(q, { incremental: true, decorations: {...} })`. `decorations` needs `allowProposedApi: true`. `incremental` only affects `findNext`. The roster app searches upwards (`findPrevious`), as Windows Terminal does, and clears the selection on each keystroke, so typing always shows the newest match (`@xterm/addon-search` 0.16.0, ticket 08).
