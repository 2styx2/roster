//! The roster app's core, with no Tauri dependency: finding a Backend, talking to `roster serve`, and
//! running Sessions in PTYs.

pub mod backend;
pub mod browser;
pub mod config;
pub mod detect;
pub mod env;
pub mod error;
pub mod migrate;
pub mod package;
pub mod platform;
pub mod plugin;
pub mod rpc;
mod screen;
pub mod session;
pub mod slot;
pub mod state;
mod wcwidth;
pub mod window;
pub mod wt;
