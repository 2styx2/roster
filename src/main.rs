//! roster: know your network. See roster(1).

mod add;
mod askpass;
mod atomic;
mod bw;
mod check;
mod claude;
mod hosts;
mod import;
mod inventory;
mod ls;
mod mesh;
mod pick;
mod plugin;
mod remote;
mod run;
mod setup;
mod ssh;
mod sshconf;
mod undo;
mod vault;
mod web;

/// Commands roster runs itself; any other name is a plugin.
const BUILTINS: &[&str] = &[
    "add", "check", "ls", "pick", "run", "setup", "ssh", "sync", "vault", "web", "help", "version",
];

use std::process::ExitCode;

const USAGE: &str = "\
usage: roster [-c FILE] COMMAND [ARGS]

commands:
  pick           pick Hosts with fzf and ssh to them: in tmux, Enter opens a
                 window, ctrl-v a split, Tab-marked Hosts synchronized panes
  ls [--json] [--long] [FILTER]
                 list Hosts: name, group, address, access, title;
                 FILTER: names, groups, types or products, comma-separated
  setup [--dry-run] [-v]
                 make this Box's key; write the ssh config for the Hosts and,
                 next to roster.yml, ROSTER.md and the Claude files; install
                 the Box key on each Enrolled Host (vault password, once);
                 make the Mesh: the Hosts of a `mesh: true` group ssh to
                 each other; --dry-run prints the plan (SOURCE -> PEER, and
                 each Host's changes) and changes nothing; routine skips
                 (unreviewed, Password, Windows) are one summary line, -v
                 lists each
  setup --undo [--dry-run]
                 remove what setup put on the Hosts (this Box's Mesh, then
                 its key line) and the Box (ssh config, Include, known_hosts,
                 ROSTER.md and Claude entries); the Box key is kept
  sync           import new `HOST ssh` items from Bitwarden into roster.yml
                 (when unlocked), then rewrite the Box files from roster.yml
                 (ssh config, Include, ROSTER.md, Claude files) and nothing
                 else: no Host, no key; quick enough for cron
  add NAME --ip ADDR [--group G] [--user U] [--port P] [--auth REF]
      [--enroll=false]
                 write a Host into roster.yml (comments kept), then sync
  add --from-vault ITEM [--name NAME] [--group G]
                 the same, from one Bitwarden item (name or id)
  ssh HOST [ARGS]
                 ssh to a Host by name; ARGS go to ssh unchanged; a Password
                 Host's auth password goes to ssh through askpass
  run [--json] TARGET -- CMD
                 run CMD on Hosts in parallel, lines prefixed `host: `;
                 TARGET: Hosts and groups, comma-separated; exit 1 if any
                 Host failed
  check [--json] [TARGET]
                 per Host: DNS, port, then a BatchMode ssh login (a Password
                 Host: its auth resolves); one line each; exit 1 on a failure
  web [-k] [-d BODY] [-H HEADER]... HOST [SERVICE] METHOD PATH
                 call a Host's web API with curl and the service's Login,
                 which goes to curl on stdin; exit 1 if the HTTP status is
                 400 or more
  vault unlock   unlock Bitwarden for 12 h (session key in the kernel keyring)
  vault lock     lock Bitwarden and forget the session key
  help plugins   how `roster NAME` runs a roster-NAME plugin from PATH
  version        print roster's version (also -V, --version)

options:
  -c FILE        the Inventory (default: $ROSTER_CONFIG, ./roster.yml,
                 then ~/.config/roster/roster.yml)
  -h, --help     print this help
  -V, --version  print roster's version

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

/// The Inventory, with every variable a secret may come from kept out of
/// each ssh and curl roster starts from here on.
fn open(config: Option<std::ffi::OsString>) -> Result<inventory::Inventory, Fail> {
    let inventory = inventory::Inventory::open(config.map(Into::into))?;
    remote::scrub(inventory.secret_vars());
    Ok(inventory)
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
    let mut target = None; // `check [TARGET]`
    let mut action = None; // `vault unlock|lock`
    let mut dry_run = false; // `setup --dry-run`
    let mut undo = false; // `setup --undo`
    let mut web = web::Args::default();
    let mut add = add::Args::default();
    while let Some(arg) = parser.next().map_err(|e| usage_error(e.to_string()))? {
        match arg {
            Short('h') | Long("help") => {
                print!("{USAGE}");
                return Ok(());
            }
            Short('V') | Long("version") => {
                println!("roster {}", env!("CARGO_PKG_VERSION"));
                return Ok(());
            }
            Short('c') | Long("config") => {
                config = Some(parser.value().map_err(|e| usage_error(e.to_string()))?);
            }
            Long("json") if matches!(command.as_deref(), Some("ls" | "run" | "check")) => {
                json = true
            }
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
            Long("dry-run") if command.as_deref() == Some("setup") => dry_run = true,
            Long("undo") if command.as_deref() == Some("setup") => undo = true,
            Short('v') | Long("verbose") if command.as_deref() == Some("setup") => {
                setup::set_verbose(true)
            }
            Long(
                f @ ("ip" | "group" | "user" | "port" | "auth" | "enroll" | "from-vault" | "name"),
            ) if command.as_deref() == Some("add") => {
                let f = f.to_string();
                let v = parser.value().map_err(|e| usage_error(e.to_string()))?;
                let v = v.string().map_err(|e| usage_error(e.to_string()))?;
                add.flags.push((f, v));
            }
            Value(v) if command.as_deref() == Some("add") && add.name.is_none() => {
                add.name = Some(v.string().map_err(|e| usage_error(e.to_string()))?)
            }
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
                let inventory = open(config)?;
                return run::run(&inventory, &target, cmd, json);
            }
            Value(v) if command.as_deref() == Some("check") && target.is_none() => {
                target = Some(v.string().map_err(|e| usage_error(e.to_string()))?)
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
                let inventory = open(config)?;
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
            let mut inventory = open(config)?;
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
        Some("check") => {
            let inventory = open(config)?;
            check::run(&inventory, target.as_deref(), json)
        }
        Some("setup") => {
            let inventory = open(config)?;
            setup::run(&inventory, dry_run, undo)
        }
        Some("add") => add::run(open(config)?, add),
        Some("sync") => {
            // The vault import first, so the Box files include its Hosts.
            let inventory = open(config)?;
            match import::sync(&inventory) {
                true => setup::box_files(&open(Some(inventory.path.into()))?),
                false => setup::box_files(&inventory),
            }
        }
        Some("ssh") => Err(usage_error("ssh needs a HOST")),
        Some("run") => Err(usage_error("run needs a TARGET and -- CMD")),
        Some("web") => web::run(&open(config)?, web),
        Some("vault") => match action.as_deref() {
            Some("unlock") => bw::unlock(),
            Some("lock") => bw::lock(),
            _ => Err(usage_error("vault needs unlock or lock")),
        },
        Some("help") => {
            print!("{}", if topic { plugin::HELP } else { USAGE });
            Ok(())
        }
        Some("version") => {
            println!("roster {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some("pick") => pick::run(&open(config)?),
        Some(other) => Err(usage_error(format!("unknown command '{other}'"))),
        None => {
            print!("{USAGE}");
            Ok(())
        }
    }
}
