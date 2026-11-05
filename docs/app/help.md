# Help: `:help`

The app has its own docs inside it, the way Neovim's `:help` does (ticket 37, decisions Q66 and Q73). They open in a panel beside the terminal (over it in Focus or a narrow window), like the Key bindings panel. New to roster? `:help start` is the place to begin.

## Opening it

| Keys or command | What it does |
|---|---|
| `␣ ?`, `:help` | The topic finder: every page and every entry on one, fuzzy-matched. Each row reads title, page, tag: an entry's title says what it is after its name (`E31 · Pick Bitwarden cloud…`), the page is always the page it's on, and the tag (what you'd type after `:help`) is left out where the title already is it; a long tag is cut in its middle, its end kept. With two words or more, a title holding them as one phrase ranks first, then one holding them all. Enter opens it |
| `:help TOPIC` | Opens TOPIC: a page (`:help options`), an option (`:help terminal.size`), a command (`:help :connect`, or `:help connect`), an error (`:help E13`), a Theme (`:help themes#nord`), a guide's heading (`:help config#the-sandbox`) or another name for one (`:help roster.yml`, `:help init.lua`). A topic that isn't exact opens the best fuzzy match. Tab completes topics |
| `:help TOPIC /TEXT` | Opens TOPIC and searches the page for TEXT, from the topic on |
| `:helpgrep TEXT` | Searches the text of every page (see [Searching every page](#searching-every-page)) |

## Links

You followed a link, or typed `:help links`. `Ctrl+o` goes back to where you were, and `Ctrl+i` forward again: help keeps the way you came, like a browser's back and forward (Neovim's jump list). The ‹ and › buttons at the top do the same.

To follow a link, Tab to it and press Enter (or `Ctrl+]`, as in Neovim), or click it. Code that names a topic is a link too: `:source`, `ui.hints`, `:help options`. A link to a file that isn't in help, such as `examples/init.lua`, shows as its text; hover it to see the path.

## Moving around

| Keys | What it does |
|---|---|
| `Tab`, `Enter` | Next link, follow it. `Ctrl+]` follows it too |
| `Ctrl+o` / `Ctrl+i` | Back, forward (also Alt+← and Alt+→, and the ‹ › buttons) |
| `j` / `k`, arrows | Scroll (`j` and `k` with vim keys on) |
| `Ctrl+d` / `Ctrl+u` | Half a page down, up |
| `g g` / `G` | Top, bottom (with vim keys on) |
| `g O` | The outline of this page (below) |
| `/`, then `n` / `N` | Search the page; next and previous match. In the search field, Enter and Shift+Enter move too, and Esc leaves it |
| `?` | The topic finder |
| `Esc`, `q` | Close help; focus goes back where it was (the terminal) |

Prose is in Inter and anything you could type or paste (commands, options, values, file names) in Iosevka; keys are keycaps. The keys in help's tables are what the page is about, so they show even with `ui.hints = false`, as in the Key bindings panel. Only the footer's hint line hides.

## The outline

`g O` (or the Outline button) lists the open page's headings and entries in a finder: type to narrow it, Enter to jump there. It's Neovim's `gO`, and the quickest way around a long page such as [Your init.lua](config.md).

## Searching every page

`:helpgrep TEXT` searches the text of every page, generated ones included, the way Neovim's `:helpgrep` does. Each paragraph, list item, table row and entry that has all the words you typed is a result, with the page and heading it's under. Enter opens that place and searches the page for your first word, so `n` and `N` go on from there. `:helpgrep` alone opens the same finder empty.

`/` searches only the page you're on; `␣ ?` matches topic names, not text.

## Help from where you are

Help has no cursor of its own to look a word up under, as Neovim's `K` and `Ctrl+]` do, so the lookup keys work from where you already are:

| Where | Keys | Opens help on |
|---|---|---|
| The command line | `Ctrl+]`, `F1` | The command you're typing: `:conn` opens `:connect`. With nothing typed, the [Commands](commands) page. Esc in help brings the command line back with your text and the cursor where they were |
| App mode | `␣ F1` (`:lookup`) | What's selected: a Host's row in the Sidebar opens `:connect`, any other row the command it runs. With nothing selected, the topic finder |
| The Picker, every finder | `F1` | The selected result: a Host opens `:connect`, a Theme its entry (`themes#nord`), a help topic itself, anything else the command Enter would run |
| The Key bindings panel | `F1` | The option of the first binding shown, so type to narrow it first (`keys.cmdline`) |

They're `cmdline.help` and `picker.help` in the keymap, and the `lookup` command, so `init.lua` can move them ([Keyboard](keyboard.md#default-bindings)).

## The pages

The [index](index) groups them, like Neovim's `help.txt`:

- **Getting started:** [Getting started](start.md), this page, [Set up a Box](../new-box.md) and [Add your Hosts](../adding-hosts.md).
- **Make it yours:** [Your init.lua](config.md), [Recipes](recipes.md), [Keyboard](keyboard.md), [Themes](themes.md).
- **Reference**, mostly generated from what the app has now, every time it's shown, so it can't go stale: `quickref` (the commands you'll use most, with their keys now), `commands`, `keys`, `options` (each with the value in effect and where it came from), `themes`, `finders`, `errors`, `health` (this Box's health, as the last `:check` with no Host found it), `all` (every topic, A to Z), and the guides [Connection errors](errors.md), [The roster command](../cli-reference.md) and [The roster serve API](../serve-api.md).
- **Extending:** [How far roster bends](extending.md).
- **What's new:** `version` (`:version`: this build's version, roster's licence and the third-party notices, and where they're installed), [What's new](../news.md), the changes in each Release, and [Deprecated names](../deprecated.md), every old name that still works and what replaces it. `:help` on an old name (`:help ROSTER_DESK_ROSTER`) lands on its row there.

### Where an option's value came from

The `options` page says, for each option, one of:

- `default`: init.lua doesn't set it.
- `init.lua:12`: the file sets it, on that line (or just `init.lua` when the line can't be found, for a value built in a loop or a `require`d module). The core lists every value the file set, so an option set to its default value still says `init.lua`.
- `State (:theme)`, `State (:hints)` or `State (:messages)`: init.lua leaves it to the app, and `:theme`, `:hints` or `:messages` made a choice the State keeps.
- `State (:theme, over init.lua:12)`: init.lua sets `theme` on that line, and a `:theme` choice made over that same value is in effect.

## How the docs stay in sync

The Markdown in `docs/` is the only copy. The app imports it as text when it's built (`app/src/help/guideText.ts`, Vite's `?raw`), so a build always carries the docs of its own commit, and there's nothing to copy by hand. The guides are a part of the app of their own, read from its files the first time you open help, `:helpgrep` or Tab-complete a topic, so the app starts without them (ticket 213, decision Q189); a list of every guide's topics, made with the build as Neovim's `doc/tags` is, lets completion and the topic finder know them before then. A guide opens when its text is there; on a slow machine, a wait past 150 ms opens it saying it's loading. The options page reads its names, defaults and descriptions from the option tables in [config.md](config.md), and a test (`app/src/help/options.test.ts`) fails CI if an option in the core's schema isn't in those tables, or if one in them isn't in the schema. So a new option needs its row in config.md before it can merge.

CI also checks the docs themselves, the way Neovim's `make lintdoc` does: every link in every page goes to a topic, a heading or a file that exists, no two topics share a name, and every relative link in `docs/` and the READMEs resolves (`app/src/help/lint.test.ts`, `tests/test_docs.py`). Every `roster serve` method and error code is in [serve-api.md](../serve-api.md), and every `roster` command in [cli-reference.md](../cli-reference.md).

## On the web and on paper

The same pages are a website, [2styx2.github.io/roster/](https://2styx2.github.io/roster/), and one PDF, `roster-docs.pdf` there and `roster-docs-X.Y.Z.pdf` on each Release. Both are made from the same Markdown, the same generated pages and the same renderer as help in the app, the way Neovim's website is made from its `:help`, so they can't say something different. The generated pages show roster's defaults there (no `init.lua`, no Plugins) and say so; in the app they show what's in effect.

The box at the top of every page searches (`/` goes to it from anywhere on the page): the topics, ranked as `:help`'s topic finder ranks them, then the text, found the way `:helpgrep` finds it. ↑ and ↓ (or `Ctrl+N` and `Ctrl+P`) choose, Enter opens, Esc closes the list, and the last row, "All N results", opens `search.html?q=WORDS` with every match. A match in the text opens the page at its place with the first word marked. It runs in the page, on an index the website is built with; nothing is sent anywhere.

Every topic has a web address: `tag.html?t=TOPIC`, such as [2styx2.github.io/roster/tag.html?t=terminal.size](https://2styx2.github.io/roster/tag.html?t=terminal.size). Every page ends with the commit it was made from, a link to edit its Markdown, and "Wrong or unclear? Report it", which opens a new issue naming the page.

To build them yourself, in `app/`: `npm run docs` writes the website to `app/dist-docs/`, and `npm run docs -- --pdf FILE` prints the PDF too, with Chrome or Chromium (`CHROME=PATH` if it's not on `PATH`). The build stops on a link that goes nowhere. `npm run docs:a11y -- dist-docs` runs axe-core over every page, dark and light, and the open search box, and fails on any WCAG 2.x A or AA problem; CI runs it on every pull request. The website updates when a Release reaches `main` (ADR 0008).

## Writing help

What a guide in `docs/` needs so it reads well in `:help`, on GitHub, and stays linked:

- **Headings are names**, not sentences: each `##` and `###` becomes a topic, `page#slug` (`config#the-sandbox`). Renaming one breaks links to it, and CI says which; add the old name to the guide's `aliases` in `guides.ts` if people may have it in their fingers.
- **Link by topic or by file.** Another guide by its file (`[Keyboard](keyboard.md#two-modes)`), so the link works on GitHub too. A generated page, command, option or error by its topic: `[Options](options)`, `` `:connect` ``, `` `terminal.size` `` (a code span that names a topic is already a link), `[E13](E13)`.
- **Code is anything you could type**: commands, options, values, file names. Keys are written in keymap notation, `␣ f`, `Ctrl+Shift+c`.
- **An option is declared once**, in the Config's shape table, which writes [the option reference](options.md) (`:help options`) and the editor types; config.md's Options tables say more about what each does, without its default. Snippets are `init.lua` lines as people write them (`roster.o.terminal.size = "16pt"`), and each `lua` block in config.md, recipes.md and keyboard.md must load on its own (a test loads them).
- **One word means one thing**, the one in `GLOSSARY.md`.
- **Present tense, active voice**, and say exactly what happens.
- **Notes for developers** stay out of the way: help leaves out a parenthetical that only names a ticket, a decision, an ADR or an issue, such as `(decision QNN)`, so they can stay in the Markdown for whoever reads it on GitHub. Anywhere else in a sentence, write it in words or leave it to `docs/app/decisions.md`; a test fails on one that would show in help.
- **New guides** go in `guides.ts` with a part of the index, a title and a one-line summary.

## The tutor

`:tutor` is Neovim's `:Tutor`: lessons you do, not read. It opens [the tutor](tutor) on a **demo Inventory**, made-up Hosts (`demo-01` to `demo-06`) whose Sessions are pretend shells in the app, under a "Demo Inventory" banner, so nothing you try there reaches your network, your vault or your `roster.yml`. Your own workspace waits behind it, its Sessions still running; `:tutor quit` (or the banner's button) brings it back.

The page starts with the lessons and how far along each is. Each lesson says what it teaches, then has steps, each a ring that fills with a ✓ when the app sees you do it: open the Picker, open a Session to `demo-01`, follow a link and come back with `Ctrl+o`, change the Theme, open `init.lua`. A step ticks from what the app does, wherever you do it, not from text you type. The keys shown are the ones bound now, so a key you moved in `init.lua` shows as yours.

What's done is kept in the State, so `:tutor` comes back at the first lesson you haven't finished, and `:tutor reset` starts over. Nothing else from the demo is kept: a Theme picked there, its Sessions and its recent Hosts go when you leave. `:config` there opens your real `init.lua`, since that's what the lesson is about.

Tutorials are a registry too (`registries.tutorials`), so a Plugin can ship one (`roster.tutor.set`, [plugins.md](../plugins.md#a-plugins-tutorial)); `:tutor NAME` runs it and `:help tutor-NAME` shows its page. The first-party [Topology Plugin](../../plugins/topology/README.md) has one: `:tutor topology`.

Your Plugins come along. The ones running in your workspace load in the demo too, with the permissions you granted them, so a Plugin's tutorial can have you run the Plugin itself. There they see the demo's Hosts, not yours: roster serve answers only the demo's Host list, a request to the network is never sent, and what a Plugin keeps in its files starts empty and is thrown away when you leave. Your workspace's copy of each keeps running behind, untouched. One that fails to load in the demo says so in a notice, marked "(in the demo)" after its name, and the tutorial goes on without it ([errors](errors.md#a-plugin-on-the-demo-inventory)).

## Plugins add pages

Help pages are a registry (ADR 0006), like commands and Themes: `registries.help`. A page is an id (its topic), a title, a one-line summary, an order for the index and a function that returns its blocks: headings, paragraphs, lists, tables, code and entries, as plain data, never HTML. So a Plugin's page (`roster.help.set`, [plugins.md](../plugins.md)) looks like the built-in ones, gets its topics in the finder and in `:helpgrep`, and the index lists it under its source.

## See also

[Getting started](start.md) · [Every topic](all) · [Quick reference](quickref) · [Keyboard](keyboard.md)
