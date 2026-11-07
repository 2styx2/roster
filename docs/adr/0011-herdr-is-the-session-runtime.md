# herdr is the session and Agent runtime; the roster app is frozen

_Status: **Accepted (2026-11-06)**, the owner's answers to the herdr design session (Q1–Q11)._

roster's goal on a person's Box is: open work on any Host quickly, with the login from the vault, and let the coding Agents running across those Hosts know each other and reach each other when they choose. The roster app (Tauri, `app/` and `crates/`) was growing into a terminal multiplexer to do that. [herdr](https://herdr.dev) already is one: `hc` (herdr-core) keeps terminals alive across closes, drops and updates, reports each Agent's status, lets Agents start, message, wait on and read each other across machines, and herdr-app is a desktop client extended by JavaScript mods.

## Decided

- **roster stays a standalone CLI.** The Inventory, Logins from the vault, `run`, `web`, `check`, `discover`, the Mesh and `ROSTER.md` keep working with or without herdr.
- **The app is frozen, not removed.** `app/` and `crates/` stay in the repo; no new work goes into them. Deleting them is a later, separate decision.
- **herdr is the runtime** for Sessions on Hosts that run `hc` and for every Agent. roster adds what herdr doesn't have: the Inventory, vault Logins, password-only gear and Host-to-Host access.
- **The herdr side is a mod in its own repo**, so other herdr users can install it from herdr's mod gallery. It calls the `roster` CLI and reads only its `--json` output, never `roster serve` (serve stays the app's private backend, [ADR 0010](0010-roster-mcp.md#1-transport-and-shape)).
- **Which Hosts run `hc` is a person's choice on their Box**, toggled per Host in the mod; nothing about it goes into the team's `roster.yml`.
- **Hosts that can't run `hc`** (switches, ESXi, Windows DCs, password-only gear) open as `roster ssh HOST` in a terminal on the Hub.
- **The Agent directory** is kept by the Hub and written into each herdr machine, so an Agent on a remote Host can list its peers locally (`roster agents`). herdr's own messaging is hub-and-spoke (a remote can only answer the Hub terminal that started work there); **between remote Hosts, the Mesh carries Agent messages** (`roster agent send box-b/t2 …` runs `hc` on box-b over the Mesh key).

## Considered

- **Keep building the app** into sessions, persistence and Agent status. That duplicates herdr, which has a far larger user base, and the app already took about two thirds of the project's commits.
- **Contribute roster to herdr upstream.** herdr keeps its core small and puts everything else in mods by policy; a mod needs nobody's approval.
- **Wrap `roster serve` for the mod.** serve holds the unlocked vault and the askpass channel and versions with the app; `--json` is the public, versioned contract.

## Consequences

- No interactive password Sessions from the app's Picker any more: `roster ssh HOST` replaces them, without Prompt fill at first.
- Editing the Inventory, Discover, the Mesh controls and the Topology map lose their UI until the mod or the CLI gets them back.
- herdr-core and herdr-app were three weeks old when this was decided, with one main maintainer and an unversioned mod API. roster's side stays thin so a herdr change costs a mod fix, not a redesign.
