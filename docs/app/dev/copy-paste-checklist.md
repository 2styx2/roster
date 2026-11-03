# Copy and paste: the hand-test checklist (Windows build)

Copy and paste in a Session is tested end to end in headless Chromium on every pull request (`app/e2e/copy-paste.e2e.ts`, `npm run e2e`; see [testing.md](testing.md#end-to-end-copy-and-paste-headless-chromium)). That run is the real xterm.js and roster's terminal code, with real key and mouse events and the browser's own paste, but not WebView2, not ConPTY, not keys injected by another program and not a real remote program. This list is what only the Windows build can show. Run it after a change to `app/src/terminal/` and before a Release.

Set up: the Windows build (`app/scripts/app-build.sh --run`, [windows-build-loop.md](windows-build-loop.md)), a Session on a test Host (`esx-02` or any made-up lab box) with bash, and one on WSL. Notepad for copying text in and out. Use made-up text only; for the password step, a throwaway account on the test Host.

Tick each box; write down anything that differs with the build number and what you saw.

## Paste

- [ ] **Ctrl+V** at a bash prompt with text copied in Notepad: pastes once, never twice, never `^V`.
- [ ] **Ctrl+V, several lines** (three `echo` lines copied from Notepad, so CRLF line ends): they land in the prompt without running (bracketed paste), each on its own line, no blank lines between them. Enter runs all three.
- [ ] **Ctrl+V with an image only** (Win+Shift+S, then Ctrl+V in vim's insert mode or at a prompt): the program gets `^V` (vim inserts the next key literally; bash shows `^V` with `quoted-insert`). Nothing is pasted.
- [ ] **Ctrl+V with an empty clipboard** (clear it from Win+V, "Clear all"): `^V`, as above.
- [ ] **Voice typing that pastes with Ctrl+V** (a dictation tool such as Wispr Flow): dictate a sentence at a bash prompt. It appears once, never twice and never as `^V`. Dictate again right after copying something else in Notepad: the dictation is pasted, not the Notepad text, and the Notepad text is still on the clipboard afterwards (Win+V).
- [ ] **Ctrl+V held down**: pastes once.
- [ ] **Ctrl+Shift+V** and **Shift+Insert**: paste once each.
- [ ] **Right-click with no selection**: pastes. With `roster.o.terminal.right_click_paste = false` and `:source`, right-click does nothing.
- [ ] **A Russian layout** (Win+Space): Ctrl+V (the key labelled м) pastes; Ctrl+C (с) copies a selection.
- [ ] **AltGr** on a Polish layout: AltGr+A types `ą`, AltGr+C types `ć`; neither copies nor pastes.
- [ ] **A large paste**: open a 200 KB text file in Notepad, Ctrl+A, Ctrl+C, then in the Session run `cat > /tmp/big.txt`, Ctrl+V, Enter, Ctrl+D. `wc -c /tmp/big.txt` matches the file (give or take its line ends), and the app stays responsive while it goes.
- [ ] **Unicode** pasted into `cat > /tmp/u.txt` then `cat /tmp/u.txt`: `日本語 中文 한국어`, `é ñ ǟ` (combining marks), `👍🏽 👨‍👩‍👧 🇳🇿`, `שלום مرحبا`. Each comes back as it went in.
- [ ] **Tabs** pasted at a bash prompt (`a<Tab>b` copied from Notepad): bash may complete on the tab, as in Windows Terminal; nothing else is added or lost.

## Copy

- [ ] **Drag to select** (`copy_on_select` on, the default): the text is on the clipboard (paste it in Notepad).
- [ ] With `roster.o.terminal.copy_on_select = false`: selecting doesn't change the clipboard; **Ctrl+C** with a selection copies it and clears the highlight; **Ctrl+C** again (no selection) interrupts `sleep 100`.
- [ ] **Ctrl+C with no selection** interrupts a running `sleep 100`, and the clipboard is unchanged.
- [ ] **Ctrl+Shift+C** and **Ctrl+Insert** copy the selection and leave it highlighted.
- [ ] **Right-click with a selection** copies it and clears it; nothing is pasted.
- [ ] **A wrapped line**: `printf 'x%.0s' {1..300}; echo`, then select the whole wrapped line. Pasted in Notepad it's one line of 300 `x`, with no line break where it wrapped.
- [ ] **Full-width text**: `echo 日本語x`, select it; Notepad gets `日本語x` with no spaces in it.
- [ ] **Trailing blanks**: `printf 'one\ntwo\n'`, select both lines and past the end; Notepad gets `one`, `two` without padding. Spaces a program printed at a line's end are trimmed too, as in Windows Terminal (`printf 'one   \ntwo\n'` copies `one`, `two`).
- [ ] **Unicode out**: `echo '👍🏽 é שלום'`, select and copy; Notepad shows the same.

## Programs

- [ ] **A full-screen program with mouse reporting** (vim with `:set mouse=a`, htop, tmux with `set -g mouse on`, Claude Code): a drag goes to the program (vim moves its visual selection, tmux selects in its own copy mode). **Shift+drag** makes roster's own selection; Ctrl+C or right-click then copies it.
- [ ] **The same program, right-click with no selection**: it goes to the program, as in Windows Terminal, and nothing is pasted; **Shift+right-click** pastes (#293).
- [ ] **OSC 52 from a program** (T157, #293): in tmux with `set -g set-clipboard on`, copy in copy mode; in Claude Code, a plain drag (no Shift) copies when you let go. The text lands on the Windows clipboard. A program asking to read the clipboard (`printf '\e]52;c;?\a'`) gets no answer: nothing appears at the prompt.
- [ ] **The alternate screen** (vim, less): paste in vim's insert mode goes in as one paste (no auto-indent staircase with `:set paste` off, since vim asks for bracketed paste); Shift+drag and Ctrl+C copy from the screen.
- [ ] **A password prompt** (`sudo -k; sudo true` on the test Host, with a throwaway password copied in Notepad): Ctrl+V then Enter signs in. The password isn't on screen, and isn't in `:messages` or the State file. Then copy something else, so the password isn't left on the clipboard.

## ConPTY and WSL

- [ ] All of **Paste** above in a WSL Session (ConPTY sits between): multi-line paste still lands without running, CRLF from Notepad still gives one line end per line.
- [ ] A paste right after the Session opens (before the prompt is drawn) isn't lost or doubled.
