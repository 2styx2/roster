-- The pure part of recent-alerts: reading its settings, cutting a Session's output into lines and
-- matching them. No `roster` calls here, so it's easy to test and to reuse.
local M = {}

M.DEFAULT_PATTERNS = { "ERROR", "panic", "disk full" }
M.DEFAULT_LEADER = "w w"
M.DEFAULT_MAX = 100
-- At most one notice per Host this many seconds apart; the alerts in between are counted in the next.
M.DEFAULT_QUIET = 30
-- A line is cut to this many characters (a Sidebar row shows far fewer).
M.LINE_MAX = 300
-- What's kept of a line that hasn't ended yet, per Session.
local CARRY_MAX = 2000

-- The settings from init.lua's `packages = { { "…/recent-alerts", config = { … } } }`, checked.
-- Gives the settings, and a list of problems to tell the user about (bad values use the default).
function M.settings(config)
  config = type(config) == "table" and config or {}
  local problems = {}
  local s = { patterns = M.DEFAULT_PATTERNS, leader = M.DEFAULT_LEADER, max = M.DEFAULT_MAX, notify = true, quiet = M.DEFAULT_QUIET }

  if config.patterns ~= nil then
    local ok = type(config.patterns) == "table" and #config.patterns > 0
    local list = {}
    if ok then
      for _, p in ipairs(config.patterns) do
        if type(p) ~= "string" or p == "" or #p > 200 then
          ok = false
          break
        end
        list[#list + 1] = p
      end
    end
    if ok then
      s.patterns = list
    else
      problems[#problems + 1] = "config.patterns must be a list of text, such as { \"ERROR\", \"panic\" }"
    end
  end
  if config.leader ~= nil then
    local keys = config.leader
    if type(keys) == "string" and keys ~= "" and not keys:find("^ ") and not keys:find(" $") and not keys:find("  ", 1, true) then
      s.leader = config.leader
    else
      problems[#problems + 1] = "config.leader must be keys after the Leader, such as \"w w\""
    end
  end
  if config.max ~= nil then
    if math.type(config.max) == "integer" and config.max >= 1 and config.max <= 1000 then
      s.max = config.max
    else
      problems[#problems + 1] = "config.max must be a whole number from 1 to 1000"
    end
  end
  if config.notify ~= nil then
    if type(config.notify) == "boolean" then
      s.notify = config.notify
    else
      problems[#problems + 1] = "config.notify must be true or false"
    end
  end
  if config.quiet ~= nil then
    if math.type(config.quiet) == "integer" and config.quiet >= 0 and config.quiet <= 3600 then
      s.quiet = config.quiet
    else
      problems[#problems + 1] = "config.quiet must be a whole number of seconds from 0 to 3600"
    end
  end
  return s, problems
end

-- Splits `carry .. text` into whole lines; gives them and what's left of an unfinished last line.
function M.lines(carry, text)
  local all = (carry or "") .. text
  local out, start = {}, 1
  while true do
    local nl = all:find("\n", start, true)
    if not nl then break end
    out[#out + 1] = all:sub(start, nl - 1)
    start = nl + 1
  end
  local rest = all:sub(start)
  if #rest > CARRY_MAX then
    -- Keep its end, cut where a character starts: never in the middle of a multi-byte one.
    rest = rest:sub(-CARRY_MAX):gsub("^[\128-\191]+", "")
  end
  return out, rest
end

-- The first pattern `line` contains, or nil. Patterns are plain text, not Lua patterns: a `.` or a
-- `%` in one means just that character.
function M.first(line, patterns)
  for _, p in ipairs(patterns) do
    if line:find(p, 1, true) then return p end
  end
  return nil
end

-- Whether `line` looks like a shell prompt and what was typed after it ("esx-02$ grep ERROR …",
-- "root@esx-02:~# …", "[admin@appliance logs]$ …", "$ …", "PS C:\logs> …"): the shell's echo of
-- your own command, not something the server said. A guess: a log line that happens to start the
-- same way is skipped too. A line a shell's OSC 133 marks call "prompt" or "input" (the event's
-- `kind`) is skipped whatever it looks like.
function M.prompt(line)
  return line:find("^%S+[%$#] ") ~= nil
    or line:find("^%[[^%]]*%][%$#] ") ~= nil
    or line:find("^%$ ") ~= nil
    or line:find("^PS [^>]*> ") ~= nil
end

-- A line as an alert shows it: no surrounding blanks, cut to LINE_MAX.
function M.tidy(line)
  line = line:gsub("^%s+", ""):gsub("%s+$", "")
  if utf8.len(line) and utf8.len(line) > M.LINE_MAX then
    line = line:sub(1, utf8.offset(line, M.LINE_MAX) - 1) .. "…"
  elseif #line > M.LINE_MAX * 4 then
    line = line:sub(1, M.LINE_MAX) .. "…"
  end
  return line
end

return M
