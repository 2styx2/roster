//! The command a Session runs: `session.prepare`'s argv and env, made runnable on the Backend's
//! target. On WSL the env is set on wsl.exe's own process and its names listed in `WSLENV` (with
//! `/u`, no path translation), because Windows-side variables only cross into WSL that way; values
//! never go in the argv, which any process can read for the Session's life
//! (docs/app/dev/tauri-pty-wsl.md, docs/app/security.md).

use roster_core::detect::Target;
use roster_core::session::{FillRule, Prepared, SessionCommand, session_command, wslenv};
use serde_json::json;

/// The value of `name` in the command's process env.
fn env_of<'a>(cmd: &'a SessionCommand, name: &str) -> Option<&'a str> {
    cmd.env.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

/// No env value (and no `K=V`) appears anywhere in the argv.
fn assert_no_env_in_argv(cmd: &SessionCommand) {
    for (k, v) in &cmd.env {
        if k == "WSLENV" {
            continue;
        }
        for a in &cmd.argv {
            assert!(!a.contains(v.as_str()), "{k}'s value is in the argv: {:?}", cmd.argv);
            assert!(!a.starts_with(&format!("{k}=")), "{k}= is in the argv: {:?}", cmd.argv);
        }
    }
}

fn prepared(env: serde_json::Value) -> Prepared {
    serde_json::from_value(json!({
        "argv": ["/usr/bin/ssh", "-o", "BatchMode=yes", "web-1"],
        "env": env,
        "host": "web-1",
        "auth": "key",
    }))
    .unwrap()
}

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn on_wsl_runs_ssh_through_wsl_exec_with_the_env_on_the_process_and_named_in_wslenv() {
    let cmd = session_command(
        &Target::Wsl {
            distro: "FedoraLinux-44".into(),
        },
        &prepared(json!({"SSH_ASKPASS": "/run/askpass", "SSH_ASKPASS_REQUIRE": "force"})),
        FillRule::Host { marks: None },
    );
    assert_eq!(
        cmd.argv,
        strings(&[
            "wsl.exe",
            "-d",
            "FedoraLinux-44",
            "--cd",
            "~",
            "--exec",
            "/usr/bin/ssh",
            "-o",
            "BatchMode=yes",
            "web-1",
        ])
    );
    assert_eq!(env_of(&cmd, "SSH_ASKPASS"), Some("/run/askpass"));
    assert_eq!(env_of(&cmd, "TERM"), Some("xterm-256color"));
    let wslenv = env_of(&cmd, "WSLENV").unwrap();
    assert!(
        wslenv.ends_with("TERM/u:COLORTERM/u:SSH_ASKPASS/u:SSH_ASKPASS_REQUIRE/u"),
        "{wslenv}"
    );
    assert_no_env_in_argv(&cmd);
}

#[test]
fn wslenv_appends_to_the_existing_list_without_translating_paths() {
    assert_eq!(wslenv(None, ["TERM", "SSH_ASKPASS"]), "TERM/u:SSH_ASKPASS/u");
    assert_eq!(wslenv(Some(""), ["TERM"]), "TERM/u");
    assert_eq!(
        wslenv(Some("USERPROFILE/p:ROSTER_APP_ROSTER"), ["TERM"]),
        "USERPROFILE/p:ROSTER_APP_ROSTER:TERM/u"
    );
    // A name already listed (say with /p, which would turn /run/... into a Windows path) is
    // replaced by ours.
    assert_eq!(wslenv(Some("SSH_ASKPASS/p:FOO:"), ["SSH_ASKPASS"]), "FOO:SSH_ASKPASS/u");
}

#[test]
fn locally_runs_ssh_as_given_with_env_set_on_the_process() {
    let cmd = session_command(
        &Target::Local,
        &prepared(json!({"SSH_ASKPASS_REQUIRE": "force"})),
        FillRule::Host { marks: None },
    );
    assert_eq!(cmd.argv, strings(&["/usr/bin/ssh", "-o", "BatchMode=yes", "web-1"]));
    assert_eq!(
        cmd.env,
        vec![
            ("TERM".to_string(), "xterm-256color".to_string()),
            ("COLORTERM".to_string(), "truecolor".to_string()),
            ("SSH_ASKPASS_REQUIRE".to_string(), "force".to_string()),
        ]
    );
}

#[test]
fn an_empty_env_still_sets_term_and_colorterm() {
    let cmd = session_command(
        &Target::Wsl { distro: "D".into() },
        &prepared(json!({})),
        FillRule::Host { marks: None },
    );
    assert_eq!(cmd.argv[6], "/usr/bin/ssh");
    assert_eq!(env_of(&cmd, "TERM"), Some("xterm-256color"));
    assert_eq!(env_of(&cmd, "COLORTERM"), Some("truecolor"));
    assert!(env_of(&cmd, "WSLENV").unwrap().ends_with("TERM/u:COLORTERM/u"));
}

/// Decision Q37: the user's own terminal config wins. The app adds TERM and COLORTERM and
/// nothing else (no PS1, no sourced files); every other variable comes from `session.prepare`
/// (askpass, ticket 06).
#[test]
fn the_app_adds_only_term_and_colorterm_to_the_session_env() {
    let from_roster = json!({"SSH_ASKPASS": "/run/askpass", "SSH_ASKPASS_REQUIRE": "force"});
    let cmd = session_command(
        &Target::Local,
        &prepared(from_roster.clone()),
        FillRule::Host { marks: None },
    );
    let added: Vec<&str> = cmd
        .env
        .iter()
        .map(|(k, _)| k.as_str())
        .filter(|k| from_roster.get(k).is_none())
        .collect();
    assert_eq!(added, ["TERM", "COLORTERM"]);
    let wsl = session_command(
        &Target::Wsl { distro: "D".into() },
        &prepared(from_roster.clone()),
        FillRule::Host { marks: None },
    );
    let added: Vec<&str> = wsl
        .env
        .iter()
        .map(|(k, _)| k.as_str())
        .filter(|k| from_roster.get(k).is_none() && *k != "WSLENV")
        .collect();
    assert_eq!(added, ["TERM", "COLORTERM"]);
}

#[test]
fn debug_output_never_shows_env_values() {
    let secret = "tok-5f3a9c";
    let wsl = session_command(
        &Target::Wsl { distro: "D".into() },
        &prepared(json!({"ROSTER_ASKPASS_TOKEN": secret})),
        FillRule::Host { marks: None },
    );
    let local = session_command(
        &Target::Local,
        &prepared(json!({"ROSTER_ASKPASS_TOKEN": secret})),
        FillRule::Host { marks: None },
    );
    for shown in [
        format!("{wsl:?}"),
        format!("{local:?}"),
        format!("{:?}", prepared(json!({"ROSTER_ASKPASS_TOKEN": secret}))),
    ] {
        assert!(!shown.contains(secret), "{shown}");
        assert!(shown.contains("ROSTER_ASKPASS_TOKEN"), "{shown}");
    }
}

/// What `session.prepare` gives for a password-only Host (docs/serve-api.md, "Password Sessions").
fn password_prepared(token: &str) -> Prepared {
    serde_json::from_value(json!({
        "argv": ["/usr/bin/ssh", "-o", "NumberOfPasswordPrompts=1",
                 "-o", "PreferredAuthentications=password,keyboard-interactive", "sw-core"],
        "env": {
            "SSH_ASKPASS": "/run/user/1000/roster-askpass-x1/askpass",
            "SSH_ASKPASS_REQUIRE": "force",
            "ROSTER_ASKPASS_SOCKET": "/run/user/1000/roster-askpass-x1/sock",
            "ROSTER_ASKPASS_TOKEN": token,
        },
        "host": "sw-core",
        "auth": "password",
    }))
    .unwrap()
}

#[test]
fn a_password_session_on_wsl_carries_the_askpass_env_through_wslenv_not_the_argv() {
    let cmd = session_command(
        &Target::Wsl { distro: "D".into() },
        &password_prepared("tok-1"),
        FillRule::Host { marks: None },
    );
    assert_eq!(
        cmd.argv,
        strings(&[
            "wsl.exe",
            "-d",
            "D",
            "--cd",
            "~",
            "--exec",
            "/usr/bin/ssh",
            "-o",
            "NumberOfPasswordPrompts=1",
            "-o",
            "PreferredAuthentications=password,keyboard-interactive",
            "sw-core",
        ])
    );
    assert!(!cmd.argv.iter().any(|a| a.contains("tok-1")));
    assert_eq!(env_of(&cmd, "ROSTER_ASKPASS_TOKEN"), Some("tok-1"));
    assert_eq!(
        env_of(&cmd, "SSH_ASKPASS"),
        Some("/run/user/1000/roster-askpass-x1/askpass")
    );
    let wslenv = env_of(&cmd, "WSLENV").unwrap();
    assert!(
        wslenv.ends_with(
            "TERM/u:COLORTERM/u:ROSTER_ASKPASS_SOCKET/u:ROSTER_ASKPASS_TOKEN/u:SSH_ASKPASS/u:SSH_ASKPASS_REQUIRE/u"
        ),
        "{wslenv}"
    );
    assert!(!wslenv.contains("/p"), "{wslenv}");
    assert_no_env_in_argv(&cmd);
    assert_eq!(cmd.auth, "password");
    // No DISPLAY: SSH_ASKPASS_REQUIRE=force doesn't need one.
    assert!(env_of(&cmd, "DISPLAY").is_none());
}

#[test]
fn an_error_naming_the_command_line_never_shows_the_token() {
    // A spawn failure may quote the command or its environment.
    let secret = "tok-5f3a9c";
    for target in [Target::Wsl { distro: "D".into() }, Target::Local] {
        let cmd = session_command(&target, &password_prepared(secret), FillRule::Host { marks: None });
        let raw = format!("CreateProcessW `{:?}` in cwd `None` failed: 2", cmd.argv.join(" "));
        let shown = cmd.redact(&raw);
        assert!(!shown.contains(secret), "{shown}");
        let raw = format!("spawn failed; env ROSTER_ASKPASS_TOKEN={secret}");
        assert!(cmd.redact(&raw).ends_with("ROSTER_ASKPASS_TOKEN=…"), "{target:?}");
    }
}
