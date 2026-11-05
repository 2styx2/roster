-- topology: the Topology view, a first-party Plugin (plugins/README.md, decisions Q81 and Q94).
-- A full view with a graph: this Box, every Host by Inventory group, the Mesh's reach and Links,
-- live Sessions in the accent, and what's down, out of date or being cut. Selecting a Host lights
-- up what it can reach and what can reach it, with the counts (Q63's visible risk). Built only on
-- the public Plugin API, like anyone's.
--
-- Settings come from init.lua, where you name it as a Package:
--   roster.packages.add({ "https://github.com/2styx2/roster", dir = "plugins/topology", config = { leader = "T" } })
local roster = require("roster")
local build = require("topology.build")

local settings, problems = build.settings(roster.plugin.config)
for _, p in ipairs(problems) do
  roster.notify(p .. "; using the default", "warn")
end

-- What it was granted. Without any of it, it still loads and says what's missing.
local reads = roster.has("inventory.read")
local can_mesh = roster.has("serve:mesh.status")
local can_check = roster.has("serve:host.check")
local can_cut = roster.has("serve:mesh.cut")
local can_job = roster.has("serve:mesh.job")
local can_hear_checks = roster.has("serve:host.check_job")

local VIEW = "topology"
local live = {} -- Host -> { [session] = true }
local down = {} -- Host -> why it's down (its Session failed to connect, or a check failed)
local ended = {} -- Host -> true: its last Session ended
local mesh, mesh_error -- mesh.status's last answer, or why there's none
local s -- build.structure's
local sent -- what the view has: id -> sig, per nodes, edges and clusters (nil before it's set)
local sent_text
local detailed = {} -- Host -> the sig of its reach section in its details
local queued = {} -- Hosts whose reach section is still to send (at most 400 a call)
local flushing = false
local filtered = false -- the view's filter is one :topology GROUP set

-- Asks roster serve without waiting (roster.serve.request): `done(result)` or `done(nil, why)`
-- comes later, as a call of its own, so a busy serve (a Publish, a long Mesh run) never holds up
-- this Plugin or the app.
---@param done fun(result: any, why: string?)
local function ask(method, params, done)
  local sent_ok, err = pcall(roster.serve.request, method, params or {}, function(r, why) done(r, why) end)
  if not sent_ok then done(nil, tostring(err)) end
end

-- serve's words without the call's name in front.
local function clean(why) return (tostring(why):gsub("^.-roster%.serve%.request [%w._]+: ", "")) end

-- The Hosts and groups, asked of roster serve without waiting (roster.inventory.request), so a big
-- Inventory or a busy serve never holds up this Plugin or the app, and asked again only when the
-- app says they changed (inventory_changed): at 2,000 Hosts each read is a large answer.
local inventory_error -- why the Hosts couldn't be read, if they couldn't
local hosts, groups -- nil until read
local reading = false -- a read is out
local changed = 0 -- bumped by inventory_changed: an answer to an older read is read again
local after_read = {} -- what waits for the Hosts

-- Runs `done` once the Hosts and groups are read (at once if they are).
local function with_inventory(done)
  if not reads then hosts, groups = hosts or {}, groups or {} end
  if hosts then return done() end
  after_read[#after_read + 1] = done
  if reading then return end
  reading = true
  local asked = changed
  local function got(list, why)
    reading = false
    if asked ~= changed then -- roster.yml changed while this read was out: read it again
      hosts = nil
      local waiting = after_read
      after_read = {}
      for _, f in ipairs(waiting) do with_inventory(f) end
      return
    end
    if type(list) == "table" then
      hosts, groups, inventory_error = list.hosts or {}, list.groups or {}, nil
    else
      hosts, groups = {}, {}
      inventory_error = (tostring(why or "roster serve said nothing"):gsub("^roster%.inventory%.request: ", ""))
    end
    local waiting = after_read
    after_read = {}
    for _, f in ipairs(waiting) do f() end
  end
  local sent_ok, err = pcall(roster.inventory.request, got)
  if not sent_ok then got(nil, err) end
end

local function restructure()
  s = build.structure(hosts or {}, groups or {}, mesh)
end

-- A reach section's button (api 4): the map, at its Host.
local function show_on_map(e) roster.views.open(VIEW, { select = e.host }) end

-- The reach sections in Hosts' details, a few hundred a call so a big Inventory stays inside the
-- host's limit of UI changes per call.
local function flush()
  flushing = false
  local n = 0
  while #queued > 0 and n < 400 do
    local name = table.remove(queued, 1)
    local d = s.hosts[name] and build.details(s, name) or nil
    if d and roster.api_version >= 4 then
      d.actions = { { label = "Show " .. name .. " on the map", icon = "map", run = show_on_map } }
    end
    roster.details.set("topology", name, d)
    n = n + 1
  end
  if #queued > 0 then
    flushing = true
    roster.defer(50, flush)
  end
end

local function details()
  local now = {}
  for _, name in ipairs(s.order) do
    local d = build.details(s, name)
    if d then now[name] = build.details_sig(d) end
  end
  for name, sig in pairs(now) do
    if detailed[name] ~= sig then queued[#queued + 1] = name end
  end
  for name in pairs(detailed) do
    if not now[name] then queued[#queued + 1] = name end
  end
  detailed = now
  if not flushing then flush() end
end

-- What a node does, below: the graph's actions call them.
local check, cut

-- Draws the view from the state above: the whole graph the first time, then only what changed.
local function draw()
  local g = build.graph(s, live, down, ended)
  local text = build.text(s, { reads = reads, mesh = can_mesh, error = mesh_error, inventory_error = inventory_error })
  if not sent then
    local actions = {
      { label = "Details", key = "i", icon = "info", run = function(e) if e.host then roster.cmd("info " .. e.host) end end },
    }
    if can_check then actions[#actions + 1] = { label = "Check", key = "c", icon = "review", run = function(e) check(e) end } end
    if can_cut and can_job then actions[#actions + 1] = { label = "Cut", key = "x", icon = "close", run = function(e) cut(e) end } end
    roster.views.set(VIEW, {
      title = "Topology",
      place = "full",
      text = text,
      graph = {
        clusters = g.clusters,
        nodes = g.nodes,
        edges = g.edges,
        -- Every hop: a Mesh key on a Host reaches what that Host's own keys reach (decision Q102).
        reach = "all",
        actions = actions,
      },
    })
    sent = {
      nodes = select(3, build.diff(nil, g.nodes)),
      edges = select(3, build.diff(nil, g.edges)),
      clusters = select(3, build.diff(nil, g.clusters)),
    }
    sent_text = text
  else
    local nodes, nodes_gone
    local edges, edges_gone
    local clusters, clusters_gone
    clusters, clusters_gone, sent.clusters = build.diff(sent.clusters, g.clusters)
    nodes, nodes_gone, sent.nodes = build.diff(sent.nodes, g.nodes)
    edges, edges_gone, sent.edges = build.diff(sent.edges, g.edges)
    local changes = {}
    if #clusters > 0 then changes.clusters = clusters end
    if #nodes > 0 then changes.nodes = nodes end
    if #edges > 0 then changes.edges = edges end
    local remove = {}
    for _, id in ipairs(nodes_gone) do remove[#remove + 1] = id end
    for _, id in ipairs(clusters_gone) do remove[#remove + 1] = id end
    table.sort(remove)
    table.sort(edges_gone)
    if #remove > 0 then changes.remove = remove end
    if #edges_gone > 0 then changes.remove_edges = edges_gone end
    if text ~= sent_text then
      changes.text = text
      sent_text = text
    end
    if next(changes) then roster.views.update(VIEW, changes) end
  end
  details()
end

-- Draws what it has now, then asks for the Mesh and draws again when serve answers. One question
-- at a time: a refresh while one waits asks again once it's answered.
local asking, again = false, false
local function refresh()
  if asking then
    again = true
    return
  end
  asking = true
  -- The Hosts first (when they changed), then the Mesh: one draw with both.
  with_inventory(function()
    if not can_mesh then
      asking = false
      mesh, mesh_error = nil, nil
      restructure()
      draw()
      if again then
        again = false
        refresh()
      end
      return
    end
    ask("mesh.status", { grouped = true }, function(r, why)
      asking = false
      if type(r) == "table" then
        mesh, mesh_error = r, nil
      else
        mesh, mesh_error = nil, clean(why or "roster serve said nothing about the Mesh")
      end
      restructure()
      draw()
      if again then
        again = false
        refresh()
      end
    end)
  end)
end

-- ------------------------------------------------------------------- what a node does

function check(e)
  if not e.host then return roster.notify("That's this Box: pick a Host to check.", "info", { quiet = false }) end
  -- The app's own :check HOST: its diagnostics panel shows each step. (It takes seconds; a
  -- Plugin's call may take two at most, so the app runs it, not this Plugin.)
  roster.cmd("check " .. e.host)
end

-- A cut runs as a job of roster serve's (serve API 17), so it doesn't hold this Plugin's call while
-- every Host answers. serve pushes how it's going (`job_progress`, API 20) and the Plugin asks
-- `mesh.job` once it's over; until the first push (an older serve sends none), a timer asks once a
-- second, and stops when it's over.
local cutting -- { job, host, timer, polling, again }
local pushed = false -- serve pushes job_progress: no timer needed

local function cut_done(host, r)
  local waiting = 0
  for _ in pairs(r.pending or {}) do waiting = waiting + 1 end
  if waiting > 0 then
    roster.notify("Cut " .. host .. ": cut pending on " .. build.plural(waiting, "Host") .. " that didn't answer.", "warn")
  else
    roster.notify("Cut " .. host .. " from " .. build.plural(#(r.confirmed or {}), "Host") .. ".", "info", { quiet = false })
  end
  -- The `roster sync` serve runs after writing mesh: false (T150): a failure doesn't undo the cut (T153).
  local sync = (r.change or {}).sync
  if sync and not sync.ok then
    roster.notify("mesh: false for " .. host .. " was written, but this Box's ssh config didn't follow ("
      .. (sync.error or "roster sync failed") .. "): run roster sync", "warn")
  end
end

local function cut_over()
  if cutting and cutting.timer then roster.cancel(cutting.timer) end
  cutting = nil
  if roster.progress.has("topology-cut") then roster.progress.remove("topology-cut") end
  refresh()
end

local function cut_poll()
  if not cutting then return end
  if cutting.polling then
    cutting.again = true -- it ended while a question was out: ask again once that's back
    return
  end
  cutting.polling, cutting.again = true, false
  ask("mesh.job", { job = cutting.job }, function(j)
    if not cutting then return end
    cutting.polling = false
    if type(j) ~= "table" then
      roster.notify("Cut " .. cutting.host .. ": roster serve lost track of it; :topology shows where the Mesh is now.", "warn")
      return cut_over()
    end
    if j.state == "running" then
      roster.progress.set("topology-cut", { title = "Cutting " .. cutting.host .. " from the Mesh", done = j.done or 0, total = j.total or 0 })
      if cutting.again then cut_poll() end
      return
    end
    if j.state == "done" then
      cut_done(cutting.host, j.result or {})
    else
      roster.notify("Cut " .. cutting.host .. ": " .. tostring(j.error and j.error.message or "it failed"), "error")
    end
    cut_over()
  end)
end

function cut(e)
  if not e.host then return roster.notify("That's this Box: it's never in the Mesh, so there's nothing to cut.", "info", { quiet = false }) end
  local h = e.host
  local m = mesh or {}
  if not (s.involved[h] or (m.cut_pending or {})[h]) then
    return roster.notify(h .. " isn't in the Mesh: there's nothing to cut.", "info", { quiet = false })
  end
  roster.confirm({
    title = "Cut " .. h .. " from the Mesh?",
    text = "Its key comes off every Host it reaches, and every peer's key comes off it, at once. This Box keeps its own access, so you can look into it.\n\nroster writes `mesh: false` for "
      .. h
      .. " as a Pending change, so the cut lasts after the next Publish.",
    facts = {
      { label = "Reaches now", value = build.plural(s.out[h] or 0, "Host") .. " directly" },
      { label = "Reached by", value = build.plural(s["in"][h] or 0, "Host") .. " directly" },
    },
    action = "Cut",
    danger = true,
    typed = h,
    run = function()
      if cutting then return roster.notify("A cut of " .. cutting.host .. " is still going: wait for it to finish.", "warn") end
      cutting = { host = h }
      ask("mesh.cut", { host = h, background = true }, function(r, why)
        if type(r) == "table" and r.job then
          cutting.job = r.job
          roster.progress.set("topology-cut", { title = "Cutting " .. h .. " from the Mesh", done = 0, total = r.total or 0 })
          -- It may be over already (its end pushed before this answer): ask once; until serve
          -- has pushed anything, a timer asks.
          if pushed then cut_poll() else cutting.timer = roster.every(1000, cut_poll) end
          return
        end
        cutting = nil
        if type(r) == "table" then
          -- A roster serve before jobs (API 17) answers when it's over.
          cut_done(h, r)
        else
          roster.notify("Cut " .. h .. ": " .. clean(why), "error")
        end
        refresh()
      end)
    end,
  })
end

-- ------------------------------------------------------------------- commands, keys, help

roster.commands.add("topology", {
  desc = "The Topology view: this Box, your Hosts by group and the Mesh; :topology GROUP shows one group",
  run = function(a)
    -- Before the first look has drawn the view: draw what there is (the Mesh follows).
    if not sent then
      restructure()
      draw()
    end
    local word = a.words[1]
    if word then
      local ids = build.group_clusters(s, word)
      if #ids == 0 then return roster.notify("There's no group " .. word .. " on the map.", "warn") end
      roster.views.update(VIEW, { filter = { clusters = ids } })
      filtered = true
    elseif filtered then
      roster.views.update(VIEW, { filter = {} })
      filtered = false
    end
    roster.views.open(VIEW)
  end,
})
if settings.leader then roster.keymap.set("leader", settings.leader, "topology") end

roster.help.set("topology", {
  title = "Topology",
  summary = "The map: this Box, your Hosts by group, the Mesh, and who can reach whom",
  markdown = table.concat({
    "# Topology",
    "",
    "A map of this Box and every Host, grouped as the Inventory groups them, with the Mesh's reach and Links. `:topology` opens it (`:topology GROUP` shows one group)"
      .. (settings.leader and (", and so does `␣ " .. settings.leader .. "`") or "")
      .. "; Esc goes back.",
    "",
    "- **Nodes:** this Box is the square; a filled node takes a key, a ring a password, a dashed ring isn't reviewed, a hollow one's Session ended. A live Session is in the accent, with its edge from this Box; a Host that's down (its Session couldn't connect, or a check of it failed) is crossed out.",
    "- **Edges:** grey from this Box to each group; solid for a Mesh key, dashed for a password peer, an arrow one way. A cluster drawn as a mesh reaches itself both ways. A broken, dotted edge is a cut not finished.",
    "- **Marks:** warn for a Host that didn't answer the last apply or has no Link to its hop, error for a cut not finished. The text above the map says when the Mesh is out of date.",
    "- **A group the Mesh touches** shows as up to three clusters: its Hosts that reach each other, its password peers (reached, never reaching), and the ones not in the Mesh.",
    "",
    "Select a Host to light up what it can reach and what can reach it, every hop: what its key reaches, and what those Hosts' own keys reach, which is what someone on it could reach. Its details (`i`) say how many directly.",
    "",
    "Keys: `h` `j` `k` `l` move, `/` searches (it opens empty each time), `f` filters by group, kind or state (hiding the rest), `o` collapses a group, `+` `-` `0` zoom, `t` lists every node and edge. On a Host: Enter opens a Session, `i` its details, `c` Check, `x` Cut from the Mesh (after you type its name).",
    "",
    "`:tutor topology` teaches the map by using it, on the tutorial's demo Inventory.",
    "",
    "It needs **inventory.read** for the Hosts, **serve:mesh.status** for the Mesh, **serve:host.check** for Check, **serve:host.check_job** to show a Host down when a check of it fails, and **serve:mesh.cut** with **serve:mesh.job** for Cut. Without one it says so above the map.",
  }, "\n"),
})

-- `:tutor topology` (#233): the map, learned by using it on the tutorial's demo Inventory. Its
-- steps name the demo's Hosts and groups (demo-01 to demo-06, demo-lab and demo-office), and its
-- made-up Mesh (the demo's mesh.status, #233): demo-01 to demo-03 meshed, demo-01 reaching demo-05,
-- which didn't answer the last apply.
roster.tutor.set("topology", {
  title = "Topology tutor",
  summary = "Learn the Topology view: open the map, show one group, go from a node to its Host, read its reach",
  intro = table.concat({
    "The Topology view draws this Box and every Host as a map, grouped as the Inventory groups them. This tutorial runs on the demo's six Hosts, in two groups.",
    "",
    "The map also draws the Mesh: who can reach whom, and how. The demo has a small, made-up one, so you can read it there; nothing on it connects anywhere.",
  }, "\n"),
  lessons = {
    {
      title = "Open the map",
      text = "`:topology` opens the map"
        .. (settings.leader and (", and so does `␣ " .. settings.leader .. "`") or "")
        .. ". This Box is the square; each group is a cluster of its Hosts, with a grey edge from this Box to it. Esc goes back.",
      steps = {
        { id = "open", text = "Open the map with `:topology`.", on = { event = "command", id = "topology", arg = "" } },
        {
          id = "group",
          text = "Show only the lab with `:topology demo-lab`. `:topology` alone shows every group again.",
          on = { event = "command", id = "topology", arg = "demo-lab" },
        },
      },
    },
    {
      title = "From a node to its Host",
      text = "`h` `j` `k` `l` move between nodes, and `/` finds one by name. On a Host, `i` opens its details and Enter opens a Session to it. A live Session's node is in the accent, with its edge from this Box.",
      steps = {
        { id = "details", text = "On the map (`:topology`), find `demo-03` with `/`, then press `i` for its details.", on = { event = "command", id = "info", arg = "demo-03" } },
        { id = "session", text = "Open the map again, find `demo-03` and press Enter: a Session to it opens.", on = { event = "session_open", host = "demo-03" } },
      },
    },
    {
      title = "Who reaches whom",
      text = "In the demo's Mesh, the lab's `demo-01`, `demo-02` and `demo-03` reach each other both ways, drawn as one cluster, and `demo-01` also reaches `demo-05` in the office. Select a Host to light up what it can reach and what can reach it, every hop; its details (`i`) count what it reaches directly.",
      steps = {
        {
          id = "reach",
          text = "On the map (`:topology`), find `demo-01`: the lab and `demo-05` light up. Press `i`: its Reach says 3 Hosts directly.",
          on = { event = "command", id = "info", arg = "demo-01" },
        },
        {
          id = "pending",
          text = "Find `demo-05`, marked Mesh pending: it didn't answer the last apply, so its key may not be there yet. Press `i`: its Reach says why.",
          on = { event = "command", id = "info", arg = "demo-05" },
        },
      },
    },
  },
  outro = table.concat({
    "You've opened the map, shown one group, gone from a node to its Host's details and a Session, and read who reaches whom. `demo-03` is in the accent on the map now, live.",
    "",
    "- `f` filters the map by group, kind or state, and `t` lists every node and edge.",
    "- On your own Inventory, the map draws your Mesh the same way, and a pending Host is finished by the next `roster mesh`.",
    "- `:help topology` has every key and mark; `:tutor quit` goes back to your own Inventory.",
  }, "\n"),
})

roster.health.set("topology", {
  title = "Topology",
  check = function()
    local out = {}
    if not reads then
      out[#out + 1] = { level = "warn", message = "inventory.read isn't granted, so the map has no Hosts", fix = "allow it in :plugins" }
    end
    if not can_mesh then
      out[#out + 1] = { level = "warn", message = "serve:mesh.status isn't granted, so the map has no Mesh", fix = "allow it in :plugins" }
      return out
    end
    -- What it last heard from roster serve (a :check doesn't wait for serve).
    if mesh_error then
      out[#out + 1] = {
        level = "warn",
        message = "Mesh status isn't available: " .. mesh_error,
        fix = "update roster on this Box (the Mesh came with serve API 15)",
      }
    elseif not mesh then
      out[#out + 1] = { level = "warn", message = "Mesh status hasn't come yet", fix = "run :check again in a moment" }
    else
      out[#out + 1] = {
        level = "ok",
        message = "Mesh status available: " .. build.plural(#(mesh.members or {}), "Host") .. " roster visits",
      }
      if mesh.out_of_date then
        out[#out + 1] = { level = "warn", message = "The Mesh is out of date", fix = "apply it: roster mesh" }
      end
    end
    return out
  end,
})

-- ------------------------------------------------------------------- events and the clock

if reads then
  -- The Sessions open before it loaded (api 4): it hears of the rest as they open and end.
  for _, open in ipairs(roster.sessions.list and roster.sessions.list() or {}) do
    if open.host then
      live[open.host] = live[open.host] or {}
      live[open.host][open.session] = true
    end
  end
  roster.on("session_open", function(e)
    if not e.host then return end -- a Quick Connect Session isn't on a Host
    live[e.host] = live[e.host] or {}
    live[e.host][e.session] = true
    down[e.host], ended[e.host] = nil, nil
    draw()
  end)
  roster.on("session_exit", function(e)
    if not e.host then return end
    if live[e.host] then live[e.host][e.session] = nil end
    if not live[e.host] or next(live[e.host]) == nil then
      live[e.host] = nil
      ended[e.host] = true
      -- ssh's 255: it never got in (the network, the host key, the login).
      if e.code == 255 then down[e.host] = "ssh failed" end
    end
    draw()
  end)
  roster.on("inventory_changed", function()
    hosts, changed = nil, changed + 1
    refresh()
  end)
end
-- How a check came out (serve API 21: a check is a job), asked once it's done, the app's :check
-- and Check from the map alike: a failed one shows its Host down, a passed one clears that.
-- Answers can come back in any order, so only the answer for a Host's latest finished check counts
-- (by when serve said each ended, not by its id, which starts again with a new roster serve).
local latest = {} -- Host -> the token of its latest finished check
local tokens = 0
local function check_done(e)
  if not e.host then return end
  tokens = tokens + 1
  local token = tokens
  latest[e.host] = token
  ask("host.check_job", { job = e.job }, function(j)
    if latest[e.host] ~= token then return end -- a later check of it ended meanwhile
    local r = type(j) == "table" and j.result
    if type(r) ~= "table" or j.state ~= "done" then return end -- lost: no verdict
    local host = e.host
    if r.ok then
      down[host] = nil
    else
      local failed
      for _, step in ipairs(r.steps or {}) do
        if step.status == "fail" then
          failed = step.step
          break
        end
      end
      down[host] = failed and ("check failed at " .. failed) or "check failed"
    end
    draw()
  end)
end

-- serve's job_progress (API 20): a cut's progress as it moves, and mesh.job asked once it's over
-- (the first one means serve pushes, so the timer goes); a check's result once it's over.
if can_job or can_hear_checks then
  roster.on("job_progress", function(e)
    if e.kind == "check" then
      -- Only a check that ran to its end says something about the Host: one stopped (the vault
      -- locked) or failed (serve's own error) isn't asked about.
      if e.state == "done" then check_done(e) end
      return
    end
    if e.kind ~= "mesh" then return end
    pushed = true
    if cutting and cutting.timer then
      roster.cancel(cutting.timer)
      cutting.timer = nil
    end
    if not cutting or cutting.job ~= e.job then return end
    if e.state == "running" or e.state == "stopping" then
      return roster.progress.set("topology-cut", { title = "Cutting " .. cutting.host .. " from the Mesh", done = e.done or 0, total = e.total or 0 })
    end
    cut_poll()
  end)
end

-- The Mesh changes when someone applies or cuts it, here or on another Box: look again now and then.
-- mesh.status never connects anywhere, so it's cheap.
if can_mesh then roster.every(settings.refresh * 1000, refresh) end

-- The first look is deferred: nothing calls roster serve while the Plugin loads, so a busy serve
-- can't hold up the app's start.
roster.defer(50, refresh)
