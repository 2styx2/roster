// What roster-core's Plugin host decides that the app and its fake Backend agree with (events,
// limits, permissions' words, built-in Plugins). Written by `cargo run -p roster-core --example gen_plugin_api`
// from crates/roster-core/src/plugin: don't edit it here.
export const CORE = {
  "builtin_prefix": "builtin:",
  "bundled": [
    "hosts",
    "folders"
  ],
  "complete_api": 5,
  "events": [
    {
      "name": "lock",
      "needs": []
    },
    {
      "name": "unlock",
      "needs": []
    },
    {
      "name": "host_selected",
      "needs": [
        "inventory.read",
        "terminal.read"
      ]
    },
    {
      "name": "session_open",
      "needs": [
        "inventory.read",
        "terminal.read"
      ]
    },
    {
      "name": "session_exit",
      "needs": [
        "inventory.read",
        "terminal.read"
      ]
    },
    {
      "name": "inventory_changed",
      "needs": [
        "inventory.read"
      ]
    },
    {
      "name": "terminal_output",
      "needs": [
        "terminal.read"
      ]
    },
    {
      "name": "command_done",
      "needs": [
        "terminal.read"
      ]
    },
    {
      "name": "job_progress",
      "needs": [
        "serve:mesh.job",
        "serve:discover.status",
        "serve:host.check_job"
      ]
    }
  ],
  "job_kinds": {
    "check": "serve:host.check_job",
    "discover": "serve:discover.status",
    "mesh": "serve:mesh.job"
  },
  "key_contexts": [
    "leader",
    "list",
    "list_vim"
  ],
  "limits": {
    "defer_min_ms": 50,
    "every_min_ms": 1000,
    "max_copy": 65536,
    "max_serve_requests": 8,
    "max_timers": 100,
    "storage_file": 1048576,
    "storage_files": 1000,
    "storage_name": 100,
    "storage_total": 10485760,
    "strikes": 3,
    "timer_max_ms": 2147483647.0
  },
  "package_prefix": "package:",
  "permissions": {
    "serve_methods": [
      "inventory.info",
      "hosts.list",
      "host.get",
      "host.check",
      "host.check_job",
      "changes.diff"
    ],
    "serve_prefixes": [
      "mesh.",
      "discover."
    ],
    "serve_reads": [
      "inventory.info",
      "hosts.list",
      "host.get",
      "host.check_job",
      "changes.diff",
      "mesh.status",
      "mesh.plan",
      "mesh.job",
      "mesh.stop",
      "discover.plan",
      "discover.status",
      "discover.stop"
    ],
    "serve_risk": "Can run roster's {method}, which can change things on your Hosts or in the Inventory.",
    "serve_summary": "Call roster's {method}",
    "words": {
      "inventory.read": {
        "risk": null,
        "summary": "Read your Hosts and their Login references (never a password)"
      },
      "inventory.write": {
        "risk": "Can change Hosts. The changes stay Pending until you review and Publish them.",
        "summary": "Change Hosts, as Pending changes"
      },
      "serve:discover.add": {
        "risk": "Can add the Hosts a scan found to your Inventory, unreviewed, as Pending changes you review and Publish.",
        "summary": "Add the Hosts a scan found, as Pending changes"
      },
      "serve:discover.start": {
        "risk": "Can scan networks from this computer, once you've confirmed it: roster connects to every address in a range, on many ports. A network's security tools may take a scan for an attack, so scan only networks you may.",
        "summary": "Scan a network you name, from this computer"
      },
      "serve:host.check": {
        "risk": "Can check your Hosts as :check HOST does: roster connects to the Host and signs in once with its Login, then leaves (the Plugin never sees the password). It changes nothing there or in the Inventory, but a failed sign-in counts like any other.",
        "summary": ""
      },
      "sessions.open": {
        "risk": "Can open Sessions on your Hosts.",
        "summary": "Open Sessions"
      },
      "terminal.read": {
        "risk": "Sees everything your Sessions print, including anything a server echoes back. A password you type at a prompt that echoes it would be visible too.",
        "summary": "Read what your Sessions print"
      },
      "terminal.write": {
        "risk": "Can type into your open Sessions, as if you typed it: it can run commands on your servers.",
        "summary": "Type into your Sessions"
      }
    }
  }
} as const;
