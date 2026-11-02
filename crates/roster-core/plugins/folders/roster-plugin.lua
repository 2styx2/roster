-- Folders, the Sidebar's own groupings of Hosts (GLOSSARY), a built-in feature written as a
-- Plugin on the public API (tickets 23 and 61, decision Q93). It keeps the Folders you make in
-- its own data folder (roster.storage), shows init.lua's Folders first, and asks for
-- inventory.read like any Plugin would: to check a Host's name and know the Host under the
-- cursor. `:plugins` lists it and can revoke that.
return {
  name = "folders",
  version = "1.0.0",
  description = "The Sidebar's Folders: your own groupings of Hosts",
  author = "roster",
  api = 4,
  permissions = { "inventory.read" },
}
