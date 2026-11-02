# Vision

## Why

Most of the day goes into getting a shell on hosts in the team Inventory. roster already knows every Host, how to reach it and which Login opens it. Today, though, reaching one means typing `roster hosts --find`, remembering exact names, switching terminals, and doing a separate vault step for password-only gear. The roster app is **a GUI whose whole job is getting you onto a Host quickly, securely, then getting out of the way**.

SecureCRT is the reference point for the skeleton: saved Hosts, tabs, and logging in for you. It is not the model for the look or the workflow. Those are our own taste: access first, keyboard first with vim keys, and quiet, fast motion.

## Who

It's a personal tool first, open source under GPL-3.0-or-later. Choose what feels best to use every day over what would sell.

## What already exists (checked 2026-10-29)

Full, sourced comparison of 15 tools plus adjacent ones: [competitors.md](competitors.md). In short:

| Tool | Closest overlap | How we differ |
|---|---|---|
| **XPipe** | Git vault sync (free), team vaults with RBAC (Pro), 15 password managers through their CLIs, MCP server | Its repo holds encrypted app files, not a readable Inventory. No review gate, no per-service Logins, no `pass`, GUI-only settings, no plugin API. |
| **Termix** | Self-hosted. A hosts file kept in git, `op://` and `bw://` references, and an AI that never sees passwords | Runs as a server that resolves secrets. No `pass` or KeePassXC, no per-service Logins, no review gate, no per-Box keys. Plugins are TypeScript. |
| **Termius** | A polished client on desktop and mobile | Its own cloud vault (no password-manager integration); no git Inventory. |
| **Devolutions RDM, Royal TS** | Password-manager integrations (RDM: 31, Team edition only; Royal TS: scripts), per-connection credentials, RDM's MCP and AI | Enterprise or shared-document models; no git Inventory or review gate. |
| **Tabby, Wave, Warp, WezTerm** | Modern terminals with text configs; Tabby has npm plugins, WezTerm has Lua plugins | No Inventory or vault model. WezTerm plugins aren't pinned. |
| **SecureCRT, MobaXterm, mRemoteNG, Ásbrú, Remmina, Electerm** | Session managers; mRemoteNG has `op://`, Ásbrú has KeePassXC | Per-person sessions, or shared files without review; an older feel. |

## What makes it different (protect these)

1. **A team Inventory in git.** One `roster.yml` is shared by every Box, and changes are Published, not copied around.
2. **Per-service Logins.** One Host can have different vault items for SSH, its web UI and its API, with authenticated web calls through `roster web`.
3. **A review gate.** Discovered Hosts aren't connectable until a person marks them reviewed.
4. **Secrets never reach the UI.** Passwords go from the vault, through roster, into `ssh`, and nothing else.
5. **"Save to vault" on first login.** A password login becomes a properly named Vault item plus a Host for the whole team.
6. **The same model the AI uses.** Claude works through the same roster without ever seeing secrets, and other tools read the same data with `--json`.
7. **It knows your network.** The Mesh says which Host can reach which, with their own keys and no agent; Topology draws it; Discover adds what a scan finds, behind the review gate.
