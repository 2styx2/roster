-- pinned: a Sidebar section of the Hosts you pin with `:pin HOST`, a status segment with the
-- count, a finder over them, and its own help page. It reads the Inventory (inventory.read) to
-- show each Host's address and to refuse a name that isn't a Host.
-- The ---@ comments are LuaCATS annotations for lua-language-server (../types/roster.lua).
local roster = require("roster")
---@type string[]
local pins = {}

-- The Host's address, or nil when no Host has that name (roster.inventory.host gives nil).
---@param name string
---@return string?
local function address(name)
  local host = roster.inventory.host(name)
  return host and host.ip
end

local function show()
  ---@type roster.Row[], roster.FinderItem[]
  local rows, items = {}, {}
  for i, name in ipairs(pins) do
    rows[i] = {
      id = name,
      label = name,
      host = name, -- Enter opens it, and the row lights up when it's on screen
      detail = address(name),
      actions = {
        { label = "Unpin " .. name, icon = "close", run = function()
          table.remove(pins, i)
          show()
        end },
      },
    }
    items[i] = { label = name, detail = rows[i].detail, run = "open " .. name }
  end
  roster.sidebar.set("pinned", { title = "Pinned", order = 150, empty = "Nothing pinned. :pin HOST", rows = rows })
  roster.status.set("pinned", { text = #pins .. " pinned", run = "finder pinned" })
  roster.finders.set("pinned", { title = "Pinned Hosts", items = items })
end

roster.commands.add("pin", {
  desc = "Pin a Host to the Sidebar",
  ---@param a roster.CommandArgs
  run = function(a)
    local name = a.words[1]
    if not name or not address(name) then
      roster.notify("pin: which Host? :pin HOST", "warn")
      return
    end
    table.insert(pins, name)
    show()
  end,
})
roster.keymap.set("leader", "p p", "finder pinned")

roster.help.set("pinned", {
  title = "Pinned Hosts",
  summary = "A Sidebar section of the Hosts you pin",
  markdown = "# Pinned Hosts\n\n`:pin HOST` adds a Host to the Pinned section. `␣ p p` finds one.",
})

-- A Host renamed or removed elsewhere drops out.
roster.on("inventory_changed", function()
  local kept = {}
  for _, name in ipairs(pins) do
    if address(name) then table.insert(kept, name) end
  end
  pins = kept
  show()
end)

show()
