//! `roster sync` imports Hosts from the vault's login items named `HOST ssh`
//! or `HOST ssh+X`, against a fake bw and a fake keyctl. Only names,
//! folders, URIs and user names are read: never a password.
mod common;
use common::Sandbox;

const SESSION: &str = "session-made-up-77e2";
/// Every item's password: it must appear nowhere.
const CANARY: &str = "canary-pw-made-up-5d1f";

const INVENTORY: &str = "\
# made up
defaults: {user: admin}
groups:
  dev:
    hosts:
      box-b: 10.0.0.6
      old-web: {ip: 10.0.0.7, auth: \"bw:web-01 ssh#password\"}
# the end
";

/// Login items, one JSON object per line, each with the canary password.
fn items() -> String {
    let login = |id: &str, name: &str, folder: &str, user: &str, uris: &str| {
        format!(
            r#"{{"object":"item","type":1,"id":"{id}","name":"{name}","folderId":{folder},"login":{{"username":{user},"password":"{CANARY}","uris":[{uris}]}}}}"#
        )
    };
    [
        login(
            "id-a",
            "box-c ssh",
            r#""f-lab""#,
            r#""ops""#,
            r#"{"uri":"ssh://ops@10.0.0.9:2222"}"#,
        ),
        login(
            "id-b",
            "esx-03 SSH+root",
            "null",
            r#""root""#,
            r#"{"uri":"https://10.0.0.10/ui"},{"uri":"10.0.0.99"}"#,
        ),
        login(
            "id-c1",
            "sw-02 ssh",
            "null",
            "null",
            r#"{"uri":"10.0.0.11:2200"}"#,
        ),
        login(
            "id-c2",
            "sw-02 ssh",
            "null",
            "null",
            r#"{"uri":"10.0.0.12"}"#,
        ),
        login("id-d", "box-x ssh", "null", r#""ops""#, ""),
        login(
            "id-e",
            "box-b ssh",
            "null",
            r#""ops""#,
            r#"{"uri":"10.0.0.6"}"#,
        ),
        login(
            "id-f",
            "web-01 ssh",
            "null",
            r#""ops""#,
            r#"{"uri":"10.0.0.13"}"#,
        ),
        login(
            "id-g",
            "wiki admin",
            "null",
            r#""ops""#,
            r#"{"uri":"10.0.0.14"}"#,
        ),
        r#"{"object":"item","type":2,"id":"id-h","name":"note-1 ssh","folderId":null}"#.into(),
        // Nulls where bw may give them: skipped, not a parse failure.
        r#"{"object":"item","type":1,"id":"id-i","name":"box-y ssh","folderId":null,"login":{"username":null,"password":null,"uris":null}}"#.into(),
    ]
    .join("\n")
}

const FOLDERS: &str = r#"[{"object":"folder","id":"f-lab","name":"Lab Servers"},{"object":"folder","id":null,"name":"No Folder"}]"#;

fn read(s: &Sandbox, rel: &str) -> String {
    std::fs::read_to_string(s.home.join(rel)).unwrap_or_default()
}

/// The fake vault, unlocked: the session key is in the fake keyring.
fn unlocked(name: &str) -> Sandbox {
    let mut s = Sandbox::new(name);
    s.write("roster.yml", INVENTORY);
    s.write(".fake-keyring/roster:bw-session", SESSION);
    s.set_env("FAKE_BW_ITEMS", &items());
    s.set_env("FAKE_BW_FOLDERS", FOLDERS);
    s
}

#[test]
fn sync_imports_convention_items_into_roster_yml_then_writes_the_box_files() {
    let s = unlocked("import-sync");
    let out = s.roster(&["sync"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let want = INVENTORY.replace(
        "# the end\n",
        "  lab-servers:\n    hosts:\n      \
         box-c: {ip: \"10.0.0.9\", port: 2222, user: \"ops\", auth: \"bw:box-c ssh\", reviewed: true}\n  \
         vault:\n    hosts:\n      \
         esx-03: {ip: \"10.0.0.10\", port: 22, user: \"root\", auth: \"bw:esx-03 SSH+root\", reviewed: true}\n      \
         sw-02: {ip: \"10.0.0.11\", port: 2200, auth: \"bw:id-c1\", reviewed: true}\n\
         # the end\n",
    );
    assert_eq!(read(&s, "roster.yml"), want);
    for (host, group) in [
        ("box-c", "lab-servers"),
        ("esx-03", "vault"),
        ("sw-02", "vault"),
    ] {
        let line = format!("imported {host} from the vault (group {group})\n");
        assert!(out.stdout.contains(&line), "{}", out.stdout);
    }
    assert_eq!(
        out.stderr,
        "roster: skipped vault item 'box-x ssh': its first URI has no address\n\
         roster: skipped vault item 'box-y ssh': its first URI has no address\n"
    );
    assert_eq!(
        read(&s, "bw.log"),
        "sync --nointeraction\nlist items --nointeraction\nlist folders --nointeraction\n"
    );
    // The rest of sync ran on the new Inventory.
    assert!(read(&s, ".ssh/config.d/roster").contains("Host esx-03\n"));
    assert!(read(&s, "ROSTER.md").contains("box-c"));
    // A second run imports nothing.
    let out = s.roster(&["sync"]);
    assert_eq!((out.code, out.stdout.as_str()), (0, ""), "{}", out.stderr);
    assert_eq!(read(&s, "roster.yml"), want);
}

#[test]
fn a_locked_vault_skips_the_import_with_one_line_and_sync_runs_on() {
    let s = unlocked("import-locked");
    std::fs::remove_file(s.home.join(".fake-keyring/roster:bw-session")).unwrap();
    let out = s.roster(&["sync"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        out.stderr,
        "roster: vault import skipped: Bitwarden is locked (`roster vault unlock`)\n"
    );
    assert_eq!(read(&s, "roster.yml"), INVENTORY);
    assert!(!s.home.join("bw.log").exists(), "sync ran bw while locked");
    assert!(read(&s, ".ssh/config.d/roster").contains("Host box-b\n"));
}

#[test]
fn no_keyctl_or_bw_skips_the_import_and_never_prompts() {
    let mut s = unlocked("import-no-keyctl");
    s.set_env("PATH", "/nonexistent");
    let out = s.roster(&["sync"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stderr.lines().count(), 1, "{}", out.stderr);
    assert!(
        out.stderr.contains("vault import skipped"),
        "{}",
        out.stderr
    );
}

#[test]
fn add_from_vault_imports_one_item_even_off_convention() {
    let s = unlocked("import-one");
    let out = s.roster(&["add", "--from-vault", "wiki admin", "--group", "apps"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(read(&s, "roster.yml").contains(
        "  apps:\n    hosts:\n      wiki-admin: {ip: \"10.0.0.14\", port: 22, user: \"ops\", \
         auth: \"bw:wiki admin\", reviewed: true}\n"
    ));
    assert!(read(&s, ".ssh/config.d/roster").contains("Host wiki-admin\n"));
    // By id, with a name; a name two items share is refused.
    let out = s.roster(&["add", "--from-vault", "id-c2", "--name", "sw-03"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(
        read(&s, "roster.yml")
            .contains("sw-03: {ip: \"10.0.0.12\", port: 22, auth: \"bw:id-c2\", reviewed: true}")
    );
    let out = s.roster(&["add", "--from-vault", "sw-02 ssh"]);
    assert_eq!(out.code, 1);
    assert!(out.stderr.contains("give the id"), "{}", out.stderr);
}

/// Every file under `dir`, recursively.
fn files(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut all = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        match path.is_dir() {
            true => all.extend(files(&path)),
            false => all.push(path),
        }
    }
    all
}

#[test]
fn no_item_password_reaches_output_files_or_argv() {
    let s = unlocked("import-secrets");
    let sync = s.roster(&["sync"]);
    assert_eq!(sync.code, 0, "{}", sync.stderr);
    let add = s.roster(&["add", "--from-vault", "id-g", "--name", "wiki"]);
    assert_eq!(add.code, 0, "{}", add.stderr);
    for out in [&sync, &add] {
        assert!(!out.stdout.contains(CANARY) && !out.stderr.contains(CANARY));
    }
    for file in files(&s.home) {
        let text = String::from_utf8_lossy(&std::fs::read(&file).unwrap()).into_owned();
        assert!(
            !text.contains(CANARY),
            "{} holds a password",
            file.display()
        );
    }
    // Only list calls: an item is never fetched whole.
    let log = read(&s, "bw.log");
    assert!(
        log.lines()
            .all(|l| l.starts_with("sync ") || l.starts_with("list ")),
        "{log}"
    );
}

#[test]
fn imported_and_added_hosts_are_reviewed_even_when_defaults_are_not() {
    // Putting a login in the vault, or `roster add`, is the review: such a
    // Host is set up like any other, even under `defaults: reviewed: false`
    // (which keeps Hosts found other ways hands-off).
    let s = unlocked("import-reviewed");
    s.write(
        "roster.yml",
        &INVENTORY.replace(
            "defaults: {user: admin}",
            "defaults: {user: admin, reviewed: false}",
        ),
    );
    assert_eq!(s.roster(&["sync"]).code, 0);
    let added = s.roster(&["add", "box-d", "--ip", "10.0.0.12"]);
    assert_eq!(added.code, 0, "{}", added.stderr);
    let ls = s.roster(&["ls"]).stdout;
    for host in ["box-c", "esx-03", "box-d"] {
        let line = ls.lines().find(|l| l.starts_with(host)).unwrap_or_default();
        assert!(!line.contains("unreviewed"), "{host}: {line}");
    }
    // A Host that was already there keeps the default.
    let b = ls
        .lines()
        .find(|l| l.starts_with("box-b"))
        .unwrap_or_default();
    assert!(b.contains("unreviewed"), "{b}");
}

#[test]
fn an_item_for_a_login_already_in_the_inventory_is_skipped() {
    let login = |id: &str, name: &str, user: &str, uri: &str| {
        format!(
            r#"{{"object":"item","type":1,"id":"{id}","name":"{name}","folderId":null,"login":{{"username":"{user}","password":"{CANARY}","uris":[{{"uri":"{uri}"}}]}}}}"#
        )
    };
    let mut s = unlocked("import-duplicates");
    s.set_env(
        "FAKE_BW_ITEMS",
        &[
            // box-b is already 10.0.0.6:22 as admin.
            login("d1", "box-b-new ssh", "admin", "10.0.0.6"),
            // Two items for one new login: the first one wins.
            login("d2", "box-e ssh", "ops", "10.0.0.20"),
            login("d3", "box-e2 ssh", "ops", "10.0.0.20"),
            // The same address as another user: another login, imported.
            login("d4", "box-b-root ssh", "root", "10.0.0.6"),
        ]
        .join("\n"),
    );
    let out = s.roster(&["sync"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let yml = read(&s, "roster.yml");
    assert!(yml.contains("box-e: "), "{yml}");
    assert!(yml.contains("box-b-root: "), "{yml}");
    assert!(!yml.contains("box-b-new"), "{yml}");
    assert!(!yml.contains("box-e2"), "{yml}");
    assert!(
        out.stderr.contains(
            "skipped vault item 'box-b-new ssh': can't add box-b-new: \
             box-b is already 10.0.0.6:22 as admin"
        ),
        "{}",
        out.stderr
    );
    assert!(
        out.stderr
            .contains("skipped vault item 'box-e2 ssh': can't add box-e2: box-e is already"),
        "{}",
        out.stderr
    );
}
