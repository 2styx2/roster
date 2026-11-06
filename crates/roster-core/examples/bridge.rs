//! The end-to-end bridge (roster-core shell/bridge.rs): the app's commands over a WebSocket on
//! 127.0.0.1, for app/e2e/fullstack. Never shipped: it needs the `bridge` feature.
//!
//! cargo run -p roster-core --features bridge --example bridge
//!
//! Prints `ROSTER_BRIDGE ws://127.0.0.1:PORT/?token=TOKEN` once it listens, then runs until its
//! stdin closes (the test that started it is done), when every Session ends. The Config, the
//! State and the Backend are found as the app finds them: from `HOME` (or `XDG_CONFIG_HOME`),
//! `ROSTER_APP_STATE_DIR` and `ROSTER_APP_ROSTER`.

use roster_core::shell::bridge::{self, Pages};
use roster_core::shell::{Places, Shell};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Arc;

fn main() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a port on 127.0.0.1");
    let port = listener.local_addr().expect("the port").port();
    let token = bridge::token();
    let pages = Pages::default();
    let shell = Arc::new(Shell::new(Places::of_system(|| None), pages.emitter()));
    shell.start_config();
    {
        let shell = Arc::clone(&shell);
        std::thread::spawn(move || {
            let _ = std::io::stdin().read_to_end(&mut Vec::new());
            shell.exit();
            std::process::exit(0);
        });
    }
    println!("ROSTER_BRIDGE ws://127.0.0.1:{port}/?token={token}");
    std::io::stdout().flush().expect("stdout");
    bridge::serve(listener, token, shell, pages);
}
