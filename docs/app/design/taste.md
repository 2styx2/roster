# roster's taste

How the roster app should look, move and talk, so it feels like *ours* and not "Linear with an accent". Linear is the discipline we borrow (density, restraint, a quiet surface). `emil-design-eng` and `animate` are the craft. This page is the identity. Every UI change should be explainable with one of these lines. When they conflict with a reference, **this page wins** (except on accessibility).

## The idea: a live map of your network, a fast way into it, and yours to shape

roster *is* the map: Hosts are nodes, and Sessions are live connections between this Box and them. The logo already says this (Gap orbit, decision Q57): **the R in its orbit**, nodes joined into a letter, with this Box as the square at the foot of the stem. The leg reaches out to the orbit, and **the orbit is broken where the Host sits: the gap is where the Host connects**. That Host is the one accent node. Carry that one motif everywhere instead of decorating.

And like Neovim or VS Code, **roster is a tool you make your own**. The look, the keys, the layout and the behaviour are opinionated defaults that `init.lua`, themes and Plugins can reshape. Configurability isn't a settings page bolted on; it's part of the identity.

## Principles

1. **The terminal is the hero.** Chrome recedes: neutral near-black, hairlines, no gradients, no glass, no shadows on resting surfaces. If a pixel isn't helping you reach or use a shell, it's quiet.
2. **Nodes and edges are our only ornament.**
   - State dots are *nodes*, and their shapes carry meaning: filled = key, ring = password, dashed = unreviewed, hollow grey = ended.
   - Empty states, the lock screen and loading use the Gap orbit mark, small and still, never as wallpaper.
   - "Connecting" is an edge being drawn, a short line from this Box to the Host's node. It isn't a spinner.
3. **The accent means "live".** The accent is apricot (Apricot flare, Q57), and it's spent only on what's connected or actionable now: the current Session's bar, a live node, the primary button, the cursor, the Host in the logo. Nothing decorative is apricot. A screen with no live connection has almost none on it.
   - **The second tone (Sea glass) is for place, not action:** this Box's square and the dashed node of an unreviewed Host. Shapes only, never text and never something you can click.
   - Warn is yellow and error raspberry, so neither is ever mistaken for the accent.
4. **Two voices of type.**
   - **Iosevka 500** is for *data and the machine*: Host names, addresses, ports, fingerprints, keys, commands and terminal text.
   - **Inter** is for *the app talking to you*: labels, headings and copy.

   If it's something you could paste into a shell, it's in Iosevka.
5. **Keyboard first, and it shows.** Every action has a key, and keycaps sit next to the things they do. Discoverability through keycaps is our onboarding, not tooltips or tours. The mouse is welcome but never required.
6. **Honest, plain voice.** Copy says what happened, where it lives (`roster.yml`, the vault, this Box, the network, the Host), and the one thing to do next. No exclamation marks, no "Oops", no blame, no jargon the user didn't type themselves. A secret is never named "password" in a log line.
7. **Calm under failure.** Errors look like the rest of the app, not like an alarm: the same panel, a clear fix, raw details one keypress away. Red is reserved for "this will break something" (danger) and real failures. Alarm is never used to get attention.
8. **Motion confirms, it never performs.** Motion shows cause and effect: an edge drawn on connect, a node dimming on exit, a panel sliding from the side it belongs to. It's under 150 ms, interruptible, off under reduced motion, and the lock cover is instant. Through `animate`, always.
9. **It's yours, like Neovim or VS Code.** Every color, font, key, layout piece, Sidebar section, finder, status segment and command is a default that the Config or a Plugin can change, add or remove. Defaults are opinionated; they're never locks. See "Made to be made yours" below.

## Made to be made yours

What makes roster feel like Neovim or VS Code, and what every feature must respect:

- **Code, not a settings screen.** Configuration is `init.lua` (Lua, versioned in your dotfiles) plus Packages pinned in a lock file (ADR 0004, ADR 0006). There's no hidden preference that only a GUI can reach.
- **Everything is a registry entry.** Built-in features register commands, keys, themes, Sidebar sections, finder sources, status segments and error rows through the same registries Plugins use. If the app can do it, a Plugin can do it, and a Plugin can undo it. *(The status bar's Host count and the Sidebar's Folders prove it: both are built-in Plugins on the public API, tickets 23 and 61, decisions Q82 and Q93.)*
- **Always say where a thing comes from.** Every binding, theme, Folder and setting shows its source (`builtin`, `init.lua`, or the Plugin's name), as the Key bindings panel already does. The user can always answer "why is it like this, and where do I change it?"
- **Make changing it one step away.** `:config` opens `init.lua`. Every panel that shows a configurable thing hints at its name, for example `theme`, `keys`, `modes.focus.sessionbar`. `examples/init.lua` documents every option. Saving applies live.
- **Plugins look native.** Plugin pieces render with the same tokens, components, keycaps and voice as built-ins, so a well-made Plugin is indistinguishable from the app. Third-party HTML is out in v1 for this reason, as well as for security.
- **Breaking your config never breaks the app.** A config mistake shows the file and line, and the last good config keeps running. A misbehaving Plugin is disabled and named, never fatal.
- **Opinionated, then out of the way.** The defaults (Standard mode, Apricot flare, Inter and Iosevka, `␣` as the Leader) are good enough that most people never open `init.lua`. Everyone who does can change all of it.
- **Two lines that never move, whatever the config:** secrets never reach the UI or Plugins, and Inventory changes from Plugins only become Pending changes. Configurability stops at safety.

## Signature details (do these consistently)

| Detail | Spec |
|---|---|
| **Connect** | A 1px edge in the accent draws from the Sidebar row's node toward the terminal, over about 120 ms. The node fills when the Session reaches a shell. On failure the edge snaps back and the node turns hollow with the error state. Until the shell answers, the pane shows the connect card, never a blank terminal: this Box's square, the edge drawn to the Host's ring, the Host and its address, and what's happening now ("Starting ssh on this Box…", "Logging in…"); it fades out over the first output (issue #54). |
| **Session ended** | The node empties to a hollow grey ring. The row keeps its place. Nothing jumps. |
| **Empty states** | The Gap orbit mark (small, 48–64px, muted), one plain sentence, and the keycap for the next action. |
| **Lock screen** | The Gap orbit mark, the Box name in Iosevka, one field. Nothing else. |
| **Selection** | Raised fill, plus a 2px accent bar only on the live Session (Q53). The cursor in App mode is raised without the bar. |
| **Data cells** | IPs, ports and fingerprints in Iosevka at the muted color, tabular numbers, never cut mid-token. |
| **Status bar** | Reads like a tmux line: `● WSL: FedoraLinux-44  ■ devbox  91 hosts`, the `■` being this Box's square in the second tone. Data in Iosevka, hints as keycaps. |
| **Logo** | Gap orbit, plain (Q57): the R, its orbit and the Box in the text colour, one accent Host in the gap. The R fills most of the orbit (radius 26 of 64, the round-5 prototype's proportions) and clears it by about 1 px at 16 px (Q59). The app icon is the same mark with no tile, on a transparent background, in a mid-tone neutral `#808183` and a mid apricot `#cc5c2b` that read on light and dark taskbars alike (Q59, [themes.md](../themes.md)); at 32 px and under in the icon, the small cut: the network R with two larger nodes (stem top, bowl tip), drawn on each size's pixel grid so the nodes still read on the taskbar (issue #54); 24 px and under in the app, the in-app small cut (stem, bowl, leg). Drawn from Theme tokens in the app, never animated, never given a second accent. |

## Not us

- Glassmorphism, gradients, glows, drop shadows on resting UI, or illustrations of people.
- Spinners where an edge or a node can show progress.
- Toasts for things that belong in place (put errors where the problem is).
- Celebratory motion, bouncy springs on productivity actions, confetti.
- Emoji in our own copy (users' Host names may have them; we render them properly).
- "Dashboard" cards and charts. roster is a map and a terminal, not analytics.

*Proposed 2026-10-30 from decisions Q26–Q53. Refine it as the product grows, and record changes in `docs/app/decisions.md`.*
