"""Instructions for Claude: ROSTER.md, the CLAUDE.md import, Claude Code settings."""

import json
import os
from pathlib import Path
from typing import Any

from .common import find_program, replace_file, roster_command, say
from .config import access_label, load_config, shown_file
from .context import Context, box_file, current
from .errors import InventoryError
from .hosts import vault_login
from .resources import login, summary

# ---------------------------------------------------------------- Claude files


# The first line of the ROSTER.md `roster mesh` writes on a Host (mesh.roster_md), and its scripts look for
MESH_MARK = "<!-- roster-mesh: written by roster for "


def written_by_the_mesh(md: Path) -> bool:
    """Is the ROSTER.md at MD the Mesh's (T193)? On a Host that is a roster Box too, with its roster.yml in its home
    folder, its own ROSTER.md and the one `roster mesh` writes there for its peers are the same file: neither writer
    overwrites the other's."""
    try:
        with md.open(encoding="utf-8", errors="replace") as f:
            return f.readline().startswith(MESH_MARK)
    except OSError:
        return False


def shared(path: Path, text: str) -> None:
    """Write PATH whole or not at all (common.replace_file), keeping its mode; a new one is readable by others, as
    the team's files beside roster.yml are."""
    replace_file(path, text, 0o644, like=path if path.exists() else None)


def write_roster_md(cfg: dict[str, Any], ctx: Context | None = None, only_if_there: bool = False) -> bool:
    """ROSTER.md next to the Inventory CFG's roster.yml (CTX: its context, default this run's), unless it's the Mesh's;
    ONLY_IF_THERE: only a file that's there, and only when its text changes. True when it's this Inventory's (written,
    or as it should be)."""
    md = cfg["path"].parent / "ROSTER.md"
    if (only_if_there and not md.is_file()) or written_by_the_mesh(md):
        return False
    text = roster_md(cfg, ctx)
    if not (only_if_there and md.read_text() == text):
        shared(md, text)
    return True


def write_claude_files(cfg: dict[str, Any]) -> None:
    """This Inventory's ROSTER.md, its import in CLAUDE.md and Claude Code's settings beside roster.yml, then every
    other Inventory's ROSTER.md that what it says changed for (refresh_roster_md)."""
    from . import named  # Pydantic: only once it's used, never at roster's start
    if not write_roster_md(cfg):
        md = cfg["path"].parent / "ROSTER.md"
        say(f"warning      {shown_file(cfg, md, 'ROSTER.md')} is the Mesh's (another Box's `roster mesh` lists this "
            "Host's peers in it), so roster left it alone: keep roster.yml in a folder of its own, not the home folder, for this Box's ROSTER.md")
    write_claude_settings(cfg)
    agents_hook(wanted_agents_hook())
    if named.list_file().exists():
        refresh_roster_md(skip=current())


def refresh_roster_md(inv: Any = None, skip: Context | None = None) -> None:
    """Each Inventory's ROSTER.md (where one was written) again, when what it should say changed: which of its Hosts
    are left out of this Box's ssh config depends on the active Inventory and the others' Hosts. That's every named
    Inventory's and the unnamed one roster's ssh config was last written from (named.every_inventory). A file
    whose text stays the same isn't touched. SKIP: the Inventory a sync writes it for already. Each is built for its
    own Inventory: this process's (which serve's other threads read) is never switched. Never fails the command: one
    that doesn't load is left as it is."""
    from . import named  # Pydantic: only once it's used, never at roster's start
    for name, path in named.every_inventory(inv):
        if skip is not None and name == skip.name:
            continue
        try:
            write_roster_md(load_config(path), Context(name, path), only_if_there=True)
        except (InventoryError, OSError):  # a file that doesn't load keeps the ROSTER.md it has
            continue


def roster_md(cfg: dict[str, Any], ctx: Context | None = None) -> str:
    """ROSTER.md's text for the Inventory CFG (CTX: its context, default this run's). A Host whose name reaches another
    Inventory's Host from this Box (left out of its ssh config, ticket 115) is marked so: Claude must not `ssh` to it
    by name."""
    from . import named  # Pydantic: only once it's used, never at roster's start
    ctx = ctx or current()
    this = ctx.name
    left = named.left_out_hosts(ctx)
    run = roster_command()
    first = f"`{run} inv use {this}` first" if this else f"name this roster.yml (`{run} inv add`) and use it first"

    def access(h):
        if h["name"] in left and h["enroll"]:
            return f"left out: `ssh {h['name']}` reaches another Inventory's Host from this Box; {first}"
        return access_label(h)
    hosts = sorted(cfg["hosts"].values(), key=lambda h: (h["group"], h["name"]))
    groups = {}
    for h in hosts:
        groups.setdefault(h["group"], []).append(h)

    def cell(s):
        return str(s or "").replace("|", "\\|").replace("\n", " ")

    md = [f"<!-- generated by roster from {cfg['path'].name} - regenerate with `{run} sync` -->",
          "# Network access", "",
          "This machine already has access to the hosts below. Never ask the user for an IP, "
          "username or password for them - the tooling handles it.", "",
          "## How to connect",
          "- **access = key**: `ssh <name> '<command>'` (e.g. `ssh web01 'uptime'`); "
          "`scp`/`rsync` use the same names.",
          f"- **access = password** (switches, appliances): `{run} run <name> -- <command>`. "
          "The tool fetches the password itself.",
          f"- **As root**: `{run} run --sudo <name> -- <command>` (key or password hosts). roster hands sudo "
          "the login's password; don't put `sudo` in the command yourself, and never ask for the password.",
          f"- List / filter hosts: `{run} hosts` (e.g. `{run} hosts | grep db-`). "
          f"Health check: `{run} check` (add `--only <name or group>`).",
          f"- The user will often name a box by product, role or description (\"the orion dev box\", "
          f"\"the core switch\"). Look it up: `{run} hosts --find orion`, then `{run} hosts <name>`.",
          f"- **To read roster's data rather than show it** (to pick a Host, parse a check, script something), add "
          f"`--json`: `{run} hosts --json`, `{run} hosts <name> --json`, `{run} check <name> --json`. One JSON "
          "document, Logins as references only; prefer it to parsing the tables.",
          *([f"- **access = left out**: another named Inventory on this Box has a Host by that name, and a plain "
             f"`ssh <name>` reaches that one. Never `ssh` to it; the user makes this Inventory the active one first "
             f"({first})."] if any(n in left for n in cfg["hosts"]) else []),
          "- **access = unreviewed**: found by a network scan, not set up yet. Don't try to log in; "
          "tell the user it needs reviewing in roster.yml.",
          "- Web UIs: open the URL in the browser. If it shows a login page, ask the user to sign in.",
          "- A service marked **(login)** has a stored login. For its web API use "
          f"`{run} web <name> [service] GET /path` (`-d BODY` for POST/PUT): roster sends the credentials, "
          "you only see the response. Never ask the user for the login or try to fetch it, and ask before "
          "any request that changes something (POST, PUT, PATCH, DELETE).",
          f"- **Resources** (Wi-Fi networks, accounts, secrets) have no address: they're listed below and in "
          f"`{run} hosts --resources`; `{run} hosts <name>` shows one. Never run `{run} vault reveal` (or its old "
          f"name, `{run} reveal`) yourself. If the user needs a value (e.g. a Wi-Fi password), tell them to run "
          f"`{run} vault reveal <name>` in their own shell.", "",
          "## Rules",
          "- Never read, print or copy private keys (`~/.ssh/`) and never try to retrieve passwords "
          f"(don't run `bw`, `{run} vault bw` (or `{run} bw`), `op`, `{run} vault op` or any other password-manager command "
          "yourself).",
          "- If `run` says a password manager is locked or signed out, tell the user what it said; they "
          f"unlock it in their own terminal (`{run} vault unlock` for Bitwarden, `eval $(op signin)` for "
          "1Password). Don't try to unlock it yourself.",
          "- Ask before changing state on a host: restarts, installs, deletes, config edits, writes to databases.",
          f"- If a host doesn't respond, run `{run} check <name> --json` to see which step fails and its fix, "
          "and report what you find.", "",
          "## Agents",
          "Only where this machine runs herdr-core (`hc` works). Each Claude (or other agent) in a herdr terminal is an "
          "Agent, and the **Agent directory** lists every live one on the Hub and its herdr machines: address "
          "(`HOST/tN`), Host, folder, status (working, blocked, idle, done) and label. It holds no secrets and no "
          "screen text. A new session starts with a short list of the other Agents (a Claude Code SessionStart hook).",
          f"- `{run} agents` lists them (`--json` to read it; on a Host it says how old its copy is and which machine "
          "is you).",
          f"- `{run} agent read ADDRESS` shows an Agent's screen: look before you interrupt.",
          f"- `{run} agent send ADDRESS \"text\"` types a message into it and presses Enter.",
          f"- `{run} agent wait ADDRESS` waits until it stops working (`--timeout S`).",
          f"- `{run} agent label \"text\"` sets your own label (what you're on), so the others see it.",
          "- Coordinating is optional: work on your own task, and reach another Agent only when your work needs "
          "it (a hand-off, a question about its box). Never send one a secret.", "",
          "## Groups"]
    for g, hs in groups.items():
        meta = cfg["groups"].get(g, {})
        head = f"- **{g}**" + (f" - {meta['title']}" if meta.get("title") else "")
        md.append(f"{head} ({len(hs)} hosts, {'key' if all(x['enroll'] for x in hs) else 'password/mixed'} access)"
                  + (f": {meta['description']}" if meta.get("description") else ""))
    md.append("")
    if len(hosts) <= cfg["inline_limit"]:
        md += ["## Hosts", "| name | title | type | product | address | access | web UI | services | description |",
               "|---|---|---|---|---|---|---|---|---|"]
        for h in hosts:
            svc = ", ".join(f"{k}:{s['port']}" + (" (login)" if vault_login(s["auth"]) else "")
                            for k, s in h["services"].items() if k != "web" or s["override"])
            md.append(f"| {h['name']} | {cell(h['title'])} | {cell(h['type'])} | {cell(h['product'])} | "
                      f"{h['user']}@{h['ip']}:{h['port']} | {access(h)} | "
                      f"{cell(h['web'])} | {cell(svc)} | {cell(h['description'])} |")
    else:
        def counts(field):
            c = {}
            for h in hosts:
                c[h[field] or "(none)"] = c.get(h[field] or "(none)", 0) + 1
            return ", ".join(f"{k} ({v})" for k, v in sorted(c.items()))
        md += [f"{len(hosts)} hosts - too many to list here. Search with `{run} hosts --find <text>`.",
               f"- Products: {counts('product')}", f"- Types: {counts('type')}"]
    resources = sorted(cfg["resources"].values(), key=lambda r: (r["type"], r["name"]))
    if resources:
        md += ["", "## Resources", "| name | type | group | details | login | title | description |",
               "|---|---|---|---|---|---|---|"]
        md += [f"| {r['name']} | {r['type']} | {cell(r['group'])} | {cell(summary(r))} | {cell(login(r))} | "
               f"{cell(r['title'])} | {cell(r['description'])} |" for r in resources]
    return "\n".join(md) + "\n"


def write_claude_settings(cfg):
    proj = cfg["path"].parent

    claude_md = proj / "CLAUDE.md"
    text = claude_md.read_text() if claude_md.exists() else ""
    if "@ROSTER.md" not in text:
        shared(claude_md, (text.rstrip() + "\n\n" if text.strip() else "") + "@ROSTER.md\n")

    # Guardrail for Claude Code: keep Claude out of the key directory.
    settings = proj / ".claude" / "settings.json"
    data = {}
    if settings.exists():
        try:
            data = json.loads(settings.read_text())
        except json.JSONDecodeError:
            say(f"warning      {shown_file(cfg, settings, '.claude/settings.json')} isn't valid JSON - left it alone")
            data = None
    if data is not None:
        deny = data.setdefault("permissions", {}).setdefault("deny", [])
        for rule in ("Read(~/.ssh/**)", "Edit(~/.ssh/**)"):
            if rule not in deny:
                deny.append(rule)
        settings.parent.mkdir(exist_ok=True)
        shared(settings, json.dumps(data, indent=2) + "\n")
    say(f"claude       {shown_file(cfg, proj / 'ROSTER.md', 'ROSTER.md')} (imported from CLAUDE.md), .claude/settings.json")


# ---------------------------------------------------------------- the Agents' SessionStart hook (R5)

HOOK_ACTION = "agents hook"     # what the hook runs after roster's command: the short peer list (agents.hook_lines)
HOOK_TIMEOUT = 10               # seconds Claude Code gives the hook before it stops waiting


def claude_user_settings() -> Path:
    """The user's own Claude Code settings: ~/.claude/settings.json (or $CLAUDE_CONFIG_DIR's)."""
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude") / "settings.json"


def no_agents(choice: bool | None) -> None:
    """Record this Box's answer: `--no-agents` (True) or `--agents` (False); None leaves it as it was."""
    mark = box_file("no_agents")
    if choice:
        replace_file(mark, "the Agents' SessionStart hook is off: `roster sync --agents` puts it back\n", 0o644)
    elif choice is False:
        mark.unlink(missing_ok=True)


def wanted_agents_hook() -> bool:
    """Should new Claude sessions on this Box start with the peer list: herdr-core is here (`hc`), and the Box didn't
    opt out (`--no-agents`)."""
    return find_program("hc") is not None and not box_file("no_agents").exists()


def _ours(hook: Any) -> bool:
    return (isinstance(hook, dict) and hook.get("type") == "command"
            and str(hook.get("command", "")).rstrip().endswith(HOOK_ACTION))


def agents_hook(on: bool) -> None:
    """The SessionStart hook in the user's Claude settings that prints the other Agents (`roster agents hook`): there
    once (ON), or gone. Every other key and hook stays as it is; a file that isn't JSON isn't touched, and one that's
    as it should be already isn't written."""
    path = claude_user_settings()
    try:
        data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except (ValueError, OSError):
        data = None
    if not isinstance(data, dict):
        if on:
            say(f"warning      {path} isn't valid JSON - left it alone (no SessionStart hook for the Agents)")
        return
    before = json.dumps(data, sort_keys=True)
    hooks = data["hooks"] if isinstance(data.get("hooks"), dict) else {}
    kept = []
    for g in hooks.get("SessionStart") or []:
        inner = g.get("hooks") if isinstance(g, dict) else None
        if not isinstance(inner, list):
            kept.append(g)
            continue
        rest = [h for h in inner if not _ours(h)]
        if rest or not inner:
            kept.append(g if rest == inner else {**g, "hooks": rest})
    if on:
        kept.append({"hooks": [{"type": "command", "command": f"{roster_command()} {HOOK_ACTION}",
                                "timeout": HOOK_TIMEOUT}]})
    if kept:
        data["hooks"] = {**hooks, "SessionStart": kept}
    elif "hooks" in data:
        hooks = {k: v for k, v in hooks.items() if k != "SessionStart"}
        if hooks:
            data["hooks"] = hooks
        else:
            del data["hooks"]
    if json.dumps(data, sort_keys=True) == before:
        return
    replace_file(path, json.dumps(data, indent=2) + "\n", 0o600, like=path if path.exists() else None)
    shown = f"~/{path.relative_to(Path.home()).as_posix()}" if path.is_relative_to(Path.home()) else str(path)
    say(f"claude       {shown}: " + ("a SessionStart hook shows each new Claude session the other Agents "
                                    "(`roster agents hook`)" if on else "took out the Agents' SessionStart hook"))
