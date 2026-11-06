//! The TypeScript types of what the core sends the frontend (the Config, the Windows Terminal
//! import, the Backend, Sessions, errors), generated from the Rust types (ts-rs) into
//! app/src/config/core.gen.ts. The test fails while the file is stale; to write it again:
//! `ROSTER_WRITE_TS=1 cargo test --test ts_types`.

use roster_core::backend::{BackendInfo, CheckStarted, CreateError, OpenedSession};
use roster_core::config::{self, *};
use roster_core::error::{BackendError, ErrorKind};
use roster_core::rpc::CallError;
use roster_core::wt::{DiffKind, DiffLine, Overridden, Preview, Previewed, Wins};
use std::path::Path;
use ts_rs::TS;

const FILE: &str = "app/src/config/core.gen.ts";

/// `T` as the file declares it: its docs, then `export type …`, an object one field a line.
fn decl<T: TS>(cfg: &ts_rs::Config) -> String {
    format!(
        "{}export {}",
        T::docs().unwrap_or_default(),
        one_field_a_line(&T::decl(cfg))
    )
}

/// `type X = { a: A, /** doc */ b: B, };` (ts-rs writes it on one line) as one field a line, each
/// after its doc. Any other declaration is left as it is.
fn one_field_a_line(decl: &str) -> String {
    let Some(open) = decl.find(" = { ") else {
        return decl.to_string();
    };
    let body = &decl[open + " = { ".len()..];
    let mut fields = Vec::new();
    let (mut depth, mut quoted, mut start) = (0i32, false, 0);
    let mut comment_ends = 0;
    for (i, c) in body.char_indices() {
        if i < comment_ends {
            continue;
        }
        if !quoted && body[i..].starts_with("/*") {
            comment_ends = i + body[i..].find("*/").map_or(body.len() - i, |e| e + 2);
            continue;
        }
        match c {
            '"' => quoted = !quoted,
            '{' | '<' | '(' | '[' if !quoted => depth += 1,
            '}' | '>' | ')' | ']' if !quoted && depth > 0 => depth -= 1,
            ',' if !quoted && depth == 0 => {
                fields.push(body[start..i].trim());
                start = i + 1;
            }
            // The object's own closing brace: anything after it (a union) is left as it is.
            '}' if !quoted => {
                if body[i..].trim() != "};" || !body[start..i].trim().is_empty() {
                    return decl.to_string();
                }
                let mut out = format!("{}{{\n", &decl[..open + " = ".len()]);
                for field in &fields {
                    for line in field.lines() {
                        out.push_str("  ");
                        out.push_str(line.trim_end());
                        out.push('\n');
                    }
                    out.pop();
                    out.push_str(",\n");
                }
                out.push_str("};");
                return out;
            }
            _ => {}
        }
    }
    decl.to_string()
}

fn generated() -> String {
    // serde_json sends every integer as a number.
    let cfg = ts_rs::Config::new().with_large_int("number");
    let decls = [
        // The Config (config/schema.rs, config/mod.rs).
        decl::<config::Report>(&cfg),
        decl::<config::ConfigError>(&cfg),
        decl::<Config>(&cfg),
        decl::<Location>(&cfg),
        decl::<DeprecatedUse>(&cfg),
        decl::<ThemeDef>(&cfg),
        decl::<Appearance>(&cfg),
        decl::<ThemeColors>(&cfg),
        decl::<ThemeTerminalColors>(&cfg),
        decl::<Ansi>(&cfg),
        decl::<AnsiChoice>(&cfg),
        decl::<TerminalColors>(&cfg),
        decl::<Fonts>(&cfg),
        decl::<Ui>(&cfg),
        decl::<MessagesLevel>(&cfg),
        decl::<Panel>(&cfg),
        decl::<ViewLayout>(&cfg),
        decl::<PanelPlace>(&cfg),
        decl::<Terminal>(&cfg),
        decl::<FontList>(&cfg),
        decl::<FontSize>(&cfg),
        decl::<Renderer>(&cfg),
        decl::<CursorStyle>(&cfg),
        decl::<ViewMode>(&cfg),
        decl::<SessionsIn>(&cfg),
        decl::<Keys>(&cfg),
        decl::<KeyBinding>(&cfg),
        decl::<KeyContext>(&cfg),
        decl::<KeyAction>(&cfg),
        decl::<Modes>(&cfg),
        decl::<ModeLayout>(&cfg),
        decl::<SidebarPiece>(&cfg),
        decl::<Side>(&cfg),
        decl::<SessionBarPiece>(&cfg),
        decl::<Edge>(&cfg),
        decl::<StatusBarPiece>(&cfg),
        decl::<ToolbarPiece>(&cfg),
        decl::<FolderDef>(&cfg),
        decl::<RosterCommand>(&cfg),
        decl::<BackendChoice>(&cfg),
        decl::<Editor>(&cfg),
        decl::<Vault>(&cfg),
        decl::<SaveTo>(&cfg),
        decl::<KeePassXc>(&cfg),
        decl::<PackageSpec>(&cfg),
        decl::<Opened>(&cfg),
        // `:config import-terminal` (wt.rs).
        decl::<Preview>(&cfg),
        decl::<DiffLine>(&cfg),
        decl::<DiffKind>(&cfg),
        decl::<Overridden>(&cfg),
        decl::<Wins>(&cfg),
        decl::<Previewed>(&cfg),
        // The Backend and Sessions (backend.rs, error.rs, rpc.rs).
        decl::<BackendInfo>(&cfg),
        decl::<BackendError>(&cfg),
        decl::<ErrorKind>(&cfg),
        decl::<CallError>(&cfg),
        decl::<CreateError>(&cfg),
        decl::<CheckStarted>(&cfg),
        decl::<OpenedSession>(&cfg),
        decl::<roster_core::session::Exit>(&cfg),
        decl::<roster_core::session::ExitMessage>(&cfg),
        decl::<roster_core::shell::PlatformInfo>(&cfg),
        decl::<roster_core::shell::FoldersFile>(&cfg),
        // Plugins and Packages (plugin/, package/).
        decl::<roster_core::plugin::By>(&cfg),
        decl::<roster_core::plugin::Manifest>(&cfg),
        decl::<roster_core::plugin::Described>(&cfg),
        decl::<roster_core::plugin::ManifestRead>(&cfg),
        decl::<roster_core::plugin::Loaded>(&cfg),
        decl::<roster_core::plugin::Reply>(&cfg),
        decl::<roster_core::plugin::PluginError>(&cfg),
        decl::<roster_core::shell::DemoReply>(&cfg),
        decl::<roster_core::plugin::network::SiteCount>(&cfg),
        decl::<roster_core::plugin::folder::DataUse>(&cfg),
        decl::<roster_core::package::Status>(&cfg),
        decl::<roster_core::package::Update>(&cfg),
        decl::<roster_core::package::Checked>(&cfg),
    ];
    format!(
        "// Generated from roster-core's Rust types by crates/roster-core/tests/ts_types.rs: don't edit.\n\
         // `ROSTER_WRITE_TS=1 cargo test --test ts_types` writes it again.\n\n{}\n",
        decls.join("\n\n")
    )
}

#[test]
fn the_typescript_types_match_the_rust_ones() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").join(FILE);
    let want = generated();
    if std::env::var_os("ROSTER_WRITE_TS").is_some() {
        std::fs::write(&path, &want).unwrap();
        return;
    }
    let have = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        have == want,
        "{FILE} is stale: run `ROSTER_WRITE_TS=1 cargo test --test ts_types`, then check the app"
    );
}
