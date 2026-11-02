//! Ticket 33 (decision Q55): the terminal looks like the user's Windows Terminal. The Config's
//! terminal options (a font list, sizes in points, the renderer, the cursor, a cell height)
//! and `roster.set`, which `:config import-terminal` writes.

mod common;

use roster_core::config::{self, Config, CursorStyle, FontSize, Renderer};

fn with_init(name: &str, lua: &str) -> common::Temp {
    let dir = common::temp(&format!("terminal-{name}"));
    std::fs::write(dir.join("init.lua"), lua).unwrap();
    dir
}

fn load(name: &str, lua: &str) -> Result<Config, config::ConfigError> {
    config::load(&with_init(name, lua))
}

#[test]
fn the_default_font_list_tries_the_installed_iosevkas_before_the_bundled_one() {
    let t = Config::default().terminal;
    assert_eq!(t.font.0, ["Iosevka Nerd Font", "Iosevka Term", "Iosevka"]);
    // A step above Windows Terminal's default 12 pt (decision Q61).
    assert_eq!(t.size, FontSize::Pt(13.0));
    assert!((t.size.px() - 17.333).abs() < 0.001);
    assert_eq!(t.renderer, Renderer::Webgl);
    assert_eq!(t.cursor_style, CursorStyle::Block);
    assert!(t.bold_is_bright);
}

#[test]
fn a_font_is_a_name_a_css_stack_or_a_list() {
    let font = |lua: &str, name: &str| {
        load(name, &format!("return {{ terminal = {{ font = {lua} }} }}"))
            .unwrap()
            .terminal
            .font
            .0
    };
    assert_eq!(font(r#""Cascadia Mono""#, "one"), ["Cascadia Mono"]);
    assert_eq!(font(r#"'"Fira Code", Consolas'"#, "stack"), ["Fira Code", "Consolas"]);
    assert_eq!(
        font(r#"{ "Iosevka Nerd Font", "Iosevka" }"#, "list"),
        ["Iosevka Nerd Font", "Iosevka"]
    );
    let e = load("empty-list", "return { terminal = { font = {} } }").unwrap_err();
    assert!(e.message.starts_with("terminal.font"), "{e}");
}

#[test]
fn a_size_is_px_as_a_number_or_points_or_px_as_text() {
    let size = |lua: &str, name: &str| {
        load(name, &format!("return {{ terminal = {{ size = {lua} }} }}"))
            .unwrap()
            .terminal
            .size
    };
    assert_eq!(size("14", "px-number"), FontSize::Px(14.0));
    assert_eq!(size(r#""13.5px""#, "px-text"), FontSize::Px(13.5));
    let pt = size(r#""16pt""#, "pt");
    assert_eq!(pt, FontSize::Pt(16.0));
    // Windows Terminal's conversion: 1 pt is 96/72 DIPs, and a CSS px is a DIP, so the
    // window's DPI scale applies to both the same way.
    assert!((pt.px() - 21.333_333).abs() < 1e-5);
    for (bad, name) in [
        (r#""16em""#, "em"),
        (r#""pt""#, "nopt"),
        ("100", "big"),
        (r#""2pt""#, "small"),
    ] {
        let e = load(name, &format!("return {{\n  terminal = {{ size = {bad} }},\n}}\n")).unwrap_err();
        assert!(e.message.starts_with("terminal.size"), "{bad}: {e}");
        assert_eq!(e.line, Some(2), "{bad}: {e}");
    }
}

#[test]
fn the_renderer_cursor_and_cell_height() {
    let c = load(
        "renderer",
        r#"return { terminal = { renderer = "dom", cursor_style = "bar", cell_height = 1.2 } }"#,
    )
    .unwrap();
    assert_eq!(c.terminal.renderer, Renderer::Dom);
    assert_eq!(c.terminal.cursor_style, CursorStyle::Bar);
    assert_eq!(c.terminal.cell_height, Some(1.2));
    assert!(load("bad-renderer", r#"return { terminal = { renderer = "canvas" } }"#).is_err());
    assert!(load("bad-cell", r#"return { terminal = { cell_height = 9 } }"#).is_err());
}

#[test]
fn roster_set_sets_an_option_by_name_and_the_returned_table_wins() {
    let c = load(
        "set",
        r#"
roster.set("terminal.size", "16pt")
roster.set("theme", "nord")
roster.set("terminal.font", { "Iosevka Nerd Font" })
return { terminal = { weight = 400 }, theme = "gruvbox" }
"#,
    )
    .unwrap();
    assert_eq!(c.terminal.size, FontSize::Pt(16.0));
    assert_eq!(c.terminal.font.0, ["Iosevka Nerd Font"]);
    assert_eq!(c.terminal.weight, 400);
    assert_eq!(c.theme, "gruvbox");
}

#[test]
fn roster_set_with_a_bad_value_points_at_the_call() {
    let e = load("set-bad", "\nroster.set(\"terminal.size\", \"huge\")\nreturn {}\n").unwrap_err();
    assert_eq!(e.line, Some(2), "{e}");
    assert!(e.message.starts_with("terminal.size"), "{e}");
    let e = load("set-name", "roster.set(\"terminal.fnot\", 1)\n").unwrap_err();
    assert!(e.message.contains("fnot"), "{e}");
}

#[test]
fn the_frontend_gets_the_size_in_px_and_the_font_as_a_list() {
    let c = load(
        "json",
        r#"return { terminal = { size = "16pt", font = "Iosevka Term" } }"#,
    )
    .unwrap();
    let v = serde_json::to_value(&c).unwrap();
    assert!((v["terminal"]["size"].as_f64().unwrap() - 21.333_333).abs() < 1e-5);
    assert_eq!(v["terminal"]["font"], serde_json::json!(["Iosevka Term"]));
    assert_eq!(v["terminal"]["renderer"], "webgl");
    assert_eq!(v["terminal"]["cursorStyle"], "block");
    assert_eq!(v["terminal"]["cellHeight"], serde_json::Value::Null);
}
