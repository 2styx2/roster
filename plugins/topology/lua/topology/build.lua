-- The pure part of Topology: from the Hosts, their groups and roster serve's `mesh.status`, the
-- graph the view draws (clusters, nodes, edges), the view's text and each Host's reach section.
-- No `roster` calls here, so it's the same on every machine and cheap to test.
--
-- How the Mesh becomes a graph without an edge per pair (a meshed group of 50 is 2,450 Links):
--   * A group the Mesh touches is split by what each Host is in it: the Hosts that take a key and
--     reach their peers (the group's own cluster), its password peers ("· password peers": reached,
--     never reaching), and the rest ("· not in the Mesh": unreviewed, `mesh: false`, or not named).
--     So a cluster's `mesh = true`, and an edge to or from a cluster, say exactly who reaches whom.
--   * Links are grouped by the clusters at their ends: every pair between two clusters is one edge,
--     a Host to a whole cluster (or a whole cluster to a Host) is one edge, the rest one each. Both
--     ways with the same look is one two-way edge.
local M = {}

M.BOX = ":box"
M.MAX_HOSTS = 4999 -- a graph holds 5,000 nodes, and this Box is one
M.MAX_EDGES = 9000 -- of a graph's 10,000: the rest is room for live Sessions' edges

---@param name string
---@param part string?
local function gid(name, part) return ":group:" .. name .. (part and ("/" .. part) or "") end

-- A count as the app writes one: 2,000.
local function count(n)
  local s, k = tostring(n), 1
  while k > 0 do
    s, k = s:gsub("^(%d+)(%d%d%d)", "%1,%2")
  end
  return s
end

local function plural(n, one, many) return count(n) .. " " .. (n == 1 and one or (many or one .. "s")) end
M.plural = plural

-- ------------------------------------------------------------------- settings

---@param config table?
---@return { leader: string|false, refresh: integer }, string[]
function M.settings(config)
  local out = { leader = "T", refresh = 60 }
  local problems = {}
  config = type(config) == "table" and config or {}
  if config.leader ~= nil then
    if config.leader == false or (type(config.leader) == "string" and config.leader:match("%S")) then
      out.leader = config.leader
    else
      problems[#problems + 1] = "topology: leader must be the keys after the Leader, such as \"T\", or false for none"
    end
  end
  if config.refresh ~= nil then
    local r = config.refresh
    if math.type(r) == "integer" and r >= 10 and r <= 3600 then
      out.refresh = r
    else
      problems[#problems + 1] = "topology: refresh must be a whole number of seconds from 10 to 3600"
    end
  end
  return out, problems
end

-- ------------------------------------------------------------------- the Hosts

-- A password Host, as the app draws it (Q53's ring): no key of this Box's on it, and a Login that
-- isn't a key.
---@param h table
function M.password(h)
  local auth = h.ssh and h.ssh.auth or h.auth
  return not h.enroll and auth ~= "agent" and auth ~= "key" and auth ~= "none"
end

-- ------------------------------------------------------------------- the structure

-- Everything that changes only with the Inventory or the Mesh: clusters, which Host is in which,
-- the Mesh's edges and each Host's direct reach. Sessions don't touch it.
---@param hosts table[] roster.inventory.hosts(), in roster.yml's order
---@param groups table<string, table> roster.inventory.groups()
---@param mesh table? mesh.status's result, nil when it isn't there
function M.structure(hosts, groups, mesh)
  local s = {
    hosts = {}, -- name -> Host
    order = {}, -- names, in roster.yml's order
    clusters = {}, -- { id, title, mesh?, members = {names} }
    cluster_of = {}, -- name -> cluster id
    edges = {}, -- the Mesh's edges, as the graph takes them
    involved = {}, -- name -> true: in a working Link, either end
    out = {}, -- name -> how many Hosts it reaches directly
    ["in"] = {}, -- name -> how many reach it directly
    skipped = {}, -- name -> Links from it roster doesn't write (a password source)
    nohop = {}, -- name -> the hop it has no Link to
    mesh = mesh,
    trimmed = 0, -- Hosts left out over MAX_HOSTS
    cut = 0, -- edges left out over MAX_EDGES
    links = 0,
    groups = 0,
  }
  for _, h in ipairs(hosts) do
    if #s.order >= M.MAX_HOSTS then
      s.trimmed = s.trimmed + 1
    elseif type(h.name) == "string" then
      s.order[#s.order + 1] = h.name
      s.hosts[h.name] = h
    end
  end

  -- Meshed groups, when roster serve gives them grouped (`mesh.status { grouped = true }`, serve
  -- API 19): every Host in one that takes a key reaches every other in it; a password Host reaches
  -- no one (roster doesn't write on it).
  local meshed = {} -- { group, keys = {names}, peers = {names} }
  local mesh_of = {} -- name -> its meshed group's entry
  if mesh and type(mesh.meshed) == "table" then
    for g, names in pairs(mesh.meshed) do
      local m = { group = g, keys = {}, peers = {} }
      for _, n in ipairs(names) do
        local h = s.hosts[n]
        if h then table.insert(h.enroll and m.keys or m.peers, n) end
      end
      local all = #m.keys + #m.peers
      if all > 1 then
        for _, n in ipairs(m.keys) do mesh_of[n] = m end
        for _, n in ipairs(m.peers) do mesh_of[n] = m end
        meshed[#meshed + 1] = m
        for _, n in ipairs(m.keys) do
          s.involved[n] = true
          s.out[n] = (s.out[n] or 0) + all - 1
          s["in"][n] = (s["in"][n] or 0) + #m.keys - 1
        end
        for _, n in ipairs(m.peers) do
          s.involved[n] = true
          s.skipped[n] = (s.skipped[n] or 0) + all - 1
          s["in"][n] = (s["in"][n] or 0) + #m.keys
        end
        s.links = s.links + #m.keys * (all - 1)
      end
    end
  end

  -- The other Links that work, by pair.
  local pair = {}
  local working = {}
  if mesh then
    for _, l in ipairs(mesh.links or {}) do
      if s.hosts[l.from] and s.hosts[l.to] then
        if l.skip then
          s.skipped[l.from] = (s.skipped[l.from] or 0) + 1
        else
          working[#working + 1] = l
          pair[l.from .. ">" .. l.to] = l
          s.involved[l.from], s.involved[l.to] = true, true
          s.out[l.from] = (s.out[l.from] or 0) + 1
          s["in"][l.to] = (s["in"][l.to] or 0) + 1
        end
      end
    end
  end
  s.links = s.links + #working

  -- Groups, in the order their first Host comes; each a cluster, or three when the Mesh touches it.
  local seen, list = {}, {}
  local members = {}
  for _, name in ipairs(s.order) do
    local g = s.hosts[name].group or ""
    if not seen[g] then
      seen[g] = true
      list[#list + 1] = g
      members[g] = {}
    end
    table.insert(members[g], name)
  end
  s.groups = #list
  local by_id = {}
  local function add(id, title, names)
    if #names == 0 then return end
    local c = { id = id, title = title, members = names }
    s.clusters[#s.clusters + 1] = c
    by_id[id] = c
    for _, n in ipairs(names) do s.cluster_of[n] = id end
  end
  for _, g in ipairs(list) do
    local info = groups[g]
    local title = (type(info) == "table" and type(info.title) == "string" and info.title ~= "") and info.title or g
    local touched = false
    for _, n in ipairs(members[g]) do
      if s.involved[n] then touched = true break end
    end
    if not touched then
      add(gid(g), title, members[g])
    else
      local main, peers, rest = {}, {}, {}
      for _, n in ipairs(members[g]) do
        if not s.involved[n] then
          rest[#rest + 1] = n
        elseif s.hosts[n].enroll then
          main[#main + 1] = n
        else
          peers[#peers + 1] = n
        end
      end
      add(gid(g), title, main)
      add(gid(g, "peers"), title .. " · password peers", peers)
      add(gid(g, "out"), title .. " · not in the Mesh", rest)
    end
  end

  -- A meshed group whose clusters are exactly its key Hosts and its password peers is its cluster's
  -- mesh and one edge to its peers; one that isn't (a Host meshed on its own in a group that isn't)
  -- is its pairs, one by one, as below.
  local raw = {} -- { from, to, style, tone?, label? }, before two-way ones are joined
  local function emit(from, to, b)
    local e = { from = from, to = to, style = b.kind == "password" and "dashed" or "solid" }
    raw[#raw + 1] = e
    return e
  end
  local function exactly(c, names)
    if not c then return #names == 0 end
    if #c.members ~= #names then return false end
    local set = {}
    for _, n in ipairs(names) do set[n] = true end
    for _, n in ipairs(c.members) do
      if not set[n] then return false end
    end
    return true
  end
  table.sort(meshed, function(a, b) return a.group < b.group end)
  for _, m in ipairs(meshed) do
    local main, peers = by_id[gid(m.group)], by_id[gid(m.group, "peers")]
    if exactly(main, m.keys) and exactly(peers, m.peers) then
      if #m.keys > 1 then main.mesh = true end
      if #m.keys > 0 and #m.peers > 0 then emit(main.id, peers.id, { kind = "password" }) end
    else
      local all = {}
      for _, n in ipairs(m.keys) do all[#all + 1] = n end
      for _, n in ipairs(m.peers) do all[#all + 1] = n end
      for _, a in ipairs(m.keys) do
        for _, b in ipairs(all) do
          if a ~= b then
            local l = { from = a, to = b, kind = s.hosts[b].enroll and "key" or "password" }
            working[#working + 1] = l
            pair[a .. ">" .. b] = l
          end
        end
      end
    end
  end

  -- The Links, grouped by the clusters at their ends.
  local buckets, bucket_at = {}, {}
  for _, l in ipairs(working) do
    local cf, ct = s.cluster_of[l.from], s.cluster_of[l.to]
    local key = table.concat({ cf, ct, l.kind or "key", l.via or "" }, "\0")
    local b = bucket_at[key]
    if not b then
      b = { from = cf, to = ct, kind = l.kind or "key", via = l.via, pairs = {} }
      bucket_at[key] = b
      buckets[#buckets + 1] = b
    end
    b.pairs[#b.pairs + 1] = l
  end
  for _, b in ipairs(buckets) do
    local F, T = by_id[b.from].members, by_id[b.to].members
    local same = b.from == b.to
    local need = same and #F * (#F - 1) or #F * #T
    if not b.via and #b.pairs == need then
      if same then
        by_id[b.from].mesh = true
      else
        emit(b.from, b.to, b)
      end
    elseif b.via then
      -- Through a jump Host: one edge each, saying which, and whether the source reaches the hop.
      for _, l in ipairs(b.pairs) do
        local e = emit(l.from, l.to, b)
        local hop = pair[l.from .. ">" .. l.via]
          or (mesh_of[l.from] ~= nil and mesh_of[l.from] == mesh_of[l.via] and s.hosts[l.from].enroll)
        if hop then
          e.label = "via " .. l.via
        else
          e.label = "via " .. l.via .. ", but " .. l.from .. " has no Link to it"
          e.tone = "error"
          s.nohop[l.from] = l.via
        end
      end
    else
      -- A Host to a whole cluster; then a whole cluster to a Host; the rest one by one.
      local per_from, per_to = {}, {}
      for _, l in ipairs(b.pairs) do per_from[l.from] = (per_from[l.from] or 0) + 1 end
      local left = {}
      for _, l in ipairs(b.pairs) do
        local want = #T - (same and 1 or 0)
        if want > 1 and per_from[l.from] == want then
          emit(l.from, b.to, b)
          per_from[l.from] = 0
        elseif per_from[l.from] ~= 0 then
          left[#left + 1] = l
        end
      end
      for _, l in ipairs(left) do per_to[l.to] = (per_to[l.to] or 0) + 1 end
      for _, l in ipairs(left) do
        local want = #F - (same and 1 or 0)
        if want > 1 and per_to[l.to] == want then
          emit(b.from, l.to, b)
          per_to[l.to] = 0
        elseif per_to[l.to] ~= 0 then
          emit(l.from, l.to, b)
        end
      end
    end
  end

  -- Both ways with the same look: one two-way edge.
  local at = {}
  local function key(e, from, to) return table.concat({ from, to, e.style, e.tone or "", e.label or "" }, "\0") end
  for i, e in ipairs(raw) do at[key(e, e.from, e.to)] = i end
  for i, e in ipairs(raw) do
    if not e.gone then
      local j = at[key(e, e.to, e.from)]
      local back = j and raw[j]
      if back and j ~= i and not back.gone then
        back.gone = true
        e.dir = "both"
      end
      if #s.edges >= M.MAX_EDGES then
        s.cut = s.cut + 1
      else
        s.edges[#s.edges + 1] = {
          id = "mesh:" .. e.from .. ">" .. e.to,
          from = e.from,
          to = e.to,
          dir = e.dir,
          style = e.style,
          tone = e.tone,
          label = e.label,
        }
      end
    end
  end

  -- Cuts not finished: the key may still be there, so it's still reach, drawn broken.
  if mesh then
    for host, peers in pairs(mesh.cut_pending or {}) do
      if s.hosts[host] then
        for _, p in ipairs(peers) do
          if s.hosts[p] and #s.edges < M.MAX_EDGES then
            s.edges[#s.edges + 1] = {
              id = "cut:" .. host .. ">" .. p,
              from = host,
              to = p,
              dir = "both",
              style = "dotted",
              tone = "error",
              cut = true,
              label = "cut pending",
            }
          end
        end
      end
    end
  end
  return s
end

-- ------------------------------------------------------------------- the graph

-- The nodes, clusters and edges as the view takes them, with what Sessions and Checks found.
---@param s table M.structure's
---@param live table<string, table> Host -> its live Sessions
---@param down table<string, string> Host -> why it's down
---@param ended table<string, boolean> Hosts whose Session ended
function M.graph(s, live, down, ended)
  local mesh = s.mesh or {}
  local cut_pending = mesh.cut_pending or {}
  local pending = mesh.pending or {}
  local nodes = { { id = M.BOX, label = "This Box", shape = "square", kind = "box" } }
  local edges = {}
  local clusters = {}
  for _, c in ipairs(s.clusters) do
    clusters[#clusters + 1] = { id = c.id, title = c.title, mesh = c.mesh }
    edges[#edges + 1] = { id = "box>" .. c.id, from = M.BOX, to = c.id, tone = "muted" }
  end
  for _, e in ipairs(s.edges) do edges[#edges + 1] = e end
  for _, name in ipairs(s.order) do
    local h = s.hosts[name]
    local is_live = live[name] ~= nil and next(live[name]) ~= nil
    local shape = "dot"
    if h.reviewed == false then
      shape = "dashed"
    elseif ended[name] and not is_live then
      shape = "hollow"
    elseif M.password(h) then
      shape = "ring"
    end
    local mark, note
    if cut_pending[name] then
      mark, note = "error", "cut pending on " .. plural(#cut_pending[name], "Host")
    elseif down[name] and not is_live then
      note = down[name]
    elseif pending[name] then
      mark, note = "warn", "Mesh pending"
    elseif s.nohop[name] then
      mark, note = "warn", "no Link to its hop " .. s.nohop[name]
    end
    nodes[#nodes + 1] = {
      id = name,
      label = name,
      host = name,
      cluster = s.cluster_of[name],
      kind = (type(h.type) == "string" and h.type ~= "") and h.type or nil,
      detail = h.ip,
      shape = shape,
      state = is_live and "live" or (down[name] and "down" or nil),
      mark = mark,
      note = note,
    }
    if is_live then edges[#edges + 1] = { id = "live:" .. name, from = M.BOX, to = name, tone = "live" } end
  end
  return { nodes = nodes, edges = edges, clusters = clusters }
end

-- ------------------------------------------------------------------- words

-- The view's text: what's on the map, and anything that needs doing.
---@param s table
---@param why { reads: boolean, mesh: boolean, error: string?, inventory_error: string? }
function M.text(s, why)
  local lines = {}
  if not why.reads then
    lines[#lines + 1] = "Allow inventory.read in :plugins to see your Hosts: only this Box is on the map."
  elseif why.inventory_error then
    lines[#lines + 1] = "Your Hosts couldn't be read: " .. why.inventory_error
  else
    local line = plural(#s.order, "Host") .. " in " .. plural(s.groups, "group") .. "."
    if s.trimmed > 0 then line = line .. " " .. plural(s.trimmed, "more Host") .. " left out: a map holds 5,000." end
    lines[#lines + 1] = line
  end
  if not why.mesh then
    lines[#lines + 1] = "Allow serve:mesh.status in :plugins to see the Mesh."
  elseif why.error then
    lines[#lines + 1] = "The Mesh isn't shown: " .. why.error
  elseif s.mesh then
    local m = s.mesh
    local members = 0
    for _ in pairs(s.involved) do members = members + 1 end
    local line = "The Mesh: " .. plural(members, "Host") .. ", " .. plural(s.links, "Link") .. "."
    if s.cut > 0 then line = line .. " " .. plural(s.cut, "edge") .. " left out: a map holds 10,000." end
    lines[#lines + 1] = line
    if m.out_of_date then
      lines[#lines + 1] = "The Mesh is out of date: roster.yml changed it since the last apply on this Box (roster mesh)."
    end
    local cuts = 0
    for _ in pairs(m.cut_pending or {}) do cuts = cuts + 1 end
    if cuts > 0 then lines[#lines + 1] = "Cut pending on " .. plural(cuts, "Host") .. ": a peer didn't answer, so its key may still be there." end
    local waiting = 0
    for _ in pairs(m.pending or {}) do waiting = waiting + 1 end
    if waiting > 0 then lines[#lines + 1] = plural(waiting, "Host") .. " didn't answer the last apply (Mesh pending)." end
  end
  return table.concat(lines, "\n\n")
end

-- A Host's reach section in its details (`:info HOST`), or nil when the Mesh doesn't touch it.
---@param s table
---@param name string
function M.details(s, name)
  local m = s.mesh
  if not m then return nil end
  local excluded = (m.excluded or {})[name]
  local cut = (m.cut_pending or {})[name]
  local pend = (m.pending or {})[name]
  if not (s.involved[name] or excluded or cut or pend or s.skipped[name]) then return nil end
  local facts = {}
  local h = s.hosts[name]
  if excluded then
    facts[#facts + 1] = { label = "In the Mesh", value = "no: " .. excluded }
  elseif s.involved[name] then
    facts[#facts + 1] = {
      label = "In the Mesh",
      value = (h and not h.enroll) and "yes, as a password peer: it's reached, and reaches no one" or "yes",
    }
  end
  facts[#facts + 1] = { label = "Reaches", value = plural(s.out[name] or 0, "Host") .. " directly" }
  facts[#facts + 1] = { label = "Reached by", value = plural(s["in"][name] or 0, "Host") .. " directly" }
  if s.skipped[name] then
    facts[#facts + 1] = {
      label = "Not written",
      value = plural(s.skipped[name], "Link") .. " from it: roster doesn't write on a password Host",
    }
  end
  if s.nohop[name] then facts[#facts + 1] = { label = "Hop", value = "no Link to " .. s.nohop[name] } end
  if pend then facts[#facts + 1] = { label = "Pending", value = pend } end
  if cut then facts[#facts + 1] = { label = "Cut pending on", value = table.concat(cut, ", "), data = true } end
  return {
    title = "Reach",
    text = "Directly is its own Mesh keys. Selected in :topology, it counts every hop: what those Hosts' own keys reach too.",
    facts = facts,
  }
end

-- ------------------------------------------------------------------- changes

-- A node's, edge's or cluster's fields in a fixed order, so two equal ones say the same. Only the
-- fields this Plugin sets: a sort per table would cost too much at 5,000 nodes.
local FIELDS = { "id", "label", "title", "host", "cluster", "kind", "detail", "shape", "state", "mark", "note",
  "from", "to", "dir", "style", "tone", "cut", "mesh" }
local NFIELDS = #FIELDS

---@param t table
function M.sig(t)
  local parts = {}
  for i = 1, NFIELDS do
    local v = t[FIELDS[i]]
    parts[i] = v == nil and "" or tostring(v)
  end
  return table.concat(parts, "\1")
end

-- A Host's reach section, as M.sig says a node.
---@param d table M.details's
function M.details_sig(d)
  local parts = { d.title, d.text }
  for _, f in ipairs(d.facts) do parts[#parts + 1] = f.label .. "=" .. f.value end
  return table.concat(parts, "\1")
end

-- What changed from `before` (id -> sig, nil the first time) to `items`: the changed ones and the
-- ids gone, and the new id -> sig.
---@param before table<string, string>?
---@param items table[]
function M.diff(before, items)
  local now, changed, gone = {}, {}, {}
  for _, it in ipairs(items) do
    local sg = M.sig(it)
    now[it.id] = sg
    if not before or before[it.id] ~= sg then changed[#changed + 1] = it end
  end
  if before then
    for id in pairs(before) do
      if not now[id] then gone[#gone + 1] = id end
    end
  end
  return changed, gone, now
end

-- The clusters of the group named `word` (by its name or title): one, or a split group's three.
---@param s table
---@param word string
function M.group_clusters(s, word)
  local w = word:lower()
  local base
  for _, c in ipairs(s.clusters) do
    local b = (c.id:gsub("/peers$", ""):gsub("/out$", ""))
    local title = (c.title:gsub(" · password peers$", ""):gsub(" · not in the Mesh$", ""))
    if b:sub(#":group:" + 1):lower() == w or title:lower() == w then
      base = b
      break
    end
  end
  local out = {}
  if not base then return out end
  for _, c in ipairs(s.clusters) do
    if c.id == base or c.id == base .. "/peers" or c.id == base .. "/out" then out[#out + 1] = c.id end
  end
  return out
end

return M
