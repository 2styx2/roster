//! The Mesh: the Hosts of a `mesh: true` group ssh to each other. Stateless:
//! nothing is kept on the Box. Each Host is read (`sh/mesh-read.sh`), a pure
//! planner turns the Inventory plus what was read into a [`Todo`] per Host,
//! and `sh/mesh-apply.sh` makes it so, one Host at a time.
//!
//! Who reaches whom is a set of (source, peer) pairs ([`pairs`]); Links add
//! more pairs. Only `roster-mesh:SRC@BOX` lines and keys whose `.pub` carries
//! `@BOX` are ever changed or deleted.

use crate::inventory::{Host, Inventory};
use crate::{errors, hosts, remote};
use std::collections::{BTreeMap, BTreeSet};

const READ: &str = include_str!("sh/mesh-read.sh");
const APPLY: &str = include_str!("sh/mesh-apply.sh");
/// v0.7.0's mark above the Mesh's Include in `~/.ssh/config`.
const MARK: &str =
    "# roster-mesh: the Mesh's ssh config (roster mesh adds and removes these two lines)";
/// v0.7.0's first line of a Host's `~/ROSTER.md`, up to the source's name.
const MD_MARK: &str = "<!-- roster-mesh: written by roster for ";
const CONFIG_MARK: &str = "# Written by roster mesh for ";
const OPTS: [&str; 4] = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

/// What the read script found on a Host.
#[derive(Default, Clone)]
pub struct Seen {
    home: Option<String>,
    /// Each Mesh key by file name: whether the private key is there, and
    /// its `.pub` line.
    keys: BTreeMap<String, (bool, Option<String>)>,
    include: bool,
    mark: bool,
    claude: bool,
    import: bool,
    /// Root's home, when the login isn't root and `sudo -n` works.
    root: Option<String>,
    /// The login isn't root and `sudo -n` asks for a password.
    nosudo: bool,
    /// Root's CLAUDE.md imports the login's ROSTER.md / root's ssh config
    /// has the Include / roster's mark.
    rimport: bool,
    rinclude: bool,
    rmark: bool,
    /// `config`, `known_hosts` (in `~/.ssh/roster-mesh`), `ROSTER.md`,
    /// `settings.json` (`~/.claude`'s) and `root-settings.json`.
    files: BTreeMap<String, String>,
    /// authorized_keys lines tagged `roster-mesh:SRC@BOX`.
    lines: Vec<String>,
}

/// What one Host needs. A source's part is left alone when `problem` says why.
#[derive(Default)]
pub struct Todo {
    problem: Option<String>,
    /// The Host's Mesh files are another Box's: left alone, and not a
    /// failure (two Boxes may share an Inventory; one of them runs its Mesh).
    foreign: bool,
    /// Root is left out: `sudo -n` asks for a password there.
    nosudo: bool,
    warn: Option<String>,
    make: Option<String>,
    drop_keys: Vec<String>,
    put: Vec<(&'static str, String)>,
    drop: Vec<&'static str>,
    /// Some(true): add the Include (or the import); Some(false): remove it.
    include: Option<bool>,
    import: Option<bool>,
    /// The same for root's ssh config and CLAUDE.md.
    rinclude: Option<bool>,
    rimport: Option<bool>,
    /// `~/.claude/settings.json`'s new text ("" removes it), and root's.
    settings: Option<String>,
    rsettings: Option<String>,
    /// Root's own copy of the Mesh config (ssh refuses one another user
    /// owns): its new text, or "" to remove it.
    rconfig: Option<String>,
    /// (source, its line; None until its key is made).
    add: Vec<(String, Option<String>)>,
    /// (source, the exact line there now).
    del: Vec<(String, String)>,
}

impl Todo {
    /// Nothing for the apply script to do (a line waiting for a key isn't).
    fn is_empty(&self) -> bool {
        self.make.is_none()
            && self.drop_keys.is_empty()
            && self.put.is_empty()
            && self.drop.is_empty()
            && self.include.is_none()
            && self.import.is_none()
            && self.rinclude.is_none()
            && self.rimport.is_none()
            && self.settings.is_none()
            && self.rsettings.is_none()
            && self.rconfig.is_none()
            && self.add.iter().all(|(_, l)| l.is_none())
            && self.del.is_empty()
    }

    /// Each change as (what `--dry-run` says after "would ", what's said once done).
    fn says(&self) -> Vec<(String, String)> {
        let mut out = Vec::new();
        let json = |s: &Option<String>, whose: &str| match s.as_deref() {
            None => None,
            Some("") => Some(format!("remove {whose}~/.claude/settings.json")),
            Some(_) => Some(format!("write {whose}~/.claude/settings.json")),
        };
        let both = |a: String| (a.clone(), done(&a));
        let early = [json(&self.settings, ""), json(&self.rsettings, "root's ")];
        out.extend(early.into_iter().flatten().map(both));
        if self.rimport == Some(false) {
            out.push(both(
                "remove the import from root's ~/.claude/CLAUDE.md".into(),
            ));
        }
        if self.rinclude == Some(false) {
            out.push(both("remove the Include from root's ~/.ssh/config".into()));
        }
        if self.rconfig.as_deref() == Some("") {
            out.push(both("remove root's ~/.ssh/roster-mesh.config".into()));
        }
        let mut say = |a: String, b: String| out.push((a, b));
        let dir = "~/.ssh/roster-mesh";
        let file = |f: &str| match f {
            "ROSTER.md" => "~/ROSTER.md".to_string(),
            f => format!("{dir}/{f}"),
        };
        if self.import == Some(false) {
            say(
                "remove the import from ~/.claude/CLAUDE.md".into(),
                "removed the import from ~/.claude/CLAUDE.md".into(),
            );
        }
        if self.include == Some(false) {
            say(
                "remove the Include from ~/.ssh/config".into(),
                "removed the Include from ~/.ssh/config".into(),
            );
        }
        for f in &self.drop {
            say(
                format!("remove {}", file(f)),
                format!("removed {}", file(f)),
            );
        }
        for k in self
            .drop_keys
            .iter()
            .filter(|k| self.make.as_ref() != Some(k))
        {
            say(
                format!("remove the Mesh key {dir}/{k}"),
                format!("removed the Mesh key {dir}/{k}"),
            );
        }
        if let Some(k) = &self.make {
            say(
                format!("make the Mesh key {dir}/{k}"),
                format!("made the Mesh key {dir}/{k}"),
            );
        }
        for (f, _) in &self.put {
            say(format!("write {}", file(f)), format!("wrote {}", file(f)));
        }
        if self.include == Some(true) {
            say(
                "add the Include to ~/.ssh/config".into(),
                "added the Include to ~/.ssh/config".into(),
            );
        }
        if self.import == Some(true) {
            say(
                "add the import to ~/.claude/CLAUDE.md".into(),
                "added the import to ~/.claude/CLAUDE.md".into(),
            );
        }
        if self.rconfig.as_deref().is_some_and(|c| !c.is_empty()) {
            let a = "write root's ~/.ssh/roster-mesh.config";
            say(a.into(), done(a));
        }
        for (on, what) in [
            (self.rinclude, "the Include to root's ~/.ssh/config"),
            (self.rimport, "the import to root's ~/.claude/CLAUDE.md"),
        ] {
            if on == Some(true) {
                say(format!("add {what}"), format!("added {what}"));
            }
        }
        for (src, _) in &self.del {
            say(
                format!("remove {src}'s key"),
                format!("removed {src}'s key"),
            );
        }
        for (src, line) in &self.add {
            match line {
                Some(_) => say(format!("add {src}'s key"), format!("added {src}'s key")),
                None => say(format!("add {src}'s key once it's made"), String::new()),
            }
        }
        out
    }
}

/// "remove the X" said once done: "removed the X".
fn done(would: &str) -> String {
    let (verb, rest) = would.split_once(' ').unwrap_or((would, ""));
    let verb = match verb {
        "remove" => "removed",
        "write" => "wrote",
        v => v,
    };
    format!("{verb} {rest}")
}

/// A settings file's new text with (`on`) or without roster's rules for
/// Claude, or None; a warning instead when it isn't JSON.
fn rules(s: &Seen, file: &str, on: bool, warn: &mut Option<String>) -> Option<String> {
    let path = match file {
        "settings.json" => "~/.claude/settings.json",
        _ => "root's ~/.claude/settings.json",
    };
    let old = s.files.get(file).map(String::as_str);
    crate::claude::rules(old, on, &crate::claude::USER).unwrap_or_else(|()| {
        *warn = Some(format!("{path} isn't valid JSON; left alone"));
        None
    })
}

/// Why a Host can't take part, if it can't: only Enrolled, reviewed, POSIX
/// Hosts without settings v1 doesn't follow are visited.
pub fn left_out(h: &Host) -> Option<String> {
    match h.mesh_unsupported {
        _ if !h.reviewed => Some("unreviewed".into()),
        _ if !h.enroll => Some("a Password Host (enroll: false)".into()),
        _ if h.os == "windows" => Some("os: windows".into()),
        Some(key) => Some(format!("{key} isn't supported yet")),
        None => None,
    }
}

/// Who reaches whom, as (source, peer) indexes into `inv.hosts`: the Hosts
/// of a group with `mesh: true` (from `defaults`, the group or the Host;
/// `mesh: false` opts out) reach each other. Each Link adds its ends' pairs,
/// both ways with `both: true`. Also returns a line for each Host left out
/// and each Link skipped.
pub fn pairs(inv: &Inventory) -> (BTreeSet<(usize, usize)>, Vec<String>) {
    let hosts = &inv.hosts;
    let ok = |i: usize| hosts[i].mesh != Some(false) && left_out(&hosts[i]).is_none();
    let meshed: Vec<usize> = (0..hosts.len())
        .filter(|&i| hosts[i].mesh == Some(true) && ok(i))
        .collect();
    let mut out = BTreeSet::new();
    for &a in &meshed {
        for &b in &meshed {
            if a != b && hosts[a].group == hosts[b].group {
                out.insert((a, b));
            }
        }
    }
    // Hosts named for the Mesh, by `mesh: true` or a Link, that can't take part.
    let mut named: BTreeSet<usize> = (0..hosts.len())
        .filter(|&i| hosts[i].mesh == Some(true))
        .collect();
    // A Link's end: the Host of that name, or every Host of that group.
    let mut end = |name: &str| -> Vec<usize> {
        let host = hosts.iter().position(|h| h.name == name);
        let all = (0..hosts.len()).filter(|&i| host.map_or(hosts[i].group == name, |h| h == i));
        named.extend(all.clone().filter(|&i| hosts[i].mesh != Some(false)));
        all.filter(|&i| ok(i)).collect()
    };
    let mut skipped = Vec::new();
    for l in &inv.links {
        if let Some(via) = &l.via {
            let arrow = if l.both { "<->" } else { "->" };
            skipped.push(format!(
                "roster: link {} {arrow} {} via {via}: skipped: via isn't supported yet",
                l.from, l.to
            ));
            continue;
        }
        let to = end(&l.to);
        for a in end(&l.from) {
            for &b in to.iter().filter(|&&b| b != a) {
                out.insert((a, b));
                if l.both {
                    out.insert((b, a));
                }
            }
        }
    }
    let why = named.into_iter().filter_map(|i| {
        let h = &hosts[i];
        left_out(h).map(|why| format!("roster: {}: left out of the Mesh: {why}", h.name))
    });
    (out, why.chain(skipped).collect())
}

/// The Mesh key's file name for a key type: v0.7.0's names.
fn key_file(key_type: &str) -> String {
    match key_type {
        "ed25519" => "id_ed25519".into(),
        t => format!("roster_mesh_{t}"),
    }
}

/// A `.pub` line is this Box's: its comment is `roster-mesh:SRC@BOX`.
fn ours(public: &str, box_name: &str) -> bool {
    let tag = public.split_whitespace().last().unwrap_or_default();
    tag.strip_prefix("roster-mesh:")
        .and_then(|t| t.rsplit_once('@'))
        .is_some_and(|(src, owner)| !src.is_empty() && owner == box_name)
}

/// The source a tagged line is for.
fn source_of(line: &str) -> &str {
    let tag = line.rsplit(' ').next().unwrap_or_default();
    let tag = tag.strip_prefix("roster-mesh:").unwrap_or(tag);
    tag.rsplit_once('@').map_or(tag, |(src, _)| src)
}

/// The peer's authorized_keys line for `src`'s key.
fn key_line(src: &Host, public: &str, box_name: &str) -> String {
    let mut f = public.split_whitespace();
    let (kind, key) = (f.next().unwrap_or_default(), f.next().unwrap_or_default());
    format!(
        "from=\"{}\",no-agent-forwarding,no-X11-forwarding {kind} {key} roster-mesh:{}@{box_name}",
        src.ip, src.name
    )
}

/// The plan: what each Host needs, from the Inventory, the pairs, what was
/// read on each Host (None: not reached), and the Box's known_hosts text.
/// Pure: no I/O.
pub fn plan(
    inv: &Inventory,
    pairs: &BTreeSet<(usize, usize)>,
    seen: &[Option<Seen>],
    known: &str,
) -> Vec<Todo> {
    let bx = &inv.box_name;
    let mut todo: Vec<Todo> = seen.iter().map(|_| Todo::default()).collect();
    // A source's key: Some(pub) to use, None while it's made or unknown.
    let mut key: Vec<Option<String>> = vec![None; seen.len()];
    for (i, s) in seen.iter().enumerate() {
        let Some(s) = s else { continue };
        let (h, t) = (&inv.hosts[i], &mut todo[i]);
        let peers: Vec<&Host> = pairs
            .iter()
            .filter(|(a, _)| *a == i)
            .map(|&(_, b)| &inv.hosts[b])
            .collect();
        let config_ours = |text: &str| {
            text.lines().next().is_some_and(|l| {
                l.starts_with(CONFIG_MARK) && l.contains(&format!(" (owner {bx}) "))
            })
        };
        let md_ours = |text: &str| {
            text.lines()
                .next()
                .is_some_and(|l| l.starts_with(MD_MARK) && l.contains(&format!(" (owner {bx});")))
        };
        let pub_ours = |k: &(bool, Option<String>)| k.1.as_deref().is_some_and(|p| ours(p, bx));
        if peers.is_empty() {
            // Not a source: this Box's Mesh files there go, evidence last.
            let config = s.files.get("config").map(|c| config_ours(c));
            let any_key = s.keys.values().any(pub_ours);
            let md = s.files.get("ROSTER.md").is_some_and(|m| md_ours(m));
            if md && s.import {
                t.import = Some(false);
            }
            if md {
                t.settings = rules(s, "settings.json", false, &mut t.warn);
                t.rsettings = rules(s, "root-settings.json", false, &mut t.warn);
            }
            if s.rimport {
                t.rimport = Some(false);
            }
            if s.files.get("root-config").is_some_and(|c| config_ours(c)) {
                t.rconfig = Some(String::new());
            }
            if (s.rinclude || s.rmark) && config != Some(false) {
                t.rinclude = Some(false);
            }
            if (s.include || s.mark) && config != Some(false) {
                t.include = Some(false);
            }
            if md {
                t.drop.push("ROSTER.md");
            }
            if s.files.contains_key("known_hosts") && (config == Some(true) || any_key) {
                t.drop.push("known_hosts");
            }
            if config == Some(true) {
                t.drop.push("config");
            }
            t.drop_keys = s
                .keys
                .iter()
                .filter(|(_, k)| pub_ours(k))
                .map(|(n, _)| n.clone())
                .collect();
            continue;
        }
        let want = key_file(&h.key_type);
        let Some(home) = &s.home else {
            t.problem = Some("didn't say where its home is".into());
            continue;
        };
        if s.files.get("config").is_some_and(|c| !config_ours(c)) {
            t.problem = Some("~/.ssh/roster-mesh/config isn't this Box's; left alone".into());
            t.foreign = true;
            continue;
        }
        match s.keys.get(&want) {
            None => t.make = Some(want.clone()),
            Some(k @ (true, Some(p))) if pub_ours(k) => key[i] = Some(p.clone()),
            Some(k @ (false, Some(_))) if pub_ours(k) => {
                t.drop_keys.push(want.clone());
                t.make = Some(want.clone());
            }
            Some(_) => {
                t.problem = Some(format!(
                    "~/.ssh/roster-mesh/{want} isn't a Mesh key this Box made; left alone"
                ));
                continue;
            }
        }
        // A key of another type this Box made (key_type changed) goes.
        for (n, k) in &s.keys {
            if *n != want && pub_ours(k) {
                t.drop_keys.push(n.clone());
            }
        }
        let dir = format!("{home}/.ssh/roster-mesh");
        let conf = config(inv, h, &peers, &dir, &want);
        let files = [
            ("config", conf.clone()),
            ("known_hosts", known_hosts(&peers, known)),
            ("ROSTER.md", roster_md(inv, h, &peers)),
        ];
        for (name, text) in files {
            let now = s.files.get(name);
            if name == "ROSTER.md" && now.is_some_and(|m| !md_ours(m)) {
                t.warn = Some("~/ROSTER.md isn't the Mesh's; left alone".into());
                continue;
            }
            if now.map(|n| n.trim_end()) != Some(text.trim_end()) {
                t.put.push((name, text));
            }
        }
        if !s.include {
            t.include = Some(true);
        }
        // Claude, for the login and for root: `claude: false` takes it out.
        let on = inv.claude;
        if s.claude {
            if on != s.import {
                t.import = Some(on);
            }
            t.settings = rules(s, "settings.json", on, &mut t.warn);
        }
        if s.root.is_some() {
            if on != s.rinclude {
                t.rinclude = Some(on);
            }
            if on != s.rimport {
                t.rimport = Some(on);
            }
            t.rsettings = rules(s, "root-settings.json", on, &mut t.warn);
            let now = s.files.get("root-config");
            t.rconfig = match on {
                true if now.map(|n| n.trim_end()) != Some(conf.trim_end()) => Some(conf),
                false if now.is_some_and(|c| config_ours(c)) => Some(String::new()),
                _ => None,
            };
        } else if s.nosudo && on {
            t.nosudo = true;
        }
    }
    // Peers: each Host gets its sources' lines; a line for a source that
    // wasn't read (or was left alone) stays as it is.
    for (p, s) in seen.iter().enumerate() {
        let Some(s) = s else { continue };
        let mut want: Vec<(String, Option<String>)> = Vec::new();
        let mut keep: Vec<&str> = Vec::new();
        for &(a, _) in pairs.iter().filter(|(_, b)| *b == p) {
            let src = &inv.hosts[a];
            match (&seen[a], &key[a], &todo[a]) {
                (Some(_), Some(public), _) => {
                    want.push((src.name.clone(), Some(key_line(src, public, bx))))
                }
                (Some(_), None, t) if t.make.is_some() => want.push((src.name.clone(), None)),
                _ => keep.push(&src.name),
            }
        }
        let t = &mut todo[p];
        for line in s.lines.iter().filter(|l| ours(l, bx)) {
            let src = source_of(line);
            let wanted = want.iter().any(|(_, l)| l.as_deref() == Some(line));
            if !wanted && !keep.contains(&src) {
                t.del.push((src.to_string(), line.clone()));
            }
        }
        for (src, line) in want {
            if line.as_ref().is_none_or(|l| !s.lines.contains(l)) {
                t.add.push((src, line));
            }
        }
    }
    todo
}

/// The source's Mesh ssh config, as v0.7.0 writes it.
fn config(inv: &Inventory, src: &Host, peers: &[&Host], dir: &str, key: &str) -> String {
    let file = inv
        .path
        .file_name()
        .map(|f| f.to_string_lossy().into_owned());
    let mut out = format!(
        "{CONFIG_MARK}{} (owner {}) from {}: the Hosts {} reaches. Don't edit by hand.\n",
        src.name,
        inv.box_name,
        file.unwrap_or_default(),
        src.name
    );
    for p in peers {
        out += &format!(
            "\nHost {}\n    HostName {}\n    User {}\n    Port {}\n    UserKnownHostsFile {dir}/known_hosts\n    \
             StrictHostKeyChecking yes\n    ConnectTimeout 10\n    IdentityFile {dir}/{key}\n    IdentitiesOnly yes\n",
            p.name,
            p.ip.replace('%', "%%"),
            p.user,
            p.port
        );
    }
    out
}

/// The peers' host keys, from the Box's own known_hosts.
fn known_hosts(peers: &[&Host], known: &str) -> String {
    let mut out = String::new();
    for p in peers {
        let at = hosts::known_as(p);
        for l in known.lines() {
            let names = l.split_whitespace().next().unwrap_or_default();
            if names.split(',').any(|n| n == at) {
                out += l;
                out.push('\n');
            }
        }
    }
    out
}

/// The source's `~/ROSTER.md`: the peers Claude there may reach.
fn roster_md(inv: &Inventory, src: &Host, peers: &[&Host]) -> String {
    let mut out = format!(
        "{MD_MARK}{} (owner {}); roster mesh rewrites it, don't edit by hand -->\n\
         # Hosts {} can reach\n\n\
         From this Host, `ssh <name>` logs in to the Hosts below as their own user. \
         No password or vault is kept on this Host.\n\n\
         - **access = key**: `ssh <name> '<command>'` works without a password.\n\
         - Never read, print or copy the Mesh's private key, and ask before changing \
         anything on another Host.\n\n\
         | name | address | access |\n|---|---|---|\n",
        src.name, inv.box_name, src.name
    );
    if inv.claude {
        let at = out.find("- Never read").unwrap_or(out.len());
        out.insert_str(at, crate::claude::GRANT);
    }
    for p in peers {
        out += &format!("| {} | {}@{}:{} | key |\n", p.name, p.user, p.ip, p.port);
    }
    out
}

/// Parse the read script's report; None when it was cut short (no `home`
/// or no `end`, as in empty output).
fn parse(out: &str) -> Option<Seen> {
    let mut s = Seen::default();
    let mut file: Option<String> = None;
    let mut end = false;
    for l in out.lines() {
        if let Some(text) = l.strip_prefix('|') {
            let f = s.files.entry(file.clone()?).or_default();
            f.push_str(text);
            f.push('\n');
            continue;
        }
        let (word, rest) = l.split_once(' ').unwrap_or((l, ""));
        match word {
            "home" => s.home = Some(rest.into()),
            "key" => s.keys.entry(rest.into()).or_default().0 = true,
            "pub" => {
                let (name, text) = rest.split_once(' ').unwrap_or((rest, ""));
                s.keys.entry(name.into()).or_default().1 = Some(text.into());
            }
            "include" => s.include = true,
            "mark" => s.mark = true,
            "claude" => s.claude = true,
            "import" => s.import = true,
            "sudo" => s.root = Some(rest.into()),
            "nosudo" => s.nosudo = true,
            "rimport" => s.rimport = true,
            "rinclude" => s.rinclude = true,
            "rmark" => s.rmark = true,
            "file" => {
                s.files.insert(rest.into(), String::new());
                file = Some(rest.into());
            }
            "nonl" => _ = s.files.get_mut(file.as_ref()?)?.pop(),
            "line" => s.lines.push(rest.into()),
            "end" => end = true,
            _ => return None,
        }
    }
    (end && s.home.is_some()).then_some(s)
}

/// Run `script` (and then the read script) on `h`; what was read, or why not.
fn visit(inv: &Inventory, h: &Host, vars: &[(&str, &str)], script: &str) -> Result<Seen, String> {
    let mut all = vec![
        ("BOX", inv.box_name.as_str()),
        ("MARK", MARK),
        ("NAME", h.name.as_str()),
    ];
    all.extend_from_slice(vars);
    let ran = remote::run(
        &h.name,
        &OPTS,
        &remote::script(&all, &format!("{script}{READ}")),
        None,
    )
    .map_err(|e| errors::spawn("ssh", &e))?;
    let why = format!("the Mesh script failed: {}", errors::last_line(&ran.stderr));
    // PowerShell and cmd say so in their own words: the likely fix is
    // `os: windows`, which the Mesh leaves out.
    let windows = ["CommandNotFoundException", "is not recognized as"];
    match ran.code {
        0 => parse(&ran.stdout).ok_or_else(|| "its report was cut short".into()),
        255 => Err(errors::ssh(h, None, &ran.stderr)),
        _ if windows.iter().any(|w| ran.stderr.contains(w)) => {
            Err(errors::hint(why, "a Windows Host? give it `os: windows`"))
        }
        _ => Err(why),
    }
}

/// Apply `t` on `h`, then read it again.
fn apply(inv: &Inventory, h: &Host, t: &Todo) -> Result<Seen, String> {
    let keygen = crate::setup::keygen_args(&h.key_type).join(" ");
    let content = |name: &str| {
        t.put
            .iter()
            .find(|(n, _)| *n == name)
            .map_or("", |(_, c)| c.as_str())
    };
    let words = |v: &[&str]| v.join(" ");
    let put: Vec<&str> = t.put.iter().map(|(n, _)| *n).collect();
    let drop_keys: Vec<&str> = t.drop_keys.iter().map(String::as_str).collect();
    let add: Vec<&str> = t.add.iter().filter_map(|(_, l)| l.as_deref()).collect();
    let del: Vec<&str> = t.del.iter().map(|(_, l)| l.as_str()).collect();
    let flag = |f: Option<bool>| match f {
        Some(true) => "add",
        Some(false) => "remove",
        None => "",
    };
    let json = |s: &Option<String>| match s.as_deref() {
        None => "",
        Some("") => "drop",
        Some(_) => "put",
    };
    let (put, drop_keys, drop) = (words(&put), words(&drop_keys), words(&t.drop));
    let (add, del) = (add.join("\n"), del.join("\n"));
    let vars = [
        ("MAKE", t.make.as_deref().unwrap_or("")),
        ("KEYGEN", keygen.as_str()),
        ("DROPKEYS", drop_keys.as_str()),
        ("PUT", put.as_str()),
        ("C_config", content("config")),
        ("C_known_hosts", content("known_hosts")),
        ("C_md", content("ROSTER.md")),
        ("DROP", drop.as_str()),
        ("INCLUDE", flag(t.include)),
        ("IMPORT", flag(t.import)),
        ("RINCLUDE", flag(t.rinclude)),
        ("RIMPORT", flag(t.rimport)),
        ("SETTINGS", json(&t.settings)),
        ("C_settings", t.settings.as_deref().unwrap_or("")),
        ("RSETTINGS", json(&t.rsettings)),
        ("C_rsettings", t.rsettings.as_deref().unwrap_or("")),
        ("RCONFIG", json(&t.rconfig)),
        ("C_rconfig", t.rconfig.as_deref().unwrap_or("")),
        ("ADD", add.as_str()),
        ("DEL", del.as_str()),
    ];
    visit(inv, h, &vars, APPLY)
}

/// `roster setup --undo` on Host `i`: remove all of this Box's Mesh there,
/// which is the plan for no pairs at all. Ok(false): the Host refuses the
/// Box key, so nothing of this Box's is reachable there.
pub fn undo(inv: &Inventory, i: usize, dry: bool) -> Result<bool, String> {
    let h = &inv.hosts[i];
    let mut seen = vec![None; inv.hosts.len()];
    match visit(inv, h, &[], "") {
        Ok(s) => seen[i] = Some(s),
        Err(why) if why.contains("the Box key isn't accepted") => return Ok(false),
        Err(why) => return Err(why),
    }
    let t = &plan(inv, &BTreeSet::new(), &seen, "")[i];
    if !dry && !t.is_empty() {
        apply(inv, h, t)?;
    }
    for (would, done) in t.says() {
        match dry {
            true => println!("{}: would {would}", h.name),
            false => println!("{}: {done}", h.name),
        }
    }
    Ok(true)
}

/// `roster setup`'s Mesh step, on the Hosts that take the Box key (`ready`).
/// Returns how many Hosts aren't done; the next run finishes them.
pub fn run(inv: &Inventory, ready: &[&Host], dry: bool) -> usize {
    let (pairs, skipped) = pairs(inv);
    let mut tally = crate::setup::Tally::default();
    for line in &skipped {
        let why = line
            .split_once(": left out of the Mesh: ")
            .map_or("", |(_, w)| w);
        tally.note(why, line);
    }
    tally.summary("left out of the Mesh:");
    if dry {
        for &(a, b) in &pairs {
            println!("{} -> {}", inv.hosts[a].name, inv.hosts[b].name);
        }
    }
    let known = std::fs::read_to_string(crate::setup::home().join(".ssh/roster_known_hosts"))
        .unwrap_or_default();
    let mut seen: Vec<Option<Seen>> = vec![None; inv.hosts.len()];
    let mut undone = 0;
    for (i, h) in inv.hosts.iter().enumerate() {
        if left_out(h).is_some() || !ready.iter().any(|r| r.name == h.name) {
            continue;
        }
        match visit(inv, h, &[], "") {
            Ok(s) => seen[i] = Some(s),
            Err(why) => {
                eprintln!("roster: {}: Mesh: {why}", h.name);
                undone += 1;
            }
        }
    }
    let first = plan(inv, &pairs, &seen, &known);
    let mut foreign = Vec::new();
    for (h, t) in inv.hosts.iter().zip(&first) {
        if let Some(why) = &t.warn {
            eprintln!("roster: {}: warning: {why}", h.name);
        }
        if t.foreign {
            foreign.push(h.name.as_str());
        } else if let Some(why) = &t.problem {
            eprintln!("roster: {}: Mesh: {why}", h.name);
            undone += usize::from(!dry);
        }
    }
    if !foreign.is_empty() {
        eprintln!(
            "roster: the Mesh on {} is another Box's; left alone (run `roster setup` there)",
            foreign.join(", ")
        );
    }
    let nosudo: Vec<&str> = (inv.hosts.iter().zip(&first))
        .filter(|(_, t)| t.nosudo)
        .map(|(h, _)| h.name.as_str())
        .collect();
    if !nosudo.is_empty() {
        eprintln!(
            "{}",
            errors::hint(
                format!(
                    "roster: root on {} isn't set up for Claude: sudo asks for a password there",
                    nosudo.join(", ")
                ),
                "give the login passwordless sudo, or set `claude: false` in roster.yml"
            )
        );
    }
    if dry {
        for (h, t) in inv.hosts.iter().zip(&first) {
            for (todo, _) in t.says() {
                println!("{}: would {todo}", h.name);
            }
        }
        return undone;
    }
    // Hosts that make a key go first, so the rest get its line in one visit;
    // a second pass adds the keys made after a peer was visited. The plan is
    // made again only after a Host changed.
    let (mut todo, mut stale) = (Vec::new(), true);
    for _pass in 0..2 {
        let mut order: Vec<usize> = (0..seen.len()).collect();
        order.sort_by_key(|&i| first[i].make.is_none());
        for i in order {
            if stale {
                (todo, stale) = (plan(inv, &pairs, &seen, &known), false);
            }
            let (h, t) = (&inv.hosts[i], &todo[i]);
            if seen[i].is_none() || t.is_empty() {
                continue;
            }
            stale = true;
            match apply(inv, h, t) {
                Ok(s) => {
                    seen[i] = Some(s);
                    for (_, done) in t.says().into_iter().filter(|(_, d)| !d.is_empty()) {
                        println!("{}: {done}", h.name);
                    }
                }
                Err(why) => {
                    eprintln!("roster: {}: Mesh: {why}", h.name);
                    seen[i] = None;
                    undone += 1;
                }
            }
        }
    }
    undone
}
