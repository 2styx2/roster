-- The pure part of discover: reading its settings, and turning what roster serve's discover.status
-- found into table rows and words. No `roster` calls here, so it's easy to read and to test.
local M = {}

M.DEFAULT_LEADER = "y d"
-- The most rows the view keeps (the app's table holds 10,000): a bigger scan says it was cut.
M.MAX_ROWS = 10000
-- Rows sent in one roster.views.update (the app takes 2,000 at once).
M.CHUNK = 2000
-- Ports shown in a row before "+N more".
local PORTS_SHOWN = 4

---@class discover.Settings
---@field leader string|false
---@field ranges string[]
---@field ports string?
---@field group string?

---@param keys any
local function is_keys(keys)
  return type(keys) == "string" and keys ~= "" and not keys:find("^ ") and not keys:find(" $")
    and not keys:find("  ", 1, true)
end

---@param s any
local function is_range(s)
  return type(s) == "string" and #s <= 64 and s:find("^[%x%.:/]+$") ~= nil
end

-- The settings from init.lua's `roster.packages.add({ …, dir = "plugins/discover", config = { … } })`,
-- checked. Gives the settings, and the problems to tell the user about (bad values use the default).
---@param config any
---@return discover.Settings, string[]
function M.settings(config)
  config = type(config) == "table" and config or {}
  local problems = {}
  ---@type discover.Settings
  local s = { leader = M.DEFAULT_LEADER, ranges = {}, ports = nil, group = nil }
  if config.leader ~= nil then
    if config.leader == false or is_keys(config.leader) then
      s.leader = config.leader
    else
      problems[#problems + 1] = "config.leader must be keys after the Leader, such as \"y d\", or false for none"
    end
  end
  if config.ranges ~= nil then
    local ok = type(config.ranges) == "table"
    local list = {}
    if ok then
      for _, r in ipairs(config.ranges) do
        if not is_range(r) then
          ok = false
          break
        end
        list[#list + 1] = r
      end
    end
    if ok then
      s.ranges = list
    else
      problems[#problems + 1] = "config.ranges must be a list of networks, such as { \"10.0.0.0/24\" }"
    end
  end
  if config.ports ~= nil then
    if type(config.ports) == "string" and config.ports:find("^%d+[%d,]*$") then
      s.ports = config.ports
    else
      problems[#problems + 1] = "config.ports must be TCP ports separated by commas, such as \"22,80,443\""
    end
  end
  if config.group ~= nil then
    if type(config.group) == "string" and config.group:find("^[%w][%w%._%-]*$") and #config.group <= 64 then
      s.group = config.group
    else
      problems[#problems + 1] = "config.group must be a group name, such as \"found\" (letters, digits, . _ -)"
    end
  end
  return s, problems
end

---@param n integer
---@param one string
---@param many string
function M.plural(n, one, many) return M.count(n) .. " " .. (n == 1 and one or many) end

-- 4096 as "4,096".
---@param n integer
function M.count(n)
  local s = tostring(n)
  while true do
    local t, k = s:gsub("^(%d+)(%d%d%d)", "%1,%2")
    s = t
    if k == 0 then return s end
  end
end

-- A list read out: "a", "a and b", "a, b and c".
---@param items string[]
function M.list(items)
  if #items <= 1 then return items[1] or "" end
  return table.concat(items, ", ", 1, #items - 1) .. " and " .. items[#items]
end

-- roster serve's code for an error (its error object's `code`, Plugin API 7), or nil.
---@param err any
---@return integer?
function M.code(err)
  return type(err) == "table" and err.code or nil
end

-- What an error says: roster serve's message, or the text without the function's name.
---@param err any
---@return string
function M.message(err)
  if type(err) == "table" and err.message then return err.message end
  return (tostring(err):gsub("^roster%.serve%.%a+ [%w%._]+: ", ""))
end

---@class discover.Port
---@field port integer
---@field name string
---@field product string
---@field title string

---@class discover.Found
---@field address string
---@field name string?
---@field type string
---@field hostname string
---@field title string
---@field web string?
---@field known string?
---@field added string?
---@field vendor string
---@field os string
---@field mac string
---@field ports discover.Port[]

-- The open ports, short: "22 ssh · 443 https · +3 more".
---@param ports discover.Port[]
function M.ports(ports)
  local bits = {}
  for i, p in ipairs(ports) do
    if i > PORTS_SHOWN then
      bits[#bits + 1] = "+" .. (#ports - PORTS_SHOWN) .. " more"
      break
    end
    bits[#bits + 1] = p.port .. " " .. p.name
  end
  return table.concat(bits, " · ")
end

-- What a found address is now: new, in the Inventory already, or added by this Plugin.
---@param f discover.Found
---@return "new"|"known"|"added"
function M.state(f)
  if f.known then return "known" end
  if f.added then return "added" end
  return "new"
end

-- A table row for a found address. `keep` says whether the user marked it to add.
---@param f discover.Found
---@param keep boolean
---@return roster.TableRow
function M.row(f, keep)
  local state = M.state(f)
  local status = state == "known" and ("in the Inventory as " .. f.known)
    or state == "added" and ("added as " .. f.added)
    or "new"
  return {
    id = f.address,
    cells = {
      keep = keep and "✓" or "",
      address = f.address,
      name = f.known or f.added or f.name or "",
      type = f.type,
      ports = M.ports(f.ports),
      title = f.title ~= "" and f.title or f.hostname,
      status = status,
      -- Not columns: what the actions' `when` reads.
      state = state,
      pick = keep and "yes" or "no",
    },
    host = f.known or f.added,
    tone = state ~= "new" and "muted" or nil,
  }
end

-- The lines of a found address's details, for its floating window.
---@param f discover.Found
---@return string[]
function M.details(f)
  local lines = { "Address   " .. f.address }
  if f.hostname ~= "" then lines[#lines + 1] = "DNS name  " .. f.hostname end
  if f.known then
    lines[#lines + 1] = "Host      " .. f.known .. " (in the Inventory)"
  elseif f.added then
    lines[#lines + 1] = "Host      " .. f.added .. " (added, a Pending change)"
  else
    lines[#lines + 1] = "Adds as   " .. (f.name or "")
  end
  lines[#lines + 1] = "Type      " .. f.type .. " (guessed: fix it when you review it)"
  if f.vendor ~= "" then lines[#lines + 1] = "Hardware  " .. f.vendor end
  if f.os ~= "" then lines[#lines + 1] = "OS        " .. f.os end
  if f.mac ~= "" then lines[#lines + 1] = "MAC       " .. f.mac end
  lines[#lines + 1] = ""
  lines[#lines + 1] = "Open ports"
  for _, p in ipairs(f.ports) do
    local line = string.format("  %-6s %s", tostring(p.port), p.name)
    if p.product ~= "" then line = line .. "  " .. p.product end
    if p.title ~= "" then line = line .. "  \"" .. p.title .. "\"" end
    lines[#lines + 1] = line
  end
  return lines
end

return M
