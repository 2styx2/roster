//! The declarations: every option, in the reference's order, and init.lua's `roster` table.
//! Colour tokens and key contexts come from the schema's own lists, so a token added there is
//! here too.

use super::{Allowed, ApiItem, Kind, Opt, Param};
use crate::config::schema::{Ansi, KeyContext, TerminalColors, ThemeColors, ThemeTerminalColors};

const UNSET: &str = "unset";
const COLOUR: Allowed = Allowed::Form("a CSS colour, such as \"#e8a33d\"");
const THEME_ID: Allowed = Allowed::Form("a Theme's id");
const BOOL: Allowed = Allowed::Any;

struct B {
    out: Vec<Opt>,
    section: &'static str,
}

impl B {
    #[allow(clippy::too_many_arguments)] // one declaration per option reads best as one call
    fn add(
        &mut self,
        path: impl Into<String>,
        kind: Kind,
        ty: impl Into<String>,
        default: impl Into<String>,
        allowed: Allowed,
        about: impl Into<String>,
        example: impl Into<String>,
    ) -> &mut Opt {
        self.out.push(Opt {
            path: path.into(),
            kind,
            ty: ty.into(),
            default: default.into(),
            allowed,
            about: about.into(),
            example: example.into(),
            section: self.section,
            class: None,
            brief: false,
        });
        self.out.last_mut().expect("just pushed")
    }

    fn leaf(&mut self, path: impl Into<String>, ty: &str, default: &str, allowed: Allowed, about: &str, example: &str) {
        self.add(path, Kind::Leaf, ty, default, allowed, about, example);
    }

    fn object(&mut self, path: impl Into<String>, class: &'static str, ty: &str, about: &str) {
        self.add(path, Kind::Object, ty, "{}", Allowed::Any, about, "").class = Some(class);
    }

    /// A colour object: one optional colour per name, listed in its parent's entry.
    fn colours(&mut self, path: &str, class: &'static str, names: &[&str], about: &str, example: &str) {
        let o = self.add(path, Kind::Object, class, "{}", Allowed::Any, about, example);
        o.class = Some(class);
        for name in names {
            let o = self.add(
                format!("{path}.{name}"),
                Kind::Leaf,
                "string",
                UNSET,
                COLOUR,
                format!("The `{name}` colour."),
                "\"#e8a33d\"",
            );
            o.brief = true;
        }
    }
}

pub(super) fn options() -> Vec<Opt> {
    let mut b = B {
        out: Vec::new(),
        section: "",
    };

    b.section = "Themes and colours";
    b.leaf(
        "theme",
        "string",
        "\"auto\"",
        Allowed::Form("a Theme's id, or \"auto\""),
        "The Theme to use, or \"auto\" to follow the OS's light or dark setting with dark_theme and light_theme.",
        "\"nord\"",
    );
    b.leaf(
        "dark_theme",
        "string",
        "\"roster-dark\"",
        THEME_ID,
        "The Theme \"auto\" picks while the OS is dark.",
        "\"tokyo-night\"",
    );
    b.leaf(
        "light_theme",
        "string",
        "\"roster-light\"",
        THEME_ID,
        "The Theme \"auto\" picks while the OS is light.",
        "\"paper\"",
    );
    b.add(
        "themes",
        Kind::Map,
        "table<string, roster.config.Theme>",
        "{}",
        Allowed::Any,
        "New Themes, or changed copies of bundled ones, by id: each a Theme spec.",
        "{ paper = { appearance = \"light\", colors = { accent = \"#b85c00\" } } }",
    );
    b.object(
        "themes.*",
        "roster.config.Theme",
        "roster.config.Theme",
        "A Theme spec: a bundled Theme (base) with tokens changed, or a new one.",
    );
    b.leaf(
        "themes.*.label",
        "string",
        UNSET,
        Allowed::Any,
        "Its name in the app; the id when left out.",
        "\"Paper\"",
    );
    b.leaf(
        "themes.*.appearance",
        "\"dark\"|\"light\"",
        UNSET,
        Allowed::OneOf(&["\"dark\"", "\"light\""]),
        "Which OS appearance it suits; the base's when left out.",
        "\"light\"",
    );
    b.leaf("themes.*.base", "string", UNSET, THEME_ID, "The Theme it starts from: every token it doesn't set comes from there (Roster dark, or Roster light for appearance = \"light\", when left out).", "\"nord\"");
    b.colours(
        "themes.*.colors",
        "roster.config.UiColors",
        ThemeColors::NAMES,
        "UI colour tokens over the base's.",
        "{ accent = \"#b85c00\" }",
    );
    b.colours(
        "themes.*.terminal",
        "roster.config.ThemeTerminalColors",
        ThemeTerminalColors::NAMES,
        "The terminal's colours, apart from the 16 ANSI ones, over the base's.",
        "{ background = \"#fdf6e3\" }",
    );
    b.colours("themes.*.ansi", "roster.config.Ansi", Ansi::NAMES, "The 16 ANSI colours; false keeps the standard palette even when the base has its own; the base's when left out.", "false");
    if let Some(ansi) = b.out.iter_mut().find(|o| o.path == "themes.*.ansi") {
        ansi.ty = "false|roster.config.Ansi".into();
        ansi.default = UNSET.into();
    }
    b.colours(
        "colors",
        "roster.config.UiColors",
        ThemeColors::NAMES,
        "UI colour tokens set over whichever Theme is in use.",
        "{ accent = \"#e8a33d\" }",
    );

    b.section = "Fonts and the terminal";
    b.object("fonts", "roster.config.Fonts", "roster.config.Fonts", "The UI's fonts.");
    b.leaf(
        "fonts.ui",
        "string",
        "\"Inter\"",
        Allowed::Form("a family name, or a CSS font stack (anything with a comma)"),
        "The UI's font.",
        "\"IBM Plex Sans\"",
    );
    b.leaf(
        "fonts.mono",
        "string",
        "\"Iosevka\"",
        Allowed::Form("a family name, or a CSS font stack"),
        "The wordmark's and code-like UI text's font.",
        "\"JetBrains Mono\"",
    );
    b.leaf(
        "fonts.ui_size",
        "integer",
        "15",
        Allowed::Range {
            min: 11.0,
            max: 20.0,
            unit: "px",
        },
        "The UI's text size; the smaller steps, the row height and the Sidebar's width follow it.",
        "16",
    );
    b.object(
        "ui",
        "roster.config.Ui",
        "roster.config.Ui",
        "The rest of the UI's look.",
    );
    b.leaf(
        "ui.hints",
        "boolean",
        UNSET,
        BOOL,
        "false hides every keycap hint. Unset, :hints decides and the State keeps its choice; set, it wins.",
        "false",
    );
    b.leaf("ui.messages", "\"quiet\"|\"all\"", UNSET, Allowed::OneOf(&["\"quiet\"", "\"all\""]), "What the message line shows: errors, warnings and answers only (\"quiet\"), or routine confirmations too (\"all\"). Unset, :messages decides.", "\"all\"");
    b.object(
        "terminal",
        "roster.config.Terminal",
        "roster.config.Terminal",
        "The terminal's font, look and behaviour.",
    );
    b.add(
        "terminal.font",
        Kind::List,
        "string|string[]",
        "{ \"Iosevka Nerd Font\", \"Iosevka Term\", \"Iosevka\" }",
        Allowed::Form("a font name, a CSS font stack, or a list of names"),
        "Font families, most wanted first: the first one installed is used.",
        "{ \"Fira Code\", \"Iosevka\" }",
    );
    b.leaf(
        "terminal.size",
        "number|string",
        "\"13pt\"",
        Allowed::Range {
            min: 6.0,
            max: 72.0,
            unit: "px (4.5 to 54 pt)",
        },
        "The font size: a number is px, \"16pt\" is points (as Windows Terminal converts them), \"21px\" works too.",
        "\"16pt\"",
    );
    b.leaf(
        "terminal.weight",
        "integer",
        "500",
        Allowed::Range {
            min: 100.0,
            max: 900.0,
            unit: "",
        },
        "The font weight; the bundled Iosevka has 400, 500 and 700.",
        "400",
    );
    b.leaf(
        "terminal.bold_weight",
        "integer",
        "700",
        Allowed::Range {
            min: 100.0,
            max: 900.0,
            unit: "",
        },
        "The weight of bold (SGR 1) text.",
        "800",
    );
    b.leaf(
        "terminal.bold_is_bright",
        "boolean",
        "true",
        BOOL,
        "Bold text in the bright ANSI colours too.",
        "false",
    );
    b.leaf(
        "terminal.line_height",
        "number",
        "1.0",
        Allowed::Range {
            min: 0.5,
            max: 3.0,
            unit: "",
        },
        "A multiple of the font's own line height.",
        "1.2",
    );
    b.leaf(
        "terminal.cell_height",
        "number",
        UNSET,
        Allowed::Range {
            min: 0.5,
            max: 3.0,
            unit: "",
        },
        "A multiple of the font size, as Windows Terminal's cellHeight; wins over line_height.",
        "1.1",
    );
    b.leaf(
        "terminal.renderer",
        "\"webgl\"|\"dom\"",
        "\"webgl\"",
        Allowed::OneOf(&["\"webgl\"", "\"dom\""]),
        "WebGL (fast) or the DOM (the browser's own text rendering).",
        "\"dom\"",
    );
    b.leaf(
        "terminal.cursor_style",
        "\"block\"|\"bar\"|\"underline\"",
        "\"block\"",
        Allowed::OneOf(&["\"block\"", "\"bar\"", "\"underline\""]),
        "The cursor's shape.",
        "\"bar\"",
    );
    b.leaf(
        "terminal.scrollback",
        "integer",
        "10000",
        Allowed::Range {
            min: 0.0,
            max: 1_000_000.0,
            unit: "lines",
        },
        "How many lines the terminal keeps above the screen.",
        "50000",
    );
    b.leaf(
        "terminal.copy_on_select",
        "boolean",
        "true",
        BOOL,
        "Selecting text copies it.",
        "false",
    );
    b.leaf(
        "terminal.right_click_paste",
        "boolean",
        "true",
        BOOL,
        "Right-click copies the selection, or pastes when there's none.",
        "false",
    );
    b.colours(
        "terminal.colors",
        "roster.config.TerminalColors",
        TerminalColors::NAMES,
        "Any terminal or ANSI colour, set over the Theme's.",
        "{ background = \"#101418\", red = \"#e06c75\" }",
    );
    b.leaf("terminal.shell_hooks", "boolean", UNSET, BOOL, "Send each Session's shell the line that turns on prompt marks (OSC 133) and its folder (OSC 7). Unset, a Host's shell_hooks in roster.yml decides.", "true");

    b.section = "Keys";
    b.leaf(
        "leader",
        "string",
        "\"Ctrl+Space\"",
        Allowed::Form("a chord: \"Ctrl+Space\", \"ctrl+b\", \"C-b\" or \"<C-b>\", with Ctrl, Alt or Meta"),
        "The chord that takes the keyboard back from a terminal.",
        "\"Ctrl+b\"",
    );
    b.leaf(
        "vim",
        "boolean",
        "true",
        BOOL,
        "j/k/h/l/gg/G in lists and the Picker.",
        "false",
    );
    b.object(
        "keys",
        "roster.config.Keys",
        "roster.config.Keys",
        "Key bindings, per context: key or sequence → action.",
    );
    for context in KeyContext::ALL {
        let name = context.lua_name();
        b.add(
            format!("keys.{name}"),
            Kind::Map,
            "table<string, roster.config.KeyAction>",
            "{}",
            Allowed::Any,
            format!(
                "{}: key or sequence (chords separated by spaces: \"d d\") → key action.",
                context_about(context)
            ),
            "{ [\"d d\"] = \"close\", [\"Ctrl+n\"] = false }",
        );
        b.add(
            format!("keys.{name}.*"),
            Kind::Leaf,
            "string|false",
            UNSET,
            Allowed::Form("a command line, exactly what you'd type after : (\"close\", \"session 1\"), or false"),
            "A key action: the command line a key runs, or false to unbind a default.",
            "\"session 1\"",
        )
        .class = Some("roster.config.KeyAction");
    }

    b.section = "Layout";
    b.leaf(
        "default_mode",
        "\"standard\"|\"focus\"",
        "\"standard\"",
        Allowed::OneOf(&["\"standard\"", "\"focus\""]),
        "The view mode at start (read at start only).",
        "\"focus\"",
    );
    b.leaf(
        "sessions",
        "\"sidebar\"|\"tabs\"",
        "\"sidebar\"",
        Allowed::OneOf(&["\"sidebar\"", "\"tabs\""]),
        "Open Sessions in the Sidebar, or in a tab strip.",
        "\"tabs\"",
    );
    b.object(
        "modes",
        "roster.config.Modes",
        "roster.config.Modes",
        "Each view mode's layout.",
    );
    for (mode, standard) in [("standard", true), ("focus", false)] {
        let p = |piece: &str| format!("modes.{mode}.{piece}");
        let yes_no = |on: bool| if on { "true" } else { "false" };
        b.object(
            format!("modes.{mode}"),
            "roster.config.Mode",
            "roster.config.Mode",
            &format!(
                "The {} mode's pieces; a piece left out keeps this mode's default.",
                if standard { "Standard" } else { "Focus" }
            ),
        );
        b.leaf(
            p("titlebar"),
            "boolean",
            yes_no(standard),
            BOOL,
            "The title bar.",
            yes_no(!standard),
        );
        {
            let o = b.add(
                p("sidebar"),
                Kind::Object,
                "boolean|roster.config.Sidebar",
                if standard { "{ side = \"left\" }" } else { "false" },
                Allowed::Form("true, false, or a table of the options below (which shows it)"),
                "The Sidebar: shown or hidden, the side it's on, and its sections.",
                "{ side = \"right\", sections = { \"sessions\", \"inventory\" } }",
            );
            o.class = Some("roster.config.Sidebar");
        }
        b.leaf(
            p("sidebar.side"),
            "\"left\"|\"right\"",
            "\"left\"",
            Allowed::OneOf(&["\"left\"", "\"right\""]),
            "The side of the window it's on.",
            "\"right\"",
        );
        b.add(
            p("sidebar.sections"),
            Kind::List,
            "string[]",
            UNSET,
            Allowed::Form("section ids in order: \"sessions\", \"folders\", \"inventory\", or a Plugin section's id"),
            "Its sections, in order; all of them when left out.",
            "{ \"sessions\", \"inventory\" }",
        );
        b.leaf(
            p("sessionbar"),
            "false|\"bottom\"|\"top\"",
            "false",
            Allowed::OneOf(&["false", "\"bottom\"", "\"top\""]),
            "The thin tmux-style bar of open Sessions, and its edge.",
            "\"top\"",
        );
        b.leaf(p("statusbar"), "boolean|string[]", yes_no(standard), Allowed::Form("true, false, or segments in order: \"backend\", \"box\", \"hosts\", \"path\", \"changes\", \"hints\", \"mode\""), "The status bar, and its segments.", "{ \"backend\", \"hosts\" }");
        b.leaf(
            p("fullscreen"),
            "boolean",
            yes_no(!standard),
            BOOL,
            "OS fullscreen.",
            yes_no(standard),
        );
        b.leaf(p("toolbar"), "boolean|string[]", yes_no(standard), Allowed::Form("true, false, or controls in order: \"sidebar\", \"find\", \"quick\", \"add\", \"changes\", \"publish\", \"details\", \"cmdline\", \"keys\", \"help\", \"lock\", \"mode\", or a Plugin control's id"), "The controls for common commands, in the title bar (or a bar of their own without one).", "{ \"add\", \"find\" }");
    }
    b.object(
        "panel",
        "roster.config.Panel",
        "roster.config.Panel",
        "What every panel and view starts with.",
    );
    b.leaf(
        "panel.width",
        "integer",
        UNSET,
        Allowed::Range {
            min: 10.0,
            max: 95.0,
            unit: "percent of the window",
        },
        "A docked panel's width, for every panel and view views doesn't give one. Unset, each keeps its own.",
        "40",
    );
    b.add(
        "views",
        Kind::Map,
        "table<string, roster.config.View>",
        "{}",
        Allowed::Any,
        "Per panel or view id (help, details, a Plugin view's id): where it opens first, and its width.",
        "{ topology = { place = \"panel\", width = 60 } }",
    );
    b.object(
        "views.*",
        "roster.config.View",
        "roster.config.View",
        "A view spec: one panel's or view's default place and width.",
    );
    b.leaf(
        "views.*.place",
        "\"panel\"|\"full\"",
        UNSET,
        Allowed::OneOf(&["\"panel\"", "\"full\""]),
        "Docked beside the terminal, or over the whole window.",
        "\"full\"",
    );
    b.leaf(
        "views.*.width",
        "integer",
        UNSET,
        Allowed::Range {
            min: 10.0,
            max: 95.0,
            unit: "percent of the window",
        },
        "Its docked width.",
        "60",
    );

    b.section = "Folders";
    b.add(
        "folders",
        Kind::List,
        "roster.config.Folder[]",
        "{}",
        Allowed::Any,
        "Folders kept in the Config, read-only in the app: each a Folder spec.",
        "{ { name = \"Lab\", hosts = { \"esx-02\", \"esx-03\" } } }",
    );
    b.object(
        "folders[]",
        "roster.config.Folder",
        "roster.config.Folder",
        "A Folder spec: a name and the Hosts in it.",
    );
    b.leaf(
        "folders[].name",
        "string",
        "required",
        Allowed::Form("unique, ignoring case, with no double quote"),
        "The Folder's name.",
        "\"Lab\"",
    );
    b.add(
        "folders[].hosts",
        Kind::List,
        "string[]",
        "{}",
        Allowed::Form("Host names"),
        "The Hosts in it, in order.",
        "{ \"esx-02\", \"esx-03\" }",
    );

    b.section = "The vault";
    b.object(
        "vault",
        "roster.config.Vault",
        "roster.config.Vault",
        "This Box's own vault settings, over roster.yml's providers. Paths and choices, never a secret.",
    );
    b.leaf(
        "vault.save_to",
        "\"personal\"|{ organization: string, collection: string }|{ group: string }",
        UNSET,
        Allowed::Form("\"personal\", { organization = …, collection = … } (Bitwarden) or { group = … } (KeePassXC)"),
        "Where Save to vault puts a new password by default.",
        "{ organization = \"My Team\", collection = \"Infra logins\" }",
    );
    b.object(
        "vault.kp",
        "roster.config.KeePassXC",
        "roster.config.KeePassXC",
        "KeePassXC's files, on the Box roster runs on.",
    );
    b.leaf(
        "vault.kp.database",
        "string",
        UNSET,
        Allowed::Form("an absolute path, or one starting with ~"),
        "KeePassXC's .kdbx.",
        "\"~/roster.kdbx\"",
    );
    b.leaf(
        "vault.kp.key_file",
        "string",
        UNSET,
        Allowed::Form("an absolute path, or one starting with ~"),
        "A key file used with the database's master password.",
        "\"~/roster.keyx\"",
    );

    b.section = "Packages";
    b.add(
        "packages",
        Kind::List,
        "(string|roster.config.Package)[]",
        "{}",
        Allowed::Any,
        "Plugins fetched from git repos and pinned in roster.lock: each a Package spec, or just its source.",
        "{ { \"someone/recent-alerts\", tag = \"v1.2.0\" }, \"someone/pinned\" }",
    );
    b.object(
        "packages[]",
        "roster.config.Package",
        "string|roster.config.Package",
        "A Package spec: { SOURCE, tag = …, config = { … } }, or just SOURCE.",
    );
    b.leaf(
        "packages[].source",
        "string",
        "required",
        Allowed::Form(
            "\"owner/repo\" (GitHub), or a git URL: https://…, ssh://…, git@host:path, file://… or a full path",
        ),
        "Where the repo is: the spec's first item, or source = ….",
        "\"someone/recent-alerts\"",
    );
    b.leaf(
        "packages[].name",
        "string",
        UNSET,
        Allowed::Any,
        "Its name (its folder and its line in roster.lock); the repo's (or dir's) name when left out.",
        "\"alerts\"",
    );
    b.leaf(
        "packages[].tag",
        "string",
        UNSET,
        Allowed::Any,
        "The tag to pin. At most one of tag, branch and commit; none means the default branch.",
        "\"v1.2.0\"",
    );
    b.leaf(
        "packages[].branch",
        "string",
        UNSET,
        Allowed::Any,
        "The branch to follow.",
        "\"main\"",
    );
    b.leaf(
        "packages[].commit",
        "string",
        UNSET,
        Allowed::Form("4 to 40 hex digits"),
        "The commit to pin.",
        "\"0a1b2c3d\"",
    );
    b.leaf(
        "packages[].dir",
        "string",
        UNSET,
        Allowed::Form("a folder inside the repo, relative, / between folders, no .."),
        "The repo's folder that holds the Plugin, when it isn't the top.",
        "\"plugins/alerts\"",
    );
    b.leaf(
        "packages[].config",
        "table",
        "{}",
        Allowed::Form("a table (never a function)"),
        "Settings the Package reads as roster.plugin.config.",
        "{ patterns = { \"ERROR\", \"panic\" } }",
    );
    b.leaf(
        "plugin_proxy",
        "string",
        UNSET,
        Allowed::Form("http://HOST:PORT, the port written out, with no user or password"),
        "The proxy Plugins' requests to public names go through. Unset, they go direct.",
        "\"http://10.0.0.5:3128\"",
    );

    b.section = "Other";
    b.leaf(
        "idle_lock_minutes",
        "integer",
        "15",
        Allowed::Range {
            min: 1.0,
            max: 1440.0,
            unit: "minutes",
        },
        "Lock after this many minutes without input.",
        "30",
    );
    b.leaf(
        "pull_fresh_minutes",
        "integer",
        "5",
        Allowed::Range {
            min: 0.0,
            max: 1440.0,
            unit: "minutes",
        },
        "How old the last pull of the infra repo may be before a form pulls again; 0 pulls every time.",
        "0",
    );
    b.leaf(
        "auto_reload",
        "boolean",
        "false",
        BOOL,
        "Reload on every save of a .lua file of the Config, and of roster.yml. Off, :source reloads.",
        "true",
    );
    b.leaf(
        "editor",
        "\"os\"|\"wsl\"",
        "\"os\"",
        Allowed::OneOf(&["\"os\"", "\"wsl\""]),
        "What :config opens init.lua with: the desktop's app for .lua files, or $EDITOR inside WSL.",
        "\"wsl\"",
    );
    b.leaf(
        "backend",
        "string",
        "\"auto\"",
        Allowed::Form("\"auto\", \"local\", \"wsl\" or \"wsl:<distro>\""),
        "Which roster the app runs: detected, this machine's, or WSL's.",
        "\"wsl:dev\"",
    );
    b.add("roster_command", Kind::List, "string|string[]", UNSET, Allowed::Form("roster itself: \"roster\", a path ending in /roster, or \"uv run --project <dir> roster\""), "The command that runs roster, for development: a command line (split on spaces) or a list of words. Unset, roster.", "\"uv run --project ~/work/roster roster\"");

    // An object's example: its first field's, as a table.
    for i in (0..b.out.len()).rev() {
        if b.out[i].kind == Kind::Object && b.out[i].example.is_empty() {
            let prefix = format!("{}.", b.out[i].path);
            let child = b.out.iter().find(|c| {
                c.path
                    .strip_prefix(&prefix)
                    .is_some_and(|rest| !rest.contains('.') && !rest.contains('['))
                    && !c.example.is_empty()
            });
            if let Some(c) = child {
                let name = c.path.rsplit('.').next().unwrap_or_default();
                b.out[i].example = format!("{{ {name} = {} }}", c.example);
            }
        }
    }
    b.out
}

fn context_about(context: KeyContext) -> &'static str {
    match context {
        KeyContext::Leader => "After the Leader",
        KeyContext::List => "In a list (the Sidebar)",
        KeyContext::ListVim => "In a list while vim keys are on",
        KeyContext::Picker => "In the Picker and every finder",
        KeyContext::PickerVim => "In the Picker's list while vim keys are on",
        KeyContext::Cmdline => "In the : command line",
        KeyContext::Terminal => "In a terminal, before the shell sees the key",
        KeyContext::Global => "Everywhere, with no Leader (keep it to keys a shell doesn't use)",
    }
}

const CONTEXTS: &str = "\"leader\"|\"list\"|\"list_vim\"|\"picker\"|\"picker_vim\"|\"cmdline\"|\"terminal\"|\"global\"";

pub(super) const API: &[ApiItem] = &[
    ApiItem {
        path: "roster.os",
        params: None,
        ty: "\"windows\"|\"linux\"|\"macos\"",
        about: "The OS the app runs on.",
        more: "",
        example: "if roster.os == \"windows\" then\n  roster.set(\"backend\", \"wsl\")\nend",
        neovim_style: false,
    },
    ApiItem {
        path: "roster.api_version",
        params: None,
        ty: "integer",
        about: "The version of this table, raised when it changes.",
        more: "",
        example: "if roster.api_version >= 4 then … end",
        neovim_style: false,
    },
    ApiItem {
        path: "roster.set",
        params: Some(&[
            Param {
                name: "name",
                ty: "roster.config.OptionName",
                about: "An option's dotted name: \"terminal.size\".",
            },
            Param {
                name: "value",
                ty: "any",
                about: "Its value, as the option takes it.",
            },
        ]),
        ty: "",
        about: "Sets any option by its dotted name.",
        more: "The name and the value are checked like the returned table's; an error points at the call's line. The returned table wins over a call that sets the same option.",
        example: "roster.set(\"terminal.size\", \"16pt\")",
        neovim_style: false,
    },
    ApiItem {
        path: "roster.keymap.set",
        params: Some(&[
            Param {
                name: "context",
                ty: CONTEXTS,
                about: "The keymap's context.",
            },
            Param {
                name: "keys",
                ty: "string",
                about: "A chord or a sequence of chords separated by spaces: \"Ctrl+n\", \"d d\".",
            },
            Param {
                name: "action",
                ty: "roster.config.KeyAction",
                about: "A command line, or false to unbind a default.",
            },
        ]),
        ty: "",
        about: "Binds a key, as `keys.<context>` does.",
        more: "",
        example: "roster.keymap.set(\"leader\", \"p\", \"connect esx-02\")",
        neovim_style: false,
    },
    ApiItem {
        path: "roster.themes.define",
        params: Some(&[
            Param {
                name: "id",
                ty: "string",
                about: "The Theme's id (not \"auto\").",
            },
            Param {
                name: "theme",
                ty: "roster.config.Theme",
                about: "A Theme spec.",
            },
        ]),
        ty: "",
        about: "Defines a Theme, as `themes.<id>` does.",
        more: "",
        example: "roster.themes.define(\"paper\", { appearance = \"light\", colors = { accent = \"#b85c00\" } })",
        neovim_style: false,
    },
    ApiItem {
        path: "roster.o",
        params: None,
        ty: "roster.config.Options",
        about: "Every option, as a table you assign to: roster.o.terminal.size = \"16pt\".",
        more: "Nested objects need no setup. An unknown name is an error at its line, with the name meant; reading gives the value set so far, or nil.",
        example: "roster.o.terminal.size = \"16pt\"\nif roster.o.vim then roster.o.keys.leader = { p = \"connect esx-02\" } end",
        neovim_style: true,
    },
    ApiItem {
        path: "roster.packages.add",
        params: Some(&[Param {
            name: "...",
            ty: "string|roster.config.Package",
            about: "Package specs.",
        }]),
        ty: "",
        about: "Adds Packages, from any file of the Config.",
        more: "Two Packages with the same name are an error naming both lines.",
        example: "roster.packages.add({ \"someone/recent-alerts\", tag = \"v1.2.0\" }, \"someone/pinned\")",
        neovim_style: true,
    },
    ApiItem {
        path: "roster.folders.add",
        params: Some(&[Param {
            name: "...",
            ty: "roster.config.Folder",
            about: "Folder specs.",
        }]),
        ty: "",
        about: "Adds Folders, from any file of the Config.",
        more: "Two Folders with the same name are an error naming both lines.",
        example: "roster.folders.add({ name = \"Lab\", hosts = { \"esx-02\", \"esx-03\" } })",
        neovim_style: true,
    },
];
