-- The manifest: read before any of the Plugin's code runs, for the install prompt. It runs with
-- no `roster` module and no `require`, so reading it can't do anything.
return {
  name = "mesh",
  version = "1.0.0",
  description = "The Mesh's controls: who reaches whom, plan and apply it, and Cut a Host out",
  author = "roster",
  api = 4,
  -- Each one is explained in README.md ("Permissions"). The three that change something on your
  -- Hosts (plan only reads; apply and cut write) run only after a question you answer.
  permissions = {
    "inventory.read",
    "serve:mesh.status",
    "serve:mesh.job",
    "serve:mesh.stop",
    "serve:mesh.plan",
    "serve:mesh.apply",
    "serve:mesh.cut",
  },
}
