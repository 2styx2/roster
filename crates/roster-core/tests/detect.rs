//! Finding the Backend: which WSL distro (or the local machine) has roster and an Inventory, and
//! the exact argv that starts `roster serve` there. Driven through a scripted command runner.

mod common;

use roster_core::detect::{
    Candidate, Choice, ErrorKind, Output, Platform, Runner, Target, detect, detect_choice, roster_command,
};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

/// Answers by the argv it's asked to run; records every call.
#[derive(Default)]
struct Scripted {
    distros: Option<String>,
    probes: HashMap<String, String>, // distro ("" = local) -> probe stdout
    calls: RefCell<Vec<Vec<String>>>,
    /// Native Windows detection: the app's env vars and the files that exist.
    vars: HashMap<String, String>,
    files: HashSet<String>,
}

impl Runner for Scripted {
    fn run(&self, argv: &[String], _env: &[(&str, &str)]) -> std::io::Result<Output> {
        self.calls.borrow_mut().push(argv.to_vec());
        let ok = |s: &str| {
            Ok(Output {
                code: Some(0),
                stdout: s.to_string(),
                stderr: String::new(),
            })
        };
        if argv[0] == "wsl.exe" && argv[1] == "-l" {
            return match &self.distros {
                Some(d) => ok(d),
                None => Err(std::io::Error::new(std::io::ErrorKind::NotFound, "wsl.exe not found")),
            };
        }
        let distro = if argv[0] == "wsl.exe" {
            argv[2].clone()
        } else {
            String::new()
        };
        ok(self.probes.get(&distro).map(String::as_str).unwrap_or(""))
    }

    fn var(&self, name: &str) -> Option<String> {
        self.vars.get(name).cloned()
    }

    fn is_file(&self, path: &str) -> bool {
        self.files.contains(path)
    }
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

/// `wsl.exe -l -v` output for `(default marker, name, state)` rows.
fn list(rows: &[(&str, &str, &str)]) -> String {
    let mut out = "  NAME      STATE      VERSION\r\n".to_string();
    for (mark, name, state) in rows {
        out += &format!("{mark:1} {name:9} {state:10} 2\r\n");
    }
    out
}

const FOUND: &str = "roster=/home/u/.local/bin/roster\ninventory=/home/u/infra/roster.yml\n";

#[test]
fn on_windows_the_first_distro_with_roster_and_an_inventory_wins() {
    let r = Scripted {
        distros: Some(list(&[
            ("*", "Ubuntu", "Running"),
            ("", "FedoraLinux-44", "Running"),
            ("", "Other", "Running"),
        ])),
        probes: HashMap::from([("Ubuntu".into(), "".into()), ("FedoraLinux-44".into(), FOUND.into())]),
        ..Default::default()
    };
    let c = detect(&r, Platform::Windows, &s(&["roster"]), None).unwrap();
    assert_eq!(
        c.target,
        Target::Wsl {
            distro: "FedoraLinux-44".into()
        }
    );
    assert_eq!(
        c.serve_argv,
        s(&[
            "wsl.exe",
            "-d",
            "FedoraLinux-44",
            "--cd",
            "~",
            "--exec",
            "/home/u/.local/bin/roster",
            "-c",
            "/home/u/infra/roster.yml",
            "serve"
        ])
    );
    // stops probing once it has found one
    assert!(!r.calls.borrow().iter().any(|a| a.contains(&"Other".to_string())));
}

#[test]
fn the_probe_resolves_roster_through_a_login_shell_with_local_bin_on_path() {
    let r = Scripted {
        distros: Some(list(&[("*", "FedoraLinux-44", "Stopped")])),
        probes: HashMap::from([("FedoraLinux-44".into(), FOUND.into())]),
        ..Default::default()
    };
    detect(&r, Platform::Windows, &s(&["roster"]), None).unwrap();
    let calls = r.calls.borrow();
    let probe = &calls[1];
    assert_eq!(
        &probe[..8],
        &s(&["wsl.exe", "-d", "FedoraLinux-44", "--cd", "~", "--exec", "bash", "-lc"])[..]
    );
    assert!(probe[8].contains(".local/bin"), "{}", probe[8]);
    assert_eq!(probe.last().unwrap(), "roster");
}

#[test]
fn an_override_command_keeps_its_arguments_and_resolves_only_the_program() {
    let r = Scripted {
        distros: Some(list(&[("*", "FedoraLinux-44", "Stopped")])),
        probes: HashMap::from([(
            "FedoraLinux-44".into(),
            "roster=/usr/bin/uv\ninventory=/home/u/infra/roster.yml\n".into(),
        )]),
        ..Default::default()
    };
    let cmd = roster_command(Some("uv run --project /home/u/work/roster roster"));
    let c = detect(&r, Platform::Windows, &cmd, None).unwrap();
    assert_eq!(r.calls.borrow()[1].last().unwrap(), "uv");
    assert_eq!(
        &c.serve_argv[6..],
        &s(&[
            "/usr/bin/uv",
            "run",
            "--project",
            "/home/u/work/roster",
            "roster",
            "-c",
            "/home/u/infra/roster.yml",
            "serve"
        ])[..]
    );
}

#[test]
fn roster_without_an_inventory_is_still_chosen_so_serve_can_say_what_is_missing() {
    let r = Scripted {
        distros: Some(list(&[("*", "A", "Running"), ("", "B", "Running")])),
        probes: HashMap::from([("A".into(), "roster=/r\ninventory=\n".into()), ("B".into(), "".into())]),
        ..Default::default()
    };
    let c = detect(&r, Platform::Windows, &s(&["roster"]), None).unwrap();
    assert_eq!(c.target, Target::Wsl { distro: "A".into() });
    assert_eq!(&c.serve_argv[6..], &s(&["/r", "serve"])[..]);
}

#[test]
fn no_distro_with_roster_is_roster_missing_and_names_the_distros_searched() {
    let r = Scripted {
        distros: Some(list(&[("*", "A", "Running"), ("", "B", "Running")])),
        ..Default::default()
    };
    let e = detect(&r, Platform::Windows, &s(&["roster"]), None).unwrap_err();
    assert_eq!(e.kind, ErrorKind::RosterMissing);
    assert!(e.message.contains("A, B"), "{}", e.message);
}

#[test]
fn no_wsl_at_all_is_its_own_error() {
    let r = Scripted::default();
    assert_eq!(
        detect(&r, Platform::Windows, &s(&["roster"]), None).unwrap_err().kind,
        ErrorKind::NoWsl
    );
    let r = Scripted {
        distros: Some("\n".into()),
        ..Default::default()
    };
    assert_eq!(
        detect(&r, Platform::Windows, &s(&["roster"]), None).unwrap_err().kind,
        ErrorKind::NoWsl
    );
}

#[test]
fn distro_names_survive_utf16_noise_and_skip_docker_desktop() {
    let r = Scripted {
        distros: Some(
            "\u{feff}  NAME STATE VERSION\0\r\n* docker-desktop Running 2\0\r\n  Fedora Running 2\0\r\n".into(),
        ),
        probes: HashMap::from([("Fedora".into(), FOUND.into())]),
        ..Default::default()
    };
    let c: Candidate = detect(&r, Platform::Windows, &s(&["roster"]), None).unwrap();
    assert_eq!(
        c.target,
        Target::Wsl {
            distro: "Fedora".into()
        }
    );
    assert!(
        !r.calls
            .borrow()
            .iter()
            .any(|a| a.contains(&"docker-desktop".to_string()))
    );
}

#[test]
fn on_linux_roster_runs_locally() {
    let r = Scripted {
        probes: HashMap::from([("".into(), FOUND.into())]),
        ..Default::default()
    };
    let c = detect(&r, Platform::Linux, &s(&["roster"]), None).unwrap();
    assert_eq!(c.target, Target::Local);
    assert_eq!(
        c.serve_argv,
        s(&["/home/u/.local/bin/roster", "-c", "/home/u/infra/roster.yml", "serve"])
    );
    assert_eq!(r.calls.borrow()[0][..2], s(&["bash", "-lc"])[..]);
}

#[test]
fn the_override_is_split_on_whitespace_and_blank_means_roster() {
    assert_eq!(roster_command(None), s(&["roster"]));
    assert_eq!(roster_command(Some("  ")), s(&["roster"]));
    assert_eq!(roster_command(Some(" uv  run roster ")), s(&["uv", "run", "roster"]));
}

/// `wsl.exe --exec` starts serve with a bare PATH (no `~/.local/bin`), so roster couldn't find the
/// vault CLI (`bw` from npm or `~/.local/bin`) and the lock screen said "not installed".
#[test]
fn serve_gets_the_login_shells_path_so_it_finds_the_vault_cli() {
    let found = format!("{FOUND}path=/home/u/.local/bin:/usr/local/bin:/usr/bin:/bin\n");
    let r = Scripted {
        distros: Some(LIST_V.into()),
        probes: HashMap::from([("FedoraLinux-44".into(), found)]),
        ..Default::default()
    };
    let c = detect(&r, Platform::Windows, &s(&["roster"]), None).unwrap();
    assert_eq!(
        c.serve_argv,
        s(&[
            "wsl.exe",
            "-d",
            "FedoraLinux-44",
            "--cd",
            "~",
            "--exec",
            "/usr/bin/env",
            "PATH=/home/u/.local/bin:/usr/local/bin:/usr/bin:/bin",
            "/home/u/.local/bin/roster",
            "-c",
            "/home/u/infra/roster.yml",
            "serve"
        ])
    );
}

#[test]
fn the_probe_reports_the_login_path() {
    let r = Scripted {
        distros: Some(LIST_V.into()),
        probes: HashMap::from([("FedoraLinux-44".into(), FOUND.into())]),
        ..Default::default()
    };
    detect(&r, Platform::Windows, &s(&["roster"]), None).unwrap();
    let script = r.calls.borrow()[1][8].clone();
    assert!(script.contains(r#"echo "path=$PATH""#), "{script}");
}

/// `wsl.exe -l -v` as WSL_UTF8=1 prints it: `*` marks the default distro.
const LIST_V: &str = "  NAME              STATE           VERSION\r\n\
* FedoraLinux-44    Running         2\r\n\
  OracleLinux_9     Stopped         2\r\n\
  Ubuntu            Running         2\r\n";

fn probed(r: &Scripted) -> Vec<String> {
    r.calls
        .borrow()
        .iter()
        .filter(|a| a[0] == "wsl.exe" && a[1] == "-d")
        .map(|a| a[2].clone())
        .collect()
}

#[test]
fn a_stopped_distro_that_is_not_the_default_is_never_probed() {
    let r = Scripted {
        distros: Some(LIST_V.into()),
        ..Default::default()
    };
    let e = detect(&r, Platform::Windows, &s(&["roster"]), None).unwrap_err();
    assert_eq!(probed(&r), s(&["FedoraLinux-44", "Ubuntu"]));
    assert_eq!(e.kind, ErrorKind::RosterMissing);
}

#[test]
fn the_default_distro_is_probed_first_and_may_be_started() {
    let r = Scripted {
        distros: Some(list(&[("", "Ubuntu", "Running"), ("*", "Fedora", "Stopped")])),
        probes: HashMap::from([("Fedora".into(), FOUND.into()), ("Ubuntu".into(), FOUND.into())]),
        ..Default::default()
    };
    let c = detect(&r, Platform::Windows, &s(&["roster"]), None).unwrap();
    assert_eq!(
        c.target,
        Target::Wsl {
            distro: "Fedora".into()
        }
    );
    assert_eq!(probed(&r), s(&["Fedora"]));
}

#[test]
fn localized_states_and_a_utf16_listing_still_parse() {
    // Without WSL_UTF8 honoured: UTF-16 read as bytes leaves NULs; STATE words are localized.
    let raw = "\u{feff}  NAME  ZUSTAND  VERSION\r\n* Fedora  Wird ausgeführt  2\r\n  Oracle  Beendet  2\r\n";
    let utf16ish: String = raw.chars().flat_map(|c| [c, '\0']).collect();
    let r = Scripted {
        distros: Some(utf16ish),
        ..Default::default()
    };
    detect(&r, Platform::Windows, &s(&["roster"]), None).unwrap_err();
    // only the default: an unknown state is never taken for Running
    assert_eq!(probed(&r), s(&["Fedora"]));
}

#[test]
fn when_nothing_matches_the_error_names_the_stopped_distros_and_how_to_pick_one() {
    let r = Scripted {
        distros: Some(LIST_V.into()),
        ..Default::default()
    };
    let e = detect(&r, Platform::Windows, &s(&["roster"]), None).unwrap_err();
    assert!(e.message.contains("FedoraLinux-44, Ubuntu"), "{}", e.message);
    assert!(e.message.contains("OracleLinux_9"), "{}", e.message);
    assert!(e.hint.contains("ROSTER_APP_WSL_DISTRO=OracleLinux_9"), "{}", e.hint);
}

#[test]
fn a_chosen_distro_is_the_only_one_probed_even_if_stopped() {
    let r = Scripted {
        distros: Some(LIST_V.into()),
        probes: HashMap::from([
            ("OracleLinux_9".into(), FOUND.into()),
            ("FedoraLinux-44".into(), FOUND.into()),
        ]),
        ..Default::default()
    };
    let c = detect(&r, Platform::Windows, &s(&["roster"]), Some("OracleLinux_9")).unwrap();
    assert_eq!(
        c.target,
        Target::Wsl {
            distro: "OracleLinux_9".into()
        }
    );
    assert_eq!(probed(&r), s(&["OracleLinux_9"]));
}

#[test]
fn a_chosen_distro_without_roster_is_named_in_the_error() {
    let r = Scripted {
        distros: Some(LIST_V.into()),
        ..Default::default()
    };
    let e = detect(&r, Platform::Windows, &s(&["roster"]), Some(" Ubuntu ")).unwrap_err();
    assert_eq!(probed(&r), s(&["Ubuntu"]));
    assert_eq!(e.kind, ErrorKind::RosterMissing);
    assert!(e.message.contains("Ubuntu"), "{}", e.message);
    assert!(e.message.contains("ROSTER_APP_WSL_DISTRO"), "{}", e.message);
}

#[test]
fn a_blank_distro_choice_means_none() {
    let r = Scripted {
        distros: Some(LIST_V.into()),
        probes: HashMap::from([("FedoraLinux-44".into(), FOUND.into())]),
        ..Default::default()
    };
    let c = detect(&r, Platform::Windows, &s(&["roster"]), Some("  ")).unwrap();
    assert_eq!(
        c.target,
        Target::Wsl {
            distro: "FedoraLinux-44".into()
        }
    );
}

#[test]
fn a_leading_tilde_in_the_override_means_the_targets_home() {
    // No shell runs serve (`wsl.exe --exec`), so `~/work/roster` would reach uv as is; the probe
    // reports the target's $HOME and the override's arguments are expanded with it.
    let r = Scripted {
        distros: Some(list(&[("*", "FedoraLinux-44", "Running")])),
        probes: HashMap::from([(
            "FedoraLinux-44".into(),
            "roster=/usr/bin/uv\nhome=/home/u\ninventory=/home/u/infra/roster.yml\n".into(),
        )]),
        ..Default::default()
    };
    let cmd = roster_command(Some("uv run --project ~/work/roster roster"));
    let c = detect(&r, Platform::Windows, &cmd, None).unwrap();
    assert_eq!(
        &c.serve_argv[6..10],
        &s(&["/usr/bin/uv", "run", "--project", "/home/u/work/roster"])[..]
    );
}

#[test]
fn the_roster_missing_hint_gives_an_absolute_override_example() {
    let r = Scripted {
        distros: Some(list(&[("*", "A", "Running")])),
        ..Default::default()
    };
    let e = detect(&r, Platform::Windows, &s(&["roster"]), None).unwrap_err();
    assert!(!e.hint.contains("~/"), "{}", e.hint);
    assert!(e.hint.contains("--project /home/"), "{}", e.hint);
}

/// Runs the real probe locally, with `HOME` pointing at a scratch dir.
#[cfg(unix)]
struct WithHome(std::path::PathBuf);

#[cfg(unix)]
impl Runner for WithHome {
    fn run(&self, argv: &[String], env: &[(&str, &str)]) -> std::io::Result<Output> {
        let home = self.0.to_str().unwrap();
        let mut all = env.to_vec();
        all.push(("HOME", home));
        all.push(("ROSTER_CONFIG", ""));
        roster_core::detect::SystemRunner.run(argv, &all)
    }
}

#[cfg(unix)]
#[test]
fn the_real_probe_expands_a_tilde_in_the_program_and_its_arguments() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = common::temp("detect-home");
    let home = tmp.to_path_buf();
    std::fs::create_dir_all(home.join("bin")).unwrap();
    std::fs::create_dir_all(home.join("infra")).unwrap();
    let program = home.join("bin/roster");
    std::fs::write(&program, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(home.join("infra/roster.yml"), "hosts: []\n").unwrap();

    let cmd = roster_command(Some("~/bin/roster --dir ~/x"));
    let c = detect(&WithHome(home.clone()), Platform::Linux, &cmd, None);
    let h = home.to_str().unwrap().to_string();
    let c = c.unwrap();
    assert_eq!(
        &c.serve_argv[2..],
        &[
            format!("{h}/bin/roster"),
            "--dir".into(),
            format!("{h}/x"),
            "-c".into(),
            format!("{h}/infra/roster.yml"),
            "serve".into()
        ][..]
    );
}

// ---- native Windows roster (ticket 19)

/// A Windows PC with roster installed by `uv tool install` (in `~\.local\bin`, not on the app's
/// PATH yet) and, if `inventory`, a `roster.yml` in `%APPDATA%\roster`.
fn windows_pc(inventory: bool, wsl: Option<(&str, &str)>) -> Scripted {
    let mut files = HashSet::from([r"C:\Users\you\.local\bin\roster.exe".to_string()]);
    if inventory {
        files.insert(r"C:\Users\you\AppData\Roaming\roster\roster.yml".into());
    }
    Scripted {
        distros: wsl.map(|(name, _)| list(&[("*", name, "Running")])),
        probes: wsl
            .map(|(name, probe)| HashMap::from([(name.to_string(), probe.to_string())]))
            .unwrap_or_default(),
        vars: HashMap::from([
            ("PATH".into(), r"C:\Windows\system32;C:\Windows".into()),
            ("PATHEXT".into(), ".COM;.EXE;.BAT;.CMD".into()),
            ("USERPROFILE".into(), r"C:\Users\you".into()),
            ("APPDATA".into(), r"C:\Users\you\AppData\Roaming".into()),
        ]),
        files,
        ..Default::default()
    }
}

#[test]
fn auto_on_windows_takes_roster_on_windows_with_an_inventory_and_never_runs_wsl() {
    let r = windows_pc(true, Some(("Ubuntu", FOUND)));
    let c = detect_choice(&r, Platform::Windows, &s(&["roster"]), &Choice::Auto).unwrap();
    assert_eq!(c.target, Target::Local);
    assert_eq!(
        c.serve_argv,
        s(&[
            r"C:\Users\you\.local\bin\roster.exe",
            "-c",
            r"C:\Users\you\AppData\Roaming\roster\roster.yml",
            "serve"
        ])
    );
    assert!(
        r.calls.borrow().is_empty(),
        "nothing runs, WSL stays asleep: {:?}",
        r.calls.borrow()
    );
}

#[test]
fn auto_on_windows_prefers_a_wsl_distro_with_an_inventory_over_windows_roster_without_one() {
    let r = windows_pc(false, Some(("Ubuntu", FOUND)));
    let c = detect_choice(&r, Platform::Windows, &s(&["roster"]), &Choice::Auto).unwrap();
    assert_eq!(
        c.target,
        Target::Wsl {
            distro: "Ubuntu".into()
        }
    );
    // ... and with no WSL at all, Windows roster without an Inventory is the Backend (it says so).
    let r = windows_pc(false, None);
    let c = detect_choice(&r, Platform::Windows, &s(&["roster"]), &Choice::Auto).unwrap();
    assert_eq!((c.target, c.has_inventory), (Target::Local, false));
    assert_eq!(c.serve_argv, s(&[r"C:\Users\you\.local\bin\roster.exe", "serve"]));
}

#[test]
fn local_on_windows_never_looks_in_wsl_and_says_what_to_install() {
    let mut r = windows_pc(false, Some(("Ubuntu", FOUND)));
    r.files.clear();
    let e = detect_choice(&r, Platform::Windows, &s(&["roster"]), &Choice::Local).unwrap_err();
    assert_eq!(e.kind, ErrorKind::RosterMissing);
    assert!(
        e.message.contains("on Windows") && e.hint.contains("uv tool install"),
        "{e}"
    );
    assert!(r.calls.borrow().is_empty());
    // Without an Inventory it's still this Backend: roster then says the Inventory is missing.
    let r = windows_pc(false, Some(("Ubuntu", FOUND)));
    let c = detect_choice(&r, Platform::Windows, &s(&["roster"]), &Choice::Local).unwrap();
    assert_eq!(c.target, Target::Local);
}

#[test]
fn wsl_on_windows_never_takes_windows_roster() {
    let r = windows_pc(true, Some(("Ubuntu", FOUND)));
    let c = detect_choice(&r, Platform::Windows, &s(&["roster"]), &Choice::Wsl(None)).unwrap();
    assert_eq!(
        c.target,
        Target::Wsl {
            distro: "Ubuntu".into()
        }
    );
}

#[test]
fn windows_roster_is_found_on_path_with_pathext_and_roster_config_wins() {
    let mut r = windows_pc(true, None);
    r.files = HashSet::from([
        r"D:\tools\roster.CMD".to_string(),
        r"C:\Users\you\infra\roster.yml".into(),
        r"C:\Users\you\team\roster.yml".into(),
    ]);
    r.vars.insert("PATH".into(), r"C:\Windows\system32;D:\tools\".into());
    let c = detect_choice(&r, Platform::Windows, &s(&["roster"]), &Choice::Local).unwrap();
    assert_eq!(
        c.serve_argv,
        s(&[r"D:\tools\roster.CMD", "-c", r"C:\Users\you\infra\roster.yml", "serve"])
    );
    r.vars.insert("ROSTER_CONFIG".into(), r"~\team\roster.yml".into());
    let c = detect_choice(&r, Platform::Windows, &s(&["roster"]), &Choice::Local).unwrap();
    assert_eq!(c.serve_argv[2], r"C:\Users\you\team\roster.yml");
}

#[test]
fn an_override_on_windows_runs_natively_with_its_home_expanded() {
    let mut r = windows_pc(true, None);
    r.files.insert(r"C:\Users\you\.cargo\bin\uv.exe".into());
    r.vars.insert("PATH".into(), r"C:\Users\you\.cargo\bin".into());
    let cmd = s(&["uv", "run", "--project", r"~\work\roster", "roster"]);
    let c = detect_choice(&r, Platform::Windows, &cmd, &Choice::Local).unwrap();
    assert_eq!(
        c.serve_argv,
        s(&[
            r"C:\Users\you\.cargo\bin\uv.exe",
            "run",
            "--project",
            r"C:\Users\you\work\roster",
            "roster",
            "-c",
            r"C:\Users\you\AppData\Roaming\roster\roster.yml",
            "serve"
        ])
    );
}

#[test]
fn no_roster_anywhere_on_windows_names_both_places() {
    let mut r = windows_pc(false, None);
    r.files.clear();
    let e = detect(&r, Platform::Windows, &s(&["roster"]), None).unwrap_err();
    assert_eq!(e.kind, ErrorKind::NoWsl);
    assert!(e.hint.contains("roster on Windows itself"), "{e}");
}
