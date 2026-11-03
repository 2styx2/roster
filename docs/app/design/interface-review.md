# Interface review (ticket 29)

> **Screenshots.** The `review/` screenshots this review names (before, `after/` and `windows/`) were not carried over when the app joined the roster repo. Each browser one can be reproduced from the fake Backend: its file name gives the screen, the fixture and the Theme (`app/README.md`, "UI in a plain browser"). Current Theme screenshots are in [themes.md](../themes.md#screenshots).

Run of `interfaces:better-interface` over the whole app on `dev` at `4435601` (after 09, 21, 22, 26, 27, 30, 31).
**The user picked all 26 items, and all are fixed** (decision Q53; how each was fixed is under [Fixes](#fixes) at the
end). The **Pick** column records the choice on each flagged item.

## Scope and coverage

- **Scope:** every screen in a plain browser (Vite dev server, fake Backend, `?fixture=…&theme=…&toggle=off`), in
  Roster dark and Roster light, with Gruvbox, Nord, Catppuccin Mocha and Tokyo Night spot-checked. Screens: the lock
  screen (unlock, wrong password, not logged in, missing CLI, worst-case message) and the whole sign-in flow
  (server choice, self-hosted, email, master password, wrong password, two-step method picker, code, wrong code,
  new-device code, SSO wait, rate limit); Standard (Sidebar Sessions/Folders/Inventory, terminal, status bar, title bar,
  App mode cursor); the Picker (results, query, no match, empty Inventory); the command line with completions; the Key
  bindings panel (filter, no match, Plugin bindings); the `:theme` finder with live preview; the Session error panel and
  `:check`; the start-error screens; Focus (mode hint, Sessions finder, Picker and Key bindings over the terminal);
  `worst-case`, `worst-case-empty`, `worst-case-one`, `worst-case-start`, `worst-case-vault`; widths 800, 640 (= 1280 at
  200 % zoom) and 320 px.
- **Stack:** React 19 + TypeScript, plain CSS in `app/src/styles.css` (+ `app/src/lock/signin.css`) written only against
  Theme tokens (`app/src/theme/themes.ts` → CSS variables), xterm.js for terminals, Inter + Iosevka bundled. Tauri shell;
  the window's minimum size is 480 × 320 (`app/src-tauri/tauri.conf.json:20`).
- **Project conventions read:** `docs/app/decisions.md` Q26–Q52 (Linear-like, neutral near-black, jade, Inter + Iosevka 500,
  raised selection, keyboard-first, everything Config-overridable), `GLOSSARY.md`, `README.md` Development,
  `docs/app/design/` (09), `docs/app/design/break-ui/` (27), `docs/app/design/themes/` (30), `app/src/theme/contrast.test.ts`.
  No separate design-system or writing style guide exists; the decisions log plays that role.
- **Boundary:** Not reviewed live: the tab-strip layout (`sessions = "tabs"`), the right-hand Sidebar, the Focus
  session bar (both need an `init.lua`, which a plain browser can't load: reviewed from source and the 22 Windows
  screenshots only), the Config error toast, and the real Windows WebView2 rendering.

| Domain | Evidence inspected | Result |
| --- | --- | --- |
| Accessibility | ARIA snapshots of every screen (Playwright `ariaSnapshot`), keyboard walk (Tab/Shift+Tab, Leader keys, Esc), `Sidebar.tsx`, `Keys.tsx`, `CheckPanel.tsx`, `SignIn.tsx`, `LockScreen.tsx`, `Picker.tsx`, `Finder.tsx`, reduced-motion rules in `styles.css` | 7 findings |
| Layout | Screenshots at 1280, 800, 640, 320 px; `styles.css` Standard/side-panel/Focus rules; worst-case fixtures | 4 findings |
| Writing | Every visible string on the screens above; `sections.ts`, `Picker.tsx`, `SignIn.tsx`, `LockScreen.tsx`, `ErrorScreen.tsx`, `catalog.ts` rows as rendered; `GLOSSARY.md` terms | 5 findings |
| Typography | Type scale tokens, keycaps, badges, code spans in errors, wrapping in the worst case | 2 findings |
| Colour | WCAG ratios for every text token on every surface of all six Themes (script over `themes.ts`), rendered screenshots | 4 findings |
| UI polish | Surfaces, selection, press/hover rules, motion (`--dur-*`, `@starting-style`, `mode-hint` keyframes), finders | 4 findings |

## How to read this

- **Severity** is the skill's scale: **Must fix** = `HIGH` (blocks a task, hides content or a state, fails a WCAG AA
  pair, or is a repeated systemic failure). **Should fix** = `MEDIUM`. **Nice to have** = `LOW`.
- Within each group the items are ranked by reach: a token or shared component outranks one leaf.
- **Effort:** S = under an hour, M = half a day, L = a day or more (with tests).
- **Skill** is the focused skill to implement it with.
- The skill caps a report at 15 rows; the ticket asked for every screen with a short list to pick from, so this one
  lists 26 (near-duplicates merged). All `HIGH` items come first.
- ⚠ marks a finding that touches a settled decision. Those are flagged, not overridden: the fix keeps the decision
  unless the user says otherwise.

## Ranked list

| ID | Severity | Finding | Effort | Skill | Pick |
| --- | --- | --- | --- | --- | --- |
| M1 | Must | The `faint` text token fails 4.5:1 in all six Themes (2.4–4.75:1) and carries real text everywhere ⚠ | M | better-colors || ✓ B: `faint` for icons only (Q53) — done |
| M2 | Must | Status and ink tokens fail on the surfaces they're drawn on (Nord/Gruvbox error, light accent ink and warn, keycap text) | S | better-colors || ✓ done |
| M3 | Must | Sidebar Host and Session state is carried by dot colour alone, and the dots are hidden from screen readers ⚠ | M | better-accessibility || ✓ shapes + words (Q53) — done |
| M4 | Must | The App mode cursor in the Sidebar is invisible to assistive tech (no focus, no `aria-activedescendant`) | L | better-accessibility || ✓ done |
| M5 | Must | A side panel plus the Sidebar squeeze the terminal to ~8 columns at 640 px (200 % zoom), to nothing at the 480 px minimum | S | better-layout || ✓ done |
| M6 | Must | Cut-off names, paths and messages can only be read in a mouse tooltip, never from the keyboard | M | better-layout || ✓ done |
| S1 | Should | Session errors and start errors print raw Markdown backticks (`` `roster sync` ``) | S | better-typography || ✓ done |
| S2 | Should | No key closes the `:check` panel (Esc doesn't; only the × button or a Shift+Tab wrap) | S | better-accessibility || ✓ done |
| S3 | Should | The Leader keycap's hidden text is "␣", so every key hint reads "open box f" | S | better-accessibility || ✓ done |
| S4 | Should | `:check` step results aren't announced (`aria-label` on a plain span is ignored) | S | better-accessibility || ✓ done |
| S5 | Should | Sign-in fields never get `aria-invalid` when Bitwarden refuses them | S | better-accessibility || ✓ done |
| S6 | Should | Native radios use the browser's blue in every Theme (no `accent-color`) | S | better-colors || ✓ done |
| S7 | Should | Empty-Inventory states don't say what to do; the Picker says `No hosts match “”.` | S | better-writing || ✓ done |
| S8 | Should | Command line completions are bare command ids, list-motion commands included, with no label or key | M | better-ui || ✓ done |
| S9 | Should | The start-error screen doesn't follow the error system (traceback always open, no Copy, no Where) | M | better-ui || ✓ done |
| S10 | Should | Lock and sign-in copy: "Locked" when not signed in, an Enter hint where Enter does nothing, repeated message and Fix | S | better-writing || ✓ done |
| S11 | Should | The raised selection's outline is 1.3:1 against the Sidebar, under the 3:1 for a state indicator ⚠ | S | better-colors || ✓ raised + 2px jade bar on the live Session (Q53) — done |
| S12 | Should | The `:theme` finder doesn't show which Theme is current | S | better-ui || ✓ done |
| N1 | Nice | Key bindings panel noise: "builtin" on every row, nine "Go to Session N" rows | S | better-writing || ✓ done |
| N2 | Nice | Domain terms capitalised two ways: "Find a Host" / "Find a host", "this Box" / "this box", "hosts" | S | better-writing || ✓ done |
| N3 | Nice | At narrow widths the status bar keeps a key hint's keycaps but drops its word | S | better-layout || ✓ done |
| N4 | Nice | The Focus mode hint covers the side panel's heading for 2 s | S | better-layout || ✓ done |
| N5 | Nice | Terminal text runs flush to the right edge and the side panel's border | S | better-ui || ✓ done |
| N6 | Nice | 10–10.5 px text (keycaps, badges, binding sources) is below the 11 px floor of the scale ⚠ | S | better-typography || ✓ 11 px floor (Q53) — done |
| N7 | Nice | The finder's tmux marks (`*`, `-`) have no legend and read as symbols to a screen reader ⚠ | S | better-writing || ✓ marks kept + words + legend — done |
| N8 | Nice | Hover rules outside `@media (hover: hover)`; press scale 0.97 rather than 0.96 | S | better-ui || ✓ done (press scale stays 0.97) |

**Verdict at review time: `Block`** (six `HIGH` findings). **After the fixes: `Pass`**, with the limits listed under
[Fixes](#fixes). Domains not reviewed live: the tab-strip layout, the right-hand
Sidebar, the Focus session bar and the Config toast (source only), and RTL mirroring. Screen readers weren't run;
accessibility evidence comes from the ARIA tree and keyboard walks.

## Findings

### Must fix

#### M1 · The `faint` token fails 4.5:1 and carries text everywhere (Colour, M) ⚠

- **Where:** `app/src/theme/themes.ts:33, 72, 114, 174, 233, 295` (`faint` in each Theme), used as text colour about 50
  times in `app/src/styles.css`, including the status bar (182), Sidebar headings (236), empty states (177, 246), Host
  addresses and counts (288, 293), the Sidebar footer buttons "Keys"/"Lock" (320), binding sources (343), group
  headings (352), Picker address/group/type columns (417–418), the Picker footer (429), lock and sign-in field labels
  (451, `signin.css:5`), the lock hint (460), error facts (553), Details (570), the session bar (613) and finder paths
  (661). Screens: every one; see `review/standard-empty-dark.png`, `review/lock-light.png`.
- **Measured (WCAG 2):** faint on bg / chrome / panel / raised = Roster dark 3.21 / 3.07 / 2.97 / 2.81; Roster light
  3.02 / 2.80 / 3.02 / 2.55; Gruvbox 3.03 / 3.37 / 2.70 / 2.38; Nord 3.50 / 3.50 / 2.82 / 2.42; Catppuccin 4.44 /
  4.75 / 4.75 / 2.47; Tokyo Night 4.10 / 4.31 / 4.31 / 3.22. Text at 11–13 px needs 4.5:1 (1.4.3). The contrast test
  (`app/src/theme/contrast.test.ts:19–22`) checks `text` and `muted` (at 3:1), never `faint`.
- **Why it matters:** the status bar, every label on the lock and sign-in forms, Host addresses and all the hints are
  hard to read on a dim screen or for low vision. It's one token, so one fix reaches every screen.
- **Fix, option A (keep three greys):** lift `faint` to the lowest value that passes on bg, chrome, sidebar and panel:
  Roster dark `#5f6165 → #7c7e81`, Roster light `#8e959e → #6b7179`, Gruvbox `#7c6f64 → #a49680`, Nord `#7b88a1 →
  #a5aec0`, Catppuccin `#7f849c → #81869e`, Tokyo Night `#737aa2 → #7a81a9`. Text that sits on a selected (raised) row
  switches to `muted` (`.picker-row.selected .host-ip` and the like). The test checks `faint` ≥ 4.5 on those four
  surfaces, and `muted` ≥ 4.5 rather than 3.
- **Fix, option B (two greys for text):** keep `faint` for non-text only (chevrons, icons, dots, rules) and move every
  text use to `muted`. Hierarchy then comes from size and weight, which Linear also does. This is the cheaper fix
  (it deletes a tier), but every screen looks a little brighter.
- ⚠ **Decision:** Q27 ("muted palette") and Q50 (the dark surfaces) set the look. Option A changes only `faint`'s
  value; option B changes how the hierarchy is drawn. In Roster dark, A leaves `faint` (#7c7e81) close to `muted`
  (#8b8d91), so the two tiers nearly merge anyway. That is the argument for B.

#### M2 · Status and ink tokens fail on their surfaces (Colour, S)

- **Where:** `themes.ts`. Nord `error #bf616a` (176): 3.05 on bg, 2.46 on panel. Gruvbox `error #fb4934` (116): 3.82
  on panel, 3.37 on raised. Roster light `accentInk #17845a` (60): 4.33 on chrome/sidebar, 3.95 on raised.
  Roster light `warn #9a6200` (73): 4.30 on raised. `muted` on raised: Nord 3.74, Catppuccin 4.10, Gruvbox 4.17.
- **Rendered on:** the lock and sign-in errors and `.problem` headings (`review/theme-nord-signin-error.png`), the
  status bar's `APP` mode label and `init.lua` binding sources (`styles.css:202, 345`, on chrome), `:check` ticks, and
  every keycap (`.keycap { color: muted; background: raised }`, `styles.css:107–108`;
  `review/theme-catppuccin-mocha-keys.png`).
- **Fix:** Nord error `→ #d3a1a8` (or switch Nord's error to aurora `#d08770`, re-measured); Gruvbox error
  `→ #f76c52`; Roster light accentInk `→ #187954`, warn `→ #955f02`; Nord muted `→ #b7bcc6`, Catppuccin muted
  `→ #aeb6d1`, Gruvbox muted `→ #afa089` (each the nearest value at 4.5:1 on raised). Extend `contrast.test.ts` to
  error, warn and accentInk on every surface, and muted on raised.
- **Why:** error text is what people must read to recover. Q51 asked for "official palettes"; the error hue stays in
  the palette's family, only lightened. Flag it if exact palette values matter more than legibility.

#### M3 · Sidebar state by colour alone, hidden from screen readers (Accessibility, M) ⚠

- **Where:** `app/src/sidebar/Sidebar.tsx:218` (`<span className="dot …" aria-hidden="true" />` with no text alternative);
  `styles.css:296–301` (the "unreviewed" badge is `display: none` until hover or cursor, and hides the address);
  `styles.css:270–274` (a Session's "failed"/"ended" note drops to the hidden second line when the name is long).
- **What's wrong:** in the Inventory an unreviewed Host (hollow *grey* ring) and a password Host (hollow *jade* ring)
  differ only in colour (`review/standard-empty-dark.png`, `linux-1-024` vs `linux-1-000`). In the worst case,
  `host-key-changed-esxi-rack-…` has ended, but with the note pushed out only the grey dot says so
  (`review/w800-worst-dark.png`). The ARIA tree reads `button "linux-1-024"` and `button "router-1-004 10.19.1.6"`
  with no state at all: key or password Login, unreviewed (can't open), ended or failed. Fails 1.4.1 and 1.3.1.
- **Fix:** (1) put the state in the row's name with visually hidden text after the label: ", unreviewed, can't be
  opened" / ", password login" / ", ended" / ", failed". (2) Give `off` a shape of its own: `.dot.off { background:
  transparent; box-shadow: none; border: 1.5px dashed var(--faint); }`. (3) Keep a Session's state note in view when
  the name is cut: make `.sb-note` sit outside `.sb-text` with `flex: none`, like the `(2)` tail.
- ⚠ **Decision:** ticket 27 hid the badge "so it shows only when you look at the row". The fix keeps that and adds the
  dashed ring plus the hidden text, so the quiet look stays.

#### M4 · The App mode cursor is invisible to assistive tech (Accessibility, L)

- **Where:** `Sidebar.tsx:203–216` (rows are `<div role="button">` with no `tabIndex`); the cursor is only the
  `.cursor` class (`styles.css:260`); the Sidebar's scroller `.sb-scroll` (`Sidebar.tsx:351`) is a Tab stop
  (Chromium makes scrollers focusable) with no role or name. The keyboard walk reaches *Find a Host → [unnamed div] →
  Keys → Lock → Terminal input*, and arrows in App mode move a cursor nothing announces.
- **Why:** the Sidebar's keyboard path, the main way to reach Sessions, Folders and the Inventory without a mouse,
  can't be used with a screen reader (4.1.2, 2.4.3). The Picker and finders already do this right (combobox +
  `aria-activedescendant`).
- **Fix:** the same pattern as the Picker: `.sb-scroll` gets `role="tree" aria-label="Sidebar"`, rows get
  `role="treeitem"` with `aria-level`, `aria-expanded`, `aria-selected` (cursor) and `aria-current` (on-screen
  Session), and `aria-activedescendant` points at the cursor row while App mode has focus on the tree (`tabIndex={0}`
  when shown, focused on entering App mode in the Sidebar). Keep the row's click behaviour.

#### M5 · Side panels squeeze the terminal at narrow widths (Layout, S)

- **Where:** `styles.css:327–330, 357–360` (Key bindings and `:check` panels: `width: 320px; flex: none` beside a
  248 px Sidebar). Screens: `review/w640-keys-dark.png` (the terminal is ~70 px, 8 columns), `review/w800-keys-dark.png`.
  At the window's 480 px minimum, Sidebar plus panel need 568 px and the terminal disappears.
- **Why:** 640 px is the 1280 px window at 200 % zoom (1.4.4/1.4.10). The terminal is the primary content.
- **Fix (reuse what exists):** Focus already floats these panels over the terminal (`styles.css:588–592`). Apply the
  same rule when there isn't room: `@media (max-width: 1040px) { .keys-panel, .check-panel { position: absolute;
  top: 0; right: 0; bottom: 0; z-index: 5; border-left: 1px solid var(--line-strong); box-shadow: -8px 0 32px
  var(--shadow); } }`. 1040 = 248 + 320 + 472 (80 terminal columns at 14 px Iosevka is about 590 px; 472 keeps ~64).
  Also consider hiding the Sidebar on its own below ~720 px (`␣ e` brings it back).

#### M6 · Cut text can only be read in a mouse tooltip (Layout, M)

- **Where:** Sidebar names (`.sb-label`, `styles.css:276–279`; full text only in `title`, `Sidebar.tsx:209, 222`),
  Picker columns (`styles.css:414`, `Picker.tsx:141–150` `title`), finder names and paths (`styles.css:658, 661`),
  status bar Box and path (`styles.css:190–192`), session bar names, `:check` messages (`styles.css:373`). Screens:
  `review/worst-case-dark.png` (`server-10-0-0-203-very-l…`, `lab-hub2-ops-console-work…`),
  `review/w640-picker-light.png`.
- **Why:** this is a keyboard-first app (Q27, Q36), and the only way to the full value is hovering a mouse.
  Two long Hosts that differ only at the end (`…-building-4` / `…-building-5`) can't be told apart from the
  keyboard.
- **Fix:** the selected row shows its whole name. In the Picker and finders: `.picker-row.selected .host-name,
  .finder-row.selected .finder-name { white-space: normal; overflow-wrap: anywhere; }` with the row's `height: 34px`
  → `min-height: 34px`. In the Sidebar, App mode shows the cursor row's whole label and detail in the message line
  (it exists: `.message-line`). The status bar path stays cut, but `:info` (or the Key bindings panel's header) shows
  it whole.

### Should fix

#### S1 · Raw Markdown backticks in errors (Typography, S)

- **Where:** `app/src/errors/ErrorPanel.tsx:141` (`sentence(problem.message, …)`) and `:146` (`fixFor(row, problem)`),
  `app/src/ErrorScreen.tsx:16–17`. Screens: `review/error-not-set-up-dark.png` ("run `` `roster sync` ``, or
  `` `roster setup` ``"), `review/start-roster-too-old-dark.png`.
- **Fix:** wrap both in `withCode()` (`app/src/lock/withCode.tsx`), as `LockScreen.tsx:71` and `SignIn.tsx:544, 549`
  already do. Reuse, no new code.

#### S2 · No key closes the `:check` panel (Accessibility, S)

- **Where:** `App.tsx:751–760`: the panel closes only from its × button. Esc in App mode leaves it open, and the
  terminal keeps Tab, so the button is reached only by Shift+Tab wrapping past the document start (checked in
  Chromium; WebView2 not verified).
- **Fix:** Esc in App mode closes the topmost panel (Key bindings already closes on Esc from its filter), and add a
  `:check` toggle or a `panel.close` command to the command table so `init.lua` can bind it.

#### S3 · The Leader keycap reads as "open box" (Accessibility, S)

- **Where:** `app/src/ui/Keys.tsx:41` (`<span className="visually-hidden">{LEADER}</span>`, where `LEADER = "␣"`).
  Accessible names come out as `Find a Host ␣ f`; the status bar and the empty states read the same way.
- **Fix:** hidden text "Leader" (the glossary term), so a name reads "Find a Host, Leader f". The title already says
  `Leader (Ctrl+Space)`.

#### S4 · `:check` step results aren't announced (Accessibility, S)

- **Where:** `app/src/errors/CheckPanel.tsx:58` (`<span className="check-mark" aria-label={s.status}>✓</span>`). An
  `aria-label` on a generic span is ignored; the tree reads "✓ Inventory entry …".
- **Fix:** `<span className="check-mark" aria-hidden="true">{MARK[s.status]}</span><span
  className="visually-hidden">{passed | failed | skipped}</span>`.

#### S5 · Sign-in fields never get `aria-invalid` (Accessibility, S)

- **Where:** `app/src/lock/SignIn.tsx:287–298` (Secret) and `:362–371` (email) set `aria-describedby="signin-error"` but
  never `aria-invalid`; the unlock form does (`LockScreen.tsx:123–124`). Screens: `review/signin-3-wrong-password-*.png`,
  `review/signin-6-code-error-*.png`.
- **Fix:** pass `invalid={problem !== null}` into `Secret` and the email field and set `aria-invalid`. The red border
  already exists (`styles.css:454`). Set `aria-describedby` only while the error exists.

#### S6 · Native radios ignore the Theme (Colour, S)

- **Where:** `:root` in `app/src/styles.css:8–40` has no `accent-color`, so the sign-in server radios
  (`SignIn.tsx:316`) are Chromium blue in every Theme (`review/signin-1-server-dark.png`).
- **Fix:** `:root { accent-color: var(--accent); }`. One line, and it covers any future checkbox too.

#### S7 · Empty-Inventory states don't say what to do (Writing, S)

- **Where:** `Picker.tsx:161` shows `No hosts match “”.` for an empty query (`review/worst-case-empty-picker-dark.png`);
  `sections.ts:162` "No Hosts in the Inventory."; the workspace's "No Sessions open" still offers **Find a Host**
  (`App.tsx:727`), which opens that empty Picker.
- **Fix:** Picker with an empty query and no Hosts: "The Inventory has no Hosts yet. Add them to roster.yml and they
  show up here." Sidebar: "No Hosts yet. Add them in roster.yml." Workspace with no Hosts: show the Inventory path from
  the status bar instead of the Find button. Keep `No Hosts match “query”.` for a real query.

#### S8 · Command line completions are bare ids (UI, M)

- **Where:** `app/src/cmdline/CommandLine.tsx:48–52` renders `{c}` only. Screen: `review/cmdline-complete-dark.png`:
  `bottom, check, choose, close, cmdline, connect, down, find, +21 more`.
- **Why:** the command line is the discovery surface of a keyboard-first app, but it lists list-motion internals
  (`down`, `bottom`, `choose`, `cmdline`) first and says nothing about what a command does.
- **Fix:** a second column with the command's `label()` (it exists in `commands/table.ts`) and its key hint (`Keys`),
  in `muted`; rank `area: "Sidebar"` motion commands last (still runnable).

#### S9 · The start-error screen isn't the error system (UI, M)

- **Where:** `app/src/ErrorScreen.tsx:12–25`, `styles.css:152–161`. A 220 px traceback is always open
  (`review/start-worst-case-start-light.png`), the fix command can't be copied, and there's no Where, while Session
  errors (`ProblemBody`) put the raw text under **Details** with a Copy button.
- **Fix:** build the start error from `ProblemBody`-style parts: message, Where ("this Box: WSL FedoraLinux-44"),
  Fix with `withCode` and Copy, the raw output under `<details>`. Q44 "Clean errors everywhere".

#### S10 · Lock and sign-in copy (Writing, S)

- `LockScreen.tsx:48`: the heading says **Locked** when the vault CLI isn't signed in and there's no sign-in
  (`review/worst-case-vault-dark.png`, `review/missing-cli-dark.png`). → "Bitwarden isn't signed in on this Box" /
  "The Bitwarden CLI isn't installed". The command inside the warning has no Copy button: use the `.problem-copy`
  row.
- `SignIn.tsx:241–243`: "Enter continues · Esc goes back" shows on the SSO wait, where Enter does nothing
  (`review/sign-in-sso-dark.png`), and it's plain `<kbd>` text where everything else uses keycaps (`Keys`). → Hide it
  on the SSO step and draw it with `Keys`.
- `SignIn.tsx:525`: "Finish signing in in your browser" → "Finish signing in with your browser". The SSO link is
  11 px code that breaks mid-token (`…state=fa` / `ke`); give it `overflow-wrap: anywhere` at `--text-sm`, and a
  quiet progress cue beside "Waiting for the browser…".
- `SignInProblem` (`SignIn.tsx:546–549`): "Where: the vault, the sign-in form" says nothing new, and for the rate limit
  the message and Fix repeat each other (`review/sign-in-rate-limited-light.png`). → Drop Where on the lock screen
  (you're looking at it); show Fix only when it adds something to the message.

#### S11 · The raised selection is under 3:1 (Colour, S) ⚠

- **Where:** `themes.ts` `raised`/`raisedLine`: the selected row's fill is 1.14:1 (dark) and 1.10:1 (light) against
  the Sidebar, and its outline 1.31:1 / 1.34:1. Selection is mostly carried by the text turning from muted to text.
  Used by `.sb-row.raised`, `.picker-row.selected`, `.finder-row.selected`, `.cmdline-candidates li.selected`,
  `.sessionbar-tab.current` (`review/standard-session-dark.png`).
- **Fix within Q31:** keep the raised style and lift only `raisedLine` to 3:1 against the Sidebar: dark
  `#28292b → #606162`, light `#d3d7dd → #8a8e94`.
- ⚠ **Decision:** Q31 chose a *slightly* lighter fill and a 1px outline, and a 3:1 outline is visibly stronger than
  Linear's. If that's too loud, the alternative is a 2px jade bar at the row's start edge for the current Session only
  (`box-shadow: inset 2px 0 var(--accent)`). The user decides; this is flagged, not overridden.

#### S12 · The `:theme` finder doesn't show the current Theme (UI, S)

- **Where:** `app/src/theme/picker.ts:107` (detail is only `dark`/`light`); `review/theme-finder-dark.png`.
- **Fix:** detail `dark · current` on the active Theme, and open the finder with it selected, so Esc after previewing
  reads as "back to this one".

### Nice to have

- **N1 · Key bindings panel noise (Writing, S):** `BindingsPanel.tsx:71` prints `builtin` on every row; nine "Go to
  Session N" rows (`review/keys-panel-light.png`). → Show the source only when it isn't builtin (filtering by
  "builtin" still works), and fold the digits into one row: "Go to Session 1–9 · ␣ 1…9".
- **N2 · Capitalisation of domain terms (Writing, S):** "Find a Host" (Sidebar) vs "Find a host: name, address…"
  (`Picker.tsx:110`), "No hosts match", "300 hosts", "this Box" vs "this box". → The glossary capitalises Host, Box
  and Session; follow it in the app's own strings. Messages from roster itself are Not verified here.
- **N3 · Status bar hints at narrow widths (Layout, S):** at 640 px the right end shows `␣ f` with its word cut
  (`review/w640-worst-light.png`). → Let `.statusbar .hint` drop out whole (`flex: none` per hint inside the wrapping
  row already does this for the row; the last hint is cut by `overflow: hidden` on `.statusbar`).
- **N4 · Focus hint over the panel heading (Layout, S):** `styles.css:596–601` puts the hint at `top: 12px; right:
  14px`, over a panel's title (`review/focus-hint-dark.png`). → Put it at the top centre, or `right:
  calc(var(--keys-width) + 14px)` while a panel is open.
- **N5 · Terminal flush to the right (UI, S):** `.term-host { padding: 8px 0 0 12px }` (`styles.css:501`). → `padding:
  8px 12px 0` so the last column never touches the panel border (`review/check-dark.png`).
- **N6 · Sub-scale text sizes (Typography, S) ⚠:** keycaps 10.5 px and 10 px in the status bar (`styles.css:107,
  201`), badges 10 px (296, 423), binding sources 10.5 px (343). The scale's smallest step is 11 px (`--text-xs`). →
  Use `--text-xs` for all of them. Q27 asks for small type, so this only removes the off-scale values.
- **N7 · tmux marks unexplained (Writing, S) ⚠:** the Sessions finder marks the current Session `*` and the previous
  `-` (`review/focus-finder-sessions-light.png`), and the session bar's names read `1:linux-1-000*`
  (`SessionBar.tsx:45`). → Keep the marks (Q36 is tmux-style), add hidden text ("current", "previous") and a footer
  legend `* current · - previous`.
- **N8 · Hover and press details (UI, S):** `.config-toast-close:hover` (`styles.css:681`) and `.sb-row:hover .sb-badge,
  .sb-row:hover .sb-action` (300, 308) sit outside `@media (hover: hover) and (pointer: fine)`, unlike the rest;
  `--press-scale: 0.97` (30) where the skill's value is `0.96`. Touch only matters for a future tablet build.

## Settled decisions this touches

| Finding | Decision | What the fix keeps |
| --- | --- | --- |
| M1 | Q27 muted palette, Q50 dark surfaces | Surfaces untouched; only `faint`'s value (A) or its use (B) changes |
| M3 | Ticket 27's "badge only when you look at the row" | Badge behaviour stays; adds a dashed ring and hidden text |
| S11 | Q31 raised selection | Raised style stays; only the outline's value changes, or an accent bar is used instead |
| N6 | Q27 small type | Stays small; only off-scale sizes go |
| N7 | Q36 tmux-style marks | Marks stay; adds a legend and hidden text |

Nothing here argues for a different direction: Linear-like density, the near-black, jade, Inter + Iosevka 500 and the
keyboard-first model all hold up across the screens.

## What's working

- Motion follows its own rules: everything is 150 ms or less on transform and opacity, the Picker, finders and Lock
  have no open motion, and reduced motion keeps the fades only (`styles.css:42–49`).
- The Picker and finders are proper comboboxes with `aria-activedescendant`, disabled unreviewed rows, and the
  "unreviewed" badge always in view.
- Error panels (ticket 26) give a heading, plain message, Where, Fix, Copy, Retry and Details, which is the model for S9.
- The worst case (27) holds: long, RTL, CJK and one-letter names, 1,284 Hosts and 50 Sessions render without overlap
  at 800 px and above.
- The six Themes are consistent: every token is used by role, with no colour literals in components.
- The sign-in flow is fully keyboard-driven (Enter, Esc, number keys in the method picker) and keeps secrets out of
  React state.

## Verification

Passed or run:

- `npm run check` (tsc, eslint, Vitest): 35 files, 416 tests passed.
- Contrast: WCAG 2 ratios of `muted`, `faint`, `warn`, `error` and `accentInk` on `bg`, `chrome`, `sidebar`, `panel`
  and `raised` for all six Themes, computed from `themes.ts` (script in the session scratchpad; the values are
  quoted above). The fix values were found the same way and are the nearest at ≥ 4.5:1 (≥ 3:1 for S11).
- Screens: Vite dev server on port 5179 with the fake Backend, driven by Playwright (Chromium 1248 headless), 1280 ×
  800 at 1×, colour scheme matched to the Theme. 126 screenshots in `review/`.
- Keyboard: Tab and Shift+Tab walk from the Sidebar; Leader + f, :, ?, m, b, e, arrow keys; Esc on every overlay;
  number keys in the method picker; Enter on radios.
- ARIA: `ariaSnapshot()` of the lock screen, each sign-in step, Standard, the Picker, the command line, Key bindings,
  `:check`, the error panel, the theme finder, the Focus finder and the worst case.
- Reduced motion: from source (`styles.css:42–49, 596–608`).

Not verified:

- Screen readers (NVDA, Narrator) weren't run; M4, S3, S4 and S5 rely on the ARIA tree.
- WebView2 on Windows (focus wrap for S2, native radio colour for S6, emoji fallback).
- Emoji: the WSL Chromium has no colour-emoji font, so `🦊-fox-lab` draws as a box. The font stack names Segoe UI
  Emoji, so this is likely fine on Windows.
- The tab-strip layout, the right-hand Sidebar, the Focus session bar and the Config toast need an `init.lua`; they
  were read from source only.
- RTL mirroring of the whole layout, and forced-colors mode (the `box-shadow` rings and the raised outline vanish
  there; worth a check alongside S11).

## Screenshots

All in `review/`, named `<screen>-<dark|light>.png`:

- Lock: `lock-*`, `lock-wrong-password-*`, `missing-cli-*`, `worst-case-vault-*`.
- Sign-in: `signin-1-server-*`, `signin-1b-selfhosted-*`, `signin-2-email-*`, `signin-3-wrong-password-*`,
  `signin-4-methods-*`, `signin-5-code-*`, `signin-6-code-error-*`, `sign-in-*` (new-device code), `sign-in-sso-*`,
  `sign-in-rate-limited-*`.
- Standard: `standard-empty-*`, `standard-session-*`, `app-mode-pending-*`, `app-mode-cursor-*`,
  `tab-focus-sidebar-*`.
- Picker: `picker-*`, `picker-query-*`, `picker-no-match-*`.
- Command line: `cmdline-*`, `cmdline-complete-*`.
- Key bindings: `keys-panel-*`, `keys-panel-filter-*`, `keys-panel-nomatch-*`.
- Themes: `theme-finder-*`, `theme-finder-preview-*`, `theme-<gruvbox|nord|catppuccin-mocha|tokyo-night>-<worst|keys|signin-error>`.
- Errors: `error-not-set-up-*`, `check-*`, `start-roster-too-old-*`, `start-roster-missing-*`, `start-worst-case-start-*`.
- Focus: `focus-hint-*`, `focus-finder-sessions-*`, `focus-picker-*`, `focus-keys-*`.
- Worst case and empty: `worst-case-*`, `worst-case-keys-*`, `worst-case-picker-*`, `worst-case-one-*`,
  `worst-case-empty-*`, `worst-case-empty-picker-*`, `worst-case-empty-focus-finder-*`.
- Widths: `w800-*`, `w640-*`, `w320-*` (worst case, Key bindings, Picker, sign-in). 320 px is below the window's
  480 px minimum and is kept for reference only.

## Fixes

All 26 picked, all done on `feat/29-interface-review`, test-first. Commits are tagged `(ticket 29, <IDs>)`.
Before and after: `review/` and `review/after/` use the same file names; the Windows
check is in `review/windows/`. Design calls follow `emil-design-eng`, `animate` and
[taste.md](taste.md) (Q54).

| ID | Done | How (and where it differs from the proposal) |
| --- | --- | --- |
| M1 | ✓ | Option B. Every text rule moved from `faint` to `muted`; `faint` colours only decorative icons (search, row icons). The fold chevron and the close/edit glyphs went to `muted` too, since they act or show state (1.4.11). `app/src/styles.test.ts` fails on any rule that colours text with `--faint`. |
| M2 | ✓ | Values recomputed so every text token (`text`, `muted`, `warn`, `error`, `accentInk`) reads at 4.5:1 on **all six** surfaces, `hover` included (the proposal measured five), mixing toward white (black in Roster light) to keep the hue: Roster light accentInk `#157953`, warn `#955f00`; Gruvbox muted `#aea08c`, error `#fc7b6c`; Nord muted `#b7bcc5`, error `#dfb0b5`, accentInk `#8fc4d3`; Catppuccin muted `#afb6ce`, error `#f59db5`, accentInk `#cca7f7`. Nord's error is noticeably paler than `nord11`; listed in `docs/app/themes.md`. |
| M3 | ✓ | `ui/StateDot.tsx`: SVG nodes, filled / ring / hollow grey / dashed grey (Sidebar and finders). Every tree item's name carries its state ("linux-1-000, password login, 10.19.1.2"; "…, unreviewed, can't be opened, …"; "…, ended (code 0)"). A Session's note sits beside the name and is never cut. Badge rule from ticket 27 kept. |
| M4 | ✓ | The Sidebar's scroller is `role="tree"` ("Sessions and Hosts"), sections are `group`s, rows and headings `treeitem`s with `aria-level`, `aria-expanded`, `aria-current`, `aria-selected`. App mode puts focus on the tree with the cursor as `aria-activedescendant` and gives it back on leaving (or to the workspace if the Sidebar went away with `␣ m`). Tab from Find a Host reaches the tree and enters App mode. |
| M5 | ✓ | Below 1040 px the Key bindings and `:check` panels float over the terminal, as in Focus. Not done: hiding the Sidebar on its own below ~720 px ("also consider"); `␣ e` still does it by hand. |
| M6 | ✓ | Picker and finders: the selected row wraps its whole name (and path). Sidebar: App mode shows the cursor row whole below the tree (name, state, address, tooltip) instead of using the message line, so it doesn't flicker as a live region. Status bar: a new `:info` command says the Backend, Box and path whole. |
| S1 | ✓ | `withCode` on the Session error's message and Fix. Details keeps roster's raw text. |
| S2 | ✓ | Esc in App mode closes the topmost side panel; new `hidepanel` command for `init.lua`. |
| S3 | ✓ | Hidden text "Leader"; the Find button reads "Find a Host, Leader f". |
| S4 | ✓ | Marks `aria-hidden`, "passed / failed / skipped" as hidden text. |
| S5 | ✓ | `aria-invalid` and `aria-describedby` only while the error shows. |
| S6 | ✓ | `:root { accent-color: var(--accent) }`. |
| S7 | ✓ | Picker, Sidebar and workspace copy as proposed; the workspace shows the Inventory's path in Iosevka with no Find button. |
| S8 | ✓ | Label and keycaps per command; list and tree motions (a new `motion` flag) rank last. |
| S9 | ✓ | Message, Where, Fix, a Copy row per command in the hint, Retry, raw output closed under Details. |
| S10 | ✓ | Headings by vault status, Copy row for the command, keycaps for the step keys, no Enter hint while waiting on SSO, "with your browser", the SSO link at `--text-sm`, a breathing node (not a spinner: taste.md) beside "Waiting for the browser…" (constant motion, linear, opacity only, still under reduced motion). Where dropped on the lock screen; a catalog row can say its Fix is in the message (`fixInMessage`, set on rate-limited). |
| S11 | ✓ | The user's pick: raised fill kept, plus a 2px jade bar (a pill inset 5 px top and bottom) on the on-screen Session's row **while it's live** (an ended Session on screen is raised without it: "jade means live"). The cursor is raised with the accent outline and no bar. Forced-colors mode keeps both. `raisedLine` unchanged. No motion: it moves with keys. |
| S12 | ✓ | `dark · current` on the Theme in use; the finder already opened on it. |
| N1 | ✓ | Source shown only when not builtin; "Go to Session 1–9 · ␣ 1…9". |
| N2 | ✓ | "Host", "Hosts", "Box" capitalised in the app's own strings. Messages from roster itself ("on this box") are roster's and unchanged. |
| N3 | ✓ | A zero-width first flex item makes a hint that doesn't fit wrap away whole. |
| N4 | ✓ | Top centre. |
| N5 | ✓ | The cause was the padding on `.term-host`, which FitAddon counted as room; the padding moved onto xterm's own element (which FitAddon subtracts), and xterm's black default viewport is transparent. |
| N6 | ✓ | Everything at `--text-xs` or above; `app/src/styles.test.ts` fails on any font size under 11 px. |
| N7 | ✓ | Hidden "current" / "previous", a footer legend `* current · - previous`, and the session bar's names say it too. |
| N8 | ✓ | Every `:hover` rule inside `@media (hover: hover) and (pointer: fine)` (test). The press scale stays **0.97**: that's emil-design-eng's and animate's value, which win over the interfaces skill's 0.96 on motion. |

### Verification

- `npm run check` (tsc, eslint, Vitest) and `cargo test`, `cargo clippy`, `cargo fmt --check` pass; see the ticket's
  commits for the counts.
- Screens: the Vite dev server with the fake Backend in Playwright's Chromium, 1280 × 800 (800 and 640 for the narrow
  ones), dark and light, plus Nord, Gruvbox, Catppuccin Mocha and Tokyo Night spot checks: `review/after/`.
- Windows (WebView2, `tauri dev` from `%LOCALAPPDATA%\roster-app-dev-29` on port 1434 with its own
  `WEBVIEW2_USER_DATA_FOLDER`, the fake Backend's `few-hosts` fixture, no real vault), driven over CDP:
  `review/windows/`. Checked: the lock screen, the jade bar on the live Session
  (`w-session-live-bar`), the node shapes and the App-mode cursor with its details line (`w-app-mode-cursor`), the Key
  bindings panel floating at a 640 px viewport (`w-640-keys-panel`), and locking again. WebView2's own accessibility
  tree (CDP `Accessibility.getFullAXTree`) shows `tree "Sessions and Hosts"` focused in App mode with
  `aria-activedescendant` on the cursor row, `group`s per section, and tree items such as
  `treeitem "router-1-004, key login, 10.19.1.6" level=3 selected=true`; Esc gives focus back to xterm's textarea.
- **Screen readers: not verified.** Narrator is installed but an agent can't hear or capture its speech, and NVDA
  isn't installed. The evidence is the WebView2 accessibility tree above and the Vitest checks of names, roles and
  focus.

### New proposals (not in this ticket)

- **Connect edge** (taste.md): a 1px jade edge drawn from the row's node toward the terminal on connect (~120 ms),
  the node filling on a shell. Needs the `animate` skill's pass; a ticket of its own.
- Hide the Sidebar by itself below ~720 px (M5's "also consider").
- taste.md's status bar and lock screen: the Box name, Host count and path in Iosevka (data), the lock screen showing
  the Box name.
- roster's own messages say "this box" in lower case (N2 covers only the app's strings); a roster-side copy pass.
