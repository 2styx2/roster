# `roster mcp`: a stdio MCP server over the CLI's read commands, with actions granted per client

_Status: **Proposed.** A draft from the design spike T103 (issue #181), for the owner's design session. Nothing here is decided: no decision row exists yet, and the build tickets are filed only after that session. The research it rests on is in the [appendix](#appendix-research-notes) (read 2026-11-05)._

roster already lets Claude work on the network without seeing a secret: `ROSTER.md` is its map, `roster run` and `roster web` log in for it, and `--json` gives it roster's data ([How Claude uses it](../cli-reference.md#how-claude-uses-it)). That needs a shell. An AI app that has no shell (Claude Desktop, other MCP clients) can't use any of it. `roster mcp` would give those apps the same reads, and later the same two actions, through the Model Context Protocol (MCP), with **no new door to a secret**.

The proposal, in short:

- `roster mcp` is a **stdio** MCP server that the AI app starts as a child process. It speaks to nobody else: no port, no socket.
- **v1 is read-only**: six tools that return exactly the documents `--json` prints (`hosts`, `host`, `resources`, `check`, `check_host`, `mesh_status`).
- **Actions** (`run`, `web`) come later, off by default, granted **per client profile and per Host** in a file of this Box's own, `~/.config/roster/mcp.yml`, each one `allow` or `ask`.
- A **client profile** is a name the person writes into the app's MCP config (`roster mcp --client desktop`). Over stdio nothing can prove which app is calling, so the profile is a label the person chose, not an identity; `clientInfo` is only logged.
- **Every tool call is logged**, one JSON line each, with the `--json` redaction.
- It's built on the **official `mcp` Python SDK (2.x)**, as an optional extra (`roster[mcp]`), imported only by `roster mcp`.

## 1. Transport and shape

**Recommendation: stdio only, as `roster mcp [--client NAME]`, calling the same Python code that builds each `--json` document, in-process.**

- **stdio.** The client launches the server as a subprocess and they exchange newline-delimited JSON-RPC on stdin and stdout; the server may log to stderr and must write nothing else to stdout ([transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)). That's how `roster serve` already talks to the app, so roster knows the pattern. The server exits when stdin closes, which the spec names as the primary shutdown signal. No listening port means no DNS rebinding, no `Origin` check and no token to manage, which the HTTP transport would need ([HTTP's security warning](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#security-warning)).
- **Which Inventory.** The same lookup as every command (`-c`, `--inv`, `ROSTER_CONFIG`, …), fixed when the process starts. No tool switches Inventories (as no Plugin can, [security.md](../app/security.md#locking)), so a Host name always means one Inventory's Host for the process's life. The person writes `--inv NAME` into the client's config to pin it.
- **In-process, not a subprocess per call.** Each read command today builds a `jsondocs` model and prints it (`jsonout.emit`). The build ticket splits each one into a function that returns the model (`hosts_doc(cfg, …) -> HostsDoc`) and the printing around it. `--json` and `roster mcp` then call the same function and dump through the same redaction (`jsonout.redact`), so the shapes are identical by construction, and the MCP output schemas are those models' JSON schemas.
- **No new door.** The server registers a closed list of tools, each a thin call to one of those functions. It imports nothing from the vault commands, and none of its tools can reach `vault reveal`, `vault bw`, `vault op`, `vault status`, `vault sync`, `add --from-vault`, `check --auth`, keys, `setup`, `revoke`, `mesh` (apply, cut, leftovers), `discover`, `inv use` or `serve`. A test asserts the registered tool names are exactly the list in this ADR, and that a `tools/call` for anything else is refused.

Alternatives:

- **A subprocess per call** (`roster hosts --json`, with the model's arguments after `--`). Parity for free, and the allowlist is literally an argv allowlist. But each call pays Python's and Pydantic's start-up (ADR 0009), errors arrive as text to parse, and the model's arguments become argv (a Host name starting with `-` needs care). Kept as the fallback if the refactor turns out bigger than it looks.
- **Wrap `roster serve`** (its `hosts.list`, `host.get`, …). serve is the app's backend, not a public API ([Machine-readable output](../cli-reference.md#machine-readable-output)), and it holds the unlocked vault and the askpass channel: an MCP front on it would sit one method away from every door this ADR keeps shut.
- **Streamable HTTP on localhost** (XPipe's choice). Several clients could share one server, but it needs an API key, an `Origin` check and a port, and every local process can try it. stdio has none of that.

## 2. The v1 tools (read only)

Each returns the `--json` document unchanged, `version` field included, as the tool result's `structuredContent`, with the same JSON in a text block (the spec asks for both, for older clients: [tools, structured content](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#structured-content)). Each declares its `outputSchema` from its `jsondocs` model and the annotation `readOnlyHint: true` (a hint for the client only: the spec says clients must treat annotations as untrusted).

| Tool | CLI equivalent | Input schema | Output (`jsondocs` model; fields in [cli-reference](../cli-reference.md#machine-readable-output)) | Touches the network |
|---|---|---|---|---|
| `hosts` | `hosts --json [--only …] [--find …] [--all]` | `{only?: string[], find?: string, all?: boolean}`, no other key | `HostsDoc`: `{version, hosts: [Host], resources: [resource], groups: {name: {title, description}}, hidden}` | no |
| `host` | `hosts NAME --json` | `{name: string}` (required) | `HostInfoDoc` `{version, host: Host, group}` or `ResourceInfoDoc` `{version, resource, group}` | no |
| `resources` | `hosts --resources --json [--only …] [--find …]` | `{only?: string[], find?: string}` | `ResourcesDoc`: `{version, resources: [resource]}` | no |
| `check` | `check --json [--only …]` | `{only?: string[]}` | `CheckDoc`: `{version, hosts: [{name, ok, ssh, checks}], mesh, ok}` | yes: one login per Host |
| `check_host` | `check HOST --json` | `{host: string}` (required) | `CheckHostDoc`: `{version, host, ok, steps: [{step, status, message, code?, fix?, details?, data?}]}` | yes: at most one TCP connection and one login |
| `mesh_status` | `mesh status --json` | `{}` (`additionalProperties: false`) | `MeshStatusDoc`: `{version, links, excluded, reach, members, pending, cut_pending, out_of_date}` | no |

Every input schema has `additionalProperties: false`. Names, groups and `--find` text go to the same resolution as the CLI's (fuzzy names for `host`, as `hosts NAME`).

- **Results that say "not ok" are results.** `check` with a failing Host, `check_host` with a failed step, or `hosts` whose `find` matches nothing (the CLI's exit 1) return their document normally, `isError: false`: `ok: false` is data the model reads.
- **Errors** (the CLI's `{version, error: {code, message, fix}}` on stderr) become a tool execution error (`isError: true`) whose text is `code N: message` plus the fix, through `redact_error`, so the model can correct itself. The codes are serve's, as now: `1` no `roster.yml`, `2` no such Host, `3` anything else.
- **`check` and `check_host` log in to Hosts.** They fetch a password-only Host's password inside roster, as the CLI does, and the result says only `ok`/`fail`. With the vault locked they fail with code 14's message; `roster mcp` never asks for a password or an unlock (§4). They respect `rate_limited:` (a no-answer's fix names the network), and the server runs one check at a time.

Left out of v1, each with its reason: `check --box` (harmless and local, but not asked for: a candidate, see the open questions), `check --auth` (fetches every Login's secret to test it), `vault status` and `add --from-vault` (vault commands), `discover` (an active scan), `mesh --dry-run` (connects to every Mesh Host; `check` already reports the drift), `inv list`/`inv which` (would tell the model about the person's other Inventories).

## 3. Client identity and grants

**What MCP offers.** A client names itself: `clientInfo` (`name`, `version`, `title`, …) in the `initialize` request up to protocol 2025-11-25, and an optional `io.modelcontextprotocol/clientInfo` in every request's `_meta` from 2026-07-28. The spec says it's self-reported and not verified, and that implementations "SHOULD NOT rely on them for security decisions" ([_meta](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#meta)). MCP's authorization is for HTTP; stdio servers "SHOULD NOT follow this specification, and instead retrieve credentials from the environment" ([authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)). So over stdio there's no client authentication to lean on.

**What's actually enforceable over stdio.** Only what roster itself refuses. The process runs as the person, started by an app that runs as the person, so the OS user is the only real boundary, and anything running as that user can start `roster mcp` with any argument. What roster can guarantee is:

- which tools exist at all (§1's closed list),
- what each grant allows, read from a file the model has no tool to write,
- that an action is refused, not attempted, when no grant covers it, and
- that no tool output ever holds a secret (§4).

**Recommendation: a client profile named on the command line.** The person adds roster to an app's MCP config with `roster mcp --client desktop` (any name; without `--client` the profile is `default`). The profile picks the grants. `clientInfo` goes in the audit log as `reported_client`, never into a decision. This is honest about what it is: a label chosen by whoever wrote the app's config, which keeps two apps on one Box apart (an editor plugin with read-only, a desktop app with `run` on the lab), not a lock against a hostile local program. Such a program already runs as the person and can run `roster run` itself.

**Where grants live: `~/.config/roster/mcp.yml`** (`%APPDATA%\roster\mcp.yml` on Windows), next to `inventories.json`: this Box's own file, never `roster.yml`. Grants are one person's choice on one Box; `roster.yml` is the team's shared, reviewed Inventory, and a grant there would give every teammate's AI app the same rights. YAML because roster.yml is YAML and pyyaml is already a dependency (`tomllib` needs Python 3.11; roster supports 3.10). A Pydantic model reads it, with its own `version: 1`, refusing unknown keys. Mode `0600`, and roster refuses a file anyone else can write, the way it treats `bw-session`. Grants are keyed by Inventory, as Host names are only unique inside one (the reason the app never fills a Session from another Inventory, [security.md](../app/security.md#locking)):

```yaml
# ~/.config/roster/mcp.yml
version: 1
clients:
  desktop:                 # roster mcp --client desktop
    inventories:
      lab:                 # a named Inventory (roster inv), or a roster.yml path
        check: true        # check and check_host (they log in to Hosts); default false?
        run:               # Hosts or groups: allow (no question) or ask (§4)
          esx-02: ask
          lab-linux: allow
        web:
          nas-01: ask
        sudo: false        # run --sudo; default false
```

**The default: read-only, actions off.** A profile the file doesn't name, or no file at all, gets the four offline reads (`hosts`, `host`, `resources`, `mesh_status`). Whether `check` and `check_host` are on by default too is open question 3: they're reads, and `ROSTER.md` already tells Claude to run `check HOST`, but they log in to Hosts, which networks with an SSH rate limiter notice.

**No `CONFIG_VERSION` bump.** `CONFIG_VERSION` is `init.lua`'s version (`roster.config_version`, decision Q165), and the grants aren't in `init.lua`: that's the app's Config, run by the Rust core, and the Python CLI can't read Lua. `roster.yml` doesn't change either. `mcp.yml` carries its own `version`.

**Who edits it.** By hand at first; `roster mcp grants` prints the effective grants per profile and Inventory. One caveat to write down in the docs: an agent that also has a shell on this Box (Claude Code) can edit `mcp.yml` like any file of the person's. `roster setup` already writes `.claude/settings.json` deny rules for `~/.ssh` ([How Claude uses it](../cli-reference.md#how-claude-uses-it)); it should add `mcp.yml`. That's a guardrail, not a wall: an agent with a shell can run `roster run` anyway, so grants constrain an agent that has only MCP.

Alternatives:

- **Trust `clientInfo.name`.** Free and automatic, but any client can say it's any other, and the spec says not to.
- **A per-client token** in the app's MCP config, passed in the environment. The same person writes the config and the grants, and any local program can read the app's config file, so it adds a secret to manage without adding a boundary.
- **Look at the parent process.** Brittle (apps start servers through `npx`, `uv`, `wsl.exe`, `cmd.exe`), different on every platform, and spoofable by the same user.
- **Grants in `roster.yml`.** Shared and reviewed, but team-wide where grants are personal, and an MCP client would get rights from a pull. A team-wide **ceiling** there (a Host or group marked `mcp: false`, which no `mcp.yml` can override) is a different, useful idea: open question 6.
- **Grants in `init.lua`.** The app's Config, in Lua, read by the Rust core: the CLI would need a second reader.

## 4. Actions: `run` and `web`

Not in v1. Proposed for the release after it, behind §3's grants:

| Tool | Input schema | Result |
|---|---|---|
| `run` | `{host: string, command: string, sudo?: boolean}` | `{version, host, exit, stdout, stderr}`, through `jsonout.redact` |
| `web` | `{host: string, service?: string, method: string, path: string, body?: string, headers?: string[]}` | `{version, host, service, status, reason, content_type, body}` |

**Per-client opt-in and per-Host approval.** A call is allowed only if the profile's grant for that Inventory names the Host (or a group it's in) under `run` or `web`. `allow` runs it. `ask` asks first (below). Anything else is refused, before roster touches the vault or the network, with a message naming the grant that's missing (the model can tell the person; it can't add the grant). `sudo: true` also needs `sudo: true` in the grant. The existing rules still hold on top: unreviewed Hosts are refused, an `os: windows` Host refuses `--sudo` (159), `web`'s path can't be a full URL or leave the service's address.

**How `ask` asks, with no TTY.** The server has no terminal; its stdin and stdout are the MCP channel. **Recommendation: MCP elicitation, form mode, and refuse when the client can't elicit.**

- The question is a form with one enum field (`run once` / `deny`) and a message that names the profile, the Inventory, the Host, its address and the exact command or request. Nothing in it is secret, and form mode is allowed for that; it is forbidden for passwords ("Servers MUST NOT use form mode elicitation to request sensitive information such as passwords", [elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)), and roster never needs one (below). Clients must show which server is asking and offer decline and cancel.
- Elicitation is a client capability. A client that didn't declare `elicitation` can't be asked, so an `ask` grant becomes a refusal ("esx-02 needs approval, and this client can't ask: set it to `allow` in mcp.yml, or use a client that can"). Fail closed, never silently allow.
- Protocol 2026-07-28 changed how a server asks: no server-to-client request on stdio any more, the question comes back from `tools/call` as an `InputRequiredResult` and the client retries with the answer (multi round-trip requests). The SDK's `Resolve(fn)` parameters work in both eras; `ctx.elicit` works only with older clients ([SDK elicitation](https://py.sdk.modelcontextprotocol.io/handlers/elicitation/)). The build uses `Resolve`. With the round trip, the server must check that the retried call is the same call it asked about (same tool, Host, command), so an approval can't be replayed onto another command.
- **What it's worth.** The client's UI shows the question to the person and the model can't answer it, in a client that follows the spec. A client that auto-accepts elicitations, or a buggy one, defeats `ask`. So `ask` is as strong as the client, and the docs say so. Open question 4 is whether that's enough, or whether `ask` should go to something roster controls.

**The model never sees a password.** The actions run the code `roster run` and `roster web` run today, and that code already keeps the password inside roster:

- `run` gets the Login's password from the vault inside roster's process and hands it to ssh or paramiko; the tool result is the command's stdout, stderr and exit status. `--sudo` gives sudo the password on its stdin with `sudo -S -p ''`, and the command itself runs with `</dev/null`, so it can't read it (`sshops.sudo_wrap`); the output is masked for the password anyway (`mask(out, [secret])`).
- `web` adds the credentials itself, refuses an `Authorization` header from the caller, never follows a redirect with them, and masks the password and the session tokens it got from the body, the reason and any error (`web.mask`).
- A locked vault is refused with code 14's message ("unlock in your shell, or `bw-session`"), never answered with an elicitation, a prompt or a field: roster never asks the model or the client for a secret.
- Logins in tool output are references only, `cmd:`/`env:` cut to their kind, as in `--json`.

**New edges the build must close** (found while reading the code):

- **`web`'s body.** The CLI reads `-d @FILE` from this Box's disk. Over MCP that would let the model send any local file of the person's to a Host (and maybe get it echoed back). The MCP `web` tool takes the body as text only; `@` has no meaning there.
- **`web`'s `--insecure`.** Not a model-settable input; it follows the service's own `verify:` in `roster.yml`.
- **`die()` exits the process.** `cmd_run` and `web.request` end with `SystemExit` on a refusal. In-process they must raise an error the server turns into a tool error, not end the server.
- **What the Host prints.** roster can't stop a remote command printing a secret that lives on the Host (`cat` of a config file). That's the Host's data, as it is with `roster run` in a shell today, and the grant (which Hosts) is the control. The docs say so.

**Limits.** One action at a time per server process, and at most 30 a minute (the spec says servers must rate-limit tool calls); `run` keeps its 120 s command timeout.

Alternatives for the approval:

- **Refuse, never ask:** only `allow` grants, decided ahead in `mcp.yml`. Simplest and as strong as the file, but every new Host means editing the file.
- **Ask in the roster app.** The app shows the question in its own window and roster mcp waits for the answer. Out of the model's and the client's reach, but the app isn't always running, and it needs a channel between `roster mcp` and the app that doesn't exist (the app reaches roster only through serve, ADR 0001).
- **Ask in a terminal:** roster mcp queues the request and the person runs `roster mcp approve ID`. Out of the client's reach, but slow, and needs a shared queue file between processes.
- **The client's own tool confirmation** (most clients ask before each tool call). Useful, but it's the client's setting, not roster's, and it can be turned off; roster can't rely on it.
- **URL-mode elicitation** to a page roster serves. For secrets it's the spec's answer, but roster has no secret to collect, and it would mean roster running a web server.

## 5. Audit log

**Recommendation: one JSON line per tool call, in a daily file of this Box's own, redacted with the `--json` rules.**

- **Location:** `$XDG_STATE_HOME/roster/mcp/` (default `~/.local/state/roster/mcp/`); on Windows `%LOCALAPPDATA%\roster\mcp\`. Logs are state, not config, so not under `~/.config/roster/`. Folder `0700`, files `0600`. `roster mcp log` prints the path (and, later, a summary).
- **Format:** JSON Lines, one file per day (`2026-11-05.jsonl`). One line per call, written once the call ends, through `O_APPEND` (one `write` per line), so several `roster mcp` processes (one per client) can share a file without a lock. Fields: `time` (UTC), `pid`, `profile`, `inventory` (name or path), `reported_client` (`clientInfo`'s name and version, as reported), `protocol` (the version spoken), `tool`, `args`, `outcome` (`ok`, `not_ok`, `error`, `refused`, `declined`), `error` (`{code, message}`), `approval` (`read`, `allow`, `asked`, or the grant that was missing), `duration_ms`, and for actions `host`, `exit` or `status`, and the output's size in bytes.
- **Never logged:** a tool's output (a Host list is in `roster.yml` already; `run`'s stdout can be anything the Host prints), a secret (roster has none to log: the values stay in the vault code), an elicitation's free text (there is none: the answer is an enum).
- **Redaction:** every string goes through `jsonout.redact` and error messages through `redact_error`, the cases in `tests/vectors/redaction.json`: a `cmd:`/`env:` reference in an argument or message is cut to its kind. `run`'s `command` is logged as the model sent it, redacted: it's what the audit is for.
- **Rotation:** by day. A starting server deletes files older than 30 days (`mcp.yml` can set `log_days:`). No size rotation: a rotate-by-size between several processes needs a lock, and a day of calls is small (a few hundred bytes a call).

Alternatives: one file rotated by size (Python's `RotatingFileHandler` isn't safe across processes); the system log (`journald`, Windows' Event Log: two implementations and harder for the person to read); MCP's own logging notifications (they go to the client, which is the party being audited).

## 6. Library

**Recommendation: the official `mcp` SDK, 2.x, as an optional extra.**

- **Why the SDK:** MCP changed its wire model in 2026-07-28 (no `initialize` handshake, per-request `_meta`, `server/discover`, server questions as `InputRequiredResult`), and today's clients speak both eras. SDK 2's stdio server "answers a 2025-era client's `initialize` and a 2026-era client's requests with nothing to configure" ([what's new in v2](https://py.sdk.modelcontextprotocol.io/whats-new/)), and its `Resolve` elicitation works in both. Hand-rolling that means following two protocol revisions, their schemas and their error codes ourselves, and every revision after.
- **It fits roster:** MIT, `requires-python >=3.10` (as roster), Pydantic 2 (roster's models; SDK 2.3 needs `pydantic>=2.12`). A tool's return type is its output schema: a Pydantic model's schema, field for field, validated before it leaves ([structured output](https://py.sdk.modelcontextprotocol.io/servers/structured-output/)), which the `jsondocs` models are. The protocol types are a separate `mcp-types` package.
- **The cost:** it's heavy for a stdio server. SDK 2.3.0 also requires `anyio`, `httpx2`, `jsonschema`, `opentelemetry-api`, `pyjwt[crypto]` (cryptography, which paramiko already brings), `python-multipart`, `sse-starlette`, `starlette`, `uvicorn`, `typing-inspection`, and `pywin32` on Windows: the HTTP transport's stack, which `roster mcp` won't use. So it's an **extra**: `pip install 'roster[mcp]'` / `uv tool install '.[mcp]'`, imported only inside `roster mcp`. A Box that never runs `roster mcp` installs nothing new, and every other command's start-up is unchanged. `roster mcp` without the extra exits with a fix naming the install line.
- **Pinning:** `mcp>=2.3,<3` in `pyproject.toml` (a major version may break the API, as 2.0 renamed `FastMCP` to `MCPServer`), the exact version locked in `uv.lock`, updated on purpose. SDK 1.x is in maintenance and speaks only the older protocol, so not that.

Alternatives:

- **Hand-rolled JSON-RPC,** reusing what serve already has (newline-delimited JSON-RPC on stdio). No dependency, and roster's read tools need little of MCP. But two protocol eras, `outputSchema`/`structuredContent`, the round-trip elicitation, cancellation and the next revision are all ours to get right, and MCP has broken its wire format once already this year.
- **The SDK as a required dependency.** Simpler install, but every roster user pays for an HTTP stack to serve stdio.
- **SDK 1.x (`mcp<2`).** Smaller change for clients today, but legacy-only, so it stops working with clients that drop the old handshake.

## 7. Comparables

From each product's public docs (links and what each page does and doesn't say: [appendix](#comparables)):

| | Transport | Scope of tools | Approval | Secrets and the model | Audit |
|---|---|---|---|---|---|
| **XPipe** | Local Streamable HTTP, API key; off by default | `list_files`, `call_api` (add, change, remove connections) | The person enables each kind of action that can change a system; per-call confirmation is left to the client | Not stated. Connection notes and a global "MCP context" setting reach the agent | Not documented |
| **Devolutions RDM** | User-scoped named pipes bridged through stdio | Commands in RDP, SSH and Devolutions Agent sessions | "Mandatory authorization for every AI action" (an MCP Connection Prompt); approval modes Default and Bypass | Vendor claim: credentials are injected into sessions, so the model never sees them | Not described |
| **Teleport** | `tsh mcp connect` on stdio, proxied to the MCP server through Teleport | RBAC per role: `app_labels` pick the servers, `mcp.tools` the tools (`'*'` in the preset) | By role, granted ahead; no approval flow on the page | Teleport identity (`tsh login`); the tools are the target server's | MCP requests logged as audit events |

**What roster does differently.**

- **Nothing is held for the model.** RDM makes the same promise as a vendor claim, inside a paid product; roster's is checkable: the password path is the code in `run` and `web` (§4), the redaction is tested against shared vectors, and the source is public. XPipe's docs don't say.
- **Grants per Host, not per tool or role.** Teleport scopes which tools a role may call; roster scopes which Hosts an action may touch, and whether to ask, per client profile. For an operator that's the question that matters: "may it run commands on the lab, and on the core switch?"
- **The read side is the reviewed Inventory.** What the model reads is the team's `roster.yml` after review: unreviewed scanned Hosts are hidden and never acted on. XPipe and RDM read their own vaults.
- **No server, gateway or account.** One local process per client, started by the client, gone when it closes; no port (XPipe), no proxy cluster (Teleport), no licence tier (RDM).
- **What roster doesn't have:** a central policy (Teleport's roles, RDM's server-side governance). On a team, each person grants on their own Box. Open question 6 is the team-wide ceiling.

## 8. Open questions for the owner

1. **Is `--client NAME` the identity you want, knowing it's a label and not a proof?** The alternatives (trust `clientInfo`, a token, the parent process) add no real boundary over stdio. If yes: does a missing `--client` mean the profile `default` (read-only), or is `--client` required?
2. **Is `~/.config/roster/mcp.yml` the right home for grants,** keyed by Inventory as proposed, or should grants live elsewhere (a section in `inventories.json`, the app's State)? And should roster offer `roster mcp grant`/`revoke` commands in v1, or hand edits plus `roster mcp grants` to view them?
3. **Are `check` and `check_host` on by default,** like the offline reads, or a grant of their own (`check: true`) because they log in to Hosts and count against SSH rate limiters?
4. **Is MCP elicitation good enough for `ask`?** It's as strong as the client (one that auto-accepts defeats it). Or should `ask` go to something roster controls (the roster app, or `roster mcp approve` in a terminal), at the cost of a new channel? Or no `ask` at all in the first actions release: `allow` grants only?
5. **May the first actions release include `run --sudo`,** behind its own `sudo: true` grant, or should `sudo` wait for a later release?
6. **Should `roster.yml` be able to set a team-wide ceiling,** e.g. `mcp: false` on a Host or group that no Box's `mcp.yml` can override? It would be reviewed in git like the rest of the Inventory, and it's the one team-level control roster would have.
7. **`web`: any method, or `GET` (and `HEAD`) only unless the grant says `methods: [POST, …]`?** A `POST` can change a device's config.
8. **The SDK as an extra (`roster[mcp]`):** fine, or should `install.sh` offer it (one more question there), or should `mcp` be a required dependency so `roster mcp` always works?
9. **Should v1 also have `check_box`** (`check --box --json`: this Box's health, connecting nowhere)? It's local and harmless, and helps a model explain why `roster` doesn't work here, but the issue didn't list it.
10. **The audit log's retention:** 30 days by default? And should the log record `run`'s output size only (proposed), or a hash of the output as well, for later comparison?
11. **Protocol versions:** serve both eras (2026-07-28 and 2025-11-25, what the SDK does by default), or modern-only once the main clients have moved?

## Consequences (if accepted)

- A new command, `roster mcp`, internal to AI apps the way `serve` is to the desktop app: its own section in cli-reference, a page for setting it up in Claude Desktop and others, rows in errors and `docs/news.md`.
- The read commands split into "build the document" and "print it" (one function per document), a refactor that `--json` gets for free.
- `security.md` gains a section for `roster mcp`: what reaches the model, what's logged, what `ask` is worth.
- `roster setup`'s `.claude/settings.json` deny rules add `mcp.yml`.
- The decision rows (one for the shape, one for the grants and approvals) are pre-assigned by the coordinator after the owner's session.

## Appendix: research notes

Read 2026-11-05. MCP's current protocol version is **2026-07-28** ([versioning](https://modelcontextprotocol.io/specification/versioning)); the one before it, **2025-11-25**, is the last with the `initialize` handshake, and clients of both are in use.

### MCP: stdio

- The client launches the server as a subprocess; newline-delimited JSON-RPC on stdin/stdout, no embedded newlines; the server may log anything to stderr and must write nothing but MCP messages to stdout ([2026-07-28 stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio), [2025-11-25 transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#stdio)).
- Shutdown: the client closes stdin, waits, then terminates. "Servers SHOULD exit promptly when their standard input is closed."
- 2026-07-28: "The server MUST NOT write JSON-RPC requests to stdout. Server-to-client interactions are carried in `InputRequiredResult` replies." The protocol is stateless: "Servers MUST NOT rely on prior requests over the same connection to establish context (e.g., capabilities, protocol version, client identity)" ([basic, statelessness](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#statelessness)).
- A dual-era server answers `initialize` with the old semantics and per-request `_meta` with the new; a modern client probes with `server/discover` first ([versioning and compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)).

### MCP: client identity

- 2025-11-25: `clientInfo` (`name`, `title`, `version`, `description`, `icons`, `websiteUrl`) in `initialize` ([lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#initialization)); nothing in the spec verifies it.
- 2026-07-28: `io.modelcontextprotocol/clientInfo` in each request's `_meta`, optional. "`io.modelcontextprotocol/clientInfo` and `io.modelcontextprotocol/serverInfo` are self-reported by the sender and are not verified by the protocol. They are intended for display, logging, and debugging. Implementations SHOULD NOT use them to change the behavior of the client or server, and SHOULD NOT rely on them for security decisions" ([_meta](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#meta)).
- Authorization is for HTTP: "Implementations using an STDIO transport SHOULD NOT follow this specification, and instead retrieve credentials from the environment" ([authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)).
- Elicitation's security considerations: "Servers MUST NOT rely on client-provided user identification without server verification, as this can be forged."

### MCP: elicitation

- Two modes: **form** (structured data, a flat schema of primitive fields, the data passes through the client) and **URL** (out-of-band, for secrets). "Servers MUST NOT use form mode elicitation to request sensitive information such as passwords, API keys, access tokens, or payment credentials." Clients "MUST provide UI that makes it clear which server is requesting information" and offer decline and cancel ([2026-07-28 elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)).
- A capability the client declares (`elicitation: {form: {}, url: {}}`); servers must not use a mode the client didn't declare. Answers are `accept` (with content), `decline` or `cancel`.
- 2025-11-25: a server-to-client `elicitation/create` request during the call. 2026-07-28: the call returns an `InputRequiredResult` holding the `elicitation/create`, and the client retries the call with `inputResponses`.

### MCP: tools

- A tool has `name`, `title`, `description`, `inputSchema` (JSON Schema 2020-12; no parameters: `{"type": "object", "additionalProperties": false}`), optional `outputSchema` and `annotations` ([tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)).
- With an `outputSchema`, "Servers MUST provide structured results that conform to this schema"; a tool that returns `structuredContent` "SHOULD also return the serialized JSON in a TextContent block."
- Errors: protocol errors (unknown tool, malformed request) vs tool execution errors (`isError: true`), which the model sees and can correct.
- "Clients MUST consider tool annotations to be untrusted unless they come from trusted servers." Servers "MUST: validate all tool inputs, implement proper access controls, rate limit tool invocations, sanitize tool outputs." Applications SHOULD "present confirmation prompts to the user for operations".

### The official Python SDK

- PyPI `mcp` 2.3.0 (2026-10-02): MIT, `requires-python >=3.10`, from github.com/modelcontextprotocol/python-sdk ([PyPI](https://pypi.org/project/mcp/)). Its `requires_dist`: `anyio>=4.9`, `httpx2>=2.10.0`, `jsonschema>=4.20.0`, `mcp-types==2.3.0` (which needs only `pydantic>=2.12.0` and `typing-extensions`), `opentelemetry-api>=1.28.0`, `pydantic>=2.12.0`, `pyjwt[crypto]>=2.10.1`, `python-multipart>=0.0.9`, `pywin32>=311` (Windows), `sse-starlette>=3.0.0`, `starlette>=0.27`, `typing-extensions>=4.13.0`, `typing-inspection>=0.4.1`, `uvicorn>=0.31.1`; extras `cli` (typer, python-dotenv) and `rich`.
- Releases: 2.0.0 on 2026-07-28 (with the protocol), 2.1.0 2026-08-24, 2.2.0 2026-09-07, 2.3.0 2026-10-02; 1.x continues (1.30.0, 2026-09-07).
- v2: `FastMCP` renamed `MCPServer` (the old import removed); the stdio server serves both eras with nothing to configure; protocol types in `mcp-types`; "Raising `MCPError` inside a tool is now a protocol error that the model never sees", other exceptions become error results, and only a `ToolError`'s message reaches the model; "v1.x is not going anywhere. It moves to maintenance, keeps getting critical fixes and security patches" ([what's new in v2](https://py.sdk.modelcontextprotocol.io/whats-new/)).
- Structured output: "the return type annotation is the output schema"; a Pydantic model's schema is the model itself, unwrapped, and the value is validated before it leaves the server; `structured_output=False` turns that off ([structured output](https://py.sdk.modelcontextprotocol.io/servers/structured-output/)).
- Elicitation: a parameter `Annotated[T, Resolve(fn)]` is filled before the tool runs and works on every connection (on 2026-07-28 "the SDK returns the question from the call, and the client's next attempt carries the answer"); `ctx.elicit()` in a tool body is a server-to-client request: "On a 2026-07-28 connection there are no server-initiated requests, so these calls fail." A client that didn't declare elicitation makes the call fail with "Elicitation not supported" ([elicitation](https://py.sdk.modelcontextprotocol.io/handlers/elicitation/)).

### Comparables

- **XPipe** ([MCP guide](https://docs.xpipe.io/guide/mcp)): an MCP server inside the desktop app, disabled by default, Streamable HTTP only (SSE clients get an error), local clients authenticate with an API key. Tools named on the page: `list_files` (read, optionally recursive) and `call_api` (XPipe's HTTP API, which can add, modify or remove connection entries); the page says the person must "explicitly enable every kind of actions that can potentially modify a system" and recommends configuring the client to confirm tool calls. The global MCP context setting and connection notes are given to the agent. The page doesn't say whether secrets can reach the model, and doesn't mention logging. XPipe's HTTP API has a secret-decrypt endpoint ([API](https://docs.xpipe.io/api), as competitors.md notes).
- **Devolutions RDM**: MCP server and AI assistant since 2026.1 ([2026.1](https://devolutions.net/blog/whats-new-in-devolutions-remote-desktop-manager-20261/)); commands run "directly in RDP, via the Devolutions Agent, or via SSH sessions". The vendor's brief says the transport is "user-scoped" named pipes bridged through stdio, "Mandatory authorization for every AI action" through an MCP Connection Prompt, and that RDM "injects them directly into remote sessions, preventing the model from ever seeing or processing them" ([brief](https://devolutions.net/blog/ema-impact-brief-why-devolutions-rdm-mcp-server-sets-a-new-standard-for-secure-ai-automation/)). 2026.2 adds approval modes, "Default approvals" for change control and "Bypass approvals" for labs and demos ([2026.2](https://devolutions.net/blog/ai-assistant-in-remote-desktop-manager-20262/)). Neither page lists the tools or describes an audit log. Vendor claims, not checked.
- **Teleport** ([MCP access](https://goteleport.com/docs/enroll-resources/mcp-access/getting-started/)): the client starts `tsh mcp connect SERVER` on stdio, `tsh` authenticates with the person's Teleport identity (`tsh login`, or an identity file for automation), and Teleport proxies to the MCP server, which its Application Service runs. Access is RBAC: the preset `mcp-user` role allows MCP apps by label and `mcp.tools: ['*']`; Teleport "logs MCP protocol requests as audit events". No approval flow on that page.
