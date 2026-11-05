# `roster mcp`: a stdio MCP server over the CLI's read commands, with actions granted per client

_Status: **Accepted (2026-11-05)**, decision Q206. The design spike T103 (issue #181) drafted it; the owner answered its open questions on #181 the same day, and each answer is a decided point below ([Decided](#8-decided-the-owners-answers)). The research it rests on is in the [appendix](#appendix-research-notes), checked against primary sources on 2026-11-05._

_Stretch goal (owner, 2026-11-05): design recorded; no build work until resumed._

roster already lets Claude work on the network without seeing a secret: `ROSTER.md` is its map, `roster run` and `roster web` log in for it, and `--json` gives it roster's data ([How Claude uses it](../cli-reference.md#how-claude-uses-it)). That needs a shell. An AI app that has no shell (Claude Desktop, other MCP clients) can't use any of it. `roster mcp` gives those apps the same reads, and later two actions, through the Model Context Protocol (MCP), with **no new door to a secret**.

In short:

- `roster mcp` is a **stdio** MCP server that the AI app starts as a child process. It speaks to nobody else: no port, no socket.
- **v1 is read-only**: seven tools that return exactly the documents `--json` prints (`hosts`, `host`, `resources`, `check_box`, `mesh_status`, and, behind a grant, `check` and `check_host`).
- **Actions** (`run`, `web`) come later, off by default, granted **per client profile and per Host** in a file of this Box's own, `~/.config/roster/mcp.yml`. The first actions release has `allow` grants only: no question at run time, no `sudo`, and `web` is `GET`/`HEAD` unless the grant lists more methods.
- A **team ceiling** in `roster.yml`, `mcp: false` on a Host or group, which no Box's grants can override.
- A **client profile** is a name the person writes into the app's MCP config (`roster mcp --client desktop`). Over stdio nothing can prove which app is calling, so the profile is a label the person chose, not an identity; `clientInfo` is only logged.
- **Every tool call is logged**, one JSON line each, with the `--json` redaction, kept 30 days.
- It's built on the **official `mcp` Python SDK (2.x)**, as an optional extra (`roster[mcp]`), imported only by `roster mcp`. It serves clients of both current protocol versions.

## 1. Transport and shape

**Decided: stdio only, as `roster mcp [--client NAME]`, calling the same Python code that builds each `--json` document, in-process.**

- **stdio.** The client launches the server as a subprocess and they exchange newline-delimited JSON-RPC on stdin and stdout; the server may log to stderr and must write nothing else to stdout ([stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)). That's how `roster serve` already talks to the app, so roster knows the pattern. The server exits when stdin closes, which the spec names as the primary shutdown signal. No listening port means no DNS rebinding, no `Origin` check and no token to manage, which the HTTP transport would need ([HTTP's security warning](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#security-warning)).
- **Which Inventory.** The same lookup as every command (`-c`, `--inv`, `ROSTER_CONFIG`, …), fixed when the process starts. No tool switches Inventories (as no Plugin can, [security.md](../app/security.md#locking)), so a Host name always means one Inventory's Host for the process's life. The person writes `--inv NAME` into the client's config to pin it.
- **In-process, not a subprocess per call.** Each read command today builds a `jsondocs` model and prints it (`jsonout.emit`). The read commands are split into a function that returns the model (`hosts_doc(cfg, …) -> HostsDoc`) and the printing around it. `--json` and `roster mcp` then call the same function and dump through the same redaction (`jsonout.redact`), so the shapes are identical by construction, and the MCP output schemas are those models' JSON schemas.
- **No new door.** The server registers a closed list of tools, each a thin call to one of those functions. It imports nothing from the vault commands, and none of its tools can reach `vault reveal`, `vault bw`, `vault op`, `vault status`, `vault sync`, `add --from-vault`, `check --auth`, keys, `setup`, `revoke`, `mesh` (apply, cut, leftovers), `discover`, `inv use` or `serve`. A test asserts the registered tool names are exactly the list in this ADR, and that a `tools/call` for anything else is refused.

Considered:

- **A subprocess per call** (`roster hosts --json`, with the model's arguments after `--`). Parity for free, and the allowlist is literally an argv allowlist. But each call pays Python's and Pydantic's start-up (ADR 0009), errors arrive as text to parse, and the model's arguments become argv (a Host name starting with `-` needs care). The fallback if the refactor turns out bigger than it looks.
- **Wrap `roster serve`** (its `hosts.list`, `host.get`, …). serve is the app's backend, not a public API ([Machine-readable output](../cli-reference.md#machine-readable-output)), and it holds the unlocked vault and the askpass channel: an MCP front on it would sit one method away from every door this ADR keeps shut.
- **Streamable HTTP on localhost** (XPipe's choice). Several clients could share one server, but it needs an API key, an `Origin` check and a port, and every local process can try it. stdio has none of that.

## 2. The v1 tools (read only)

Each returns the `--json` document unchanged, `version` field included, as the tool result's `structuredContent`, with the same JSON in a text block (the spec asks for both, for older clients: [tools, structured content](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#structured-content)). Each declares its `outputSchema` from its `jsondocs` model and the annotation `readOnlyHint: true` (a hint for the client only: the spec says clients must treat annotations as untrusted).

| Tool | CLI equivalent | Input schema | Output (`jsondocs` model; fields in [cli-reference](../cli-reference.md#machine-readable-output)) | Touches the network | Default |
|---|---|---|---|---|---|
| `hosts` | `hosts --json [--only …] [--find …] [--all]` | `{only?: string[], find?: string, all?: boolean}` | `HostsDoc`: `{version, hosts: [Host], resources: [resource], groups: {name: {title, description}}, hidden}` | no | on |
| `host` | `hosts NAME --json` | `{name: string}` (required) | `HostInfoDoc` `{version, host: Host, group}` or `ResourceInfoDoc` `{version, resource, group}` | no | on |
| `resources` | `hosts --resources --json [--only …] [--find …]` | `{only?: string[], find?: string}` | `ResourcesDoc`: `{version, resources: [resource]}` | no | on |
| `check_box` | `check --box --json` | `{}` | `BoxCheckDoc`: `{version, checks: [{section, level, message, fix?, topic?}], ok}` | no | on |
| `mesh_status` | `mesh status --json` | `{}` | `MeshStatusDoc`: `{version, links, excluded, reach, members, pending, cut_pending, out_of_date}` | no | on |
| `check` | `check --json [--only …]` | `{only?: string[]}` | `CheckDoc`: `{version, hosts: [{name, ok, ssh, checks}], mesh, ok}` | yes: one login per Host | off: `check: true` |
| `check_host` | `check HOST --json` | `{host: string}` (required) | `CheckHostDoc`: `{version, host, ok, steps: [{step, status, message, code?, fix?, details?, data?}]}` | yes: at most one TCP connection and one login | off: `check: true` |

Every input schema has `additionalProperties: false` (`{}` above is `{"type": "object", "additionalProperties": false}`). Names, groups and `--find` text go to the same resolution as the CLI's (fuzzy names for `host`, as `hosts NAME`).

- **Results that say "not ok" are results.** `check` with a failing Host, `check_host` with a failed step, `check_box` with an error, or `hosts` whose `find` matches nothing (the CLI's exit 1) return their document normally, `isError: false`: `ok: false` is data the model reads.
- **Errors** (the CLI's `{version, error: {code, message, fix}}` on stderr) become a tool execution error (`isError: true`) whose text is `code N: message` plus the fix, through `redact_error`, so the model can correct itself. The codes are serve's, as now: `1` no `roster.yml`, `2` no such Host, `3` anything else.
- **`check_box` connects nowhere.** It's this Box's health (`roster.yml`, ssh, the vault's state, the infra repo), the one place a model can learn why roster itself doesn't work here.
- **`check` and `check_host` log in to Hosts, so they need a grant** (`check: true` for the profile and Inventory, §3). They fetch a password-only Host's password inside roster, as the CLI does, and the result says only `ok`/`fail`. With the vault locked they fail with code 14's message; `roster mcp` never asks for a password or an unlock (§4). They respect `rate_limited:` (a no-answer's fix names the network), and the server runs one check at a time. Without the grant, a call is refused with a message naming it.

Left out, each with its reason: `check --auth` (fetches every Login's secret to test it), `vault status` and `add --from-vault` (vault commands), `discover` (an active scan), `mesh --dry-run` (connects to every Mesh Host; `check` already reports the drift), `inv list`/`inv which` (would tell the model about the person's other Inventories).

## 3. Client identity and grants

**What MCP offers.** A client names itself: `clientInfo` (`name`, `version`, `title`, …) in the `initialize` request up to protocol 2025-11-25, and an optional `io.modelcontextprotocol/clientInfo` in every request's `_meta` from 2026-07-28. The spec says it's self-reported and not verified, and that implementations "SHOULD NOT rely on them for security decisions" ([_meta](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#meta)). MCP's authorization is for HTTP; stdio implementations "SHOULD NOT follow this specification, and instead retrieve credentials from the environment" ([authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)). So over stdio there's no client authentication to lean on.

**What's actually enforceable over stdio.** Only what roster itself refuses. The process runs as the person, started by an app that runs as the person, so the OS user is the only real boundary, and anything running as that user can start `roster mcp` with any argument. What roster can guarantee is:

- which tools exist at all (§1's closed list),
- what each grant allows, read from a file the model has no tool to write,
- that a Host the team marked `mcp: false` is never acted on, whatever a grant says,
- that a call is refused, not attempted, when no grant covers it, and
- that no tool output ever holds a secret (§4).

**Decided: a client profile named on the command line, optional.** The person adds roster to an app's MCP config with `roster mcp --client desktop` (any name). Without `--client` the profile is `default`, which is read-only like any profile `mcp.yml` doesn't name. The profile picks the grants. `clientInfo` goes in the audit log as `reported_client`, never into a decision. It's a label chosen by whoever wrote the app's config, which keeps two apps on one Box apart (an editor plugin with the reads, a desktop app with `run` on the lab), not a lock against a hostile local program. Such a program already runs as the person and can run `roster run` itself.

**Decided: grants live in `~/.config/roster/mcp.yml`** (`%APPDATA%\roster\mcp.yml` on Windows), next to `inventories.json`: this Box's own file, never `roster.yml`. Grants are one person's choice on one Box; `roster.yml` is the team's shared, reviewed Inventory, and a grant there would give every teammate's AI app the same rights. YAML because roster.yml is YAML and pyyaml is already a dependency (`tomllib` needs Python 3.11; roster supports 3.10). A Pydantic model reads it, with its own `version: 1`, refusing unknown keys. Mode `0600`, and roster refuses a file anyone else can write, the way it treats `bw-session`. Grants are keyed by Inventory, as Host names are only unique inside one (the reason the app never fills a Session from another Inventory, [security.md](../app/security.md#locking)):

```yaml
# ~/.config/roster/mcp.yml
version: 1
clients:
  desktop:                 # roster mcp --client desktop
    inventories:
      lab:                 # a named Inventory (roster inv), or a roster.yml path
        check: true        # check and check_host (they log in to Hosts); default false
        run:               # Hosts or groups this profile may run commands on
          - lab-linux
          - esx-02
        web:               # Hosts or groups; GET and HEAD only ...
          - nas-01
          - host: appliance
            methods: [GET, HEAD, POST]   # ... unless the entry lists methods
```

**The default: the offline reads only.** A profile the file doesn't name, `default`, or no file at all, gets `hosts`, `host`, `resources`, `check_box` and `mesh_status`. `check` and `check_host` need `check: true`; actions need a `run` or `web` entry.

**Decided: the team ceiling, `mcp: false` in `roster.yml`.** A Host or a group in `roster.yml` may say `mcp: false`. Then no MCP action touches it and no MCP check logs in to it, whatever any Box's `mcp.yml` says: the server refuses the call and names the `roster.yml` line. It's reviewed in git like the rest of the Inventory, and it's the one team-level control: a team can keep the core switch out of every AI app's reach without asking each person. It is not a reason to hide the Host from the read tools (it's in `roster.yml` already, and `hosts` reads it); the build ticket shows `mcp: false` in the Host object. A new `roster.yml` key, so it ships with its `roster.yml` docs row and a news line, and an older roster ignores it (the key is the team's own until then).

**No `CONFIG_VERSION` bump.** `CONFIG_VERSION` is `init.lua`'s version (`roster.config_version`, decision Q165), and the grants aren't in `init.lua`: that's the app's Config, run by the Rust core, and the Python CLI can't read Lua. `mcp.yml` carries its own `version`.

**Who edits it.** By hand in v1; `roster mcp grants` prints the effective grants per profile and Inventory, the ceiling applied. `roster mcp grant`/`revoke` commands may come later. One caveat in the docs: an agent that also has a shell on this Box (Claude Code) can edit `mcp.yml` like any file of the person's. `roster setup` already writes `.claude/settings.json` deny rules for `~/.ssh` ([How Claude uses it](../cli-reference.md#how-claude-uses-it)); it adds `mcp.yml`. That's a guardrail, not a wall: an agent with a shell can run `roster run` anyway, so grants constrain an agent that has only MCP.

Considered:

- **Trust `clientInfo.name`.** Free and automatic, but any client can say it's any other, and the spec says not to.
- **A per-client token** in the app's MCP config, passed in the environment. The same person writes the config and the grants, and any local program can read the app's config file, so it adds a secret to manage without adding a boundary.
- **Look at the parent process.** Brittle (apps start servers through `npx`, `uv`, `wsl.exe`, `cmd.exe`), different on every platform, and spoofable by the same user.
- **`--client` required.** Forces a choice, but a read-only `default` costs nothing and keeps the first setup one line.
- **Grants in `roster.yml`.** Shared and reviewed, but team-wide where grants are personal, and an MCP client would get rights from a pull. Only the ceiling (`mcp: false`) is there.
- **Grants in `init.lua`,** in `inventories.json`, or in the app's State. `init.lua` is Lua read by the Rust core, so the CLI would need a second reader; `inventories.json` and the State are other tools' files.
- **`check` and `check_host` on by default.** They're reads, and `ROSTER.md` already tells Claude to run `check HOST`, but they log in to Hosts, which networks with an SSH rate limiter notice.

## 4. Actions: `run` and `web`

Not in v1. In the first actions release, behind §3's grants and the ceiling:

| Tool | Input schema | Result |
|---|---|---|
| `run` | `{host: string, command: string}` | `{version, host, exit, stdout, stderr}`, through `jsonout.redact` |
| `web` | `{host: string, service?: string, method: string, path: string, body?: string, headers?: string[]}` | `{version, host, service, status, reason, content_type, body}` |

**Decided: per-client opt-in, per-Host grants, `allow` only.** A call runs only if the profile's grant for that Inventory names the Host (or a group it's in) under `run` or `web`, and `roster.yml` doesn't say `mcp: false` for it. Anything else is refused, before roster touches the vault or the network, with a message naming the grant or the ceiling (the model can tell the person; it can't change either). The existing rules hold on top: unreviewed Hosts are refused, `web`'s path can't be a full URL or leave the service's address.

**Decided: no question at run time in the first actions release.** No `ask`: what isn't granted ahead is refused. If an `ask` comes later, it goes through roster's own app (a question in the roster app's window), never through MCP elicitation alone, because an elicitation is shown, and answered, by the client, and a client that auto-accepts defeats it.

**Decided: no `sudo` in the first actions release.** `run` has no `sudo` input; a command needing root fails as it would for the login user. A later release may add it behind its own grant.

**Decided: `web` is `GET` and `HEAD` unless the grant lists methods.** A `POST`, `PUT`, `PATCH` or `DELETE` can change a device's configuration, so each `web` grant entry is `GET`/`HEAD` unless it has `methods: [...]`.

**The model never sees a password.** The actions run the code `roster run` and `roster web` run today, and that code already keeps the password inside roster:

- `run` gets the Login's password from the vault inside roster's process and hands it to ssh or paramiko; the tool result is the command's stdout, stderr and exit status.
- `web` adds the credentials itself, refuses an `Authorization` header from the caller, never follows a redirect with them, and masks the password and the session tokens it got (vSphere's cookie, UniFi's cookie and CSRF token, OpenVPN AS's and Hub's tokens) from the body, the reason and any error (`web.mask`).
- A locked vault is refused with code 14's message ("unlock in your shell, or `bw-session`"), never answered with a prompt or a field: roster never asks the model or the client for a secret. (MCP forbids asking for one in form mode anyway: "Servers MUST NOT use form mode elicitation to request sensitive information such as passwords", [elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation).)
- Logins in tool output are references only, `cmd:`/`env:` cut to their kind, as in `--json`.

**Edges the actions build closes** (found while reading the code):

- **`web`'s body is literal text.** The CLI reads `-d @FILE` from this Box's disk. Over MCP that would let the model send any local file of the person's to a Host (and maybe get it echoed back). The MCP `web` tool takes the body as text only; `@` has no meaning there.
- **No `--insecure`.** Not a model-settable input; it follows the service's own `verify:` in `roster.yml`.
- **`die()` becomes a tool error.** `cmd_run` and `web.request` end with `SystemExit` on a refusal. In-process they must raise an error the server turns into a tool error, not end the server.
- **What the Host prints.** roster can't stop a remote command printing a secret that lives on the Host (`cat` of a config file). That's the Host's data, as it is with `roster run` in a shell today, and the grant (which Hosts) is the control. The docs say so.

**Limits.** One action at a time per server process, and at most 30 a minute (the spec says servers must rate-limit tool calls); `run` keeps its 120 s command timeout.

Considered for approvals:

- **`ask` through MCP elicitation** (form mode, one enum field, refused when the client can't elicit). The question is shown by the client, so it's as strong as the client; one that auto-accepts defeats it. Rejected as the only gate; a later `ask` goes through roster's app.
- **`ask` in a terminal:** roster mcp queues the request and the person runs `roster mcp approve ID`. Out of the client's reach, but slow, and needs a shared queue between processes.
- **The client's own tool confirmation** (most clients ask before each tool call). Useful, but it's the client's setting, not roster's, and it can be turned off; roster can't rely on it.
- **URL-mode elicitation** to a page roster serves. For secrets it's the spec's answer, but roster has no secret to collect, and it would mean roster running a web server.
- **`sudo` behind a `sudo: true` grant** in the first release. `run --sudo` keeps the password from the command (`sudo -S` reads it on stdin and the command gets `</dev/null`, `sshops.sudo_wrap`), but root on a Host is a bigger grant than the first release needs.
- **Any `web` method by default.** Simpler grants, but a `POST` is a change.

## 5. Audit log

**Decided: one JSON line per tool call, in a daily file of this Box's own, redacted with the `--json` rules, kept 30 days.**

- **Location:** `$XDG_STATE_HOME/roster/mcp/` (default `~/.local/state/roster/mcp/`); on Windows `%LOCALAPPDATA%\roster\mcp\`. Logs are state, not config, so not under `~/.config/roster/`. Folder `0700`, files `0600`. `roster mcp log` prints the path.
- **Format:** JSON Lines, one file per day (`2026-11-05.jsonl`). One line per call, written once the call ends, through `O_APPEND` (one `write` per line), so several `roster mcp` processes (one per client) can share a file without a lock. Fields: `time` (UTC), `pid`, `profile`, `inventory` (name or path), `reported_client` (`clientInfo`'s name and version, as reported), `protocol` (the version spoken), `tool`, `args`, `outcome` (`ok`, `not_ok`, `error`, `refused`), `error` (`{code, message}`), `grant` (`read`, the grant that allowed it, or the grant or ceiling that refused it), `duration_ms`, and for actions `host`, `exit` or `status`, and the output's size in bytes.
- **Never logged:** a tool's output (a Host list is in `roster.yml` already; `run`'s stdout can be anything the Host prints), nor a hash of it: the size only. Never a secret (roster has none to log: the values stay in the vault code).
- **Redaction:** every string goes through `jsonout.redact` and error messages through `redact_error`, the cases in `tests/vectors/redaction.json`: a `cmd:`/`env:` reference in an argument or message is cut to its kind. `run`'s `command` is logged as the model sent it, redacted: it's what the audit is for.
- **Rotation:** by day. A starting server deletes files older than 30 days. No size rotation: a rotate-by-size between several processes needs a lock, and a day of calls is small (a few hundred bytes a call).

Considered: one file rotated by size (Python's `RotatingFileHandler` isn't safe across processes); the system log (`journald`, Windows' Event Log: two implementations and harder for the person to read); MCP's own logging (it goes to the client, which is the party being audited, and 2026-07-28 deprecates it); a hash of each output (lets a later run be compared, but the size is enough to spot a surprise and a hash is one more thing to explain).

## 6. Library

**Decided: the official `mcp` SDK, 2.x, as an optional extra; `install.sh` doesn't ask.**

- **Why the SDK:** MCP changed its wire model in 2026-07-28 (no `initialize` handshake, per-request `_meta`, `server/discover`, server questions as `InputRequiredResult`), and today's clients speak both protocol versions. SDK 2's stdio server "answers a 2025-era client's `initialize` and a 2026-era client's requests with nothing to configure" ([what's new in v2](https://py.sdk.modelcontextprotocol.io/whats-new/)). Hand-rolling that means following two protocol revisions, their schemas and their error codes ourselves, and every revision after.
- **Both protocol versions** (decided): `roster mcp` serves 2026-07-28 and 2025-11-25 clients, the SDK's default, until the main clients have moved.
- **It fits roster:** MIT, Pydantic 2 (roster's models; SDK 2.3 needs `pydantic>=2.12`). A tool's return type is its output schema: a Pydantic model's schema, field for field, validated before it leaves ([structured output](https://py.sdk.modelcontextprotocol.io/servers/structured-output/)), which the `jsondocs` models are. The protocol types are a separate `mcp-types` package.
- **The cost:** it's heavy for a stdio server. SDK 2.3.0 also requires `anyio`, `httpx2`, `jsonschema`, `opentelemetry-api`, `pyjwt[crypto]` (cryptography, which paramiko already brings), `python-multipart`, `sse-starlette`, `starlette`, `uvicorn`, `typing-inspection`, and `pywin32` on Windows: the HTTP transport's stack, which `roster mcp` won't use. So it's an **extra**: `pip install 'roster[mcp]'` / `uv tool install '.[mcp]'`, imported only inside `roster mcp`. A Box that never runs `roster mcp` installs nothing new, and every other command's start-up is unchanged. `roster mcp` without the extra exits with a fix naming the install line. `install.sh` doesn't offer it.
- **Pinning:** `mcp>=2.3,<3` in `pyproject.toml` (a major version may break the API, as 2.0 renamed `FastMCP` to `MCPServer`), the exact version locked in `uv.lock`, updated on purpose. SDK 1.x is in maintenance and speaks only the older protocol, so not that.
- **Python 3.10 (found while checking, 2026-11-05):** `mcp` 2.3.0 says `requires-python >=3.10`, but the SDK's `main` dropped Python 3.10 on 2026-10-12 ([#3690](https://github.com/modelcontextprotocol/python-sdk/commit/c4492554da517f93ddd52b072d9c4d07292f1161), unreleased), and its versioning policy allows "dropping a Python version after its upstream end-of-life" in a minor release ([VERSIONING.md](https://github.com/modelcontextprotocol/python-sdk/blob/main/VERSIONING.md)). roster supports 3.10 (`requires-python >=3.10`). So on Python 3.10, `roster[mcp]` will resolve to 2.3.x at most and miss later fixes. The first build ticket decides how to say that: the extra only for Python 3.11 and later (an environment marker), or `roster mcp` saying on 3.10 that it needs 3.11.

Considered:

- **Hand-rolled JSON-RPC,** reusing what serve already has (newline-delimited JSON-RPC on stdio). No dependency, and roster's read tools need little of MCP. But two protocol versions, `outputSchema`/`structuredContent`, cancellation and the next revision are all ours to get right, and MCP has broken its wire format once already this year.
- **The SDK as a required dependency,** or offered by `install.sh`. `roster mcp` would always work, but every roster user pays for an HTTP stack to serve stdio, or answers one more install question.
- **SDK 1.x (`mcp<2`).** Smaller change for clients today, but legacy-only, so it stops working with clients that drop the old handshake.
- **2026-07-28 clients only.** Less to test, but clients of the older version are still common.

## 7. Comparables

From each product's public docs (links and what each page does and doesn't say: [appendix](#comparables)):

| | Transport | Scope of tools | Approval | Secrets and the model | Audit |
|---|---|---|---|---|---|
| **XPipe** | Local Streamable HTTP, API key; off by default | `list_files`, `call_api` (add, change, remove connections) | The person enables each kind of action that can change a system; per-call confirmation is left to the client | Not stated. Connection notes and a global "MCP context" setting reach the agent | Not documented |
| **Devolutions RDM** | User-scoped named pipes bridged through stdio | Commands in RDP, SSH and Devolutions Agent sessions | "Mandatory authorization for every AI action" (an MCP Connection Prompt); approval modes Default and Bypass | Vendor claim: credentials are injected into sessions, so the model never sees them | Not described |
| **Teleport** | `tsh mcp connect` on stdio, proxied to the MCP server through Teleport | RBAC per role: `app_labels` pick the servers, `mcp.tools` the tools (`'*'` in the preset) | By role, granted ahead; no approval flow on the page | Teleport identity (`tsh login`); the tools are the target server's | MCP requests logged as audit events |

**What roster does differently.**

- **Nothing is held for the model.** RDM makes the same promise as a vendor claim, inside a paid product; roster's is checkable: the password path is the code in `run` and `web` (§4), the redaction is tested against shared vectors, and the source is public. XPipe's docs don't say.
- **Grants per Host, not per tool or role.** Teleport scopes which tools a role may call; roster scopes which Hosts an action may touch, per client profile. For an operator that's the question that matters: "may it run commands on the lab, and on the core switch?"
- **The read side is the reviewed Inventory.** What the model reads is the team's `roster.yml` after review: unreviewed scanned Hosts are hidden and never acted on, and the team's `mcp: false` is reviewed there too. XPipe and RDM read their own vaults.
- **No server, gateway or account.** One local process per client, started by the client, gone when it closes; no port (XPipe), no proxy cluster (Teleport), no licence tier (RDM).
- **What roster doesn't have:** a central policy (Teleport's roles, RDM's server-side governance). On a team, each person grants on their own Box, under the team's `mcp: false` ceiling.

## 8. Decided: the owner's answers

The draft's open questions, as the owner answered them on #181 (2026-11-05):

1. **Identity:** a `--client NAME` label written into the AI app's config: a label, not a proof. Optional: no `--client` is the `default` profile, read-only.
2. **Grants:** `~/.config/roster/mcp.yml`, keyed by Inventory. v1 is hand edits plus `roster mcp grants` to view them; `grant`/`revoke` commands later.
3. **`check` / `check_host`:** off by default, behind their own `check: true` grant (they log in to Hosts and hit SSH rate limiters). The offline reads are on by default.
4. **`ask`:** none in the first actions release, which has `allow` grants only. An `ask` may come later through roster's own app, never through MCP elicitation alone.
5. **`run --sudo`:** not in the first actions release.
6. **Team ceiling:** yes, `mcp: false` on a Host or group in `roster.yml`, which no Box's `mcp.yml` can override.
7. **`web`:** `GET`/`HEAD` only unless the grant lists `methods: [...]`.
8. **SDK:** an optional extra, `roster[mcp]`; `install.sh` doesn't ask.
9. **`check_box`:** in v1 (local, connects nowhere).
10. **Audit log:** 30 days' retention; `run`'s output size only, no hash.
11. **Protocol versions:** both current ones (the SDK's default) until the main clients have moved.

## Consequences

- A new command, `roster mcp`, internal to AI apps the way `serve` is to the desktop app: its own section in cli-reference, a page for setting it up in Claude Desktop and others, rows in errors and `docs/news.md`.
- The read commands split into "build the document" and "print it" (one function per document), a refactor that `--json` gets for free.
- A new `roster.yml` key, `mcp: false`, on a Host or a group.
- `security.md` gains a section for `roster mcp`: what reaches the model, what's logged, what the grants and the ceiling are worth.
- `roster setup`'s `.claude/settings.json` deny rules add `mcp.yml`.

## Build tickets (when the owner resumes this)

In this order; each ships its docs in the same pull request.

1. **The read-command refactor and `roster mcp` v1 reads.** Split each read command into a function that builds its `jsondocs` model and the printing around it (`--json` output byte for byte unchanged). `roster mcp [--client NAME]` on stdio with the SDK as the `roster[mcp]` extra (`mcp>=2.3,<3`, and the Python 3.10 call from §6): the seven tools of §2, with `check`/`check_host` refused until ticket 2's grants exist. The closed-tool-list test, errors as tool errors, one check at a time. Its cli-reference section, errors rows, a news line.
2. **Grants and the ceiling.** `~/.config/roster/mcp.yml` (Pydantic model, `version: 1`, `0600`, refused if anyone else can write it), keyed by profile and Inventory; `check: true` turns on `check`/`check_host`. `roster mcp grants` to view the effective grants. The `roster.yml` key `mcp: false` on a Host or group, which no grant overrides (with its `roster.yml` docs row). The `default` profile.
3. **The audit log.** Daily JSONL under `$XDG_STATE_HOME/roster/mcp/` (`%LOCALAPPDATA%\roster\mcp\`), `O_APPEND` lines, §5's fields, `jsonout.redact`/`redact_error`, `run`'s output size only, files older than 30 days deleted at start; `roster mcp log`.
4. **Actions: `run` and `web`, allow-only.** Per-Host grants from ticket 2 under the ceiling; no `ask`, no `sudo`; `web` `GET`/`HEAD` unless the entry lists `methods:`. The edges from §4: `web`'s body is literal text (no `@FILE`), no `--insecure` input, `die()`/`SystemExit` becomes a tool error, and `roster setup`'s `.claude/settings.json` deny rules add `mcp.yml`. One action at a time, 30 a minute.
5. **`security.md` and the setup docs.** A `roster mcp` section in `security.md` (what reaches the model, what's logged, what the profile, grants and ceiling are worth, the shell-agent caveat), and a page for adding `roster mcp` to Claude Desktop and other MCP clients.

## Appendix: research notes

Checked against primary sources on 2026-11-05. MCP's current protocol version is **2026-07-28** ([versioning](https://modelcontextprotocol.io/specification/versioning): "The current protocol version is 2026-07-28"); the one before it, **2025-11-25**, is the last with the `initialize` handshake. Clients of both are in use.

### Verified claims

Each claim the ADR leans on, and where it holds:

- **2026-07-28 has no `initialize` handshake; version and capabilities ride on each request's `_meta`, and identity may too.** Holds. The changelog's major change 2: "Make MCP stateless: remove the `initialize`/`notifications/initialized` handshake. Every request now carries its protocol version and client capabilities in `_meta` (`io.modelcontextprotocol/protocolVersion`, `io.modelcontextprotocol/clientCapabilities`). Clients SHOULD identify themselves on each request (`io.modelcontextprotocol/clientInfo`)" ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)). The `_meta` table marks `protocolVersion` and `clientCapabilities` required and `clientInfo` optional ([_meta](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#meta)). Precisely: identity is a SHOULD, not a must, and it's unverified.
- **On a 2026-07-28 connection a stdio server can't send requests to the client.** Holds for that version: "The server MUST NOT write JSON-RPC requests to `stdout`. Server-to-client interactions are carried in `InputRequiredResult` replies" ([stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)); "The previous pattern of server-initiated requests is no longer supported. This is a breaking change" ([MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)). It doesn't hold for a client speaking 2025-11-25: a dual-version server still answers its `initialize` and serves it by that version's rules, which include server-to-client `elicitation/create` ([versioning and compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#backward-compatibility-with-initialization-based-versions)).
- **The elicitation flow on 2026-07-28 is `InputRequiredResult`.** Holds: changelog major change 7, "Servers return an `InputRequiredResult` (`resultType: "input_required"`) whose `inputRequests` field carries the requests … Clients respond with `inputResponses` on a retry of the original request". `requestState` is opaque to the client and echoed back; servers "MUST treat `requestState` as an attacker-controlled input" and, where it influences authorization, "MUST protect its integrity (e.g. HMAC or AEAD)"; only `tools/call`, `prompts/get` and `resources/read` may return one ([MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)). (Moot for roster's first actions release, which asks nothing; recorded for a later `ask`.)
- **SDK 2.3.0, Python >=3.10, MIT.** Holds for the release: PyPI's 2.3.0 metadata says `requires_python >=3.10`, licence MIT, uploaded 2026-10-02 ([PyPI JSON](https://pypi.org/pypi/mcp/2.3.0/json)); the `v2.3.0` tag's `pyproject.toml` says `requires-python = ">=3.10"` and `license = { text = "MIT" }` ([pyproject at v2.3.0](https://github.com/modelcontextprotocol/python-sdk/blob/v2.3.0/pyproject.toml)); the repository's licence is MIT ([LICENSE](https://github.com/modelcontextprotocol/python-sdk/blob/main/LICENSE)); `v2.3.0` is the latest GitHub release (2026-10-02, [releases](https://github.com/modelcontextprotocol/python-sdk/releases/tag/v2.3.0)). **Correction:** it no longer holds on `main`, which says `>=3.11` since "Drop support for Python 3.10 (#3690)", 2026-10-12 ([commit](https://github.com/modelcontextprotocol/python-sdk/commit/c4492554da517f93ddd52b072d9c4d07292f1161)); see §6.

### MCP: stdio

- The client launches the server as a subprocess; newline-delimited JSON-RPC on stdin/stdout, no embedded newlines; the server may log anything to stderr and must write nothing but MCP messages to stdout ([2026-07-28 stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio), [2025-11-25 transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#stdio)).
- Shutdown: the client closes stdin, waits, then terminates. "Servers SHOULD exit promptly when their standard input is closed."
- 2026-07-28 is stateless: "Servers MUST NOT rely on prior requests over the same connection to establish context (e.g., capabilities, protocol version, client identity)" ([basic, statelessness](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#statelessness)).
- A dual-version server answers `initialize` with the old semantics and per-request `_meta` with the new; a client that speaks both probes with `server/discover` first ([versioning and compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)).

### MCP: client identity

- 2025-11-25: `clientInfo` (`name`, `title`, `version`, `description`, `icons`, `websiteUrl`) in `initialize` ([lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#initialization)); nothing in the spec verifies it.
- 2026-07-28: "`io.modelcontextprotocol/clientInfo` and `io.modelcontextprotocol/serverInfo` are self-reported by the sender and are not verified by the protocol. They are intended for display, logging, and debugging. Implementations SHOULD NOT use them to change the behavior of the client or server, and SHOULD NOT rely on them for security decisions" ([_meta](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#meta)).
- Authorization is for HTTP: "Implementations using an STDIO transport SHOULD NOT follow this specification, and instead retrieve credentials from the environment" ([authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)).
- Elicitation's security considerations: "Servers MUST NOT rely on client-provided user identification without server verification, as this can be forged."

### MCP: elicitation

- Two modes: **form** (structured data, a flat schema of primitive fields, the data passes through the client) and **URL** (out-of-band, for secrets). "Servers MUST NOT use form mode elicitation to request sensitive information such as passwords, API keys, access tokens, or payment credentials." Clients "MUST provide UI that makes it clear which server is requesting information" and offer decline and cancel ([2026-07-28 elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)).
- A capability the client declares (`elicitation: {form: {}, url: {}}`, in `_meta.io.modelcontextprotocol/clientCapabilities` on 2026-07-28); servers must not use a mode the client didn't declare. Answers are `accept` (with content), `decline` or `cancel`.
- 2025-11-25: a server-to-client `elicitation/create` request during the call ([2025-11-25 elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)). 2026-07-28: the call returns an `InputRequiredResult` holding the `elicitation/create`, and the client retries the call with `inputResponses`.

### MCP: tools

- A tool has `name`, `title`, `description`, `inputSchema` (JSON Schema 2020-12; no parameters: `{"type": "object", "additionalProperties": false}`), optional `outputSchema` and `annotations` ([tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)).
- With an `outputSchema`, "Servers MUST provide structured results that conform to this schema"; a tool that returns `structuredContent` "SHOULD also return the serialized JSON in a TextContent block."
- Errors: protocol errors (unknown tool, malformed request) vs tool execution errors (`isError: true`), which the model sees and can correct.
- "Clients MUST consider tool annotations to be untrusted unless they come from trusted servers." Servers "MUST: validate all tool inputs, implement proper access controls, rate limit tool invocations, sanitize tool outputs."

### The official Python SDK

- PyPI `mcp` 2.3.0 (2026-10-02), from github.com/modelcontextprotocol/python-sdk ([PyPI](https://pypi.org/project/mcp/)). Its `requires_dist`: `anyio>=4.9`, `httpx2>=2.10.0`, `jsonschema>=4.20.0`, `mcp-types==2.3.0` (which needs only `pydantic>=2.12.0` and `typing-extensions`), `opentelemetry-api>=1.28.0`, `pydantic>=2.12.0`, `pyjwt[crypto]>=2.10.1`, `python-multipart>=0.0.9`, `pywin32>=311` (Windows), `sse-starlette>=3.0.0`, `starlette>=0.27`, `typing-extensions>=4.13.0`, `typing-inspection>=0.4.1`, `uvicorn>=0.31.1`; extras `cli` (typer, python-dotenv) and `rich`.
- Releases: 2.0.0 on 2026-07-28 (with the protocol), 2.1.0 2026-08-24, 2.2.0 2026-09-07, 2.3.0 2026-10-02; 1.x continues (1.30.0, 2026-09-07).
- Versioning: semver; a minor may raise a dependency floor or drop "a Python version after its upstream end-of-life", called out in the release notes ([VERSIONING.md](https://github.com/modelcontextprotocol/python-sdk/blob/main/VERSIONING.md)).
- v2: `FastMCP` renamed `MCPServer` (the old import removed); the stdio server serves both protocol versions with nothing to configure; protocol types in `mcp-types`; "Raising `MCPError` inside a tool is now a protocol error that the model never sees", other exceptions become error results, and only a `ToolError`'s message reaches the model; "v1.x is not going anywhere. It moves to maintenance, keeps getting critical fixes and security patches" ([what's new in v2](https://py.sdk.modelcontextprotocol.io/whats-new/)).
- Structured output: "the return type annotation is the output schema"; a Pydantic model's schema is the model itself, unwrapped, and the value is validated before it leaves the server; `structured_output=False` turns that off ([structured output](https://py.sdk.modelcontextprotocol.io/servers/structured-output/)).
- Elicitation: a parameter `Annotated[T, Resolve(fn)]` is filled before the tool runs and works on every connection; `ctx.elicit()` in a tool body is a server-to-client request: "On a 2026-07-28 connection there are no server-initiated requests, so these calls fail" ([elicitation](https://py.sdk.modelcontextprotocol.io/handlers/elicitation/)).

### Comparables

- **XPipe** ([MCP guide](https://docs.xpipe.io/guide/mcp)): an MCP server inside the desktop app, disabled by default, Streamable HTTP only (SSE clients get an error), local clients authenticate with an API key. Tools named on the page: `list_files` (read, optionally recursive) and `call_api` (XPipe's HTTP API, which can add, modify or remove connection entries); the page says the person must "explicitly enable every kind of actions that can potentially modify a system" and recommends configuring the client to confirm tool calls. The global MCP context setting and connection notes are given to the agent. The page doesn't say whether secrets can reach the model, and doesn't mention logging. XPipe's HTTP API has a secret-decrypt endpoint ([API](https://docs.xpipe.io/api), as competitors.md notes).
- **Devolutions RDM**: MCP server and AI assistant since 2026.1 ([2026.1](https://devolutions.net/blog/whats-new-in-devolutions-remote-desktop-manager-20261/)); commands run "directly in RDP, via the Devolutions Agent, or via SSH sessions". The vendor's brief says the transport is "user-scoped" named pipes bridged through stdio, "Mandatory authorization for every AI action" through an MCP Connection Prompt, and that RDM "injects them directly into remote sessions, preventing the model from ever seeing or processing them" ([brief](https://devolutions.net/blog/ema-impact-brief-why-devolutions-rdm-mcp-server-sets-a-new-standard-for-secure-ai-automation/)). 2026.2 adds approval modes, "Default approvals" for change control and "Bypass approvals" for labs and demos ([2026.2](https://devolutions.net/blog/ai-assistant-in-remote-desktop-manager-20262/)). Neither page lists the tools or describes an audit log. Vendor claims, not checked.
- **Teleport** ([MCP access](https://goteleport.com/docs/enroll-resources/mcp-access/getting-started/)): the client starts `tsh mcp connect SERVER` on stdio, `tsh` authenticates with the person's Teleport identity (`tsh login`, or an identity file for automation), and Teleport proxies to the MCP server, which its Application Service runs. Access is RBAC: the preset `mcp-user` role allows MCP apps by label and `mcp.tools: ['*']`; Teleport "logs MCP protocol requests as audit events". No approval flow on that page.
