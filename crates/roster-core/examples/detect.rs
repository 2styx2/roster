//! Detect and start the Backend on this machine, then print what it reports:
//! `cargo run --example detect [-- <roster command>]`. Without arguments it uses
//! ROSTER_APP_ROSTER (or the old ROSTER_DESK_ROSTER), then `roster`; ROSTER_APP_WSL_DISTRO picks the
//! WSL distro.
use roster_core::backend::Backend;
use roster_core::detect::{Os, SystemRunner, detect, roster_command};
use roster_core::env;
use serde_json::json;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = if args.is_empty() {
        roster_command(env::roster_override().as_deref())
    } else {
        args
    };
    let distro = env::wsl_distro();
    let started = detect(&SystemRunner, Os::current(), &cmd, distro.as_deref()).and_then(|c| {
        println!("{} -> {:?}", c.target.label(), c.serve_argv);
        Backend::start(&c, None)
    });
    match started {
        Ok(b) => {
            let hosts = b
                .call("hosts.list", json!({}))
                .map(|r| r["hosts"].as_array().map_or(0, Vec::len));
            println!("inventory: {}\nhosts.list: {hosts:?}", b.info.inventory);
        }
        Err(e) => println!("error: {e:#?}"),
    }
}
