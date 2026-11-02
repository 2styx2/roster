# Getting started with roster

roster opens a terminal to any Host in your team's Inventory, logged in with the Login from the shared vault, and never shows you or keeps the password. It works as it comes: you don't need an `init.lua` to use it. When you want it to look or behave your way, everything you see can be changed, and most of it can be replaced.

To follow a link here, Tab to it and press Enter, or click it. Try it on [links](help.md#links): `Ctrl+o` brings you back. `␣ ?` finds any topic, `:help TOPIC` opens one, and `Esc` closes help. `␣` is the Leader, `Ctrl+Space` unless you've changed it.

These pages are also online, at [2styx2.github.io/roster/](https://2styx2.github.io/roster/), and in one PDF, [2styx2.github.io/roster/roster-docs.pdf](https://2styx2.github.io/roster/roster-docs.pdf) ([On the web and on paper](help.md#on-the-web-and-on-paper)).

## New to roster

`:tutor` is the quickest way in: a short tutorial, like Neovim's `:Tutor`, that you do rather than read, on a demo Inventory of made-up Hosts so nothing you try reaches your network. Its steps tick themselves as you do them, and it comes back where you left off. Or start here:

- **Open a Host.** `␣ f` opens the Picker: type a few letters of a Host's name, address or group, then Enter. `␣ ]` and `␣ [` move between open Sessions.
- **Run anything by name.** `␣ :` opens the command line, and Tab completes. Every key, button and menu runs a command you could type: [Commands](commands) lists them all.
- **Learn the keys as you go.** Keycaps sit next to what they do. `␣ K` shows every binding, and [the quick reference](quickref) has the ones you'll use most on one page.
- **A new Box, or no Hosts yet?** [Set up a Box](../new-box.md), then [add your Hosts](../adding-hosts.md).

## Coming from another tool

- **SecureCRT or PuTTY:** a saved session there is a Host here, kept in the team's `roster.yml` instead of on your machine, and its password stays in the vault. The Picker (`␣ f`) is the session manager; Folders (`␣ a`) are your own grouping on top.
- **Windows Terminal:** `:config import-terminal` copies your profile's font, size, cursor and colours into `init.lua`, so a Session looks the way your terminal does.
- **Neovim or tmux:** the Leader works like tmux's prefix, `:` commands and `:help` like Neovim's, and the Config is Lua. `init.lua`, `:source` and `:help options` do what you'd expect.

## Make it yours

`:config` opens your `init.lua` (it makes one, every line commented out, if there's none), and `:source` applies it. [Options](options) lists every option with the value in effect now and where it came from: the default, a line of your `init.lua`, or a choice the app kept. [Recipes](recipes.md) has short snippets that work when pasted, and [Your init.lua](config.md) explains the file.

## See how far it goes

Commands, keys, Themes, finders, Sidebar sections, the toolbar and these help pages are all registries that your `init.lua` and Plugins add to. [How far roster bends](extending.md) shows each one and what you can do with it today.

## When something's wrong

A Session that can't open says why, where the problem lives (`roster.yml`, the vault, this Box, the network or the Host) and the fix. `:check HOST` runs the same diagnostics on demand, and [Connection errors](errors) lists every one. `:check` alone checks this Box: `roster.yml`, ssh, the vault, `init.lua` and the font, each with its fix ([Health](health)).

## See also

[Using help](help.md) · [Every topic](all) · [The roster command](../cli-reference.md)
