# Competitor analysis

Checked **2026-10-29** against primary sources: official docs, pricing pages, GitHub/GitLab repos, release notes and changelogs. Every claim links its source. **UNVERIFIED** marks anything a primary source didn't confirm. Prices are list prices on that date, excluding tax.

The roster app is at v0.2.0, with iterations 8 and 9 on `dev` (see [roadmap.md](roadmap.md)). Where this doc compares, "roster" means **the roster CLI + the roster app as built**; anything not built yet is tagged *(planned)*. roster's CLI already ships the Inventory, providers, `discover`, `setup`, `run`, `web`, `mesh` and `serve`, with `--json` on its read commands.

## Contents

1. [Findings that matter](#findings-that-matter)
2. [roster baseline](#roster-baseline)
3. [Overview matrix](#overview-matrix)
4. Competitors: [XPipe](#xpipe) · [Termix](#termix) · [Termius](#termius) · [Devolutions RDM](#devolutions-remote-desktop-manager) · [Royal TS/TSX](#royal-ts--royal-tsx) · [Tabby](#tabby) · [Warp](#warp) · [Wave](#wave-terminal) · [WezTerm](#wezterm) · [SecureCRT](#securecrt) · [MobaXterm](#mobaxterm) · [Electerm](#electerm) · [mRemoteNG](#mremoteng) · [Ásbrú](#ásbrú-connection-manager) · [Remmina](#remmina) · [Adjacent tools](#adjacent-tools)
5. [Customizability and extensibility](#customizability-and-extensibility)
6. [Secrets model](#secrets-model)
7. [Positioning](#positioning)
8. [Not verified](#not-verified)

## Findings that matter

1. **Termix already combines the three ideas we treated as our core.** It is self-hosted, Apache-2.0 and about 15.7k stars. Its pieces:
   - a git-kept hosts file ([Hosts Config plugin](https://docs.termix.site/plugins/hosts-config): "a file you keep next to your deployment, for example in git")
   - `op://` and `bw://` password-manager references resolved at connect time ([Secret Sources](https://docs.termix.site/plugins/secret-sources))
   - an AI assistant that reads host data but "never passwords or keys" ([AI plugin](https://docs.termix.site/plugins/ai))

   Our differences are now *how* we do it, not *whether*:
   - local-first desktop using your own vault session (Termix resolves secrets on its server)
   - `pass` and KeePassXC support
   - per-service Logins on one Host
   - the review gate and per-Box keys
   - a keyboard-first terminal UI
   - Lua config and Packages
2. **XPipe has team vaults in git and reads 15 password managers.**
   - **Git sync** of the vault is in the free tier ([sync](https://docs.xpipe.io/guide/sync)).
   - **Team vaults with RBAC** (Professional plan): each role's key lives in the team's password manager ([team vault](https://docs.xpipe.io/guide/team-vault)).
   - **Password managers:** Bitwarden, 1Password, KeePassXC, Keeper and 11 more ([list](https://docs.xpipe.io/guide/password-manager)).
   - **MCP server**, added in XPipe 18 ([MCP](https://docs.xpipe.io/guide/mcp)).

   vision.md said XPipe's hosts are "a personal list with no team Inventory in git", which is no longer accurate. What it *doesn't* have:
   - a readable, reviewable inventory (its repo holds XPipe's own encrypted files)
   - a review gate
   - per-service web or API Logins
   - `pass`
   - a text config file
   - a plugin API
3. **"The AI uses it without seeing secrets" is now claimed by at least four products:**
   - Devolutions RDM, with an MCP server and AI assistant since 2026.1 ([blog](https://devolutions.net/blog/whats-new-in-devolutions-remote-desktop-manager-20261/))
   - Termix
   - Teleport, through MCP access ([docs](https://goteleport.com/docs/enroll-resources/mcp-access/getting-started/))
   - Bitwarden's Agent Access SDK, alpha ([blog](https://bitwarden.com/blog/introducing-agent-access-sdk/))

   What's still ours: the agent uses **plain `ssh`, `roster run` and `roster web` on any Box**, with `ROSTER.md` as its map, and needs no server, MCP gateway or vendor account.
4. **Nobody else has the review gate or per-Box key revocation.**
   - No tool found turns a network scan into hosts that can't be connected to until a person reviews them. mRemoteNG, RDM, MobaXterm and XPipe all scan, then trust what they find.
   - No tool found issues a tagged SSH key per device that you can revoke on its own. Termius SSH ID has per-device keys, but revoking one means logging out on that device ([SSH ID](https://docs.termius.com/ssh-id-passkeys-for-ssh/what-is-ssh-id.md)).
   - These, plus per-service Logins, are the most defensible differentiators.
5. **On config and plugins, our model has no direct rival, and it improves on its reference.**
   - WezTerm plugins track the default branch, with **no pinning and no lock file** ([plugins](https://wezterm.org/config/plugins.html)).
   - Tabby plugins are unsandboxed npm/Angular packages ([HACKING.md](https://github.com/Eugeny/tabby/blob/master/HACKING.md)).
   - Electerm widgets run with full Node privileges in the main process ([guide](https://github.com/electerm/electerm/wiki/User-widget-guide)).
   - XPipe, Termius, SecureCRT and Royal TS have no third-party plugin API.
   - ADR 0006's Lua Packages, pinned in `roster.lock`, never shown secrets, and writing only Pending changes, are a real gap in this market. It is also a niche taste.

## roster baseline

The values every "vs roster" cell below is compared against.

| Dimension | roster CLI + app |
|---|---|
| Inventory and sharing | One `roster.yml` in the team's git repo (`~/infra`). Edits become Pending changes, then Publish (commit and push to `main`). Every Box pulls. Personal Folders stay on this Box (the Folders Plugin's data folder, Q93). |
| Secrets | **No vault of our own (Q40).** Logins are references (`bw:esxi-02 ssh+web`, `op:…`) to the user's Bitwarden, 1Password or `pass`, or to an env var or any command. KeePassXC (`keepassxc-cli`) is the local-only option (Q41). A secret goes from the vault to `roster serve` to askpass to `ssh`, and never reaches the UI ([security.md](security.md)). |
| What a Host describes | Address, type, product and description; how it is reached (port, user, key or password only); web UIs and API services; **per-service Logins** (SSH vs web vs API). `roster web` makes authenticated API calls. |
| Discovery | `roster discover` (nmap) writes Hosts with `reviewed: false`, which can't be connected to until reviewed. Quick Connect plus "Save to vault" turns a first login into a Vault item and a Host. `roster discover` runs from the CLI, or from the app through the Discover Plugin (Q100). |
| Network | The Mesh: Hosts reach each other with their own keys, per group or Link, through jump Hosts; Topology draws it (first-party Plugins). |
| Keys | `roster setup` gives each Box its own key, tagged with the Box's name, and installs it with the vault password once. You can revoke one Box. Host keys are recorded, and enrolled Hosts use `BatchMode=yes`. |
| Automation and AI | roster CLI, with `--json` on its read commands for scripts and other tools (never a secret, Q110); `ROSTER.md` tells Claude which Hosts exist and to read them with `--json`. Claude uses `ssh`, `roster run` and `roster web` and sees only the output. `roster serve` is the app's internal backend, not an API for other tools. |
| Customizability | `init.lua` (Lua 5.4 through mlua), applied with `:source` (or on every save with `auto_reload = true`, Q58), with **no Settings screen** (ADR 0004). Themes are sets of tokens. Keymap, leader, vim keys, fonts, and a layout table per view mode (Q33, Q36, Q39). |
| Extensibility | Lua Plugins on the app's own registries, and Packages from git pinned in `roster.lock`. Plugins never see secrets, and their writes become Pending changes only. No plugin HTML/JS in v1 (ADR 0006). |
| Setup sync | Plain files synced through git dotfiles; no vendor cloud (Q42). |
| Platforms | Windows (native, or with roster in WSL) and Linux (X11, Wayland, WSLg); a macOS build ships but isn't tested day to day. |
| Licence and price | GPL-3.0-or-later, public on GitHub; a personal tool first. Might get a small subscription later. |
| Not in scope yet | SFTP, split panes, port forwarding, broadcast input, RDP/VNC, mobile, macOS as a tested platform. |

## Overview matrix

✓ = yes · ◐ = partial, or needs a paid tier, plugin or script · ✗ = no.

| | Team inventory in git | PM references (no own vault) | `pass` / KeePassXC | Per-service logins (SSH / web / API) | Discovery → review gate | Per-device keys + revoke | AI without secrets | Text config file | Plugin API | Open source | Cross-platform desktop |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **roster** | ✓ (readable YAML) | ✓ | ✓ / ✓ | ✓ | ✓ / ✓ | ✓ | ✓ (CLI) | ✓ Lua | ✓ Lua | ✓ GPL-3.0 | Win, Linux (macOS untested) |
| XPipe | ◐ encrypted vault in git; team = Pro | ◐ PM or own vault | ✗ / ✓ | ✗ | ◐ scan, no gate | ✗ | ◐ MCP, secrets not stated | ✗ | ✗ | ◐ open core | ✓ |
| Termix | ✓ hosts file (server-side) | ◐ refs or server store | ✗ / ✗ | ✗ | ✗ import only | ✗ | ✓ | ◐ YAML hosts file | ✓ TS | ✓ | ✓ + web, mobile |
| Termius | ✗ own cloud | ✗ own vault | ✗ / ✗ | ✗ | ✗ import only | ◐ SSH ID | ? | ✗ | ✗ | ✗ | ✓ + mobile |
| Devolutions RDM | ✗ DB / server | ◐ 31 PMs, Team only | ✗ / ◐ KeePass | ✓ per entry | ◐ scan, AD, no gate | ✗ | ✓ vendor claim | ✗ | ◐ add-ons | ✗ | ✓ + mobile |
| Royal TS/TSX | ◐ shared document file | ◐ script integrations | ✗ / ◐ KeePass import | ✓ per connection | ◐ dynamic folders | ✗ | ✗ | ✗ | ✗ 3rd-party | ✗ | Win, Mac |
| Tabby | ✗ | ✗ own vault or keychain | ✗ / ◐ plugin | ✗ | ✗ | ✗ | ◐ plugins | ✓ YAML | ✓ TS/npm | ✓ MIT | ✓ |
| Warp | ✗ no hosts | ◐ env vars only | ✗ / ✗ | ✗ | ✗ | ✗ | ◐ redaction | ✓ TOML | ✗ | ✓ AGPL client | ✓ |
| Wave | ✗ local JSON | ✗ own store | ✗ / ✗ | ✗ | ✗ | ✗ | ✗ | ✓ JSON | ◐ JSON widgets | ✓ | ✓ |
| WezTerm | ◐ user's own Lua | ✗ | ◐ via Lua | ✗ | ✗ | ✗ | ✗ | ✓ Lua | ✓ Lua, unpinned | ✓ MIT | ✓ |
| SecureCRT | ◐ .ini files on a share | ✗ own store | ✗ / ✗ | ✗ | ✗ | ✗ | ✗ | ◐ .ini | ✗ scripts | ✗ | ✓ + iOS |
| MobaXterm | ◐ shared .mxtsessions | ✗ own vault | ✗ / ✗ | ✗ | ◐ port scanner | ✗ | ✗ | ◐ .ini | ✗ | ✗ | Windows |
| Electerm | ◐ gist sync | ✗ own store | ✗ / ✗ | ✗ | ✗ | ✗ | ◐ MCP widget | ✗ | ◐ widgets, Node | ✓ MIT | ✓ + mobile |
| mRemoteNG | ◐ XML / SQL | ◐ 1Password, Delinea, Passwordstate, OpenBao | ✗ / ✗ | ◐ RDP/SSH/HTTP entries | ◐ nmap, AD, no gate | ✗ | ✗ | ◐ XML | ◐ .NET DLL | ✓ GPL-2 | Windows |
| Ásbrú | ◐ YAML (encoded secrets) | ◐ KeePassXC, `<CMD:>` | ✗ / ✓ | ✗ | ✗ | ✗ | ✗ | ◐ YAML | ✗ | ✓ GPL-3 | Linux |
| Remmina | ✗ per-profile files | ◐ libsecret / KWallet | ✗ / ✗ | ✗ | ✗ | ✗ | ✗ | ◐ INI | ◐ C/Python | ✓ GPL-2+ | Linux |

---

## XPipe

**Positioning:** a cross-platform connection hub over the tools you already have (ssh, docker, k8s, hypervisors), installing nothing on remote hosts. **This is the closest desktop rival.** ([repo](https://github.com/xpipe-io/xpipe))

| Dimension | XPipe | vs roster |
|---|---|---|
| Inventory and sharing | Local encrypted vault ("no servers involved"). **Git vault sync** to your own repo is in the free Community tier; by default only secrets are encrypted ([sync](https://docs.xpipe.io/guide/sync), [pricing](https://xpipe.io/pricing)). **Team vaults** (Professional): "a git repository of encrypted files", RBAC since XPipe 24 (Sep 2026), each role's key handed out through the team's password manager ([team vault](https://docs.xpipe.io/guide/team-vault), [blog](https://xpipe.io/blog)). | Both use git. XPipe's repo is app-managed encrypted files. Ours is a hand-readable `roster.yml` with a diff and Publish step. XPipe has no read-only role ("anyone with access to a role can view and modify"). |
| Secrets | Reads from 15 password managers through their CLIs: 1Password (`op` + SSH agent), Bitwarden/Vaultwarden (`bw` + SSH agent), KeePassXC (browser protocol), Keeper, Proton Pass, HashiCorp Vault, OpenBao, Passbolt, Dashlane, Passwork, Psono, LastPass, Enpass, Windows Credential Manager, custom command ([list](https://docs.xpipe.io/guide/password-manager)). Can also store passwords in its own vault. **No `pass`.** | Same "point at your vault" idea, with more managers. We have `pass`, no own vault at all (Q40), and secrets kept out of the UI process. |
| What a host describes | SSH, containers (Docker, Podman, LXD, Incus), VMs (Proxmox, Hyper-V, KVM, VMware), k8s, RDP/VNC, WSL, cloud (AWS, Hetzner), Tailscale/Teleport, serial ([repo](https://github.com/xpipe-io/xpipe)). Identities combine user, password and key; can differ per device ([identities](https://docs.xpipe.io/guide/identities)). | Much wider protocol reach. No per-service web/API Logins on one host. |
| Discovery and import | `~/.ssh/config` stays the source of truth; PuTTY/KiTTY; Tailscale, Netbird, AWS, Hetzner listing; network scan since XPipe 18 ([ssh](https://docs.xpipe.io/guide/ssh), [blog](https://xpipe.io/blog)). | No review gate. |
| Keys | System OpenSSH; `ssh-keygen` including FIDO2; any agent including password-manager agents; PKCS#11; SSH certificates (Pro) with auto-renewal through Vault or OpenBao ([ssh-auth](https://docs.xpipe.io/guide/ssh-auth)). Key revocation not documented (UNVERIFIED). | Stronger key tooling. No per-device key you can revoke on its own. |
| Automation and AI | Localhost HTTP API with a Python client, including a **secret-decrypt endpoint** ([API](https://docs.xpipe.io/api)). MCP server (off by default; write actions opt-in) ([MCP](https://docs.xpipe.io/guide/mcp)). Claude Code MCP helper in v24.10, 2026-10-29 ([releases](https://github.com/xpipe-io/xpipe/releases)). Whether secrets can reach the model: UNVERIFIED. | We expose Login references only, never values. |
| Customizability | GUI settings, UI themes; opens your external terminal; splits (XPipe 20), docked terminal on Windows ([blog](https://xpipe.io/blog)). No config file, keymap or vim mode documented (UNVERIFIED). | We are config-as-code and keyboard-first, with the terminal built in. |
| Extensibility | No public plugin API. Paid "extensions" are closed modules. Scripts can be fetched from git ([XPipe 21](https://xpipe.io/blog/xpipe-21-released)). | Our Lua Packages have no counterpart. |
| Platforms | Windows, macOS, Linux; browser via the "webtop" Docker image ([repo](https://github.com/xpipe-io/xpipe)). | Has macOS. |
| Licence | Apache-2.0 core; paid extensions and the shell-handling library are closed ([repo](https://github.com/xpipe-io/xpipe)). | — |
| Pricing | Community free; Homelab $5/mo or $40/yr; Professional $10/mo or $80/yr; Enterprise custom. Whether prices are per user: UNVERIFIED ([pricing](https://xpipe.io/pricing)). | — |

**Better than us:** breadth of connection types and password managers; mature key and certificate support; macOS; many releases already shipped (XPipe 14→24 in 2025–26); team vaults whose access is managed in the password manager.
**What we do that it doesn't:** an Inventory people can read and review; Publish with a diff; review gate; per-service Logins and `roster web`; `pass`; a UI that never sees secrets; per-Box keys; Lua config and Packages; a built-in, keyboard-first terminal.

## Termix

**Positioning:** "a free, self-hosted Termius". A web server with desktop, iOS and Android clients. **This is the closest conceptually.** ([repo](https://github.com/Termix-SSH/Termix), v26.10.6, 2026-10-29)

| Dimension | Termix | vs roster |
|---|---|---|
| Inventory and sharing | Hosts in the server database, shared with users or roles at four levels (connect, view, edit, manage). The **Hosts Config** plugin makes a YAML/JSON file the source of truth, "for example in git": hosts from it are locked in the app; the file is reloaded and validated with the last good load kept; it carries its own share list; `strict: true` blocks manual hosts ([docs](https://docs.termix.site/plugins/hosts-config)). | Very close to our model. Differences: the file lives on a server, edits happen outside the app (no in-app edit, diff and Publish), and sharing is server RBAC rather than git access. |
| Secrets | Secrets are stored encrypted on the server, or fetched at connect time through **Secret Sources**: `op://` (1Password Connect), `bw://` (through `bw serve`), `bws://`, `vault://` (HashiCorp Vault / OpenBao), `infisical://`, cached for one minute ([docs](https://docs.termix.site/plugins/secret-sources)). The hosts file must not contain secrets ([docs](https://docs.termix.site/plugins/hosts-config)). Where secrets resolve isn't stated; it looks like the server (inference). | Same reference idea. Termix needs a 1Password Connect server or `bw serve` running beside the server. We use the user's own local vault session. No `pass` or KeePassXC. |
| What a host describes | SSH, with SFTP, tunnels and more through plugins. Per-service logins: not found. | We have per-service Logins. |
| Discovery and import | SSH config/JSON, cloud providers, Proxmox, Tailscale import ([repo](https://github.com/Termix-SSH/Termix)). No scan, no review state. | We have the review gate. |
| Keys | Key generation plugin, `ssh-copy-id`; certificates through Vault, step-ca, OPKSSH ([repo](https://github.com/Termix-SSH/Termix)). No per-device revocation found. | We have per-Box keys. |
| Automation and AI | AI assistant reads host "names, addresses and settings. Never passwords or keys", proposes changes for approval, permission-gated (`ai.ops.use`), can start Claude Code or Codex on a host ([AI](https://docs.termix.site/plugins/ai)). The page contradicts itself on whether it asks before changing things. | Equivalent promise. Ours is CLI-native and works with any agent on any Box, without a server. |
| Customizability | Web UI settings (details UNVERIFIED). | We are config-as-code. |
| Extensibility | About 50 plugins, in TypeScript ([repo](https://github.com/Termix-SSH/Termix)). | Similar breadth; different language and trust model. |
| Platforms | Web, desktop, iOS, Android. | Has mobile and web. |
| Licence and pricing | Apache-2.0; free. | — |

**Better than us:** already ships the git hosts file, password-manager references and an AI that never sees secrets, plus multi-user RBAC, an audit log, mobile and web.
**What we do that it doesn't:** no server to run; your own vault session (`bw`/`op`/`pass`/KeePassXC) on your machine; per-service Logins and `roster web`; review gate; per-Box keys; Inventory edits in the app with diff and Publish; a native terminal app built for the keyboard; Lua.

## Termius

**Positioning:** a polished cross-platform SSH client with its own end-to-end encrypted cloud vault, including mobile ([pricing](https://termius.com/pricing)).

| Dimension | Termius | vs roster |
|---|---|---|
| Inventory and sharing | Local vault (Starter); personal cloud vault (Pro); team vault (Team); several vaults with access control (Business). Synced through Termius Cloud ([pricing](https://termius.com/pricing), [encryption](https://docs.termius.com/security/encryption-overview.md)). No git, no file store. | Opposite model: a vendor cloud vs your git. |
| Secrets | Own end-to-end encrypted vault (X25519, XSalsa20-Poly1305, Argon2id) ([encryption](https://docs.termius.com/security/encryption-overview.md)). **No documented external password-manager integration** ([docs index](https://docs.termius.com/llms.txt)). | This is exactly what Q40 rejects. |
| What a host describes | SSH, Mosh, Telnet, serial, SFTP, local; port forwarding; AWS, DigitalOcean, Azure ([docs](https://docs.termius.com/llms.txt)). No RDP or VNC. | No per-service web/API Logins. |
| Discovery and import | `~/.ssh` (config, known_hosts, keys), CSV, PuTTY, MobaXterm, SecureCRT ([import](https://docs.termius.com/getting-started/import-existing-hosts.md)). | Better importers. No scan or gate. |
| Keys | Generates Ed25519, ECDSA, RSA and ML-DSA keys; FIDO2; hardware-bound keys (TPM, Secure Enclave); certificates ([keys](https://docs.termius.com/keychain/ssh-keys-and-certificates.md)). **SSH ID**: per-device keys published at `sshid.io/<handle>`; revoking one means logging out on that device ([SSH ID](https://docs.termius.com/ssh-id-passkeys-for-ssh/what-is-ssh-id.md)). | Their key UX is stronger. Our per-Box keys are tied to the Inventory and can be revoked one Box at a time. |
| Automation and AI | CLI archived 2025-03-23 ([repo](https://github.com/termius/termius-cli)). AI autocomplete on the free tier; "Gloria" agent in limited preview, "not yet integrated with Termius Vaults" ([blog](https://termius.com/blog/devops-ai-agent-gloria)). Whether the AI sees secrets: UNVERIFIED. | We are scriptable and agent-ready. |
| Customizability | GUI settings; editable shortcuts; splits up to 16 panes; focus mode; workspace templates ([workspaces](https://docs.termius.com/terminal/workspaces.md)). No config file; vim mode not found. | We are config-as-code; they have splits and workspaces now. |
| Extensibility | None found (snippets only). | — |
| Platforms | macOS, Windows, Linux, iOS, Android. | Has mobile. |
| Licence and pricing | Proprietary (inferred). Starter free; Pro $10/mo; Team $20/seat/mo; Business $30/seat/mo (annual billing) ([pricing](https://termius.com/pricing)). | — |

**Better than us:** polish, mobile, multiplayer session sharing, hardware-bound keys, importers.
**What we do that it doesn't:** use your password manager; git Inventory; per-service Logins; review gate; CLI and AI path; config-as-code and plugins.

## Devolutions Remote Desktop Manager

**Positioning:** "one application for every remote connection", a 150+ protocol enterprise workspace with credentials and auditing ([product](https://devolutions.net/remote-desktop-manager/)). Version 2026.3.

| Dimension | RDM | vs roster |
|---|---|---|
| Inventory and sharing | "Workspaces": local XML/SQLite, SQL Server/Azure SQL, Devolutions Server, Devolutions Cloud ([types](https://docs.devolutions.net/rdm/getting-started/workspaces/workspace-types)). Dropbox and OneDrive sources removed in 2026 ([notes](https://devolutions.net/remote-desktop-manager/release-notes/)). No git. | Database or server, against our git. |
| Secrets | Own vault with RBAC and audit (Team). **31 external password managers**, including 1Password, Bitwarden, KeePass, Keeper, LastPass, Passbolt, Proton Pass, HashiCorp Vault, CyberArk and Delinea; "RDM does not keep credentials in memory" ([integrations](https://docs.devolutions.net/rdm/concepts/intermediate-concepts/external-password-managers-integration/)). **Team edition only** ([Bitwarden](https://docs.devolutions.net/rdm/kb/how-to-articles/configure-bitwarden-entry)). Bitwarden uses an API client ID plus the master password; whether it uses `bw`: UNVERIFIED. | The broadest reference model, but paid and enterprise-shaped. No `pass`. |
| What a host describes | RDP, SSH, VNC, web, VPN, cloud consoles, k8s, hypervisors and more ([product](https://devolutions.net/remote-desktop-manager/)); credentials per entry. | Per-entry logins cover what our per-service Logins do. |
| Discovery and import | Many importers, CSV, Active Directory, network-scan import over an IP range, Lansweeper ([scan](https://docs.devolutions.net/rdm/ribbon-menu-bar/file/import/import-with-network-scan.md)). | No review gate. |
| Keys | SSH key agent (Pageant/OpenSSH), key generator, key entries with certificates, Bitwarden SSH-key sync ([agent](https://docs.devolutions.net/rdm/ribbon-menu-bar/tools/ssh-key-agent.md)). | No per-device keys. |
| Automation and AI | `Devolutions.PowerShell` module, cross-platform ([docs](https://docs.devolutions.net/powershell/remote-desktop-manager-powershell.md)). **MCP server and AI assistant (2026.1)**, multi-session requests with approvals (2026.2) ([2026.1](https://devolutions.net/blog/whats-new-in-devolutions-remote-desktop-manager-20261/), [2026.2](https://devolutions.net/blog/ai-assistant-in-remote-desktop-manager-20262/)). Vendor claim: credentials are injected so the model never sees them ([brief](https://devolutions.net/blog/ema-impact-brief-why-devolutions-rdm-mcp-server-sets-a-new-standard-for-secure-ai-automation/)). | Same promise, enterprise-packaged. |
| Customizability | GUI settings. Themes and keybindings: UNVERIFIED. | — |
| Extensibility | Extensions manager for add-ons (sessions, VPNs, browser) ([add-ons](https://docs.devolutions.net/rdm/concepts/basic-concepts/add-ons.md)). Public SDK: UNVERIFIED. | — |
| Platforms | Windows, macOS, Linux, iOS, Android. | — |
| Licence and pricing | Proprietary. Free edition for individuals, commercial use allowed. Team bundles $400/user/yr (RDM Team plus Server, Cloud, Gateway); Starter Pack (≤5 users) $325; Enterprise by quote ([pricing](https://devolutions.net/pricing/)). A Devolutions blog quotes $30/user/mo, which conflicts ([blog](https://devolutions.net/blog/rdp-management-showdown-2026-mremoteng-vs-devolutions-rdm/)). | — |

**Better than us:** every protocol, 31 password managers, audit and compliance, AI shipped, mobile.
**What we do that it doesn't:** free password-manager integration (theirs is Team only); `pass`; git Inventory with diff and Publish; review gate; per-Box keys; lightweight, keyboard-first; config-as-code.

## Royal TS / Royal TSX

**Positioning:** a multi-protocol connection manager built on shareable document files, so teams share connection lists without sharing personal credentials ([features](https://www.royalapps.com/ts/win/features)).

| Dimension | Royal TS/TSX | vs roster |
|---|---|---|
| Inventory and sharing | Encrypted `.rtsx` documents shared through a network share or cloud storage, with "no SQL back end"; Royal Server optional ([features](https://www.royalapps.com/ts/win/features), [docs](https://docs.royalapps.com/r2023/royalts/getting-started/documents-and-files.html)). Git possible as a file; diffability UNVERIFIED. | Closest "shared file" model among the older tools. Not readable text, and no review step. |
| Secrets | Own credential objects, referenced by link or name and inherited from folders; personal credentials in a separate document. **Dynamic Credential and Dynamic Folder scripts** (Bash, Python, PowerShell, …) fetch secrets when a connection opens ([dynamic folders](https://docs.royalapps.com/r2023/scripting/rjson/dynamic-folders.html)). The official toolbox has 1Password, **Bitwarden (calls `bw`)**, Keeper, Delinea, Passwordstate and others ([toolbox](https://github.com/royalapplications/toolbox/tree/master/Dynamic%20Folder)). KeePass import; LastPass as an external vault ([import](https://docs.royalapps.com/r2023/royalts/advanced/import.html)). | Its Bitwarden script works the same way roster does, but as a user-maintained script, not a core model. |
| What a host describes | RDP, SSH/Telnet, VNC, web, file transfer, TeamViewer, VMware/Hyper-V, PowerShell; per-connection credentials ([features](https://www.royalapps.com/ts/win/features)). V26 adds an SSH file browser, S3 and custom PTY ([blog](https://royalapps.com/blog/royal-ts-v26-whats-new-in-terminal-and-file-transfer-connections)). | Per-connection credentials cover our per-service idea. |
| Discovery and import | .rdp, CSV, mRemote, RDCMan, RDM, KeePass. Dynamic folders for AD, AWS, Azure, VMware and port scan ([toolbox](https://github.com/royalapplications/toolbox/tree/master/Dynamic%20Folder)). | No review gate. |
| Keys | Rebex or PuTTY terminal plugin. No built-in agent per staff posts (UNVERIFIED as current) ([community](https://community.royalapps.com/t/pageant-integration/794)). | — |
| Automation and AI | `RoyalDocument.PowerShell` edits documents without the app ([docs](https://docs.royalapps.com/r2023/scripting/document/cmdlet-reference/index.html)). AI only for icon generation (TSX 26 beta) ([blog](https://www.royalapps.com/blog/royal-tsx-v26---user-interface-improvements)). | — |
| Customizability | GUI settings. Terminal colour schemes and keymap editor: UNVERIFIED. | — |
| Extensibility | Plugins are built-in connection engines; "third-party plugins are not currently available" ([plugins](https://docs.royalapps.com/r2023/royalts/getting-started/plugins.html)). Scripts are the real extension point. | — |
| Platforms | Windows (TS), macOS (TSX). Royal Connect cross-platform rewrite (Avalonia, incl. Linux) announced and delayed; Android technical preview Aug 2026 ([licensing](https://www.royalapps.com/blog/licensing-and-versioning), [Android](https://blog.royalapps.com/blog/royal-connect-for-android-technical-preview)). | — |
| Licence and pricing | Proprietary; free Lite mode (10 connections). Buy page: Individual €49 (TS or TSX) ([buy](https://www.royalapps.com/ts/win/buy)). New model announced 2026-04-28, revised 2026-10-28: Desktop Individual €65/yr or €289 perpetual ([licensing](https://www.royalapps.com/blog/licensing-and-versioning)). The two sources currently disagree. | — |

**Better than us:** protocols; dynamic folders as a generic "any script returns an inventory" hook; credential inheritance.
**What we do that it doesn't:** readable git Inventory with Publish; review gate; password-manager references as the core model; Linux today; keyboard-first; Lua.

## Tabby

**Positioning:** "a terminal for a more modern age". A free, configurable terminal, SSH and serial client ([repo](https://github.com/Eugeny/tabby), v1.0.238, 2026-10-07).

| Dimension | Tabby | vs roster |
|---|---|---|
| Inventory and sharing | Profiles in local YAML config ([config.service.ts](https://github.com/Eugeny/tabby/blob/master/tabby-core/src/services/config.service.ts)). Config sync to Tabby Web through a REST API, encrypted ([configSync](https://github.com/Eugeny/tabby/blob/master/tabby-settings/src/services/configSync.service.ts)). No team model. | Personal only. |
| Secrets | Own vault (AES-256-CBC, PBKDF2) or the OS keychain ([vault.service.ts](https://github.com/Eugeny/tabby/blob/master/tabby-core/src/services/vault.service.ts)). Password managers only through community plugins (`tabby-keepass-ssh`, `tabby-vault-keepassxc`, agent-socket plugins) ([npm](https://registry.npmjs.org/-/v1/search?text=keywords:tabby-plugin)). | — |
| What a host describes | SSH2 (SFTP, X11, forwarding, jump hosts, Zmodem), Telnet, serial, local; RDP via a plugin ([repo](https://github.com/Eugeny/tabby)). | — |
| Discovery and import | `~/.ssh/config` importer ([sshImporters.ts](https://github.com/Eugeny/tabby/blob/master/tabby-electron/src/sshImporters.ts)). | — |
| Keys | Agent forwarding, Pageant and the Windows agent ([repo](https://github.com/Eugeny/tabby)). Key generation: UNVERIFIED. | — |
| Automation and AI | Core: `tabby://` URLs. Community MCP and AI plugins ([repo](https://github.com/Eugeny/tabby)). | — |
| Customizability | YAML config **plus** settings GUI; fully configurable hotkeys including multi-chord; themes; splits; Quake console ([repo](https://github.com/Eugeny/tabby)). Vim mode not found. | Closest "config file" UX among Electron terminals, but GUI-first. |
| Extensibility | npm packages tagged `tabby-plugin`, TypeScript/Angular `NgModule`s, about 186 on npm; installed in-app; **no sandbox** (full Electron/Node) ([HACKING.md](https://github.com/Eugeny/tabby/blob/master/HACKING.md)). Plugins can use the vault (v1.0.238) ([releases](https://github.com/Eugeny/tabby/releases)). | A plugin ecosystem that already exists. ADR 0006 rejected exactly this model (webview JS beside the password field). |
| Platforms | Windows, macOS, Linux; Tabby Web (self-hostable). | — |
| Licence and pricing | MIT; free. | — |

**Better than us:** an existing plugin ecosystem, splits, serial and SFTP, macOS.
**What we do that it doesn't:** team Inventory; password-manager Logins; review gate; secrets never in the UI process; plugins that can't see secrets; pinned Packages.

## Warp

**Positioning:** "an agentic development environment, born out of the terminal" ([repo](https://github.com/warpdotdev/warp)). Not a connection manager.

| Dimension | Warp | vs roster |
|---|---|---|
| Inventory and sharing | **No host inventory.** It wraps your own `ssh` command ([SSH](https://docs.warp.dev/terminal/warpify/ssh)). Warp Drive syncs workflows, notebooks, prompts and env vars to its cloud, with team permissions ([Drive](https://docs.warp.dev/knowledge-and-collaboration/warp-drive)). | Different category. |
| Secrets | Dynamic env vars from 1Password, LastPass or a custom command; "never stores secrets used in dynamic variables" ([env vars](https://docs.warp.dev/knowledge-and-collaboration/warp-drive/environment-variables)). Secret redaction is regex-based, off by default, best effort ([redaction](https://docs.warp.dev/privacy/secret-redaction)). | Agents see terminal context; we keep secrets structurally out of it. |
| What a host describes | Plain SSH, with an optional remote server installed on the host ([SSH](https://docs.warp.dev/terminal/warpify/ssh)). | — |
| Discovery and keys | None. | — |
| Automation and AI | Agents (Warp 2.0, Jun 2025), cloud agents (Oz, Feb 2026), MCP client, third-party CLI agents such as Claude Code ([changelog 2025](https://docs.warp.dev/changelog/2025/), [2026](https://docs.warp.dev/changelog/2026/)). | Far more AI, none of it inventory-aware. |
| Customizability | `settings.toml` (hot reload), YAML themes, `keybindings.yaml`, vim mode in the input editor ([settings](https://docs.warp.dev/terminal/settings/), [themes](https://docs.warp.dev/terminal/appearance/custom-themes/)). | Good reference for text config with live reload. Visual reference per Q27. |
| Extensibility | No plugin API found; extended through MCP, workflows, rules and skills. | — |
| Platforms | macOS, Linux, Windows. | — |
| Licence and pricing | Client open-sourced around 2026-04-28 under AGPL-3.0 (UI crates MIT) ([repo](https://github.com/warpdotdev/warp)). Free; Build $20/mo; Max $200/mo; Business $50/user/mo ([pricing](https://www.warp.dev/pricing)). | — |

**Better than us:** AI agents, input editor, polish.
**What we do that it doesn't:** everything about Hosts and Logins.

## Wave Terminal

**Positioning:** "open-source, AI-integrated terminal… No accounts required", with tiling blocks for terminals, files, web and AI ([repo](https://github.com/wavetermdev/waveterm)). Latest release v0.14.5, 2026-04-16; commits continue ([releases](https://github.com/wavetermdev/waveterm/releases)).

| Dimension | Wave | vs roster |
|---|---|---|
| Inventory and sharing | `~/.config/waveterm/connections.json` merged with `~/.ssh/config` ([connections](https://docs.waveterm.dev/connections)). No sharing. | — |
| Secrets | Own encrypted secret store, its key held in the OS keychain; `ssh:passwordsecretname` ([secrets](https://docs.waveterm.dev/secrets)). No password-manager integration. | — |
| What a host describes | SSH and WSL. Durable SSH sessions since v0.14.0 ([durable](https://docs.waveterm.dev/durable-sessions)). | Durable sessions are worth noting. |
| Discovery and keys | `~/.ssh/config`, WSL distros; identity files and agent options; no key management ([connections](https://docs.waveterm.dev/connections)). | — |
| Automation and AI | `wsh` CLI ([reference](https://docs.waveterm.dev/wsh-reference)). Wave AI reads scrollback and writes files with approval; bring your own key or local models ([Wave AI](https://docs.waveterm.dev/waveai)). | AI reads scrollback; there's no secret boundary. |
| Customizability | JSON files (`settings.json`, `termthemes.json`, `widgets.json`, …) plus a config GUI ([config](https://docs.waveterm.dev/config)). Fixed keybindings (only the global hotkey can be remapped) ([keybindings](https://docs.waveterm.dev/keybindings)). Live reload: UNVERIFIED. | — |
| Extensibility | "Custom widgets" are JSON block definitions, not code ([widgets](https://docs.waveterm.dev/customwidgets)). | — |
| Platforms, licence, price | macOS, Windows, Linux; Apache-2.0; free (default AI uses Wave's cloud credits) ([Wave AI](https://docs.waveterm.dev/waveai)). | — |

**Better than us:** blocks (web, files, AI next to terminals), durable sessions.
**What we do that it doesn't:** inventory, vault, team, rebindable keys, plugins.

## WezTerm

**Positioning:** a GPU-accelerated terminal and multiplexer **configured entirely in Lua**. It is the reference for ADR 0004 ([site](https://wezterm.org)). The last tagged stable release is 20240203; development ships as continuous nightlies, which the changelog calls "usually the best available version" ([changelog](https://wezterm.org/changelog.html)).

| Dimension | WezTerm | vs roster |
|---|---|---|
| Inventory and sharing | No inventory. `ssh_domains` in Lua, defaulting to entries derived from ssh config; `wezterm.enumerate_ssh_hosts()` lets Lua build domains from any file ([ssh_domains](https://wezterm.org/config/lua/config/ssh_domains.html), [enumerate](https://wezterm.org/config/lua/wezterm/enumerate_ssh_hosts.html)). | A user could hand-roll a roster.yml reader in Lua; we make it the product. |
| Secrets | None. `run_child_process` can call any CLI ([docs](https://wezterm.org/config/lua/wezterm/run_child_process.html)). | — |
| What a host describes | Local, SSH, SSH multiplexer domains, unix and TLS domains ([multiplexing](https://wezterm.org/multiplexing.html)). | Persistent remote mux is something we don't have. |
| Discovery and keys | Parses ssh config, including Include and most options ([ssh](https://wezterm.org/ssh.html)). No key management. | — |
| Automation | `wezterm.on` events ([on](https://wezterm.org/config/lua/wezterm/on.html)); `wezterm cli` (spawn, split-pane, send-text, get-text, list…) ([cli](https://wezterm.org/cli/cli/index.html)). No AI. | Its CLI drives the terminal itself; ours reads the Inventory (`--json`) and reaches Hosts, and the app has no outside API by design (Q110). |
| Customizability | `wezterm.lua`; `config_builder()` warns on unknown keys; automatic reload on save; leader key, modal `key_tables`, vim-like copy mode, workspaces, splits; **no settings GUI** ([files](https://wezterm.org/config/files.html), [builder](https://wezterm.org/config/lua/config/config_builder.html), [reload](https://wezterm.org/config/lua/config/automatically_reload_config.html), [key tables](https://wezterm.org/config/lua/config/key_tables.html)). | Same model as ADR 0004. |
| Extensibility | `wezterm.plugin.require('https://…')` clones the repo and **checks out the default branch**; "not automatically updated"; `update_all()` pulls everything; **no version pinning, no lock file, no sandbox** ([plugins](https://wezterm.org/config/plugins.html), [require](https://wezterm.org/config/lua/wezterm.plugin/require.html)). Index: [awesome-wezterm](https://github.com/michaelbrusegard/awesome-wezterm). | Our lock file and update diff (ADR 0006) fix exactly this gap. |
| Platforms, licence, price | Linux, macOS, Windows, FreeBSD, NetBSD; MIT; free. | — |

**Better than us:** a mature Lua API, multiplexing, CLI control, splits.
**What we do that it doesn't:** everything about Hosts and secrets; pinned plugins; an app UI (sidebar, Picker) as well as the terminal.

## SecureCRT

**Positioning:** "rock-solid terminal emulation for computing professionals". The skeleton we started from (vision.md) ([product](https://www.vandyke.com/products/securecrt/index.html)). Version 9.7.3, 2026-07-01.

| Dimension | SecureCRT | vs roster |
|---|---|---|
| Inventory and sharing | One `.ini` per session in `Config/Sessions/`, folders map to the tree ([scripting](https://vandyke.com/support/scripting/scripting-examples/interate-over-saved-sessions.html)). A personal data folder separates credentials so config can sit on a share ([features](https://vandyke.com/products/securecrt/features.html)). No team server. | Per-session ini files are git-friendly in principle, but there's no workflow for it. |
| Secrets | Built-in Credentials Manager (9.2+). No external password-manager integration ([features](https://vandyke.com/products/securecrt/features.html), [history](https://www.vandyke.com/products/securecrt/history.txt)). | — |
| What a host describes | SSH1/2, Telnet(/TLS), TN3270, RDP tabs (Windows), serial, local shell, SFTP tab ([features](https://vandyke.com/products/securecrt/features.html)). | — |
| Discovery and import | CSV wizard, XML import. | — |
| Keys | Key generation; Public Key Assistant uploads keys; built-in agent; forwarding; OpenSSH and X.509 certificates; PKCS#11, PIV/CAC ([features](https://vandyke.com/products/securecrt/features.html)). | Much stronger key tooling. |
| Automation and AI | Python 3, VBScript, JScript, Perl; script recorder; Command Manager. No AI ([features](https://vandyke.com/products/securecrt/features.html)). | — |
| Customizability | GUI over ini files; colour schemes including one that follows system light or dark; graphical keymap editor with shareable keymap files; button bars ([features](https://vandyke.com/products/securecrt/features.html)). | — |
| Extensibility | Scripts only. | — |
| Platforms | Windows, macOS, Linux; separate iOS app. | — |
| Licence and pricing | Proprietary perpetual licence. $119 with 1 year of updates, $190 with 3 years; bundled with SecureFX $129 ([pricing](https://www.vandyke.com/pricing/index.html)). | — |

**Better than us:** terminal emulation depth, keys and certificates, scripting, snapshots (saved workspaces, 9.7).
**What we do that it doesn't:** the vault, team Inventory, review gate, modern feel, config-as-code, plugins.

## MobaXterm

**Positioning:** an all-in-one Windows remote toolbox: X server, tabbed SSH, SFTP, RDP/VNC and Unix tools ([features](https://mobaxterm.mobatek.net/features.html)). Version 26.6, 2026-10-25.

| Dimension | MobaXterm | vs roster |
|---|---|---|
| Inventory and sharing | `MobaXterm.ini` ([config](https://blog.mobatek.net/post/mobaxterm-configuration-settings/)). "Share these sessions with my team" writes a `.mxtsessions` file to a share; protection is by folder ACLs ([shared sessions](https://blog.mobatek.net/post/configure-shared-sessions/)). | A shared file without review or history. |
| Secrets | Own vault with a master password; Windows Hello. No external password manager ([changelog](https://mobaxterm.mobatek.net/download-home-edition.html)). | — |
| What a host describes | SSH, Telnet, Rlogin, RDP, VNC, XDMCP, FTP, SFTP, serial, Mosh, WSL ([features](https://mobaxterm.mobatek.net/features.html)). | — |
| Discovery and import | PuTTY, mRemoteNG, SecureCRT, SuperPuTTY, RDM, CSV; port scanner ([changelog](https://mobaxterm.mobatek.net/download-home-edition.html)). | No gate. |
| Keys | MobaKeyGen, MobAgent, Windows agent, certificates, smart cards ([changelog](https://mobaxterm.mobatek.net/download-home-edition.html)). | — |
| Automation and AI | Macros, multi-exec, local Cygwin bash. No API, no AI. | — |
| Customizability | GUI plus .ini; light/dark; terminal themes. | — |
| Extensibility | "Plugins" are Unix tool bundles, not app extensions ([plugins](https://mobaxterm.mobatek.net/plugins.html)). | — |
| Platforms, licence, price | Windows only; proprietary; Home free (12 sessions); Pro $69 per user, lifetime with 12 months of updates ([download](https://mobaxterm.mobatek.net/download.html)). | — |

**Better than us:** X server, the toolbox, protocols.
**What we do that it doesn't:** cross-platform, password manager, git Inventory, review gate, config and plugins.

## Electerm

**Positioning:** an open-source terminal, SSH, SFTP, telnet, serial, RDP, VNC and FTP client on desktop and mobile ([repo](https://github.com/electerm/electerm), v5.7.21, 2026-10-27, releases weekly).

| Dimension | Electerm | vs roster |
|---|---|---|
| Inventory and sharing | Bookmarks in a local DB (SQLite or NeDB) ([db.js](https://github.com/electerm/electerm/blob/master/src/app/lib/db.js)). Sync to a GitHub or Gitee secret gist, WebDAV, a custom server or electerm cloud ([sync](https://github.com/electerm/electerm/wiki/Auto-data-Sync)). | Gist sync is git underneath, but not a reviewable team inventory. |
| Secrets | Own encryption through Electron `safeStorage` (falls back to plaintext if unavailable) ([safe-storage.js](https://github.com/electerm/electerm/blob/master/src/app/lib/safe-storage.js)). No password manager. | — |
| What a host describes | SSH, SFTP, FTP, Telnet, serial, RDP, VNC, Spice, local, web. | — |
| Discovery and keys | `~/.ssh/config`; keys as content or path; certificates ([wiki](https://github.com/electerm/electerm/wiki/SSH-Certificate-Authentication-Guide-for-electerm)). | — |
| Automation and AI | CLI and deep links; AI assistant (OpenAI or Anthropic formats); MCP widget exposing bookmarks over localhost, in development ([MCP](https://github.com/electerm/electerm/wiki/MCP-Widget-Usage-Guide)). | Its MCP exposes bookmarks without a secret boundary (UNVERIFIED whether it filters). |
| Customizability | GUI settings, themes, custom CSS, shortcut editor, workspaces. No config file, no vim mode. | — |
| Extensibility | User widgets: `package.json` folders, logic runs in the **main process with full Node privileges**, UI in a sandboxed iframe; "installing a widget is trusting its author" ([widgets](https://github.com/electerm/electerm/wiki/User-widget-guide)). | — |
| Platforms, licence, price | Windows, macOS, Linux, Android, iOS, HarmonyOS, web; MIT; free. | — |

**Better than us:** protocols, mobile, release pace.
**What we do that it doesn't:** password manager, team Inventory, review gate, secret boundary, pinned plugins.

## mRemoteNG

**Positioning:** an open-source, multi-protocol, tabbed connection manager for Windows ([repo](https://github.com/mRemoteNG/mRemoteNG)). The last stable release is 1.76.20 (2019); 1.78.2 ships as nightlies (latest 2026-10-02) ([releases](https://github.com/mRemoteNG/mRemoteNG/releases)).

| Dimension | mRemoteNG | vs roster |
|---|---|---|
| Inventory and sharing | `confCons.xml` tree with inheritance; optional SQL Server/MySQL/PostgreSQL (marked "early beta") ([SQL](https://mremoteng.readthedocs.io/en/latest/sql_configuration.html)). | — |
| Secrets | Own encryption ([security](https://mremoteng.readthedocs.io/en/latest/registry/security_settings.html)). **External credential connectors:** Delinea Secret Server, Passwordstate, **1Password via `op` with `op://vault/item`** ([credvault](https://mremoteng.readthedocs.io/en/latest/howtos/credvault.html)), OpenBao/Vault (1.78.2) ([CHANGELOG](https://github.com/mRemoteNG/mRemoteNG/blob/v1.78.2-dev/CHANGELOG.md)). No Bitwarden, KeePassXC or `pass`. | The same reference idea as our `op:` Logins, on Windows. |
| What a host describes | RDP, VNC, SSH, Telnet, HTTP(S), rlogin, raw, PowerShell, AnyDesk, ARD. | Separate entries per protocol, not per-service Logins on one Host. |
| Discovery and import | .rdp, RDCMan, PuTTY CM, SecureCRT, Royal TS, CSV/XML; AD OU import; **nmap port-scan import** ([import](https://mremoteng.readthedocs.io/en/latest/user_interface/import_export.html)). | Has scan import, but no review gate. |
| Keys | PuTTYNG; keys from vault connectors. | — |
| Automation | External tools with variables; command-line switches. No AI. | — |
| Customizability | GUI and registry; VS-style themes; fixed shortcuts ([shortcuts](https://mremoteng.readthedocs.io/en/latest/keyboard_shortcuts.html)). | — |
| Extensibility | New .NET DLL plugin model (`Plugins` folder; PortScan, AWS samples), no distribution or sandbox ([README.plugins](https://github.com/mRemoteNG/mRemoteNG/blob/v1.78.2-dev/README.plugins.md)). | — |
| Platforms, licence, price | Windows; GPL-2.0; free. | — |

**Better than us:** protocols, AD import, free 1Password and Delinea connectors.
**What we do that it doesn't:** cross-platform, Bitwarden, `pass` and KeePassXC, git Inventory, review gate, keyboard-first, stable releases.

## Ásbrú Connection Manager

**Positioning:** a Perl/GTK3 Linux connection organiser with automation, successor to PAC Manager ([repo](https://github.com/asbru-cm/asbru-cm)). Maintenance mode: v6.4.1 (2026-04-04) is packaging only; 6.4.0 was 2022-11 ([release](https://github.com/asbru-cm/asbru-cm/releases/tag/v6.4.1)).

| Dimension | Ásbrú | vs roster |
|---|---|---|
| Inventory and sharing | `~/.config/asbru/asbru.yml`; `--config-dir` "could be a shared directory"; `--readonly` ([CLI](https://docs.asbru-cm.net/Manual/CommandLine/)). | YAML, but secrets inside it are only encoded. |
| Secrets | "No real protection… simply encoded" ([notice](https://docs.asbru-cm.net/General/sensitive-info-notice/)). **KeePassXC through `keepassxc-cli`** (6.2+), with entries addressed by unique path; `<field\|/path/to/entry>` substitution in any field ([KeePassXC](https://docs.asbru-cm.net/Manual/Preferences/KeePassXC/), [substitutions](https://docs.asbru-cm.net/Manual/Substitutions/)). `<CMD:…>` runs any command. | **Prior art for Q41.** Its KeePassXC entries are addressed by path because the CLI can't search by UUID, which ticket 25 should note. |
| What a host describes | SSH, SFTP, mosh, telnet, FTP, RDP, VNC, 3270, serial, generic command ([methods](https://github.com/asbru-cm/asbru-cm/tree/master/lib/method)). | — |
| Discovery and import | PuTTY, SuperPuTTY, MCM converters ([utils](https://github.com/asbru-cm/asbru-cm/tree/master/utils)). ssh config import: not found. | — |
| Automation | Expect rules at login, macros, clusters, Perl scripts ([expect](https://docs.asbru-cm.net/Managing/Expect/)). | — |
| Customizability | GTK preferences, including keybindings ([keys](https://docs.asbru-cm.net/Manual/Preferences/KeyBindings/)). | — |
| Extensibility | None besides scripts. | — |
| Platforms, licence, price | Linux; GPL-3.0; free. | — |

**Better than us:** protocols, login automation, clusters.
**What we do that it doesn't:** everything team-related, Bitwarden and 1Password, secrets never at rest, active development.

## Remmina

**Positioning:** a Linux remote desktop client for RDP, VNC, SPICE, X2Go, SSH, WWW and EXEC ([repo](https://gitlab.com/Remmina/Remmina), v1.4.43, 2026-02-20).

| Dimension | Remmina | vs roster |
|---|---|---|
| Inventory and sharing | One `.remmina` INI file per profile in `~/.local/share/remmina` ([FAQ](https://remmina.org/faq/)). No sharing. | — |
| Secrets | 3DES-encrypted in files, or libsecret (GNOME Keyring) or KWallet through plugins ([FAQ](https://remmina.org/faq/)). No Bitwarden, 1Password or KeePassXC (except through Secret Service). | — |
| What a host describes | RDP (FreeRDP 2/3), VNC, SPICE, X2Go, SSH, SFTP, WWW, EXEC. | — |
| Discovery and keys | URIs and .rdp files; ssh-rsa option; smart cards for RDP ([releases](https://gitlab.com/Remmina/Remmina/-/releases)). | — |
| Automation | CLI (`--connect`, `--update-profile`, `--encrypt-password`). | — |
| Customizability | GUI preferences. | — |
| Extensibility | C plugins plus a Python plugin wrapper ([plugins](https://gitlab.com/Remmina/Remmina/-/tree/master/plugins)). | — |
| Platforms, licence, price | Linux (minimal macOS build in 1.4.43); GPLv2+; free. | — |

**Better than us:** graphical remote desktop on Linux.
**What we do that it doesn't:** almost everything else. Remmina is a different category: graphical sessions (RDP, VNC), where roster is SSH access to a team's Hosts.

## Adjacent tools

Not direct rivals, but each overlaps one differentiator.

| Tool | Overlap | Gap vs roster |
|---|---|---|
| **1Password SSH Bookmarks** (beta) | Attaches `ssh://` URLs to SSH Key items, opens them from a Bookmarks tab, and can generate `~/.ssh/1Password/config` that maps each host to its key ([docs](https://www.1password.dev/ssh/bookmarks/)). | One key per host, SSH only, personal or vault-scoped, no git, no web/API Logins. **The password-manager vendors are moving towards host lists.** |
| **1Password for Claude / for Agents** (Jul and Oct 2026) | The agent gets metadata and success/failure, never the secret ([press](https://1password.com/press/2026/july/1password-for-claude), [security](https://support.1password.com/1password-claude-security/), [blog](https://1password.com/blog/1password-for-ai-agents)). | Browser logins only, not SSH or terminals. |
| **Bitwarden SSH agent** | Keys in the vault, approval prompts ([help](https://bitwarden.com/help/ssh-agent/)). | No host mapping. |
| **Bitwarden Agent Access SDK** (alpha, 2026-03-24) | The agent requests a credential, a human approves, and `run` injects it into a child process ([blog](https://bitwarden.com/blog/introducing-agent-access-sdk/), [repo](https://github.com/bitwarden/agent-access)). | The same pattern as `roster run`, but Bitwarden-only with no inventory. A possible future provider for roster. |
| **KeePassXC** 2.8.0 SSH agent | Loads per-entry keys into the system agent on unlock ([docs](https://github.com/keepassxreboot/keepassxc/blob/develop/docs/topics/SSHAgent.adoc)). | Relevant to ticket 25: KeePassXC users may expect agent-based keys. |
| **Teleport Connect** | Desktop client over the cluster's resource inventory (SSH, DB, k8s, apps, RDP, MCP), with short-lived certificates ([docs](https://goteleport.com/docs/connect-your-client/teleport-clients/teleport-connect/)). | Needs a cluster. No password-manager references. Community Edition binaries are commercial-licensed, free only for orgs under 100 employees and under $10M revenue ([discussion](https://github.com/gravitational/teleport/discussions/39158)). |
| **Apache Guacamole** 1.6 | Connection fields hold `keeper://` references resolved at connect time ([vault](https://guacamole.apache.org/doc/gug/vault.html)). | Keeper only; web gateway. |
| **Warpgate**, **Boundary**, **StrongDM** (now Delinea) | Bastions or brokers that inject credentials ([Warpgate](https://github.com/warp-tech/warpgate), [Boundary](https://developer.hashicorp.com/boundary/docs/api-clients/desktop)). | Server products. The bastion owns the secrets. |
| **assh**, **sshs**, **sshclick** | YAML or ssh-config host pickers ([assh](https://github.com/moul/assh), [sshs](https://github.com/quantumsheep/sshs)). | No secrets, no team. |
| **SSH MCP servers** | [tufantunc/ssh-mcp](https://github.com/tufantunc/ssh-mcp) (TOML profiles, agent or keychain credentials); [jgauffin/ssh-mcp](https://github.com/jgauffin/ssh-mcp) (host enum built from config). | Small, single-user, no git inventory or `bw`/`op`/`pass` references. |

---

## Customizability and extensibility

### How each tool is configured

| Tool | Config | Live reload | Keymap | Vim | Layout control | Settings GUI |
|---|---|---|---|---|---|---|
| **roster** | `init.lua` (Lua 5.4) | ✓ (last good Config kept) | ✓ leader + data table | ✓ app-wide | ✓ per-mode layout tables (Q39) | ✗ by design |
| WezTerm | `wezterm.lua` | ✓ | ✓ leader + `key_tables` | copy mode | splits, workspaces | ✗ |
| Warp | `settings.toml`, YAML themes, `keybindings.yaml` | ✓ | ✓ | input editor | splits, tabs | ✓ |
| Tabby | YAML | UNVERIFIED | ✓ multi-chord | ✗ | splits | ✓ |
| Wave | JSON files | partly | ✗ (global hotkey only) | block navigation | tiling blocks | ✓ |
| Termius | GUI | — | ✓ | ✗ | splits up to 16 panes, workspace templates | ✓ |
| SecureCRT | GUI over .ini | — | ✓ keymap files | ✗ | tabs, tiles, button bars | ✓ |
| XPipe, RDM, Royal TS, MobaXterm, Electerm, mRemoteNG, Ásbrú, Remmina | GUI (some back it with ini, XML or YAML) | — | partial or fixed | ✗ | docking or tabs | ✓ |

### How each tool is extended

| Tool | Language | What a plugin can do | Distribution | Pinning | Sandbox / secret boundary |
|---|---|---|---|---|---|
| **roster** (ADR 0006) | Lua, same runtime as the Config | Commands, keys, themes, Sidebar sections, finders, status segments, views (tables, graphs), Host-details and `:check` sections, its own data folder, HTTP to listed sites, event hooks | git repos listed in `init.lua` | ✓ `roster.lock`, update shows a diff | Runs in the core, which has no secrets; writes become Pending changes only; no HTML/JS in v1 |
| WezTerm | Lua | Anything the config can do | `plugin.require(git URL)` | ✗ default branch, `update_all()` | ✗ |
| Tabby | TypeScript/Angular | Providers for profiles, tabs, settings, themes, hotkeys | npm `tabby-plugin` (~186), in-app manager | npm semver | ✗ full Electron/Node |
| Termix | TypeScript | Hosts config, secret sources, AI, certificates (~50) | built-in plugin catalogue | UNVERIFIED | Server-side; permission-gated |
| Electerm | JS widgets | Main-process logic + iframe UI | copied folder | ✗ | UI in an iframe; logic has full Node |
| mRemoteNG | .NET DLL | Connectors, tools | drop into `Plugins` | ✗ | ✗ |
| Remmina | C, Python | Protocols, secret backends | distro packages | distro | ✗ |
| Wave | JSON | Block definitions (no code) | file | — | n/a |
| Royal TS | Any script (Dynamic Folders/Credentials) | Return connections or credentials as JSON | toolbox repo, copy-paste | ✗ | ✗ |
| SecureCRT | Python, VBScript… | Session scripting | files | ✗ | ✗ |
| Warp | MCP, workflows, rules | Agent tools | Drive / MCP | — | — |
| XPipe, Termius, MobaXterm, Ásbrú | none (scripts or macros only) | — | — | — | — |

### What to copy, and what to avoid

Consistent with ADR 0004 and ADR 0006. Items marked *proposal* are new and not decided.

**Copy**
- WezTerm's `config_builder()`: **warn on unknown keys**. architecture.md already checks the result against a schema; make the error name the bad key.
- WezTerm's `add_to_config_reload_watch_list`: when `init.lua` `require`s other files, reload on those too. *Proposal.*
- Termix's Hosts Config reload rules: validate the whole file, keep the last good load, warn on plain-text secrets. We already do the first two for `init.lua`. *Proposal:* have roster refuse a literal password in `roster.yml`, if it doesn't already.
- Tabby's in-app list of installed plugins: a read-only `:packages` view of what's loaded, its pinned commit and its source. That is not a Settings screen, so it fits Q24. *Proposal.*
- Warp's separate `keybindings.yaml` idea: we have one file, but the Key bindings panel (`␣ ?`) showing where each binding comes from already covers the discoverability side.

**Avoid**
- WezTerm's unpinned default-branch plugins. Keep the lock file and the update diff.
- Tabby's and Electerm's full-privilege JS plugins in the UI process. ADR 0006 already rejects this, and the survey supports that.
- A Settings GUI next to the file (Tabby, Warp, Wave). Q24 holds. Two sources of truth is the usual complaint.
- Vendor-cloud config sync (Termius, Warp Drive, Tabby Web, electerm cloud). Q42 covers this: git dotfiles.

## Secrets model

| Model | Who | Notes |
|---|---|---|
| **Own vault only** | Termius, Tabby (vault or keychain), Wave, Electerm, SecureCRT, MobaXterm, Remmina (file or keyring), Nexterm | The app owns encryption, recovery and sync. Q40 rejects this. |
| **Own vault plus password-manager integration** | Devolutions RDM (31 managers, Team only), XPipe (15, via CLI), Royal TS (scripts), mRemoteNG (1Password, Delinea, Passwordstate, OpenBao), Termix (op, bw, bws, vault, infisical; server-side), Ásbrú (KeePassXC) | The common pattern today. Most of these still keep a vault as the default. |
| **References only, no vault at all** | **roster** (bw, op, pass, KeePassXC, env, command) | Only roster. XPipe comes closest: it can run vault-less, but always has its own encrypted store. |
| **No stored secrets (certificates or identity)** | Teleport, Tailscale SSH, Pomerium | No password manager needed, but you have to run their infrastructure. Doesn't cover password-only network gear, which is a core roster case. |
| **None** | WezTerm, Warp (env vars from 1Password or LastPass only) | — |

Three things set our model apart from the integrations above:
1. **Resolved in the user's own session, on their machine.** RDM uses API keys, Termix uses a server-side Connect or `bw serve`, and XPipe uses the CLI as we do.
2. **The UI process never holds a secret** (askpass socket, one-time token). No other tool states this boundary for its UI. RDM, Termix and Teleport state it only for the AI.
3. **Local-only users get `pass` and KeePassXC, not our vault.** XPipe has KeePassXC (browser protocol) but not `pass`; Ásbrú has KeePassXC (`keepassxc-cli`). Nobody else covers both.

## Positioning

**Who it's for:** people who run a mixed network as a small team, with a shared password manager and a git repo they already trust. They work from a terminal, often with password-only gear (switches, ESXi, appliances), and increasingly alongside an AI agent. It's not aimed at people who want RDP or VNC, a mobile app, or an enterprise PAM.

**Differentiators to protect**, ordered by how rare they turned out to be:
1. **Review gate on discovered Hosts.** Not found anywhere else.
2. **Per-service Logins on one Host, plus `roster web`.** Only RDM and Royal TS, with separate entries, come close; nobody does authenticated API calls.
3. **Per-Box keys with revoke.** Termius SSH ID comes nearest, but revoking there means logging out.
4. **Readable Inventory in git, with diff and Publish from the app.** XPipe's repo is encrypted; Termix's file is edited outside the app.
5. **No vault of our own, and secrets never in the UI.** Password-manager references resolved locally, with `pass` and KeePassXC covered.
6. **Config and Packages as code, pinned.** Lua with a lock file; nobody else combines a connection manager with this.

"Claude uses it without seeing secrets" is **no longer unique** (RDM, Termix, Teleport). Keep it, but present it as "works with any agent through plain `ssh`, `roster run` and `roster web`, with no server or MCP gateway". Don't lead with it.

**Gaps to close later** (all proposals; the roadmap already lists several as "later"):
- SSH config import into the Inventory. Every rival has one; it would be a natural `roster discover` source. *Proposal.*
- macOS. XPipe, Termius, Tabby and WezTerm all have it; it's already on the "later" list.
- SFTP and port forwarding: on the "later" list, and table stakes in Termius, Tabby, XPipe and Electerm.
- Split panes: Q36 keeps them out of scope. Termius, Tabby, WezTerm and XPipe have them. Revisit only if the Focus-mode buffer finder isn't enough.
- More providers. XPipe's list shows demand for Keeper, Proton Pass and HashiCorp Vault. The `command` provider already covers them roughly.
- SSH certificates (XPipe Pro, SecureCRT, Teleport), hardware keys and FIDO2. *Proposal:* only if a team asks.

**Deliberately not chasing** (from the docs):
- A built-in vault or vendor cloud sync (Q40, Q42).
- A Settings screen (Q24).
- Plugin HTML/JS panels in v1, and JS or webview plugins in general (ADR 0006).
- RDP, VNC and the protocol zoo (RDM, Royal TS, MobaXterm, Remmina). Out of scope by Q3; no decision says otherwise.
- Mobile and a web/server edition (Termius, Termix). Nothing in the docs plans them.
- Generic AI agent features inside the terminal (Warp, Wave). The agent uses roster from outside.

## Not verified

- **XPipe:** whether prices are per user; CLI page (404); on-disk vault format; config file or keybindings; whether MCP can pass secrets to the model.
- **Termix:** where Secret Sources resolve (server inferred); plugin pinning; UI customisation; an inconsistency in the AI doc on approval.
- **Termius:** monthly billing prices; licence text; whether the AI sees secrets; vim mode.
- **RDM:** whether Bitwarden integration uses `bw`; themes and keybindings; plugin SDK; full import list; the $400/yr vs $30/mo price conflict.
- **Royal TS:** `.rtsx` diffability; keys and certificates; keymap editor; which licensing model is in force (buy page vs 2026 blog); Royal Connect Desktop release date.
- **Tabby:** key generation; hosted Tabby Web pricing; YAML live reload.
- **Warp:** whether Oz and the backend remain closed (press only).
- **Wave:** live-reload semantics.
- **WezTerm:** serial support; when it moved to the `wezterm` org.
- **Electerm:** cloud sync pricing; importers from other tools; whether its MCP filters secrets.
- **MobaXterm:** whether Home may be used commercially; whether shared sessions are Pro-only.
- **SecureCRT:** a supported shared-config setup.
- **Ásbrú and Remmina:** SSH identity and agent options. **Ásbrú:** ssh config import.
- **Adjacent:** when Bitwarden's SSH agent first shipped; StrongDM details after the Delinea deal; Teleport prices; KeePassXC remove-on-lock options (third-party guides only).
