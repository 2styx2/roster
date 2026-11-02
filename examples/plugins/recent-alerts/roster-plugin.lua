-- The manifest: read before any of the Plugin's code runs, for the install prompt. It runs with
-- no `roster` module and no `require`, so reading it can't do anything.
return {
  name = "recent-alerts",
  version = "1.0.0",
  description = "Lines your Sessions print that look like trouble: ERROR, panic, disk full",
  author = "A. N. Author",
  api = 3,
  -- Everything it reads comes from the terminal_output event. It asks for nothing else.
  permissions = { "terminal.read" },
}
