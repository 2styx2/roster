//! The Config's schema: what `init.lua` may return, with every default. Lua names are
//! snake_case (`bold_weight`); the object sent to the frontend is camelCase (`boldWeight`) and
//! mirrors `src/config/types.ts`. Unknown names are errors, so a typo is reported with its line
//! instead of silently doing nothing.
//!
//! Several options take a shorthand as well as a table (`sidebar = false`, `statusbar = true`,
//! `ansi = false`); the custom Deserialize impls below normalize them, so the frontend always
//! gets one shape.

use serde::de::{self, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;

/// The whole Config: built-in defaults with `init.lua`'s values layered over them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all(serialize = "camelCase"))]
pub struct Config {
    /// A Theme's id, or "auto" to follow the OS with `dark_theme` / `light_theme`.
    pub theme: String,
    pub dark_theme: String,
    pub light_theme: String,
    /// New Themes (or changed copies of bundled ones), by id.
    pub themes: BTreeMap<String, ThemeDef>,
    /// Colour tokens set over whichever Theme is in use.
    pub colors: ThemeColors,
    /// The UI's fonts (decision Q30).
    pub fonts: Fonts,
    /// The rest of the UI's look.
    pub ui: Ui,
    /// Every panel's default width (ticket 95, decision Q106): `panel.width`.
    pub panel: Panel,
    /// Per panel or view id (`help`, `details`, a Plugin view's id): its default place and width.
    pub views: BTreeMap<String, ViewLayout>,
    pub terminal: Terminal,
    /// The chord that takes the keyboard back from a terminal.
    pub leader: String,
    pub vim: bool,
    pub idle_lock_minutes: u32,
    /// How old the last pull of the infra repo may be before a form pulls again, in the background
    /// (decision Q88); 0 pulls every time.
    pub pull_fresh_minutes: u32,
    /// The view mode at start: "standard" or "focus" (decision Q36).
    pub default_mode: ViewMode,
    /// Open Sessions listed in the Sidebar, or in a tab strip.
    pub sessions: SessionsIn,
    /// Key bindings: in Lua, per context, key or sequence → action (a command line), or false
    /// to unbind. Sent as a list.
    pub keys: Keys,
    /// The layout of each view mode (decision Q39).
    pub modes: Modes,
    /// Personal Folders (GLOSSARY: Folder) defined here; read-only in the app.
    #[serde(deserialize_with = "list")]
    pub folders: Vec<FolderDef>,
    /// The command that runs roster (development). The `ROSTER_APP_ROSTER` env var wins.
    pub roster_command: Option<RosterCommand>,
    /// "auto", "local", "wsl" or "wsl:<distro>". `ROSTER_APP_WSL_DISTRO` wins.
    pub backend: BackendChoice,
    /// What `:config` opens init.lua with (ticket 32).
    pub editor: Editor,
    /// Reload on every save of a `.lua` file. Off by default: `:source` reloads, as in Neovim
    /// (decision Q58).
    pub auto_reload: bool,
    /// The proxy Plugins' requests to public names go through (decision Q116): `http://HOST:PORT`,
    /// never with credentials. None: they go direct.
    pub plugin_proxy: Option<String>,
    /// This Box's own vault settings, sent to roster serve (`vault.configure`, tickets 35 and 41).
    pub vault: Vault,
    /// Packages: Plugins from git repos, pinned in `roster.lock` (ticket 24, decision Q83). In
    /// Lua, `{ "owner/repo", tag = "v1.0.0", config = { … } }` or a plain `"owner/repo"`; the
    /// first item becomes `source` (config/lua.rs).
    #[serde(deserialize_with = "list")]
    pub packages: Vec<PackageSpec>,
    /// Where each value came from in the file, for warnings the frontend raises (an unknown
    /// command in `keys`). Filled in after the schema check; never read from Lua.
    #[serde(skip_deserializing)]
    pub lines: BTreeMap<String, Location>,
    /// The options the file set, in its returned table or through `roster.set`, as Lua paths
    /// down to each value (`terminal.size`, `modes.focus.sidebar`), sorted. `:help options`
    /// (ticket 37) says these came from init.lua, even when a value equals its default. Filled
    /// in after the schema check; never read from Lua.
    #[serde(skip_deserializing)]
    pub set: Vec<String>,
    /// The deprecated options the file set (ticket 48), each applied under its new name; the
    /// frontend warns about each one, at `lines[old]`. Never read from Lua.
    #[serde(skip_deserializing)]
    pub deprecated: Vec<DeprecatedUse>,
}

/// An `init.lua` option that was renamed: docs/deprecated.md's "init.lua options" rows.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Renamed {
    /// Its Lua path, `terminal.font_size`.
    pub old: &'static str,
    pub new: &'static str,
}

/// Every renamed option, still applied under its new name with a warning until it's removed
/// (CONTRIBUTING.md, "Docs"; docs/deprecated.md says when). None yet.
pub const DEPRECATED_OPTIONS: &[Renamed] = &[];

/// A deprecated option the file set, for the frontend's warning.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeprecatedUse {
    pub old: String,
    pub new: String,
    /// Its row in `:help deprecated`: `deprecated#terminalfont_size`.
    pub topic: String,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            theme: "auto".into(),
            dark_theme: "roster-dark".into(),
            light_theme: "roster-light".into(),
            themes: BTreeMap::new(),
            colors: ThemeColors::default(),
            fonts: Fonts::default(),
            ui: Ui::default(),
            panel: Panel::default(),
            views: BTreeMap::new(),
            terminal: Terminal::default(),
            leader: "Ctrl+Space".into(),
            vim: true,
            idle_lock_minutes: 15,
            pull_fresh_minutes: 5,
            default_mode: ViewMode::Standard,
            sessions: SessionsIn::Sidebar,
            keys: Keys::default(),
            modes: Modes::default(),
            folders: Vec::new(),
            roster_command: None,
            backend: BackendChoice::Auto,
            editor: Editor::Os,
            auto_reload: false,
            plugin_proxy: None,
            vault: Vault::default(),
            packages: Vec::new(),
            lines: BTreeMap::new(),
            set: Vec::new(),
            deprecated: Vec::new(),
        }
    }
}

/// The UI's look, apart from fonts and colours.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all(serialize = "camelCase"))]
pub struct Ui {
    /// Show the keycap hints (status bar, empty states, panels, Picker footers, menus). Unset:
    /// `:hints` decides and the State keeps its choice; set, it wins.
    pub hints: Option<bool>,
    /// What the message line shows (ticket 111): `"quiet"`, errors, warnings and answers only, as
    /// Neovim; `"all"`, routine confirmations and tips too. Unset: `:messages` decides and the
    /// State keeps its choice (quiet until it makes one); set, it wins.
    pub messages: Option<MessagesLevel>,
}

/// `ui.messages`: which messages the message line shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessagesLevel {
    Quiet,
    All,
}

/// `panel`: what every panel and view starts with (ticket 95). The user's own choice, kept in the
/// State, wins over these: they're defaults (decision Q106).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all(serialize = "camelCase"))]
pub struct Panel {
    /// A docked panel's width in percent of the window (10 to 95). Unset: each panel's own.
    pub width: Option<u32>,
}

/// `views.ID`: one panel's or view's default place and width.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all(serialize = "camelCase"))]
pub struct ViewLayout {
    /// Docked beside the terminal (`"panel"`) or over the whole window (`"full"`).
    pub place: Option<PanelPlace>,
    /// Docked width in percent of the window (10 to 95).
    pub width: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PanelPlace {
    Panel,
    Full,
}

/// What init.lua says about the vault: this Box's own settings, which win over roster.yml's
/// `providers:`. The app sends them to roster serve (`vault.configure`) at start and after every
/// `:source`. Paths and choices only, never a secret (docs/app/security.md).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all(serialize = "camelCase"))]
pub struct Vault {
    /// Where "Save to vault" puts new Vault items by default (ticket 35). None: roster.yml's.
    pub save_to: Option<SaveTo>,
    /// KeePassXC (ticket 41): a local database is this Box's, not the team's.
    pub kp: KeePassXc,
}

/// `save_to`: the personal vault, an organization's collection (Bitwarden, by name or id), or a
/// group (KeePassXC). The same shape as roster.yml's `providers: NAME: save_to:`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum SaveTo {
    #[serde(serialize_with = "personal")]
    Personal,
    Collection {
        organization: String,
        collection: String,
    },
    Group {
        group: String,
    },
}

fn personal<S: serde::Serializer>(s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str("personal")
}

impl<'de> Deserialize<'de> for SaveTo {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = SaveTo;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str(
                    "\"personal\", { organization = …, collection = … } (Bitwarden) or { group = … } (KeePassXC)",
                )
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<SaveTo, E> {
                match v {
                    "personal" => Ok(SaveTo::Personal),
                    _ => Err(E::custom(format!(
                        "{v:?}: say \"personal\", or give {{ organization = …, collection = … }} or {{ group = … }}"
                    ))),
                }
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<SaveTo, A::Error> {
                let mut fields: BTreeMap<String, String> = BTreeMap::new();
                while let Some((k, v)) = map.next_entry::<String, String>()? {
                    if v.trim().is_empty() {
                        return Err(de::Error::custom(format!("{k} can't be empty")));
                    }
                    fields.insert(k, v.trim().to_string());
                }
                let keys: Vec<&str> = fields.keys().map(String::as_str).collect();
                match keys.as_slice() {
                    ["collection", "organization"] => Ok(SaveTo::Collection {
                        organization: fields["organization"].clone(),
                        collection: fields["collection"].clone(),
                    }),
                    ["group"] => Ok(SaveTo::Group {
                        group: fields["group"].clone(),
                    }),
                    _ => Err(de::Error::custom(format!(
                        "{{ {} }}: give {{ organization = …, collection = … }} (Bitwarden) or {{ group = … }} (KeePassXC)",
                        keys.join(", ")
                    ))),
                }
            }
        }
        d.deserialize_any(V)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all(serialize = "camelCase"))]
pub struct KeePassXc {
    /// The `.kdbx`, on the Box roster runs on (WSL's file system for a WSL Backend).
    #[serde(deserialize_with = "backend_path")]
    pub database: Option<String>,
    /// A key file used with the master password, on the same Box.
    #[serde(deserialize_with = "backend_path")]
    pub key_file: Option<String>,
}

/// A path on the Box roster runs on: absolute or `~/…`, since init.lua may be on another machine
/// (Windows, with roster in WSL) and a relative path would have nothing to be relative to. A
/// Windows path (`C:\…`, `\\server\…`) is taken here and checked once the whole Config is read
/// (`validate` in mod.rs): it's right for native Windows roster (`backend = "local"`), and refused
/// otherwise with the path it most likely means in WSL.
fn backend_path<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    let s = String::deserialize(d)?;
    let t = s.trim();
    if t.starts_with('/') || t.starts_with('~') || windows_path(t).is_some() {
        return Ok(Some(t.to_string()));
    }
    Err(de::Error::custom(format!(
        "{s:?} isn't an absolute path: give the path on the Box roster runs on, starting with / or ~"
    )))
}

/// For a Windows path, what to give instead: its path inside WSL when that's clear (a drive is
/// usually mounted at /mnt/<drive>; a `\\wsl$\<distro>\` share is the distro's own `/`). None for
/// anything else.
pub(crate) fn windows_path(t: &str) -> Option<String> {
    let b = t.as_bytes();
    if b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/') {
        let rest = t[3..].replace('\\', "/");
        let drive = (b[0] as char).to_ascii_lowercase();
        return Some(format!(
            "give its path there, usually /mnt/{drive}/{rest} (or copy the file into WSL)"
        ));
    }
    let share = t.strip_prefix("\\\\")?; // `//x` is a POSIX path too: only `\\x` is a share
    let parts: Vec<&str> = share.split(['\\', '/']).collect();
    let host = parts.first().map(|h| h.to_ascii_lowercase()).unwrap_or_default();
    if (host == "wsl$" || host == "wsl.localhost") && parts.len() > 2 {
        return Some(format!("give its path inside WSL: /{}", parts[2..].join("/")));
    }
    Some("copy the file into WSL (or mount the share there) and give that path".into())
}

/// A place in a Lua file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Location {
    /// Relative to the config dir, `/`-separated: `init.lua`, `lua/keys.lua`.
    pub file: String,
    pub line: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all(serialize = "camelCase"))]
pub struct Fonts {
    /// A family name ("Inter") or a whole CSS font stack (anything with a comma).
    pub ui: String,
    /// The wordmark's and code-like UI text's font.
    pub mono: String,
    /// The UI's body text size in px; the rest of the type scale and the row height follow it.
    pub ui_size: u32,
}

impl Default for Fonts {
    fn default() -> Self {
        Fonts {
            ui: "Inter".into(),
            mono: "Iosevka".into(),
            ui_size: 15,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all(serialize = "camelCase"))]
pub struct Terminal {
    /// Font families in order of preference: the first one installed (or bundled) is used
    /// (ticket 33). A name, a CSS stack, or a list.
    pub font: FontList,
    /// A number is px; "16pt" is points, converted as Windows Terminal does. Zoom keys move it,
    /// `Ctrl+0` comes back here.
    pub size: FontSize,
    /// 100–900. Medium (500) by default; the bundled Iosevka has 400, 500 and 700.
    pub weight: u32,
    pub bold_weight: u32,
    /// A multiple of the font's own line height (xterm's lineHeight).
    pub line_height: f64,
    /// A multiple of the font size, as Windows Terminal's `cellHeight`; wins over
    /// `line_height` when set.
    pub cell_height: Option<f64>,
    pub scrollback: u32,
    pub copy_on_select: bool,
    /// Right-click copies the selection, or pastes when nothing is selected.
    pub right_click_paste: bool,
    /// xterm's renderer: WebGL (fast) or the DOM (the browser's own text rendering).
    pub renderer: Renderer,
    pub cursor_style: CursorStyle,
    /// Bold text in the bright ANSI colours too (xterm's drawBoldTextInBrightColors).
    pub bold_is_bright: bool,
    /// Terminal colours over the Theme's: background, cursor, the 16 ANSI colours…
    pub colors: TerminalColors,
    /// Send each Session's shell the one-line hook that turns on OSC 133 marks and OSC 7 (ticket
    /// 121, decision Q130). Unset: a Host's `shell_hooks: true` in roster.yml decides; `true`: every
    /// Session but a Host's `shell_hooks: false`; `false`: none.
    pub shell_hooks: Option<bool>,
}

impl Default for Terminal {
    fn default() -> Self {
        Terminal {
            font: FontList(vec![
                "Iosevka Nerd Font".into(),
                "Iosevka Term".into(),
                "Iosevka".into(),
            ]),
            size: FontSize::Pt(13.0),
            weight: 500,
            bold_weight: 700,
            line_height: 1.0,
            cell_height: None,
            scrollback: 10_000,
            copy_on_select: true,
            right_click_paste: true,
            renderer: Renderer::Webgl,
            cursor_style: CursorStyle::Block,
            bold_is_bright: true,
            colors: TerminalColors::default(),
            shell_hooks: None,
        }
    }
}

/// Font families, most wanted first. From Lua: a name ("Iosevka"), a CSS stack
/// ("\"Fira Code\", Consolas"), or a list ({ "Iosevka Nerd Font", "Iosevka" }).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FontList(pub Vec<String>);

impl PartialEq<&str> for FontList {
    fn eq(&self, other: &&str) -> bool {
        self.0.len() == 1 && self.0[0] == *other
    }
}

impl FontList {
    /// The families in a CSS stack: split on commas, quotes and spaces trimmed.
    pub fn parse(stack: &str) -> FontList {
        FontList(
            stack
                .split(',')
                .map(|f| f.trim().trim_matches(|c| c == '"' || c == '\'').trim().to_string())
                .filter(|f| !f.is_empty())
                .collect(),
        )
    }
}

impl<'de> Deserialize<'de> for FontList {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = FontList;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a font name, a CSS font stack, or a list of font names")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<FontList, E> {
                Ok(FontList::parse(v))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<FontList, A::Error> {
                let mut out = Vec::new();
                while let Some(name) = seq.next_element::<String>()? {
                    out.push(name.trim().to_string());
                }
                Ok(FontList(out))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<FontList, A::Error> {
                // An empty Lua table arrives as a map.
                if map.next_key::<IgnoredAny>()?.is_some() {
                    return Err(de::Error::custom("expected a list of font names"));
                }
                Ok(FontList(Vec::new()))
            }
        }
        d.deserialize_any(V)
    }
}

/// A font size: px, or points (Windows Terminal's unit).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FontSize {
    Px(f64),
    Pt(f64),
}

impl FontSize {
    /// In CSS px. Windows Terminal turns points into DIPs at 96/72 and lets the window's DPI
    /// scale them; a CSS px is a DIP, and the webview applies the same scale, so 16 pt is
    /// 21.33 px here at any scaling (decision Q55).
    pub fn px(self) -> f64 {
        match self {
            FontSize::Px(v) => v,
            FontSize::Pt(v) => v * 96.0 / 72.0,
        }
    }
}

/// Sent to the frontend as px.
impl Serialize for FontSize {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_f64(self.px())
    }
}

impl<'de> Deserialize<'de> for FontSize {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl Visitor<'_> for V {
            type Value = FontSize;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a size in px (14), or text with a unit (\"16pt\", \"21px\")")
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<FontSize, E> {
                Ok(FontSize::Px(v))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<FontSize, E> {
                Ok(FontSize::Px(v as f64))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<FontSize, E> {
                Ok(FontSize::Px(v as f64))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<FontSize, E> {
                let t = v.trim();
                let (num, unit): (&str, fn(f64) -> FontSize) = if let Some(n) = t.strip_suffix("pt") {
                    (n, FontSize::Pt)
                } else if let Some(n) = t.strip_suffix("px") {
                    (n, FontSize::Px)
                } else {
                    return Err(E::custom(format!("\"{v}\" needs a unit: \"16pt\" or \"21px\"")));
                };
                num.trim()
                    .parse::<f64>()
                    .ok()
                    .filter(|n| n.is_finite())
                    .map(unit)
                    .ok_or_else(|| E::custom(format!("\"{v}\" isn't a size like \"16pt\" or \"21px\"")))
            }
        }
        d.deserialize_any(V)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Renderer {
    Webgl,
    Dom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CursorStyle {
    Block,
    Bar,
    Underline,
}

/// Declares a struct of optional colour strings, skipped when unset, unknown names refused.
macro_rules! colors {
    ($(#[$doc:meta])* $name:ident { $($field:ident),* $(,)? }) => {
        $(#[$doc])*
        #[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
        #[serde(default, deny_unknown_fields, rename_all(serialize = "camelCase"))]
        pub struct $name {
            $(
                #[serde(skip_serializing_if = "Option::is_none")]
                pub $field: Option<String>,
            )*
        }

        impl $name {
            /// The Lua names, in order.
            pub const NAMES: &'static [&'static str] = &[$(stringify!($field)),*];
        }
    };
}

colors!(
    /// The UI's colour tokens (src/theme/theme.ts ThemeColors).
    ThemeColors {
        accent, accent_text, accent_ink, tone, bg, chrome, sidebar, panel, raised, raised_line,
        hover, line, line_strong, text, muted, faint, warn, error, danger, danger_text, backdrop,
        shadow, syntax_keyword, syntax_string, syntax_number, syntax_comment, syntax_function,
        syntax_punctuation, syntax_key, syntax_command,
    }
);

colors!(
    /// A Theme's own terminal colours, apart from the 16 ANSI ones.
    ThemeTerminalColors {
        background, foreground, cursor, cursor_accent, selection_background, search_match,
        search_active_match,
    }
);

colors!(
    /// The 16 ANSI colours; any left out keep the standard palette's (decision Q37).
    Ansi {
        black, red, green, yellow, blue, magenta, cyan, white, bright_black, bright_red,
        bright_green, bright_yellow, bright_blue, bright_magenta, bright_cyan, bright_white,
    }
);

colors!(
    /// `terminal.colors`: any terminal colour, the ANSI ones included.
    TerminalColors {
        background, foreground, cursor, cursor_accent, selection_background, search_match,
        search_active_match, black, red, green, yellow, blue, magenta, cyan, white, bright_black,
        bright_red, bright_green, bright_yellow, bright_blue, bright_magenta, bright_cyan,
        bright_white,
    }
);

/// A Theme defined in `init.lua`: a bundled one (`base`) with tokens changed, or a new one.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ThemeDef {
    /// Shown in the app; the id if left out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// "dark" or "light": which OS appearance it suits. The base's if left out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub appearance: Option<Appearance>,
    /// The Theme it starts from: every token it doesn't set comes from there. Defaults to
    /// Roster dark or Roster light, by `appearance`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    pub colors: ThemeColors,
    pub terminal: ThemeTerminalColors,
    /// The terminal's 16 colours; `false` keeps the standard palette even if the base has its
    /// own. Left out: the base's.
    pub ansi: AnsiChoice,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    Dark,
    Light,
}

/// `ansi = { … }`, `ansi = false`, or nothing.
#[derive(Debug, Clone, Default, PartialEq)]
pub enum AnsiChoice {
    #[default]
    Inherit,
    Standard,
    Colors(Box<Ansi>),
}

impl Serialize for AnsiChoice {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            AnsiChoice::Inherit => s.serialize_str("inherit"),
            AnsiChoice::Standard => s.serialize_str("standard"),
            AnsiChoice::Colors(a) => a.serialize(s),
        }
    }
}

impl<'de> Deserialize<'de> for AnsiChoice {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = AnsiChoice;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a table of ANSI colours, or false for the standard palette")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<AnsiChoice, E> {
                if v {
                    Err(E::custom(
                        "ansi = true means nothing: give a table of colours, or false",
                    ))
                } else {
                    Ok(AnsiChoice::Standard)
                }
            }
            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<AnsiChoice, A::Error> {
                Ansi::deserialize(de::value::MapAccessDeserializer::new(map)).map(|a| AnsiChoice::Colors(Box::new(a)))
            }
        }
        d.deserialize_any(V)
    }
}

/// What `:config` opens init.lua with: the OS's app for the file, or `$EDITOR` inside WSL (in a
/// console window of its own).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Editor {
    Os,
    Wsl,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ViewMode {
    Standard,
    Focus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionsIn {
    Sidebar,
    Tabs,
}

/// The keymap's contexts (src/keymap.ts Keymap).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyContext {
    /// After the Leader (App mode).
    Leader,
    /// Moving in a list (the Sidebar), always.
    List,
    /// Moving in a list when vim keys are on.
    ListVim,
    /// In the Picker.
    Picker,
    /// In the Picker's list when vim keys are on.
    PickerVim,
    /// In the command line (ticket 34): cycle through completions, accept, run, cancel.
    Cmdline,
    /// In a terminal, before the shell sees the key.
    Terminal,
    /// Everywhere, with no Leader (F11).
    Global,
}

impl KeyContext {
    pub const ALL: [KeyContext; 8] = [
        KeyContext::Leader,
        KeyContext::List,
        KeyContext::ListVim,
        KeyContext::Picker,
        KeyContext::PickerVim,
        KeyContext::Cmdline,
        KeyContext::Terminal,
        KeyContext::Global,
    ];

    /// The name in Lua.
    pub fn lua_name(self) -> &'static str {
        match self {
            KeyContext::Leader => "leader",
            KeyContext::List => "list",
            KeyContext::ListVim => "list_vim",
            KeyContext::Picker => "picker",
            KeyContext::PickerVim => "picker_vim",
            KeyContext::Cmdline => "cmdline",
            KeyContext::Terminal => "terminal",
            KeyContext::Global => "global",
        }
    }
}

/// One key binding from the Config.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KeyBinding {
    pub context: KeyContext,
    /// A chord or a sequence: "x", "Ctrl+n", "g g".
    pub keys: String,
    pub action: KeyAction,
}

/// The Config's key bindings, in context order, then key order.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(from = "KeysPatch")]
pub struct Keys(pub Vec<KeyBinding>);

impl Serialize for Keys {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(s)
    }
}

type KeyTable = Option<BTreeMap<String, KeyAction>>;

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct KeysPatch {
    leader: KeyTable,
    list: KeyTable,
    list_vim: KeyTable,
    picker: KeyTable,
    picker_vim: KeyTable,
    cmdline: KeyTable,
    terminal: KeyTable,
    global: KeyTable,
}

impl From<KeysPatch> for Keys {
    fn from(p: KeysPatch) -> Self {
        let tables = [
            p.leader,
            p.list,
            p.list_vim,
            p.picker,
            p.picker_vim,
            p.cmdline,
            p.terminal,
            p.global,
        ];
        let mut out = Vec::new();
        for (context, table) in KeyContext::ALL.into_iter().zip(tables) {
            for (keys, action) in table.unwrap_or_default() {
                out.push(KeyBinding { context, keys, action });
            }
        }
        Keys(out)
    }
}

/// What a key does: an action (a command line such as "session 1"), or nothing (`false`
/// unbinds a default). Serialized as the string, or null.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyAction {
    Run(String),
    Unbind,
}

impl Serialize for KeyAction {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            KeyAction::Run(a) => s.serialize_str(a),
            KeyAction::Unbind => s.serialize_none(),
        }
    }
}

impl<'de> Deserialize<'de> for KeyAction {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl Visitor<'_> for V {
            type Value = KeyAction;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an action name (a command line such as \"session 1\"), or false to unbind the key")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<KeyAction, E> {
                if v.trim().is_empty() {
                    return Err(E::custom("an empty action: use false to unbind a key"));
                }
                Ok(KeyAction::Run(v.trim().to_string()))
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<KeyAction, E> {
                if v {
                    Err(E::custom(
                        "a key can be an action name, or false to unbind it (not true)",
                    ))
                } else {
                    Ok(KeyAction::Unbind)
                }
            }
        }
        d.deserialize_any(V)
    }
}

/// Each view mode's layout (decision Q39). The pieces: title bar, Sidebar (and its sections),
/// session bar, status bar (and its segments).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(from = "ModesPatch")]
pub struct Modes {
    pub standard: ModeLayout,
    pub focus: ModeLayout,
}

impl Default for Modes {
    fn default() -> Self {
        Modes {
            standard: ModeLayout {
                fullscreen: false,
                titlebar: true,
                sidebar: SidebarPiece {
                    shown: true,
                    side: Side::Left,
                    sections: None,
                },
                sessionbar: SessionBarPiece {
                    shown: false,
                    at: Edge::Bottom,
                },
                statusbar: StatusBarPiece {
                    shown: true,
                    segments: None,
                },
                toolbar: ToolbarPiece {
                    shown: true,
                    controls: None,
                },
                set: Vec::new(),
            },
            focus: ModeLayout {
                fullscreen: true,
                titlebar: false,
                sidebar: SidebarPiece {
                    shown: false,
                    side: Side::Left,
                    sections: None,
                },
                sessionbar: SessionBarPiece {
                    shown: false,
                    at: Edge::Bottom,
                },
                statusbar: StatusBarPiece {
                    shown: false,
                    segments: None,
                },
                toolbar: ToolbarPiece {
                    shown: false,
                    controls: None,
                },
                set: Vec::new(),
            },
        }
    }
}

/// One mode's layout, as sent to the frontend: every piece, shown or not.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModeLayout {
    /// OS fullscreen (Focus by default).
    pub fullscreen: bool,
    pub titlebar: bool,
    pub sidebar: SidebarPiece,
    pub sessionbar: SessionBarPiece,
    pub statusbar: StatusBarPiece,
    /// The visible controls for common commands (decision Q65): in the title bar, or a bar of
    /// their own at the top when the mode has no title bar.
    pub toolbar: ToolbarPiece,
    /// The pieces `init.lua` set, by name ("sidebar", "toolbar"…): what it sets wins over what the
    /// app keeps in the State (the Sidebar shown or hidden, issue #78). Empty for the defaults.
    pub set: Vec<String>,
}

/// What `init.lua` says about the modes: only what it sets, laid over each mode's defaults.
#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct ModesPatch {
    standard: ModePatch,
    focus: ModePatch,
}

/// One mode in Lua. Each piece takes a shorthand: `sidebar = false`, `sessionbar = "bottom"`,
/// `statusbar = { "backend", "hosts" }`. A piece left out keeps the mode's default.
#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct ModePatch {
    fullscreen: Option<bool>,
    titlebar: Option<bool>,
    sidebar: Option<SidebarPiece>,
    sessionbar: Option<SessionBarPiece>,
    statusbar: Option<StatusBarPiece>,
    toolbar: Option<ToolbarPiece>,
}

impl ModePatch {
    fn over(self, base: ModeLayout) -> ModeLayout {
        let set = [
            ("fullscreen", self.fullscreen.is_some()),
            ("titlebar", self.titlebar.is_some()),
            ("sidebar", self.sidebar.is_some()),
            ("sessionbar", self.sessionbar.is_some()),
            ("statusbar", self.statusbar.is_some()),
            ("toolbar", self.toolbar.is_some()),
        ]
        .into_iter()
        .filter(|(_, given)| *given)
        .map(|(name, _)| name.to_string())
        .collect();
        ModeLayout {
            fullscreen: self.fullscreen.unwrap_or(base.fullscreen),
            titlebar: self.titlebar.unwrap_or(base.titlebar),
            sidebar: self.sidebar.unwrap_or(base.sidebar),
            sessionbar: self.sessionbar.unwrap_or(base.sessionbar),
            statusbar: self.statusbar.unwrap_or(base.statusbar),
            toolbar: self.toolbar.unwrap_or(base.toolbar),
            set,
        }
    }
}

impl From<ModesPatch> for Modes {
    fn from(p: ModesPatch) -> Self {
        let d = Modes::default();
        Modes {
            standard: p.standard.over(d.standard),
            focus: p.focus.over(d.focus),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    #[default]
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    Top,
    Bottom,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct SidebarPiece {
    pub shown: bool,
    pub side: Side,
    /// Section ids in order ("sessions", "folders", "inventory"); null: all, in their order.
    pub sections: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SidebarTable {
    #[serde(default)]
    side: Option<Side>,
    #[serde(default, deserialize_with = "opt_list")]
    sections: Option<Vec<String>>,
}

impl<'de> Deserialize<'de> for SidebarPiece {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = SidebarPiece;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("true, false, or a table { side = \"left\" | \"right\", sections = { … } }")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<SidebarPiece, E> {
                Ok(SidebarPiece {
                    shown: v,
                    ..SidebarPiece::default()
                })
            }
            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<SidebarPiece, A::Error> {
                let t = SidebarTable::deserialize(de::value::MapAccessDeserializer::new(map))?;
                Ok(SidebarPiece {
                    shown: true,
                    side: t.side.unwrap_or_default(),
                    sections: t.sections,
                })
            }
        }
        d.deserialize_any(V)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SessionBarPiece {
    pub shown: bool,
    pub at: Edge,
}

impl Default for SessionBarPiece {
    fn default() -> Self {
        SessionBarPiece {
            shown: false,
            at: Edge::Bottom,
        }
    }
}

impl<'de> Deserialize<'de> for SessionBarPiece {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl Visitor<'_> for V {
            type Value = SessionBarPiece;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("\"bottom\", \"top\" or false")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<SessionBarPiece, E> {
                Ok(SessionBarPiece {
                    shown: v,
                    at: Edge::Bottom,
                })
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<SessionBarPiece, E> {
                let at = match v {
                    "top" => Edge::Top,
                    "bottom" => Edge::Bottom,
                    _ => return Err(E::invalid_value(de::Unexpected::Str(v), &self)),
                };
                Ok(SessionBarPiece { shown: true, at })
            }
        }
        d.deserialize_any(V)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct StatusBarPiece {
    pub shown: bool,
    /// Segment ids in order ("backend", "box", "hosts", "path", "changes", "hints", "mode"); null: all.
    pub segments: Option<Vec<String>>,
}

impl<'de> Deserialize<'de> for StatusBarPiece {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = StatusBarPiece;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("true, false, or a list of segments such as { \"backend\", \"hosts\" }")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<StatusBarPiece, E> {
                Ok(StatusBarPiece {
                    shown: v,
                    segments: None,
                })
            }
            fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> Result<StatusBarPiece, A::Error> {
                let segments = ListVisitor::<String>::new().visit_seq(seq)?;
                Ok(StatusBarPiece {
                    shown: true,
                    segments: Some(segments),
                })
            }
            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<StatusBarPiece, A::Error> {
                let segments = ListVisitor::<String>::new().visit_map(map)?;
                Ok(StatusBarPiece {
                    shown: true,
                    segments: Some(segments),
                })
            }
        }
        d.deserialize_any(V)
    }
}

/// The toolbar (decision Q65): `true`, `false`, or its controls in order (`{ "add", "find" }`,
/// ids from the app's toolbar registry: "sidebar", "find", "quick", "add", "changes", "publish", "details", and the
/// ones not shown by default, "cmdline", "keys", "help", "lock", "mode"); null: the default set.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ToolbarPiece {
    pub shown: bool,
    pub controls: Option<Vec<String>>,
}

impl<'de> Deserialize<'de> for ToolbarPiece {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = ToolbarPiece;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("true, false, or a list of controls such as { \"add\", \"find\" }")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<ToolbarPiece, E> {
                Ok(ToolbarPiece {
                    shown: v,
                    controls: None,
                })
            }
            fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> Result<ToolbarPiece, A::Error> {
                let controls = ListVisitor::<String>::new().visit_seq(seq)?;
                Ok(ToolbarPiece {
                    shown: true,
                    controls: Some(controls),
                })
            }
            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<ToolbarPiece, A::Error> {
                let controls = ListVisitor::<String>::new().visit_map(map)?;
                Ok(ToolbarPiece {
                    shown: true,
                    controls: Some(controls),
                })
            }
        }
        d.deserialize_any(V)
    }
}

/// A Folder defined in `init.lua`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FolderDef {
    pub name: String,
    #[serde(default, deserialize_with = "list")]
    pub hosts: Vec<String>,
}

/// A Package named in `init.lua` (ticket 24): where its git repo is, which version, and the
/// settings it's handed. At most one of `tag`, `branch` and `commit`; none means the repo's
/// default branch. Checked by [`crate::package::check_spec`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PackageSpec {
    /// `"owner/repo"` (on GitHub) or a full git URL (`https://…`, `ssh://…`, `git@host:path`,
    /// `file://…` or a full path to a repo on this machine).
    pub source: String,
    /// The Package's name (its folder and its key in `roster.lock`); the repo's name by default.
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub commit: Option<String>,
    /// The folder in the repo that holds the Plugin (`plugins/topology`), when it isn't the repo's
    /// top (decision Q94). Relative, inside the repo, `/` between folders.
    #[serde(default)]
    pub dir: Option<String>,
    /// Settings handed to the Package as `roster.plugin.config` (a table; never a function).
    #[serde(default)]
    pub config: serde_json::Map<String, serde_json::Value>,
}

/// `roster_command = "uv run --project ~/work/roster roster"` (split on spaces) or a list.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(transparent)]
pub struct RosterCommand(pub Vec<String>);

impl RosterCommand {
    /// The forms init.lua may use (docs/app/security.md): roster itself (`roster`, or a path ending
    /// in `/roster`), or `uv run [--project P | --directory P | --frozen | --locked | --offline |
    /// --no-sync | -q | --quiet]… roster`. This program gets the master password, two-step codes
    /// and the API secret on its stdin, so the Config can't put anything else in front of them;
    /// a wrapper takes the `ROSTER_APP_ROSTER` env var, which the user sets outside the Config.
    pub fn check(&self) -> Result<(), String> {
        let refuse = || {
            Err(format!(
                "{:?} isn't roster. init.lua may only name roster itself (\"roster\", a path to it, or \
                 \"uv run --project <dir> roster\"), because this program gets the master password; \
                 for any other wrapper, set the ROSTER_APP_ROSTER env var instead",
                self.0.join(" ")
            ))
        };
        let base = |w: &str| w.rsplit(['/', '\\']).next().unwrap_or(w).to_string();
        let is = |w: &str, name: &str| {
            let b = base(w);
            b == name || b == format!("{name}.exe")
        };
        match self.0.as_slice() {
            [roster] if is(roster, "roster") => Ok(()),
            [uv, run, options @ .., roster] if is(uv, "uv") && run == "run" && is(roster, "roster") => {
                let mut rest = options.iter();
                while let Some(o) = rest.next() {
                    match o.as_str() {
                        "--frozen" | "--locked" | "--offline" | "--no-sync" | "-q" | "--quiet" => {}
                        "--project" | "--directory" => {
                            if rest.next().is_none() {
                                return refuse();
                            }
                        }
                        o if o.starts_with("--project=") || o.starts_with("--directory=") => {}
                        _ => return refuse(),
                    }
                }
                Ok(())
            }
            _ => refuse(),
        }
    }
}

impl<'de> Deserialize<'de> for RosterCommand {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = RosterCommand;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a command line (split on spaces) or a list of words")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<RosterCommand, E> {
                let words: Vec<String> = v.split_whitespace().map(String::from).collect();
                if words.is_empty() {
                    return Err(E::custom("an empty roster_command"));
                }
                Ok(RosterCommand(words))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> Result<RosterCommand, A::Error> {
                let words = ListVisitor::<String>::new().visit_seq(seq)?;
                if words.is_empty() {
                    return Err(de::Error::custom("an empty roster_command"));
                }
                Ok(RosterCommand(words))
            }
        }
        d.deserialize_any(V)
    }
}

/// Which roster to run (ticket 19 adds native Windows `local`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendChoice {
    /// Detect: local on Linux; the default WSL distro, then running ones, on Windows.
    Auto,
    /// roster on this machine.
    Local,
    /// roster in WSL, in this distro (or found as with Auto).
    Wsl(Option<String>),
}

impl BackendChoice {
    /// The WSL distro it names, if any.
    pub fn distro(&self) -> Option<&str> {
        match self {
            BackendChoice::Wsl(Some(d)) => Some(d),
            _ => None,
        }
    }
}

impl Serialize for BackendChoice {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            BackendChoice::Auto => s.serialize_str("auto"),
            BackendChoice::Local => s.serialize_str("local"),
            BackendChoice::Wsl(None) => s.serialize_str("wsl"),
            BackendChoice::Wsl(Some(d)) => s.serialize_str(&format!("wsl:{d}")),
        }
    }
}

impl<'de> Deserialize<'de> for BackendChoice {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        match s.as_str() {
            "auto" => Ok(BackendChoice::Auto),
            "local" => Ok(BackendChoice::Local),
            "wsl" => Ok(BackendChoice::Wsl(None)),
            _ => match s.strip_prefix("wsl:").map(str::trim) {
                Some(d) if !d.is_empty() => Ok(BackendChoice::Wsl(Some(d.to_string()))),
                _ => Err(de::Error::custom(format!(
                    "{s:?}: say \"auto\", \"local\", \"wsl\" or \"wsl:<distro>\""
                ))),
            },
        }
    }
}

/// A Lua list. An empty Lua table `{}` can't say whether it's a list or a table, so an empty
/// table is accepted wherever a list is.
fn list<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Vec<T>, D::Error> {
    d.deserialize_any(ListVisitor::new())
}

fn opt_list<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<Vec<T>>, D::Error> {
    list(d).map(Some)
}

struct ListVisitor<T>(std::marker::PhantomData<T>);

impl<T> ListVisitor<T> {
    fn new() -> Self {
        ListVisitor(std::marker::PhantomData)
    }
}

impl<'de, T: Deserialize<'de>> Visitor<'de> for ListVisitor<T> {
    type Value = Vec<T>;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a list such as { \"a\", \"b\" }")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Vec<T>, A::Error> {
        let mut out = Vec::new();
        while let Some(item) = seq.next_element()? {
            out.push(item);
        }
        Ok(out)
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Vec<T>, A::Error> {
        match map.next_key::<String>()? {
            None => Ok(Vec::new()),
            Some(k) => {
                let _ = map.next_value::<IgnoredAny>();
                Err(de::Error::custom(format!(
                    "expected a list such as {{ \"a\", \"b\" }}, found a table with key `{k}`"
                )))
            }
        }
    }
}
