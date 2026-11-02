-- A Config split into modules, the way a Neovim init.lua often is: init.lua only loads them, in
-- order. Copy this folder's files into the roster app's config folder (where init.lua goes).
--
-- require("myconf.options") loads lua/myconf/options.lua from the config folder. Each module sets
-- what it's about with roster.* calls; they all write to one store, and a later line wins over an
-- earlier one, so the last module can override what the first set. An error names the module and
-- its line (lua/myconf/options.lua:12: …), and so does :options for every value.
require("myconf.options")
require("myconf.keys")
require("myconf.themes")
require("myconf.folders")
