//! Starting `roster serve` and checking it: a stub serve (tests/fake_serve.py) in each failure mode
//! must come out as the error the error screen explains.

use roster_core::backend::Backend;
use roster_core::detect::{Candidate, ErrorKind, Target};

fn fake(mode: &str) -> Candidate {
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fake_serve.py");
    Candidate {
        target: Target::Local,
        serve_argv: vec!["python3".into(), script.into(), mode.into()],
        has_inventory: true,
    }
}

use roster_core::session::{FillTarget, LoginAs};

#[test]
fn a_current_roster_starts_and_reports_its_inventory() {
    let b = Backend::start(&fake("ok")).unwrap();
    assert_eq!(b.info.backend, "Local");
    assert_eq!(b.info.inventory["host_count"], 3);
    assert_eq!(
        b.call("hosts.list", serde_json::json!({})).unwrap()["hosts"][1]["name"],
        "scan-1"
    );
}

#[test]
fn an_api_older_than_required_is_too_old() {
    let e = Backend::start(&fake("old-api")).err().unwrap();
    assert_eq!(e.kind, ErrorKind::RosterTooOld);
    assert!(e.message.contains("API version 0"), "{}", e.message);
}

#[test]
fn a_roster_without_serve_is_too_old_and_points_at_the_override() {
    let e = Backend::start(&fake("unknown-command")).err().unwrap();
    assert_eq!(e.kind, ErrorKind::RosterTooOld);
    assert!(e.hint.contains("ROSTER_APP_ROSTER"), "{}", e.hint);
    assert!(e.detail.unwrap().contains("invalid choice"));
}

#[test]
fn no_inventory_is_inventory_not_found_with_roster_wording() {
    let e = Backend::start(&fake("no-inventory")).err().unwrap();
    assert_eq!(e.kind, ErrorKind::InventoryNotFound);
    assert!(e.message.contains("no roster.yml found"), "{}", e.message);
}

#[test]
fn a_command_that_cannot_start_is_a_failure_naming_it() {
    let c = Candidate {
        target: Target::Local,
        serve_argv: vec!["/nonexistent/roster".into(), "serve".into()],
        has_inventory: true,
    };
    let e = Backend::start(&c).err().unwrap();
    assert_eq!(e.kind, ErrorKind::Failed);
    assert!(e.detail.unwrap().contains("/nonexistent/roster"));
}

#[test]
fn a_session_command_comes_from_session_prepare_with_term_set() {
    let b = Backend::start(&fake("ok")).unwrap();
    let cmd = b.session_command("esxi-02").unwrap();
    assert_eq!(
        cmd.argv,
        [
            "/usr/bin/ssh",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "BatchMode=yes",
            "esxi-02"
        ]
    );
    assert!(cmd.env.contains(&("TERM".into(), "xterm-256color".into())));
}

#[test]
fn session_prepare_refusals_keep_roster_code_and_wording() {
    let b = Backend::start(&fake("ok")).unwrap();
    match b.session_command("scan-1").err().unwrap() {
        roster_core::rpc::CallError::Rpc { code, message, .. } => {
            assert_eq!(code, 20);
            assert!(message.contains("is not reviewed yet"), "{message}");
        }
        other => panic!("{other:?}"),
    }
}

/// How fake_serve.py's one-time askpass tokens start (a counter follows).
const TOKEN: &str = "tok-3b1f9e2a7c";

fn token(cmd: &roster_core::session::SessionCommand) -> String {
    cmd.env
        .iter()
        .find(|(k, _)| k == "ROSTER_ASKPASS_TOKEN")
        .unwrap()
        .1
        .clone()
}

#[test]
fn a_password_host_gets_ssh_with_the_askpass_env_and_says_so() {
    let b = Backend::start(&fake("ok")).unwrap();
    let cmd = b.session_command("sw-core").unwrap();
    assert_eq!(cmd.auth, "password");
    assert_eq!(
        cmd.argv[1..5],
        ["-o", "StrictHostKeyChecking=yes", "-o", "NumberOfPasswordPrompts=1"]
    );
    let names: Vec<&str> = cmd.env.iter().map(|(k, _)| k.as_str()).collect();
    for var in [
        "SSH_ASKPASS",
        "SSH_ASKPASS_REQUIRE",
        "ROSTER_ASKPASS_SOCKET",
        "ROSTER_ASKPASS_TOKEN",
    ] {
        assert!(names.contains(&var), "{var} missing from {names:?}");
    }
    assert!(!format!("{cmd:?}").contains(TOKEN));
}

#[test]
fn a_key_host_says_key() {
    let b = Backend::start(&fake("ok")).unwrap();
    assert_eq!(b.session_command("esxi-02").unwrap().auth, "key");
}

#[test]
fn a_locked_vault_keeps_code_14_for_the_lock_screen() {
    let b = Backend::start(&fake("locked")).unwrap();
    match b.session_command("sw-core").err().unwrap() {
        roster_core::rpc::CallError::Rpc { code, .. } => assert_eq!(code, 14),
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_refusal_keeps_roster_data_for_the_error_panel() {
    // Ticket 26: the app shows `data.near` / `data.matches` and roster's `data.fix`, so the error
    // object's data must reach the frontend (serialized with the CallError) untouched.
    let b = Backend::start(&fake("missing-item")).unwrap();
    let err = b.session_command("sw-core").err().unwrap();
    match &err {
        roster_core::rpc::CallError::Rpc { code, data, .. } => {
            assert_eq!(*code, 32);
            let data = data.as_ref().expect("data");
            assert_eq!(data["near"], serde_json::json!(["sw-core ssh"]));
            assert_eq!(data["fix"], "fix the name in auth:");
        }
        other => panic!("{other:?}"),
    }
    let wire = serde_json::to_value(&err).unwrap();
    assert_eq!(wire["kind"], "rpc");
    assert_eq!(wire["data"]["near"][0], "sw-core ssh");
}

#[test]
fn every_session_command_asks_for_a_fresh_token() {
    // Tokens live 60 s and are spent once: opening (or reconnecting) must never reuse one.
    let b = Backend::start(&fake("ok")).unwrap();
    let first = token(&b.session_command("sw-core").unwrap());
    let second = token(&b.session_command("sw-core").unwrap());
    assert!(first.starts_with(TOKEN));
    assert_ne!(first, second);
}

#[test]
fn a_malformed_session_prepare_names_the_field_but_never_its_value() {
    // serde's own message quotes the bad value ("invalid type: integer `987654321`"), and the env
    // carries the askpass token, so the error may only say which field has the wrong shape.
    let b = Backend::start(&fake("bad-prepare")).unwrap();
    let err = b.session_command("sw-core").err().unwrap();
    let text = format!("{err} {err:?} {}", serde_json::to_string(&err).unwrap());
    assert!(!text.contains("987654321"), "{text}");
    assert!(text.contains("env.ROSTER_ASKPASS_TOKEN"), "{text}");
}

#[test]
fn slow_methods_get_their_own_timeout_and_the_rest_the_default() {
    use roster_core::backend::{CALL_SECS, timeout_for};
    use roster_core::rpc::DEFAULT_TIMEOUT;
    use std::time::Duration;
    assert_eq!(timeout_for("host.add"), Duration::from_secs(180));
    assert_eq!(timeout_for("changes.publish"), Duration::from_secs(180));
    assert_eq!(timeout_for("hosts.list"), DEFAULT_TIMEOUT);
    assert!(CALL_SECS.iter().all(|(_, s)| Duration::from_secs(*s) > DEFAULT_TIMEOUT));
}

#[test]
fn an_unknown_host_key_is_asked_about_then_trusted_then_the_session_opens() {
    // Ticket 36: serve refuses with 44 (and the address to ask about) until the user trusted the
    // key; the core passes that on intact, fetches the key and records the one the user saw.
    use roster_core::backend::HOST_KEY_UNKNOWN;
    let b = Backend::start(&fake("unknown-key")).unwrap();
    match b.session_command("esxi-02").err().unwrap() {
        roster_core::rpc::CallError::Rpc { code, data, .. } => {
            assert_eq!(code, HOST_KEY_UNKNOWN);
            let data = data.expect("data");
            assert_eq!(
                (data["address"].as_str(), data["port"].as_i64()),
                (Some("10.19.77.10"), Some(22))
            );
        }
        other => panic!("{other:?}"),
    }
    let key = b.scan_host_key("esxi-02").unwrap();
    assert_eq!(key["recorded"], "none");
    let fp = key["fingerprint"].as_str().unwrap().to_owned();
    assert_eq!(b.trust_host_key("esxi-02", &fp).unwrap()["recorded"], true);
    assert_eq!(
        b.session_command("esxi-02").unwrap().argv[2],
        "StrictHostKeyChecking=yes"
    );
}

#[test]
fn only_a_fingerprint_is_sent_to_be_trusted() {
    let b = Backend::start(&fake("unknown-key")).unwrap();
    let err = b.trust_host_key("esxi-02", "ssh-ed25519 AAAA").err().unwrap();
    assert!(matches!(err, roster_core::rpc::CallError::Io { .. }), "{err:?}");
    assert!(b.session_command("esxi-02").is_err(), "nothing was recorded");
}

#[test]
fn a_quick_connect_password_goes_to_serve_and_comes_back_as_an_askpass_token() {
    // Ticket 14: the typed password is sent once, inside quick.prepare's params; what comes back is
    // a Session command whose env carries a token, never the password.
    use roster_core::backend::QuickTarget;
    let b = Backend::start(&fake("quick")).unwrap();
    let to = QuickTarget {
        user: "root".into(),
        address: "10.0.0.5".into(),
        port: 2222,
        fingerprint: "SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8".into(),
    };
    let q = b
        .quick_session_command(&to, Some("typed-pw-123".into()), false)
        .unwrap();
    assert_eq!(q.quick, "q1");
    assert_eq!(q.held, None);
    assert_eq!(q.command.auth, "password");
    assert_eq!(
        q.command.argv[q.command.argv.len() - 4..],
        ["-l", "root", "--", "10.0.0.5"]
    );
    assert!(q.command.env.iter().any(|(k, _)| k == "ROSTER_ASKPASS_TOKEN"));
    let shown = format!("{:?}", q.command);
    assert!(!shown.contains("typed-pw-123") && !shown.contains("tok-3b1f9e2a7c-"));
    let key = b.quick_session_command(&to, None, false).unwrap();
    assert_eq!(key.command.auth, "key");
}

#[test]
fn an_auth_prompt_hosts_typed_password_goes_to_serve_once_and_only_its_held_id_comes_back() {
    // Ticket 16: serve answers 39 until the app sends the password typed for the Host.
    let b = Backend::start(&fake("ok")).unwrap();
    let err = b.session_command("pve").err().unwrap();
    assert!(
        matches!(err, roster_core::rpc::CallError::Rpc { code: 39, .. }),
        "{err:?}"
    );
    let s = b.typed_session_command("pve", "typed-pw-123".into(), true).unwrap();
    assert_eq!(s.held.as_deref(), Some("h1"));
    assert_eq!(s.command.auth, "password");
    assert!(!format!("{:?}", s.command).contains("typed-pw-123"));
    let plain = b.typed_session_command("pve", "typed-pw-123".into(), false).unwrap();
    assert_eq!(plain.held, None);
}

#[test]
fn a_quick_connect_to_save_asks_serve_to_hold_the_password_and_hands_back_its_id() {
    // Ticket 15: with "Save to vault" ticked, serve holds the typed password under an id; the app
    // only ever gets the id, which quick.save refers to.
    use roster_core::backend::QuickTarget;
    let b = Backend::start(&fake("quick")).unwrap();
    let to = QuickTarget {
        user: "root".into(),
        address: "10.0.0.5".into(),
        port: 22,
        fingerprint: "SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8".into(),
    };
    let q = b.quick_session_command(&to, Some("typed-pw-123".into()), true).unwrap();
    assert_eq!(q.held.as_deref(), Some("q1"));
    assert!(q.command.argv.iter().any(|a| a == "PermitLocalCommand=yes"));
    assert!(!format!("{:?}", q.command).contains("typed-pw-123"));
}

#[test]
fn a_quick_connect_with_a_key_that_changed_keeps_serves_code_and_never_the_password() {
    use roster_core::backend::QuickTarget;
    let b = Backend::start(&fake("quick")).unwrap();
    let to = QuickTarget {
        user: "root".into(),
        address: "10.0.0.5".into(),
        port: 22,
        fingerprint: "SHA256:AAAAbbbbCCCCddddEEEEffffGGGGhhhhIIIIjjjjKKK".into(),
    };
    let err = b
        .quick_session_command(&to, Some("typed-pw-123".into()), false)
        .err()
        .unwrap();
    assert!(
        matches!(err, roster_core::rpc::CallError::Rpc { code: 23, .. }),
        "{err:?}"
    );
    assert!(!format!("{err:?}").contains("typed-pw-123"));
    // Only a SHA256 fingerprint is ever sent.
    let bad = QuickTarget {
        fingerprint: "ssh-ed25519 AAAA".into(),
        ..to
    };
    assert!(matches!(
        b.quick_session_command(&bad, None, false).err().unwrap(),
        roster_core::rpc::CallError::Io { .. }
    ));
}

/// serve API 21 (ticket 108): a Host's check runs as a job in serve, so no worker of serve waits
/// for it. The core starts it in the background and asks `host.check_job` until it's over; the
/// UI gets the same result as before.
#[test]
fn a_check_runs_as_a_job_when_serve_has_them() {
    let b = Backend::start(&fake("checks")).unwrap();
    let r = b.check_host("esxi-02").unwrap();
    assert_eq!(r["ok"], true);
    assert_eq!(r["steps"][0]["step"], "inventory");
    let info = b.call("inventory.info", serde_json::json!({})).unwrap();
    assert_eq!(info["checks"], serde_json::json!(["esxi-02"]));
}

/// A check the core gave up on is stopped only if the core started it (iteration 9 review, item
/// 2): one it joined is another caller's too, a Plugin's waiting `host.check` say, and serve says
/// which (`joined`, API 22).
#[test]
fn a_check_given_up_on_is_stopped_only_when_the_core_started_it() {
    use std::time::Duration;
    for (how, stops) in [
        ("started", serde_json::json!([{ "kind": "check", "job": "check-1" }])),
        ("joined", serde_json::json!([])),
    ] {
        let mut candidate = fake("stuck-check");
        candidate.serve_argv.push(how.into());
        let b = Backend::start(&candidate).unwrap();
        let err = b.check_host_within("esxi-02", Duration::from_millis(300)).unwrap_err();
        assert!(matches!(err, roster_core::rpc::CallError::Timeout), "{how}: {err:?}");
        let info = b.call("inventory.info", serde_json::json!({})).unwrap();
        assert_eq!(info["stops"], stops, "{how}");
    }
}

#[test]
fn a_check_waits_for_its_answer_on_an_older_serve() {
    let b = Backend::start(&fake("ok")).unwrap();
    let r = b.check_host("esxi-02").unwrap();
    assert_eq!(r["host"], "esxi-02");
    let info = b.call("inventory.info", serde_json::json!({})).unwrap();
    assert_eq!(info["checks"], serde_json::json!([]));
}

/// fake_serve.py's session.fill password (ticket 119).
const FILL_PASSWORD: &str = "fill-pw-9d2e";

/// sw-core as its Session connected to it (fake_serve.py's session.prepare `login`).
fn sw_core() -> FillTarget {
    FillTarget {
        host: "sw-core".into(),
        login: LoginAs {
            address: "10.19.1.2".into(),
            port: 22,
            user: "root".into(),
        },
    }
}

#[test]
fn a_fill_secret_comes_from_session_fill_and_never_prints() {
    let b = Backend::start(&fake("ok")).unwrap();
    let secret = b.fill_secret(&sw_core(), "[sudo] password for root: ", None).unwrap();
    assert!(!format!("{secret:?}").contains(FILL_PASSWORD));
}

#[test]
fn a_refused_fill_keeps_serves_code_and_a_malformed_one_never_shows_its_value() {
    let b = Backend::start(&fake("ok")).unwrap();
    match b
        .fill_secret(
            &FillTarget {
                host: "esxi-02".into(),
                ..sw_core()
            },
            "Username: ",
            None,
        )
        .unwrap_err()
    {
        roster_core::rpc::CallError::Rpc { code, .. } => assert_eq!(code, 130),
        other => panic!("{other:?}"),
    }
    let locked = Backend::start(&fake("locked")).unwrap();
    match locked
        .fill_secret(&sw_core(), "[sudo] password for root: ", None)
        .unwrap_err()
    {
        roster_core::rpc::CallError::Rpc { code, .. } => assert_eq!(code, 14),
        other => panic!("{other:?}"),
    }
    let bad = Backend::start(&fake("bad-fill")).unwrap();
    let err = bad
        .fill_secret(&sw_core(), "[sudo] password for root: ", None)
        .unwrap_err();
    let text = format!("{err} {err:?}");
    assert!(text.contains("`password`") && !text.contains("31337"), "{text}");
}

#[test]
fn a_quick_connect_session_has_no_host_to_fill() {
    let b = Backend::start(&fake("quick")).unwrap();
    let to = roster_core::backend::QuickTarget {
        user: "root".into(),
        address: "10.0.0.5".into(),
        port: 22,
        fingerprint: "SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8".into(),
    };
    assert_eq!(b.quick_session_command(&to, None, false).unwrap().command.fill_as, None);
    let ok = Backend::start(&fake("ok")).unwrap();
    assert_eq!(ok.session_command("sw-core").unwrap().fill_as, Some(sw_core()));
}

#[test]
fn a_session_serve_didnt_say_the_login_of_is_never_filled() {
    // fake_serve.py's old-login mode answers session.prepare as serve before API 25: no `login`.
    let b = Backend::start(&fake("old-login")).unwrap();
    assert_eq!(b.session_command("sw-core").unwrap().fill_as, None);
}

#[test]
fn a_fill_sends_what_the_session_connected_to() {
    // fake_serve.py refuses (130) unless address, port and user are sw-core's.
    let b = Backend::start(&fake("ok")).unwrap();
    let moved = FillTarget {
        login: LoginAs {
            address: "10.19.1.99".into(),
            ..sw_core().login
        },
        ..sw_core()
    };
    match b.fill_secret(&moved, "[sudo] password for root: ", None).unwrap_err() {
        roster_core::rpc::CallError::Rpc { code, .. } => assert_eq!(code, 130),
        other => panic!("{other:?}"),
    }
}

/// esxi-02, the Host a nested ssh in sw-core's Session went to, as the app resolved it (ticket 120).
fn esxi_02() -> FillTarget {
    FillTarget {
        host: "esxi-02".into(),
        login: LoginAs {
            address: "10.19.1.3".into(),
            port: 22,
            user: "root".into(),
        },
    }
}

#[test]
fn a_nested_fill_names_the_host_the_ssh_went_to() {
    // fake_serve.py fills esxi-02's own prompt only with its `hop`, and refuses another address.
    let b = Backend::start(&fake("nested")).unwrap();
    let prompt = "root@esxi-02's password: ";
    assert!(b.fill_secret(&sw_core(), prompt, Some(&esxi_02())).is_ok());
    let moved = FillTarget {
        login: LoginAs {
            address: "10.19.1.99".into(),
            ..esxi_02().login
        },
        ..esxi_02()
    };
    match b.fill_secret(&sw_core(), prompt, Some(&moved)).unwrap_err() {
        roster_core::rpc::CallError::Rpc { code, .. } => assert_eq!(code, 130),
        other => panic!("{other:?}"),
    }
    match b.fill_secret(&sw_core(), prompt, None).unwrap_err() {
        roster_core::rpc::CallError::Rpc { code, .. } => assert_eq!(code, 130),
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_nested_fill_is_never_sent_to_a_serve_that_would_ignore_the_hop() {
    // serve before API 26 doesn't know `hop`: it would answer for the Session's own Host, whose
    // password would then be typed on the nested one. The core refuses before asking.
    let b = Backend::start(&fake("fill-25")).unwrap();
    let err = b
        .fill_secret(&sw_core(), "root@esxi-02's password: ", Some(&esxi_02()))
        .unwrap_err();
    assert!(err.to_string().contains("API 26"), "{err}");
    assert!(!err.to_string().contains(FILL_PASSWORD));
    // Its own Host's fill still goes.
    assert!(b.fill_secret(&sw_core(), "[sudo] password for root: ", None).is_ok());
}

#[test]
fn no_plugin_may_ever_ask_serve_for_a_fill() {
    assert!(!roster_core::plugin::permission::serve_method_allowed("session.fill"));
}

#[test]
fn no_plugin_may_run_the_fill_command() {
    assert!(!roster_core::plugin::api::COMMANDS.iter().any(|c| c.name == "fill"));
}
