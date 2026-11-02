-- The manifest: read before any of the Plugin's code runs, for the install prompt. It runs with
-- no `roster` module and no `require`, so reading it can't do anything.
return {
  name = "discover",
  version = "1.0.0",
  description = "Scan a network from the app and add what it finds, as Pending changes you review",
  author = "roster",
  api = 3,
  -- The scan runs in roster serve, never here: these are the only serve methods it calls.
  --   discover.plan    how many addresses a range holds, and with what it'd scan (connects nowhere)
  --   discover.start   start a scan you confirmed (flagged: it's a network action)
  --   discover.status  how far it has got, and what it found
  --   discover.stop    stop it
  --   discover.add     add the Hosts you kept, unreviewed, as Pending changes (flagged)
  permissions = {
    "serve:discover.plan",
    "serve:discover.start",
    "serve:discover.status",
    "serve:discover.stop",
    "serve:discover.add",
  },
}
