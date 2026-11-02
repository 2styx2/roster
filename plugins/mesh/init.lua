-- mesh: the Mesh's controls in the roster app (decision Q80: the core stays small, and the Mesh
-- itself, `roster mesh`, stays in the CLI and roster serve). Who reaches whom and each Host's reach
-- ("can reach 7 Hosts"), "Mesh out of date" after a Publish, a plan you look at before an apply you
-- confirm, and a Cut you confirm by typing the Host's name. It's an ordinary Plugin, built only on
-- the public Plugin API, with the permissions its manifest asks for (README.md says why each).
--
-- Every Mesh run (plan, apply, cut) is a job in roster serve (`background = true`, API 17): a
-- Mesh of many Hosts takes minutes. Every call into serve is a `roster.serve.request` that
-- doesn't wait (decision Q103): the app's Publish can hold serve for a minute or two, while the
-- Mesh's controls keep answering. serve pushes a job's
-- progress (`job_progress`, serve API 20), and the Plugin asks `mesh.job` once when it ends, for
-- the result. Until the first `job_progress` comes (an older serve sends none), a timer asks
-- `mesh.job` once a second instead, one question at a time.
--
-- Install it as a Package (plugins/README.md):
--   roster.packages.add({ "https://github.com/2styx2/roster", dir = "plugins/mesh" })
local roster = require("roster")
local words = require("mesh.words")

local settings, problems = words.settings(roster.plugin.config)
for _, p in ipairs(problems) do
  roster.notify(p .. "; using the default", "warn")
end

local POLL = 1000 -- ms between mesh.job polls while a job runs
local DETAIL_LINKS = 20 -- a Host's Links worth a look, at most, in its details
local DETAILS_AT_ONCE = 300 -- Host-details sections set in one call; the rest come in deferred calls
local ACTIONS = { plan = "Planning the Mesh", apply = "Applying the Mesh", cut = "Cutting" }

---@class MeshJob
---@field job integer
---@field action string
---@field host string?
---@field total integer

local state = {
  status = nil, ---@type table? mesh.status, brief
  problem = nil, ---@type string? why there's no status
  jobs = false, -- roster serve has Mesh jobs (API 17)
  job = nil, ---@type MeshJob? the job being followed
  starting = nil, ---@type string? the job asked for, until serve answers
  asking = false, -- a mesh.job question is out
  recheck = false, -- the job ended while that question was out: ask again once it's back
  pushed = false, -- serve pushes job_progress: no timer needed
  refreshing = false, -- a refresh is out
  again = false, -- refresh again once it's back
  timer = nil, ---@type roster.Timer?
  done = 0, -- how far the job has got
  plan = nil, ---@type table? the last plan (brief)
  planned = nil, ---@type integer? when
  last = nil, ---@type string? what the last apply or cut did, in words
  badged = {}, ---@type table<string, boolean>
  detailed = {}, ---@type table<string, boolean>
  queue = {}, ---@type string[] Hosts whose details are still to set
}

local function can(method) return roster.has("serve:" .. method) end

-- Asks roster serve without waiting: `done(true, result)` or `done(false, why)` comes later.
---@param done fun(ok: boolean, result: any)
local function ask(method, params, done)
  if not roster.serve then return done(false, "no serve permission") end
  local sent, err = pcall(roster.serve.request, method, params or {}, function(r, why)
    if why then done(false, why) else done(true, r) end
  end)
  if not sent then done(false, err) end
end

local show -- draws everything from `state`, below
local poll -- follows a running job, below

-- ------------------------------------------------------------------ reading the Mesh

local refresh

-- mesh.status (brief: a meshed group of 500 Hosts is 249,500 Links), once serve has answered.
local function ask_status()
  ask("mesh.status", { brief = true }, function(ok, r)
    if ok then
      state.status, state.problem = r, nil
    else
      state.status, state.problem = nil, "roster serve couldn't say how the Mesh is: " .. words.clean(r)
    end
    state.refreshing = false
    show()
    if state.again then refresh() end
  end)
end

-- mesh.status, and whether serve has jobs. One at a time: asked again meanwhile, it goes again
-- once this one is back.
refresh = function()
  if not (can("mesh.status") and can("mesh.job")) then
    state.status, state.problem = nil, "Allow serve:mesh.status and serve:mesh.job in :plugins to see the Mesh."
    return show()
  end
  if state.refreshing then
    state.again = true
    return
  end
  state.refreshing, state.again = true, false
  if state.jobs then return ask_status() end
  ask("mesh.job", {}, function(ok, j)
    if not ok then
      local e = words.clean(j)
      state.status, state.refreshing = nil, false
      state.problem = e:find("unknown method", 1, true)
          and "This roster serve has no Mesh jobs (API 17): update roster to use the Mesh controls."
        or ("roster serve couldn't say how the Mesh is: " .. e)
      return show()
    end
    state.jobs = true
    if j and j.state == "running" and not state.job then
      state.job = { job = j.job, action = j.action, host = j.host, total = j.total }
      if not state.pushed then state.timer = roster.every(POLL, function() poll() end) end
    end
    ask_status()
  end)
end

-- ------------------------------------------------------------------ jobs

local function over(j)
  if state.timer then roster.cancel(state.timer) end
  state.timer, state.done = nil, 0
  roster.progress.remove("mesh")
  local action, host = state.job and state.job.action, state.job and state.job.host
  state.job = nil
  if j == nil then
    roster.notify("The Mesh's job is gone: roster serve restarted. Plan again to see where it got to.", "warn")
    return refresh()
  end
  if j.state == "failed" then
    roster.notify("The Mesh " .. action .. " failed: " .. j.error.message, "error")
    return refresh()
  end
  local r = j.result
  local stopped = j.stopped and (", stopped: " .. words.plural(#words.keys(r.pending), "Host", "Hosts") .. " left pending") or ""
  if action == "plan" then
    state.plan, state.planned = r, os.time()
    local n = 0
    for _, h in ipairs(r.hosts) do
      if #h.changes > 0 then n = n + 1 end
    end
    -- The plan ran in the background: the notice's button opens it (the click is the user's call).
    roster.notify(r.already and "Plan ready: the Mesh is as roster.yml says, nothing to apply."
      or ("Plan ready: " .. words.plural(n, "Host", "Hosts") .. " would change" .. stopped .. ". Press a in :view mesh-plan to apply it."),
      "info", { actions = { { label = "Show the plan", run = "view mesh-plan" } } })
  elseif action == "apply" then
    state.plan = nil
    local changed, pending = 0, #words.keys(r.pending)
    for _, h in ipairs(r.hosts) do
      if h.status == "changed" then changed = changed + 1 end
    end
    state.last = r.already and "Applied: already in the Mesh." or ("Applied: " .. words.plural(changed, "Host", "Hosts") .. " changed"
      .. (pending > 0 and (", " .. words.count(pending) .. " pending (the next apply finishes them)") or "") .. stopped .. ".")
    roster.notify(state.last, pending > 0 and "warn" or "info", { quiet = false })
  else
    state.plan = nil
    local pending = words.keys(r.pending)
    state.last = host .. " is cut from the Mesh on " .. words.plural(#r.confirmed, "Host", "Hosts") .. "."
    roster.notify(state.last, #pending > 0 and "warn" or "info", { quiet = false })
    -- A warning per Host that's down: it may still let the cut Host in.
    for i, h in ipairs(pending) do
      if i > 5 then
        roster.notify("CUT PENDING on " .. words.count(#pending - 5) .. " more Hosts: see :view mesh", "warn")
        break
      end
      roster.notify("CUT PENDING on " .. h .. ": " .. r.pending[h] .. ". Until it's done there, " .. h .. " may still let " .. host .. " in. Cut again once it answers.", "warn")
    end
    -- What roster left on the cut Host's own side: an earlier mesh_dir: (serve API 24; older ones say nothing).
    for _, w in ipairs(r.warnings or {}) do roster.notify(w, "warn", { quiet = false }) end
    local c = r.change or {}
    if c.error then roster.notify("mesh: false for " .. host .. " wasn't written: " .. c.error .. " (" .. c.fix .. ")", "warn") end
  end
  refresh()
end

local function stop(job)
  ask("mesh.stop", { job = job }, function() end)
end

-- The job's progress in the status bar: from mesh.job's answer or a job_progress event.
local function draw(j)
  state.done = j.done
  roster.progress.set("mesh", {
    title = (ACTIONS[j.action] or j.action) .. (state.job.host and (" " .. state.job.host .. " out") or ""),
    text = j.at and ("At " .. j.at) or nil,
    done = j.done,
    total = j.total,
    cancel = can("mesh.stop") and function() stop(state.job.job) end or nil,
  })
  if j.action == "plan" then show() end
end

-- Asks mesh.job how the job is getting on (the timer's function, and once a job starts or ends):
-- one question out at a time, however long serve takes.
poll = function()
  if not state.job then return end
  if state.asking then
    state.recheck = true
    return
  end
  state.asking, state.recheck = true, false
  local following = state.job.job
  ask("mesh.job", { job = following, brief = true }, function(ok, j)
    state.asking = false
    -- serve is busy or gone for a moment (try again on the next tick), or the job was let go.
    if not ok or not state.job or state.job.job ~= following then return end
    if j == nil or j.state ~= "running" then return over(j) end
    draw(j)
    if state.recheck then poll() end
  end)
end

-- serve's job_progress (API 20): the progress as it moves, and mesh.job asked once it's over.
-- The first one means serve pushes, so the timer goes.
if can("mesh.job") then
  roster.on("job_progress", function(e)
    if e.kind ~= "mesh" then return end
    state.pushed = true
    if state.timer then
      roster.cancel(state.timer)
      state.timer = nil
    end
    if not state.job or state.job.job ~= e.job then return end
    if e.state == "running" or e.state == "stopping" then return draw(e) end
    poll()
  end)
end

-- Whether a job runs already (or is being asked for); says so when it does.
local function busy()
  if state.starting then
    roster.notify("A Mesh " .. state.starting .. " is starting: wait for roster serve to answer.", "warn")
    return true
  end
  if not state.job then return false end
  roster.notify("A Mesh " .. state.job.action .. " is running: wait for it, or stop it with :cancel mesh.", "warn")
  return true
end

-- Whether it may run `action` (plan, apply or cut); says what's missing when it may not.
local function allowed(action)
  if can("mesh." .. action) then return true end
  roster.notify("Allow serve:mesh." .. action .. " in :plugins to " .. action .. " the Mesh from here.", "warn")
  return false
end

-- Starts a Mesh job: `action` is plan, apply or cut. True once it's asked for; whether it
-- started comes when roster serve answers.
local function start(action, params)
  if busy() then return false end
  if not state.jobs then
    roster.notify(state.problem or "roster serve can't run the Mesh from here.", "warn")
    return false
  end
  if not allowed(action) then return false end
  params.background = true
  state.starting = action
  ask("mesh." .. action, params, function(ok, r)
    state.starting = nil
    if not ok then
      roster.notify("The Mesh " .. action .. " didn't start: " .. words.clean(r), "error")
      return
    end
    state.job = { job = r.job, action = r.action, host = r.host, total = r.total }
    state.done = 0
    if action == "plan" then state.plan = nil end
    roster.progress.set("mesh", {
      title = ACTIONS[action] .. (r.host and (" " .. r.host .. " out") or ""),
      done = 0,
      total = r.total,
      cancel = can("mesh.stop") and function() stop(r.job) end or nil,
    })
    -- Pushed progress follows it from here, after one question (it may be over already: its
    -- end was pushed before this answer came); until serve has pushed any, a timer asks.
    if state.pushed then poll() else state.timer = roster.every(POLL, poll) end
    show()
  end)
  return true
end

-- ------------------------------------------------------------------ what the user does

local function plan()
  if start("plan", {}) then roster.views.open("mesh-plan") end
end

-- Apply only what a plan showed, after a question.
local function apply()
  if not allowed("apply") or busy() then return end
  local p = state.plan
  if not p then
    roster.notify("Plan first: here's what an apply would change. Press a when you've looked.", "info", { quiet = false })
    return plan()
  end
  if p.already then return roster.notify("Nothing to apply: the plan changes nothing.", "info", { quiet = false }) end
  local change, left = 0, 0
  for _, h in ipairs(p.hosts) do
    if #h.changes > 0 then change = change + 1 end
  end
  for status, n in pairs(p.link_statuses or {}) do
    if words.LEFT_OUT[status] then left = left + n end
  end
  roster.confirm({
    title = "Apply the Mesh?",
    text = "roster connects to each Host in turn, one at a time, and writes what the plan shows: Mesh keys in authorized_keys, and each source's ssh config. It applies roster.yml as it is now. A Host that doesn't answer is left pending, and the next apply finishes it.",
    facts = {
      { label = "Hosts that change", value = words.count(change) .. " of " .. words.count(#p.hosts) },
      { label = "Links that work", value = words.count((p.link_statuses or {}).ok or 0) },
      { label = "Links left out", value = words.count(left) },
    },
    action = "Apply",
    run = function() start("apply", {}) end,
  })
end

-- Cut a Host out of the Mesh now, after it's typed.
local function cut(host)
  if not allowed("cut") or busy() then return end
  local st = state.status
  local member = false
  for _, m in ipairs(st and st.members or {}) do
    if m == host then member = true end
  end
  if not member then return roster.notify(host .. " isn't in the Mesh: there's nothing to cut.", "warn") end
  roster.confirm({
    title = "Cut " .. host .. " from the Mesh?",
    text = "Its key comes off every Host it can reach, every peer's key comes off " .. host .. ", and its Mesh files go, on every Host at once. This Box's own access stays.\n\nThen mesh: false for " .. host .. " is written to roster.yml as a Pending change, so the cut survives the next Publish. A Host that doesn't answer gets a warning until the cut is finished there.",
    facts = {
      { label = "Host", value = host, data = true },
      { label = "reach", value = words.reach(st.reach[host] or 0) },
      { label = "reached from", value = words.plural(st.reached[host] or 0, "Host", "Hosts") },
    },
    action = "Cut",
    danger = true,
    typed = host,
    run = function() start("cut", { host = host }) end,
  })
end

-- A Link's details: what its status means and what to do.
local function explain(x)
  local lines = { words.link(x), "", "Status  " .. words.status(x.status) }
  if x.why then lines[#lines + 1] = "Why     " .. x.why end
  lines[#lines + 1] = ""
  lines[#lines + 1] = words.FIX[x.status or "asked"] or ""
  roster.float.open({ title = "Link " .. words.link(x), lines = lines })
end

-- The Links shown: the plan's (tested) when there is one, else roster.yml's.
local function links()
  local from = state.plan or state.status
  return from and from.links or {}
end

-- ------------------------------------------------------------------ drawing

local function hosts_of(st)
  local seen, out = {}, {}
  local function add(h)
    if not seen[h] then seen[h], out[#out + 1] = true, h end
  end
  for _, h in ipairs(st.members or {}) do add(h) end
  for _, h in ipairs(words.keys(st.excluded)) do add(h) end
  for _, h in ipairs(words.keys(st.pending)) do add(h) end
  for _, h in ipairs(words.keys(st.cut_pending)) do
    add(h)
    for _, p in ipairs(st.cut_pending[h]) do add(p) end
  end
  table.sort(out)
  return out
end

local function link_rows(list)
  local rows = {}
  for i, x in ipairs(list) do
    local tone = words.LEFT_OUT[x.status] and "error" or (x.status == "pending" and "warn") or nil
    rows[#rows + 1] = {
      id = "l" .. i,
      cells = { from = x.from, to = x.to, via = x.via or "", status = words.status(x.status), why = x.why or "" },
      tone = tone,
    }
  end
  return rows
end

local function link_of(e)
  local i = tonumber((e.row or ""):match("^l(%d+)$"))
  return i and links()[i]
end

local function by_host(e) return e.host end

-- A Host's details, from a row: the full view closes first, so the details panel isn't under it.
local function info(e)
  roster.views.close(e.view)
  roster.cmd("info " .. e.host)
end

local function draw_details(names)
  local st = state.status
  if not st then return end
  local mine = {}
  for _, x in ipairs(links()) do
    for _, h in ipairs({ x.from, x.to }) do
      mine[h] = mine[h] or {}
      if #mine[h] < DETAIL_LINKS then mine[h][#mine[h] + 1] = x end
    end
  end
  local members = {}
  for _, m in ipairs(st.members or {}) do members[m] = true end
  for _, h in ipairs(names) do
    local what = words.state(h, st)
    local section = {
      title = "Mesh",
      facts = {
        { label = "reach", value = words.reach(st.reach[h] or 0) },
        { label = "reached from", value = words.plural(st.reached[h] or 0, "Host", "Hosts") },
        { label = "state", value = what },
      },
    }
    if members[h] then
      -- The Host itself is the facts above and the Cut on the heading; the rows are its Links.
      local rows = {}
      for i, x in ipairs(mine[h] or {}) do
        rows[#rows + 1] = { id = "l" .. i, cells = { link = words.link(x), status = words.status(x.status), member = "yes" },
          tone = words.LEFT_OUT[x.status] and "error" or nil }
      end
      section.text = #rows == 0 and "Every Link of this Host works as roster.yml asks." or "The Links worth a look: a hop (via) or a problem."
      if #rows > 0 then
        section.table = {
          columns = { { id = "link", label = "Link", kind = "data" }, { id = "status", label = "Status" } },
          rows = rows,
          open = function(e)
            local x = (mine[e.host] or {})[tonumber((e.row or ""):match("^l(%d+)$") or "")]
            if x then explain(x) end
          end,
        }
      end
      -- Cut on the section's heading: it's about this Host, not one of its Links; x anywhere in
      -- the section runs it (api 4).
      section.actions = { { label = "Cut " .. h .. " from the Mesh", key = "x", icon = "cut", run = function(e) cut(e.host) end } }
    end
    roster.details.set("mesh", h, section)
    state.detailed[h] = true
  end
end

-- The Host-details sections, a few hundred per call (a call may make at most 1,000 UI changes).
local function details()
  local st = state.status
  local now = {}
  for _, h in ipairs(st and hosts_of(st) or {}) do now[h] = true end
  for _, h in ipairs(words.keys(state.detailed)) do
    if not now[h] then
      roster.details.set("mesh", h, nil)
      state.detailed[h] = nil
    end
  end
  local all = st and hosts_of(st) or {}
  local first = {}
  for i = 1, math.min(#all, DETAILS_AT_ONCE) do first[i] = all[i] end
  draw_details(first)
  state.queue = {}
  for i = DETAILS_AT_ONCE + 1, #all do state.queue[#state.queue + 1] = all[i] end
  local function more()
    local batch = {}
    while #batch < DETAILS_AT_ONCE and #state.queue > 0 do batch[#batch + 1] = table.remove(state.queue, 1) end
    draw_details(batch)
    if #state.queue > 0 then roster.defer(50, more) end
  end
  if #state.queue > 0 then roster.defer(50, more) end
end

local function badges(st)
  local want = {}
  for _, cut_host in ipairs(words.keys(st and st.cut_pending)) do
    want[cut_host] = "cut pending"
    for _, p in ipairs(st.cut_pending[cut_host]) do want[p] = "cut pending" end
  end
  for _, h in ipairs(words.keys(st and st.pending)) do want[h] = want[h] or "pending" end
  local names = words.keys(want)
  for _, h in ipairs(words.keys(state.badged)) do
    if not want[h] then names[#names + 1] = h end
  end
  table.sort(names)
  for _, h in ipairs(names) do roster.badges.set(h, want[h]) end
  state.badged = {}
  for h in pairs(want) do state.badged[h] = true end
end

local function segment(st)
  if state.job or not st then return roster.status.remove("mesh") end
  local cuts = words.keys(st.cut_pending)
  local pending = words.keys(st.pending)
  if #cuts > 0 then
    roster.status.set("mesh", { text = "Cut pending", title = "A cut isn't finished on every Host: :view mesh", run = "view mesh" })
  elseif st.out_of_date then
    roster.status.set("mesh", { text = "Mesh out of date", title = "roster.yml changed the Mesh since the last apply: plan it, then apply", run = "mesh plan" })
  elseif #pending > 0 then
    roster.status.set("mesh", { text = "Mesh: " .. words.count(#pending) .. " pending", title = "Hosts that didn't answer: the next apply finishes them", run = "view mesh" })
  else
    roster.status.remove("mesh")
  end
end

local function overview(st)
  if not st then return { state.problem or "Loading…" }, {} end
  local count, statuses = st.link_count or #st.links, st.link_statuses or {}
  local text = {}
  if #(st.members or {}) == 0 then
    text[#text + 1] = "No Hosts are in the Mesh. Set mesh: true on a group in roster.yml, or add links:, then Publish."
  else
    text[#text + 1] = words.plural(#st.members, "Host", "Hosts") .. " in the Mesh, " .. words.plural(count, "Link", "Links") .. "."
      .. " Each Host's reach is who it can log in to with its Mesh key: the risk if it's taken over."
  end
  if st.out_of_date then text[#text + 1] = "roster.yml changed the Mesh since the last apply on this Box: plan it (p), then apply it (a)." end
  if (statuses["no-via"] or 0) > 0 then
    text[#text + 1] = words.plural(statuses["no-via"], "Link goes", "Links go") .. " through a jump Host its source has no Link to (no-via): see :view mesh-links."
  end
  if state.last then text[#text + 1] = state.last end
  local facts = {
    { label = "Hosts", value = words.count(#(st.members or {})) },
    { label = "Links", value = words.count(count) },
    { label = "out of date", value = st.out_of_date and "yes" or "no" },
    { label = "pending", value = words.count(#words.keys(st.pending)) },
    { label = "cut pending", value = words.count(#words.keys(st.cut_pending)) },
  }
  return text, facts
end

local function views()
  local st = state.status
  local text, facts = overview(st)
  local rows, members = {}, {}
  for _, m in ipairs(st and st.members or {}) do members[m] = true end
  for i, h in ipairs(st and hosts_of(st) or {}) do
    local what, tone = words.state(h, st)
    rows[#rows + 1] = { id = words.id(h, i), host = h, tone = tone,
      cells = { host = h, reach = st.reach[h] or 0, reached = st.reached[h] or 0, state = what, member = members[h] and "yes" or "no" } }
  end
  roster.views.set("mesh", {
    title = "Mesh",
    place = "full",
    actions = {
      { label = "Plan", icon = "plan", run = plan },
      { label = "Apply", icon = "apply", run = apply },
    },
    text = table.concat(text, "\n\n"),
    facts = facts,
    table = {
      columns = {
        { id = "host", label = "Host", kind = "data" },
        { id = "reach", label = "Can reach", kind = "number" },
        { id = "reached", label = "Reached from", kind = "number" },
        { id = "state", label = "State" },
      },
      rows = rows,
      sort = "host",
      empty = st and "No Hosts in the Mesh." or (state.problem or "Loading…"),
      open = function(e) info(e) end,
      actions = {
        { label = "Plan", key = "p", icon = "plan", run = plan },
        { label = "Apply", key = "a", icon = "apply", run = apply },
        { label = "Links", key = "l", run = function() roster.views.open("mesh-links") end },
        { label = "Cut", key = "x", icon = "cut", when = { member = "yes" }, run = function(e) cut(by_host(e)) end },
      },
    },
  })

  -- The Links worth a look.
  local list = links()
  local from = state.plan or st
  local ltext = {}
  if from then
    local statuses = from.link_statuses or {}
    local parts = {}
    for _, s in ipairs(words.keys(statuses)) do parts[#parts + 1] = words.count(statuses[s]) .. " " .. words.status(s) end
    ltext[#ltext + 1] = words.plural(from.link_count or #list, "Link", "Links") .. (#parts > 0 and (": " .. table.concat(parts, ", ")) or "") .. "."
    ltext[#ltext + 1] = "Listed: the Links that go through a jump Host (via) or have a problem"
      .. ((from.links_more or 0) > 0 and (", the first " .. words.count(#list) .. " of " .. words.count(#list + from.links_more)) or "")
      .. (state.plan and "" or ". Plan the Mesh to test them all") .. "."
    ltext[#ltext + 1] = "no-via: the Link goes through a jump Host its source has no Link to. ssh logs in to the jump Host first, so add a Link from the source to it in roster.yml, or take via: off."
  else
    ltext[#ltext + 1] = state.problem or "Loading…"
  end
  roster.views.set("mesh-links", {
    title = "Mesh Links",
    place = "full",
    text = table.concat(ltext, "\n\n"),
    table = {
      columns = {
        { id = "from", label = "From", kind = "data" },
        { id = "to", label = "To", kind = "data" },
        { id = "via", label = "Via", kind = "data" },
        { id = "status", label = "Status", width = 18 },
        { id = "why", label = "Why" },
      },
      rows = link_rows(list),
      empty = "No Link goes through a jump Host or has a problem.",
      open = function(e)
        local x = link_of(e)
        if x then explain(x) end
      end,
      actions = {
        { label = "Explain", key = "e", run = function(e)
          local x = link_of(e)
          if x then explain(x) end
        end },
        { label = "Plan", key = "p", run = plan },
      },
    },
  })

  -- The plan, before an apply.
  local p, ptext, pfacts, prows = state.plan, {}, {}, {}
  if state.job and state.job.action == "plan" then
    ptext[1] = "Planning: roster connects to each Host in turn and changes nothing. " .. words.count(state.done) .. " of " .. words.plural(state.job.total, "step", "steps") .. " so far."
  elseif p then
    local change = 0
    for i, h in ipairs(p.hosts) do
      if #h.changes > 0 then change = change + 1 end
      local what = table.concat(h.changes, "; ") .. ((h.more or 0) > 0 and ("; and " .. words.count(h.more) .. " more") or "")
      prows[#prows + 1] = { id = words.id(h.host, i), host = h.host,
        tone = h.status == "pending" and "warn" or (#h.changes == 0 and "muted" or nil),
        cells = { host = h.host, status = h.status == "would-change" and "would change" or h.status, changes = h.error or what } }
    end
    ptext[1] = "Planned at " .. os.date("%H:%M:%S", state.planned) .. ". " .. (p.already and "The Mesh is as roster.yml says: nothing to apply."
      or (words.plural(change, "Host", "Hosts") .. " would change. Apply it with a: you're asked first."))
    for _, w in ipairs(p.warnings or {}) do ptext[#ptext + 1] = w end
    pfacts = {
      { label = "Hosts that change", value = words.count(change) .. " of " .. words.count(#p.hosts) },
      { label = "pending", value = words.count(#words.keys(p.pending)) },
    }
  else
    ptext[1] = "No plan yet. Plan the Mesh (p): roster connects to each Host and shows what an apply would change, without changing anything."
  end
  roster.views.set("mesh-plan", {
    title = "Mesh plan",
    place = "full",
    actions = {
      { label = "Apply", icon = "apply", run = apply },
      { label = "Plan again", icon = "plan", run = plan },
    },
    text = table.concat(ptext, "\n\n"),
    facts = pfacts,
    table = {
      columns = {
        { id = "host", label = "Host", kind = "data" },
        { id = "status", label = "Status", width = 14 },
        { id = "changes", label = "Changes" },
      },
      rows = prows,
      sort = "host",
      empty = "Nothing planned yet.",
      open = function(e) info(e) end,
      actions = {
        { label = "Apply", key = "a", icon = "apply", run = apply },
        { label = "Plan again", key = "p", icon = "plan", run = plan },
        { label = "Links", key = "l", run = function() roster.views.open("mesh-links") end },
      },
    },
  })
end

show = function()
  segment(state.status)
  badges(state.status)
  views()
  details()
end

-- ------------------------------------------------------------------ commands, keys, help

roster.commands.add("mesh", {
  desc = "The Mesh: who reaches whom; :mesh plan, apply, links, cut HOST",
  run = function(a)
    local w = a.words[1]
    if w == nil then
      refresh()
      return roster.views.open("mesh")
    elseif w == "plan" then
      return plan()
    elseif w == "apply" then
      return apply()
    elseif w == "links" then
      return roster.views.open("mesh-links")
    elseif w == "cut" and a.words[2] then
      return cut(a.words[2])
    end
    roster.notify(":mesh " .. a.args .. ": there's :mesh, :mesh plan, :mesh apply, :mesh links and :mesh cut HOST", "warn")
  end,
})

if settings.leader then roster.keymap.set("leader", settings.leader, "mesh") end

roster.help.set("mesh-controls", {
  title = "Mesh controls",
  summary = "The Mesh in the app: reach, plan and apply, Cut",
  markdown = [[
# Mesh controls

The Mesh's controls in the app: who reaches whom, a plan you look at before an apply you confirm, and a Cut you confirm by typing the Host's name. The Mesh itself is `roster mesh` (`:help mesh`); this Plugin runs it through roster serve.

| | |
|---|---|
| `:mesh` | The Mesh view: every Host in it, what it **can reach** (the Hosts it can log in to with its Mesh key: the risk if it's taken over), what reaches it, and its state |
| `:mesh plan` | Plan: roster connects to each Host and shows what an apply would change, changing nothing. The plan view lists each Host's changes |
| `:mesh apply` | Apply the plan, after a question. Without a plan, it plans first |
| `:mesh links` | The Links worth a look: those through a jump Host (`via`) or with a problem, and what each status means |
| `:mesh cut HOST` | Take HOST out of the Mesh now, on every Host at once, after you type its name |
| `:cancel mesh` | Stop a plan or apply before its next Host: the rest is pending, and the next apply finishes it |

In the views: `p` plans, `a` applies, `l` shows the Links, `x` cuts the selected Host, `e` (in the Links) says what a status means. Each Host's details (`:info HOST`) have a Mesh section with its reach.

The status bar says **Mesh out of date** when `roster.yml` changed the Mesh since the last apply on this Box (after a Publish, say): click it to plan. A Host that didn't answer gets a `pending` badge, and one that still holds a cut Host's key `cut pending`.

**no-via**: a Link with `via:` goes through a jump Host, and ssh logs in to the jump Host first, so its source needs a Link to the jump Host too. Without one the Link is left out and `roster check` fails: add the Link it names, or take `via:` off.
]],
})

-- Refresh after an edit, a pull or a Publish (inventory_changed needs inventory.read).
if roster.has("inventory.read") then roster.on("inventory_changed", refresh) end

-- The first look, once loaded: never at load itself, so a busy serve can't hold the app's start.
roster.defer(50, refresh)
show()
