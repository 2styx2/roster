//! init.lua's Neovim-style API (decision Q132, ticket 142): `roster.o`, a checked option tree
//! that reads back, with each kind's methods; the named collections `roster.packages`,
//! `roster.folders`, `roster.keymap` and `roster.themes`; one store with `roster.set`, where the
//! last write wins and the returned table wins over every call. Driven through the public loader.

mod common;

use roster_core::config::{self, Config, ConfigError, Env, FontSize, KeyAction, KeyContext};

fn dir_with(files: &[(&str, &str)]) -> common::Temp {
    let dir = common::temp("config-api");
    for (name, text) in files {
        let path = dir.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
    dir
}

fn load(lua: &str) -> Result<Config, ConfigError> {
    let dir = dir_with(&[("init.lua", lua)]);
    config::load(&dir)
}

fn ok(lua: &str) -> Config {
    load(lua).unwrap_or_else(|e| panic!("{e}\n---\n{lua}"))
}

fn err(lua: &str) -> ConfigError {
    match load(lua) {
        Ok(_) => panic!("loaded, but should fail:\n{lua}"),
        Err(e) => e,
    }
}

/// What the file returns in `theme` (a string option the tests use to see a Lua value).
fn says(lua: &str) -> String {
    ok(lua).theme
}

fn line_of(c: &Config, path: &str) -> (String, u32) {
    let at = c
        .lines
        .get(path)
        .unwrap_or_else(|| panic!("no line for {path}: {:?}", c.lines));
    (at.file.clone(), at.line)
}

fn binding(c: &Config, context: KeyContext, keys: &str) -> Option<KeyAction> {
    c.keys
        .0
        .iter()
        .rfind(|b| b.context == context && b.keys == keys)
        .map(|b| b.action.clone())
}

// ---------------------------------------------------------------- roster.o: assignment

#[test]
fn assigning_an_option_sets_it() {
    let c = ok("roster.o.terminal.size = \"16pt\"\nroster.o.vim = false\n");
    assert_eq!(c.terminal.size, FontSize::Pt(16.0));
    assert!(!c.vim);
}

#[test]
fn nested_objects_need_no_setup() {
    let c = ok(
        "roster.o.modes.focus.sidebar.side = \"right\"\nroster.o.themes.paper.colors.accent = \"#b85c00\"\nroster.o.vault.kp.database = \"~/x.kdbx\"\n",
    );
    assert_eq!(c.themes["paper"].colors.accent.as_deref(), Some("#b85c00"));
    assert_eq!(c.vault.kp.database.as_deref(), Some("~/x.kdbx"));
}

#[test]
fn a_misspelled_name_errors_at_its_line_with_the_name_meant_at_every_depth() {
    for (lua, meant) in [
        ("roster.o.thmee = \"nord\"", "theme"),
        ("roster.o.terminal.szie = \"16pt\"", "terminal.size"),
        ("roster.o.modes.focus.sidebr = false", "modes.focus.sidebar"),
        (
            "roster.o.modes.focus.sidebar.sid = \"left\"",
            "modes.focus.sidebar.side",
        ),
        (
            "roster.o.themes.paper.colors.acent = \"#fff\"",
            "themes.paper.colors.accent",
        ),
        ("roster.o.vault.kp.databse = \"~/x\"", "vault.kp.database"),
    ] {
        let e = err(&format!("-- one\n{lua}\nroster.o.vim = false\n"));
        assert_eq!((e.file.as_str(), e.line), ("init.lua", Some(2)), "{lua}: {e}");
        assert!(e.message.contains("isn't an option"), "{lua}: {e}");
        assert!(e.message.contains(&format!("did you mean {meant}?")), "{lua}: {e}");
    }
    // Nothing close: no guess.
    let e = err("roster.o.terminal.completely_else = 1\n");
    assert!(!e.message.contains("did you mean"), "{e}");
}

#[test]
fn a_misspelled_name_in_a_module_names_the_module_and_line() {
    let dir = dir_with(&[
        ("init.lua", "require(\"opts\")\n"),
        ("lua/opts.lua", "local o = roster.o\n\no.terminal.szie = \"16pt\"\n"),
    ]);
    let e = config::load(&dir).unwrap_err();
    assert_eq!((e.file.as_str(), e.line), ("lua/opts.lua", Some(3)), "{e}");
}

#[test]
fn reading_an_unknown_name_is_an_error_too() {
    let e = err("local x = roster.o.terminal.szie\n");
    assert!(e.message.contains("did you mean terminal.size?"), "{e}");
    assert_eq!(e.line, Some(1));
}

#[test]
fn a_whole_table_is_checked_and_replaces_that_branch() {
    let e = err("roster.o.terminal = {\n  size = \"16pt\",\n  szie = 1,\n}\n");
    assert!(e.message.contains("terminal.szie isn't an option"), "{e}");
    assert!(e.message.contains("did you mean terminal.size?"), "{e}");
    assert_eq!(e.line, Some(3), "the line with the name");
    let e = err("roster.o.themes = { paper = { colors = { acent = \"#fff\" } } }\n");
    assert!(e.message.contains("themes.paper.colors.acent"), "{e}");
    // Replaces: the earlier size goes back to its default.
    let c = ok("roster.o.terminal.size = \"20pt\"\nroster.o.terminal = { scrollback = 5 }\n");
    assert_eq!(c.terminal.size, FontSize::Pt(13.0));
    assert_eq!(c.terminal.scrollback, 5);
}

#[test]
fn a_bad_value_errors_at_the_assignments_line_in_any_module() {
    let e = err("roster.o.vim = false\nroster.o.terminal.renderer = \"canvas\"\nroster.o.vim = true\n");
    assert_eq!((e.file.as_str(), e.line), ("init.lua", Some(2)), "{e}");
    assert!(e.message.starts_with("terminal.renderer:"), "{e}");
    // A range, checked once everything has run, still names the assignment.
    let dir = dir_with(&[
        ("init.lua", "require(\"term\")\n"),
        ("lua/term.lua", "\n\nroster.o.terminal.size = \"900pt\"\n"),
    ]);
    let e = config::load(&dir).unwrap_err();
    assert_eq!((e.file.as_str(), e.line), ("lua/term.lua", Some(3)), "{e}");
    // A type: the line of the assignment.
    let e = err("\nroster.o.fonts.ui_size = \"big\"\n");
    assert_eq!(e.line, Some(2), "{e}");
}

#[test]
fn a_value_inside_a_table_gets_the_assignments_line() {
    let c = ok(
        "roster.o.fonts = {\n  ui = \"Inter\",\n  ui_size = 16,\n}\nroster.set(\"terminal\", { size = \"14pt\" })\n",
    );
    assert_eq!(line_of(&c, "fonts.ui"), ("init.lua".into(), 1));
    assert_eq!(line_of(&c, "terminal.size"), ("init.lua".into(), 5));
}

#[test]
fn a_modules_table_assigned_to_an_option_gets_the_assignments_line() {
    let dir = dir_with(&[
        ("init.lua", "\nroster.o.terminal = require(\"term\")\n"),
        ("term.lua", "local t = {}\nt[\"si\" .. \"ze\"] = \"16pt\"\nreturn t\n"),
    ]);
    let c = config::load(&dir).unwrap();
    assert_eq!(line_of(&c, "terminal.size"), ("init.lua".into(), 2));
}

// ---------------------------------------------------------------- roster.o: reads

#[test]
fn reading_gives_the_value_set_so_far_or_nil() {
    assert_eq!(
        says("roster.o.terminal.size = \"16pt\"\nreturn { theme = tostring(roster.o.terminal.size) }"),
        "16pt"
    );
    assert_eq!(says("return { theme = tostring(roster.o.terminal.size) }"), "nil");
    assert_eq!(
        says("roster.o.vim = false\nif roster.o.vim then return { theme = \"on\" } end\nreturn { theme = \"off\" }"),
        "off"
    );
    // roster.set writes to the same store.
    assert_eq!(
        says("roster.set(\"terminal.size\", 14)\nreturn { theme = tostring(roster.o.terminal.size) }"),
        "14"
    );
}

#[test]
fn reads_are_copies() {
    let c = ok(r#"
roster.o.terminal.font = { "Iosevka" }
local f = roster.o.terminal.font:get()
f[1] = "Comic Sans"
roster.o.fonts = { ui = "Inter" }
local fonts = roster.o.fonts:get()
fonts.ui = "Other"
return { theme = roster.o.terminal.font:get()[1] .. "," .. roster.o.fonts.ui }
"#);
    assert_eq!(c.theme, "Iosevka,Inter");
    assert_eq!(c.terminal.font.0, ["Iosevka"]);
}

#[test]
fn get_on_something_unset_is_nil() {
    assert_eq!(
        says(
            "return { theme = tostring(roster.o.terminal:get()) .. tostring(roster.o.views:get()) .. tostring(roster.o.terminal.font:get()) }"
        ),
        "nilnilnil"
    );
}

// ---------------------------------------------------------------- roster.o: methods per kind

#[test]
fn reset_puts_an_option_back_to_its_default() {
    let c = ok(
        "roster.o.terminal.size = \"20pt\"\nroster.o.reset(\"terminal.size\")\nroster.o.vim = false\nroster.o.reset(\"vim\")\n",
    );
    assert_eq!(c.terminal.size, FontSize::Pt(13.0));
    assert!(c.vim);
    assert!(!c.lines.contains_key("terminal.size"));
    let e = err("roster.o.reset(\"terminal.szie\")\n");
    assert!(e.message.contains("did you mean terminal.size?"), "{e}");
    let c = ok("roster.o.terminal.size = \"20pt\"\nroster.o.terminal.scrollback = 5\nroster.o.terminal:reset()\n");
    assert_eq!((c.terminal.size, c.terminal.scrollback), (FontSize::Pt(13.0), 10000));
}

#[test]
fn a_map_sets_reads_removes_and_lists_its_keys() {
    let c = ok(r#"
local v = roster.o.views
v.topology = { place = "panel", width = 60 }
v["help"] = { place = "full" }
v.details = { width = 30 }
v.details = nil
local keys = v:keys()
table.sort(keys)
return { theme = table.concat(keys, ",") .. ";" .. tostring(v:has("help")) .. tostring(v:has("details")) .. ";" .. v.topology.place }
"#);
    assert_eq!(c.theme, "help,topology;truefalse;panel");
    assert!(c.views.contains_key("topology") && !c.views.contains_key("details"));
    let c = ok("roster.o.views.topology = { width = 60 }\nroster.o.views:reset()\n");
    assert!(c.views.is_empty());
    let c = ok("roster.o.colors.accent = \"#ff0000\"\nroster.o.colors.accent = nil\n");
    assert_eq!(c.colors.accent, None);
}

#[test]
fn a_key_map_leaf_reads_back_as_a_value() {
    let c = ok(r#"
roster.o.keys.leader.p = "connect esx-02"
roster.o.keys.leader["d d"] = false
return { theme = roster.o.keys.leader.p .. tostring(roster.o.keys.leader["d d"]) .. tostring(roster.o.keys.leader.zz) }
"#);
    assert_eq!(c.theme, "connect esx-02falsenil");
    assert_eq!(
        binding(&c, KeyContext::Leader, "p"),
        Some(KeyAction::Run("connect esx-02".into()))
    );
}

#[test]
fn a_list_appends_prepends_inserts_removes_and_clears() {
    let c = ok(r#"
local f = roster.o.terminal.font
f:prepend("Cascadia Mono")
f:append("Fira Code", "Hack")
f:insert(2, "JetBrains Mono")
f:remove("Iosevka Term")
return { theme = tostring(f:has("Hack")) .. tostring(f:has("Iosevka Term")) }
"#);
    assert_eq!(c.theme, "truefalse");
    assert_eq!(
        c.terminal.font.0,
        [
            "Cascadia Mono",
            "JetBrains Mono",
            "Iosevka Nerd Font",
            "Iosevka",
            "Fira Code",
            "Hack"
        ]
    );
    let c = ok("roster.o.terminal.font:clear()\nroster.o.terminal.font:append(\"Hack\")\n");
    assert_eq!(c.terminal.font.0, ["Hack"]);
    let c = ok("roster.o.terminal.font = { \"Hack\" }\nroster.o.terminal.font:reset()\n");
    assert_eq!(c.terminal.font.0, ["Iosevka Nerd Font", "Iosevka Term", "Iosevka"]);
}

#[test]
fn list_method_errors_are_at_their_line() {
    // A set-like list takes each item once.
    let e = err("\nroster.o.terminal.font:append(\"Iosevka\")\n");
    assert_eq!(e.line, Some(2), "{e}");
    assert!(e.message.contains("already"), "{e}");
    let e = err("roster.o.modes.standard.sidebar.sections = { \"sessions\", \"sessions\" }\n");
    assert!(e.message.contains("already"), "{e}");
    // Removing what isn't there.
    let e = err("roster.o.terminal.font:remove(\"Comic Sans\")\n");
    assert!(e.message.contains("Comic Sans"), "{e}");
    // A list that isn't one yet (true: all the segments).
    let e = err("roster.o.modes.standard.statusbar:append(\"hosts\")\n");
    assert!(e.message.contains("assign a list first"), "{e}");
    let c = ok(
        "roster.o.modes.standard.statusbar = { \"backend\" }\nroster.o.modes.standard.statusbar:append(\"hosts\")\n",
    );
    assert!(c.modes.standard.statusbar.segments.as_deref() == Some(&["backend".to_string(), "hosts".to_string()][..]));
    // insert's index.
    let e = err("roster.o.terminal.font:insert(9, \"Hack\")\n");
    assert!(e.message.contains("insert"), "{e}");
    // A list that isn't set-like takes repeats.
    ok("roster.o.roster_command = { \"roster\" }\n");
}

#[test]
fn an_unknown_method_is_an_error() {
    let e = err("roster.o.terminal.font:push(\"x\")\n");
    assert!(e.message.contains("push"), "{e}");
    let e = err("roster.o.views:append(\"x\")\n");
    assert!(e.message.contains("append"), "{e}");
}

// ---------------------------------------------------------------- one store

#[test]
fn roster_o_and_roster_set_share_one_store_and_the_last_write_wins() {
    let c = ok("roster.o.terminal.size = \"20pt\"\nroster.set(\"terminal.size\", \"14pt\")\n");
    assert_eq!(c.terminal.size, FontSize::Pt(14.0));
    let c = ok("roster.set(\"terminal.size\", \"14pt\")\nroster.o.terminal.size = \"15pt\"\n");
    assert_eq!(c.terminal.size, FontSize::Pt(15.0));
    assert_eq!(line_of(&c, "terminal.size"), ("init.lua".into(), 2));
}

#[test]
fn the_returned_table_still_wins_over_roster_o() {
    let c = ok("roster.o.vim = false\nroster.o.terminal.size = \"20pt\"\nreturn { vim = true }\n");
    assert!(c.vim);
    assert_eq!(c.terminal.size, FontSize::Pt(20.0));
}

#[test]
fn roster_set_checks_names_at_its_line_too() {
    let e = err("\nroster.set(\"terminal.szie\", 1)\n");
    assert_eq!(e.line, Some(2));
    assert!(e.message.contains("did you mean terminal.size?"), "{e}");
}

// ---------------------------------------------------------------- read-only fields

#[test]
fn version_and_config_dir_are_read_only_fields() {
    let dir = dir_with(&[(
        "init.lua",
        "return { theme = roster.version .. \"|\" .. roster.config_dir }\n",
    )]);
    let c = config::load(&dir).unwrap();
    let (version, at) = c.theme.split_once('|').unwrap();
    assert_eq!(version, env!("CARGO_PKG_VERSION"));
    assert_eq!(
        std::path::Path::new(at),
        dir.canonicalize().unwrap_or(dir.to_path_buf())
    );
    let e = err("roster.version = \"9\"\n");
    assert!(e.message.contains("read-only"), "{e}");
    let e = err("roster.o = {}\n");
    assert!(e.message.contains("read-only"), "{e}");
}

// ---------------------------------------------------------------- roster.packages

#[test]
fn packages_are_added_from_any_file_and_read_back() {
    let dir = dir_with(&[
        (
            "init.lua",
            "roster.packages.add({ \"someone/recent-alerts\", tag = \"v1.2.0\" })\nrequire(\"more\")\n",
        ),
        (
            "lua/more.lua",
            "roster.packages.add(\"someone/pinned\", { \"https://example.com/x/tools.git\", dir = \"plugins/net\" })\n",
        ),
    ]);
    let c = config::load(&dir).unwrap();
    let names: Vec<_> = c.packages.iter().map(|p| p.source.as_str()).collect();
    assert_eq!(
        names,
        [
            "someone/recent-alerts",
            "someone/pinned",
            "https://example.com/x/tools.git"
        ]
    );
    let c = ok(r#"
roster.packages.add({ "someone/recent-alerts", tag = "v1.2.0" })
local p = roster.packages.get("recent-alerts")
p.tag = "v9"
local names = {}
for _, s in ipairs(roster.packages.list()) do names[#names + 1] = s.source end
return { theme = roster.packages.get("recent-alerts").tag .. "," .. table.concat(names, ",") .. "," .. tostring(roster.packages.has("recent-alerts")) .. tostring(roster.packages.has("nope")) .. tostring(roster.packages.get("nope")) }
"#);
    assert_eq!(c.theme, "v1.2.0,someone/recent-alerts,truefalsenil");
}

#[test]
fn a_duplicate_package_names_both_lines() {
    let dir = dir_with(&[
        (
            "init.lua",
            "roster.packages.add(\"someone/alerts\")\nrequire(\"more\")\n",
        ),
        ("lua/more.lua", "\nroster.packages.add({ \"other/alerts\" })\n"),
    ]);
    let e = config::load(&dir).unwrap_err();
    assert_eq!((e.file.as_str(), e.line), ("lua/more.lua", Some(2)), "{e}");
    assert!(e.message.contains("init.lua:1"), "{e}");
}

#[test]
fn packages_update_and_remove() {
    let c = ok(r#"
roster.packages.add({ "someone/alerts", branch = "main" }, "someone/pinned")
roster.packages.update("alerts", { tag = "v2", config = { level = 3 } })
roster.packages.remove("pinned")
"#);
    assert_eq!(c.packages.len(), 1);
    let p = &c.packages[0];
    assert_eq!(
        (p.tag.as_deref(), p.branch.as_deref()),
        (Some("v2"), None),
        "a pin replaces the other pins"
    );
    assert_eq!(p.config["level"], 3);
    for (lua, word) in [
        ("roster.packages.remove(\"nope\")", "nope"),
        ("roster.packages.update(\"nope\", { tag = \"v1\" })", "nope"),
        ("roster.packages.update(\"alerts\", { tga = \"v1\" })", "tga"),
        ("roster.packages.add({ tag = \"v1\" })", "source"),
        (
            "roster.packages.add({ \"someone/x\", config = function() end })",
            "function",
        ),
    ] {
        let e = err(&format!("roster.packages.add(\"someone/alerts\")\n{lua}\n"));
        assert_eq!(e.line, Some(2), "{lua}: {e}");
        assert!(e.message.contains(word), "{lua}: {e}");
    }
}

// ---------------------------------------------------------------- roster.folders

#[test]
fn folders_add_update_hosts_and_remove() {
    let c = ok(r#"
roster.folders.add({ name = "Lab", hosts = { "esx-02" } }, { name = "Edge" })
roster.folders.add_hosts("Lab", { "esx-03", "esx-04" })
roster.folders.remove_hosts("lab", "esx-04")
roster.folders.update("Edge", { name = "Edge boxes", hosts = { "fw-01" } })
roster.folders.add({ name = "Gone" })
roster.folders.remove("Gone")
local l = roster.folders.get("Lab")
table.insert(l.hosts, "changed-copy")
local names = {}
for _, f in ipairs(roster.folders.list()) do names[#names + 1] = f.name end
return { theme = table.concat(names, ",") .. ";" .. #roster.folders.get("Lab").hosts .. tostring(roster.folders.has("edge boxes")) .. tostring(roster.folders.has("Gone")) }
"#);
    assert_eq!(c.theme, "Lab,Edge boxes;2truefalse");
    assert_eq!(c.folders[0].hosts, ["esx-02", "esx-03"]);
    assert_eq!(c.folders[1].hosts, ["fw-01"]);
    assert_eq!(line_of(&c, "folders.Lab"), ("init.lua".into(), 2));
}

#[test]
fn folder_errors_are_at_their_line() {
    for (lua, word) in [
        ("roster.folders.add({ name = \"lab\" })", "init.lua:1"),
        ("roster.folders.add({ hosts = {} })", "name"),
        ("roster.folders.add({ name = \"X\", hots = {} })", "hots"),
        ("roster.folders.remove(\"Nope\")", "Nope"),
        ("roster.folders.update(\"Nope\", {})", "Nope"),
        ("roster.folders.update(\"Lab\", { name = \"Edge\" })", "init.lua:1"),
        ("roster.folders.add_hosts(\"Lab\", \"esx-02\")", "already"),
        ("roster.folders.remove_hosts(\"Lab\", \"esx-09\")", "esx-09"),
        ("roster.folders.add_hosts(\"Nope\", \"esx-02\")", "Nope"),
    ] {
        let e = err(&format!(
            "roster.folders.add({{ name = \"Lab\", hosts = {{ \"esx-02\" }} }}, {{ name = \"Edge\" }})\n{lua}\n"
        ));
        assert_eq!(e.line, Some(2), "{lua}: {e}");
        assert!(e.message.contains(word), "{lua}: {e}");
    }
}

#[test]
fn folders_assigned_whole_still_count_for_duplicates() {
    let e = err("roster.o.folders = { { name = \"Lab\" } }\nroster.folders.add({ name = \"Lab\" })\n");
    assert_eq!(e.line, Some(2));
    assert!(e.message.contains("init.lua:1"), "{e}");
}

// ---------------------------------------------------------------- roster.keymap

#[test]
fn keymap_sets_gets_lists_and_deletes() {
    let c = ok(r#"
roster.keymap.set("leader", "p", "connect esx-02")
roster.keymap.set("leader", "q", "close")
roster.keymap.set("leader", "p", "next")
roster.keymap.del("leader", "q")
local l = roster.keymap.list("leader")
l.p = "changed copy"
return { theme = roster.keymap.get("leader", "p") .. "," .. tostring(roster.keymap.get("leader", "q")) .. "," .. roster.keymap.list("leader").p }
"#);
    assert_eq!(c.theme, "next,nil,next");
    assert_eq!(
        binding(&c, KeyContext::Leader, "p"),
        Some(KeyAction::Run("next".into()))
    );
    assert_eq!(line_of(&c, "keys.leader.p"), ("init.lua".into(), 4));
    for (lua, word) in [
        ("roster.keymap.del(\"leader\", \"zz\")", "zz"),
        ("roster.keymap.set(\"leadr\", \"p\", \"close\")", "did you mean"),
        ("roster.keymap.get(\"leadr\", \"p\")", "did you mean"),
        ("roster.keymap.list(\"nowhere\")", "nowhere"),
    ] {
        let e = err(&format!("roster.keymap.set(\"leader\", \"p\", \"close\")\n{lua}\n"));
        assert_eq!(e.line, Some(2), "{lua}: {e}");
        assert!(e.message.contains(word), "{lua}: {e}");
    }
}

// ---------------------------------------------------------------- roster.themes

#[test]
fn themes_define_update_get_list_and_remove() {
    let c = ok(r##"
roster.themes.define("paper", { appearance = "light", colors = { accent = "#b85c00" } })
roster.themes.update("paper", { colors = { bg = "#fbfaf7" } })
roster.themes.update("nord", { colors = { accent = "#88c0d0" } })
roster.themes.define("gone", { colors = {} })
roster.themes.remove("gone")
local p = roster.themes.get("paper")
p.label = "copy"
local ids = roster.themes.list()
return { theme = table.concat(ids, ",") .. ";" .. tostring(roster.themes.get("paper").label) .. ";" .. tostring(roster.themes.get("gone")) }
"##);
    assert_eq!(
        c.theme,
        "roster-dark,roster-light,gruvbox,nord,catppuccin-mocha,tokyo-night,paper;nil;nil"
    );
    let paper = &c.themes["paper"];
    assert_eq!(paper.colors.accent.as_deref(), Some("#b85c00"));
    assert_eq!(paper.colors.bg.as_deref(), Some("#fbfaf7"));
    let nord = &c.themes["nord"];
    assert_eq!(
        nord.base.as_deref(),
        Some("nord"),
        "a bundled Theme's update starts from it"
    );
    assert!(!c.themes.contains_key("gone"));
}

#[test]
fn theme_errors_are_at_their_line() {
    for (lua, word) in [
        ("roster.themes.define(\"paper\", {})", "init.lua:1"),
        ("roster.themes.define(\"nord\", {})", "bundled"),
        ("roster.themes.remove(\"nord\")", "bundled"),
        ("roster.themes.remove(\"nope\")", "nope"),
        ("roster.themes.update(\"nope\", {})", "nope"),
        (
            "roster.themes.define(\"x\", { colors = { acent = \"#fff\" } })",
            "acent",
        ),
        ("roster.themes.define(\"auto\", {})", "auto"),
    ] {
        let e = err(&format!(
            "roster.themes.define(\"paper\", {{ colors = {{}} }})\n{lua}\n"
        ));
        assert_eq!(e.line, Some(2), "{lua}: {e}");
        assert!(e.message.contains(word), "{lua}: {e}");
    }
}

// ---------------------------------------------------------------- the budget

#[test]
fn a_big_neovim_style_config_loads_within_the_budget() {
    let mut lua = String::new();
    for i in 0..300 {
        lua.push_str(&format!("roster.o.views[\"v{i}\"] = {{ width = 40 }}\n"));
        lua.push_str(&format!("roster.keymap.set(\"leader\", \"x{i}\", \"close\")\n"));
        lua.push_str(&format!("roster.o.terminal.size = {}\n", 10 + i % 20));
    }
    for i in 0..100 {
        lua.push_str(&format!(
            "roster.folders.add({{ name = \"F{i}\", hosts = {{ \"h{i}\" }} }})\n"
        ));
        lua.push_str(&format!("roster.packages.add(\"someone/p{i}\")\n"));
    }
    let start = std::time::Instant::now();
    let c = config::load_source(&common::temp("config-api-budget"), &lua, &Env::default())
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(c.folders.len(), 100);
    assert!(
        start.elapsed() < std::time::Duration::from_millis(1000),
        "{:?}",
        start.elapsed()
    );
}

// ---------------------------------------------------------------- review of #253

#[test]
fn a_package_list_finds_an_item_by_its_name_or_source() {
    let c = ok(r#"
roster.packages.add("someone/alerts", { "someone/pinned", tag = "v1" })
local p = roster.o.packages
local found = tostring(p:has("alerts")) .. tostring(p:has("someone/pinned")) .. tostring(p:has("nope"))
p:remove("alerts")
p:remove("someone/pinned")
return { theme = found }
"#);
    assert_eq!(c.theme, "truetruefalse");
    assert!(c.packages.is_empty());
}

#[test]
fn a_write_keeps_its_own_line_after_an_earlier_one_of_the_same_name() {
    let c = ok(r#"roster.o.terminal = {
  size = "14pt",
}
for k, v in pairs({ scrollback = 5 }) do
  roster.o.terminal[k] = v
end
roster.o.vim = true
local key = "vim"
roster.o[key] = false
"#);
    assert_eq!(line_of(&c, "terminal.scrollback"), ("init.lua".into(), 5));
    assert_eq!(line_of(&c, "terminal.size"), ("init.lua".into(), 1));
    assert_eq!(line_of(&c, "vim"), ("init.lua".into(), 9));
}

#[test]
fn copying_an_unset_table_copies_its_default_or_says_there_is_nothing() {
    let c = ok("roster.o.terminal.font = { \"Hack\" }\nroster.o.terminal.font = roster.o.terminal.font\n");
    assert_eq!(c.terminal.font.0, ["Hack"]);
    let c = ok("roster.o.terminal.size = \"16pt\"\nroster.o.terminal.font = roster.o.terminal.font\n");
    assert_eq!(c.terminal.font.0, ["Iosevka Nerd Font", "Iosevka Term", "Iosevka"]);
    assert_eq!(c.terminal.size, FontSize::Pt(16.0), "nothing else is wiped");
    let e = err(
        "roster.o.modes.focus.sidebar.sections = { \"sessions\" }\nroster.o.modes.focus.sidebar.sections = roster.o.modes.standard.sidebar.sections\n",
    );
    assert_eq!(e.line, Some(2), "{e}");
    assert!(e.message.contains("unset"), "{e}");
}

#[test]
fn a_list_inside_a_written_value_takes_each_item_once_too() {
    for lua in [
        "roster.folders.add({ name = \"Lab\", hosts = { \"esx-02\", \"esx-02\" } })",
        "roster.o.terminal = { font = { \"Hack\", \"Hack\" } }",
        "roster.folders.add({ name = \"Lab\" })\nroster.folders.update(\"Lab\", { hosts = { \"a\", \"a\" } })",
        "roster.o.folders = { { name = \"Lab\", hosts = { \"a\", \"a\" } } }",
    ] {
        let e = err(lua);
        assert!(e.message.contains("already"), "{lua}: {e}");
    }
}

#[test]
fn a_second_define_says_to_use_update() {
    let e = err("roster.themes.define(\"mine\", {})\nroster.themes.define(\"mine\", {})\n");
    assert!(e.message.contains("roster.themes.update(\"mine\""), "{e}");
}

#[test]
fn a_duplicate_names_the_latest_line_that_touched_it() {
    let e = err(
        "roster.themes.define(\"mine\", {})\nroster.o.themes.mine.label = \"Mine\"\nroster.themes.define(\"mine\", {})\n",
    );
    assert!(e.message.contains("init.lua:2"), "{e}");
}

#[test]
fn a_map_key_named_like_a_method_reads_as_the_key_once_set() {
    let c = ok(r#"
roster.o.themes.keys = { label = "Keys" }
roster.o.views.reset = { width = 30 }
local ids = roster.o.views:get()
return { theme = roster.o.themes.keys.label .. "," .. roster.o.views.reset.width .. "," .. tostring(ids.reset.width) }
"#);
    assert_eq!(c.theme, "Keys,30,30");
    assert_eq!(c.views["reset"].width, Some(30));
    // The methods are still there for a key that isn't set, and roster.o.reset always is.
    let c = ok(
        "roster.o.views.x = { width = 30 }\nlocal n = #roster.o.views:keys()\nroster.o.reset(\"views\")\nreturn { theme = tostring(n) }\n",
    );
    assert_eq!(c.theme, "1");
    assert!(c.views.is_empty());
}

/// `roster.o.get(name)` reads any option by its dotted name, so a map whose keys are named like
/// its methods still has a read that always works (ticket 144).
#[test]
fn roster_o_get_reads_any_option_even_a_map_with_method_named_keys() {
    let lua = r#"
roster.o.views.get = { width = 30 }
roster.o.views.keys = { width = 40 }
roster.o.terminal.size = "16pt"
local views = roster.o.get("views")
local n = 0
for _ in pairs(views) do n = n + 1 end
return { theme = table.concat({
  n,
  roster.o.get("views.get").width,
  roster.o.get("views.keys").width,
  roster.o.get("terminal.size"),
  roster.o.get("terminal").size,
  tostring(roster.o.get("terminal.scrollback")),
  tostring(roster.o.get("themes.nothing")),
}, ",") }
"#;
    assert_eq!(says(lua), "2,30,40,16pt,16pt,nil,nil");
    // A copy: changing it changes nothing.
    let c = ok("roster.o.views.get = { width = 30 }\nroster.o.get(\"views\").get.width = 99\n");
    assert_eq!(c.views["get"].width, Some(30));
    // A bad name is an error at its line, as reset's is.
    let e = err("\nroster.o.get(\"terminal.szie\")\n");
    assert_eq!(e.line, Some(2), "{e}");
    assert!(e.message.contains("did you mean terminal.size?"), "{e}");
    let e = err("roster.o.get(42)\n");
    assert!(e.message.contains("roster.o.get(\"terminal.size\")"), "{e}");
    // It's a function, not an option.
    let e = err("roster.o.get = 1\n");
    assert!(e.message.contains("roster.o.get is a function"), "{e}");
    // The root's own :get() still gives everything set.
    assert_eq!(says("roster.o.vim = false\nreturn { theme = tostring(roster.o:get().vim) }\n"), "false");
}

#[test]
fn updates_normalise_and_check_as_adds_do() {
    let c = ok(
        "roster.packages.add(\"someone/alerts\")\nroster.packages.update(\"alerts\", { \"someone/alerts\", tag = \"v2\" })\n",
    );
    assert_eq!(c.packages[0].tag.as_deref(), Some("v2"));
    let e = err(
        "roster.packages.add(\"someone/alerts\")\nroster.packages.update(\"alerts\", { config = function() end })\n",
    );
    assert_eq!(e.line, Some(2), "{e}");
    assert!(e.message.contains("roster.plugin.config"), "{e}");
    let e = err("roster.folders.add({ name = \"Lab\" })\nroster.folders.update(\"Lab\", { hots = {} })\n");
    assert!(e.message.contains("hots"), "{e}");
}

#[test]
fn five_thousand_writes_stay_well_within_the_budget() {
    let mut lua = String::new();
    for i in 0..10 {
        lua.push_str(&format!("roster.folders.add({{ name = \"F{i}\" }})\n"));
    }
    for i in 0..2000 {
        if i % 4 == 0 {
            lua.push_str(&format!("roster.o.views[\"v{i}\"] = {{ width = 40 }}\n"));
        } else {
            lua.push_str(&format!("roster.o.terminal.scrollback = {i}\n"));
        }
        lua.push_str(&format!("roster.keymap.set(\"leader\", \"k{i}\", \"close\")\n"));
    }
    for i in 0..1000 {
        lua.push_str(&format!("roster.folders.add_hosts(\"F{}\", \"h{i}\")\n", i % 10));
    }
    let start = std::time::Instant::now();
    let c =
        config::load_source(&common::temp("config-api-5000"), &lua, &Env::default()).unwrap_or_else(|e| panic!("{e}"));
    let took = start.elapsed();
    assert_eq!(c.folders[3].hosts.len(), 100);
    assert!(took < std::time::Duration::from_millis(600), "{took:?}");
}

#[test]
fn a_failing_add_hosts_leaves_the_folder_as_it_was() {
    let c = ok(r#"
roster.folders.add({ name = "Lab" })
local ok1 = pcall(roster.folders.add_hosts, "Lab", { "a", "a" })
local ok2 = pcall(roster.folders.remove_hosts, "Lab", "nope")
return { theme = tostring(ok1) .. tostring(ok2) .. tostring(roster.folders.get("Lab").hosts) }
"#);
    assert_eq!(c.theme, "falsefalsenil");
}

#[test]
fn names_match_with_spaces_and_letter_case_aside() {
    let c = ok(r#"
roster.folders.add({ name = "  Lab  " })
roster.packages.add({ "someone/alerts", name = "Alerts" })
local found = tostring(roster.folders.has(" LAB")) .. tostring(roster.packages.has(" alerts ")) .. tostring(roster.o.packages:has("ALERTS"))
roster.folders.update(" lab", { hosts = { "a" } })
roster.packages.remove(" ALERTS ")
return { theme = found }
"#);
    assert_eq!(c.theme, "truetruetrue");
    assert!(c.packages.is_empty());
    let e = err("roster.folders.add({ name = \"Lab\" })\nroster.folders.add({ name = \" lab \" })\n");
    assert!(e.message.contains("init.lua:1"), "{e}");
}
