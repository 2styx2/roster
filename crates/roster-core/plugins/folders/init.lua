-- Folders (GLOSSARY): your own groupings of Hosts, in the Sidebar between Sessions and the
-- Inventory. Built into roster, written on the public Plugin API (docs/plugins.md) like any
-- Plugin, so it proves the API can do what the app does (tickets 23 and 61, decision Q93).
--
--   folder new NAME            folder rename NAME NEW     folder delete NAME
--   folder add [HOST [NAME]]   folder remove [HOST NAME]
--
-- Names may have spaces ("Lab ESXi"); quote one only where it would be ambiguous.
--
-- Where its data is: the Folders you make live in folders.json in this Plugin's own data folder
-- (roster.storage). The app hands it, as roster.plugin.config:
--   fixed         init.lua's Folders ({ name, hosts, source }): shown first, read-only here
--   import        the Folders to move in once, when there's no folders.json yet: folders.yml's
--                 (from before Folders was a Plugin) or, older still, the State's
--   import_from   where those came from ("folders.yml" or "the State")
--   import_error  why folders.yml couldn't be read: nothing is moved until it's fixed
local roster = require("roster")

local FILE = "folders.json"
local SECTION = "folders"
local config = roster.plugin.config
local fixed = type(config.fixed) == "table" and config.fixed or {}

local function trim(s)
  return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

local lower = string.lower

--- Folders from data that may be anything: malformed ones are dropped, as are a second Folder
--- with the same name (ignoring case) and a Host listed twice.
local function clean(list)
  local out, seen = {}, {}
  if type(list) ~= "table" then return out end
  for _, f in ipairs(list) do
    if type(f) == "table" and type(f.name) == "string" and trim(f.name) ~= "" and not seen[lower(f.name)] then
      seen[lower(f.name)] = true
      local hosts, had = {}, {}
      if type(f.hosts) == "table" then
        for _, h in ipairs(f.hosts) do
          if type(h) == "string" and not had[h] then
            had[h] = true
            hosts[#hosts + 1] = h
          end
        end
      end
      out[#out + 1] = { name = f.name, hosts = hosts }
    end
  end
  return out
end

local fixed_folders = {}
for _, f in ipairs(clean(fixed)) do
  local source
  for _, g in ipairs(fixed) do
    if g.name == f.name then source = g.source end
  end
  f.source = type(source) == "string" and source or "init.lua"
  fixed_folders[#fixed_folders + 1] = f
end

local folders = {}
-- Why the Folders can't be used now, for :check and the section.
local problem
-- What happened to folders.yml (or the State's Folders) at this load, for :check.
local moved
-- Why the Folders couldn't be read at load: until that's fixed, nothing is written over them.
local blocked

local function find(list, name)
  local want = lower(trim(name))
  for _, f in ipairs(list) do
    if lower(f.name) == want then return f end
  end
end

local function fixed_named(name)
  return find(fixed_folders, name)
end

local function save()
  local ok, e = pcall(roster.storage.write_json, FILE, folders)
  if not ok then
    problem = "can't save the Folders: " .. tostring(e)
    return false
  end
  problem = nil
  return true
end

local function count(n, one)
  return n .. " " .. one .. (n == 1 and "" or "s")
end

-- Loads folders.json; with none yet, moves in what the app handed over, once.
do
  local ok, data = pcall(roster.storage.read_json, FILE)
  if not ok then
    problem = tostring(data)
    blocked = problem
  elseif data ~= nil then
    folders = clean(data)
  elseif config.import_error then
    -- folders.yml doesn't parse: move nothing, so nothing is lost; it's tried again next time.
    problem = tostring(config.import_error)
    blocked = problem
  elseif type(config.import) == "table" then
    folders = clean(config.import)
    local from = config.import_from or "folders.yml"
    if save() then
      moved = { from = from, n = #folders }
      if #folders > 0 then
        roster.notify(
          "Moved " .. count(#folders, "Folder") .. " from " .. from .. " into roster's own data"
            .. (from == "folders.yml" and ": folders.yml isn't read any more (:check)" or ""),
          "info",
          -- A result that needs attention: it shows whatever ui.messages says (ticket 117).
          { quiet = false }
        )
      end
    end
  end
end

-- ------------------------------------------------------------------ what the commands do

local function bad_name(name)
  if trim(name) == "" then return "A Folder needs a name" end
  if name:find('"', 1, true) then return "A Folder name can't contain a double quote" end
end

local function quote(name)
  return name:find("%s") and ('"' .. name .. '"') or name
end

local function unquote(s)
  local t = trim(s)
  if #t >= 2 and t:sub(1, 1) == '"' and t:sub(-1) == '"' then return t:sub(2, -2) end
  return t
end

local function first_word(text)
  local t = trim(text)
  local at = t:find("%s")
  if not at then return t, "" end
  return t:sub(1, at - 1), trim(t:sub(at))
end

--- Splits "NAME REST" where NAME may be quoted, or an existing Folder's name with spaces.
local function split_name(text, names)
  local t = trim(text)
  if t:sub(1, 1) == '"' then
    local close = t:find('"', 2, true)
    if close then return t:sub(2, close - 1), trim(t:sub(close + 1)) end
  end
  local l = lower(t)
  local sorted = {}
  for _, n in ipairs(names) do sorted[#sorted + 1] = n end
  table.sort(sorted, function(a, b) return #a > #b end)
  for _, n in ipairs(sorted) do
    local ln = lower(n)
    if l == ln or l:sub(1, #ln + 1) == ln .. " " then
      return t:sub(1, #n), trim(t:sub(#n + 1))
    end
  end
  return first_word(t)
end

local function create(name)
  local bad = bad_name(name)
  if bad then return nil, bad end
  if find(folders, name) then return nil, "There's already a Folder named " .. trim(name) end
  folders[#folders + 1] = { name = trim(name), hosts = {} }
  return "Created Folder " .. trim(name)
end

local function rename(name, to)
  local folder = find(folders, name)
  if not folder then return nil, "No Folder named " .. name end
  local bad = bad_name(to)
  if bad then return nil, bad end
  local clash = find(folders, to)
  if clash and clash ~= folder then return nil, "There's already a Folder named " .. trim(to) end
  local old = folder.name
  folder.name = trim(to)
  return "Renamed Folder " .. old .. " to " .. trim(to)
end

local function delete(name)
  for i, f in ipairs(folders) do
    if lower(f.name) == lower(trim(name)) then
      table.remove(folders, i)
      return "Deleted Folder " .. f.name
    end
  end
  return nil, "No Folder named " .. name
end

local function add(host, name)
  local folder = find(folders, name)
  if not folder then
    local _, bad = create(name)
    if bad then return nil, bad end
    folder = find(folders, name)
  end
  for _, h in ipairs(folder.hosts) do
    if h == host then return nil, host .. " is already in " .. folder.name end
  end
  folder.hosts[#folder.hosts + 1] = host
  return "Added " .. host .. " to " .. folder.name
end

local function remove(host, name)
  local folder = find(folders, name)
  if not folder then return nil, "No Folder named " .. name end
  for i, h in ipairs(folder.hosts) do
    if h == host then
      table.remove(folder.hosts, i)
      return "Removed " .. host .. " from " .. folder.name
    end
  end
  return nil, host .. " isn't in " .. folder.name
end

-- ------------------------------------------------------------------ the Inventory's names

-- The Inventory's Host names, read when first needed and again after it changes.
local names
local function host_names()
  if not roster.inventory then return nil end
  if not names then
    names = {}
    for _, h in ipairs(roster.inventory.hosts()) do names[#names + 1] = h.name end
  end
  return names
end

local function is_host(name)
  local list = host_names()
  if not list then return true end -- without inventory.read, any name is taken as given
  for _, n in ipairs(list) do
    if n == name then return true end
  end
  return false
end

-- ------------------------------------------------------------------ the Sidebar

-- What each of the section's rows stands for, by row id: { folder = NAME, host = HOST? }.
local rows_of = {}
local show

local function dropped_into(name)
  return function(e)
    if e.dropped then roster.cmd("folder add " .. e.dropped .. " " .. name) end
  end
end

show = function()
  rows_of = {}
  local rows = {}
  local shown = 0
  local function folder_rows(f, own)
    shown = shown + 1
    local id = f.name
    rows_of[id] = { folder = f.name }
    local head = { id = id, label = f.name, icon = "folder", fold = true }
    if own then
      head.count = #f.hosts
      head.drop = dropped_into(f.name)
      head.actions = {
        { label = "Rename " .. f.name, icon = "edit", run = "folder rename " .. quote(f.name) },
        { label = "Delete Folder " .. f.name, icon = "close", run = "folder delete " .. f.name },
      }
    else
      head.detail = tostring(#f.hosts)
      head.note = "from " .. f.source
      head.title = "Defined in " .. f.source .. ": change it there"
    end
    rows[#rows + 1] = head
    for _, h in ipairs(f.hosts) do
      local rid = f.name .. "/" .. h
      rows_of[rid] = { folder = f.name, host = h }
      local row = { id = rid, label = h, host = h, kind = "host", level = 1, note = "not in the Inventory" }
      if own then
        row.drop = dropped_into(f.name)
        row.drag_out = "folder remove " .. h .. " " .. f.name
        row.actions = { { label = "Remove " .. h .. " from " .. f.name, icon = "close", run = "folder remove " .. h .. " " .. f.name } }
      end
      rows[#rows + 1] = row
    end
  end
  for _, f in ipairs(fixed_folders) do folder_rows(f, false) end
  for _, f in ipairs(folders) do
    -- A Folder init.lua also has is hidden behind init.lua's.
    if not fixed_named(f.name) then folder_rows(f, true) end
  end
  roster.sidebar.set(SECTION, {
    title = "Folders",
    order = 200,
    count = shown,
    empty = problem and ("Folders can't be read: " .. problem) or "No Folders yet. Drag a Host here or press `␣ a`.",
    actions = { { label = "New Folder", icon = "add", run = "folder new" } },
    drop = function(e)
      if e.dropped then roster.cmdline("folder add " .. e.dropped .. " ") end
    end,
    rows = rows,
  })
end

-- ------------------------------------------------------------------ the command

local SUBCOMMANDS = { "new", "rename", "delete", "add", "remove" }

local function all_names()
  local list = {}
  for _, f in ipairs(fixed_folders) do list[#list + 1] = f.name end
  for _, f in ipairs(folders) do list[#list + 1] = f.name end
  return list
end

local function run(a)
  local say = roster.echo
  local sub, rest = first_word(a.args or "")
  local at = a.section == SECTION and a.row and rows_of[a.row] or nil
  local function apply(message, err)
    if err then return say(err) end
    if not save() then return say(problem) end
    show()
    -- A routine confirmation: quiet, as roster's own (api 4, ticket 118).
    roster.echo(message, { quiet = true })
  end
  -- Folders that couldn't be read aren't written over: nothing is lost while it's fixed.
  if blocked and sub ~= "" then
    return say("Folders can't be changed until they can be read: " .. blocked)
  end
  -- A Folder from init.lua can only be changed there.
  local function from_config(name)
    local f = fixed_named(name)
    if not f then return false end
    say(f.name .. " is defined in " .. f.source .. ": change it there")
    return true
  end
  if sub == "new" then
    if rest == "" then return roster.cmdline("folder new ") end
    if from_config(unquote(rest)) then return end
    return apply(create(unquote(rest)))
  elseif sub == "rename" then
    if rest == "" then
      if at then return roster.cmdline("folder rename " .. quote(at.folder) .. " ") end
      return say("folder rename needs a Folder name and a new name")
    end
    local name, to = split_name(rest, all_names())
    if from_config(name) then return end
    if to == "" then return roster.cmdline("folder rename " .. quote(name) .. " ") end
    if from_config(unquote(to)) then return end
    return apply(rename(name, unquote(to)))
  elseif sub == "delete" then
    local name = rest ~= "" and unquote(rest) or (at and at.folder)
    if not name then return say("folder delete needs a Folder name") end
    if from_config(name) then return end
    return apply(delete(name))
  elseif sub == "add" then
    local given, name = first_word(rest)
    local host = given ~= "" and given or a.host
    if not host then return say("No Host selected: move to one in the Sidebar, or use folder add HOST NAME") end
    if not is_host(host) then return say("No Host named " .. host) end
    if name == "" then return roster.cmdline("folder add " .. host .. " ") end
    if from_config(unquote(name)) then return end
    return apply(add(host, unquote(name)))
  elseif sub == "remove" then
    if rest == "" then
      if not (at and at.host) then return say("Move to a Host in a Folder first, or use folder remove HOST NAME") end
      if from_config(at.folder) then return end
      return apply(remove(at.host, at.folder))
    end
    local host, name = first_word(rest)
    if name == "" then return say("folder remove needs a Host and a Folder name") end
    if from_config(unquote(name)) then return end
    return apply(remove(host, unquote(name)))
  end
  say("folder: say " .. table.concat(SUBCOMMANDS, ", "))
end

local function starts(word)
  local w = lower(word)
  return function(s) return lower(s):sub(1, #w) == w end
end

local function complete(arg)
  local out = {}
  local space = arg:find("%s")
  if not space then
    for _, s in ipairs(SUBCOMMANDS) do
      if s:sub(1, #arg) == arg then out[#out + 1] = s .. " " end
    end
    return out
  end
  local sub, rest = arg:sub(1, space - 1), arg:sub(space):gsub("^%s+", "")
  if sub == "rename" or sub == "delete" then
    local ok = starts(rest)
    for _, f in ipairs(folders) do
      if ok(f.name) then out[#out + 1] = sub .. " " .. (sub == "rename" and (quote(f.name) .. " ") or f.name) end
    end
    return out
  end
  if sub ~= "add" and sub ~= "remove" then return out end
  local host_space = rest:find("%s")
  if not host_space then
    local pool, seen = {}, {}
    if sub == "remove" then
      for _, f in ipairs(folders) do
        for _, h in ipairs(f.hosts) do
          if not seen[h] then seen[h] = true pool[#pool + 1] = h end
        end
      end
    else
      pool = host_names() or {}
    end
    local ok = starts(rest)
    for _, h in ipairs(pool) do
      if ok(h) and #out < 200 then out[#out + 1] = sub .. " " .. h .. " " end
    end
    return out
  end
  local host = rest:sub(1, host_space - 1)
  local ok = starts((rest:sub(host_space):gsub("^%s+", "")))
  for _, f in ipairs(folders) do
    local has = false
    for _, h in ipairs(f.hosts) do
      if h == host then has = true end
    end
    if (sub == "remove") == has and ok(f.name) then out[#out + 1] = sub .. " " .. host .. " " .. f.name end
  end
  return out
end

roster.commands.add("folder", { desc = "Folders: new, rename, delete, add, remove", run = run, complete = complete })
roster.keymap.set("leader", "a", "folder add")
roster.keymap.set("leader", "A", "folder remove")
roster.finders.set(SECTION, { title = "Find in the Folders", prompt = "Folders", section = SECTION })

if roster.has("inventory.read") then
  roster.on("inventory_changed", function() names = nil end)
end

roster.health.set(SECTION, {
  title = "Folders",
  check = function()
    local lines = {}
    if problem then
      lines[#lines + 1] = { level = "error", message = problem, fix = "fix folders.yml (it's moved in once it reads), or see :plugins" }
    else
      lines[#lines + 1] = { level = "ok", message = count(#folders, "Folder") .. " of yours, in roster's own data (plugin-data/folders)" }
    end
    if moved then
      lines[#lines + 1] = { level = "ok", message = "Moved " .. count(moved.n, "Folder") .. " in from " .. moved.from .. " at this start" }
    end
    if config.import_from == "folders.yml" and not moved and not problem then
      lines[#lines + 1] = {
        level = "warn",
        message = "folders.yml is still in your config folder, but it isn't read any more: your Folders moved into roster's own data",
        fix = "delete folders.yml once your Folders look right",
      }
    end
    if not roster.has("inventory.read") then
      lines[#lines + 1] = { level = "warn", message = "inventory.read isn't granted, so Host names aren't checked or completed", fix = "allow it in :plugins" }
    end
    return lines
  end,
})

show()
