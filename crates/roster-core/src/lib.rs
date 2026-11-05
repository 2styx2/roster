//! The roster app's core, with no Tauri dependency: finding a Backend, talking to `roster serve`, and
//! running Sessions in PTYs.

pub mod anchor;
pub mod backend;
pub mod browser;
pub mod config;
pub mod detect;
pub mod env;
pub mod error;
pub mod files;
pub mod migrate;
pub mod package;
pub mod platform;
pub mod plugin;
pub mod process;
pub mod proxy;
pub mod rpc;
mod screen;
pub mod serve_api;
pub mod session;
pub mod slot;
pub mod state;
mod wcwidth;
pub mod window;
pub mod wipe;
pub mod wt;

/// The version of the `roster` Lua module (`roster.api_version`) Plugins are written against;
/// init.lua's table shows it too. init.lua's own version is `config::CONFIG_VERSION` (decision Q165).
pub const API_VERSION: u32 = 6;
