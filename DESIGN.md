---
name: roster
description: A live map of your network and a fast, keyboard-first way into it.
colors:
  apricot-flare: "#ff9a70"
  apricot-ink: "#ffa076"
  sea-glass: "#82ccd5"
  ink: "#0f1011"
  chrome-graphite: "#141617"
  panel-graphite: "#171819"
  raised-graphite: "#1e1f20"
  raised-line: "#2c2d2e"
  hover-graphite: "#18191a"
  hairline: "#1f2021"
  hairline-strong: "#282a2b"
  paper: "#e8e8ea"
  muted-pewter: "#98989a"
  faint-pewter: "#69696a"
  signal-yellow: "#e9c944"
  raspberry: "#e25a98"
  danger-raspberry: "#b9205c"
  terminal-foreground: "#d4d4d6"
  apricot-flare-light: "#9b411a"
  sea-glass-light: "#296d82"
  paper-bg-light: "#f2f2f4"
  text-light: "#1e1f20"
  muted-light: "#5a5b5c"
typography:
  title:
    fontFamily: "Inter, system-ui, Segoe UI, sans-serif"
    fontSize: "17px"
    fontWeight: 500
    lineHeight: 1.4
  body:
    fontFamily: "Inter, system-ui, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.4
    fontFeature: "\"cv11\", \"calt\""
  body-small:
    fontFamily: "Inter, system-ui, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "Inter, system-ui, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    letterSpacing: "0.06em"
  data:
    fontFamily: "Iosevka, Cascadia Mono, Consolas, ui-monospace, monospace"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: 1.4
    fontFeature: "\"tnum\""
  data-small:
    fontFamily: "Iosevka, Cascadia Mono, Consolas, ui-monospace, monospace"
    fontSize: "14px"
    fontWeight: 500
    fontFeature: "\"tnum\""
  keycap:
    fontFamily: "Iosevka, Cascadia Mono, Consolas, ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1
rounded:
  sm: "4px"
  md: "6px"
  lg: "10px"
  pill: "999px"
spacing:
  xxs: "2px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  ml: "10px"
  lg: "12px"
  xl: "16px"
  xxl: "24px"
  row: "30px"
  titlebar: "32px"
  statusbar: "24px"
components:
  button:
    backgroundColor: "{colors.raised-graphite}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    height: "28px"
    padding: "0 12px"
  button-hover:
    backgroundColor: "{colors.hover-graphite}"
  button-primary:
    backgroundColor: "{colors.apricot-flare}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "28px"
    padding: "0 12px"
  icon-button:
    textColor: "{colors.muted-pewter}"
    rounded: "{rounded.md}"
    size: "24px"
  input:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
  keycap:
    backgroundColor: "{colors.raised-graphite}"
    textColor: "{colors.muted-pewter}"
    typography: "{typography.keycap}"
    rounded: "{rounded.sm}"
    height: "17px"
    padding: "0 4px"
  sidebar-row:
    textColor: "{colors.muted-pewter}"
    rounded: "{rounded.md}"
    height: "{spacing.row}"
  sidebar-row-raised:
    backgroundColor: "{colors.raised-graphite}"
    textColor: "{colors.paper}"
  sidebar-heading:
    textColor: "{colors.muted-pewter}"
    typography: "{typography.label}"
  picker:
    backgroundColor: "{colors.panel-graphite}"
    rounded: "{rounded.lg}"
    width: "680px"
  picker-row-selected:
    backgroundColor: "{colors.raised-graphite}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    padding: "8px 10px"
  statusbar:
    backgroundColor: "{colors.chrome-graphite}"
    textColor: "{colors.muted-pewter}"
    height: "{spacing.statusbar}"
    padding: "0 12px"
  badge-unreviewed:
    textColor: "{colors.signal-yellow}"
    rounded: "{rounded.sm}"
    padding: "0 5px"
---

# Design System: roster

<!-- Source of truth: every colour is a Theme token in app/src/theme/themes.ts (set on :root as
     --kebab-case variables); sizes, radii, type scale and motion are in app/src/styles.css. The
     frontmatter mirrors Roster dark (the default) plus Roster light's key tokens; when they
     disagree, the code wins. The identity behind it is docs/app/design/taste.md, which wins over
     this file and over any outside reference, except on accessibility. -->

## Overview

**Creative North Star: "The Live Network Map"**

roster is a map of your network you can step into. Hosts are nodes, Sessions are edges drawn from this Box to them, and the Gap orbit mark (the R in its orbit, broken where the Host connects) is the motif carried everywhere instead of decoration. Everything else is a near-black instrument panel that gets out of the way, because the terminal is the hero. The look borrows Linear's discipline: dense rows, one accent, 1px hairlines and short motion. The identity is roster's own.

The surface is dark, flat and dense: a 15px UI size, 30px rows, and graphite layers a few steps apart, separated by hairlines rather than shadows. Colour is almost absent. Apricot appears only where something is live or actionable *now*, so a screen with no live connection has almost none. Controls are **machined and tactile, with a terminal's crispness**: keycaps have a heavier bottom edge, buttons press to 97%, and rows rise into a raised fill with a 1px outline, like an instrument's switches. Navigation feels like Neovim. A key moves the cursor *instantly*, with no easing. A `:` command line completes as you type, the status line shows the mode in apricot, and there's a Leader key. Data sits on Iosevka's even monospace grid, so columns line up like a well-set buffer. The mouse is welcome, but the app is fastest from the keys.

Every token is a default the user can change. Themes, `init.lua` and Plugins restyle the whole app through the same CSS variables, so a component never hard-codes a colour. Confirmed rejections (taste.md, "Not us"): glassmorphism, gradients, glows, shadows on resting UI, illustrations of people, spinners, celebratory motion, emoji in our own copy, and dashboard cards and charts.

**Key Characteristics:**
- Near-black graphite layers (Ink to Raised Graphite), separated by hairlines.
- One accent, Apricot flare, spent only on what's live or actionable.
- Two voices of type: Iosevka for anything you could paste into a shell, Inter for the app talking to you.
- State shown by node *shape* (filled, ring, dashed, hollow), never by colour alone.
- Keycaps beside every action: keyboard discoverability is the onboarding.
- Motion of 150 ms or less, ease-out, transform and opacity only, and it confirms cause and effect.

## Colors

A neutral graphite palette with exactly one warm accent and one cool place-marker tone. Six bundled Themes (Roster dark and light, Gruvbox Dark, Nord, Catppuccin Mocha, Tokyo Night) remap the same 22 UI tokens plus 8 syntax tokens.

### Primary
- **Apricot Flare** (`accent`): the one accent. It marks the current Session's 2px bar, a live node, the primary button, focus rings, the App-mode cursor outline and the Host in the logo. On light themes it deepens to **Burnt Apricot** (`apricot-flare-light`) so white text reads on it.
- **Apricot Ink** (`accent-ink`): accent-coloured *text* on the background, such as the status bar's mode name, tuned separately for 4.5:1.

### Secondary
- **Sea Glass** (`tone`): place, not action. It marks this Box's square (in the status bar and the logo) and the dashed node of an unreviewed Host. It's used for shapes only: never text, never anything you can click. It deepens to **Deep Sea Glass** on light.

### Neutral
- **Ink** (`bg`): the workspace behind the terminal and the lock screen, which is also the terminal's background, so the terminal and app read as one surface.
- **Chrome Graphite** (`chrome`, `sidebar`): the title bar, status bar and Sidebar, one quiet step up from Ink.
- **Panel Graphite** (`panel`): floating surfaces such as the Picker, cards, error panels and the find bar.
- **Raised Graphite** (`raised`) with **Raised Line** (`raised-line`): the raised style for the selected row, the item on screen and a keycap's face.
- **Hover Graphite** (`hover`): the row or button under the pointer, barely visible on purpose.
- **Hairline** (`line`) and **Strong Hairline** (`line-strong`): borders between areas, and the borders of inputs and keycaps one step stronger.
- **Paper** (`text`): primary text. Paper is also Roster light's chrome.
- **Muted Pewter** (`muted`): secondary text such as inactive rows, addresses, counts, headings and hints. It reads at 4.5:1 on every surface.
- **Faint Pewter** (`faint`): never text. Icons, chevrons, outlines and rules only (Q53).

### Status
- **Signal Yellow** (`warn`): Pending changes, the unreviewed badge and message-line warnings (a slip in what you typed, such as an unknown command, is said in the text colour: it isn't a warning). It's yellow so it's never mistaken for apricot.
- **Raspberry** (`error`) and **Danger Raspberry** (`danger`): real failures, and the close button under the pointer. Never used to get attention.

### Named Rules
**The Accent Means Live Rule.** Apricot is spent only on what's connected or actionable *now*. Nothing decorative is apricot. Test: on a screen with no live Session, the accent should be nearly absent.

**The Place-Not-Action Rule.** Sea Glass marks *where* (this Box, an unreviewed Host) and is only ever a shape. If you could click it or read it, it isn't Sea Glass.

**The Faint-Is-Not-Text Rule.** Faint Pewter fails 4.5:1 by design. Text that needs to be quiet uses Muted Pewter.

**The Token-Only Rule.** No component names a colour. Every colour is a Theme token, so a Theme or Plugin can restyle everything.

## Typography

**Body Font:** Inter (with system-ui, Segoe UI, sans-serif)
**Data / Mono Font:** Iosevka 500 (with Cascadia Mono, Consolas, ui-monospace)

**Character:** Two voices. Inter is the app talking to you: labels, headings, copy. Iosevka is the machine: Host names, addresses, ports, fingerprints, keys, commands and terminal text. The narrow monospace makes dense data columns line up and read as "something you can paste."

### Hierarchy
The whole scale follows one `--ui-size` (15px by default, `fonts.ui_size`), and nothing goes under 11px.
- **Title** (500, 17px, 1.4): the Picker's query field and panel titles.
- **Landing** (19px, `--text-xl`): only the connect card's title, the moment a Session lands. The largest type in the app; there is no display tier.
- **Body** (400, 15px, 1.4): Sidebar rows, panel text, messages. Inter uses `cv11` and `calt`.
- **Body small** (400, 14px): secondary lines, Picker group/type columns, empty-state hints, the message line.
- **Label** (600, 12px (one step under the xs size, never under 11px), 0.06em, uppercase): Sidebar section headings (SESSIONS, FOLDERS, INVENTORY) and the idle pane's RECENT, nothing else.
- **Data** (Iosevka 500, 15px, tabular figures): Host names, the wordmark, terminal text.
- **Data small** (Iosevka 500, 14px or 13px, tabular figures, muted): IPs, ports, counts, the status bar's numbers.
- **Keycap** (Iosevka 500, 13px, line-height 1): every key hint.

### Named Rules
**The Paste Test Rule.** If it's something you could paste into a shell, it's in Iosevka. Everything else is Inter.

**The Never-Cut-Mid-Token Rule.** IPs, ports and fingerprints are never truncated mid-token. Data cells use tabular numbers. A long address drops whole groups from its middle (`fe80::…:4567:890a%eth0`), and the whole value is one step away (a tooltip, the Picker's detail strip).

## Layout

A fixed desktop shell rather than a page:
- a 32px title bar (logo, toolbar, window controls)
- a Sidebar of `19 × ui-size` (285px), with Sessions, Folders and Inventory sections
- the terminal pane taking all remaining space
- a 24px status bar that reads like a tmux line

Floating pieces sit over the terminal: the Picker (up to 680px wide, 12vh from the top, at most 68vh tall), side panels (320px Key bindings) and full-window panels. A single z-order rule keeps them in order: float 5, full 6, full-top 7, over-full 8, and the Picker and lock above them all.

Density is high and regular. Rows are `2 × ui-size` (30px), and spacing runs on small steps (2, 4, 6, 8, 10, 12, 16, 24px), with 6 to 12px doing most of the work. The minimum window is 480 × 320. Under 1040px, side panels float over the terminal instead of docking; under 720px the Sidebar floats over the terminal too (as in Focus), so the terminal keeps the window's width; under 640px the toolbar is icon-only. The window controls never give way. In the status bar, long values give way in a fixed order: the Inventory's path drops whole folders for one `…/` down to `~/…/roster.yml` (a folder name is never cut inside), then the hints go whole (last first), then the path drops to `…/roster.yml` and then goes, then the Backend's label, this Box's name and the Session on screen are cut, in that order; each segment is one line, and one that gives way is removed, never left as blank room. Each cut value has its whole text in a tooltip.

**The Terminal-Is-The-Hero Rule.** Chrome recedes. If a pixel isn't helping you reach or use a shell, it's quiet.

## Elevation & Depth

Flat at rest. Depth comes from tonal layering: Ink, then Chrome, Panel and Raised Graphite, each a few lightness steps apart, with 1px hairlines between areas. Shadows exist only on surfaces that *float* over the terminal, where they separate the surface from the live output beneath it. The shadow colour is itself a Theme token (`shadow`).

### Shadow Vocabulary
- **Overlay** (`box-shadow: 0 16px 48px var(--shadow), 0 2px 8px var(--shadow)`): the Picker and the command line's floating panel.
- **Float** (`box-shadow: 0 8px 24px var(--shadow)`): menus, cards and error panels over the terminal.
- **Side sheet** (`box-shadow: -8px 0 32px var(--shadow)`, mirrored for the left): a side panel floating over the terminal in a narrow window.
- **Raised outline** (`box-shadow: inset 0 0 0 1px var(--raised-line)`): not a shadow but an inset hairline. It's the raised style for selected rows, tabs and counts.

### Named Rules
**The Flat-At-Rest Rule.** Resting UI never casts a shadow. A shadow means "this is floating over your terminal and will go away."

## Shapes

Gently rounded and mostly rectangular:
- **Small, 4px:** keycaps and badges.
- **Medium, 6px:** buttons, inputs, rows and menus.
- **Large, 10px:** the Picker and large floating panels.
- **Pill, 999px:** counts in the toolbar.
- Window controls are square, matching the OS.

The one recurring geometry is the network's: **nodes** (6 to 7px circles whose fill or stroke carries state), **edges** (1px lines drawn between nodes), and **this Box's square** (6px, 1.5px radius, Sea Glass). Node shapes carry meaning. At rest every node is Muted Pewter; the Session on screen and its Host are apricot, other connected Sessions are Paper, the text colour (Q204, Q205):
- **Filled:** key login.
- **Ring:** password login.
- **Dashed ring:** unreviewed.
- **Hollow grey:** ended.
- **Open apricot ring** (a short gap at its upper right, where the logo's Host sits): connecting.
- **Edge stub:** a short 1px edge leaving a node whose Host has a Session, toward this Box (the one on screen apricot, others Paper), so "has a Session" is a shape too (Q213). Not on the Sessions list's own rows, where every row is a Session (Q228). With nine or more Sessions open, only the on-screen Host's node keeps it, in the Sidebar and the Picker alike; other live Hosts keep their colour (Q219 a, Q235).

With no Session open, the pane draws up to six recent Hosts (on a first launch, the Inventory's first reviewed Hosts, titled "In the Inventory") as a map under the mark: this Box's name and Sea Glass square, a hairline edge from the square to each Host's node (brighter under the pointer), and each Host a Sidebar-style row (node, Iosevka name, muted address), above Find a Host.

**The Nodes-And-Edges Rule.** The network's own shapes are the only ornament. The Gap orbit mark appears small and still (48 to 64px, muted) in empty states and on the lock screen, and is never used as wallpaper.

## Components

Machined and tactile, with a terminal's crispness: every control is a precise, quiet instrument part with one crisp physical cue, and everything driven from the keyboard responds the way Neovim does, at once.

**The Instant Keys Rule.** What a key moves, it moves immediately: the Sidebar cursor, the live bar, the Picker's selection and the command line's completions don't animate. Motion is kept for things that *arrive* or *connect* (a panel entering, an edge drawing), never for keyboard navigation. Test: holding `j` should feel like scrolling a buffer, not watching a transition.

**The Modal Clarity Rule.** The current mode is always readable at a glance in the status line (Inter 600, tracked 0.04em, Apricot Ink). Every command has a `:` form that completes, as in Neovim.

### Buttons
- **Shape:** gently rounded (6px), 28px tall, 12px side padding, Inter 500.
- **Default:** a Raised Graphite face with a Strong Hairline border.
- **Primary:** Apricot Flare fill with Ink text, borderless. On hover it mixes 12% toward the text colour.
- **Hover / Focus / Active:** hover moves to Hover Graphite (on fine pointers only). Focus is a 2px Ink gap plus a 2px accent ring. Pressing scales to 0.97 over 120ms ease-out. Disabled is 60% opacity.
- **Icon button:** a borderless 24px square with a muted glyph that turns Paper on hover.
- **Toolbar buttons:** transparent and muted at rest, 24px tall, with no motion of their own because they're used many times a day.

### Inputs / Fields
- **Style:** an Ink fill, Strong Hairline border, 6px radius, inheriting the UI font. The placeholder uses Muted Pewter.
- **Focus:** the border turns apricot, with a 3px apricot halo at 22% opacity.
- **Picker query:** borderless and transparent at 17px, so the search reads as the panel's title.

### Keycaps (signature)
- **Style:** Iosevka 500 at 13px, a 17px tall cap, Raised Graphite face, Strong Hairline border with a **1.5px bottom edge**, the tactile cue of a real key. 4px radius, muted text.
- **Use:** beside every action (in the status bar, Picker footer, empty states, menus and the command line) and on the docs website. `ui.hints = false` hides them visually but keeps them for assistive tech.

### Sidebar rows (signature)
- **Default:** 30px tall, 6px radius, muted text, with a node at the start and an Iosevka address at the end in muted tabular figures.
- **Hover:** Hover Graphite with Paper text.
- **Raised (on screen):** Raised Graphite fill with a 1px inset Raised Line.
- **Live Session:** raised, plus a **2px apricot bar** at the start, inset 5px top and bottom. It moves with a key, so it doesn't animate.
- **App-mode cursor:** raised, with a 1px inset *apricot* outline and no bar. It is the one cursor style: the Picker's and Finder's selected row and the focused row-menu item wear it too.
- **Pending (added, not Published):** content at 60% opacity, with a hollow muted node.
- **Section headings:** 12px uppercase Inter 600, tracked 0.06em, muted, with a tabular count at the right (left out at 0, where the section's sentence says it).
- **Ended or refused Session:** a hollow grey node, one word after the name that is never cut ("ended", "failed", "closed"; the code and the reason in its tooltip and the App-mode details), and a Reconnect button (↻, `reconnect N`) always on the row (Q238).
- **A row's own trouble:** what a row's command says went wrong (an unreviewed Host that won't open, a refused Folder or group change) floats under the row on the row menu's surface, in the message line's words, until the next key or press; `:messages` keeps it. Typed commands still answer on the message line (Q238).
- **Row menu:** where it opens, its edges sit on row edges: from a key the tree scrolls up just enough for it to open under its row; opened upward it lands on a row edge, the extra room shared as padding. Group rules have 6px each side (Q238).

### Picker (signature)
- **Container:** Panel Graphite, Strong Hairline border, 10px radius, Overlay shadow, over a dimmed backdrop.
- **Rows:** one shared grid (subgrid) of node, name (an unreviewed Host's badge beside it, as in the Sidebar), IP, group and type, with a minimum height of 34px and 12px gaps. The node follows the Sidebar's rule (muted at rest, apricot when the Host has a Session). The Host name is Iosevka in Paper and the other columns are muted. A column is as wide as its widest value in the whole Inventory, so it holds still while you type; an IPv6 address drops whole groups from its middle. The name takes the spare room; the group takes what it needs up to 18ch, and on a Host with no type it also takes the empty type cell, from its own column's start (Q235). A long group is cut in its middle, measured to its column: its start, one "…", and its last whole parts ("fieldwork…and-storage"), whole in its tooltip (Q238). Under 600px only the node, name and IP stay.
- **Quick Connect row:** Quick Connect's own glyph (this Box's square, an edge, an open muted ring, as in the title bar), its ring where the rows' nodes sit (Q235).
- **No match:** what was searched, then what you can do: Add a Host with its keys where this roster can add one, and `user@address` (Iosevka) where Quick Connect is on (Q235).
- **Selected:** a raised fill with a 1px accent outline (the Sidebar cursor's), since it's the row Enter opens. It reveals the info button. Rows never wrap (Q214).
- **Detail:** when the selected row cuts its Host's name, the footer's free room (left of the count) shows the name whole, in Iosevka; otherwise it says nothing. An address never shrinks below its text (an IPv6 one drops whole groups first); the name, then the group, give way (Q221).
- **Matches:** what the query matched is underlined in the text colour (never the accent).
- **Footer:** 34px, with a tabular Host count and keycap hints (move, open, close). Warnings in the footer use Signal Yellow.

### Status bar
A tmux-like line on Chrome Graphite: `● backend  ■ this Box  ● esx-02  N Hosts  path`, with hints and mode at the right. The Session on screen is named with its node in Iosevka, in the text colour. Hints that name a command are also its buttons. The `●` is an apricot node, the `■` is the Sea Glass Box square, and data is in Iosevka. Pending changes is a quiet Signal Yellow segment with a hollow node: you can click it, but it isn't a button that shouts. It's one line that never wraps: when room runs out, the path drops whole folders for one `…/` down to its first folder and file name (`~/…/infra/roster.yml`, `~/…/roster.yml`; never a folder cut inside), the hints drop out whole (last first), then the path drops to `…/roster.yml` and then isn't drawn, then the backend's label, then this Box's name, each down to six characters, and the Session on screen last (Q209, Q230, Q236). The empty Inventory's pane draws the path whole when it fits and cuts it the same way when it doesn't.

### Badges
- **Unreviewed:** 13px Signal Yellow text with a 45%-yellow 1px border, 4px radius and 5px side padding.

### Connect card and lock screen (signature)
- **Connect card:** while a Session starts, the pane itself shows the map: no surface, no border, no shadow. It has this Box's square, an edge and the Host's open ring (160 to 240px wide as the pane grows, 12px above a 19px title; this Box's square about 10px beside an 18px Host ring whose gap faces the edge, the edge ending inside it over a faint dashed route), the Host and its address in Iosevka, and plain progress text (`ssh` in Iosevka). The edge reaches 40% while ssh starts and the Host's ring while it logs in (120ms each). The terminal stays hidden until its first byte, so no cursor blinks behind the card. From the start it shows the keys that close the Session, and from 3s it counts the seconds in Iosevka. When the shell answers, the ring closes (and fills, for a key login), the title says "Logged in to …" and holds for 220ms so the landing is seen, and the card fades before the terminal comes in, so its words never sit on the first output. Its height never changes: the phase line and the keys' line keep their room throughout. This Box's square is small (about 10px) beside the 16px Host ring, so the Host is the focus. It's never a spinner and never a blank terminal. The host-key and password questions keep the Panel Graphite surface, because they ask something, and a host-key question is titled as one ("Trust esx-02's host key?", its address on a muted line under it).
- **Lock screen:** the Gap orbit mark, the Box name in Iosevka, one field labelled with the vault ("Bitwarden master password") and nothing else; "Locked" is the dialog's name for assistive tech, not drawn. It covers the window instantly; no fade, because hiding Sessions must not lag.

### Motion
The tokens are `--ease-out` (`cubic-bezier(0.23, 1, 0.32, 1)`), 120ms press/fade/draw, 150ms move, and a 4px enter offset. Motion uses transform and opacity only. Under reduced motion, movement drops and fades stay. Every new or changed animation goes through the `animate` skill.

## Do's and Don'ts

### Do:
- **Do** use the raised style (Raised Graphite plus a 1px inset Raised Line) for selection, and add the 2px apricot bar only for the live Session.
- **Do** put Host names, IPs, ports, keys and commands in Iosevka 500 with tabular figures, at Muted Pewter for secondary data.
- **Do** show state with node shape (filled, ring, dashed, hollow) plus words, never colour alone. Nodes are Muted Pewter at rest and apricot only while their Host is live.
- **Do** put the keycap for the next action beside every empty state, footer and menu item.
- **Do** make keyboard navigation instant (no transition on cursor, selection or live-bar moves), as in Neovim.
- **Do** keep motion under 150ms, ease-out, transform and opacity only, interruptible and off under reduced motion.
- **Do** draw every colour from a Theme token so `init.lua`, Themes and Plugins can restyle it; Plugin UI uses the same tokens and components as built-ins.
- **Do** use the Gap orbit mark small (48 to 64px) and still, at reduced opacity, for empty states and the lock screen.

### Don't:
- **Don't** spend apricot on anything that isn't live or actionable now. No decorative accent.
- **Don't** use Faint Pewter for text, or Sea Glass for text or anything clickable.
- **Don't** add shadows, gradients, glows or glass to resting surfaces. Shadows are for floating surfaces only.
- **Don't** use spinners where an edge or node can show progress, or toasts for errors that belong in place.
- **Don't** add celebratory motion, bouncy springs, confetti or emoji in our own copy.
- **Don't** build "dashboard" cards or charts. roster is a map and a terminal.
- **Don't** truncate an IP, port or fingerprint mid-token.
- **Don't** animate the lock cover. It's instant.
