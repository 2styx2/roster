-- The manifest: read before any of the Plugin's code runs, for the install prompt. It runs with
-- no `roster` module and no `require`, so reading it can't do anything.
return {
  name = "topology",
  version = "1.1.0",
  description = "The Topology view: this Box, your Hosts by group, the Mesh and its Links as a map",
  author = "roster",
  api = 4,
  -- Why each one is here is in README.md ("Permissions"). It loads without any of them, and says
  -- what it's missing.
  permissions = {
    "inventory.read", -- the Hosts and groups, and which Sessions are live
    "serve:mesh.status", -- who reaches whom in the Mesh (it never connects anywhere)
    "serve:host.check", -- Check from a node: the app's :check HOST, roster's diagnostics for it
    "serve:mesh.cut", -- Cut from a node, after a question you answer by typing the Host's name
    "serve:mesh.job", -- how that cut is going, while roster serve runs it
    "serve:host.check_job", -- how a :check of a Host came out, so a failed one shows it down
  },
}
