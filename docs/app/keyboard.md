# Keyboard

Keyboard first, with vim keys and full mouse support. Every binding lives in one keymap. Your `init.lua` ([docs/app/config.md](config.md)) can change the Leader, rebind any key to an action (`keys = { leader = { t = "next" } }`), and turn vim bindings off.

## Two modes

- **Terminal mode:** every key goes to the shell, including Esc, Ctrl+C and Ctrl+W. Only the **Leader** (Ctrl+Space by default), the keymap's `global` keys (F11) and its `terminal` keys (copy, paste, find, zoom; below) are caught. Ctrl+C is caught only while text is selected, as in Windows Terminal.
- **App mode:** after the Leader, or whenever the Picker, a panel or the command line has focus. Vim bindings apply. Esc goes back to the terminal you came from.

The same keys on Windows and Linux: Ctrl, never a Windows-only key. While an input method (IBus or Fcitx on Linux, the Windows IME) is composing, its keys are its own: the Enter that commits a word doesn't also choose a Picker row or run a binding. Some input methods take Ctrl+Space to switch languages (Fcitx does by default) and the app never sees it; set another Leader in `init.lua` (`leader = "ctrl+b"`, [config.md](config.md)) or change the input method's switch key.

## How keys become actions

Every action is a command in one command table (`app/src/commands/table.ts`), named as the `:` command line names it. The keymap maps a key, or a sequence such as `d d`, to a command line (`session 1`, `close`), so a binding, a typed `:` command and a button (the Sidebar's rows, the tab strip) all run the same command. View modes (ticket 22) only change how commands are shown. Commands, bindings and Sidebar sections are registries (ADR 0006): each entry carries its source (`builtin`, `init.lua`, or a Plugin), which the Key bindings panel shows.

After the Leader you're in App mode until Esc, or until a command that isn't list movement runs: `␣ ]` switches and hands the keys straight back to the new Session's terminal, while `␣ j` / `␣ k` move the Sidebar's cursor and stay in App mode until Enter (switch) or Esc. An unbound key in App mode is swallowed, never sent to the shell. The Picker, the command line and the bindings filter take their own keys.

## Default bindings

| Keys | Command | Action |
|---|---|---|
| `<leader> f` | `find` | Open the Picker |
| — | `connect HOST` | Open a Session to HOST |
| In the Picker: Ctrl+Enter | `here HOST` | Open HOST in the current tab if its Session has ended (else a new one) |
| `<leader> r` | `reconnect` | Reconnect the current Session if it has ended or was refused |
| `<leader> p` | `fill` | Fill sudo's password prompt in the current Session (`[sudo] password for USER:`, USER the Host's login user) with the Host's password from the vault: its `sudo: {auth}` in `roster.yml`, else its ssh Login. Offered, with a note in the pane's corner, only while that prompt is at the cursor; with shell integration, only while the command running is sudo itself. Without it the note says roster can't tell whether you're still on the Host. The password goes from serve to the Session's PTY, never through the window, and only once roster has checked that the prompt doesn't echo. su's `Password:` is never filled. A nested ssh to an Inventory Host (with shell integration): its login prompt while it logs in, and that Host's sudo at the first command its marked shell runs, from that Host's own Login (API 26; [A nested ssh](security.md#a-nested-ssh)). Needs API 25. See [security.md](security.md#filling-a-password-prompt) |
| `<leader> ]` / `[` | `next` / `prev` | Next / previous Session (wraps) |
| `<leader> 1`–`9` | `session N` | Go to Session N |
| `<leader> d d` | `close [N]` | Close the current Session (or Session N) |
| `<leader> e` | `sidebar` | Show or hide the Sidebar, in Standard and Focus; also the Sidebar button at the left of the title bar. The State keeps the choice per mode unless `init.lua` sets `modes.<mode>.sidebar`, which wins (issue #54) |
| `<leader> t` | `finder tree` | The Sidebar's tree (Folders and the Inventory) as a finder |
| `<leader> s` | `statusbar` | Show or hide the status bar, and say the option that keeps it |
| `<leader> :` | `cmdline` | Command line, with Tab completion for commands and their arguments (see below) |
| `<leader> ?` | `help [TOPIC]` | Help, like Neovim's `:help` (ticket 37): with no topic, the topic finder; `:help terminal.size`, `:help :connect`, `:help E13` open a page at that entry. Tab completes topics. See [help.md](help.md) |
| (no key) | `tutor [NAME]` | The tutorial, like Neovim's `:Tutor` (ticket 55): lessons whose steps tick themselves as you do them, on a demo Inventory of made-up Hosts, with your own Sessions kept behind it. It comes back where you left off. `:tutor quit` goes back to your Inventory, `:tutor reset` starts it over, `:tutor NAME` runs another tutorial (a Plugin's). See [help.md](help.md#the-tutor) |
| `<leader> F1` | `lookup` | Help on what's selected, like Neovim's `K` (which `␣ K` can't be here): a Host's row in the Sidebar opens `:connect`, another row the command it runs, nothing selected the topic finder. In the Key bindings panel's filter, F1 opens help on the first binding's option ([help.md](help.md#help-from-where-you-are)) |
| `<leader> K` | `keys` | Key bindings panel: the resolved keymap, grouped, with each binding's source and its option in `init.lua` (`keys.leader`), filterable |
| `<leader> L` | `lock` | Lock |
| (no key) | `vault signout` | Sign the vault CLI out, to sign in to a different account (ticket 42). It asks first, naming the account ("Sign out of you@example.com on this Box?"; Enter signs out, Esc keeps it), then locks and shows the full sign-in form. The lock screen's "Use a different account" does the same. KeePassXC, `pass`, `env` and `cmd` have no account: the command says why. Needs API 14 |
| `<leader> E` | `edit [HOST]` | Edit the Host under the cursor, or the current Session's (ticket 10). It opens at once; when the last pull of the infra repo is older than `pull_fresh_minutes` it pulls in the background, and Save waits for it (a pull that changed the Host updates the fields you hadn't touched and says so; a pull that fails blocks the save). Enter saves, Esc closes |
| `<leader> +`, `<leader> n` | `host add [GROUP]` | Add a Host (ticket 11), in GROUP or the cursor's group (also the `+` always shown on the Inventory heading, which starts in the cursor's group, and the `+` on a group heading). On a roster too old to add Hosts (API 6) the Inventory's `+` stays and says so, in its tooltip and when clicked: the form tests a Login first (host key confirmed, one login), then saves; Enter adds, Esc closes |
| `<leader> D` | `host remove [HOST]` | Remove the Host under the cursor from `roster.yml` (ticket 28), after a question that names it; its vault item stays. Also the × on its row |
| `<leader> R` | `host rename [HOST [NEW]]` | Rename a Host; what's left out, the command line asks for. Also the ✎ on its row |
| `<leader> M` | `host move [HOST [GROUP]]` | Move a Host to another group (Tab completes the groups). Also: drag it onto another group |
| `<leader> N` | `group new [NAME]` | Add an empty group. Also "New group" on the Inventory heading. `group rename [GROUP [NEW]]` and `group delete [GROUP [TO]]` have no key: the ✎ and × on a group heading run them; deleting a group with Hosts asks which group they go to |
| (no key) | `review [HOST]` | Mark an unreviewed Host reviewed, so it can be opened; also the ✓ button on its Sidebar row, Ctrl+R in the Picker, and "Mark reviewed" in `:edit` |
| (no key) | `host unreview [HOST]` (`unreview`) | Mark a reviewed Host unreviewed again (`reviewed: false`), for a review made by mistake, as a Pending change (API 9). While the review is still only a Pending change, the row's ↶ button (where the ✓ was) takes it back, leaving `roster.yml` as it was; `:discard` drops it with the rest. Also "Mark unreviewed" in `:edit`. `host review [HOST]` is `review` |
| `<leader> c` | `changes` | Show the Pending changes (the diff of `roster.yml`); `:discard` asks, then discards them; `:publish` shows the diff and the commit message (edit it; `Ctrl+Enter` publishes, `Esc` goes back) |
| `<leader> m` | `mode [standard\|focus]` | Switch the view mode (no argument: the other one) |
| F11 (any mode, no Leader) | `focus` | Focus on or off |
| `<leader> b` | `finder sessions` | Find a Session (the Finder over the `sessions` source) |
| — | `finder SOURCE` | The Finder over a finder source: `sessions`, `hosts`, `tree` (Folders and Inventory), `folders`, `inventory`. Enter runs the item's command, Esc closes; the Picker's keys move |
| Esc (App mode) | `terminal` | Back to the terminal, closing the topmost side panel (Key bindings, `:check`, then Host details) if one is open |
| — | `hidepanel` | Close the topmost side panel (bind it in `init.lua`) |
| `<leader> z` | `panel` (`panel toggle`) | The panel or view with focus, else the one used last: full window, or docked beside the terminal again, as tmux's prefix z zooms a pane. Also the button by its close button. It stays in App mode, so `z` again switches it back. In a panel made full window, Esc docks it first ([Panels](#panels-docked-or-full-window)) |
| `<leader> <` / `<leader> >` | `panel narrower` / `panel wider` | Narrow or widen that panel by 5% of the window, as Vim's Ctrl+W < and >; `<` and `>` again keep going until Esc. From full window, `<` docks it. `:panel width N` sets N% (10 to 95), `:panel full`, `:panel dock` choose one, `:panel reset` forgets your choice (init.lua's `views` and `panel.width`, else the panel's own, apply again) |
| On a panel's edge (a separator): a drag; ← →, Home / End; a double click | — | Resize it: the panel follows the pointer over the terminal, and the terminal fits its new size once you let go. An arrow moves the edge 2% that way, Home and End to the narrowest and widest, a double click back to its default |
| — | `hints [on\|off\|toggle]` | Show or hide every keycap hint (no word: toggle). The choice is kept in the State unless `init.lua` sets `ui.hints`, which wins ([config.md](config.md)). Hidden hints only go out of sight: every binding still works |
| — | `messages [all\|quiet\|toggle\|clear]` | Alone: the recent messages, quiet ones too, oldest first (as Neovim's `:messages`), in a view. `all` shows every message on the message line, routine confirmations and tips too; `quiet` (the default) only errors, warnings, answers and results that need attention; `toggle` switches; `clear` forgets the list. The choice is kept in the State unless `init.lua` sets `ui.messages`, which wins ([config.md](config.md)). Quiet, a screen reader still hears what changed |
| — | `info` | Alone: say the Backend, the Box and the Inventory's path whole (the status bar cuts them), the roster command, the terminal font and size, the renderer the terminal on screen draws with (`WebGL`, `DOM`, `DOM (no WebGL here)` when no WebGL context could be made, `DOM (WebGL context lost)`), and once the Picker has opened, how long it took (`Picker opened in 12 ms`: from the key to the frame it's drawn in) |
| — | `info HOST` | Host details (ticket 18, decision Q71): a side panel opposite the Sidebar with what `roster info HOST` shows (address, type, product, description, services, the Vault item each Login uses by name, enrolled and reviewed). Tab completes Host names. Also the ⓘ on every Host row in the tree, the ⓘ on the Picker's selected row (never on hover), and Ctrl+I in the Picker. In Focus it floats over the terminal, like the Sidebar. Esc (App mode) closes it with the other side panels |
| — | `check [HOST\|%]` | With no Host, this Box's health, as Neovim's `:checkhealth`: each section's checks with the fix for any that fails ([Health](health)). With HOST, that Host's diagnostics, as `roster check HOST`: which step fails and what to do; `%` is the Host of the Session on screen |
| `<leader> i` | `details` | Show or hide Host details for the selected Host (the Sidebar's cursor, else the Session on screen); also the Host details toggle by the window's buttons (toolbar id `details`), pressed while they show |
| `<leader> S` | `source [PATH]` (`so`) | Reload the Config now, Neovim-style: `init.lua` and its modules; with PATH, only the file that owns it. Saving doesn't reload unless `auto_reload = true` (decision Q58) |
| — | `plugins [install PATH\|remove NAME\|reload NAME\|revoke NAME PERM\|grant NAME PERM]` | The Plugins: with no word, the panel (each Plugin, whether it runs, its permissions as switches, what it did lately); `install` asks first, naming every permission ([plugins.md](../plugins.md)). The prompt opens with the keys on Cancel (Keep, Not now), so a stray `Enter` never installs: `Shift+Tab` `Enter` installs or allows, `Esc` declines |
| — | `view [ID]` | Open a view a Plugin added (ticket 76): a side panel beside the terminal, or a full view over the whole window, as the Plugin's `place` says until you move it (`␣ z`). With no ID, the `views` finder lists them all (`finder views`). Tab completes ids. A Plugin binds its own key to `view ID`. Esc closes it and puts focus back where it was ([plugins.md](../plugins.md#views-tables-and-host-details-sections)) |
| In a table (a view's, a Host-details section's): `j`/`k`, arrows, `g g`/`G`, Home/End, Ctrl+D/U, PageUp/PageDown | — | Move the selected row (it keeps its row as the table sorts or the Plugin updates it) |
| In a table: `s` / `S`, a click on a heading | — | Sort by the next column (after the last, the order the Plugin gave) / reverse it; a heading's click sorts by it, again reverses |
| In a table: Enter, a double click; an action's own key | — | Open the row (what the Plugin says; a Host's row opens the Host); run that action on the selected row, whose buttons show on it (an action that doesn't apply to the row isn't offered, ticket 78). A Plugin can't take `j k g G s S / ? q` |
| In a table: a long name or address | — | A data column's value too long for its width is cut in the middle, its end kept (`server-10-1…77-203`), so names that differ only at the end still differ; the whole value is in its tooltip. A table too narrow for its columns scrolls sideways |
| In a table: `/`; then Enter (or ↓), Esc | — | Filter the rows to those saying every word typed (ticket 78); Enter keeps the filter and goes back to the rows, Esc clears it. With a filter in place, the first Esc clears it and the next closes the view |
| — | `cancel [ID]` | Stop something long a Plugin is doing, shown in the status bar (ticket 78): its `cancel` runs once and it says "stopping…". With no ID, the latest that can be stopped; Tab completes ids. Also the × beside it in the status bar ([plugins.md](../plugins.md#asking-progress-the-toolbar-and-going-places)) |
| In a view, or a Host-details section: a heading button's own key | — | Run that button (a Plugin's `actions` on the view's or section's heading, such as the Mesh controls' Cut on a Host's Mesh section, `x`), from anywhere in it: its key is in the button's tooltip. The table's or graph's own keys and its actions' keys come first, and a text field (a table's filter) keeps its letters |
| In a Plugin's question: Enter, Esc; `Shift+Tab` then Enter in its stronger form | — | Confirm (the button's word), or cancel. The stronger form (a Mesh Cut) opens on Cancel, so Enter declines until you move to the action; when it asks you to type a word (a Host's name), its button works once that's typed, and Enter in the field confirms. A held-down Enter answers nothing |
| In a Plugin's floating window: an action's key; `q`, Esc | — | Run that button; close the window |
| In a graph (a view's, ticket 77): `h` `j` `k` `l`, arrows | — | Go to the nearest node that way. Selecting a node lights up what it reaches and what reaches it, with the counts under the graph ([plugins.md](../plugins.md#graphs)) |
| In a graph: `/`, then Enter or Esc; `n` / `N` | — | Search the nodes for every word typed, as a table's filter does (in the name, id, kind, note, detail or cluster); the rest dims: Enter (or ↓) goes to the next match, Esc clears; go to the next / previous match. Esc in the graph clears a search first, then a filter, then closes the view |
| In a graph: `f`, then Enter, Space or ↓; in its menu ↑ ↓ (Ctrl+P / Ctrl+N), Home, End, a letter, Space, Enter; Esc | — | Filter: show only some clusters, kinds or states (live, down, warning, error) and hide the rest, a menu button each. Enter, Space or ↓ opens the menu on the first ticked value; ↑ ↓ move, a letter goes to the next value starting with it, Space ticks or unticks and stays (tick as many as you like), Enter ticks and closes, and "Every …" shows all of them again. Esc closes the menu, Esc on its button goes back to the graph, and Esc there shows everything again. The list (`t`) shows what the graph shows; a list with nothing in it keeps the focus, so `t` still goes on |
| In a graph: `m`, then `h` `j` `k` `l` or the arrows (Shift, or `H` `J` `K` `L`, for a bigger step); Enter or `m`; Esc | — | Move the selected node from the keyboard: its ring turns dashed while it moves, `+` `-` `0` still zoom, and the other keys wait. Enter (or `m`) keeps the new place in the State, as a drag does; Esc puts it back where it was |
| In a graph: `o` / `O`, Enter on a collapsed cluster | — | Collapse or open the selected node's cluster / every cluster; open that cluster |
| In a graph: `+` `=` / `-`, `0`; `H` `J` `K` `L`, Shift+arrows; the wheel, a drag | — | Zoom in / out around the selected node, show it all; pan; zoom where the pointer is; a drag on a node moves it (kept in the State), elsewhere pans |
| In a graph: Enter, a double click; an action's own key; `t` | — | Open the node (what the Plugin says; a Host's node opens the Host); run that action on the selected node; switch to the list of every node, then every edge, then back. A Plugin can't take `h j k l H J K L g G n N o O t f m s S / ? q + - = 0` (`s` and `S` sort the node list). An action with `when` runs, and shows its key, only on the nodes it names |
| `<leader> T`, `:topology [GROUP]` (the Topology Plugin) | — | The Topology view: this Box, every Host by group and the Mesh ([plugins/topology](../../plugins/topology/README.md)); with GROUP, only that group. On a Host: Enter opens a Session, `i` its details, `c` runs `:check HOST`, `x` cuts it from the Mesh after you type its name. Only with the Plugin installed; its `leader` setting picks the key |
| — | `packages [update [NAME]\|install NAME\|clean]` | The Packages `init.lua` names: with no word, the panel (each one's commit, what `init.lua` asks for, whether it runs, or that you cancelled its install); `update` fetches and shows each new commit with its diff and any new permission before applying it (Esc keeps the old version), and `update NAME` does it for that Package only; `install NAME` asks again about a Package whose install you cancelled; `clean` removes the ones `init.lua` no longer names ([plugins.md](../plugins.md#packages)) |
| — | `config [reload\|path]` | Open `init.lua` (made from the commented-out example the first time, never overwritten), read it again, or say where it is ([config.md](config.md)) |
| In the Sidebar (App mode): `j`/`k`, `g g`/`G`, arrows, Home/End, Enter | `down` `up` `top` `bottom` `choose` | Move, jump, choose: a Session switches, a Host opens (or goes to its Session), a group, Folder or heading folds and you stay in the Sidebar. `j`/`k`/`g g`/`G` only with vim on |
| In the Sidebar: `h` / `l`, ← / → | `fold` / `unfold` | Fold the row (or go to its parent); unfold it (or go to its first child). `h`/`l` only with vim on |
| — | `fold ID` / `unfold ID` / `togglefold ID` | Fold a row or section by id: `section:sessions`, `section:folders`, `section:inventory`, `group:subnet-42`, `folders:Lab ESXi` (a Folder; `folder:…` in older versions). A click on a heading, group or Folder runs `togglefold`. What's folded is kept in State |
| — | `open HOST` | Go to HOST's open Session, or open one (what a Host row in the tree runs). Also takes an open Session's name (a Quick Connect's `user@address`, or a Host no longer in the Inventory) and a Quick Connect address, `user@address[:port]`, which it connects to |
| — | `open SERVICE`, `open HOST SERVICE` | Open a web service (http or https) in the default browser (ticket 18): SERVICE of the Host in Host details (else the selected Host), or of HOST. A Host's name, an open Session's or a Quick Connect address wins over a service of the same name. Tab completes the current Host's web services first, then Host names, then HOST's services. Also each service's Open button in Host details |
| `<leader> a` | `folder add` | Add the Host under the cursor (or on screen) to a Folder: opens the command line at `folder add HOST ` for the Folder's name (Tab completes; a new name creates the Folder) |
| `<leader> A` | `folder remove` | Remove the Host under the cursor from its Folder |
| — | `folder new NAME`, `folder rename NAME NEW`, `folder delete NAME`, `folder add HOST NAME`, `folder remove HOST NAME` | Folders (GLOSSARY), kept by the built-in Folders Plugin in its own data folder. Names may have spaces; quote one (`"Lab ESXi"`) only where it would be ambiguous. Without a name, `new` and `rename` open the command line for it |
| In the Picker: Ctrl+N/P, arrow keys | — | Move (they also work with vim off) |
| In the Picker and every finder: Tab / Shift+Tab | `picker.next` / `picker.prev` | Next / previous result, wrapping. Before you've moved, Tab first fills the query with what the matching names share (`es` → `esxi-0` when `esxi-01` and `esxi-02` match), as a shell does |
| In the Picker: Ctrl+I | `picker.info` | The selected Host's details (closes the Picker) |
| In the Picker and every finder: F1 | `picker.help` | Help on the selected result: a Host opens `:connect`, a Theme its entry (`themes#nord`), a help topic itself, anything else the command Enter runs ([help.md](help.md#help-from-where-you-are)) |
| In the Picker: `j`/`k` | — | Move, once you've moved with Ctrl+N/P or an arrow. Until then letters go to the query, and any other letter goes back to it |
| Terminal: Ctrl+Shift+C/V, Ctrl+Insert / Shift+Insert, Ctrl+C with a selection, select to copy, right-click; Ctrl+Shift+F; Ctrl+= / Ctrl+- / Ctrl+0 | — | Clipboard, find, zoom (the keymap's `terminal` table; see "Copy and paste" below) |

## Panels: docked or full window

Every panel and view (ticket 95): `:help`, Host details, Edit, Add, Pending changes, Save to vault, `:check`, Key bindings, `:plugins`, `:packages` and every Plugin view (Topology, Discover, the Mesh controls) can be:

- **docked** beside the terminal, at the width you pick: `␣ <` and `␣ >`, or a drag of its edge (the hairline shows on hover and on focus, and the edge is a keyboard separator: Tab to it, then ← →);
- **full window**, over the Sidebar and the terminal (the title and status bars stay): `␣ z`, or the button by its close button. The terminal keeps running underneath, at the size it had.

Esc in a panel made full window docks it first. Esc in a text field stays the field's: in a form made full window (Edit, Add, Save to vault) it closes the form, as it does docked.

`␣ z`, `␣ <` and `␣ >` act on the panel that has focus, else the one you used last. What you choose is kept in the State per panel, so help opens full window next time if you left it so. `init.lua` sets the defaults (`panel.width`, and `views = { topology = { place = "panel", width = 60 } }`, [config.md](config.md)); your choice wins over them until `:panel reset`. A Plugin's `place` is only where its view first opens.

Limits keep the terminal usable: a docked panel is never narrower than 280 px, and the terminal keeps about 50 columns (400 px) however many panels are docked beside it: they share one limit, each narrowing in proportion to its width, and a panel widens (`␣ >`, a drag) only into room the terminal and the other panels can spare (#176). When their 280 px each don't fit beside a 400 px terminal, and in Focus and in a window under 1,040 px, panels float over the terminal instead, side by side from their edge in the order they'd dock in, never on top of each other; together they may cover all of it but a 48 px sliver, and floats too wide for that are narrowed in proportion. While you drag, the panel moves over the terminal; the terminal fits its new size once, when you let go (a resized Session prints its screen again, ticket 73). Nothing animates: a key or a click is its own confirmation.

What lies over what is one rule: a docked panel opened over a full one (Host details from Topology's `i`) comes over it; of two full-window panels, the one used last is on top; a question or a Plugin's float comes over everything but the Picker, the command line and the lock.

## Copy and paste

In a terminal, as in Windows Terminal. These are the keymap's `terminal` table (`keys.terminal` in `init.lua`), so each can be moved or unbound, and the Key bindings panel (`␣ K`) lists them:

| Keys | Action | What it does |
|---|---|---|
| Ctrl+Shift+C, Ctrl+Insert | `terminal.copy` | Copy the selection |
| Ctrl+C | `terminal.copyIfSelected` | With a selection: copy it and clear it. Without one, Ctrl+C goes to the shell as usual (its interrupt) |
| Ctrl+Shift+V, Shift+Insert | `terminal.paste` | Paste |
| Select with the mouse | (`terminal.copy_on_select`) | Copies the selection, unless `copy_on_select = false` |
| Right-click | (`terminal.right_click_paste`) | Copies the selection and clears it, or pastes when nothing is selected |

Ctrl+V is the shell's (`quoted-insert`, Vim's block selection). To paste with it anyway: `keys = { terminal = { ["Ctrl+v"] = "terminal.paste" } }`. A paste goes to the shell as xterm.js sends it: each line end as Enter, and the whole paste between bracketed-paste marks when the shell asked for them (bash, zsh, fish and Vim do), so several lines land in the prompt instead of running one by one. What's copied or pasted goes only between the clipboard and the terminal, never into a log or the State ([security.md](security.md)).

In every text field (the lock screen, the command line, the Picker and finders, the bindings filter, the add and edit forms) the usual editing keys belong to the field: Ctrl+C / Ctrl+X / Ctrl+V, Ctrl+Insert / Shift+Insert, Ctrl+A, Ctrl+Z / Ctrl+Shift+Z. The keymap never takes them there, and right-click shows the WebView's own Cut / Copy / Paste menu. The release build reads and writes the clipboard through Tauri's clipboard plugin (`clipboard-manager:allow-read-text` and `allow-write-text` in `app/src-tauri/capabilities/default.json`), since WebView2 won't let the page read it.

## Completion in the command line

The command line completes like bash or zsh, and like Neovim's wildmenu. The candidates for what's typed show in a list above the line: command names (with what each does and its key), then each command's arguments: Hosts (`connect`, `open`, `edit`, `check`, `review`), Folders (`folder add HOST `), Themes, finder sources, view modes, `:config`'s and `:vault`'s subcommands, `:source`'s files, the Sidebar's rows for `fold` (`group:subnet-42`, `folders:Lab`, `section:sessions`) and the open Sessions' numbers for `session` and `close`. They come from each command's `complete` hook and the registries, so a command from the Config or a Plugin completes the same way.

| Keys (`keys.cmdline`) | Action | What it does |
|---|---|---|
| Tab, Ctrl+N | `cmdline.next` | First fills in the longest prefix the candidates share; once there's nothing more to fill, the next candidate (wrapping) |
| Shift+Tab, Ctrl+P | `cmdline.prev` | The previous candidate |
| Ctrl+Y | `cmdline.accept` | Accept the candidate in the line; the list then shows the next argument's |
| Enter | `cmdline.run` | Run the line. On a command that still needs its argument (`connect `) it only accepts it |
| Esc | `cmdline.cancel` | Cancel the completion, back to what you typed; a second Esc closes the line |
| Ctrl+], F1 | `cmdline.help` | Help on the command you're typing (`:conn` → `:help :connect`; nothing typed: the Commands page). Esc in help brings the line back as it was, the cursor too ([help.md](help.md#help-from-where-you-are)) |

Typing anything also accepts the candidate. A click on one accepts it too.

With the mouse: click a Host to open it (or go to its Session), drag it onto a Folder (or the Folders heading) to add it, and drag it out of a Folder onto any other part of the Sidebar to remove it. Folder rows have rename (✎) and delete (×) buttons, and the Folders heading has + for a new one.

A row's buttons (ⓘ, ✎, ×, ✓ and the rest) show on the selected row only: the row you last clicked, or in App mode the cursor row, so j/k move them. Hovering a row shows none of them, and its address stays in view. The Inventory heading's + (Add a Host) is always there.

## View modes

Standard and Focus (decision Q36) differ only in their layout; every command works in both. In Focus the window is fullscreen with only the terminal, and keys that act on Standard's pieces reach the same things another way:

| Keys | In Standard | In Focus |
|---|---|---|
| `<leader> e` (`sidebar`) | Show or hide the Sidebar | Show or hide the Sidebar, over the terminal (issue #54) |
| `<leader> t` (`finder tree`) | The tree finder: Folders and the Inventory, with paths | The same |
| `<leader> s` (`statusbar`) | Show or hide the status bar | Show or hide the session bar (`[box] 1:esxi-02* 2:orion3-`, off by default; option `focus.sessionbar = "top" \| "bottom" \| false`) |
| `<leader> ?`, `<leader> K`, `<leader> :`, `:check HOST`, `:check` (help) | Panels beside the terminal | The same panels, over the terminal |

A hint shows for about 2 s on entering Focus. The session bar's numbers are what `<leader> N` takes; `*` is the Session on screen and `-` the one before it, which the Session finder selects first.

The platform's usual habits apply: ⌘ on macOS, Ctrl on Windows and Linux. Form fields stay ordinary text inputs in v1.

## See also

[Quick reference](quickref) · [Key bindings](keys) · [Recipes](recipes.md) · [Your init.lua](config.md)
