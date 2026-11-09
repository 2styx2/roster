//! `roster` alone: pick Hosts with fzf, open them in tmux or in place.
mod common;
use common::Sandbox;

const INVENTORY: &str = r#"
defaults: {user: admin}
groups:
  dev:
    hosts:
      box-a: {ip: 10.0.0.5, title: Build box, description: Runs the nightly builds}
      box-b: 10.0.0.6
      sw-01: {ip: 10.0.0.9, enroll: false}
"#;

fn read(s: &Sandbox, file: &str) -> String {
    std::fs::read_to_string(s.home.join(file)).unwrap_or_default()
}

fn sandbox(name: &str, pick: &str) -> Sandbox {
    let mut s = Sandbox::new(name);
    s.write("roster.yml", INVENTORY);
    s.set_env("FAKE_FZF_PICK", pick);
    s
}

#[test]
fn outside_tmux_the_pick_runs_ssh_in_place() {
    let s = sandbox("pick-outside", "box-b");
    let out = s.roster(&["pick"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(read(&s, "ssh.log"), "box-b\n");
    assert_eq!(read(&s, "tmux.log"), "");
}

fn in_tmux(name: &str, pick: &str, key: &str) -> Sandbox {
    let mut s = sandbox(name, pick);
    s.set_env("TMUX", "/tmp/tmux-1000/default,1,0");
    s.set_env("FAKE_FZF_KEY", key);
    s
}

/// `roster -c HOME/roster.yml ssh HOST`, as tmux is asked to run it.
fn roster_ssh(s: &Sandbox, host: &str) -> String {
    let config = s.home.join("roster.yml");
    let exe = env!("CARGO_BIN_EXE_roster");
    format!("{exe} -c {} ssh {host}", config.display())
}

#[test]
fn in_tmux_enter_opens_a_new_window() {
    let s = in_tmux("pick-window", "box-b", "");
    let out = s.roster(&["pick"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let want = format!("new-window -n box-b {}\n", roster_ssh(&s, "box-b"));
    assert_eq!(read(&s, "tmux.log"), want);
    assert_eq!(read(&s, "ssh.log"), "");
}

#[test]
fn in_tmux_ctrl_v_opens_a_split() {
    let s = in_tmux("pick-split", "box-a", "ctrl-v");
    let out = s.roster(&["pick"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let want = format!("split-window {}\n", roster_ssh(&s, "box-a"));
    assert_eq!(read(&s, "tmux.log"), want);
}

#[test]
fn in_tmux_marked_hosts_open_as_synchronized_panes_in_one_window() {
    let s = in_tmux("pick-multi", "box-a box-b sw-01", "");
    let out = s.roster(&["pick"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let want = format!(
        "new-window -P -F #{{window_id}} {}\n\
         split-window -t @7 {}\n\
         select-layout -t @7 tiled\n\
         split-window -t @7 {}\n\
         select-layout -t @7 tiled\n\
         set-window-option -t @7 synchronize-panes on\n",
        roster_ssh(&s, "box-a"),
        roster_ssh(&s, "box-b"),
        roster_ssh(&s, "sw-01"),
    );
    assert_eq!(read(&s, "tmux.log"), want);
}

#[test]
fn outside_tmux_marking_several_hosts_is_refused() {
    let s = sandbox("pick-multi-outside", "box-a box-b");
    let out = s.roster(&["pick"]);
    assert_eq!(out.code, 1, "{}", out.stderr);
    assert!(out.stderr.contains("inside tmux"), "{}", out.stderr);
    assert_eq!(read(&s, "ssh.log"), "");
}

#[test]
fn fzf_gets_the_ls_lines_and_the_keys() {
    let s = sandbox("pick-fzf-args", "box-a");
    s.roster(&["pick"]);
    let args = read(&s, "fzf.log");
    assert!(args.contains("--multi\n"), "{args}");
    assert!(args.contains("--expect=ctrl-v\n"), "{args}");
}

#[test]
fn the_preview_shows_the_host_in_full() {
    let s = sandbox("pick-preview", "box-a");
    s.roster(&["pick"]);
    assert_eq!(
        read(&s, "preview.out"),
        "name: box-a\ngroup: dev\naddress: 10.0.0.5\naccess: key\n\
         title: Build box\ndescription: Runs the nightly builds\n"
    );
}

#[test]
fn without_fzf_roster_says_how_to_install_it() {
    let mut s = sandbox("pick-no-fzf", "box-b");
    let empty = s.home.join("empty-path").display().to_string();
    s.set_env("PATH", &empty);
    let out = s.roster(&["pick"]);
    assert_eq!(out.code, 1, "{}", out.stderr);
    assert!(out.stderr.contains("install fzf"), "{}", out.stderr);
    assert_eq!(read(&s, "ssh.log"), "");
}

#[test]
fn a_cancelled_pick_runs_nothing() {
    let mut s = sandbox("pick-cancel", "");
    s.set_env("FAKE_FZF_EXIT", "130");
    let out = s.roster(&["pick"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stderr, "");
    assert_eq!(read(&s, "ssh.log"), "");
}
