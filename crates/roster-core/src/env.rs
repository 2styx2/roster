//! The development env vars ([`OVERRIDE_VAR`], [`DISTRO_VAR`]). They were `ROSTER_DESK_*` while
//! the app was called roster-desk; those names are still read when the new one isn't set, so an
//! old shell profile or script keeps working. A blank value counts as not set.

/// The env var that overrides the roster command line (wins over `roster_command` in init.lua).
pub const OVERRIDE_VAR: &str = "ROSTER_APP_ROSTER";

/// The env var that names the one WSL distro to use (and start, if it's stopped).
pub const DISTRO_VAR: &str = "ROSTER_APP_WSL_DISTRO";

/// [`OVERRIDE_VAR`]'s name from when the app was roster-desk, still read when the new one isn't
/// set.
pub const LEGACY_OVERRIDE_VAR: &str = "ROSTER_DESK_ROSTER";

/// [`DISTRO_VAR`]'s name from when the app was roster-desk, still read as a fallback.
pub const LEGACY_DISTRO_VAR: &str = "ROSTER_DESK_WSL_DISTRO";

/// `name`'s value, else `legacy`'s, looked up with `var`. Blank values don't count.
pub fn var_or_legacy(name: &str, legacy: &str, var: impl Fn(&str) -> Option<String>) -> Option<String> {
    let set = |n: &str| var(n).filter(|v| !v.trim().is_empty());
    set(name).or_else(|| set(legacy))
}

/// The roster command override: `ROSTER_APP_ROSTER`, else `ROSTER_DESK_ROSTER`.
pub fn roster_override() -> Option<String> {
    var_or_legacy(OVERRIDE_VAR, LEGACY_OVERRIDE_VAR, system_var)
}

/// The one WSL distro to use: `ROSTER_APP_WSL_DISTRO`, else `ROSTER_DESK_WSL_DISTRO`.
pub fn wsl_distro() -> Option<String> {
    var_or_legacy(DISTRO_VAR, LEGACY_DISTRO_VAR, system_var)
}

/// Where the State file goes instead of the OS's local app-data dir. For a test or perf copy of the
/// app (app/scripts/perf.sh) that must never touch the real State; nobody needs it day to day.
pub const STATE_DIR_VAR: &str = "ROSTER_APP_STATE_DIR";

/// [`STATE_DIR_VAR`]'s folder, if it's set (not blank).
pub fn state_dir() -> Option<std::path::PathBuf> {
    state_dir_for(system_var)
}

/// [`state_dir`] for any environment (testable).
pub fn state_dir_for(var: impl Fn(&str) -> Option<String>) -> Option<std::path::PathBuf> {
    var(STATE_DIR_VAR)
        .filter(|v| !v.trim().is_empty())
        .map(std::path::PathBuf::from)
}

/// The app's own data folder, for the State, Packages' clones and Plugins' data: [`state_dir`] if
/// it's set, else `app_local` (the OS's local app-data dir for the app, from Tauri).
pub fn data_dir(app_local: impl FnOnce() -> Option<std::path::PathBuf>) -> Option<std::path::PathBuf> {
    state_dir().or_else(app_local)
}

fn system_var(name: &str) -> Option<String> {
    std::env::var(name).ok()
}
