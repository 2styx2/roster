-- The manifest: read before any of the Plugin's code runs, for the install prompt.
return {
  name = "pinned",
  version = "1.0.0",
  description = "A Sidebar section of the Hosts you pin",
  author = "roster",
  api = 3,
  permissions = { "inventory.read" },
}
