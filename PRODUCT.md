# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The roster app is a Tauri desktop app (Windows and Linux shipped; macOS builds but isn't tested day to day) whose UI is a React webview. Its design language is web, not native platform chrome. The minimum window is 480 × 320.

## Users

Sysadmins, network engineers and homelabbers who reach many machines every day: servers, hypervisors, switches, appliances, lab boxes. They work solo or in a team that shares one Inventory (`roster.yml`) and one password manager. They live in terminals, often on Windows with WSL or on Linux, and many are keyboard-first power users (Neovim, tmux).

Their job is to get a shell, or the right web UI, on the right Host fast, logged in with the right credential, and then get on with the actual work.

The first-impression audiences that matter most:

- **Teammates on day 1**, deciding whether to switch from their current SSH client.
- **Power users**, who notice density, keys, speed and configurability.
- **GitHub visitors**, judging from the README screenshots and the docs site before installing.

## Product Purpose

roster keeps a team's knowledge of its network in one reviewed file: every Host, how to reach it, and which vault item opens which service. The app's whole job is to get you onto a Host quickly and securely, then get out of the way.

Success means a Host is found in a few keystrokes and you're in a shell over your own `ssh`, with the password fetched from the vault and never shown. It also means the Inventory stays shared, current and trusted.

## Positioning

**"Your password manager knows the secrets. roster knows your network."** roster is the network-knowledge layer over the vault you already use (Bitwarden, 1Password, `pass`, KeePassXC). It doesn't replace that vault.

Protected differentiators (`docs/app/vision.md`):

1. A team Inventory in git: one `roster.yml`, changes Published, not copied around.
2. Per-service Logins: one Host can have different vault items for SSH, its web UI and its API.
3. A review gate: discovered Hosts aren't connectable until a person marks them reviewed.
4. Secrets never reach the UI: from the vault, through roster, into `ssh`, and nothing else.
5. "Save to vault" on first login turns a password login into a named Vault item plus a Host.
6. The same model an AI agent uses, without it ever seeing secrets; `--json` for other tools.
7. It knows your network: the Mesh, Topology and Discover, behind the review gate.

The reference points are SecureCRT for the skeleton (saved Hosts, tabs, logging in for you) and Termius, XPipe and Termix as neighbours (`docs/app/competitors.md`). roster is not modelled on any of them for look or workflow.

## Operating Context

- Daily, all-day use alongside other terminals and editors. Sessions are long-lived and many are open at once.
- One repo with two halves: the Python CLI (`roster`) and the app. The app reaches roster only through `roster serve` (ADR 0001), and on Windows it finds a roster installed in WSL.
- Configuration is code: `init.lua` plus pinned Packages and Plugins (ADR 0004, ADR 0006). `:help` documents every option, command and error, modelled on Neovim's docs.
- Onboarding is `:tutor` (lessons on a demo Inventory) and keycap hints, not tours.
- Fixtures for every state run in a plain browser through the fake Backend (`app/README.md`, "UI in a plain browser"), including worst-case data (1,284 Hosts, 50 Sessions, long and non-Latin names).

## Capabilities and Constraints

- Core flows: unlock the vault, find a Host (Picker, Sidebar, Quick Connect `user@address`), connect, run many Sessions, edit, add and review Hosts, Publish Pending changes, see Host details and services, `:check` health, the Mesh, Topology and Discover, and Plugins (sections, finders, views and graphs).
- **Hard security lines:** secrets never reach the frontend, the webview, logs, `:messages` or Plugins (`docs/app/security.md`, with one narrow exception in decision Q129). Inventory changes from Plugins only become Pending changes.
- Minimal core plus optional first-party Plugins (Q80). Every built-in feature registers through the same registries Plugins use.
- **The repo is public:** never show real host names, networks, companies or secrets in screenshots, fixtures or docs.
- Terminology is fixed in `GLOSSARY.md` (Host, Session, Box, Inventory, Login, Vault item, Pending changes, Picker, Sidebar, Leader, …).
- Settled decisions live in `docs/app/decisions.md` and `docs/adr/`. Don't reopen them without the owner.

## Brand Commitments

- Name: **roster**, lowercase in running text.
- Mark: the **Gap orbit** logo (Q57), with assets in `app/assets/`.
- Identity, voice and taste: `docs/app/design/taste.md` is binding and wins over outside references, except on accessibility. The voice is honest and plain: say what happened, where it lives and the one thing to do next. No exclamation marks, no "Oops", no blame, no emoji in our own copy.
- Licence: GPL-3.0-or-later. A personal-first open-source tool: choose what feels best to use every day over what would sell.

## Evidence on Hand

- Real app screenshots: `docs/images/app-{dark,light}.webp`, `keys-*.webp`, `lock-*.webp` (made from the fake Backend). Theme screenshots are listed in `docs/app/themes.md`.
- The docs website and PDF, generated from the same `:help` source (`app/src/docs-site/`).
- Prior design reviews: `docs/app/design/interface-review.md` (ticket 29, 26 fixes) and the break-ui worst-case work.
- **None of these exist, so never fabricate them:** testimonials, user counts, customer logos, benchmarks against competitors, press.

## Product Principles

1. **Access first.** Every screen serves reaching a Host or using a Session. Anything else is quiet or one key away.
2. **Secure by construction, visibly.** The UI shows *where* a secret lives (the vault, this Box) and never the secret.
3. **Keyboard first, mouse welcome.** Every action has a key, and the keys are discoverable where you need them.
4. **Yours to shape.** Opinionated defaults that `init.lua`, Themes and Plugins can change. Always say where a setting comes from.
5. **Honest under failure.** Errors sit where the problem is, with a clear fix and the raw details one key away.

## Accessibility & Inclusion

- WCAG 2.2 AA: text contrast is measured for every bundled Theme (`app/src/theme/contrast.test.ts`).
- State is never carried by colour alone (node shapes plus words, Q53). The Sidebar cursor is exposed to assistive tech.
- Full keyboard operation. Motion is off under `prefers-reduced-motion`, and the lock cover is instant.
- Long, unbreakable, non-Latin and emoji Host names render without breaking the layout.
