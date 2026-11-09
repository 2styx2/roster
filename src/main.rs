//! roster: know your network. See roster(1).

mod atomic;
mod inventory;
mod ls;
mod plugin;
mod setup;
mod sshconf;

/// Commands roster runs itself; any other name is a plugin.
const BUILTINS: &[&str] = &["ls", "setup", "help"];

use std::process::ExitCode;

const USAGE: &str = "\
usage: roster [-c FILE] COMMAND [ARGS]

commands:
  ls [--json] [FILTER]
                 list Hosts: name, group, address, access, title;
                 FILTER: names, groups, types or products, comma-separated
  help plugins   how `roster NAME` runs a roster-NAME plugin from PATH

options:
  -c FILE        the Inventory (default: $ROSTER_CONFIG, ./roster.yml,
                 then ~/.config/roster/roster.yml)
  -h, --help     print this help

exit codes: 0 ok, 1 nothing matched, 2 usage error, 3 the Inventory
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
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(fail) => {
            eprintln!("roster: {}", fail.msg);
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
    let mut filter = None;
    let mut topic = false; // `help plugins`
    while let Some(arg) = parser.next().map_err(|e| usage_error(e.to_string()))? {
        match arg {
            Short('h') | Long("help") => {
                print!("{USAGE}");
                return Ok(());
            }
            Short('c') | Long("config") => {
                config = Some(parser.value().map_err(|e| usage_error(e.to_string()))?);
            }
            Long("json") if command.as_deref() == Some("ls") => json = true,
            Value(v) if command.as_deref() == Some("ls") && filter.is_none() => {
                filter = Some(v.string().map_err(|e| usage_error(e.to_string()))?)
            }
            Value(v) if command.as_deref() == Some("help") && v == "plugins" && !topic => {
                topic = true
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
            let render = if json { ls::json } else { ls::text };
            print!("{}", render(&inventory.hosts));
            Ok(())
        }
        Some("setup") => setup::run(&inventory::Inventory::open(config.map(Into::into))?),
        Some("help") => {
            print!("{}", if topic { plugin::HELP } else { USAGE });
            Ok(())
        }
        Some(other) => Err(usage_error(format!("unknown command '{other}'"))),
        None => Err(usage_error("no command given")),
    }
}
