# Vault sign-in: what each provider's CLI can do

Research for ticket 31 (decision Q52), done on 2026-10-30. Every row below is checked against the provider's official documentation, and for Bitwarden also against the installed CLI's own code. Where a source doesn't say, the row says so instead of guessing.

**Installed on the dev Box (WSL, Fedora):**
- `bw` **2026.9.1**: the standalone build in `~/.local/bin/bw`, a packaged Node app. Its JavaScript is embedded in the binary, so `strings` shows the real `login.command.ts` logic. That's the "CLI source" cited below.
- `op`: **not installed**.
- `keepassxc-cli`: **not installed**. Ticket 25 checked the provider against keepassxc-cli 2.8.0 (Fedora 44's package, unpacked into a scratch folder, on a throwaway `.kdbx`).

Nothing here ran `bw login`, `bw logout` or `bw config server URL`. The only commands used were `--help`, `bw status` and `strings`.

## The matrix

✅ means the CLI does it without a terminal, so roster can drive it. ⚠️ means the CLI does it but only with a prompt on a terminal, so roster drives it through a PTY. ❌ means the CLI can't do it.

| Provider | Method | Supported by its CLI | How roster drives it | Source |
|---|---|---|---|---|
| Bitwarden `bw` | Email + master password | ✅ `bw login [email] [password]`, `--passwordenv VAR`, `--passwordfile F` | Password in `ROSTER_BW_MASTER` through `--passwordenv`. The email is typed at bw's `Email address:` prompt, so it's not in argv either | [B1], `bw login --help`, CLI source |
| | Two-step: Authenticator (TOTP) | ✅ `--method 0 --code N` | Code typed at bw's `Two-step login code:` prompt (never `--code`) | [B1] (method 0), CLI source |
| | Two-step: Email | ✅ `--method 1`. The CLI asks the server to send the email when no `--code` is given | Same prompt; bw sends the email itself when Email is picked | [B1] (method 1), CLI source (`postTwoFactorEmail`) |
| | Two-step: YubiKey OTP | ✅ `--method 3` (a touch types the OTP) | Same prompt | [B1] (method 3), CLI source |
| | Two-step: FIDO2 / WebAuthn | ❌ "not supported by the CLI" | Clean message (code 51): use the API key, or add an authenticator app, email or YubiKey OTP as a second method in the web vault | [B1]; CLI source: `supportsWebAuthn()` returns `false` |
| | Two-step: Duo (personal or org) | ❌ "not supported by the CLI" | Same message (51) | [B1]; CLI source: `supportsDuo()` returns `false` |
| | Several methods on the account | ⚠️ Interactive: a list prompt `Two-step login method:`. With `--nointeraction` and no `--method` it fails with `Login failed. No provider selected.` | Read the list from the PTY and offer it as a picker. Select with arrow keys + Enter. A retry uses `--method N` | CLI source |
| | Only unsupported methods | ❌ `No providers available for this client.` | 51 | CLI source |
| | New-device verification (email OTP) | ⚠️ **Only interactively**: `New device verification required. Enter OTP sent to login email:`. There's no flag for it; with `--nointeraction` it fails `Code is required.` | Typed at that prompt through the PTY | [B2] (who gets it), CLI source |
| | API key (`--apikey`) | ✅ `BW_CLIENTID` / `BW_CLIENTSECRET` env vars; personal keys only ("Organization API Key currently not supported") | Env vars, `--nointeraction`. It logs in only, so the vault still needs `bw unlock` with the master password | [B1], CLI source |
| | SSO (`--sso [org-identifier]`) | ⚠️ Interactive only: in `--nointeraction` mode `--sso` is ignored and the login falls through to "Email address is required." It serves a callback on `localhost:8065-8070` and opens the browser; on Linux that's `spawnSync("xdg-open", [url])`, and the URL is never printed | A private `xdg-open` shim on bw's PATH hands the URL to roster, which returns it to the app to open. Then wait (timeout), then unlock with the master password | [B1], CLI source (`openSsoPrompt`, `launchUri`) |
| | SSO with trusted-device encryption or PRF passkey decryption | ❌ "The CLI does not support SSO login for accounts using trusted device encryption." (same for PRF) | 51, with bw's sentence | CLI source |
| | Self-hosted / EU server | ✅ `bw config server URL`, only while logged out ("Logout required before server config update."). EU is `https://vault.bitwarden.eu`; `bitwarden.com` resets to US cloud. `bw config server` with no value prints the current one | `bw config server` before the login, only when it differs from `bw status`'s `serverUrl` | [B1], `bw config --help`, CLI source (`getOrSetServer`) |
| | Unlock with PIN or biometrics | ❌ `bw unlock` takes only the password (argument, `--passwordenv`, `--passwordfile`) | The everyday unlock stays one master-password field | `bw unlock --help`, [B1] |
| 1Password `op` | Desktop app integration (Windows Hello, Touch ID, Linux system auth) | ✅ but the app does the sign-in. "Authenticate 1Password CLI the same way you unlock your device." The second factor is the app's job | Not driven by roster. Clean message (13): turn on the app integration | [O2] |
| | Manual `op account add` / `op signin` (password, Secret Key) | ⚠️ Interactive prompts. The docs don't describe a non-interactive password, and say "For non-interactive shells in local environments, sign in with the 1Password desktop app integration instead." Sessions expire after 30 minutes idle | Not driven (13, same message) | [O1] |
| | Two-step on manual sign-in | Not documented on the CLI pages. Community reports "MFA Type Not Supported" for security keys (not official, so not relied on) | n/a | [O1], [O4] (unofficial) |
| | Service account (`OP_SERVICE_ACCOUNT_TOKEN`) | ✅ Env var, no sign-in or 2FA. Only vaults granted to the account | Already supported by roster's `op` provider (it's an env var on the Box, not a lock-screen sign-in) | [O3] |
| KeePassXC `keepassxc-cli` | Master password | ✅ Reads the database password as the first line of stdin (prompt on stderr); `add -p` reads the entry's password as the next line. `-q` silences the prompt *and* the unlock errors (a wrong password becomes a bare exit 1), so roster doesn't use it | Ticket 25: the `kp` provider (verified with 2.8.0) | [K1] |
| | Key file | ✅ `-k, --key-file <path>` | Ticket 25 | [K1] |
| | YubiKey challenge-response | ✅ `-y, --yubikey <slot[:serial]>` (touch on the key) | Ticket 25 | [K1] |
| | No password (key file only) | ✅ `--no-password` | Ticket 25 | [K1] |
| | Quick Unlock / Windows Hello | ❌ Not in the CLI man page (it's a GUI feature) | n/a | [K1] |
| | "Login" | n/a: a local file has no account or server. Opening it is the unlock | n/a | [K1] |

## What this means for `vault.login`

1. **The `bw` CLI is one-shot, and new-device verification can't be done without a prompt.** `bw login` has no flag for the new-device OTP. In `--nointeraction` mode it fails with `Code is required.`, and the half-done login dies with the process. So roster runs `bw login` (password and SSO flows) **on a PTY** (on native Windows a pseudoconsole, ConPTY: `roster/conpty.py`, ticket 63) and answers bw's own prompts one step at a time. The process stays alive between `vault.login` calls. `canInteract` in the CLI is only `BW_NOINTERACTION !== "true"`; prompts are inquirer prompts on stderr.
2. **Secrets never go in argv.** The master password goes through `--passwordenv`. The email, two-step code and new-device code are typed at bw's prompts. The API key goes through `BW_CLIENTID`/`BW_CLIENTSECRET`, as documented. `--code` and the positional `[password]` are never used.
3. **A wrong code ends the bw process** (the CLI doesn't re-prompt). roster keeps the master password in memory for the sign-in's lifetime only (at most 10 minutes idle, or until done, cancelled or `vault.lock`). It restarts `bw login --method N` itself, so the person only re-types the code. For Email and new-device, that sends a fresh code.
4. **The server can't say "expired" apart from "wrong"** in a way the CLI exposes. A rejected code is one code (50), worded "wrong or expired".
5. **API key and SSO only log in.** The vault then needs the master password (`bw unlock`) unless the account uses Key Connector, so both flows end with a master-password step.
6. **Unsupported methods** are FIDO2/WebAuthn and Duo (the CLI filters them out), SSO with trusted-device or PRF decryption, and organization API keys. The message names the way out: the API key (which skips two-step login, [B1]), or adding a supported second method in the web vault.
7. **1Password** sign-in belongs to the desktop app (biometrics) or a service-account token. roster doesn't type 1Password credentials. `vault.login` answers 13 with that advice. **KeePassXC** has no login, only an unlock (ticket 25): `vault.login` answers 13.

## Creating items (ticket 13)

Checked against `bw` 2026.9.1 (`bw create --help`, `bw delete --help`, `bw encode --help`, and the embedded `create.command.ts`, `delete.command.ts`, `cipher.export.ts` and `login.export.ts`):

- `bw create item [encodedJson]`: when the argument is missing, the CLI reads stdin (`CliUtils.readStdin`, unless `BW_SERVE`), base64-decodes it and parses the JSON. So roster base64-encodes the item itself (that's all `bw encode` does) and pipes it in. The password is never on a command line. A bad payload gives `Error parsing the encoded request data.`
- The JSON is the export shape (`bw get template item` with `login` from `bw get template item.login`): `type: 1` (login), `name`, `login: {username, password, uris: [{uri, match}]}`. roster builds it directly instead of running `bw get template`. On success bw prints the new item, decrypted, password included. roster reads only its `id`.
- `bw delete item ID` soft-deletes it to the trash; `--permanent` would skip the trash. roster's undo uses the soft delete. The CLI also checks that the user may delete the item, and that no organization policy restricts its type.
- `bw list items --search NAME` is a substring search, so the duplicate check filters it to the exact name, after a `bw sync`.

## Sources

- [B1] Bitwarden, *Password Manager CLI*: https://bitwarden.com/help/cli/ (log in, two-step `--method` values 0/1/3, "FIDO2 and Duo are not supported by the CLI", `--apikey` and `BW_CLIENTID`/`BW_CLIENTSECRET`, `--sso`, `bw config server`, `https://vault.bitwarden.eu`, `--passwordenv`, `--nointeraction`).
- [B2] Bitwarden, *New Device Login Protection*: https://bitwarden.com/help/new-device-verification/ (an email OTP; excluded: accounts with two-step login, SSO, passkey or API-key logins, self-hosted, known devices, accounts younger than 24 h, and opt-outs).
- `bw` 2026.9.1 itself: `bw login --help`, `bw config --help`, `bw unlock --help`, and the embedded `login.command.ts`, `config.command.ts`, `default-two-factor.service.ts` and `cli-platform-utils.service.ts`, read with `strings`.
- [O1] 1Password, *Sign in to 1Password CLI manually*: https://www.1password.dev/cli/sign-in-manually/
- [O2] 1Password, *Integrate 1Password CLI with the 1Password desktop app*: https://www.1password.dev/cli/app-integration/
- [O3] 1Password, *Use service accounts with 1Password CLI*: https://www.1password.dev/service-accounts/use-with-1password-cli/
- [O4] Unofficial, for context only: 1Password Community, *headless linux cli unable to login*: https://www.1password.community/developers-69/headless-linux-cli-unable-to-login-12709
- [K1] KeePassXC, `keepassxc-cli(1)` man page: https://raw.githubusercontent.com/keepassxreboot/keepassxc/develop/docs/man/keepassxc-cli.1.adoc
