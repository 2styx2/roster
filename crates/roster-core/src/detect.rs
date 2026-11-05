//! Finding the Backend: where roster lives and the argv that starts `roster serve` there.
//!
//! What's looked for is a [`Choice`]: the Config's `backend` (or a development env var). On
//! Windows, `auto` looks for roster on Windows itself first ([`probe_windows`]: PATH with PATHEXT,
//! plus `%USERPROFILE%\.local\bin`, where `uv tool install` puts it; then that roster is asked which Inventory it uses), and
//! takes it if it has an Inventory; else the WSL distros, as `wsl` does. `local` is only Windows'
//! own roster. For WSL the default distro is probed first, then every other distro that's already
//! Running (`wsl.exe -l -v`), until one has both roster and an Inventory. A stopped distro other
//! than the default is never probed, because probing would boot it (see [`list_distros`]);
//! `ROSTER_APP_WSL_DISTRO=<name>` picks one distro explicitly, starting it if needed. On Linux roster runs locally. The probe is one login-shell
//! script per target; it resolves the roster program to an absolute path (`~/.local/bin` is only
//! on PATH in interactive shells on some distros) and asks that roster which `roster.yml` it uses
//! (`roster inv which`, ticket 115), so the app and the CLI agree; only a roster that can't answer
//! leaves it to the old list, which adds `~/infra/roster.yml`. `serve` then gets `-c <path>` because it isn't started from a login
//! shell, so variables like `ROSTER_CONFIG` from the user's profile never reach it. For the same
//! reason it gets the login shell's PATH (`env PATH=...`): `wsl.exe --exec` has no `~/.local/bin`,
//! and roster finds the vault CLI (`bw`) and `ssh` on PATH. No shell expands `~` in the override
//! (`ROSTER_APP_ROSTER`) either, so the probe reports the target's `$HOME` and a leading `~/` in
//! the program or its arguments is expanded with it.

use crate::config::{BackendChoice, Config};
pub use crate::env::{DISTRO_VAR, OVERRIDE_VAR};
pub use crate::error::{BackendError, ErrorKind};
pub use crate::platform::Os;
use std::process::Command;

/// Which Backend to look for: init.lua's `backend` (`auto`, `local`, `wsl`, `wsl:<distro>`), or
/// [`DISTRO_VAR`], which names one distro.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Choice {
    /// Linux: local. Windows: roster on Windows if it has an Inventory, else WSL, else whichever
    /// has roster.
    #[default]
    Auto,
    /// roster on this machine (on Windows, natively; ticket 19).
    Local,
    /// roster in WSL: in this distro, or found as Auto finds one.
    Wsl(Option<String>),
}

impl Choice {
    /// The one distro [`DISTRO_VAR`] names, as a choice; None when it's unset or blank.
    pub fn of_distro(distro: Option<&str>) -> Option<Choice> {
        distro
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .map(|d| Choice::Wsl(Some(d.to_string())))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Local,
    Wsl { distro: String },
}

impl Target {
    /// How the Backend is named in the UI (GLOSSARY: "Local" or "WSL: <distro>").
    pub fn label(&self) -> String {
        match self {
            Target::Local => "Local".into(),
            Target::Wsl { distro } => format!("WSL: {distro}"),
        }
    }

    /// `argv` run on this target: as is locally, through `wsl.exe --exec` (no shell) in WSL.
    pub fn wrap(&self, argv: &[String]) -> Vec<String> {
        match self {
            Target::Local => argv.to_vec(),
            Target::Wsl { distro } => {
                let mut v: Vec<String> = ["wsl.exe", "-d", distro, "--cd", "~", "--exec"]
                    .map(String::from)
                    .into();
                v.extend_from_slice(argv);
                v
            }
        }
    }
}

/// A Backend that's been found, ready to start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub target: Target,
    /// Starts `roster serve` on the target.
    pub serve_argv: Vec<String>,
    /// True when the probe found a `roster.yml`.
    pub has_inventory: bool,
}

#[derive(Debug, Clone)]
pub struct Output {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Runs a short command to completion, and answers what finding native Windows roster reads
/// (env vars, which files exist). The seam the detection tests script; by default nothing is set
/// and no file exists.
pub trait Runner {
    fn run(&self, argv: &[String], env: &[(&str, &str)]) -> std::io::Result<Output>;

    /// [`Runner::run`] in the folder `dir` (asking native Windows roster which Inventory it uses,
    /// from the home folder serve starts in). By default the folder is the caller's.
    fn run_in(&self, argv: &[String], env: &[(&str, &str)], _dir: &str) -> std::io::Result<Output> {
        self.run(argv, env)
    }

    /// An env var of the app's own process (`PATH`, `PATHEXT`, `USERPROFILE`, `APPDATA`, `ROSTER_CONFIG`).
    fn var(&self, _name: &str) -> Option<String> {
        None
    }

    /// Does this file exist?
    fn is_file(&self, _path: &str) -> bool {
        false
    }
}

/// How long native Windows roster may take to say which Inventory it uses (`roster inv which`)
/// before detection gives up on it and looks where it used to: a roster that hangs (an antivirus
/// scan, a home folder on a network drive) must not leave the app connecting forever. The WSL
/// probe holds `roster inv which` to the same, with `timeout` (or, where there's none, as on macOS,
/// perl's `alarm` over its own process group, so a wrapper's children stop too; with neither it
/// waits, as it did before).
pub const ASK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// `argv` with `env` added, in `dir` (or the caller's folder), waited for at most `limit` (or for
/// as long as it takes): [`crate::process::run`].
fn output(
    argv: &[String],
    env: &[(&str, &str)],
    dir: Option<&str>,
    limit: Option<std::time::Duration>,
) -> std::io::Result<Output> {
    let mut c = Command::new(&argv[0]);
    c.args(&argv[1..]).envs(env.iter().copied());
    if let Some(dir) = dir {
        c.current_dir(dir);
    }
    let done = crate::process::run(c, limit)?;
    Ok(Output {
        code: done.status.code(),
        stdout: String::from_utf8_lossy(&done.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&done.stderr).into_owned(),
    })
}

/// Runs commands for real (with no console window on Windows).
pub struct SystemRunner;

impl Runner for SystemRunner {
    /// No limit of its own: the WSL probe holds `roster inv which` to [`ASK_TIMEOUT`] itself, and
    /// the first probe may boot the default distro.
    fn run(&self, argv: &[String], env: &[(&str, &str)]) -> std::io::Result<Output> {
        output(argv, env, None, None)
    }

    fn run_in(&self, argv: &[String], env: &[(&str, &str)], dir: &str) -> std::io::Result<Output> {
        output(argv, env, Some(dir), Some(ASK_TIMEOUT))
    }

    fn var(&self, name: &str) -> Option<String> {
        std::env::var(name).ok().filter(|v| !v.trim().is_empty())
    }

    fn is_file(&self, path: &str) -> bool {
        std::path::Path::new(path).is_file()
    }
}

/// The roster command line: `ROSTER_APP_ROSTER` split on whitespace, or just `roster`.
pub fn roster_command(override_value: Option<&str>) -> Vec<String> {
    let v: Vec<String> = override_value
        .unwrap_or("")
        .split_whitespace()
        .map(String::from)
        .collect();
    if v.is_empty() { vec!["roster".into()] } else { v }
}

/// Run with `bash -lc PROBE probe <program> [<its arguments>...]`. Prints `roster=<abs path>` if the
/// program resolves (a leading `~` means the target's home: no shell expands it, as the program
/// comes in quoted), then `home=$HOME`, `path=<the login PATH>` and `inventory=<path>` (empty when
/// there's none). The Inventory is the one roster itself says it uses (`roster inv which`, run from
/// `$HOME` as serve is, for at most 15 s), so the app and the CLI agree on the file (ticket 115).
/// Only a roster too old to answer, one that hangs, or one that finds none, falls back to the
/// places the app looked before: those, plus `~/infra/roster.yml`.
const PROBE: &str = r#"PATH="$HOME/.local/bin:$PATH"
case $1 in "~" | "~/"*) set -- "$HOME${1#"~"}" "${@:2}" ;; esac
p=$(command -v -- "$1") || exit 0
echo "roster=$p"
echo "home=$HOME"
echo "path=$PATH"
shift
n=$#
while [ "$n" -gt 0 ]; do
  a=$1; shift; n=$((n - 1))
  case $a in "~" | "~/"*) a="$HOME${a#"~"}" ;; esac
  set -- "$@" "$a"
done
# perl, where there's no timeout (macOS): its own process group, so the alarm stops a wrapper's children too
PL='setpgrp(0,0);my $s=shift;my $c=fork;if(!$c){exec(@ARGV)||exit(127)}$SIG{ALRM}=sub{kill("TERM",-$$);exit(124)};alarm($s);waitpid($c,0);exit($?>>8)'
ask() {
  cd "$HOME" || return 1
  if command -v timeout >/dev/null 2>&1; then timeout "${ROSTER_PROBE_SECS:-15}" "$@"
  elif command -v perl >/dev/null 2>&1; then perl -e "$PL" "${ROSTER_PROBE_SECS:-15}" "$@"
  else "$@"
  fi
}
f=$(ask "$p" "$@" inv which 2>/dev/null)
case $f in /*) if [ -e "$f" ]; then echo "inventory=$f"; exit 0; fi ;; esac
for f in "$ROSTER_CONFIG" "$HOME/roster.yml" "$HOME/.config/roster/roster.yml" "$HOME/infra/roster.yml"; do
  if [ -n "$f" ] && [ -e "${f/#\~/$HOME}" ]; then echo "inventory=${f/#\~/$HOME}"; exit 0; fi
done
echo "inventory="
"#;

#[derive(Debug, Default, PartialEq, Eq)]
struct Probe {
    roster: Option<String>,
    inventory: Option<String>,
    path: Option<String>,
    home: Option<String>,
}

fn parse_probe(stdout: &str) -> Probe {
    let mut p = Probe::default();
    for line in stdout.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("roster=").filter(|v| !v.is_empty()) {
            p.roster = Some(v.to_string());
        } else if let Some(v) = line.strip_prefix("inventory=").filter(|v| !v.is_empty()) {
            p.inventory = Some(v.to_string());
        } else if let Some(v) = line.strip_prefix("path=").filter(|v| !v.is_empty()) {
            p.path = Some(v.to_string());
        } else if let Some(v) = line.strip_prefix("home=").filter(|v| !v.is_empty()) {
            p.home = Some(v.to_string());
        }
    }
    p
}

/// `dir\name`, Windows style, whatever the platform the code runs on (the tests run on Linux).
fn win_join(dir: &str, name: &str) -> String {
    format!("{}\\{name}", dir.trim_end_matches(['\\', '/']))
}

/// `~` or a leading `~\` or `~/` as `home`, on Windows.
fn win_home(arg: &str, home: Option<&str>) -> String {
    match (home, arg.strip_prefix('~')) {
        (Some(h), Some(rest)) if rest.is_empty() || rest.starts_with(['\\', '/']) => {
            win_join(h, rest.trim_start_matches(['\\', '/']))
                .trim_end_matches('\\')
                .to_string()
        }
        _ => arg.to_string(),
    }
}

/// Where `program` is on Windows: a path as given (with PATHEXT's extensions tried when it has
/// none), or the first match on PATH, then in `%USERPROFILE%\.local\bin` (where `uv tool install`
/// puts roster, a folder a GUI app's PATH may not have yet).
fn which_windows(runner: &dyn Runner, program: &str, home: Option<&str>) -> Option<String> {
    let exts: Vec<String> = runner
        .var("PATHEXT")
        .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into())
        .split(';')
        .filter(|e| !e.is_empty())
        .map(String::from)
        .collect();
    let lower = program.to_ascii_lowercase();
    let has_ext = exts.iter().any(|e| lower.ends_with(&e.to_ascii_lowercase()));
    let tries = |base: &str| -> Option<String> {
        if has_ext {
            return runner.is_file(base).then(|| base.to_string());
        }
        // `roster.exe` as the file is named (Windows matches either case), else as PATHEXT says.
        exts.iter()
            .flat_map(|e| [format!("{base}{}", e.to_ascii_lowercase()), format!("{base}{e}")])
            .find(|p| runner.is_file(p))
    };
    if program.contains(['\\', '/', ':']) {
        return tries(program);
    }
    let mut dirs: Vec<String> = runner
        .var("PATH")
        .unwrap_or_default()
        .split(';')
        .filter(|d| !d.trim().is_empty())
        .map(String::from)
        .collect();
    if let Some(h) = home {
        dirs.push(win_join(h, ".local\\bin"));
    }
    dirs.iter().find_map(|d| tries(&win_join(d, program)))
}

/// roster on Windows itself (no WSL): found as [`which_windows`] says, and its Inventory as roster
/// itself says (`roster inv which`, run from the home folder, serve's working folder), so the app and
/// the CLI agree (ticket 115). Only when roster doesn't answer (too old, or it finds none) does the
/// app look where it used to: `ROSTER_CONFIG`, then `roster.yml` in the home folder,
/// `%APPDATA%\roster\`, then `~\infra\`. The one command run is roster's own, with the app's env,
/// which is the user's.
pub fn probe_windows(runner: &dyn Runner, roster_cmd: &[String]) -> (Option<String>, Option<String>, Option<String>) {
    let home = runner.var("USERPROFILE");
    let roster = which_windows(runner, &win_home(&roster_cmd[0], home.as_deref()), home.as_deref());
    if let (Some(r), Some(h)) = (&roster, &home) {
        let mut argv = vec![r.clone()];
        argv.extend(roster_cmd[1..].iter().map(|a| win_home(a, Some(h))));
        argv.extend(["inv".into(), "which".into()]);
        if let Ok(o) = runner.run_in(&argv, &[], h) {
            let f = o.stdout.trim();
            if o.code == Some(0) && !f.is_empty() && !f.contains('\n') && runner.is_file(f) {
                return (roster, Some(f.to_string()), home);
            }
        }
    }
    let mut places: Vec<String> = Vec::new();
    if let Some(c) = runner.var("ROSTER_CONFIG") {
        places.push(win_home(c.trim(), home.as_deref()));
    }
    if let Some(h) = &home {
        places.push(win_join(h, "roster.yml"));
    }
    if let Some(a) = runner.var("APPDATA") {
        places.push(win_join(&a, "roster\\roster.yml"));
    }
    if let Some(h) = &home {
        places.push(win_join(h, "infra\\roster.yml"));
    }
    let inventory = places.into_iter().find(|p| runner.is_file(p));
    (roster, inventory, home)
}

fn probe(runner: &dyn Runner, target: &Target, roster_cmd: &[String]) -> Probe {
    let mut argv: Vec<String> = ["bash", "-lc", PROBE, "probe"].map(String::from).into();
    argv.extend_from_slice(roster_cmd);
    let argv = target.wrap(&argv);
    match runner.run(&argv, &[]) {
        Ok(o) => parse_probe(&o.stdout),
        Err(_) => Probe::default(),
    }
}

/// The distros detection may probe, in order, and the ones it left alone because they're stopped.
#[derive(Debug, Default, PartialEq, Eq)]
struct Distros {
    probe: Vec<String>,
    stopped: Vec<String>,
}

/// One row of `wsl.exe -l -v`: `[*] NAME STATE VERSION`. The header (localized) and blank lines
/// give `None`: a row ends in the WSL version number. STATE may be localized and contain spaces.
fn parse_list_row(line: &str) -> Option<(bool, String, String)> {
    let mut words: Vec<&str> = line.split_whitespace().collect();
    let is_default = words.first() == Some(&"*");
    if is_default {
        words.remove(0);
    }
    if words.len() < 3 || words.last()?.parse::<u8>().is_err() {
        return None;
    }
    let state = words[1..words.len() - 1].join(" ");
    Some((is_default, words[0].to_string(), state))
}

/// `wsl.exe -l -v`, read as UTF-8 thanks to WSL_UTF8=1 (and cleaned of UTF-16 leftovers anyway).
/// Probing runs `bash` in the distro, which boots it if it's stopped, and booting a distro can
/// have side effects for the whole WSL VM (OracleLinux_9's systemd-binfmt unregistered
/// WSLInterop, so every distro lost cmd.exe/wsl.exe). So only the default distro (the user's
/// main one) may be started; any other distro is probed only if it's already Running.
fn list_distros(runner: &dyn Runner) -> Result<Distros, BackendError> {
    let no_wsl = || {
        BackendError::new(
            ErrorKind::NoWsl,
            "No WSL distro was found.",
            "Install WSL and a Linux distro with roster in it (`wsl --install`), then retry.",
        )
    };
    let out = runner
        .run(&["wsl.exe", "-l", "-v"].map(String::from), &[("WSL_UTF8", "1")])
        .map_err(|e| no_wsl().with_detail(format!("wsl.exe -l -v: {e}")))?;
    let rows: Vec<(bool, String, String)> = out
        .stdout
        .replace(['\0', '\u{feff}'], "")
        .lines()
        .filter_map(parse_list_row)
        .filter(|(_, name, _)| !name.starts_with("docker-desktop"))
        .collect();
    if rows.is_empty() {
        return Err(no_wsl().with_detail(out.stderr));
    }
    let mut d = Distros::default();
    d.probe.extend(rows.iter().filter(|r| r.0).map(|r| r.1.clone()));
    for (is_default, name, state) in rows {
        if is_default {
            continue;
        }
        if state == "Running" {
            d.probe.push(name);
        } else {
            d.stopped.push(name);
        }
    }
    Ok(d)
}

/// `~` or a leading `~/` in `arg` as the target's `home`. serve starts through `wsl.exe --exec` (or
/// directly on Linux), with no shell to expand it, and tools like uv take `~/work/roster` literally.
fn expand_home(arg: &str, home: Option<&str>) -> String {
    match (home, arg.strip_prefix('~')) {
        (Some(h), Some(rest)) if rest.is_empty() || rest.starts_with('/') => format!("{h}{rest}"),
        _ => arg.to_string(),
    }
}

/// The Candidate for roster on Windows itself: its absolute path, the override's other words with
/// `~` expanded, `-c <inventory>` and `serve`. No `env PATH=`: the app's PATH is the user's.
fn windows_candidate(roster_cmd: &[String], p: &Probe) -> Candidate {
    let mut argv = vec![p.roster.clone().unwrap_or_default()];
    argv.extend(roster_cmd[1..].iter().map(|a| win_home(a, p.home.as_deref())));
    if let Some(inv) = &p.inventory {
        argv.extend(["-c".into(), inv.clone()]);
    }
    argv.push("serve".into());
    Candidate {
        serve_argv: argv,
        target: Target::Local,
        has_inventory: p.inventory.is_some(),
    }
}

fn candidate(target: Target, roster_cmd: &[String], p: &Probe) -> Candidate {
    let mut argv = match &p.path {
        Some(path) => vec!["/usr/bin/env".into(), format!("PATH={path}")],
        None => vec![],
    };
    argv.push(p.roster.clone().unwrap_or_default());
    argv.extend(roster_cmd[1..].iter().map(|a| expand_home(a, p.home.as_deref())));
    if let Some(inv) = &p.inventory {
        argv.extend(["-c".into(), inv.clone()]);
    }
    argv.push("serve".into());
    Candidate {
        serve_argv: target.wrap(&argv),
        target,
        has_inventory: p.inventory.is_some(),
    }
}

/// Find the Backend for `roster_cmd` (see [`roster_command`]). On Windows, `distro` is the value of
/// [`DISTRO_VAR`]: when it's set (not blank), only that distro is probed, and started if needed;
/// otherwise it's [`Choice::Auto`].
pub fn detect(
    runner: &dyn Runner,
    os: Os,
    roster_cmd: &[String],
    distro: Option<&str>,
) -> Result<Candidate, BackendError> {
    let choice = Choice::of_distro(distro).unwrap_or_default();
    detect_choice(runner, os, roster_cmd, &choice)
}

/// Find the Backend `choice` asks for (see the module docs).
pub fn detect_choice(
    runner: &dyn Runner,
    os: Os,
    roster_cmd: &[String],
    choice: &Choice,
) -> Result<Candidate, BackendError> {
    let program = &roster_cmd[0];
    let chosen = match choice {
        Choice::Wsl(Some(d)) if !d.trim().is_empty() => Some(d.trim()),
        _ => None,
    };
    // roster on Windows itself, unless WSL was asked for.
    let mut fallback = None;
    let native = os == Os::Windows && matches!(choice, Choice::Auto | Choice::Local);
    if native {
        let (roster, inventory, home) = probe_windows(runner, roster_cmd);
        if roster.is_some() {
            let p = Probe {
                roster,
                inventory,
                path: None,
                home,
            };
            let c = windows_candidate(roster_cmd, &p);
            if c.has_inventory || *choice == Choice::Local {
                return Ok(c);
            }
            fallback = Some(c);
        } else if *choice == Choice::Local {
            return Err(BackendError::new(
                ErrorKind::RosterMissing,
                format!("`{program}` wasn't found on Windows (backend = \"local\" in init.lua)."),
                "Install roster on Windows (`uv tool install .` in the roster repo, which puts it in \
                 %USERPROFILE%\\.local\\bin), or set backend to \"auto\" or \"wsl:<distro>\" in init.lua.",
            ));
        }
    }
    let mut stopped = Vec::new();
    let targets = match (os, chosen) {
        (Os::Linux | Os::Macos, _) => vec![Target::Local],
        (Os::Windows, Some(d)) => vec![Target::Wsl { distro: d.to_string() }],
        (Os::Windows, None) => match list_distros(runner) {
            Ok(d) => {
                stopped = d.stopped;
                d.probe.into_iter().map(|distro| Target::Wsl { distro }).collect()
            }
            // No WSL: roster on Windows without an Inventory is still a Backend (it says what's missing).
            Err(e) => {
                return match fallback {
                    Some(c) => Ok(c),
                    None if native => Err(BackendError {
                        hint: format!(
                            "{} Or install roster on Windows itself (`uv tool install .` in the roster repo).",
                            e.hint
                        ),
                        ..e
                    }),
                    None => Err(e),
                };
            }
        },
    };
    for t in &targets {
        let p = probe(runner, t, roster_cmd);
        if p.roster.is_none() {
            continue;
        }
        if p.inventory.is_some() {
            return Ok(candidate(t.clone(), roster_cmd, &p));
        }
        fallback.get_or_insert_with(|| candidate(t.clone(), roster_cmd, &p));
    }
    fallback.ok_or_else(|| {
        let names = |ts: &[Target]| {
            ts.iter()
                .map(|t| match t {
                    Target::Wsl { distro } => distro.as_str(),
                    Target::Local => "local",
                })
                .collect::<Vec<_>>()
                .join(", ")
        };
        let mut where_ = match (os, chosen) {
            (Os::Linux | Os::Macos, _) => "on this machine".to_string(),
            (Os::Windows, Some(d)) => format!("in WSL distro {d} (chosen with {DISTRO_VAR} or backend)"),
            (Os::Windows, None) if native => {
                format!("on Windows or in any WSL distro (searched: {})", names(&targets))
            }
            (Os::Windows, None) => format!("in any WSL distro (searched: {})", names(&targets)),
        };
        let mut hint = format!(
            "Install roster (`uv tool install roster` from the roster repo) so it's on PATH, \
             or set {OVERRIDE_VAR} to the command that runs it, e.g. \
             `uv run --project /home/you/work/roster roster`."
        );
        if !stopped.is_empty() {
            where_ += &format!("; skipped because they're stopped: {}", stopped.join(", "));
            hint += &format!(
                " To use a stopped distro, start it yourself or set {DISTRO_VAR}={} \
                 (the app then probes only that distro, starting it if needed).",
                stopped[0]
            );
        }
        BackendError::new(
            ErrorKind::RosterMissing,
            format!("`{program}` wasn't found {where_}."),
            hint,
        )
    })
}

/// Which roster to start, from the Config and the development env vars.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub command: Vec<String>,
    /// Where to look for it: init.lua's `backend`, or the one WSL distro the env var names.
    pub choice: Choice,
}

/// The roster command and where to look for it: `ROSTER_APP_ROSTER` and `ROSTER_APP_WSL_DISTRO`
/// win (they're for development, and set by the user outside the Config), then `roster_command`
/// and `backend` from init.lua, then detection. Blank env vars don't count. A `roster_command`
/// that isn't roster itself is refused ([`crate::config::RosterCommand::check`]); only the env var
/// may wrap it. The plan is what the app compares after a `:source`: a different one restarts
/// `roster serve`.
pub fn plan(config: &Config, env_command: Option<&str>, env_distro: Option<&str>) -> Result<Plan, String> {
    let env_command = env_command.filter(|v| !v.trim().is_empty());
    let command = match (env_command, &config.roster_command) {
        (None, Some(command)) => {
            command
                .check()
                .map_err(|m| format!("roster_command in init.lua: {m}."))?;
            command.0.clone()
        }
        (given, _) => roster_command(given),
    };
    let choice = Choice::of_distro(env_distro).unwrap_or_else(|| match &config.backend {
        BackendChoice::Auto => Choice::Auto,
        BackendChoice::Local => Choice::Local,
        BackendChoice::Wsl(d) => Choice::Wsl(d.clone()),
    });
    Ok(Plan { command, choice })
}

/// The roster `config` (and the development env vars) pick, found on this machine. Blocks for the
/// whole detection: run it on a blocking thread.
pub fn for_config(config: &Config) -> Result<Candidate, BackendError> {
    let env_cmd = crate::env::roster_override();
    let env_distro = crate::env::wsl_distro();
    let plan = plan(config, env_cmd.as_deref(), env_distro.as_deref()).map_err(|m| {
        BackendError::new(
            ErrorKind::Failed,
            m,
            "Fix it in init.lua (docs/app/config.md), then Retry.",
        )
    })?;
    detect_choice(&SystemRunner, Os::current(), &plan.command, &plan.choice)
}
