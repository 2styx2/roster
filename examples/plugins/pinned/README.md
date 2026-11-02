# pinned

A small roster Plugin: a Sidebar section of the Hosts you pin. [docs/plugins.md](../../../docs/plugins.md) walks through it as a first Plugin; [recent-alerts](../recent-alerts/README.md) is the bigger worked example, and the template for yours.

## What it adds

| Where | What |
|---|---|
| Sidebar | A **Pinned** section: each Host you pinned, with its address. Enter opens it; the × on a row unpins it |
| Status bar | `2 pinned`, which opens the finder |
| Finder | `:finder pinned` (and `␣ p p`): find a pinned Host |
| Commands | `:pin HOST` pins a Host |
| Help | `:help pinned` |

The pins live in memory: they're gone when the app restarts. A Host renamed or removed elsewhere drops out.

## Permissions

| Permission | Why |
|---|---|
| `inventory.read` | To show each Host's address, and to refuse a name that isn't a Host |

## Install

```text
:plugins install ~/roster/examples/plugins/pinned
```

The path is wherever your copy of the folder is.
