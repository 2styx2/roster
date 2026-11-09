//! roster: know your network. See roster(1).

mod askpass;
mod atomic;
mod bw;
mod claude;
mod inventory;
mod ls;
mod pick;
mod plugin;
mod run;
mod setup;
mod ssh;
mod sshconf;
mod vault;
mod web;

/// Commands roster runs itself; any other name is a plugin.
const BUILTINS: &[&str] = &["ls", "run", "setup", "ssh", "vault", "web", "help"];

use std::process::ExitCode;

const USAGE: &str = "\
usage: roster [-c FILE] [COMMAND [ARGS]]

commands:
  (none)         pick Hosts with fzf and ssh to them: in tmux, Enter opens a
                 window, ctrl-v a split, Tab-marked Hosts synchronized panes
  ls [--json] [--long] [FILTER]
                 list Hosts: name, group, address, access, title;
                 FILTER: names, groups, types or products, comma-separated
  setup          make this Box's key; write the ssh config for the Hosts and,
                 next to roster.yml, ROSTER.md and the Claude files
  ssh HOST [ARGS]
                 ssh to a Host by name; ARGS go to ssh unchanged; a Password
                 Host's auth password goes to ssh through askpass
  run [--json] TARGET -- CMD
                 run CMD on Hosts in parallel, lines prefixed `host: `;
                 TARGET: Hosts and groups, comma-separated; exit 1 if any
                 Host failed
  web [-k] [-d BODY] [-H HEADER]... HOST [SERVICE] METHOD PATH
                 call a Host's web API with curl and the service's Login,
                 which goes to curl on stdin; exit 1 if the HTTP status is
                 400 or more
  vault unlock   unlock Bitwarden for 12 h (session key in the kernel keyring)
  vault lock     lock Bitwarden and forget the session key
  help plugins   how `roster NAME` runs a roster-NAME plugin from PATH

options:
  -c FILE        the Inventory (default: $ROSTER_CONFIG, ./roster.yml,
                 then ~/.config/roster/roster.yml)
  -h, --help     print this help

exit codes: 0 ok, 1 nothing matched or failed, 2 usage error, 3 the Inventory
won't load.
See roster(1) for details.
";

/// Why a command stopped. The code is the process exit code, part of the contract.
pub struct Fail {
    pub code: u8,
    pub msg: String,
}

pub fn usage_error(msg: impl Into<String>) -> Fail {
    Fail {
        code: 2,
        msg: format!("{} (see roster -h)", msg.into()),
    }
}

fn main() -> ExitCode {
    if let Some(socket) = std::env::var_os(askpass::VAR) {
        return askpass::helper(socket);
    }
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(fail) => {
            if !fail.msg.is_empty() {
                eprintln!("roster: {}", fail.msg);
            }
            ExitCode::from(fail.code)
        }
    }
}

fn run() -> Result<(), Fail> {
    use lexopt::prelude::*;
    let mut parser = lexopt::Parser::from_env();
    let mut config = None;
    let mut command = None;
    let mut json = false;
    let mut long = false; // `ls --long`
    let mut filter = None;
    let mut topic = false; // `help plugins`
    let mut action = None; // `vault unlock|lock`
    let mut web = web::Args::default();
    while let Some(arg) = parser.next().map_err(|e| usage_error(e.to_string()))? {
        match arg {
            Short('h') | Long("help") => {
                print!("{USAGE}");
                return Ok(());
            }
            Short('c') | Long("config") => {
                config = Some(parser.value().map_err(|e| usage_error(e.to_string()))?);
            }
            Long("json") if matches!(command.as_deref(), Some("ls" | "run")) => json = true,
            Long("long") if command.as_deref() == Some("ls") => long = true,
            Short(flag @ ('d' | 'H')) if command.as_deref() == Some("web") => {
                let v = parser.value().map_err(|e| usage_error(e.to_string()))?;
                let v = v.string().map_err(|e| usage_error(e.to_string()))?;
                match flag {
                    'd' => web.body = Some(v),
                    _ => web.headers.push(v),
                }
            }
            Short('k') if command.as_deref() == Some("web") => web.insecure = true,
            Value(v) if command.as_deref() == Some("ls") && filter.is_none() => {
                filter = Some(v.string().map_err(|e| usage_error(e.to_string()))?)
            }
            Value(v) if command.as_deref() == Some("run") => {
                let target = v.string().map_err(|e| usage_error(e.to_string()))?;
                let mut rest = parser.raw_args().map_err(|e| usage_error(e.to_string()))?;
                let cmd: Vec<_> = match rest.next() {
                    Some(dash) if dash == "--" => rest.collect(),
                    _ => return Err(usage_error("run needs -- before the command")),
                };
                let inventory = inventory::Inventory::open(config.map(Into::into))?;
                return run::run(&inventory, &target, cmd, json);
            }
            Value(v) if command.as_deref() == Some("help") && v == "plugins" && !topic => {
                topic = true
            }
            Value(v) if command.as_deref() == Some("vault") && action.is_none() => {
                action = Some(v.string().map_err(|e| usage_error(e.to_string()))?)
            }
            Value(v) if command.as_deref() == Some("web") => web
                .words
                .push(v.string().map_err(|e| usage_error(e.to_string()))?),
            Value(v) if command.as_deref() == Some("ssh") => {
                let host = v.string().map_err(|e| usage_error(e.to_string()))?;
                let args = parser.raw_args().map_err(|e| usage_error(e.to_string()))?;
                let args = args.collect();
                let inventory = inventory::Inventory::open(config.map(Into::into))?;
                return Err(ssh::exec(&inventory, &host, args));
            }
            Value(v) if command.is_none() => {
                let name = v.string().map_err(|e| usage_error(e.to_string()))?;
                if !BUILTINS.contains(&name.as_str()) {
                    let rest = parser.raw_args().map_err(|e| usage_error(e.to_string()))?;
                    return Err(plugin::exec(&name, config.map(Into::into), rest.collect()));
                }
                if let Some(shadow) = plugin::find(&name) {
                    eprintln!(
                        "roster: warning: {} is ignored: '{name}' is built-in",
                        shadow.display()
                    );
                }
                command = Some(name)
            }
            _ => return Err(usage_error(arg.unexpected().to_string())),
        }
    }
    match command.as_deref() {
        Some("ls") => {
            let mut inventory = inventory::Inventory::open(config.map(Into::into))?;
            if let Some(filter) = filter {
                inventory.hosts.retain(|h| h.matches(&filter));
                if inventory.hosts.is_empty() {
                    let msg = format!("'{filter}' matched no Host name, group, type or product");
                    return Err(Fail { code: 1, msg });
                }
            }
            let render = match (json, long) {
                (true, _) => ls::json,
                (_, true) => ls::long,
                _ => ls::text,
            };
            print!("{}", render(&inventory.hosts));
            Ok(())
        }
        Some("setup") => setup::run(&inventory::Inventory::open(config.map(Into::into))?),
        Some("ssh") => Err(usage_error("ssh needs a HOST")),
        Some("run") => Err(usage_error("run needs a TARGET and -- CMD")),
        Some("web") => web::run(&inventory::Inventory::open(config.map(Into::into))?, web),
        Some("vault") => match action.as_deref() {
            Some("unlock") => bw::unlock(),
            Some("lock") => bw::lock(),
            _ => Err(usage_error("vault needs unlock or lock")),
        },
        Some("help") => {
            print!("{}", if topic { plugin::HELP } else { USAGE });
            Ok(())
        }
        Some(other) => Err(usage_error(format!("unknown command '{other}'"))),
        None => pick::run(&inventory::Inventory::open(config.map(Into::into))?),
    }
}
