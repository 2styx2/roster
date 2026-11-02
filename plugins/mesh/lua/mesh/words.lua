-- The pure part of the Mesh controls: what serve's answers say, in words. No `roster` here, so it's
-- the same on every machine and in every test.
local M = {}

-- 1284 -> "1,284".
---@param n integer
---@return string
function M.count(n)
  local s = tostring(n)
  local out = s:reverse():gsub("(%d%d%d)", "%1,"):reverse()
  return (out:gsub("^,", ""))
end

---@param n integer
---@param one string
---@param many string
---@return string
function M.plural(n, one, many) return M.count(n) .. " " .. (n == 1 and one or many) end

-- What a Link's status means, in a few words.
M.STATUS = {
  ok = "works",
  untested = "written, not tested",
  asked = "not tested yet",
  unreachable = "unreachable",
  ["no-host-key"] = "no host key",
  ["no-via"] = "no Link to its hop",
  pending = "pending",
  skipped = "skipped",
}

-- What to do about it, for a Link's details.
M.FIX = {
  ok = "Nothing: it works.",
  untested = "Nothing to do: the source has no nc or bash to test the port with, so roster wrote it without testing.",
  asked = "Plan the Mesh (p) to test it from its source.",
  unreachable = "Check routing and firewalls between the two it names, then plan again. Until the port answers, the Link is left out.",
  ["no-host-key"] = "This Box has no recorded host key for the peer: check its key and run roster setup --only PEER, then plan again.",
  ["no-via"] = "The Link goes through a jump Host (via:) that its source has no Link to, and ssh logs in to the jump Host first. Add a Link from the source to the jump Host in roster.yml's links:, or take via: off. Until then the Link is left out, and roster check fails.",
  pending = "Nothing to do now: a Host didn't answer. The next apply finishes it.",
  skipped = "Nothing: the source is a password Host (enroll: false), so roster never writes on it. Its peers still reach it.",
}

-- A Link that is left out until something changes.
M.LEFT_OUT = { unreachable = true, ["no-host-key"] = true, ["no-via"] = true }

---@param status string?
---@return string
function M.status(status) return M.STATUS[status or "asked"] or status or "not tested yet" end

-- What a Host's row says about it, and how it's marked.
---@param host string
---@param st table mesh.status, brief
---@return string state, string? tone
function M.state(host, st)
  if st.excluded and st.excluded[host] then return "kept out: " .. st.excluded[host], "muted" end
  if st.cut_pending and st.cut_pending[host] then
    return "cut, pending on " .. M.plural(#st.cut_pending[host], "Host", "Hosts"), "warn"
  end
  for cut, peers in pairs(st.cut_pending or {}) do
    for _, p in ipairs(peers) do
      if p == host then return "still holds " .. cut .. "'s key (cut pending)", "warn" end
    end
  end
  if st.pending and st.pending[host] then return "pending: " .. st.pending[host], "warn" end
  return "in the Mesh", nil
end

-- "can reach 7 Hosts": the risk the Mesh shows on every Host.
---@param n integer
---@return string
function M.reach(n) return "can reach " .. M.plural(n, "Host", "Hosts") end

-- A Link as one line: "orion-3 → db-9 via jump-1".
---@param x table a Link
---@return string
function M.link(x) return x.from .. " → " .. x.to .. (x.via and (" via " .. x.via) or "") end

-- A row id: the name when it fits (100 characters), else its place.
---@param name string
---@param i integer
---@return string
function M.id(name, i) return #name <= 100 and name or ("#" .. i) end

-- roster serve's error (roster.serve.request's or .call's) without the function's name in front.
---@param e any
---@return string
function M.clean(e)
  local s = tostring(e)
  return (s:gsub("^.-roster%.serve%.%a+ [%w%._]+: ", ""))
end

-- The keys of a table, sorted, as a list.
---@param t table?
---@return string[]
function M.keys(t)
  local out = {}
  for k in pairs(t or {}) do out[#out + 1] = k end
  table.sort(out)
  return out
end

-- init.lua's settings, checked: a bad one is named and the default used.
---@param config table
---@return { leader: string|false }, string[]
function M.settings(config)
  local s, problems = { leader = "y m" }, {}
  local k = config.leader
  if k ~= nil then
    if k == false or (type(k) == "string" and k ~= "" and not k:find("^ ") and not k:find(" $") and not k:find("  ")) then
      s.leader = k
    else
      problems[#problems + 1] = 'config.leader must be keys after the Leader, such as "y m", or false for none'
    end
  end
  return s, problems
end

return M
