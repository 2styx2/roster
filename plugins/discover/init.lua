-- discover: scan a network from the app, review what it found, and add the Hosts you keep as
-- Pending changes. A first-party Plugin (plugins/README.md): built only on the public Plugin API,
-- like anyone's. The scan itself runs in roster serve (discover.*), never here: this draws the
-- view, asks before anything happens, shows the progress and asks for results as serve pushes
-- the scan's progress (`job_progress`, serve API 20; until the first one comes, a timer asks once
-- a second, as an older serve sends none). It asks serve with `roster.serve.request`, which
-- doesn't wait (decision Q103): the app's Publish can hold serve for a minute or two.
--
-- Settings come from init.lua, where you name it as a Package:
--   roster.packages.add({ "https://github.com/2styx2/roster", dir = "plugins/discover",
--                         config = { ranges = { "10.0.0.0/24" }, leader = "y d" } })
local roster = require("roster")
local model = require("discover.model")

local settings, problems = model.settings(roster.plugin.config)
for _, p in ipairs(problems) do
  roster.notify(p .. "; using the default", "warn")
end

local VIEW = "discover"
-- What it needs to work at all, and to add what it found.
local SCANS = { "serve:discover.plan", "serve:discover.start", "serve:discover.status", "serve:discover.stop" }
local ADDS = "serve:discover.add"

---@return string[]
local function missing()
  local out = {}
  for _, p in ipairs(SCANS) do
    if not roster.has(p) then out[#out + 1] = p end
  end
  return out
end

---@class discover.Scan
---@field id string
---@field targets string[]
---@field scanner string
---@field state string
---@field done integer
---@field total integer
---@field count integer
---@field error string?

---@type discover.Scan?
local scan = nil
---@type table<string, discover.Found>
local found = {} -- by address
---@type string[]
local order = {} -- addresses, as found
local kept = {} -- address -> true: marked to add
local cut = false -- more were found than the view keeps
local polling -- the timer that asks roster serve how the scan is going
local asking = false -- a discover.status question is out
local again = false -- serve pushed more while that question was out: ask again once it's back
local pushed = false -- serve pushes job_progress: no timer needed
local planning = false -- a discover.plan question is out, for a scan the user asked for
local adding = false -- a discover.add is out

-- Asks roster serve without waiting: `done(true, result)` or `done(false, why)` comes later.
---@param done fun(ok: boolean, result: any)
local function request(method, params, done)
  local sent, err = pcall(roster.serve.request, method, params or {}, function(r, why)
    if why then done(false, why) else done(true, r) end
  end)
  if not sent then done(false, err) end
end

local function counts()
  local new, known, added, keep = 0, 0, 0, 0
  for _, a in ipairs(order) do
    local s = model.state(found[a])
    if s == "new" then new = new + 1 elseif s == "known" then known = known + 1 else added = added + 1 end
    if kept[a] then keep = keep + 1 end
  end
  return new, known, added, keep
end

-- The view's words and facts, from `scan` and what it found.
local function words()
  local gone = missing()
  if #gone > 0 then
    return "Discover needs " .. model.list(gone) .. ". Allow them in :plugins to scan a network.", {}
  end
  if not scan then
    local text = "Scan a network for Hosts: :discover 10.0.0.0/24. roster scans from this computer, "
      .. "and nothing is added until you pick what to keep."
    if #settings.ranges > 0 then
      text = "Scan " .. model.list(settings.ranges) .. " for Hosts: :discover (or name another range: "
        .. ":discover 10.0.0.0/24). roster scans from this computer, and nothing is added until you pick what to keep."
    end
    return text, {}
  end
  local new, known, added, keep = counts()
  local where = model.list(scan.targets)
  local text
  if scan.state == "running" then
    text = "Scanning " .. where .. " with " .. scan.scanner .. ": " .. model.count(scan.done) .. " of "
      .. model.count(scan.total) .. " addresses. Hosts show here as they're found."
  elseif scan.state == "stopping" then
    text = "Stopping the scan of " .. where .. "."
  elseif scan.state == "failed" then
    text = "The scan of " .. where .. " failed: " .. (scan.error or "no reason given") .. "."
  else
    text = (scan.state == "stopped" and "Stopped the scan of " or "Scanned ") .. where .. ": "
      .. model.plural(scan.count, "Host", "Hosts") .. " answered."
  end
  if new > 0 then
    text = text .. "\n\nKeep the ones you want (m, or :discover keep all), then add them (A): they go in "
      .. "unreviewed, as Pending changes you review in :changes and Publish."
  elseif added > 0 then
    text = text .. "\n\nThe ones you added are Pending changes: review them in :changes, then Publish."
  end
  if cut then
    text = text .. "\n\nMore answered than the view shows: it keeps the first " .. model.count(model.MAX_ROWS) .. "."
  end
  local facts = {
    { label = "Range", value = where, data = true },
    { label = "Scanner", value = scan.scanner },
    { label = "Found", value = model.count(new) .. " new, " .. model.count(known) .. " in the Inventory"
      .. (added > 0 and (", " .. model.count(added) .. " added") or "") },
    { label = "Kept", value = model.count(keep) },
  }
  return text, facts
end

-- Only the words and facts: the rows change on their own.
local function retell()
  local text, facts = words()
  roster.views.update(VIEW, { text = text, facts = facts })
end

-- The rows for `addresses` again, and the words, in as few updates as the app takes.
---@param addresses string[]
local function redraw(addresses)
  local rows = {}
  for _, a in ipairs(addresses) do
    rows[#rows + 1] = model.row(found[a], kept[a] == true)
    if #rows == model.CHUNK then
      roster.views.update(VIEW, { rows = rows })
      rows = {}
    end
  end
  local text, facts = words()
  roster.views.update(VIEW, { rows = rows, text = text, facts = facts })
end

---@param e roster.TableEvent
local function details(e)
  local f = found[e.row]
  if not f then return end
  local links = {}
  if f.web then links[1] = { label = "Its web page", url = f.web } end
  roster.float.open({ title = f.known or f.added or f.name or f.address, lines = model.details(f), links = links })
end

---@param address string
---@param keep boolean
local function mark(address, keep)
  local f = found[address]
  if not f or model.state(f) ~= "new" then return end
  kept[address] = keep or nil
  redraw({ address })
end

-- The addresses marked to add, in the order they were found.
local function keeping()
  local out = {}
  for _, a in ipairs(order) do
    if kept[a] and model.state(found[a]) == "new" then out[#out + 1] = a end
  end
  return out
end

local function add()
  if not scan then return end
  local picks = keeping()
  if #picks == 0 then
    roster.notify("Keep a Host first: m on its row, or :discover keep all", "info", { quiet = false })
    return
  end
  if not roster.has(ADDS) then
    roster.notify("Adding needs " .. ADDS .. ": allow it in :plugins", "warn")
    return
  end
  local names = {}
  for i, a in ipairs(picks) do
    if i > 8 then
      names[#names + 1] = "and " .. (#picks - 8) .. " more"
      break
    end
    names[#names + 1] = found[a].name or a
  end
  local id = scan.id
  roster.confirm({
    title = "Add " .. model.plural(#picks, "Host", "Hosts") .. " to the Inventory?",
    text = "They go in a new group, unreviewed, as Pending changes: nothing connects to them, and "
      .. "nothing is Published. Review them in :changes (names, Logins), then Publish.",
    facts = {
      { label = "Hosts", value = table.concat(names, ", "), data = true },
      { label = "Group", value = settings.group or "a new discovered-YYYYMMDD", data = settings.group ~= nil },
    },
    action = "Add",
    run = function()
      if adding then return end
      adding = true
      request("discover.add", { scan = id, addresses = picks, group = settings.group }, function(ok, r)
        adding = false
        if not ok then
          roster.notify("Nothing was added: " .. model.message(r), "error")
          return
        end
        local touched = {}
        for _, x in ipairs(r.added) do
          local f = found[x.address]
          if f then
            f.added = x.name
            kept[x.address] = nil
            touched[#touched + 1] = x.address
          end
        end
        redraw(touched)
        roster.notify("Added " .. model.plural(#r.added, "Host", "Hosts") .. " to " .. r.group
          .. " as Pending changes: review them in :changes, then Publish", "info", { quiet = false })
      end)
    end,
  })
end

local function stop()
  if not scan or scan.state ~= "running" then return end
  request("discover.stop", { scan = scan.id }, function() end)
end

local poll -- below

local function progress()
  if not scan then return end
  if scan.state == "running" or scan.state == "stopping" then
    roster.progress.set("scan", {
      title = "Scanning " .. model.list(scan.targets),
      text = model.plural(scan.count, "Host", "Hosts") .. " found so far",
      done = scan.done,
      total = scan.total,
      cancel = stop,
    })
  else
    roster.progress.remove("scan")
  end
end

-- What roster serve said about the scan: the new results, how far it has got, and whether it's over.
local function heard(ok, r)
  if not scan then return end
  if not ok then
    -- roster serve restarted (its scans don't outlive it), or the permission was taken away.
    scan.state, scan.error = "failed", model.message(r)
  else
    scan.state, scan.done, scan.total, scan.count, scan.error = r.state, r.done, r.total, r.count, r.error
    local fresh = {}
    for _, f in ipairs(r.found) do
      if found[f.address] == nil then
        if #order >= model.MAX_ROWS then
          cut = true
          break
        end
        order[#order + 1] = f.address
      end
      found[f.address] = f
      fresh[#fresh + 1] = f.address
    end
    redraw(fresh)
  end
  progress()
  if scan.state ~= "running" and scan.state ~= "stopping" then
    if polling then roster.cancel(polling) end
    polling = nil
    retell()
    if scan.state == "failed" then
      roster.notify("The scan of " .. model.list(scan.targets) .. " failed: " .. (scan.error or "no reason given"), "error")
    else
      local new = counts()
      roster.notify((scan.state == "stopped" and "Stopped: " or "Scan done: ") .. model.plural(scan.count, "Host", "Hosts")
        .. " answered, " .. model.count(new) .. " new", "info", { quiet = false })
    end
  end
end

-- Asks roster serve how the scan is going, one question at a time however long serve takes.
poll = function()
  if not scan then return end
  if asking then
    again = true
    return
  end
  asking, again = true, false
  local id = scan.id
  request("discover.status", { scan = id, since = scan.count }, function(ok, r)
    asking = false
    -- A newer scan started meanwhile: this answer is about the old one.
    if scan and scan.id == id then heard(ok, r) end
    if again and scan and (scan.state == "running" or scan.state == "stopping") then poll() end
  end)
end

-- serve's job_progress (API 20): each one may bring results, so ask (one question out at a
-- time); the first one means serve pushes, so the timer goes.
if roster.has("serve:discover.status") then
  roster.on("job_progress", function(e)
    if e.kind ~= "discover" then return end
    pushed = true
    if polling then
      roster.cancel(polling)
      polling = nil
    end
    if scan and scan.id == e.job and (scan.state == "running" or scan.state == "stopping") then poll() end
  end)
end

-- The table: what each column shows, and what a row can do.
---@type roster.Table
local TABLE = {
  columns = {
    { id = "keep", label = "Keep", width = 5 },
    { id = "address", label = "Address", kind = "data", width = 16 },
    { id = "name", label = "Name", kind = "data", width = 24 },
    { id = "type", label = "Looks like", width = 10 },
    { id = "ports", label = "Open ports" },
    { id = "title", label = "Title" },
    { id = "status", label = "Status", width = 22 },
  },
  sort = "address",
  empty = "Nothing found yet.",
  open = details,
  actions = {
    { label = "Keep", key = "m", icon = "add", when = { state = "new", pick = "no" },
      run = function(e) mark(e.row, true) end },
    { label = "Don't keep", key = "u", icon = "close", when = { state = "new", pick = "yes" },
      run = function(e) mark(e.row, false) end },
    { label = "Add the kept Hosts", key = "A", icon = "addGroup", when = { pick = "yes" }, run = add },
    { label = "Details", key = "i", icon = "info", run = details },
  },
}

local function view()
  local text, facts = words()
  TABLE.rows = {}
  roster.views.set(VIEW, { title = "Discover", place = "full", text = text, facts = facts, table = TABLE })
end

-- The scan roster serve started.
local function started(r)
  scan = { id = r.scan, targets = r.targets, scanner = r.scanner, state = r.state, done = r.done,
    total = r.total, count = 0, error = nil }
  -- The last scan's rows go; the table and its actions stay as they were set.
  local gone = {}
  for _, a in ipairs(order) do
    gone[#gone + 1] = a
    if #gone == model.CHUNK then
      roster.views.update(VIEW, { remove = gone })
      gone = {}
    end
  end
  if #gone > 0 then roster.views.update(VIEW, { remove = gone }) end
  found, order, kept, cut = {}, {}, {}, false
  retell()
  -- The answer to the user's Scan is part of it: the view may open.
  roster.views.open(VIEW)
  progress()
  if polling then roster.cancel(polling) end
  polling = nil
  -- It may be over already (its end pushed before this answer): ask once; until serve has
  -- pushed anything, a timer asks.
  if pushed then poll() else polling = roster.every(1000, poll) end
end

-- Starts the scan the user confirmed.
---@param targets string[]
---@param force boolean
local function start(targets, force)
  request("discover.start", { targets = targets, ports = settings.ports, force = force }, function(ok, r)
    if not ok then
      roster.notify("The scan didn't start: " .. model.message(r), model.code(r) == 120 and "warn" or "error")
      return
    end
    started(r)
  end)
end

local confirm -- below

-- Asks before scanning `targets`: what will happen, to how many addresses, from where.
---@param targets string[]
local function ask(targets)
  if #missing() > 0 then
    roster.notify("Discover needs " .. model.list(missing()) .. ": allow them in :plugins", "warn")
    return
  end
  if scan and (scan.state == "running" or scan.state == "stopping") then
    roster.notify("A scan of " .. model.list(scan.targets) .. " is going: stop it first (:discover stop)", "warn")
    return
  end
  if planning then
    roster.notify("Still waiting for roster serve to size the last range: a moment", "info", { quiet = false })
    return
  end
  planning = true
  -- With force, the plan says how many addresses whatever the range; a scan of more than `limit`
  -- needs the stronger question. The question comes with the answer, still part of the user's call.
  request("discover.plan", { targets = targets, ports = settings.ports, force = true }, function(ok, plan)
    planning = false
    confirm(ok, plan)
  end)
end

-- The question before a scan, from discover.plan's answer.
confirm = function(ok, plan)
  if not ok and model.code(plan) == -32601 then
    roster.notify("Not scanned: the roster on this Box is too old to scan from the app (it needs roster "
      .. "serve API 18). Update roster there, or run `roster discover` in a terminal.", "error")
    return
  elseif not ok then
    roster.notify("Not scanned: " .. model.message(plan), "error")
    return
  end
  local force = plan.addresses > plan.limit
  local where = model.list(plan.targets)
  local text = "roster scans from this computer: it connects to each of the " .. model.plural(plan.addresses,
    "address", "addresses") .. " on " .. model.plural(plan.ports, "TCP port", "TCP ports") .. ", with "
    .. plan.scanner .. ". Scan only networks you may: their security tools may take a scan for an attack."
    .. "\n\nNothing is added until you pick what to keep."
  if force then
    text = text .. "\n\nThat's more than " .. model.count(plan.limit) .. " addresses, so it takes a while. "
      .. "Type the range to scan it."
  end
  roster.confirm({
    title = "Scan " .. where .. "?",
    text = text,
    facts = {
      { label = "Range", value = where, data = true },
      { label = "Addresses", value = model.count(plan.addresses) },
      { label = "Ports", value = model.count(plan.ports) },
      { label = "Scanner", value = plan.scanner },
    },
    action = "Scan",
    danger = force,
    typed = force and plan.targets[1] or nil,
    run = function() start(plan.targets, force) end,
  })
end

roster.commands.add("discover", {
  desc = "Scan a network: :discover RANGE…, :discover stop, :discover keep all|none, :discover add",
  ---@param a roster.CommandArgs
  run = function(a)
    local what = a.words[1]
    if what == "stop" then
      if scan and scan.state == "running" then stop() else roster.notify("No scan is going", "info", { quiet = false }) end
    elseif what == "add" then
      add()
    elseif what == "keep" then
      local all = a.words[2] == "all"
      if a.words[2] ~= "all" and a.words[2] ~= "none" then
        roster.notify(":discover keep all, or :discover keep none", "warn")
        return
      end
      local touched = {}
      for _, addr in ipairs(order) do
        if model.state(found[addr]) == "new" and (kept[addr] == true) ~= all then
          kept[addr] = all or nil
          touched[#touched + 1] = addr
        end
      end
      redraw(touched)
      roster.views.open(VIEW)
    elseif what == nil then
      if not scan and #settings.ranges > 0 then
        ask(settings.ranges)
      else
        roster.views.open(VIEW)
      end
    else
      ask(a.words)
    end
  end,
})
if settings.leader then roster.keymap.set("leader", settings.leader, "discover") end
roster.toolbar.set("discover", { label = "Scan a network for Hosts", text = "Scan", icon = "map", run = "discover" })

roster.help.set("discover", {
  title = "Discover",
  summary = "Scan a network from the app and add what it finds",
  markdown = table.concat({
    "# Discover",
    "",
    "Scans a network for Hosts, from this computer, the way `roster discover` does, and shows what answered: "
      .. "its address, the name it would get, what it looks like, its open ports and its web page's title. "
      .. "You keep the ones you want and add them: they go into the Inventory in a new group, **unreviewed**, "
      .. "as Pending changes you review in `:changes` and Publish. Nothing is added, and nothing connects to "
      .. "a Host, before you say so.",
    "",
    "- `:discover 10.0.0.0/24` scans a range (several: `:discover 10.0.0.0/24 10.0.1.0/28`). It asks first, "
      .. "with how many addresses and ports.",
    "- `:discover` opens the view" .. (#settings.ranges > 0 and (", or scans " .. model.list(settings.ranges)
      .. " if nothing has been scanned yet") or "") .. "; " .. (settings.leader and ("`␣ " .. settings.leader .. "` and ") or "") .. "the toolbar's **Scan** "
      .. (settings.leader and "do" or "does") .. " the same.",
    "- On a row: `m` keeps it, `u` doesn't, `A` adds the kept ones, `i` or Enter shows its details. "
      .. "`:discover keep all` and `:discover keep none` mark every new one.",
    "- `:discover stop` (or `:cancel scan`, or the stop button by the progress) stops the scan; what it found stays.",
    "",
    "The scan runs in roster serve: nmap when it's installed (service versions and web page titles), "
      .. "else roster's own TCP connect scan. Up to 4,096 addresses as asked; more, up to a /16, only after "
      .. "you type the range. A Host already in the Inventory shows with its name, greyed out.",
    "",
    "It needs `serve:discover.plan`, `.start`, `.status` and `.stop` to scan, and `serve:discover.add` to add. "
      .. "See `:help plugins`.",
  }, "\n"),
})

-- A section of `:check`: whether this Box's roster can scan, and with what. discover.plan connects
-- nowhere, so :check stays safe to run anywhere.
roster.health.set("discover", {
  title = "Discover",
  check = function(e)
    local gone = missing()
    if #gone > 0 then
      return { { level = "warn", message = model.list(gone) .. " not granted: Discover can't scan",
        fix = "Allow them in :plugins" } }
    end
    -- It answers later (decision Q112h): discover.plan is asked without waiting, so :check never
    -- holds this Plugin's thread while serve is busy (behind a Publish, that's a while).
    request("discover.plan", { targets = { "10.0.0.0/30" } }, function(ok, plan)
      local out
      if not ok and model.code(plan) == -32601 then
        out = { { level = "error", message = "roster on this Box can't scan from the app (it needs roster serve API 18)",
          fix = "Update roster on this Box; `roster discover` in a terminal works meanwhile" } }
      elseif not ok then
        out = { { level = "error", message = "roster serve didn't answer discover.plan: " .. model.message(plan) } }
      else
        out = { { level = "ok", message = "roster serve can scan, with " .. plan.scanner } }
        if plan.scanner ~= "nmap" then
          out[1] = { level = "warn", message = "nmap isn't installed on this Box: scans use roster's own TCP connect "
            .. "scan, with no service versions or web page titles", fix = "Install nmap on this Box (apt install nmap)" }
        end
        if not roster.has(ADDS) then
          out[#out + 1] = { level = "warn", message = ADDS .. " isn't granted: scans can't add what they find",
            fix = "Allow it in :plugins" }
        end
      end
      roster.health.answer(e.check, out)
    end)
    return "later"
  end,
})

view()
