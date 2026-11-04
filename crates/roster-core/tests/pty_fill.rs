//! Filling a password prompt (ticket 119, decision Q129): `SessionManager::fill` types a Host
//! Session's secret into its PTY only after a probe shows the prompt doesn't echo, and never
//! into a Session with no Host. Real PTYs with `sh` standing in for the Host's prompt. Unix
//! only, as pty.rs.
#![cfg(unix)]

use roster_core::session::{
    FillError, FillTarget, Hop, LoginAs, PROBE, Secret, SessionCommand, SessionEvent, SessionManager, Size,
};
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};

mod common;

const SIZE: Size = Size { cols: 80, rows: 24 };
/// The fill's wait: how long its probe gives the prompt to echo, or draw anything (the app's is
/// 800 ms). Generous (T164): the stand-ins echo and draw from `sh`, a process or two per key, which
/// a loaded machine can hold up for longer than that, and a key or resize a test sends once the
/// stand-in has read the probe's first key must still land inside it.
const WAIT: Duration = Duration::from_secs(2);
const SECRET: &str = "s3cret-pw";
/// The token on roster's own shell marks for every stand-in Session (decision Q131 (a)).
const TOKEN: &str = "0123456789abcdef01234567";
/// The Session's own shell starting a command, as roster's hook marks it: the nested ssh a hop
/// fill is for (ticket 162, #284 item 2). Put before a stand-in's script.
const RUN: &str = "printf '\\033]133;C;roster=0123456789abcdef01234567\\007'; ";

fn host_sh(script: &str) -> SessionCommand {
    let mut cmd = SessionCommand::new(vec!["sh".into(), "-c".into(), script.into()], vec![]);
    cmd.marks = Some(TOKEN.into());
    cmd.fill_as = Some(FillTarget {
        host: "esx".into(),
        login: LoginAs {
            address: "10.0.0.6".into(),
            port: 22,
            user: "ops".into(),
        },
    });
    cmd
}

fn open(m: &SessionManager, cmd: SessionCommand) -> (u32, Receiver<SessionEvent>) {
    let (tx, rx) = channel();
    let id = m
        .open(&cmd, SIZE, move |e| {
            let _ = tx.send(e);
        })
        .expect("spawn");
    (id, rx)
}

/// How long a broken test waits before it says so (T146, T164): never how long anything is
/// expected to take. A loaded machine pauses a process for seconds.
const CEILING: Duration = Duration::from_secs(60);

/// Everything printed from now until it holds `needle` (panics after [`CEILING`]).
fn until(rx: &Receiver<SessionEvent>, needle: &str) -> String {
    seen_until(rx, needle, |s| s.contains(needle))
}

/// Everything printed from now until it ends with `tail`, the last thing the stand-in prints
/// before it waits for a key (T164). The core's screen takes in each chunk before the Session's
/// sink gets it, so from here the fill sees all of it: no sleep for the rest of a prompt to come.
fn shown(rx: &Receiver<SessionEvent>, tail: &str) -> String {
    seen_until(rx, tail, |s| s.ends_with(tail))
}

/// Everything printed from now through the stand-in's own report, `got:[…]` and its line end: all
/// it echoed or drew for what it read comes before it, so nothing more needs waiting for (T161's
/// marker, not a quiet spell).
fn report(rx: &Receiver<SessionEvent>) -> String {
    seen_until(rx, "got:[…]", |s| {
        s.rfind("got:[")
            .and_then(|at| s[at..].find(']').map(|end| at + end))
            .is_some_and(|end| s[end..].contains('\n'))
    })
}

fn seen_until(rx: &Receiver<SessionEvent>, what: &str, done: impl Fn(&str) -> bool) -> String {
    let deadline = Instant::now() + CEILING;
    let mut seen = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(SessionEvent::Output(b)) => {
                seen.extend_from_slice(&b);
                let s = String::from_utf8_lossy(&seen).into_owned();
                if done(&s) {
                    return s;
                }
            }
            Ok(_) => {}
            Err(_) => panic!(
                "no {what:?} within {CEILING:?}; saw {:?}",
                String::from_utf8_lossy(&seen)
            ),
        }
    }
}

/// What `printf` prints for a stand-in's format (`\033`, `\r`, `\n`, `\b`), to wait for it.
fn printed_by(format: &str) -> String {
    format
        .replace("\\033", "\x1b")
        .replace("\\r", "\r")
        .replace("\\n", "\n")
        .replace("\\b", "\x08")
}

/// A folder a stand-in and its test signal each other through (T164), in place of sleeps: the
/// stand-in waits for the test's `go` ([`GO`]), and says it has read a key with `$SIG/read`
/// ([`READ`]). Its path goes to the stand-in as `$SIG`.
struct Sig(common::Temp);

/// In a stand-in: wait until the test says go.
const GO: &str = "while [ ! -e \"$SIG/go\" ]; do sleep 0.01; done";
/// In a stand-in: say a key was read (nothing if the stand-in has no `$SIG`). A builtin, not
/// `touch`: a stand-in that draws for each key mustn't be slowed by another process per key.
const READ: &str = "[ -z \"$SIG\" ] || true 2>/dev/null >\"$SIG/read\"";

impl Sig {
    fn new() -> Sig {
        Sig(common::temp("pty-fill-sig"))
    }

    /// `cmd` with this folder as its `$SIG`.
    fn on(&self, mut cmd: SessionCommand) -> SessionCommand {
        cmd.env.push(("SIG".into(), self.0.to_string_lossy().into_owned()));
        cmd
    }

    fn go(&self) {
        std::fs::write(self.0.join("go"), "").unwrap();
    }

    /// Returns once the stand-in has read a key (panics after [`CEILING`]).
    fn read(&self) {
        let deadline = Instant::now() + CEILING;
        while !self.0.join("read").exists() {
            assert!(Instant::now() < deadline, "the stand-in read no key within {CEILING:?}");
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}

/// A nested ssh's Host, as the frontend resolved it at the Session's own `run`th command.
fn at_run(run: u64, to: FillTarget) -> Hop {
    Hop { to, run: Some(run) }
}

fn secret() -> Result<Secret, String> {
    Ok(Secret::new(SECRET.to_string()))
}

/// A prompt that turns echo off, as sudo's does, and reports what it read.
const NO_ECHO: &str = "stty -echo; printf 'Password: '; read -r pw; stty echo; echo; echo \"got:[$pw]\"; sleep 5";

#[test]
fn a_no_echo_prompt_gets_the_secret_and_enter() {
    let m = SessionManager::new();
    let (id, rx) = open(&m, host_sh(NO_ECHO));
    shown(&rx, "Password: ");
    let mut asked = None;
    let host = m
        .fill(id, WAIT, "Password:", None, |h| {
            asked = Some(format!(
                "{}@{}:{} ({})",
                h.login.user, h.login.address, h.login.port, h.host
            ));
            secret()
        })
        .expect("filled");
    assert_eq!(
        (host.as_str(), asked.as_deref()),
        ("esx", Some("ops@10.0.0.6:22 (esx)"))
    );
    let out = report(&rx);
    assert!(out.contains(&format!("got:[{SECRET}]")), "{out:?}");
    // The secret came back only in the stand-in's own report, never as an echo of the fill.
    assert_eq!(out.matches(SECRET).count(), 1, "{out:?}");
    m.close(id).unwrap();
}

#[test]
fn what_was_typed_at_the_prompt_before_is_cleared_first() {
    let m = SessionManager::new();
    let (id, rx) = open(&m, host_sh(NO_ECHO));
    shown(&rx, "Password: ");
    // Written to the PTY before the fill starts, so it's there before the probe.
    m.write(id, b"half-typ").unwrap();
    m.fill(id, WAIT, "Password:", None, |_| secret()).expect("filled");
    let out = report(&rx);
    assert!(out.contains(&format!("got:[{SECRET}]")), "{out:?}");
    m.close(id).unwrap();
}

#[test]
fn an_echoing_prompt_is_refused_and_the_secret_never_typed() {
    let m = SessionManager::new();
    let (id, rx) = open(
        &m,
        host_sh("printf 'Password: '; read -r pw; echo \"got:[$pw]\"; sleep 5"),
    );
    shown(&rx, "Password: ");
    let err = m.fill(id, WAIT, "Password:", None, |_| secret()).unwrap_err();
    assert!(matches!(err, FillError::Echoes(_)), "{err:?}");
    // The probe's letter was echoed and taken back; nothing else reached the prompt.
    m.write(id, b"\r").unwrap();
    let out = report(&rx);
    assert!(out.contains("got:[]"), "{out:?}");
    assert!(!out.contains(SECRET), "{out:?}");
    m.close(id).unwrap();
}

#[test]
fn output_while_it_checks_refuses_too() {
    let m = SessionManager::new();
    // Output that comes once the probe's first key is in (T164: not 0.2 s after the prompt,
    // which a loaded machine can bring before the fill starts or after it ends).
    let script = "stty -echo -icanon min 1 time 0; printf 'Password: '; dd bs=1 count=1 >/dev/null 2>&1; echo late output; sleep 5";
    let (id, rx) = open(&m, host_sh(script));
    shown(&rx, "Password: ");
    let err = m.fill(id, WAIT, "Password:", None, |_| secret()).unwrap_err();
    assert!(matches!(err, FillError::Echoes(_)), "{err:?}");
    m.close(id).unwrap();
}

#[test]
fn keys_typed_while_it_checks_refuse() {
    let m = std::sync::Arc::new(SessionManager::new());
    let sig = std::sync::Arc::new(Sig::new());
    // It reads the probe's keys one by one, quietly, and says when it has one.
    let script = format!(
        "stty -echo -icanon min 1 time 0; printf 'Password: '; \
         while :; do dd bs=1 count=1 >/dev/null 2>&1; {READ}; done"
    );
    let (id, rx) = open(&m, sig.on(host_sh(&script)));
    shown(&rx, "Password: ");
    // The key goes once the probe is in, so it's typed while the fill checks.
    let typer = {
        let m = std::sync::Arc::clone(&m);
        let sig = std::sync::Arc::clone(&sig);
        std::thread::spawn(move || {
            sig.read();
            m.write(id, b"a").unwrap();
        })
    };
    let err = m.fill(id, WAIT, "Password:", None, |_| secret()).unwrap_err();
    typer.join().unwrap();
    assert!(matches!(err, FillError::Typed), "{err:?}");
    m.close(id).unwrap();
}

#[test]
fn a_refused_lookup_types_nothing() {
    let m = SessionManager::new();
    let (id, rx) = open(
        &m,
        host_sh("printf 'Password: '; read -r pw; echo \"got:[$pw]\"; sleep 5"),
    );
    shown(&rx, "Password: ");
    let err = m
        .fill(id, WAIT, "Password:", None, |_| Err::<Secret, _>("locked".to_string()))
        .unwrap_err();
    assert!(matches!(&err, FillError::Lookup(e) if e == "locked"), "{err:?}");
    // Not even the probe: an echoing prompt shows only the Enter sent after, and read nothing.
    m.write(id, b"\r").unwrap();
    assert_eq!(report(&rx), "\r\ngot:[]\r\n");
    m.close(id).unwrap();
}

#[test]
fn a_session_with_no_host_is_never_filled() {
    let m = SessionManager::new();
    let cmd = SessionCommand::new(vec!["sh".into(), "-c".into(), NO_ECHO.into()], vec![]);
    let (id, rx) = open(&m, cmd);
    shown(&rx, "Password: ");
    let mut asked = false;
    let err = m
        .fill(id, WAIT, "Password:", None, |_| {
            asked = true;
            secret()
        })
        .unwrap_err();
    assert!(matches!(err, FillError::NoHost) && !asked, "{err:?}");
    m.close(id).unwrap();
}

#[test]
fn an_ended_session_is_not_found() {
    let m = SessionManager::new();
    let err = m.fill(42, WAIT, "Password:", None, |_| secret()).unwrap_err();
    assert!(matches!(err, FillError::NotFound(42)), "{err:?}");
}

#[test]
fn a_secret_never_prints() {
    let s = Secret::new(SECRET.to_string());
    assert!(!format!("{s:?}").contains(SECRET));
    let e: FillError<String> = FillError::Echoes(None);
    assert!(!format!("{e} {e:?}").contains(SECRET));
}

#[test]
fn keys_sent_while_the_vault_answers_refuse() {
    let m = SessionManager::new();
    let (id, rx) = open(
        &m,
        host_sh("stty -echo; printf 'Password: '; read -r pw; echo \"got:[$pw]\"; sleep 5"),
    );
    shown(&rx, "Password: ");
    let err = m
        .fill(id, WAIT, "Password:", None, |_| {
            // A key goes to the Session while the lookup waits on the vault.
            m.write(id, b"").ok();
            secret()
        })
        .unwrap_err();
    assert!(matches!(err, FillError::Typed), "{err:?}");
    m.close(id).unwrap();
}

#[test]
fn output_while_the_vault_answers_refuses_too() {
    let m = SessionManager::new();
    let sig = Sig::new();
    let script =
        format!("stty -echo; printf 'Password: '; ({GO}; echo late output) & read -r pw; echo \"got:[$pw]\"; sleep 5");
    let (id, rx) = open(&m, sig.on(host_sh(&script)));
    shown(&rx, "Password: ");
    // The lookup lets the late output go and answers once the core has it, before the probe.
    let err = m
        .fill(id, WAIT, "Password:", None, |_| {
            sig.go();
            until(&rx, "late output");
            secret()
        })
        .unwrap_err();
    assert!(matches!(err, FillError::Changed { .. }), "{err:?}");
    m.close(id).unwrap();
}

/// Ticket 137 (#243 b): the Session's own Host's fill types only at a prompt its output ends with,
/// as a nested fill does; the frontend's word that a prompt is up isn't enough.
#[test]
fn an_own_host_fill_types_only_at_a_prompt_the_session_ends_with() {
    let m = SessionManager::new();
    // The prompt went by, then other output: the cursor isn't at it any more.
    let script = "stty -echo; printf '[sudo] password for ops: \\nsudo: 1 incorrect password attempt\\n$ '; read -r pw; echo \"got:[$pw]\"; sleep 5";
    let (id, rx) = open(&m, host_sh(script));
    shown(&rx, "attempt\r\n$ ");
    for prompt in ["[sudo] password for ops:", "[sudo] password for root:", "", "   "] {
        let mut asked = false;
        match m.fill(id, WAIT, prompt, None, |_| {
            asked = true;
            secret()
        }) {
            Err(FillError::NotPrinted) => {}
            other => panic!("{prompt:?}: {other:?}"),
        }
        assert!(!asked, "{prompt:?}: the vault was asked");
    }
    // Nothing was typed: not the probe, not the secret.
    m.write(id, b"\r").unwrap();
    let out = report(&rx);
    assert!(out.contains("got:[]"), "{out:?}");
    m.close(id).unwrap();
}

#[test]
fn an_own_host_fill_types_at_sudos_prompt_when_the_output_ends_with_it() {
    let m = SessionManager::new();
    let script = "printf 'motd\\n$ sudo ls\\n'; stty -echo; printf '\\033[1m[sudo] password for ops:\\033[m '; read -r pw; stty echo; echo; echo \"got:[$pw]\"; sleep 5";
    let (id, rx) = open(&m, host_sh(script));
    shown(&rx, "ops:\x1b[m ");
    let host = m
        .fill(id, WAIT, "[sudo] password for ops:", None, |_| secret())
        .expect("filled");
    assert_eq!(host, "esx");
    let out = report(&rx);
    assert!(out.contains(&format!("got:[{SECRET}]")), "{out:?}");
    m.close(id).unwrap();
}

/// A nested ssh's login prompt, as OpenSSH prints it, with echo off (ticket 120).
const NESTED: &str =
    "stty -echo; printf \"ops@esx-02's password: \"; read -r pw; stty echo; echo; echo \"got:[$pw]\"; sleep 5";

#[test]
fn a_nested_fill_types_only_at_a_prompt_the_session_printed() {
    let m = SessionManager::new();
    let (id, rx) = open(&m, host_sh(&format!("{RUN}{NESTED}")));
    shown(&rx, "password: ");
    // A prompt the Session never printed (the frontend's word alone) is refused before the vault.
    let mut asked = false;
    let hop = at_run(
        1,
        FillTarget {
            host: "esx-02".into(),
            login: LoginAs {
                address: "10.0.0.12".into(),
                port: 22,
                user: "ops".into(),
            },
        },
    );
    match m.fill(id, WAIT, "ops@esx-03's password:", Some(&hop), |_| {
        asked = true;
        secret()
    }) {
        Err(FillError::NotPrinted) => {}
        other => panic!("{other:?}"),
    }
    assert!(!asked);
    m.fill(id, WAIT, "ops@esx-02's password:", Some(&hop), |_| secret())
        .expect("filled");
    let out = report(&rx);
    assert!(out.contains(&format!("got:[{SECRET}]")), "{out:?}");
    m.close(id).unwrap();
}

/// Whether a fill at `prompt` gets past the printed-prompt check (ticket 137, review #8: through
/// `fill` itself): the lookup is then asked, and refuses, so nothing is typed.
fn passes_check(m: &SessionManager, id: u32, prompt: &str) -> bool {
    match m.fill(id, WAIT, prompt, None, |_| Err::<Secret, _>("asked".to_string())) {
        Err(FillError::Lookup(_)) => true,
        Err(FillError::NotPrinted) => false,
        other => panic!("{prompt:?}: {other:?}"),
    }
}

/// A Session that prints `script`'s output and waits, once the core has all of it: it ends with
/// `last`.
fn printed(m: &SessionManager, script: &str, last: &str) -> u32 {
    let (id, rx) = open(m, host_sh(&format!("{script}; sleep 5")));
    shown(&rx, last);
    id
}

#[test]
fn a_nested_fill_needs_the_prompt_at_the_end_of_the_output() {
    // A prompt that went by earlier, with other output after it, isn't the one the cursor is at.
    let m = SessionManager::new();
    let id = printed(
        &m,
        "printf \"ops@esx-02's password: \\nPermission denied\\nlast login \"",
        "last login ",
    );
    assert!(!passes_check(&m, id, "ops@esx-02's password:"));
    assert!(passes_check(&m, id, "last login"));
    m.close(id).unwrap();
}

#[test]
fn a_nested_fill_looks_only_at_recent_output() {
    // The prompt went by, then pages of padding and a dot: the cursor is after the dot.
    let m = SessionManager::new();
    let id = printed(
        &m,
        "printf \"ops@esx-02's password: \"; head -c 6000 /dev/zero | tr '\\0' ' '; printf '.'",
        ".",
    );
    assert!(!passes_check(&m, id, "ops@esx-02's password:"));
    m.close(id).unwrap();
}

#[test]
fn a_nested_fill_reads_the_prompt_through_a_conpty_style_redraw() {
    // ConPTY repaints: a clear and cursor position, colour changes inside the line, cursor-forward
    // for a space, the cursor parked after the prompt.
    let m = SessionManager::new();
    let id = printed(
        &m,
        "printf '\\033[2J\\033[1;1H\\033[1mops\\033[0m@esx-02'\"'\"'s\\033[1Cpassword:\\033[m\\033[1;24H'",
        "password:\x1b[m\x1b[1;24H",
    );
    assert!(passes_check(&m, id, "ops@esx-02's password:"));
    assert!(!passes_check(&m, id, "ops@esx-03's password:"));
    m.close(id).unwrap();
}

/// Ticket 137 (review #4): the Session's own Host's fill reads the prompt as the terminal shows it,
/// through ConPTY's redraws, and still refuses a prompt the cursor isn't right after.
#[test]
fn an_own_host_fill_reads_its_prompt_through_conpty_redraws() {
    const SUDO: &str = "[sudo] password for ops:";
    // Each: what's printed, the last thing to wait for, whether the prompt is at the cursor.
    let cases: &[(&str, &str, &str, bool)] = &[
        (
            "a column set (CHA) for the space",
            "printf '[sudo]\\033[8Gpassword for ops: '",
            "ops: ",
            true,
        ),
        (
            "erased characters (ECH) as spaces",
            "printf '[sudo]\\033[1X\\033[1Cpassword\\033[3X\\033[1Cfor ops: '",
            "ops: ",
            true,
        ),
        (
            "a backspace and an overwrite",
            "printf '[sudo] passwordX\\010 for ops: '",
            "ops: ",
            true,
        ),
        (
            "a carriage return over a longer line, erased",
            "printf 'Last login: Mon from 10.0.0.9 on pts/0\\r[sudo] password for ops: \\033[K'",
            "ops: \x1b[K",
            true,
        ),
        (
            "a full repaint with the cursor parked after it",
            "printf '\\033[?25l\\033[H$ sudo ls\\033[K\\r\\n[sudo] password for ops: \\033[K\\r\\n\\033[K\\033[2;26H\\033[?25h'",
            "25h",
            true,
        ),
        (
            "a repaint after scrolling, cursor addressed on the screen",
            "i=0; while [ $i -lt 30 ]; do echo line $i; i=$((i+1)); done; printf '[sudo] password for ops: \\033[24;26H'",
            "26H",
            true,
        ),
        (
            "a carriage return over a longer line, not erased",
            "printf 'Last login: Mon from 10.0.0.9 on pts/0\\r[sudo] password for ops: '",
            "ops: ",
            false,
        ),
        (
            "output on the next line",
            "printf '[sudo] password for ops: \\r\\nmotd'",
            "motd",
            false,
        ),
        (
            "the cursor moved away from it",
            "printf '[sudo] password for ops: \\033[1;1H'",
            "1H",
            false,
        ),
    ];
    for (name, script, last, at) in cases {
        let m = SessionManager::new();
        let id = printed(&m, &format!("printf '\\033[2J\\033[H'; {script}"), last);
        assert_eq!(passes_check(&m, id, SUDO), *at, "{name}");
        m.close(id).unwrap();
    }
}

#[test]
fn a_nested_fill_says_the_host_whose_password_it_typed() {
    let m = SessionManager::new();
    let (id, rx) = open(&m, host_sh(&format!("{RUN}{NESTED}")));
    shown(&rx, "password: ");
    let hop = at_run(
        1,
        FillTarget {
            host: "esx-02".into(),
            login: LoginAs {
                address: "10.0.0.12".into(),
                port: 22,
                user: "ops".into(),
            },
        },
    );
    let host = m
        .fill(id, WAIT, "ops@esx-02's password:", Some(&hop), |_| secret())
        .expect("filled");
    assert_eq!(host, "esx-02");
    m.close(id).unwrap();
}

/// One of roster's own shell marks (decision Q131 (a)) as `sh`'s printf writes it: `kind` with the
/// Session's token, or `token`'s.
fn mark(kind: &str, token: &str) -> String {
    format!("printf '\\033]133;{kind};roster={token}\\007'; ")
}

fn esx_02() -> FillTarget {
    FillTarget {
        host: "esx-02".into(),
        login: LoginAs {
            address: "10.0.0.12".into(),
            port: 22,
            user: "ops".into(),
        },
    }
}

/// Ticket 162 (#284 item 2, the review of #283, #4): a hop's fill goes only to the nested ssh the
/// frontend resolved it from, which the core knows positively: the last of the Session's own
/// shell's marks (with its token) is the `C` that started it, that shell's `run`th. Once that ssh
/// has ended (the shell's `D`), another command started (a later `C`), or the Session has no marks
/// of its own, the hop's password never goes to the prompt the Session shows now, even one that
/// reads the same (sudo's on the outer Host for the same user). Nothing is looked up or typed.
#[test]
fn a_nested_fill_goes_only_to_the_ssh_the_sessions_own_shell_still_runs() {
    const SUDO: &str =
        "stty -echo; printf '[sudo] password for ops: '; read -r pw; stty echo; echo; echo \"got:[$pw]\"; sleep 5";
    let other = "fedcba9876543210fedcba98";
    let c = mark("C", TOKEN);
    let ended = format!("{}{}{}", mark("D;0", TOKEN), mark("A", TOKEN), mark("B", TOKEN));
    // Each: name, the stand-in, whether it opens with roster's token, the hop's run, filled.
    let cases: Vec<(&str, String, bool, u64, bool)> = vec![
        ("in the ssh", format!("{c}{SUDO}"), true, 1, true),
        ("the ssh ended", format!("{c}{ended}{SUDO}"), true, 1, false),
        (
            "the ssh ended, then sudo on the outer Host",
            format!("{c}{ended}{c}{SUDO}"),
            true,
            1,
            false,
        ),
        (
            "its second ssh, as resolved",
            format!("{c}{ended}{c}{SUDO}"),
            true,
            2,
            true,
        ),
        ("the ssh not started yet", SUDO.to_string(), true, 1, false),
        (
            "marks with another token after it ended",
            format!("{c}{ended}{}{SUDO}", mark("C", other)),
            true,
            1,
            false,
        ),
        ("no token of its own", format!("{c}{SUDO}"), false, 1, false),
        (
            "a mark split across reads",
            format!("printf '\\033]133;C;rost'; {GO}; printf 'er={TOKEN}\\007'; {SUDO}"),
            true,
            1,
            true,
        ),
    ];
    for (name, script, token, run, filled) in cases {
        let m = SessionManager::new();
        let mut cmd = host_sh(&script);
        if !token {
            cmd.marks = None;
        }
        let sig = Sig::new();
        let (id, rx) = open(&m, sig.on(cmd));
        if script.contains(GO) {
            // The mark's second half goes once the core has read its first.
            until(&rx, "\x1b]133;C;rost");
            sig.go();
        }
        shown(&rx, "ops: ");
        let mut asked = false;
        let got = m.fill(
            id,
            WAIT,
            "[sudo] password for ops:",
            Some(&at_run(run, esx_02())),
            |_| {
                asked = true;
                secret()
            },
        );
        if filled {
            assert_eq!(got.as_deref().ok(), Some("esx-02"), "{name}: {got:?}");
        } else {
            assert!(matches!(got, Err(FillError::NotInHop)), "{name}: {got:?}");
            assert!(!asked, "{name}: the vault was asked");
            m.write(id, b"\r").unwrap();
        }
        let out = report(&rx);
        assert_eq!(out.contains(SECRET), filled, "{name}: {out:?}");
        m.close(id).unwrap();
    }
    // It typed nothing: the code that keeps the prompt offered once the app's view catches up.
    let refusal = roster_core::backend::fill_refusal(FillError::NotInHop);
    assert!(format!("{refusal:?}").contains("130"), "{refusal:?}");
}

/// The review of #308 (#3, #5): a token that isn't 8 to 64 lowercase hex characters is no token
/// (an empty or short one could be guessed), and a hop that doesn't say which command it is has
/// no command to match: both refuse, nothing asked or typed.
#[test]
fn a_nested_fill_needs_a_real_token_and_the_hops_run() {
    const SUDO: &str =
        "stty -echo; printf '[sudo] password for ops: '; read -r pw; stty echo; echo; echo \"got:[$pw]\"; sleep 5";
    let short = "0123456";
    let upper = "0123456789ABCDEF01234567";
    let long = "0".repeat(65);
    let cases: Vec<(&str, Option<&str>, Option<u64>)> = vec![
        ("an empty token", Some(""), Some(1)),
        ("a short token", Some(short), Some(1)),
        ("upper case", Some(upper), Some(1)),
        ("too long", Some(long.as_str()), Some(1)),
        ("a hop with no run", Some(TOKEN), None),
    ];
    for (name, token, run) in cases {
        let m = SessionManager::new();
        let mut cmd = host_sh(&format!("{}{SUDO}", mark("C", token.unwrap_or(""))));
        cmd.marks = token.map(String::from);
        let (id, rx) = open(&m, cmd);
        shown(&rx, "ops: ");
        let mut asked = false;
        let hop = Hop { to: esx_02(), run };
        let got = m.fill(id, WAIT, "[sudo] password for ops:", Some(&hop), |_| {
            asked = true;
            secret()
        });
        assert!(matches!(got, Err(FillError::NotInHop)), "{name}: {got:?}");
        assert!(!asked, "{name}: the vault was asked");
        m.close(id).unwrap();
    }
    // An app that sends no `run` gets this refusal, not a malformed call.
    let hop: Hop = serde_json::from_str(r#"{"host":"esx-02","address":"10.0.0.12","port":22,"user":"ops"}"#).unwrap();
    assert_eq!(hop.run, None);
}

/// Ticket 162 (#284 item 4): a fill whose Session is closed while it checks (the PTY's writer is
/// gone) leaves nothing of the fill behind: keys sent after it aren't held (they fail, the Session
/// isn't open), and the next fill isn't refused as a fill already under way.
#[test]
fn a_fill_whose_session_closes_meanwhile_leaves_nothing_set() {
    // A shell that ignores the hang-up: the Session stays listed while its PTY is gone.
    let script = format!("trap '' HUP; {}", pwfeedback(SUDO_OPS, "", "*", ":"));
    let m = SessionManager::new();
    let (id, rx) = open(&m, host_sh(&script));
    shown(&rx, "ops: ");
    let got = m.fill(id, WAIT, "[sudo] password for ops:", None, |_| {
        m.close(id).unwrap();
        secret()
    });
    assert!(matches!(got, Err(FillError::NotFound(_))), "{got:?}");
    assert!(m.write(id, b"x").is_err(), "a key was held after the fill ended");
    let again = m.fill(id, WAIT, "[sudo] password for ops:", None, |_| secret());
    assert!(!matches!(again, Err(FillError::Busy)), "{again:?}");
}

/// Ticket 137 (review #2): a refusal that typed nothing comes back with serve's "won't fill this
/// prompt" code (130), so the app offers the prompt again; one that typed the probe has no code.
#[test]
fn a_refusal_that_typed_nothing_has_a_code_and_one_that_typed_the_probe_doesnt() {
    use roster_core::backend::fill_refusal;
    use roster_core::rpc::CallError;
    match fill_refusal(FillError::NotPrinted) {
        CallError::Rpc { code: 130, message, .. } => {
            assert!(message.contains("isn't at that prompt"), "{message}")
        }
        other => panic!("{other:?}"),
    }
    for typed in [FillError::Echoes(None), FillError::Typed] {
        assert!(matches!(fill_refusal(typed), CallError::Io { .. }));
    }
    let serve = CallError::Rpc {
        code: 131,
        message: "no saved password".into(),
        data: None,
    };
    assert!(matches!(
        fill_refusal(FillError::Lookup(serve)),
        CallError::Rpc { code: 131, .. }
    ));
}

/// sudo with `Defaults pwfeedback` (ticket 154, #279), as sudo's `tgetpass.c` does it: echo off
/// and the line discipline's canonical mode off, its prompt, then a `*` for each key read and, on
/// the line-kill key (Ctrl+U), `\b \b` for each `*` shown. `kill_tail` is what it adds after a
/// kill: nothing in released sudo (to 1.9.17p2), `ESC [ K` (erase to the end of the line) in sudo
/// since 2026-05 (commit 0abd1b1), which prints it after every kill, even of an empty line.
/// `prompt`, `before` (run once the prompt is up) and `mask` (what it draws per key) vary it for
/// the cases that must still refuse. It reports what it read, as the other stand-ins do.
fn pwfeedback(prompt: &str, kill_tail: &str, mask: &str, before: &str) -> String {
    erasing(prompt, "\\b \\b", kill_tail, mask, before)
}

/// [`pwfeedback`] with `erase` for each `*` it takes back: `\b \b` as sudo writes it, or what a
/// terminal layer (ConPTY) may redraw it as.
fn erasing(prompt: &str, erase: &str, kill_tail: &str, mask: &str, before: &str) -> String {
    format!(
        "U=$(printf '\\025'); stty -echo -icanon min 1 time 0; printf '%s' '{prompt}'; {before}; pw=''; n=0; \
         while :; do c=$(dd bs=1 count=1 2>/dev/null); {READ}; \
         if [ \"$c\" = \"$U\" ]; then while [ $n -gt 0 ]; do printf '{erase}'; n=$((n-1)); done; printf '{kill_tail}'; pw=''; \
         elif [ -z \"$c\" ]; then break; \
         else pw=\"$pw$c\"; n=$((n+1)); printf '{mask}'; fi; done; \
         while [ $n -gt 0 ]; do printf '{erase}'; n=$((n-1)); done; stty sane; echo; echo \"got:[$pw]\"; sleep 5",
        prompt = prompt.replace('\'', "'\"'\"'")
    )
}

const SUDO_OPS: &str = "[sudo] password for ops: ";
/// sudo since 2026-05: `ESC [ K` after each kill.
const ERASE_LINE: &str = "\\033[K";

/// Fills the stand-in at `prompt` (as the frontend names it), with `hop` for a nested ssh's Host.
/// Once the fill has ended, it says go ([`Sig`]), for a stand-in that holds something back until
/// then.
fn fill_pwfeedback(script: &str, prompt: &str, hop: Option<&Hop>) -> (Result<String, FillError<String>>, String) {
    let m = SessionManager::new();
    let sig = Sig::new();
    // A hop's fill is for the nested ssh the Session's own shell runs now (ticket 162).
    let script = if hop.is_some() {
        format!("{RUN}{script}")
    } else {
        script.to_string()
    };
    let (id, rx) = open(&m, sig.on(host_sh(&script)));
    // What the stand-in prints last: the prompt, and the space after it if it prints one.
    let spaced = format!("{prompt} ");
    let tail = if script.contains(&format!("{} '", prompt.replace('\'', "'\"'\"'"))) {
        spaced.as_str()
    } else {
        prompt
    };
    shown(&rx, tail);
    let got = m.fill(id, WAIT, prompt, hop, |_| secret());
    sig.go();
    if got.is_err() {
        // Nothing but the probe was typed: Enter shows what the prompt holds.
        m.write(id, b"\r").unwrap();
    }
    let out = report(&rx);
    m.close(id).unwrap();
    (got, out)
}

#[test]
fn sudo_with_pwfeedback_is_filled_both_ways_sudo_erases() {
    for (name, tail) in [("released sudo", ""), ("sudo since 2026-05", ERASE_LINE)] {
        let (got, out) = fill_pwfeedback(&pwfeedback(SUDO_OPS, tail, "*", ":"), "[sudo] password for ops:", None);
        assert_eq!(got.as_deref().ok(), Some("esx"), "{name}: {got:?} {out:?}");
        assert!(out.contains(&format!("got:[{SECRET}]")), "{name}: {out:?}");
        // The password drew stars and was never printed: only the stand-in's own report has it.
        assert_eq!(out.matches(SECRET).count(), 1, "{name}: {out:?}");
        assert!(out.contains(&"*".repeat(SECRET.len())), "{name}: {out:?}");
    }
}

/// Ticket 154, after the review of #283 (#4): the mask is taken as no echo only for the Session's
/// own Host. A nested ssh's Host's sudo with pwfeedback refuses, as before.
#[test]
fn sudo_with_pwfeedback_on_a_nested_host_still_refuses() {
    let hop = at_run(
        1,
        FillTarget {
            host: "esx-02".into(),
            login: LoginAs {
                address: "10.0.0.12".into(),
                port: 22,
                user: "admin".into(),
            },
        },
    );
    for (prompt, line) in [
        ("[sudo] password for admin: ", "[sudo] password for admin:"),
        (SUDO_OPS, "[sudo] password for ops:"),
    ] {
        let (got, out) = fill_pwfeedback(&pwfeedback(prompt, "", "*", ":"), line, Some(&hop));
        assert!(matches!(got, Err(FillError::Echoes(_))), "{line}: {got:?}");
        assert!(out.contains("got:[]") && !out.contains(SECRET), "{line}: {out:?}");
    }
}

/// Ticket 154 (the review of #283, #7): ConPTY on Windows renders the Session's output itself, so
/// sudo's `\b \b` may reach the core as other cursor moves and erases. What the terminal draws
/// decides, not the bytes: each of these leaves the prompt line and the cursor as they were.
#[test]
fn sudo_with_pwfeedback_is_filled_through_conpty_style_redraws() {
    for (name, erase, tail) in [
        (
            "a column set and an erase, the cursor hidden",
            "\\033[?25l\\033[26G\\033[K\\033[?25h",
            "",
        ),
        ("cursor back and an erase", "\\033[D\\033[K", ""),
        ("backspace and erase characters", "\\b\\033[X", ""),
        ("a carriage return and cursor forward", "\\r\\033[25C \\033[D", ""),
        ("cursor position on the line", "\\033[1;26H\\033[K", "\\033[?25h"),
    ] {
        let (got, out) = fill_pwfeedback(
            &erasing(SUDO_OPS, erase, tail, "*", ":"),
            "[sudo] password for ops:",
            None,
        );
        assert_eq!(got.as_deref().ok(), Some("esx"), "{name}: {got:?} {out:?}");
        assert!(out.contains(&format!("got:[{SECRET}]")), "{name}: {out:?}");
    }
}

/// Ticket 155 (#284), from the owner's Windows build: ConPTY sends only what changed on its
/// screen, so sudo's `*` and its erasure reach the core as nothing, and it repaints regions it
/// already drew (here while the vault answers: the lookup says go, T164). Each stand-in clears the
/// screen, draws `$ sudo -v` and its prompt, then repaints the same content as ConPTY may
/// (cursor addressing, erases, erased characters, the cursor hidden and shown) and draws
/// nothing for the probe's keys.
fn conpty(prompt: &str, repaint: &str) -> String {
    erasing(prompt, "", "", "", &later(repaint)).replacen("printf '%s'", "printf '\\033[2J\\033[H$ sudo -v\\r\\n%s'", 1)
}

/// A stand-in's `before`: print `what` in the background once the test says go ([`Sig`]).
fn later(what: &str) -> String {
    format!("({GO}; printf '{what}') & :")
}

/// A lookup that lets a stand-in's [`later`] output go and answers once the core has all of it
/// (its last line: the tty may add a `\r` before a line end): output while the vault answers,
/// between the prompt check and the probe, whatever the machine.
fn after_output(sig: &Sig, rx: &Receiver<SessionEvent>, what: &str) -> Result<Secret, String> {
    sig.go();
    let what = printed_by(what);
    shown(rx, what.rsplit('\n').next().unwrap_or_default());
    secret()
}

/// ConPTY's repaints of the unchanged screen, with the cursor parked after the prompt on row 2.
fn same_screen_repaints(prompt: &str) -> Vec<(&'static str, String)> {
    let col = prompt.len() + 1;
    vec![
        (
            "the viewport, line by line",
            format!("\\033[?25l\\033[H$ sudo -v\\033[K\\r\\n{prompt}\\033[K\\r\\n\\033[K\\033[2;{col}H\\033[?25h"),
        ),
        (
            "the prompt's line, spaces as erased characters",
            format!(
                "\\033[?25l\\033[2;1H{}\\033[1X\\033[2;{col}H\\033[?25h",
                prompt.trim_end().replace(' ', "\\033[1X\\033[1C")
            ),
        ),
        ("the cursor alone", format!("\\033[?25l\\033[2;{col}H\\033[?25h")),
        (
            // Ticket 155c (#284 item 5): ConPTY's own forms (microsoft/terminal's VtEngine):
            // blanks erased or written in whatever colour its buffer holds, SGR resets as
            // `ESC[m`, a title, the cursor's blink.
            "ConPTY's forms: coloured blanks, a title, the cursor's blink",
            format!(
                "\\033[?25l\\033]0;sudo\\007\\033[H$ sudo -v\\033[37m\\033[1m\\033[60X\\033[m\\r\\n{prompt}\\033[93m   \\033[39m\\033[2;{col}H\\033[?12h\\033[?25h"
            ),
        ),
    ]
}

/// Windows' rules (decision Q151): a manager that applies them to its Sessions' PTYs here.
fn conpty_rules() -> SessionManager {
    SessionManager::with_conpty_rules(true)
}

#[test]
fn sudo_with_pwfeedback_is_filled_through_a_conpty_repaint_before_the_probe() {
    for (name, repaint) in same_screen_repaints(SUDO_OPS) {
        let m = conpty_rules();
        let sig = Sig::new();
        let (id, rx) = open(&m, sig.on(host_sh(&conpty(SUDO_OPS, &repaint))));
        shown(&rx, "ops: ");
        let got = m.fill(id, WAIT, "[sudo] password for ops:", None, |_| {
            after_output(&sig, &rx, &repaint)
        });
        assert_eq!(got.as_ref().ok().map(String::as_str), Some("esx"), "{name}: {got:?}");
        let out = report(&rx);
        assert!(out.contains(&format!("got:[{SECRET}]")), "{name}: {out:?}");
        m.close(id).unwrap();
    }
}

/// A stand-in that keeps every byte it reads, raw (no line discipline in the way), says each one
/// ([`READ`]), and reports them in hex once it reads [`DONE`], which the test sends when the fill
/// is over (T164: not after its input has been quiet a while, which a loaded machine can bring
/// before the fill types). Nobody presses Enter here, so whatever it read came from the fill (or
/// a key the test sent). It clears the screen and draws `$ sudo -v` and `prompt`, then runs
/// `before`.
fn recording(prompt: &str, before: &str) -> String {
    format!(
        "stty raw -echo min 1 time 0; printf '\\033[2J\\033[H$ sudo -v\\r\\n%s' '{prompt}'; {before}; all=''; \
         while :; do c=$(dd bs=1 count=1 2>/dev/null | od -An -tx1 | tr -d ' \\n'); {READ}; \
         [ -z \"$c\" ] || [ \"$c\" = 04 ] && break; all=\"$all $c\"; done; \
         stty sane; echo; echo \"got:[$all ]\"; sleep 5",
        prompt = prompt.replace('\'', "'\"'\"'")
    )
}

/// The key that ends a [`recording`] (Ctrl+D, which no fill sends).
const DONE: &[u8] = b"\x04";

/// The bytes a [`recording`] stand-in read, once the fill is over.
fn recorded(m: &SessionManager, id: u32, rx: &Receiver<SessionEvent>) -> String {
    m.write(id, DONE).unwrap();
    let out = report(rx);
    out.split("got:[")
        .nth(1)
        .and_then(|r| r.split(']').next())
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// The coordinator's ruling on the review of #299 (#1, decision Q151 (i)): under ConPTY an echo
/// can vanish between two frames however the probe is timed (a network stall can bring the echo
/// and its erasure in one frame), so only sudo's own prompt for the Session's own Host is filled
/// there. Every other prompt is refused before anything is looked up or typed.
#[test]
fn under_conpty_only_sudos_own_prompt_for_the_own_host_is_filled() {
    let nested = at_run(
        1,
        FillTarget {
            host: "esx-02".into(),
            login: LoginAs {
                address: "10.0.0.12".into(),
                port: 22,
                user: "ops".into(),
            },
        },
    );
    for (prompt, line, hop) in [
        ("Password: ", "Password:", None),
        ("ops@esx-02's password: ", "ops@esx-02's password:", Some(&nested)),
        (SUDO_OPS, "[sudo] password for ops:", Some(&nested)),
        ("[sudo] password for root: ", "[sudo] password for root:", None),
    ] {
        let m = conpty_rules();
        let (id, rx) = open(&m, host_sh(&recording(prompt, ":")));
        shown(&rx, prompt);
        let mut asked = false;
        let got = m.fill(id, WAIT, line, hop, |_| {
            asked = true;
            secret()
        });
        let err = got.unwrap_err();
        assert!(matches!(err, FillError::ConPty), "{line}: {err:?}");
        assert!(!asked, "{line}: the vault was asked");
        assert!(err.to_string().contains("Windows"), "{err}");
        assert_eq!(recorded(&m, id, &rx), "", "{line}: something was typed");
        m.close(id).unwrap();
    }
    // Its refusal has no code: pressing again can't fill it.
    let refusal = roster_core::backend::fill_refusal(FillError::ConPty);
    assert!(!format!("{refusal:?}").contains("130"), "{refusal:?}");
}

/// The review of #299 (#3, #4): output between the prompt check and the probe that isn't
/// allowed refuses before anything is typed. On Linux and macOS (no ConPTY) that's any output at
/// all, a repaint of the same screen included; under ConPTY, output that changed the screen.
/// The refusal typed nothing, so it comes back as code 130 and the prompt stays offered.
#[test]
fn output_before_the_probe_refuses_before_anything_is_typed() {
    let col = SUDO_OPS.len() + 1;
    let changes = [
        ("sudo's retry", format!("\\r\\nSorry, try again.\\r\\n{SUDO_OPS}")),
        (
            "another line",
            format!("\\033[?25l\\033[H$ sudo -k\\033[2;{col}H\\033[?25h"),
        ),
        ("a line below", format!("\\033[5;1Hmotd\\033[2;{col}H")),
        ("the cursor elsewhere", "\\033[3;1H".to_string()),
    ];
    let mut cases: Vec<(String, bool, &str, String)> = vec![
        (
            "a repaint, no ConPTY".into(),
            false,
            "[sudo] password for ops:",
            same_screen_repaints(SUDO_OPS).remove(0).1,
        ),
        (
            "a repaint at a plain prompt, no ConPTY".into(),
            false,
            "Password:",
            same_screen_repaints("Password: ").remove(0).1,
        ),
    ];
    for (name, change) in changes {
        cases.push((
            format!("{name}, ConPTY"),
            true,
            "[sudo] password for ops:",
            change.clone(),
        ));
        cases.push((format!("{name}, no ConPTY"), false, "[sudo] password for ops:", change));
    }
    for (name, rules, line, repaint) in cases {
        let prompt = format!("{line} ");
        let m = SessionManager::with_conpty_rules(rules);
        let sig = Sig::new();
        let (id, rx) = open(&m, sig.on(host_sh(&recording(&prompt, &later(&repaint)))));
        shown(&rx, &prompt);
        let err = m
            .fill(id, WAIT, line, None, |_| after_output(&sig, &rx, &repaint))
            .unwrap_err();
        assert!(matches!(err, FillError::Changed { .. }), "{name}: {err:?}");
        let log = err.log_line().unwrap_or_default();
        assert!(
            log.starts_with("prompt fill refused before the probe: what was printed after the prompt check (")
                && log.contains(" bytes) changed the screen: ")
                && !log.contains("Sorry")
                && !log.contains("motd")
                && !log.contains("sudo -k"),
            "{name}: {log}"
        );
        // What differed (ticket 155c), under ConPTY's rule: never the text.
        if rules {
            let what = log.split_once("changed the screen: ").map_or("", |(_, w)| w);
            let expected = match name.split(", ").next().unwrap_or_default() {
                "sudo's retry" => {
                    "the cursor moved from 2:26 to 4:26; row 3 characters (columns 1-17); row 4 characters (columns 1-24)"
                }
                "another line" => "row 1 characters (column 9)",
                "a line below" => "row 5 characters (columns 1-4)",
                _ => "the cursor moved from 2:26 to 3:1",
            };
            assert_eq!(what, expected, "{name}");
        }
        let FillError::Changed { before, diff } = err else {
            unreachable!()
        };
        let refusal = format!(
            "{:?}",
            roster_core::backend::fill_refusal(FillError::Changed { before, diff })
        );
        assert!(refusal.contains("130"), "{name}: {refusal}");
        assert_eq!(recorded(&m, id, &rx), "", "{name}: something was typed");
        m.close(id).unwrap();
    }
}

/// The review of #299 (#2): keys sent to the Session while a fill checks its prompt are held
/// until the fill ends, then sent in order, so an Enter typed during the wait can't land between
/// the probe's letter and its Ctrl+U (where sudo would take `x` as an attempt). The fill refuses.
#[test]
fn keys_sent_during_a_fill_wait_until_it_ends() {
    for (rules, prompt) in [(false, "Password: "), (false, SUDO_OPS), (true, SUDO_OPS)] {
        let m = std::sync::Arc::new(SessionManager::with_conpty_rules(rules));
        let sig = std::sync::Arc::new(Sig::new());
        let (id, rx) = open(&m, sig.on(host_sh(&recording(prompt, ":"))));
        shown(&rx, prompt);
        // The keys go once the probe's first is in, so they're typed while the fill waits.
        let typer = {
            let m = std::sync::Arc::clone(&m);
            let sig = std::sync::Arc::clone(&sig);
            std::thread::spawn(move || {
                sig.read();
                m.write(id, b"a\r").unwrap();
            })
        };
        let err = m.fill(id, WAIT, prompt.trim_end(), None, |_| secret()).unwrap_err();
        typer.join().unwrap();
        assert!(matches!(err, FillError::Typed), "{prompt} {rules}: {err:?}");
        assert_eq!(recorded(&m, id, &rx), "15 78 15 61 0d", "{prompt} {rules}");
        m.close(id).unwrap();
    }
}

/// The review of #299 (#6): a resize at any point of a fill refuses it, even one put back.
#[test]
fn a_resize_during_a_fill_refuses() {
    // While the vault answers: before the probe, so nothing is typed.
    let m = SessionManager::new();
    let (id, rx) = open(&m, host_sh(&recording("Password: ", ":")));
    shown(&rx, "Password: ");
    let err = m
        .fill(id, WAIT, "Password:", None, |_| {
            m.resize(id, Size { cols: 100, rows: 24 }).unwrap();
            m.resize(id, SIZE).unwrap();
            secret()
        })
        .unwrap_err();
    assert!(matches!(err, FillError::Changed { .. }), "{err:?}");
    assert_eq!(recorded(&m, id, &rx), "");
    m.close(id).unwrap();
    // While the probe waits: once its first key is in.
    let m = std::sync::Arc::new(SessionManager::new());
    let sig = std::sync::Arc::new(Sig::new());
    let (id, rx) = open(&m, sig.on(host_sh(&recording("Password: ", ":"))));
    shown(&rx, "Password: ");
    let resizer = {
        let m = std::sync::Arc::clone(&m);
        let sig = std::sync::Arc::clone(&sig);
        std::thread::spawn(move || {
            sig.read();
            m.resize(id, Size { cols: 100, rows: 24 }).unwrap();
            m.resize(id, SIZE).unwrap();
        })
    };
    let err = m.fill(id, WAIT, "Password:", None, |_| secret()).unwrap_err();
    resizer.join().unwrap();
    assert!(matches!(err, FillError::Echoes(_)), "{err:?}");
    // The probe and nothing else: no secret, no Enter.
    assert_eq!(recorded(&m, id, &rx), "15 78 15");
    m.close(id).unwrap();
}

/// T155 item 3, which the key hold needs: a second fill while one checks the prompt is refused
/// at once, and the first goes on.
#[test]
fn a_second_fill_while_one_checks_is_refused() {
    let m = std::sync::Arc::new(SessionManager::new());
    let (id, rx) = open(&m, host_sh(NO_ECHO));
    shown(&rx, "Password: ");
    // The first fill's lookup says it's waiting on the vault, and answers when the test lets it.
    let (asking, asked) = channel();
    let (answer, answered) = channel::<()>();
    let first = {
        let m = std::sync::Arc::clone(&m);
        std::thread::spawn(move || {
            m.fill(id, WAIT, "Password:", None, |_| {
                asking.send(()).unwrap();
                answered.recv().unwrap();
                secret()
            })
        })
    };
    asked.recv_timeout(CEILING).expect("the first fill's lookup");
    let second = m.fill(id, WAIT, "Password:", None, |_| secret());
    answer.send(()).unwrap();
    assert!(matches!(second, Err(FillError::Busy)), "{second:?}");
    assert_eq!(first.join().unwrap().ok().as_deref(), Some("esx"));
    let out = report(&rx);
    assert!(out.contains(&format!("got:[{SECRET}]")), "{out:?}");
    m.close(id).unwrap();
}

/// Ticket 155 (#284): under ConPTY, the probe's own output is still checked as before after a
/// repaint that left the screen as it was: an echo (taken back or not) or a redraw during the
/// probe refuses, and the log says which step it was.
#[test]
fn after_a_conpty_repaint_the_probe_must_still_draw_nothing() {
    let repaint = same_screen_repaints(SUDO_OPS).remove(0).1;
    const PENDING: &str = "with the probe's letter pending, the screen showed more than sudo's prompt and at most its `*`; the probe drew ";
    const PROBED: &str = "the probe drew ";
    // Each: name, what it draws per key, how it takes one back, the rule the log names.
    for (name, mask, erase, rule) in [
        ("an echo", "x", "\\b \\b", PENDING),
        ("a colour", "\\033[1m*\\033[0m", "\\b \\b", PENDING),
        ("a colour in the erase", "*", "\\b \\b\\033[1m", PROBED),
    ] {
        let script = erasing(SUDO_OPS, erase, "", mask, &later(&repaint)).replacen(
            "printf '%s'",
            "printf '\\033[2J\\033[H$ sudo -v\\r\\n%s'",
            1,
        );
        let m = conpty_rules();
        let sig = Sig::new();
        let (id, rx) = open(&m, sig.on(host_sh(&script)));
        shown(&rx, "ops: ");
        let err = m
            .fill(id, WAIT, "[sudo] password for ops:", None, |_| {
                after_output(&sig, &rx, &repaint)
            })
            .unwrap_err();
        let log = err.log_line().unwrap_or_default();
        assert!(
            log.starts_with(&format!("prompt fill refused at sudo's prompt: {rule}"))
                && (rule == PENDING || log.contains("not sudo's pwfeedback mask as roster takes it; "))
                && log.ends_with(" bytes printed before the probe repainted the screen as it was"),
            "{name}: {log}"
        );
        m.write(id, b"\r").unwrap();
        let out = report(&rx);
        assert!(!out.contains(SECRET), "{name}: {out:?}");
        m.close(id).unwrap();
    }
    // The owner's second press: sudo took an Enter and redrew its retry during the probe.
    let script = erasing(SUDO_OPS, "", "", "", ":").replacen(
        "else pw=\"$pw$c\"",
        "else printf '\\r\\nSorry, try again.\\r\\n[sudo] password for ops: '; pw=\"$pw$c\"",
        1,
    );
    let (got, out) = fill_pwfeedback(&script, "[sudo] password for ops:", None);
    assert!(matches!(got, Err(FillError::Echoes(Some(_)))), "{got:?} {out:?}");
    assert!(!out.contains(SECRET), "{out:?}");
}

/// A stand-in for what Windows' ConPTY sends (ticket 155, #284, Q151 (h)): the tty in raw mode
/// (no echo of its own), and the prompt's line drawn only once per 50 ms frame, and only if it
/// changed since the last frame drawn: a key echoed and taken back within one frame sends
/// nothing. `mode` is what the line shows for what was typed: `echo` (the keys), `mask` (sudo's
/// `*` per key) or `silent` (nothing). Enter ends it and it reports what it read.
const FRAMES: &str = r#"
import os, select, sys, termios, time, tty
prompt, mode = sys.argv[1], sys.argv[2]
saved = termios.tcgetattr(0)
tty.setraw(0)
os.write(1, b"\x1b[2J\x1b[H" + prompt.encode())
line = b""
shown = b""
frame = 0.05
last = time.monotonic()
while True:
    r, _, _ = select.select([0], [], [], frame)
    if r:
        c = os.read(0, 1)
        if c in (b"\r", b"\n", b""):
            break
        line = b"" if c == b"\x15" else line + c
    now = time.monotonic()
    if now - last >= frame:
        last = now
        drawn = {"echo": line, "mask": b"*" * len(line), "silent": b""}[mode]
        if drawn != shown:
            os.write(1, b"\x1b[%dG" % (len(prompt) + 1) + drawn + b"\x1b[K")
            shown = drawn
termios.tcsetattr(0, termios.TCSADRAIN, saved)
os.write(1, b"\r\ngot:[" + line + b"]\r\n")
time.sleep(5)
"#;

fn frames(prompt: &str, mode: &str) -> SessionCommand {
    let mut cmd = host_sh("");
    cmd.argv = vec!["python3".into(), "-c".into(), FRAMES.into(), prompt.into(), mode.into()];
    cmd
}

/// Ticket 155 (#284, the coordinator's review of #299): under a terminal that sends only frame
/// diffs, an echoing prompt's echo of the probe's letter mustn't vanish within one frame. The
/// probe's letter stays on the line through a whole wait before it's taken back, so a frame
/// draws it: refused, the secret never typed. pwfeedback's `*` and a silent prompt still fill.
#[test]
fn an_echo_cant_hide_inside_one_frame_of_a_diff_only_terminal() {
    // Each: the prompt, the fill's line, what it shows, ConPTY's rules, whether it fills.
    for (prompt, line, mode, rules, fills) in [
        (SUDO_OPS, "[sudo] password for ops:", "echo", true, false),
        (SUDO_OPS, "[sudo] password for ops:", "silent", true, true),
        (SUDO_OPS, "[sudo] password for ops:", "mask", true, true),
        ("Password: ", "Password:", "echo", false, false),
        (SUDO_OPS, "[sudo] password for ops:", "echo", false, false),
        ("Password: ", "Password:", "silent", false, true),
    ] {
        let m = SessionManager::with_conpty_rules(rules);
        let (id, rx) = open(&m, frames(prompt, mode));
        shown(&rx, prompt);
        let got = m.fill(id, WAIT, line, None, |_| secret());
        if fills {
            assert_eq!(got.as_deref().ok(), Some("esx"), "{line} {mode} {rules}: {got:?}");
        } else {
            assert!(
                matches!(got, Err(FillError::Echoes(_))),
                "{line} {mode} {rules}: {got:?}"
            );
            m.write(id, b"\r").unwrap();
        }
        let out = report(&rx);
        m.close(id).unwrap();
        let want = if fills {
            format!("got:[{SECRET}]")
        } else {
            "got:[]".to_string()
        };
        assert!(out.contains(&want), "{line} {mode} {rules}: {out:?}");
        if !fills {
            assert!(!out.contains(SECRET), "{line} {mode} {rules}: {out:?}");
        }
    }
}

/// The probe goes in two writes, each followed by a wait: Ctrl+U and the letter, then the last
/// Ctrl+U (Q151 (h)). A refusal still types nothing else, and the line ends empty. That the two
/// are a whole wait apart is timed where they're written (session.rs's
/// `the_probes_two_writes_are_a_whole_wait_apart`): timed here, where the stand-in reads them, a
/// loaded machine that ran it late saw them closer together than they were written (T161).
#[test]
fn the_probe_goes_in_two_steps_with_a_wait_between() {
    let script = "stty raw -echo min 1 time 0; printf 'Password: '; \
                  a=$(dd bs=1 count=2 2>/dev/null | od -An -tx1 | tr -d ' \\n'); \
                  b=$(dd bs=1 count=1 2>/dev/null | od -An -tx1 | tr -d ' \\n'); \
                  stty sane; echo; echo \"got:[$a $b]\"; sleep 5";
    let m = SessionManager::new();
    let (id, rx) = open(&m, host_sh(script));
    shown(&rx, "Password: ");
    let _ = m.fill(id, WAIT, "Password:", None, |_| secret());
    let out = report(&rx);
    m.close(id).unwrap();
    let got = out
        .split("got:[")
        .nth(1)
        .and_then(|r| r.split(']').next())
        .unwrap_or_default();
    assert_eq!(got.split(' ').collect::<Vec<_>>(), ["1578", "15"], "{out:?}");
}

/// Ticket 154 (the review of #283, #3): a cursor hide or show inside another sequence isn't one.
/// Taken out byte by byte, `ESC [ ESC[?25l K` would read as sudo's `ESC [ K`; a terminal reads a
/// broken sequence, then a hide, then a `K` drawn on the line.
#[test]
fn a_cursor_toggle_inside_another_sequence_refuses() {
    let forged = "\\033[\\033[?25lK";
    let (got, out) = fill_pwfeedback(
        &pwfeedback(SUDO_OPS, forged, "*", ":"),
        "[sudo] password for ops:",
        None,
    );
    assert!(matches!(got, Err(FillError::Echoes(_))), "{got:?} {out:?}");
    assert!(!out.contains(SECRET), "{out:?}");
}

/// Ticket 154 (the review of #283, #2): the mask counts only when sudo's prompt is the whole of
/// the cursor's line, not the end of a longer one that only ends like it.
#[test]
fn a_mask_at_a_line_that_only_ends_with_sudos_prompt_refuses() {
    let (got, out) = fill_pwfeedback(
        &pwfeedback("Enter vault PIN for [sudo] password for ops: ", "", "*", ":"),
        "[sudo] password for ops:",
        None,
    );
    assert!(matches!(got, Err(FillError::Echoes(_))), "{got:?} {out:?}");
    assert!(!out.contains(SECRET), "{out:?}");
}

/// Ticket 154: everything but sudo's own mask and erasure, at sudo's own prompt for the login
/// user, still refuses, and the secret is never typed.
#[test]
fn a_mask_anywhere_else_or_with_anything_more_still_refuses() {
    let nested = at_run(
        1,
        FillTarget {
            host: "esx-02".into(),
            login: LoginAs {
                address: "10.0.0.12".into(),
                port: 22,
                user: "ops".into(),
            },
        },
    );
    // Each: name, the stand-in, the prompt the fill names, its hop.
    let cases: Vec<(&str, String, &str, Option<&Hop>)> = vec![
        (
            "a prompt that names no one",
            pwfeedback("Password: ", "", "*", ":"),
            "Password:",
            None,
        ),
        (
            "sudo's prompt for another user",
            pwfeedback("[sudo] password for root: ", "", "*", ":"),
            "[sudo] password for root:",
            None,
        ),
        (
            "a nested ssh's login prompt",
            pwfeedback("ops@esx-02's password: ", "", "*", ":"),
            "ops@esx-02's password:",
            Some(&nested),
        ),
        (
            "sudo's prompt with text after it",
            pwfeedback("[sudo] password for ops: x", "", "*", ":"),
            "[sudo] password for ops: x",
            None,
        ),
        (
            "another mask character",
            pwfeedback(SUDO_OPS, "", "#", ":"),
            "[sudo] password for ops:",
            None,
        ),
        (
            "the probe's own letter",
            pwfeedback(SUDO_OPS, "", "x", ":"),
            "[sudo] password for ops:",
            None,
        ),
        (
            "two masks per key",
            pwfeedback(SUDO_OPS, "", "**", ":"),
            "[sudo] password for ops:",
            None,
        ),
        (
            "a mask that's never erased",
            pwfeedback(SUDO_OPS, "", "*\\033[1C", ":"),
            "[sudo] password for ops:",
            None,
        ),
        (
            "more after the erasure",
            pwfeedback(SUDO_OPS, "!\\b", "*", ":"),
            "[sudo] password for ops:",
            None,
        ),
        (
            "another escape after the erasure",
            pwfeedback(SUDO_OPS, "\\033[1m", "*", ":"),
            "[sudo] password for ops:",
            None,
        ),
        (
            "the erasure after the window",
            pwfeedback(SUDO_OPS, "", "*", ":").replacen(
                "while [ $n -gt 0 ]; do printf '\\b \\b'",
                &format!("[ $n -gt 0 ] && {{ {GO}; }}; while [ $n -gt 0 ]; do printf '\\b \\b'"),
                1,
            ),
            "[sudo] password for ops:",
            None,
        ),
    ];
    for (name, script, prompt, hop) in cases {
        let (got, out) = fill_pwfeedback(&script, prompt, hop);
        assert!(matches!(got, Err(FillError::Echoes(_))), "{name}: {got:?} {out:?}");
        assert!(!out.contains(SECRET), "{name}: {out:?}");
    }
}

#[test]
fn output_while_the_vault_answers_then_the_mask_refuses() {
    let m = SessionManager::new();
    // A dot while the lookup below waits on the vault.
    let sig = Sig::new();
    let script = pwfeedback(SUDO_OPS, "", "*", &later("."));
    let (id, rx) = open(&m, sig.on(host_sh(&script)));
    shown(&rx, "ops: ");
    let err = m
        .fill(id, WAIT, "[sudo] password for ops:", None, |_| {
            after_output(&sig, &rx, ".")
        })
        .unwrap_err();
    assert!(matches!(err, FillError::Changed { .. }), "{err:?}");
    m.write(id, b"\r").unwrap();
    let out = report(&rx);
    assert!(out.contains("got:[]") && !out.contains(SECRET), "{out:?}");
    m.close(id).unwrap();
}

#[test]
fn a_key_typed_while_sudo_masks_the_probe_refuses() {
    let m = std::sync::Arc::new(SessionManager::new());
    let sig = std::sync::Arc::new(Sig::new());
    let (id, rx) = open(&m, sig.on(host_sh(&pwfeedback(SUDO_OPS, "", "*", ":"))));
    shown(&rx, "ops: ");
    // The key goes once the probe's first is in, so it's typed while sudo masks the probe.
    let typer = {
        let m = std::sync::Arc::clone(&m);
        let sig = std::sync::Arc::clone(&sig);
        std::thread::spawn(move || {
            sig.read();
            m.write(id, b"\x15").unwrap();
        })
    };
    let err = m
        .fill(id, WAIT, "[sudo] password for ops:", None, |_| secret())
        .unwrap_err();
    typer.join().unwrap();
    assert!(matches!(err, FillError::Typed), "{err:?}");
    m.write(id, b"\r").unwrap();
    let out = report(&rx);
    assert!(out.contains("got:[]") && !out.contains(SECRET), "{out:?}");
    m.close(id).unwrap();
}

/// Ticket 154 (3): once the mask is erased the cursor must be right after the prompt again, as
/// the core's screen draws it. A prompt that leaves one column puts the `*` in the last column,
/// with the wrap pending: the backspace then lands a column early and sudo's space wipes the
/// prompt's colon, so the cursor isn't after the prompt: refused, though the bytes are sudo's.
#[test]
fn a_mask_that_leaves_the_cursor_off_the_prompt_refuses() {
    // 80 columns: 55 of padding, then sudo's prompt (24 without its space), then the `*`.
    let pad = "~".repeat(55);
    let prompt = format!("{pad}{}", SUDO_OPS.trim_end());
    let (got, out) = fill_pwfeedback(&pwfeedback(&prompt, "", "*", ":"), "[sudo] password for ops:", None);
    assert!(matches!(got, Err(FillError::Echoes(_))), "{got:?} {out:?}");
    assert!(!out.contains(SECRET), "{out:?}");
}

/// Ticket 155 (#284): a refused fill types nothing but its probe, and the probe holds no Enter,
/// so a refusal can never be taken by sudo as a password attempt. The stand-in keeps every byte
/// it reads, raw (no line discipline in the way), and reports them in hex once it reads [`DONE`],
/// sent when the fill is over: nobody presses Enter here, so whatever it read came from the fill.
#[test]
fn a_refused_fill_types_only_its_probe_and_no_enter() {
    assert!(!PROBE.iter().any(|&b| b == b'\r' || b == b'\n'), "{PROBE:?}");
    // Each: name, what the stand-in draws for each key it reads, the prompt.
    for (name, mask, prompt) in [
        // A form the mask check doesn't take (yet): a colour around the `*`.
        ("a coloured pwfeedback mask", "\\033[1m*\\033[0m", SUDO_OPS),
        ("an echoing prompt", "x", SUDO_OPS),
        ("another prompt's mask", "*", "Password: "),
    ] {
        let script = format!(
            "stty raw -echo min 1 time 0; printf '%s' '{prompt}'; all=''; \
             while :; do c=$(dd bs=1 count=1 2>/dev/null | od -An -tx1 | tr -d ' \\n'); \
             [ -z \"$c\" ] || [ \"$c\" = 04 ] && break; all=\"$all $c\"; \
             if [ \"$c\" = 15 ]; then printf '\\b \\b'; else printf '{mask}'; fi; done; \
             stty sane; echo; echo \"got:[$all ]\"; sleep 5"
        );
        let m = SessionManager::new();
        let (id, rx) = open(&m, host_sh(&script));
        shown(&rx, prompt);
        let got = m.fill(id, WAIT, prompt.trim_end(), None, |_| secret());
        assert!(matches!(got, Err(FillError::Echoes(_))), "{name}: {got:?}");
        m.write(id, DONE).unwrap();
        let out = report(&rx);
        m.close(id).unwrap();
        assert!(out.contains("got:[ 15 78 15 ]"), "{name}: {out:?}");
    }
}

/// Ticket 155 (#284): a fill at sudo's own prompt for the Session's own Host that the mask watch
/// refuses says, for the app's log only, what the probe drew there, so the form Windows' ConPTY
/// draws can be added; the refusal's own text (the message line's) doesn't hold it, and nothing
/// else (a nested Host, another prompt, a refusal with no output) has a log line.
#[test]
fn a_refused_mask_says_what_was_drawn_for_the_log_only() {
    let (got, out) = fill_pwfeedback(
        &pwfeedback(SUDO_OPS, "", "\\033[1m*\\033[0m", ":"),
        "[sudo] password for ops:",
        None,
    );
    assert!(!out.contains(SECRET), "{out:?}");
    let err = got.unwrap_err();
    assert_eq!(
        err.log_line().as_deref(),
        Some(
            "prompt fill refused at sudo's prompt: with the probe's letter pending, the screen showed more than sudo's prompt and at most its `*`; the probe drew CSI[1m '*' CSI[0m; the cursor moved from 1:26 to 1:27; the line changed"
        ),
        "{err:?}"
    );
    let said = err.to_string();
    assert!(!said.contains("CSI") && !said.contains("drew"), "{said}");
    let refusal = format!(
        "{:?}",
        roster_core::backend::fill_refusal(match err {
            FillError::Echoes(d) => FillError::Echoes(d),
            other => panic!("{other:?}"),
        })
    );
    assert!(!refusal.contains("CSI"), "{refusal}");

    // Text the prompt printed shows only as how many characters.
    let (got, _) = fill_pwfeedback(
        &pwfeedback(SUDO_OPS, "", "\\033[1mhunter\\033[0m", ":"),
        "[sudo] password for ops:",
        None,
    );
    let line = got.unwrap_err().log_line().unwrap_or_default();
    assert!(
        line.contains("CSI[1m text(6) CSI[0m") && !line.contains("hunter"),
        "{line}"
    );

    let nested = at_run(
        1,
        FillTarget {
            host: "esx-02".into(),
            login: LoginAs {
                address: "10.0.0.12".into(),
                port: 22,
                user: "ops".into(),
            },
        },
    );
    for (script, prompt, hop) in [
        (
            pwfeedback(SUDO_OPS, "", "*", ":"),
            "[sudo] password for ops:",
            Some(&nested),
        ),
        (pwfeedback("Password: ", "", "*", ":"), "Password:", None),
    ] {
        let (got, out) = fill_pwfeedback(&script, prompt, hop);
        let err = got.unwrap_err();
        assert!(matches!(err, FillError::Echoes(None)), "{err:?} {out:?}");
        assert_eq!(err.log_line(), None);
    }
}

/// The last pass on #318: once the Session printed something the core's screen can't follow (a
/// wide character, synchronized output), it doesn't say a prompt is at the cursor, on any
/// platform, so the fill refuses before anything is looked up or typed, and the log says why.
#[test]
fn a_screen_that_lost_track_refuses_before_anything_is_looked_up() {
    for (earlier, what) in [("\u{4e2d} ", "wide character"), ("\x1b[?2026h", "CSI[?2026h")] {
        for rules in [false, true] {
            let prompt = format!("{earlier}\r\n[sudo] password for ops: ");
            let m = SessionManager::with_conpty_rules(rules);
            let (id, rx) = open(&m, host_sh(&recording(&prompt, ":")));
            shown(&rx, "ops: ");
            let mut asked = false;
            let err = m
                .fill(id, WAIT, "[sudo] password for ops:", None, |_| {
                    asked = true;
                    secret()
                })
                .unwrap_err();
            assert!(matches!(err, FillError::LostTrack { .. }), "{what} {rules}: {err:?}");
            assert!(!asked, "{what} {rules}: the vault was asked");
            let log = err.log_line().unwrap_or_default();
            assert!(
                log.contains(&format!("roster's screen lost track of the terminal at {what}")),
                "{log}"
            );
            let FillError::LostTrack { diff } = err else {
                unreachable!()
            };
            let refusal = format!(
                "{:?}",
                roster_core::backend::fill_refusal(FillError::LostTrack { diff })
            );
            assert!(refusal.contains("130"), "{refusal}");
            assert_eq!(recorded(&m, id, &rx), "", "{what} {rules}: something was typed");
            m.close(id).unwrap();
        }
    }
}
