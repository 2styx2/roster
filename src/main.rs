//! roster: know your network. See roster(1).

mod inventory;
mod ls;
mod plugin;

/// Commands roster runs itself; any other name is a plugin.
const BUILTINS: &[&str] = &["ls"];

use std::process::ExitCode;

const USAGE: &str = "\
usage: roster [-c FILE] COMMAND [ARGS]

commands:
  ls [--json]    list Hosts: name, group, address, access, title

options:
  -c FILE        the Inventory (default: $ROSTER_CONFIG, ./roster.yml,
                 then ~/.config/roster/roster.yml)
  -h, --help     print this help

exit codes: 0 ok, 2 usage error, 3 the Inventory won't load.
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
            Value(v) if command.is_none() => {
                let name = v.string().map_err(|e| usage_error(e.to_string()))?;
                if !BUILTINS.contains(&name.as_str()) {
                    let rest = parser.raw_args().map_err(|e| usage_error(e.to_string()))?;
                    return Err(plugin::exec(&name, config.map(Into::into), rest.collect()));
                }
                command = Some(name)
            }
            _ => return Err(usage_error(arg.unexpected().to_string())),
        }
    }
    match command.as_deref() {
        Some("ls") => {
            let inventory = inventory::Inventory::open(config.map(Into::into))?;
            let render = if json { ls::json } else { ls::text };
            print!("{}", render(&inventory.hosts));
            Ok(())
        }
        Some(other) => Err(usage_error(format!("unknown command '{other}'"))),
        None => Err(usage_error("no command given")),
    }
}
