//! The Lua Config (GLOSSARY: Config, ADR 0004): `init.lua` in the user config dir, run in a
//! sandboxed Lua 5.4, checked against a schema, layered over the defaults. These tests drive the
//! public loader the Tauri shell uses, with real files in a temp dir.

mod common;

use roster_core::config::{self, Config, Loader};

/// A fresh, empty config dir for one test.
fn temp_dir(name: &str) -> common::Temp {
    common::temp(&format!("config-{name}"))
}

fn with_init(name: &str, lua: &str) -> common::Temp {
    let dir = temp_dir(name);
    std::fs::write(dir.join("init.lua"), lua).unwrap();
    dir
}

#[test]
fn no_file_gives_the_defaults() {
    let dir = temp_dir("none");
    let config = config::load(&dir).unwrap();
    assert_eq!(config, Config::default());
    assert_eq!(config.leader, "Ctrl+Space");
    assert!(config.vim);
    assert_eq!(config.terminal.font.0, ["Iosevka Nerd Font", "Iosevka Term", "Iosevka"]);
    assert_eq!(config.terminal.weight, 500);
    assert_eq!(config.terminal.bold_weight, 700);
    assert_eq!(config.theme, "auto");
    // Decision Q61: a size larger than Windows Terminal's 12 pt and Q57's 14 px.
    assert_eq!(config.terminal.size, config::FontSize::Pt(13.0));
    assert_eq!(config.fonts.ui_size, 15);
}

#[test]
fn a_partial_table_merges_over_the_defaults() {
    let dir = with_init("partial", r#"return { vim = false, terminal = { size = 16 } }"#);
    let config = config::load(&dir).unwrap();
    assert!(!config.vim);
    assert_eq!(config.terminal.size, config::FontSize::Px(16.0));
    // Everything else stays the default, including the rest of `terminal`.
    assert_eq!(config.terminal.font.0, ["Iosevka Nerd Font", "Iosevka Term", "Iosevka"]);
    assert_eq!(config.leader, "Ctrl+Space");
    let _ = Loader::new(&dir);
}

fn load_as(dir: &std::path::Path, os: config::Os) -> Result<Config, config::ConfigError> {
    config::load_with(
        dir,
        &config::Env {
            os,
            ..config::Env::default()
        },
    )
}

#[test]
fn lua_logic_can_branch_on_the_os() {
    let dir = with_init(
        "os",
        r#"
        local font = "Iosevka"
        if roster.os == "windows" then font = "Cascadia Mono" end
        return { terminal = { font = font } }
        "#,
    );
    assert_eq!(
        load_as(&dir, config::Os::Windows).unwrap().terminal.font,
        "Cascadia Mono"
    );
    assert_eq!(load_as(&dir, config::Os::Linux).unwrap().terminal.font, "Iosevka");
}

#[test]
fn a_syntax_error_reports_file_and_line() {
    let dir = with_init("syntax", "return {\n  vim = false,\n  leader = ,\n}\n");
    let e = config::load(&dir).unwrap_err();
    assert_eq!(e.file, "init.lua");
    assert_eq!(e.line, Some(3));
    assert!(e.to_string().starts_with("init.lua:3: "), "{e}");
}

#[test]
fn a_runtime_error_reports_file_and_line() {
    let dir = with_init("runtime", "local t = nil\n\nreturn { vim = t.x }\n");
    let e = config::load(&dir).unwrap_err();
    assert_eq!((e.file.as_str(), e.line), ("init.lua", Some(3)), "{e}");
}

#[test]
fn a_schema_error_reports_file_line_and_the_field() {
    let dir = with_init(
        "schema",
        "return {\n  vim = false,\n  terminal = {\n    font = \"Iosevka\",\n    size = \"big\",\n  },\n}\n",
    );
    let e = config::load(&dir).unwrap_err();
    assert_eq!((e.file.as_str(), e.line), ("init.lua", Some(5)), "{e}");
    assert!(e.message.contains("terminal.size"), "{e}");
}

#[test]
fn a_misspelt_name_is_an_error_on_its_line() {
    let dir = with_init("typo", "return {\n  colors = {\n    acent = \"#ff0000\",\n  },\n}\n");
    let e = config::load(&dir).unwrap_err();
    assert_eq!(e.line, Some(3), "{e}");
    assert!(e.message.contains("acent"), "{e}");
}

#[test]
fn an_out_of_range_value_is_an_error_on_its_line() {
    let dir = with_init("range", "return {\n  terminal = { size = 400 },\n}\n");
    let e = config::load(&dir).unwrap_err();
    assert_eq!(e.line, Some(2), "{e}");
    assert!(e.message.contains("terminal.size"), "{e}");
}

#[test]
fn ui_hints_is_unset_by_default_and_takes_a_boolean() {
    // Unset leaves it to `:hints`, whose choice the State keeps (like `theme = "auto"`).
    assert_eq!(Config::default().ui.hints, None);
    let dir = with_init("hints", "return { ui = { hints = false } }\n");
    assert_eq!(config::load(&dir).unwrap().ui.hints, Some(false));
    let dir = with_init("hints-bad", "return {\n  ui = { hints = \"no\" },\n}\n");
    let e = config::load(&dir).unwrap_err();
    assert_eq!(e.line, Some(2), "{e}");
    assert!(e.message.contains("ui.hints"), "{e}");
}

#[test]
fn terminal_shell_hooks_is_unset_by_default_and_takes_a_boolean() {
    // Ticket 121: unset leaves it to each Host's `shell_hooks` in roster.yml.
    assert_eq!(Config::default().terminal.shell_hooks, None);
    let dir = with_init("shell-hooks", "return { terminal = { shell_hooks = true } }\n");
    assert_eq!(config::load(&dir).unwrap().terminal.shell_hooks, Some(true));
    let dir = with_init(
        "shell-hooks-bad",
        "return {\n  terminal = { shell_hooks = \"yes\" },\n}\n",
    );
    let e = config::load(&dir).unwrap_err();
    assert_eq!(e.line, Some(2), "{e}");
    assert!(e.message.contains("terminal.shell_hooks"), "{e}");
}

#[test]
fn ui_messages_is_unset_by_default_and_takes_quiet_or_all() {
    // Ticket 111: unset leaves it to `:messages`, whose choice the State keeps (quiet until it
    // makes one).
    use roster_core::config::MessagesLevel;
    assert_eq!(Config::default().ui.messages, None);
    let dir = with_init("messages", "return { ui = { messages = \"all\" } }\n");
    assert_eq!(config::load(&dir).unwrap().ui.messages, Some(MessagesLevel::All));
    let dir = with_init("messages-bad", "return {\n  ui = { messages = \"loud\" },\n}\n");
    let e = config::load(&dir).unwrap_err();
    assert_eq!(e.line, Some(2), "{e}");
    assert!(e.message.contains("ui.messages"), "{e}");
}

#[test]
fn panel_width_and_views_set_each_panels_defaults() {
    // Ticket 95: unset, each panel keeps its own; set, they're defaults the State's choice wins over.
    assert_eq!(Config::default().panel.width, None);
    assert!(Config::default().views.is_empty());
    let dir = with_init(
        "panels",
        "return {\n  panel = { width = 35 },\n  views = { topology = { place = \"panel\", width = 60 }, help = { place = \"full\" } },\n}\n",
    );
    let c = config::load(&dir).unwrap();
    assert_eq!(c.panel.width, Some(35));
    let topology = &c.views["topology"];
    assert_eq!(
        (topology.place, topology.width),
        (Some(config::PanelPlace::Panel), Some(60))
    );
    assert_eq!(c.views["help"].place, Some(config::PanelPlace::Full));
    let json = serde_json::to_value(&c).unwrap();
    assert_eq!(
        json["views"]["topology"],
        serde_json::json!({ "place": "panel", "width": 60 })
    );

    let dir = with_init(
        "panels-wide",
        "return {\n  views = { topology = { width = 120 } },\n}\n",
    );
    let e = config::load(&dir).unwrap_err();
    assert!(
        e.message.contains("views.topology.width") && e.message.contains("10 to 95"),
        "{e}"
    );
    let dir = with_init(
        "panels-place",
        "return {\n  views = { help = { place = \"left\" } },\n}\n",
    );
    assert!(config::load(&dir).unwrap_err().message.contains("views.help.place"));
    let dir = with_init("panels-narrow", "return { panel = { width = 5 } }\n");
    assert!(config::load(&dir).unwrap_err().message.contains("panel.width"));
}

#[test]
fn the_ui_text_size_is_read_and_kept_in_range() {
    let dir = with_init("uisize", "return { fonts = { ui_size = 16 } }\n");
    assert_eq!(config::load(&dir).unwrap().fonts.ui_size, 16);
    let dir = with_init("uisize-range", "return {\n  fonts = { ui_size = 9 },\n}\n");
    let e = config::load(&dir).unwrap_err();
    assert_eq!(e.line, Some(2), "{e}");
    assert!(e.message.contains("fonts.ui_size"), "{e}");
}

#[test]
fn pull_fresh_minutes_defaults_to_five_and_takes_zero_to_a_day() {
    // Decision Q88: a form pulls the infra repo in the background once the last pull is older.
    assert_eq!(Config::default().pull_fresh_minutes, 5);
    let dir = with_init("pullfresh", "return { pull_fresh_minutes = 0 }\n");
    assert_eq!(config::load(&dir).unwrap().pull_fresh_minutes, 0);
    let dir = with_init("pullfresh-range", "return {\n  pull_fresh_minutes = 2000,\n}\n");
    let e = config::load(&dir).unwrap_err();
    assert_eq!(e.line, Some(2), "{e}");
    assert!(e.message.contains("pull_fresh_minutes"), "{e}");
}

#[test]
fn plugin_proxy_is_unset_by_default_and_never_carries_credentials() {
    // Decision Q116: the user's proxy for Plugins' requests, an http://HOST:PORT and nothing more.
    assert_eq!(Config::default().plugin_proxy, None);
    let dir = with_init("proxy", "return { plugin_proxy = \"http://10.0.0.5:3128\" }\n");
    assert_eq!(
        config::load(&dir).unwrap().plugin_proxy.as_deref(),
        Some("http://10.0.0.5:3128")
    );
    let dir = with_init(
        "proxy-creds",
        "return {\n  plugin_proxy = \"http://someone:hunter2@10.0.0.5:3128\",\n}\n",
    );
    let e = config::load(&dir).unwrap_err();
    assert_eq!(e.line, Some(2), "{e}");
    assert!(
        e.message.contains("plugin_proxy") && e.message.contains("no user or password"),
        "{e}"
    );
    assert!(!e.message.contains("hunter2"), "{e}");
}

#[test]
fn returning_something_other_than_a_table_is_an_error() {
    let dir = with_init("notable", "return 42\n");
    assert!(config::load(&dir).unwrap_err().message.contains("must return a table"));
}

#[test]
fn reload_keeps_the_last_good_config_on_error() {
    let dir = with_init("reload", "return { vim = false }");
    let loader = Loader::new(&dir);
    let first = loader.reload();
    assert!(first.error.is_none());
    assert!(!first.config.vim);

    std::fs::write(dir.join("init.lua"), "return { vim = false, leader = }").unwrap();
    let broken = loader.reload();
    assert_eq!(broken.error.as_ref().map(|e| e.line), Some(Some(1)));
    assert!(!broken.config.vim, "the last good Config stays");
    assert!(!loader.current().vim);

    std::fs::write(dir.join("init.lua"), "return { leader = \"Ctrl+b\" }").unwrap();
    let fixed = loader.reload();
    assert!(fixed.error.is_none());
    assert_eq!(
        [first.version, broken.version, fixed.version],
        [1, 2, 3],
        "each reload is numbered, so the frontend can keep the newest"
    );
    assert_eq!(fixed.config.leader, "Ctrl+b");
    assert!(
        fixed.config.vim,
        "back to the default once the file no longer says otherwise"
    );
}

/// Runs `expr` in init.lua and returns what it evaluated to, as the Config's `leader` string.
fn probe(name: &str, expr: &str) -> String {
    let dir = with_init(name, &format!("return {{ leader = tostring({expr}) }}"));
    config::load(&dir).unwrap().leader
}

#[test]
fn lua_gets_only_safe_libraries() {
    for (name, expr) in [
        ("io", "io"),
        ("execute", "os.execute"),
        ("getenv", "os.getenv"),
        ("remove", "os.remove"),
        ("exit", "os.exit"),
        ("debug", "debug"),
        ("package", "package"),
        ("dofile", "dofile"),
        ("loadfile", "loadfile"),
        ("dump", "string.dump"),
    ] {
        assert_eq!(probe(name, expr), "nil", "{expr} must not be there");
    }
    // What a Config needs is there.
    assert_eq!(probe("fmt", "string.format('%d', 7)"), "7");
    assert_eq!(probe("date", "type(os.date('%Y'))"), "string");
    assert_eq!(probe("floor", "math.floor(2.5)"), "2");
}

#[test]
fn load_refuses_bytecode() {
    // "\27Lua" starts a precompiled chunk.
    let v = probe("bytecode", r#"select(2, load("\27Lua\84\0"))"#);
    assert!(v.contains("binary") || v.contains("attempt to load"), "{v}");
    assert_eq!(probe("text", r#"load("return 1 + 1")()"#), "2");
}

#[test]
fn require_loads_modules_from_the_config_dir_only() {
    let dir = with_init(
        "require",
        r#"
        local keys = require("keys")
        local theme = require("themes.mine")
        return { leader = keys.leader, theme = theme }
        "#,
    );
    std::fs::write(dir.join("keys.lua"), r#"return { leader = "Ctrl+b" }"#).unwrap();
    std::fs::create_dir_all(dir.join("lua/themes")).unwrap();
    std::fs::write(dir.join("lua/themes/mine.lua"), r#"return "nord""#).unwrap();
    let config = config::load(&dir).unwrap();
    assert_eq!(config.leader, "Ctrl+b");
    assert_eq!(config.theme, "nord");

    for (name, module) in [
        ("escape", "../escape"),
        ("abs", "/etc/passwd"),
        ("os", "os"),
        ("dots", "a..b"),
    ] {
        let dir = with_init(&format!("req-{name}"), &format!("return require({module:?})"));
        let e = config::load(&dir).unwrap_err();
        assert_eq!(e.line, Some(1), "{e}");
    }
}

#[cfg(unix)]
#[test]
fn require_refuses_a_symlink_out_of_the_config_dir() {
    let outside = temp_dir("outside");
    std::fs::write(outside.join("secret.lua"), "return { leader = 'stolen' }").unwrap();
    let dir = with_init("symlink", "return require('secret')");
    std::os::unix::fs::symlink(outside.join("secret.lua"), dir.join("secret.lua")).unwrap();
    let e = config::load(&dir).unwrap_err();
    assert!(e.message.contains("outside the config dir"), "{e}");
}

#[test]
fn an_error_in_a_required_module_names_that_file() {
    let dir = with_init("req-err", "local k = require('keys')\nreturn {}\n");
    std::fs::write(dir.join("keys.lua"), "\n\nreturn { = }\n").unwrap();
    let e = config::load(&dir).unwrap_err();
    assert_eq!((e.file.as_str(), e.line), ("keys.lua", Some(3)), "{e}");
}

#[test]
fn an_endless_loop_runs_out_of_time() {
    let dir = with_init("loop", "local n = 0\nwhile true do n = n + 1 end\n");
    let env = config::Env {
        limits: config::Limits {
            time: std::time::Duration::from_millis(100),
            ..config::Limits::default()
        },
        ..config::Env::default()
    };
    let started = std::time::Instant::now();
    let e = config::load_with(&dir, &env).unwrap_err();
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
    assert_eq!(e.line, Some(2), "{e}");
    assert!(e.message.contains("took longer"), "{e}");
}

#[test]
fn a_runaway_table_runs_out_of_memory() {
    let dir = with_init(
        "memory",
        "local t = {}\nfor i = 1, 1e9 do t[i] = string.rep('x', 1000) .. i end\n",
    );
    let env = config::Env {
        limits: config::Limits {
            memory: 8 * 1024 * 1024,
            ..config::Limits::default()
        },
        ..config::Env::default()
    };
    let e = config::load_with(&dir, &env).unwrap_err();
    assert!(e.message.contains("memory"), "{e}");
}

#[test]
fn the_roster_api_registers_keys_and_themes_with_their_lines() {
    let dir = with_init(
        "api",
        r##"local roster = require("roster")
roster.keymap.set("leader", "x", "close")
roster.keymap.set("global", "F12", "keys")
roster.keymap.set("cmdline", "Ctrl+j", "cmdline.next")
roster.themes.define("mine", { base = "nord", colors = { accent = "#ff8800" } })
return { theme = "mine" }
"##,
    );
    let config = config::load(&dir).unwrap();
    let keys: Vec<_> = config
        .keys
        .0
        .iter()
        .map(|b| (b.context, b.keys.as_str(), b.action.clone()))
        .collect();
    assert!(keys.contains(&(config::KeyContext::Leader, "x", config::KeyAction::Run("close".into()))));
    assert!(keys.contains(&(config::KeyContext::Global, "F12", config::KeyAction::Run("keys".into()))));
    assert!(keys.contains(&(
        config::KeyContext::Cmdline,
        "Ctrl+j",
        config::KeyAction::Run("cmdline.next".into())
    )));
    assert_eq!(config.themes["mine"].colors.accent.as_deref(), Some("#ff8800"));
    assert_eq!(config.lines["keys.leader.x"].line, 2);
    assert_eq!(config.lines["keys.cmdline.Ctrl+j"].line, 4);
    assert_eq!(config.lines["themes.mine"].line, 5);
}

/// `:help options` says where each option's value came from (ticket 37): the options the file
/// sets, in its table or through `roster.set`, down to each value, with their lines.
#[test]
fn the_config_says_which_options_the_file_set_and_where() {
    let dir = with_init(
        "set",
        r##"local roster = require("roster")
roster.set("fonts.ui_size", 16)
return {
  vim = true,
  terminal = {
    size = "14pt",
  },
  modes = { focus = { sidebar = false } },
}
"##,
    );
    let config = config::load(&dir).unwrap();
    assert_eq!(
        config.set,
        ["fonts.ui_size", "modes.focus.sidebar", "terminal.size", "vim"]
    );
    assert_eq!(config.lines["vim"].line, 4);
    assert_eq!(config.lines["terminal.size"].line, 6);
    assert_eq!(config.lines["fonts.ui_size"].line, 2);
    // Setting a value to its default still counts as set by the file.
    assert!(config.vim);
    assert!(config::load(&temp_dir("set-none")).unwrap().set.is_empty());
}

#[test]
fn a_bad_value_given_to_the_api_is_an_error_on_the_call_line() {
    let dir = with_init(
        "api-bad",
        "\nroster.themes.define('x', { colors = { nope = 'red' } })\nreturn {}\n",
    );
    let e = config::load(&dir).unwrap_err();
    assert_eq!(e.line, Some(2), "{e}");
    let dir = with_init("api-ctx", "roster.keymap.set('nowhere', 'x', 'close')\nreturn {}\n");
    assert_eq!(config::load(&dir).unwrap_err().line, Some(1));
}

#[test]
fn layouts_take_shorthands_and_keep_each_modes_defaults() {
    let dir = with_init(
        "modes",
        r#"return { modes = {
            standard = { sidebar = { side = "right", sections = { "folders", "sessions" } }, statusbar = { "backend", "hosts" } },
            focus = { sessionbar = "bottom" },
        } }"#,
    );
    let m = config::load(&dir).unwrap().modes;
    assert_eq!(m.standard.sidebar.side, config::Side::Right);
    assert_eq!(
        m.standard.sidebar.sections.as_deref(),
        Some(&["folders".to_string(), "sessions".to_string()][..])
    );
    assert_eq!(m.standard.statusbar.segments.as_ref().map(Vec::len), Some(2));
    assert!(m.standard.titlebar, "unset pieces keep the mode's default");
    assert!(m.focus.sessionbar.shown);
    assert_eq!(m.focus.sessionbar.at, config::Edge::Bottom);
    assert!(m.focus.fullscreen, "Focus stays fullscreen");
    assert!(!m.focus.statusbar.shown);

    let dir = with_init(
        "modes-off",
        "return { modes = { standard = { sidebar = false, statusbar = false, titlebar = false } } }",
    );
    let m = config::load(&dir).unwrap().modes;
    assert!(!m.standard.sidebar.shown && !m.standard.statusbar.shown && !m.standard.titlebar);
}

/// Decision Q65 (issue #78): the toolbar's controls are a piece of each mode's layout, so init.lua
/// can pick, order or drop them. Shown in Standard by default, with every built-in control.
#[test]
fn the_toolbar_is_a_piece_of_each_modes_layout() {
    let d = config::Modes::default();
    assert!(d.standard.toolbar.shown && d.standard.toolbar.controls.is_none());
    assert!(!d.focus.toolbar.shown, "Focus has no chrome");

    let dir = with_init(
        "toolbar",
        r#"return { modes = { standard = { toolbar = { "changes", "add" } }, focus = { toolbar = true } } }"#,
    );
    let m = config::load(&dir).unwrap().modes;
    assert_eq!(
        m.standard.toolbar.controls.as_deref(),
        Some(&["changes".to_string(), "add".to_string()][..])
    );
    assert!(m.focus.toolbar.shown && m.focus.toolbar.controls.is_none());

    let dir = with_init("toolbar-off", "return { modes = { standard = { toolbar = false } } }");
    assert!(!config::load(&dir).unwrap().modes.standard.toolbar.shown);
}

/// Issue #78: the frontend keeps a shown or hidden Sidebar in the State unless init.lua sets it, so
/// each mode says which pieces init.lua set.
#[test]
fn each_mode_says_which_pieces_init_lua_set() {
    assert!(config::Modes::default().standard.set.is_empty());
    let dir = with_init(
        "modes-set",
        r#"return { modes = { standard = { sidebar = false, toolbar = { "add" } }, focus = { statusbar = true } } }"#,
    );
    let m = config::load(&dir).unwrap().modes;
    assert_eq!(m.standard.set, ["sidebar", "toolbar"]);
    assert_eq!(m.focus.set, ["statusbar"]);
}

#[test]
fn folders_backend_and_roster_command() {
    let dir = with_init(
        "misc",
        r#"return {
            folders = { { name = "Lab ESXi", hosts = { "esxi-02", "esxi-03" } }, { name = "Empty", hosts = {} } },
            backend = "wsl:Ubuntu",
            roster_command = "uv run --project /home/me/roster roster",
        }"#,
    );
    let c = config::load(&dir).unwrap();
    assert_eq!(c.folders.len(), 2);
    assert_eq!(c.folders[0].hosts, ["esxi-02", "esxi-03"]);
    assert_eq!(c.lines["folders.Lab ESXi"].line, 2);
    assert_eq!(c.backend, config::BackendChoice::Wsl(Some("Ubuntu".into())));
    assert_eq!(c.roster_command.unwrap().0[..2], ["uv".to_string(), "run".to_string()]);
}

#[test]
fn the_config_dir_follows_the_platform() {
    use config::{Os, dir_for, legacy_dir_for};
    use std::path::PathBuf;
    let env = |k: &str| match k {
        "APPDATA" => Some(PathBuf::from(r"C:\Users\me\AppData\Roaming")),
        "HOME" => Some(PathBuf::from("/home/me")),
        _ => None,
    };
    assert_eq!(
        dir_for(Os::Windows, env),
        Some(PathBuf::from(r"C:\Users\me\AppData\Roaming").join("roster"))
    );
    assert_eq!(dir_for(Os::Linux, env), Some(PathBuf::from("/home/me/.config/roster")));
    let xdg = |k: &str| (k == "XDG_CONFIG_HOME").then(|| PathBuf::from("/x"));
    assert_eq!(dir_for(Os::Linux, xdg), Some(PathBuf::from("/x/roster")));
    // Where roster-desk kept it, for the one-time copy (migrate.rs).
    assert_eq!(
        legacy_dir_for(Os::Windows, env),
        Some(PathBuf::from(r"C:\Users\me\AppData\Roaming").join("roster-desk"))
    );
    assert_eq!(legacy_dir_for(Os::Linux, xdg), Some(PathBuf::from("/x/roster-desk")));
    assert_eq!(dir_for(Os::Linux, |_| None), None);
}

#[test]
fn saving_calls_the_watcher_back_once_for_a_write_or_a_rename() {
    use std::sync::mpsc;
    use std::time::Duration;
    let dir = temp_dir("watch");
    let (tx, rx) = mpsc::channel();
    let _w = config::watch(&dir, move || {
        let _ = tx.send(());
    })
    .unwrap();
    // A first file appears.
    std::fs::write(dir.join("init.lua"), "return {}").unwrap();
    rx.recv_timeout(Duration::from_secs(3)).expect("a new init.lua is seen");
    // Vim-style: write a temp file, rename it over.
    std::fs::write(dir.join("init.lua.tmp"), "return { vim = false }").unwrap();
    std::fs::rename(dir.join("init.lua.tmp"), dir.join("init.lua")).unwrap();
    rx.recv_timeout(Duration::from_secs(3))
        .expect("a rename over init.lua is seen");
    // One save, one call.
    assert!(rx.recv_timeout(Duration::from_millis(400)).is_err());
    // Something else in the dir is ignored.
    std::fs::write(dir.join("notes.txt"), "hi").unwrap();
    assert!(rx.recv_timeout(Duration::from_millis(400)).is_err());
}

/// The defaults as the frontend gets them, kept in a file that src/config tests read, so the
/// Rust defaults and the TypeScript ones (src/keymap.ts, theme.ts, …) can't drift apart.
/// `UPDATE_FIXTURES=1 cargo test` rewrites it.
#[test]
fn the_defaults_fixture_is_current() {
    let names = serde_json::json!({
        "config": Config::default(),
        "themeColors": config::ThemeColors::NAMES,
        "themeTerminal": config::ThemeTerminalColors::NAMES,
        "ansi": config::Ansi::NAMES,
        "terminalColors": config::TerminalColors::NAMES,
    });
    let text = serde_json::to_string_pretty(&names).unwrap() + "\n";
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/config-defaults.json");
    if std::env::var_os("UPDATE_FIXTURES").is_some() {
        std::fs::write(&path, &text).unwrap();
    }
    let on_disk = std::fs::read_to_string(&path).unwrap_or_default();
    assert_eq!(
        on_disk,
        text,
        "run UPDATE_FIXTURES=1 cargo test to update {}",
        path.display()
    );
}

#[test]
fn the_env_vars_win_over_the_configs_backend_and_roster_command() {
    use config::{BackendChoice, RosterCommand, backend_plan};
    use roster_core::detect::{Choice, Platform};
    let c = Config {
        roster_command: Some(RosterCommand(vec!["uv".into(), "run".into(), "roster".into()])),
        backend: BackendChoice::Wsl(Some("Ubuntu".into())),
        ..Config::default()
    };
    let plan = backend_plan(&c, Platform::Windows, None, None).unwrap();
    assert_eq!(plan.command, ["uv", "run", "roster"]);
    assert_eq!(plan.distro(), Some("Ubuntu"));

    let plan = backend_plan(&c, Platform::Windows, Some("roster-dev serve-stack"), Some("Debian")).unwrap();
    assert_eq!(plan.command, ["roster-dev", "serve-stack"]);
    assert_eq!(plan.distro(), Some("Debian"));

    // Blank env vars don't count.
    let plan = backend_plan(&Config::default(), Platform::Windows, Some("  "), Some("")).unwrap();
    assert_eq!(plan.command, ["roster"]);
    assert_eq!(plan.distro(), None);
    assert_eq!(plan.choice, Choice::Auto);

    // Native Windows roster (ticket 19): `local` is a plan of its own on both platforms, and the
    // distro env var still wins over it (development).
    let local = Config {
        backend: BackendChoice::Local,
        ..Config::default()
    };
    assert_eq!(
        backend_plan(&local, Platform::Windows, None, None).unwrap().choice,
        Choice::Local
    );
    assert_eq!(
        backend_plan(&local, Platform::Linux, None, None).unwrap().choice,
        Choice::Local
    );
    assert_eq!(
        backend_plan(&local, Platform::Windows, None, Some("Debian"))
            .unwrap()
            .choice,
        Choice::Wsl(Some("Debian".into()))
    );
    let any_wsl = Config {
        backend: BackendChoice::Wsl(None),
        ..Config::default()
    };
    assert_eq!(
        backend_plan(&any_wsl, Platform::Windows, None, None).unwrap().choice,
        Choice::Wsl(None)
    );
}

/// Changing `backend` in init.lua is a different plan, both ways, so the app restarts serve on
/// `:source` (ticket 19); a reload that keeps it is the same plan, so serve keeps running.
#[test]
fn switching_backend_changes_the_plan_both_ways() {
    use config::{BackendChoice, backend_plan};
    use roster_core::detect::Platform;
    let with = |b: BackendChoice| Config {
        backend: b,
        ..Config::default()
    };
    let plan = |b| backend_plan(&with(b), Platform::Windows, None, None).unwrap();
    let wsl = plan(BackendChoice::Wsl(Some("Ubuntu".into())));
    let local = plan(BackendChoice::Local);
    assert_ne!(wsl, local);
    assert_ne!(local, plan(BackendChoice::Wsl(Some("Ubuntu".into()))));
    assert_eq!(local, plan(BackendChoice::Local));
}

/// examples/init.lua documents every option with its default value, so loading it gives the
/// defaults (apart from the Themes it defines as examples).
#[test]
fn the_example_init_lua_loads_and_is_the_defaults() {
    let example = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/init.lua");
    let dir = with_init("example", &std::fs::read_to_string(example).unwrap());
    let mut config = config::load(&dir).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(config.themes.keys().collect::<Vec<_>>(), ["paper", "roster-ember"]);
    config.themes.clear();
    config.lines.clear();
    config.set.clear();
    // It writes out every piece of each mode, at its default.
    assert_eq!(config.modes.standard.set.len(), 6);
    config.modes.standard.set.clear();
    config.modes.focus.set.clear();
    assert_eq!(config, Config::default());
}

/// Loads `dir` with a short time limit on another thread, and fails the test (instead of hanging
/// it) if the load doesn't come back within `within`.
fn load_quickly(dir: &std::path::Path, within: std::time::Duration) -> Result<Config, config::ConfigError> {
    let dir = dir.to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let env = config::Env {
            limits: config::Limits {
                time: std::time::Duration::from_millis(100),
                ..config::Limits::default()
            },
            ..config::Env::default()
        };
        let _ = tx.send(config::load_with(&dir, &env));
    });
    rx.recv_timeout(within)
        .expect("init.lua kept running past its time limit")
}

#[test]
fn pcall_and_xpcall_cant_catch_running_out_of_time() {
    for (name, lua) in [
        ("pcall", "while true do pcall(function() while true do end end) end"),
        (
            "xpcall",
            "while true do xpcall(function() while true do end end, function(e) return e end) end",
        ),
        (
            "xpcall-handler",
            "while true do xpcall(function() error('x') end, function() while true do end end) end",
        ),
        (
            "nested",
            "while true do pcall(pcall, pcall, function() while true do end end) end",
        ),
        (
            "coroutine",
            "while true do pcall(function() local co = coroutine.wrap(function() while true do end end) co() end) end",
        ),
    ] {
        let dir = with_init(&format!("deadline-{name}"), lua);
        let e = load_quickly(&dir, std::time::Duration::from_secs(5)).unwrap_err();
        assert!(e.message.contains("took longer"), "{name}: {e}");
        assert_eq!(e.line, Some(1), "{name}: {e}");
    }
    // In time, they work as usual.
    assert_eq!(probe("pcall-ok", "select(2, pcall(function() return 7 end))"), "7");
    assert_eq!(probe("pcall-err", "select(2, pcall(error, 'no', 0))"), "no");
    assert_eq!(
        probe(
            "xpcall-ok",
            "select(2, xpcall(error, function(e) return 'h:' .. e end, 'no', 0))"
        ),
        "h:no"
    );
}

#[test]
fn a_table_shared_into_a_huge_tree_is_refused_quickly() {
    // 30 tables, but 2^30 nodes once each shared subtable is copied out.
    let shared = "local t = {}\nfor i = 1, 30 do t = { a = t, b = t } end\n";
    for (name, tail) in [
        ("returned", "return { themes = { big = t } }"),
        ("api", "roster.themes.define('big', t)\nreturn {}"),
    ] {
        let dir = with_init(&format!("shared-{name}"), &format!("{shared}{tail}"));
        let e = load_quickly(&dir, std::time::Duration::from_secs(5)).unwrap_err();
        assert!(e.message.contains("too big"), "{name}: {e}");
    }
    // Sharing a small table is fine: each use is a copy.
    let dir = with_init(
        "shared-ok",
        "local c = { accent = '#ff0000' }\nreturn { colors = c, themes = { a = { colors = c }, b = { colors = c } } }",
    );
    let c = config::load(&dir).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(c.themes.len(), 2);
}

#[test]
fn a_table_that_contains_itself_says_so() {
    let dir = with_init("cycle", "local t = {}\nt.colors = t\nreturn { themes = { loop = t } }");
    let e = config::load(&dir).unwrap_err();
    assert!(e.message.contains("contains itself"), "{e}");
}

#[test]
fn string_functions_refuse_sizes_a_config_never_needs() {
    for (name, call, what) in [
        ("find", "string.find(string.rep('a', 70000), 'b')", "string.find"),
        ("method", "(string.rep('a', 70000)):match('b')", "string.match"),
        ("gsub", "string.gsub('abc', string.rep('a', 300), '')", "string.gsub"),
        ("gmatch", "string.gmatch(string.rep('a', 70000), 'a')", "string.gmatch"),
        ("rep", "string.rep('ab', 3e6)", "string.rep"),
    ] {
        let dir = with_init(
            &format!("caps-{name}"),
            &format!("local x = 1\nlocal _ = {call}\nreturn {{}}"),
        );
        let e = config::load(&dir).unwrap_err();
        assert!(e.message.contains(what), "{name}: {e}");
        assert_eq!(e.line, Some(2), "{name}: {e}");
    }
    // Ordinary sizes work as usual.
    assert_eq!(probe("caps-ok", "('ctrl+b'):gsub('ctrl', 'Ctrl')"), "Ctrl+b");
}

#[test]
fn a_slow_pattern_is_cut_off_by_the_watchdog() {
    // A pattern that backtracks: one C call (no instruction hook inside) that runs for seconds.
    let dir = with_init(
        "backtrack",
        "local s = string.rep('a', 2000)\nlocal _ = s:find('.-.-b')\nreturn {}",
    );
    let env = config::Env {
        limits: config::Limits {
            time: std::time::Duration::from_millis(100),
            wall: std::time::Duration::from_millis(300),
            ..config::Limits::default()
        },
        ..config::Env::default()
    };
    let started = std::time::Instant::now();
    let e = config::load_with(&dir, &env).unwrap_err();
    assert!(
        started.elapsed() < std::time::Duration::from_secs(1),
        "{:?}",
        started.elapsed()
    );
    assert!(e.message.starts_with("took too long"), "{e}");
    assert_eq!(e.to_string().matches("init.lua").count(), 1, "{e}");
}

/// roster_command picks the program that gets the master password, two-step codes and the API
/// secret on its stdin, so init.lua may only name roster itself; any other wrapper takes the
/// ROSTER_APP_ROSTER env var, which the user sets outside the Config.
#[test]
fn roster_command_from_init_lua_must_run_roster() {
    for ok in [
        r#""roster""#,
        r#""/home/me/.local/bin/roster""#,
        r#""~/.local/bin/roster""#,
        r#"{ "roster" }"#,
        r#""uv run --project /home/me/roster roster""#,
        r#""uv run --directory=/home/me/roster --frozen -q roster""#,
        r#"{ "/usr/bin/uv", "run", "--project", "/home/me/my roster", "roster" }"#,
    ] {
        let dir = with_init("cmd-ok", &format!("return {{\n  roster_command = {ok},\n}}"));
        assert!(config::load(&dir).is_ok(), "{ok} should be accepted");
    }
    for bad in [
        r#""sh -c roster""#,
        r#"{ "sh", "-c", "tee /tmp/secrets | roster serve" }"#,
        r#""python3 -m roster""#,
        r#""roster-wrapper""#,
        r#""roster --config /tmp/other.yml""#,
        r#""uv run --with evil roster""#,
        r#""uv run --project /home/me/roster python -m roster""#,
        r#""uv run --project""#,
        r#""uvx roster""#,
    ] {
        let dir = with_init("cmd-bad", &format!("return {{\n  roster_command = {bad},\n}}"));
        let e = config::load(&dir).expect_err(bad);
        assert_eq!(e.line, Some(2), "{bad}: {e}");
        assert!(e.message.starts_with("roster_command:"), "{bad}: {e}");
        assert!(e.message.contains("ROSTER_APP_ROSTER"), "{bad}: {e}");
    }
}

#[test]
fn the_backend_plan_refuses_a_roster_command_that_isnt_roster_but_the_env_var_may_wrap() {
    use config::{RosterCommand, backend_plan};
    use roster_core::detect::Platform;
    let c = Config {
        roster_command: Some(RosterCommand(vec!["sh".into(), "-c".into(), "roster".into()])),
        ..Config::default()
    };
    let e = backend_plan(&c, Platform::Linux, None, None).unwrap_err();
    assert!(e.contains("ROSTER_APP_ROSTER"), "{e}");
    let plan = backend_plan(&c, Platform::Linux, Some("my-wrapper roster"), None).unwrap();
    assert_eq!(plan.command, ["my-wrapper", "roster"]);
}

/// A loader for an init.lua that keeps Lua busy for at least `ms` of wall-clock time (os.time
/// counts seconds and os.clock is the whole process's CPU, so it counts its own iterations,
/// calibrated first), then sets the leader. Its limits are generous so it isn't cut off. Returns its
/// folder too, deleted when the test drops it.
fn slow_loader(name: &str, ms: u32) -> (Loader, common::Temp) {
    let dir = with_init(
        name,
        &format!(
            "local n = 0\nfor i = 1, {} do n = n + i end\nreturn {{ leader = 'Ctrl+b' }}",
            iterations_for(ms)
        ),
    );
    (Loader::with_env(&dir, generous()), dir)
}

fn generous() -> config::Env {
    config::Env {
        limits: config::Limits {
            time: std::time::Duration::from_secs(30),
            wall: std::time::Duration::from_secs(60),
            ..config::Limits::default()
        },
        ..config::Env::default()
    }
}

/// How many loop iterations take at least `ms` here.
fn iterations_for(ms: u32) -> u64 {
    let n = 2_000_000u64;
    let dir = with_init(
        &format!("calibrate-{ms}"),
        &format!("local n = 0\nfor i = 1, {n} do n = n + i end\nreturn {{}}"),
    );
    let started = std::time::Instant::now();
    config::load_with(&dir, &generous()).unwrap();
    let per_ms = n as f64 / started.elapsed().as_millis().max(1) as f64;
    (per_ms * f64::from(ms)) as u64
}

/// The Tauri shell reads the Config from async commands (backend_connect, config_load) while a
/// reload may be running Lua on another thread: reading must never wait for Lua.
#[test]
fn reading_the_config_never_waits_for_a_reload_in_progress() {
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    let (loader, _dir) = slow_loader("loader-busy", 600);
    let loader = Arc::new(loader);
    let l = Arc::clone(&loader);
    let reload = std::thread::spawn(move || l.reload());
    std::thread::sleep(Duration::from_millis(100));

    let started = Instant::now();
    assert_eq!(
        loader.current().leader,
        "Ctrl+Space",
        "the defaults until the reload is done"
    );
    assert!(loader.last().is_none(), "nothing loaded yet");
    assert!(started.elapsed() < Duration::from_millis(50), "{:?}", started.elapsed());

    // `settled` is for blocking threads: it waits for the reload, and sees its result.
    assert_eq!(loader.settled().leader, "Ctrl+b");
    assert_eq!(reload.join().unwrap().config.leader, "Ctrl+b");
    assert_eq!(loader.last().unwrap().config.leader, "Ctrl+b");
}

/// At startup the window waits for the Config only briefly; a slow init.lua arrives later, as
/// a change.
#[test]
fn a_startup_reload_waits_only_so_long_then_reports_when_done() {
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    let (loader, _dir) = slow_loader("loader-startup", 600);
    let loader = Arc::new(loader);
    let (tx, rx) = std::sync::mpsc::channel();
    let started = Instant::now();
    let now = loader.reload_within(Duration::from_millis(100), move |report| {
        let _ = tx.send(report);
    });
    assert!(now.is_none(), "not done within the wait");
    assert!(
        started.elapsed() < Duration::from_millis(300),
        "{:?}",
        started.elapsed()
    );
    let later = rx.recv_timeout(Duration::from_secs(5)).expect("reported when done");
    assert_eq!(later.config.leader, "Ctrl+b");

    // A quick one is there straight away (and still reported).
    let dir = with_init("loader-quick", "return { vim = false }");
    let loader = Arc::new(Loader::new(&dir));
    let (tx, rx) = std::sync::mpsc::channel();
    let now = loader.reload_within(Duration::from_secs(2), move |report| {
        let _ = tx.send(report);
    });
    assert!(!now.expect("done within the wait").config.vim);
    assert!(!rx.recv_timeout(Duration::from_secs(2)).unwrap().config.vim);
}

/// Dotfile managers (stow, chezmoi's symlink mode) make init.lua and its modules symlinks into
/// another folder. Saving the real file must reload too.
#[cfg(unix)]
#[test]
fn saving_a_symlinked_init_lua_or_module_calls_the_watcher_back() {
    use std::os::unix::fs::symlink;
    use std::sync::mpsc;
    use std::time::Duration;
    let dotfiles = temp_dir("watch-dotfiles");
    std::fs::write(dotfiles.join("init.lua"), "return {}").unwrap();
    std::fs::create_dir_all(dotfiles.join("lua")).unwrap();
    std::fs::write(dotfiles.join("lua/keys.lua"), "return {}").unwrap();
    std::fs::write(dotfiles.join("other.txt"), "").unwrap();
    let dir = temp_dir("watch-symlinked");
    symlink(dotfiles.join("init.lua"), dir.join("init.lua")).unwrap();
    symlink(dotfiles.join("lua"), dir.join("lua")).unwrap();

    let (tx, rx) = mpsc::channel();
    let _w = config::watch(&dir, move || {
        let _ = tx.send(());
    })
    .unwrap();
    std::thread::sleep(Duration::from_millis(100));

    std::fs::write(dotfiles.join("init.lua"), "return { vim = false }").unwrap();
    rx.recv_timeout(Duration::from_secs(3))
        .expect("a save of the symlink's target is seen");
    // Editor-style: a temp file renamed over the target.
    std::fs::write(dotfiles.join("init.lua.tmp"), "return {}").unwrap();
    std::fs::rename(dotfiles.join("init.lua.tmp"), dotfiles.join("init.lua")).unwrap();
    rx.recv_timeout(Duration::from_secs(3))
        .expect("a rename over the target is seen");
    std::fs::write(dotfiles.join("lua/keys.lua"), "return { 1 }").unwrap();
    rx.recv_timeout(Duration::from_secs(3))
        .expect("a module in a symlinked folder is seen");
    // The rest of the dotfiles folder isn't the Config.
    while rx.recv_timeout(Duration::from_millis(400)).is_ok() {}
    std::fs::write(dotfiles.join("other.txt"), "x").unwrap();
    assert!(rx.recv_timeout(Duration::from_millis(400)).is_err());
}

/// A tool that keeps writing (a sync, a formatter on a loop) mustn't hold the reload back
/// forever: it comes at most about half a second after the first event.
#[test]
fn a_continuous_stream_of_saves_still_reloads_within_half_a_second() {
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    let dir = temp_dir("watch-stream");
    std::fs::write(dir.join("init.lua"), "return {}").unwrap();
    let (tx, rx) = mpsc::channel();
    let _w = config::watch(&dir, move || {
        let _ = tx.send(Instant::now());
    })
    .unwrap();
    std::thread::sleep(Duration::from_millis(100));
    let started = Instant::now();
    let writer = std::thread::spawn({
        let dir = dir.to_path_buf();
        move || {
            while started.elapsed() < Duration::from_secs(2) {
                std::fs::write(dir.join("init.lua"), "return {}").unwrap();
                std::thread::sleep(Duration::from_millis(40));
            }
        }
    });
    let first = rx
        .recv_timeout(Duration::from_secs(3))
        .expect("a reload during the stream");
    assert!(
        first.duration_since(started) < Duration::from_millis(900),
        "{:?}",
        first.duration_since(started)
    );
    writer.join().unwrap();
}

// `:config` (ticket 32) --------------------------------------------------------------------------

/// The file `:config` creates: examples/init.lua with every line commented out, so creating it
/// changes nothing until the user uncomments a line.
#[test]
fn the_starter_file_is_the_example_commented_out_and_loads_as_the_defaults() {
    let starter = config::starter();
    for line in starter.lines() {
        assert!(
            line.trim().is_empty() || line.trim_start().starts_with("--"),
            "not commented out: {line:?}"
        );
    }
    // Every option of the example is in it, ready to uncomment.
    assert!(starter.contains("--   theme = \"auto\","));
    assert!(starter.contains("--     size = \"13pt\","));
    let dir = with_init("starter", &starter);
    let mut loaded = config::load(&dir).unwrap_or_else(|e| panic!("{e}"));
    loaded.lines.clear();
    loaded.set.clear();
    assert_eq!(loaded, Config::default());
}

#[test]
fn ensuring_the_file_creates_it_once_and_never_overwrites_it() {
    let tmp = temp_dir("ensure");
    let dir = tmp.join("nested").join("roster");
    let first = config::ensure_file(&dir).unwrap();
    assert!(first.created);
    assert_eq!(first.path, dir.join("init.lua"));
    assert_eq!(std::fs::read_to_string(&first.path).unwrap(), config::starter());

    std::fs::write(&first.path, "return { vim = false }\n").unwrap();
    let second = config::ensure_file(&dir).unwrap();
    assert!(!second.created);
    assert_eq!(
        std::fs::read_to_string(&second.path).unwrap(),
        "return { vim = false }\n"
    );
}

#[test]
fn the_editor_is_the_os_default_or_editor_in_wsl() {
    assert_eq!(Config::default().editor, config::Editor::Os);
    let dir = with_init("editor", r#"return { editor = "wsl" }"#);
    assert_eq!(config::load(&dir).unwrap().editor, config::Editor::Wsl);
    let dir = with_init("editor-bad", r#"return { editor = "notepad" }"#);
    let e = config::load(&dir).unwrap_err();
    assert_eq!(e.line, Some(1));
    assert!(e.message.starts_with("editor:"), "{}", e.message);
}

#[test]
fn how_the_file_opens_follows_the_editor_and_the_os() {
    use config::{Editor, OpenWith, Os, open_with};
    let path = std::path::Path::new(r"C:\Users\me\AppData\Roaming\roster\init.lua");
    assert_eq!(
        open_with(Editor::Os, Os::Windows, path, None),
        Ok(OpenWith::Default(path.to_path_buf()))
    );
    assert_eq!(
        open_with(
            Editor::Os,
            Os::Linux,
            std::path::Path::new("/home/me/.config/roster/init.lua"),
            None
        ),
        Ok(OpenWith::Program {
            argv: vec!["xdg-open".into(), "/home/me/.config/roster/init.lua".into()],
            new_console: false,
        })
    );
    // $EDITOR in the Backend's distro, in a console window of its own; the path goes in as an
    // argument (never into the script), and wslpath turns it into a Linux path.
    let Ok(OpenWith::Program { argv, new_console }) = open_with(Editor::Wsl, Os::Windows, path, Some("Fedora")) else {
        panic!("expected a program")
    };
    assert!(new_console);
    assert_eq!(argv[..4], ["wsl.exe", "-d", "Fedora", "--exec"]);
    assert_eq!(argv.last().unwrap(), &path.display().to_string());
    assert!(
        argv.iter()
            .any(|a| a.contains("${EDITOR:-vi}") && a.contains("wslpath"))
    );
    // No distro: WSL's default.
    let Ok(OpenWith::Program { argv, .. }) = open_with(Editor::Wsl, Os::Windows, path, None) else {
        panic!("expected a program")
    };
    assert_eq!(argv[..2], ["wsl.exe", "--exec"]);
    // There's no WSL off Windows.
    assert!(
        open_with(Editor::Wsl, Os::Linux, path, None)
            .unwrap_err()
            .contains("Windows")
    );
}

// Neovim-style reloading (owner decision Q58): a save doesn't reload unless `auto_reload = true`;
// `:source` reloads now -------------------------------------------------------------------------

#[test]
fn a_save_reloads_only_when_auto_reload_is_on() {
    let dir = with_init("auto-off", "return { vim = false }\n");
    let loader = Loader::new(&dir);
    assert!(!loader.reload().config.auto_reload);
    std::fs::write(dir.join("init.lua"), "return { vim = true }\n").unwrap();
    // The default: the save is noticed, nothing reloads, the last Config stays.
    assert!(loader.on_save().is_none());
    assert!(!loader.current().vim);
    // `:source` reloads it.
    assert!(loader.reload().config.vim);

    std::fs::write(dir.join("init.lua"), "return { auto_reload = true, vim = false }\n").unwrap();
    assert!(loader.on_save().is_none(), "auto_reload takes effect once sourced");
    assert!(loader.reload().config.auto_reload);
    std::fs::write(dir.join("init.lua"), "return { auto_reload = true, vim = true }\n").unwrap();
    let report = loader.on_save().expect("auto_reload = true reloads on save");
    assert!(report.config.vim);
}

#[test]
fn sourcing_a_broken_file_keeps_the_last_good_config() {
    let dir = with_init("source-bad", "return { vim = false }\n");
    let loader = Loader::new(&dir);
    loader.reload();
    std::fs::write(dir.join("init.lua"), "return { vim = }\n").unwrap();
    let report = loader.reload();
    assert_eq!(report.error.as_ref().map(|e| e.line), Some(Some(1)));
    assert!(!report.config.vim);
    assert!(!loader.current().vim);
}

#[test]
fn folders_yml_is_only_read_and_a_save_of_it_is_no_config_change() {
    use roster_core::config::folders;
    use std::sync::mpsc;
    use std::time::Duration;
    let dir = temp_dir("folders");
    assert_eq!(folders::read(&dir).unwrap(), None);
    let (tx, rx) = mpsc::channel();
    let _w = config::watch(&dir, move || {
        let _ = tx.send(());
    })
    .unwrap();
    // Read once, to move its Folders into the Folders Plugin (decision Q93): saving it reloads nothing.
    std::fs::write(folders::path(&dir), "Lab:\n  - esx\n").unwrap();
    assert_eq!(folders::read(&dir).unwrap().as_deref(), Some("Lab:\n  - esx\n"));
    assert!(rx.recv_timeout(Duration::from_millis(400)).is_err());
    std::fs::write(dir.join("init.lua"), "return {}").unwrap();
    rx.recv_timeout(Duration::from_secs(3))
        .expect("a save of init.lua is seen");
}

#[test]
fn on_windows_init_lua_opens_with_the_edit_verb_or_notepad_never_open() {
    use config::{WindowsOpen, windows_open};
    use std::cell::RefCell;
    // The registry, injected: which verbs .lua files have an app for.
    let asked = RefCell::new(Vec::<String>::new());
    let registry = |verbs: &'static [&'static str]| {
        let asked = &asked;
        move |verb: &str| {
            asked.borrow_mut().push(verb.to_string());
            verbs.contains(&verb)
        }
    };
    // A Lua interpreter is .lua's "open" app: running init.lua is never the way to edit it.
    assert_eq!(windows_open(registry(&["open"])), WindowsOpen::Notepad);
    // An editor registered for "edit" is used.
    assert_eq!(windows_open(registry(&["open", "edit"])), WindowsOpen::EditVerb);
    assert_eq!(windows_open(registry(&["edit"])), WindowsOpen::EditVerb);
    // Nothing registered: Notepad.
    assert_eq!(windows_open(registry(&[])), WindowsOpen::Notepad);
    assert!(
        asked.borrow().iter().all(|v| v == "edit"),
        "only ever asks about edit: {:?}",
        asked.borrow()
    );
}

/// Ticket 41: a KeePassXC database (and key file) of this Box's own, sent to roster serve with
/// `vault.configure`. Paths only, never a secret; a path is the Backend's, so it must be absolute.
#[test]
fn the_keepassxc_database_and_key_file_are_paths_on_the_backend() {
    assert_eq!(Config::default().vault, config::Vault::default());
    assert_eq!(Config::default().vault.kp.database, None);
    let dir = with_init(
        "vault-kp",
        r#"return { vault = { kp = { database = "~/roster.kdbx", key_file = "/home/you/roster.keyx" } } }"#,
    );
    let c = config::load(&dir).unwrap();
    assert_eq!(c.vault.kp.database.as_deref(), Some("~/roster.kdbx"));
    assert_eq!(c.vault.kp.key_file.as_deref(), Some("/home/you/roster.keyx"));
    assert_eq!(
        serde_json::to_value(&c.vault).unwrap(),
        serde_json::json!({ "saveTo": null, "kp": { "database": "~/roster.kdbx", "keyFile": "/home/you/roster.keyx" } })
    );
    for (name, lua, field) in [
        (
            "vault-rel",
            "return {\n  vault = { kp = { database = \"roster.kdbx\" } },\n}\n",
            "vault.kp.database",
        ),
        (
            "vault-empty",
            "return {\n  vault = { kp = { key_file = \"\" } },\n}\n",
            "vault.kp.key_file",
        ),
        (
            "vault-secret",
            "return {\n  vault = { kp = { password = \"x\" } },\n}\n",
            "password",
        ),
    ] {
        let e = config::load(&with_init(name, lua)).unwrap_err();
        assert_eq!(e.line, Some(2), "{e}");
        assert!(e.message.contains(field), "{name}: {e}");
    }
}

/// roster serve runs on Linux (in WSL on Windows), so a Windows path in init.lua is refused with
/// the path it most likely means there, instead of roster refusing all of `vault.configure`.
#[test]
fn a_windows_path_for_the_keepassxc_database_is_refused_with_its_wsl_path() {
    for (name, path, hint) in [
        (
            "vault-drive",
            r"C:\Users\you\roster.kdbx",
            "/mnt/c/Users/you/roster.kdbx",
        ),
        (
            "vault-drive-slash",
            "d:/vaults/roster.kdbx",
            "/mnt/d/vaults/roster.kdbx",
        ),
        (
            "vault-wsl-share",
            r"\\wsl.localhost\Ubuntu\home\you\roster.kdbx",
            "/home/you/roster.kdbx",
        ),
        (
            "vault-wsl-dollar",
            r"\\wsl$\Ubuntu\home\you\roster.keyx",
            "/home/you/roster.keyx",
        ),
    ] {
        let lua = format!("return {{\n  vault = {{ kp = {{ database = [[{path}]] }} }},\n}}\n");
        let e = config::load(&with_init(name, &lua)).unwrap_err();
        assert_eq!(e.line, Some(2), "{e}");
        assert!(e.message.contains("vault.kp.database"), "{name}: {e}");
        assert!(e.message.contains("Windows path"), "{name}: {e}");
        assert!(e.message.contains(hint), "{name}: {e}");
    }
    let lua = "return {\n  vault = { kp = { key_file = [[\\\\nas\\keys\\roster.keyx]] } },\n}\n";
    let e = config::load(&with_init("vault-unc", lua)).unwrap_err();
    assert!(
        e.message.contains("vault.kp.key_file") && e.message.contains("Windows path"),
        "{e}"
    );
}

/// With roster on Windows itself (`backend = "local"`, ticket 19) a Windows path is the right one;
/// the same path with another backend is still refused.
#[test]
fn a_windows_path_is_taken_with_the_local_backend() {
    let lua =
        "return {\n  backend = \"local\",\n  vault = { kp = { database = [[C:\\Users\\you\\roster.kdbx]] } },\n}\n";
    let c = config::load(&with_init("vault-local", lua)).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(c.vault.kp.database.as_deref(), Some(r"C:\Users\you\roster.kdbx"));
    let wsl = lua.replace("\"local\"", "\"wsl\"");
    let e = config::load(&with_init("vault-wsl", &wsl)).unwrap_err();
    assert!(
        e.message.contains("vault.kp.database") && e.message.contains("backend = \"local\""),
        "{e}"
    );
    assert_eq!(e.line, Some(3), "{e}");
}

/// Ticket 35: where "Save to vault" puts new Vault items on this Box: "personal", an
/// organization's collection (Bitwarden) or a group (KeePassXC). It wins over roster.yml's.
#[test]
fn save_to_is_personal_a_collection_or_a_group() {
    use config::SaveTo;
    assert_eq!(Config::default().vault.save_to, None);
    let load = |name: &str, lua: &str| config::load(&with_init(name, lua));
    let c = load("save-personal", r#"return { vault = { save_to = "personal" } }"#).unwrap();
    assert_eq!(c.vault.save_to, Some(SaveTo::Personal));
    let c = load(
        "save-coll",
        r#"return { vault = { save_to = { organization = "My Team", collection = "Infra logins" } } }"#,
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(&c.vault.save_to).unwrap(),
        serde_json::json!({ "organization": "My Team", "collection": "Infra logins" })
    );
    let c = load("save-group", r#"return { vault = { save_to = { group = "Hosts" } } }"#).unwrap();
    assert_eq!(
        serde_json::to_value(&c.vault.save_to).unwrap(),
        serde_json::json!({ "group": "Hosts" })
    );
    assert_eq!(
        serde_json::to_value(SaveTo::Personal).unwrap(),
        serde_json::json!("personal")
    );
    for (name, lua) in [
        ("save-shared", "return {\n  vault = { save_to = \"shared\" },\n}\n"),
        (
            "save-half",
            "return {\n  vault = { save_to = { organization = \"My Team\" } },\n}\n",
        ),
        (
            "save-mixed",
            "return {\n  vault = { save_to = { group = \"a\", collection = \"b\" } },\n}\n",
        ),
        ("save-empty", "return {\n  vault = { save_to = { group = \"\" } },\n}\n"),
    ] {
        let e = load(name, lua).unwrap_err();
        assert_eq!(e.line, Some(2), "{e}");
        assert!(e.message.contains("vault.save_to"), "{name}: {e}");
    }
}

/// A renamed option (ticket 48) still applies under its new name, and the Config says so, with
/// its line, so the frontend can warn and link `:help deprecated#…`. The new name wins when the
/// file sets both.
#[test]
fn a_deprecated_option_applies_under_its_new_name_and_is_named() {
    let renamed = [config::Renamed {
        old: "terminal.font_size",
        new: "terminal.size",
    }];
    let dir = temp_dir("deprecated-option");
    let lua = "return {\n  terminal = {\n    font_size = \"15px\",\n  },\n}\n";
    let c = config::load_source_renaming(&dir, lua, &config::Env::default(), &renamed).unwrap();
    assert_eq!(c.terminal.size, config::FontSize::Px(15.0));
    assert_eq!(
        c.deprecated,
        [config::DeprecatedUse {
            old: "terminal.font_size".into(),
            new: "terminal.size".into(),
            topic: "deprecated#terminalfont_size".into(),
        }]
    );
    assert_eq!(c.lines.get("terminal.font_size").map(|l| l.line), Some(3));
    assert!(c.set.contains(&"terminal.size".to_string()));

    let both = "return { terminal = { font_size = \"15px\", size = \"20px\" } }";
    let c = config::load_source_renaming(&dir, both, &config::Env::default(), &renamed).unwrap();
    assert_eq!(c.terminal.size, config::FontSize::Px(20.0));
    assert_eq!(c.deprecated.len(), 1);

    // Without the rename, the old name is just unknown.
    assert!(config::load_source(&dir, lua, &config::Env::default()).is_err());
}

/// Ticket 138: init.lua runs as a block, so a one-line `require` of a module that returns
/// nothing (the Neovim layout: `init.lua` → `lua/<name>/init.lua`) loads, with or without a
/// leading comment.
#[test]
fn a_one_line_require_of_a_module_that_returns_nothing_loads() {
    for (name, init) in [
        ("plain", "require(\"me\")"),
        ("comment", "-- my config\nrequire(\"me\")\n"),
    ] {
        let dir = with_init(&format!("block-{name}"), init);
        std::fs::create_dir_all(dir.join("lua/me")).unwrap();
        std::fs::write(dir.join("lua/me/init.lua"), "roster.set(\"terminal.size\", \"16pt\")\n").unwrap();
        let config = config::load(&dir).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(config.terminal.size, config::FontSize::Pt(16.0), "{name}");
    }
}

/// Ticket 138: `return require(...)` of a module that returns nothing returns `true`; the error
/// says why.
#[test]
fn returning_true_from_require_gets_a_hint() {
    let dir = with_init("block-return", "return require(\"me\")\n");
    std::fs::write(dir.join("me.lua"), "roster.set(\"vim\", false)\n").unwrap();
    let e = config::load(&dir).unwrap_err();
    assert!(e.message.contains("returned true"), "{e}");
    assert!(e.message.contains("leave out the `return`"), "{e}");
}

/// Ticket 138: a bare table with no `return` isn't a Config; it's a syntax error at its line.
#[test]
fn a_bare_table_without_return_is_a_syntax_error_at_its_line() {
    let dir = with_init("block-bare", "-- config\n{ vim = false }\n");
    let e = config::load(&dir).unwrap_err();
    assert_eq!((e.file.as_str(), e.line), ("init.lua", Some(2)), "{e}");
}

/// Ticket 139: among `roster.*` calls the last one wins (a base module, then an override), and
/// the returned table still wins over every call.
#[test]
fn the_last_roster_call_wins() {
    let dir = with_init(
        "last-wins",
        r##"roster.set("terminal.size", "13pt")
roster.keymap.set("leader", "p", "close")
roster.themes.define("mine", { base = "nord", colors = { accent = "#111111" } })
roster.set("terminal.size", "16pt")
roster.keymap.set("leader", "p", "next")
roster.themes.define("mine", { base = "nord", colors = { accent = "#222222" } })
roster.set("vim", false)
roster.set("vim", true)
return { vim = false }
"##,
    );
    let config = config::load(&dir).unwrap();
    assert_eq!(config.terminal.size, config::FontSize::Pt(16.0));
    let p: Vec<_> = config
        .keys
        .0
        .iter()
        .filter(|b| b.context == config::KeyContext::Leader && b.keys == "p")
        .map(|b| b.action.clone())
        .collect();
    assert_eq!(p, [config::KeyAction::Run("next".into())]);
    assert_eq!(config.themes["mine"].colors.accent.as_deref(), Some("#222222"));
    assert!(!config.vim, "the returned table wins over calls");
    // The lines point at the calls that won.
    assert_eq!(config.lines["terminal.size"].line, 4);
    assert_eq!(config.lines["keys.leader.p"].line, 5);
    assert_eq!(config.lines["themes.mine"].line, 6);
}

/// Ticket 139: a base module, then an override module (Neovim's habit): the override wins.
#[test]
fn an_override_module_required_later_wins() {
    let dir = with_init("override", "require(\"base\")\nrequire(\"override\")\n");
    std::fs::write(dir.join("base.lua"), "roster.set(\"terminal.size\", \"13pt\")\n").unwrap();
    std::fs::write(dir.join("override.lua"), "\nroster.set(\"terminal.size\", \"16pt\")\n").unwrap();
    let config = config::load(&dir).unwrap();
    assert_eq!(config.terminal.size, config::FontSize::Pt(16.0));
    assert_eq!(
        (
            config.lines["terminal.size"].file.as_str(),
            config.lines["terminal.size"].line
        ),
        ("override.lua", 2)
    );
}

/// Ticket 140: when the returned table wins over a call, an error in its value points at the
/// table, not at the call whose value was discarded.
#[test]
fn a_bad_table_value_is_not_blamed_on_a_discarded_call() {
    let dir = with_init(
        "line-table-wins",
        "roster.set(\"terminal.size\", \"14pt\")\nreturn {\n  terminal = {\n    size = \"900pt\",\n  },\n}\n",
    );
    let e = config::load(&dir).unwrap_err();
    assert_eq!((e.file.as_str(), e.line), ("init.lua", Some(4)), "{e}");
}

/// Ticket 140: a bad value in a table that a required module returns is reported at the
/// module's line.
#[test]
fn a_bad_value_from_a_required_module_names_the_module_and_line() {
    let dir = with_init("line-module", "-- config\nreturn require(\"opts\")\n");
    std::fs::create_dir_all(dir.join("lua")).unwrap();
    std::fs::write(
        dir.join("lua/opts.lua"),
        "return {\n  vim = false,\n  terminal = {\n    size = \"900pt\",\n  },\n}\n",
    )
    .unwrap();
    let e = config::load(&dir).unwrap_err();
    assert_eq!((e.file.as_str(), e.line), ("lua/opts.lua", Some(4)), "{e}");
    // `:help options` finds the module's lines too.
    let dir = with_init("line-module-ok", "return require(\"opts\")\n");
    std::fs::write(dir.join("opts.lua"), "return {\n  terminal = { size = \"16pt\" },\n}\n").unwrap();
    let config = config::load(&dir).unwrap();
    let at = &config.lines["terminal.size"];
    assert_eq!((at.file.as_str(), at.line), ("opts.lua", 2));
}

/// Ticket 140: when roster can't tell where a value was set, it says so instead of naming the
/// line of a parent key.
#[test]
fn a_value_roster_cannot_place_says_line_unknown() {
    let dir = with_init("line-unknown", "return {\n  terminal = require(\"term\"),\n}\n");
    std::fs::write(
        dir.join("term.lua"),
        "local t = {}\nt[\"si\" .. \"ze\"] = \"900pt\"\nreturn t\n",
    )
    .unwrap();
    let e = config::load(&dir).unwrap_err();
    assert_eq!(e.line, None, "{e}");
    assert!(e.message.contains("line unknown"), "{e}");
    assert!(e.message.starts_with("terminal.size:"), "{e}");
}

/// Ticket 139: a later call replaces what's at its path, a whole table included; a later call
/// below an earlier table changes just that value.
#[test]
fn a_later_call_replaces_what_is_at_its_path() {
    let dir = with_init(
        "last-wins-tables",
        r#"roster.set("terminal.size", "20pt")
roster.set("terminal", { font = "Cascadia Mono" })
roster.set("fonts", { ui = "Inter", ui_size = 16 })
roster.set("fonts.ui_size", 12)
"#,
    );
    let config = config::load(&dir).unwrap();
    assert_eq!(
        config.terminal.size,
        config::FontSize::Pt(13.0),
        "replaced with the table"
    );
    assert_eq!(config.terminal.font, "Cascadia Mono");
    assert_eq!((config.fonts.ui.as_str(), config.fonts.ui_size), ("Inter", 12));
    assert_eq!(config.lines["fonts.ui_size"].line, 4);
}
