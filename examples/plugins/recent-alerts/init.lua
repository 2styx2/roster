-- recent-alerts: lines your Sessions print that look like trouble (ERROR, panic, disk full), in a
-- Sidebar section with the Host and time of each, a badge on each Host that has some, a status
-- segment with the count, a finder, a notice when a new one arrives, and a floating window with an
-- alert's details. It's the worked example of docs/plugins.md: it uses only the public API, and it
-- asks for one permission, terminal.read.
--
-- Settings come from init.lua, where you name it as a Package:
--   packages = { { "someone/recent-alerts", config = { patterns = { "ERROR", "panic" }, leader = "w w" } } }
-- The ---@ comments are LuaCATS annotations: with ../types/roster.lua (docs/plugin-api.md,
-- "Editor support"), lua-language-server completes roster.* and checks what we hand the app.
local roster = require("roster")
local match = require("recent-alerts.match")

local settings, problems = match.settings(roster.plugin.config)
for _, p in ipairs(problems) do
  roster.notify(p .. "; using the default", "warn")
end

-- Whether it was granted terminal.read: without it there's no terminal_output event to listen to,
-- and listening would be an error. It still loads, and says what it's missing.
local function granted(permission)
  for _, p in ipairs(roster.plugin.permissions) do
    if p == permission then return true end
  end
  return false
end
local reads = granted("terminal.read")

---@class Alert
---@field id integer
---@field host string? nil: a Quick Connect Session
---@field session integer
---@field text string
---@field pattern string
---@field at integer
---@field before string[]

---@type Alert[]
local alerts = {} -- oldest first: { id, host, session, text, pattern, at, before } (host nil: Quick Connect)
local next_id = 0
local carry = {} -- per Session: the end of its output that isn't a whole line yet
local context = {} -- per Session: its last few lines, shown above an alert in its details
local badged = {} -- the Hosts that have a badge now
local told = {} -- per Host (or Quick Connect): when its last notice was, and the alerts since
local CONTEXT = 3
local QUICK = "Quick Connect"

---@param at integer
---@return string
local function clock(at) return os.date("%H:%M:%S", at) --[[@as string]] end

local function plural(n, one, many) return n .. " " .. (n == 1 and one or many) end

local function list(patterns)
  if #patterns == 1 then return patterns[1] end
  return table.concat(patterns, ", ", 1, #patterns - 1) .. " or " .. patterns[#patterns]
end

local show -- below: draws everything from `alerts`

-- Where an alert came from, as its row says it: the Host, or Quick Connect (no Host to name).
---@param a Alert
local function where(a) return a.host or QUICK end

---@param a Alert
local function details(a)
  local lines = {
    "Host     " .. (a.host or ("none (" .. QUICK .. ")")),
    "Session  " .. a.session,
    "At       " .. os.date("%Y-%m-%d %H:%M:%S", a.at),
    "Matched  " .. a.pattern,
    "",
  }
  for _, l in ipairs(a.before) do lines[#lines + 1] = "  " .. l end
  lines[#lines + 1] = "› " .. a.text
  local title = a.host and ("Alert on " .. a.host) or "Alert in a Quick Connect Session"
  roster.float.open({ title = title, lines = lines })
end

local function dismiss(id)
  for i, a in ipairs(alerts) do
    if a.id == id then
      table.remove(alerts, i)
      break
    end
  end
  show()
end

local function clear()
  alerts = {}
  show()
end

show = function()
  ---@type roster.Row[], roster.FinderItem[], table<string, integer>
  local rows, items, per_host = {}, {}, {}
  -- Newest first.
  for i = #alerts, 1, -1 do
    local a = alerts[i]
    -- A Quick Connect Session has no Host: no badge, and nothing for Enter to go to.
    if a.host then per_host[a.host] = (per_host[a.host] or 0) + 1 end
    rows[#rows + 1] = {
      id = tostring(a.id),
      label = a.text,
      detail = where(a),
      note = clock(a.at),
      title = where(a) .. " at " .. clock(a.at) .. ": " .. a.text,
      -- With `host`, Enter goes to that Host's Session, and the row lights up while it's on screen.
      host = a.host,
      actions = {
        { label = "Details of " .. a.text, icon = "info", run = function() details(a) end },
        { label = "Copy " .. a.text, icon = "copy", run = function()
          roster.clipboard.copy(a.text)
          roster.notify("Copied the line from " .. where(a))
        end },
        { label = "Dismiss " .. a.text, icon = "close", run = function() dismiss(a.id) end },
      },
    }
    items[#items + 1] = {
      id = tostring(a.id),
      label = a.text,
      detail = where(a) .. " · " .. clock(a.at),
      run = function() details(a) end,
    }
  end

  local empty = reads and ("No alerts. Lines with " .. list(settings.patterns) .. " show here.")
    or "Allow terminal.read in :plugins to see alerts."
  roster.sidebar.set("recent-alerts", { title = "Recent alerts", order = 200, empty = empty, rows = rows })
  roster.finders.set("alerts", { title = "Recent alerts", items = items })

  if #alerts > 0 then
    roster.status.set("alerts", { text = "⚠ " .. #alerts, title = plural(#alerts, "recent alert", "recent alerts"), run = "finder alerts" })
  else
    roster.status.remove("alerts")
  end

  -- In name order, so the same alerts always make the same changes.
  local hosts = {}
  for host in pairs(per_host) do hosts[#hosts + 1] = host end
  for host in pairs(badged) do
    if not per_host[host] then hosts[#hosts + 1] = host end
  end
  table.sort(hosts)
  for _, host in ipairs(hosts) do
    local n = per_host[host]
    -- A count, kept short: the app draws it as a small chip after the Host's name.
    roster.badges.set(host, n and tostring(n) or nil)
  end
  badged = per_host
end

roster.commands.add("alerts", {
  desc = "Recent alerts: :alerts shows them, :alerts clear dismisses them all",
  ---@param a roster.CommandArgs
  run = function(a)
    local what = a.words[1]
    if what == "clear" then
      local n = #alerts
      clear()
      roster.notify(n == 0 and "No alerts to clear" or ("Dismissed " .. plural(n, "alert", "alerts")))
    elseif what == nil then
      if #alerts == 0 then
        roster.notify("No alerts")
        return
      end
      local lines = {}
      for i = #alerts, 1, -1 do
        local x = alerts[i]
        lines[#lines + 1] = clock(x.at) .. "  " .. where(x) .. "  " .. x.text
      end
      roster.float.open({ title = "Recent alerts", lines = lines })
    else
      roster.notify(":alerts shows the alerts, :alerts clear dismisses them all", "warn")
    end
  end,
})
roster.keymap.set("leader", settings.leader, "finder alerts")

roster.help.set("recent-alerts", {
  title = "Recent alerts",
  summary = "Lines your Sessions print that look like trouble",
  markdown = table.concat({
    "# Recent alerts",
    "",
    "Watches what your Sessions print and lists the lines with " .. list(settings.patterns)
      .. " in the **Recent alerts** section of the Sidebar, newest first, each with its Host and time.",
    "",
    "- `:alerts` shows them all; `:alerts clear` dismisses them all.",
    "- `␣ " .. settings.leader .. "` finds one (`:finder alerts`); the status bar's `⚠` count opens the same finder.",
    "- On a row: Enter goes to the Host's Session; the buttons show the details, copy the line or dismiss it.",
    "",
    "It keeps the last " .. settings.max .. " alerts, in memory only: they're gone when the app restarts.",
    "",
    "It needs **terminal.read**, which lets it see everything your Sessions print. Revoke it in `:plugins` and it stops at once.",
  }, "\n"),
})

-- A notice for `fresh` alerts from one Session, at most once per `quiet` seconds for each Host:
-- `tail -f` on a noisy log keeps the section up to date without a pile of notices. The alerts
-- held back are counted in the next one.
local function tell(fresh)
  local last = fresh[#fresh]
  local key = where(last)
  local t = told[key] or { at = nil, held = 0 }
  told[key] = t
  local now = os.time()
  if t.at and now - t.at < settings.quiet then
    t.held = t.held + #fresh
    return
  end
  local n = t.held + #fresh
  t.at, t.held = now, 0
  if n == 1 then
    roster.notify(key .. ": " .. last.text, "warn")
  else
    roster.notify(n .. " new alerts on " .. key .. ", the last: " .. last.text, "warn")
  end
end

if reads then
  ---@param e roster.TerminalOutputEvent
  roster.on("terminal_output", function(e)
    -- nil for a Quick Connect Session: it isn't a Host of the Inventory.
    local host = e.host
    local lines
    lines, carry[e.session] = match.lines(carry[e.session], e.text)
    local seen = context[e.session] or {}
    local fresh = {}
    for _, raw in ipairs(lines) do
      local whole = raw:gsub("^%s+", ""):gsub("%s+$", "")
      -- Matched on the whole line, shown cut; your own command echoed after a prompt isn't one.
      local pattern = whole ~= "" and not match.prompt(whole) and match.first(whole, settings.patterns)
      local line = match.tidy(whole)
      if pattern then
        next_id = next_id + 1
        local before = {}
        for i = math.max(1, #seen - CONTEXT + 1), #seen do before[#before + 1] = seen[i] end
        local a = { id = next_id, host = host, session = e.session, text = line, pattern = pattern, at = os.time(), before = before }
        alerts[#alerts + 1] = a
        fresh[#fresh + 1] = a
      end
      if line ~= "" then
        seen[#seen + 1] = line
        if #seen > CONTEXT then table.remove(seen, 1) end
      end
    end
    context[e.session] = seen
    if #fresh == 0 then return end
    while #alerts > settings.max do table.remove(alerts, 1) end
    show()
    if settings.notify then tell(fresh) end
  end)

  -- A Session that ended takes its unfinished line and context with it (its alerts stay).
  roster.on("session_exit", function(e)
    carry[e.session] = nil
    context[e.session] = nil
  end)
end

show()
