//! `:config` (ticket 32): make sure `init.lua` exists, then open it in the user's editor.
//!
//! The first time, the file is created from `examples/init.lua` with every line commented out,
//! so creating it changes nothing until the user uncomments something. An existing file is never
//! touched. It opens with the OS's app for the file, or (`editor = "wsl"`) with `$EDITOR` inside
//! the Backend's WSL distro, in a console window of its own. `:source` applies it, as any change
//! (or a save, with `auto_reload`).
//!
//! On Windows "the OS's app" is the one registered for `.lua`'s **edit** verb, else Notepad.
//! Never the "open" verb: with Lua installed, `.lua` usually opens with the interpreter, which
//! would run init.lua instead of showing it.

use super::{FILE_NAME, Os};
use std::io::Write;
use std::path::{Path, PathBuf};

/// examples/init.lua: every option with its default and a comment, one `roster.o` line each.
const EXAMPLE: &str = include_str!("../../../../examples/init.lua");

const HEADER: &str = "\
-- Made by the roster app's :config from its example (examples/init.lua in the roster repo).
-- Every line is commented out, so this file changes nothing yet: uncomment a `roster.o` line
-- (each one stands alone), change its value, save, and run :source (Leader S) to apply it.
--
";

/// The file `:config` creates: the example with every line of code commented out.
pub fn starter() -> String {
    let mut out = String::from(HEADER);
    for line in EXAMPLE.lines() {
        let t = line.trim_start();
        if t.is_empty() || t.starts_with("--") {
            out.push_str(line);
        } else {
            out.push_str("-- ");
            out.push_str(line);
        }
        out.push('\n');
    }
    out
}

/// Where init.lua is, and whether [`ensure_file`] just made it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ensured {
    pub path: PathBuf,
    pub created: bool,
}

/// What `:config` did (ticket 32): init.lua's full path, and whether it was just made.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(rename = "ConfigOpened"))]
pub struct Opened {
    pub path: String,
    /// It was just made, from the example with every option commented out.
    pub created: bool,
}

/// `:config`: makes `dir/init.lua` from [`starter`] if there's none (never overwriting one), then
/// opens it with `editor` on this machine. `$EDITOR` runs in `distro`, the Backend's WSL distro.
pub fn edit(dir: &Path, editor: super::Editor, distro: Option<&str>) -> Result<Opened, String> {
    let ensured = ensure_file(dir).map_err(|e| format!("can't create {}: {e}", dir.display()))?;
    let how = open_with(editor, Os::current(), &ensured.path, distro)?;
    open(&how).map_err(|e| format!("can't open {}: {e}", ensured.path.display()))?;
    Ok(Opened {
        path: ensured.path.display().to_string(),
        created: ensured.created,
    })
}

/// Makes `dir/init.lua` from [`starter`] if there's no file there yet (and the dir with it).
/// Never overwrites: the file is created only if it doesn't exist, in one step.
pub fn ensure_file(dir: &Path) -> std::io::Result<Ensured> {
    let path = dir.join(FILE_NAME);
    std::fs::create_dir_all(dir)?;
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut f) => {
            f.write_all(starter().as_bytes())?;
            Ok(Ensured { path, created: true })
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(Ensured { path, created: false }),
        Err(e) => Err(e),
    }
}

/// How to open the file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenWith {
    /// The OS's app for editing the file (Windows: [`windows_open`]'s choice).
    Default(PathBuf),
    /// A program and its arguments; `new_console` gives it a console window (Windows).
    Program { argv: Vec<String>, new_console: bool },
}

/// `$EDITOR` (vi if unset) on the file, its Windows path turned into a Linux one. The path is
/// `$1`, never part of the script.
const WSL_SCRIPT: &str = r#"exec ${EDITOR:-vi} "$(wslpath -u "$1")""#;

/// How `editor` opens `path` on `os`. `distro`: the Backend's WSL distro, if it runs in one.
pub fn open_with(editor: super::Editor, os: Os, path: &Path, distro: Option<&str>) -> Result<OpenWith, String> {
    let file = path.display().to_string();
    match (editor, os) {
        (super::Editor::Os, Os::Windows) => Ok(OpenWith::Default(path.to_path_buf())),
        (super::Editor::Os, Os::Macos) => Ok(OpenWith::Program {
            argv: vec!["open".into(), file],
            new_console: false,
        }),
        (super::Editor::Os, Os::Linux) => Ok(OpenWith::Program {
            argv: vec!["xdg-open".into(), file],
            new_console: false,
        }),
        (super::Editor::Wsl, Os::Windows) => {
            let mut argv = vec!["wsl.exe".to_string()];
            if let Some(d) = distro {
                argv.extend(["-d".into(), d.to_string()]);
            }
            argv.extend(
                ["--exec", "bash", "-lic", WSL_SCRIPT, "roster-config"]
                    .iter()
                    .map(|s| s.to_string()),
            );
            argv.push(file);
            Ok(OpenWith::Program {
                argv,
                new_console: true,
            })
        }
        (super::Editor::Wsl, _) => Err("editor = \"wsl\" works on Windows only; use \"os\" here".into()),
    }
}

/// How Windows opens init.lua for `editor = "os"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowsOpen {
    /// ShellExecute's "edit" verb: the app registered to edit `.lua` files.
    EditVerb,
    /// Notepad, which is always there.
    Notepad,
}

/// The choice, given `has_app(verb)`: whether the registry has an app for `.lua`'s verb. Only
/// "edit" is asked about. "open" never is, since it may be a Lua interpreter that runs the file.
pub fn windows_open(has_app: impl Fn(&str) -> bool) -> WindowsOpen {
    if has_app("edit") {
        WindowsOpen::EditVerb
    } else {
        WindowsOpen::Notepad
    }
}

/// Starts the editor and doesn't wait for it.
pub fn open(how: &OpenWith) -> std::io::Result<()> {
    match how {
        OpenWith::Default(path) => open_default(path),
        OpenWith::Program { argv, new_console } => {
            let (program, args) = argv.split_first().ok_or_else(|| std::io::Error::other("no program"))?;
            let mut cmd = std::process::Command::new(program);
            cmd.args(args);
            #[cfg(windows)]
            if *new_console {
                use std::os::windows::process::CommandExt;
                const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
                cmd.creation_flags(CREATE_NEW_CONSOLE);
            }
            #[cfg(not(windows))]
            let _ = new_console;
            let mut child = cmd.spawn()?;
            // Reap it when it exits (xdg-open hands off and ends at once).
            std::thread::spawn(move || child.wait());
            Ok(())
        }
    }
}

#[cfg(windows)]
fn open_default(path: &Path) -> std::io::Result<()> {
    // The "edit" verb's app if there is one (never "open": see windows_open); else Notepad,
    // rather than Windows' "Pick an app".
    if windows_open(|verb| win::has_app(path, verb)) == WindowsOpen::EditVerb && win::shell_execute(path, "edit") {
        return Ok(());
    }
    std::process::Command::new("notepad.exe").arg(path).spawn().map(|_| ())
}

#[cfg(not(windows))]
fn open_default(path: &Path) -> std::io::Result<()> {
    open(&OpenWith::Program {
        argv: vec!["xdg-open".into(), path.display().to_string()],
        new_console: false,
    })
}

#[cfg(windows)]
pub(crate) mod win {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    #[link(name = "shell32")]
    unsafe extern "system" {
        fn ShellExecuteW(
            hwnd: *mut c_void,
            op: *const u16,
            file: *const u16,
            params: *const u16,
            dir: *const u16,
            show: i32,
        ) -> isize;
    }

    #[link(name = "shlwapi")]
    unsafe extern "system" {
        fn AssocQueryStringW(
            flags: u32,
            what: u32,
            assoc: *const u16,
            extra: *const u16,
            out: *mut u16,
            out_len: *mut u32,
        ) -> i32;
    }

    /// Whether Windows has an app for `verb` on files like `path` (by its extension).
    pub fn has_app(path: &Path, verb: &str) -> bool {
        let Some(ext) = path.extension() else { return false };
        let mut dotted = std::ffi::OsString::from(".");
        dotted.push(ext);
        let assoc = wide(&dotted);
        let verb = wide(std::ffi::OsStr::new(verb));
        const ASSOCSTR_EXECUTABLE: u32 = 2;
        // Without it, an unknown extension "has" OpenWith.exe, the "Pick an app" dialog.
        const ASSOCF_INIT_IGNOREUNKNOWN: u32 = 0x400;
        let mut len = 0u32;
        // SAFETY: NUL-terminated UTF-16 strings; a null `out` asks only for the length.
        let hr = unsafe {
            AssocQueryStringW(
                ASSOCF_INIT_IGNOREUNKNOWN,
                ASSOCSTR_EXECUTABLE,
                assoc.as_ptr(),
                verb.as_ptr(),
                std::ptr::null_mut(),
                &mut len,
            )
        };
        hr >= 0
    }

    #[link(name = "ole32")]
    unsafe extern "system" {
        fn CoInitializeEx(reserved: *mut c_void, flags: u32) -> i32;
        fn CoUninitialize();
    }

    fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    /// ShellExecute with `verb` on its own thread, with COM set up as the docs ask. False when
    /// Windows has no app for it (or it failed).
    pub fn shell_execute(path: &Path, verb: &str) -> bool {
        let file = wide(path.as_os_str());
        let op = wide(std::ffi::OsStr::new(verb));
        std::thread::spawn(move || {
            const COINIT_APARTMENTTHREADED: u32 = 0x2;
            const COINIT_DISABLE_OLE1DDE: u32 = 0x4;
            const SW_SHOWNORMAL: i32 = 1;
            // SAFETY: plain Win32 calls with NUL-terminated UTF-16 strings that outlive them.
            unsafe {
                let hr = CoInitializeEx(std::ptr::null_mut(), COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
                let r = ShellExecuteW(
                    std::ptr::null_mut(),
                    op.as_ptr(),
                    file.as_ptr(),
                    std::ptr::null(),
                    std::ptr::null(),
                    SW_SHOWNORMAL,
                );
                if hr >= 0 {
                    CoUninitialize();
                }
                // Above 32 is success.
                r > 32
            }
        })
        .join()
        .unwrap_or(false)
    }
}
