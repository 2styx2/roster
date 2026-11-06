// `:config` (ticket 32): opens init.lua (making it first if there's none), reads it again, says
// where it is, copies Windows Terminal's profile in (ticket 33) or writes the option types.
import { BUILTIN } from "../registry";
import type { AppContext, CommandDef } from "../commands/table";

/** Each thing `:config` does, and its label; `open` is `:config` alone. */
const ACTIONS = {
  open: "Open init.lua, the Config",
  reload: "Read init.lua again",
  path: "Say where init.lua is",
  "import-terminal": "Copy Windows Terminal's font and colours into init.lua",
  types: "Write the option types for your editor (types/roster-config.lua)",
} as const;

export type ConfigAction = keyof typeof ACTIONS;

/** What `:config` asks of the app. */
export interface ConfigContext {
  /** `:config` (ticket 32): opens init.lua (making it first if there's none), reads it again,
   * or says where it is. */
  config(what: ConfigAction): void;
}

/** What's typed after `config`. */
const SUBCOMMANDS = (Object.keys(ACTIONS) as ConfigAction[]).filter((a) => a !== "open");

export const configCommand: CommandDef<ConfigContext & AppContext> = {
  id: "config",
  source: BUILTIN,
  area: "App",
  seldom: true,
  arg: "text",
  optionalArg: true,
  label: (what) => ACTIONS[SUBCOMMANDS.find((a) => a === what) ?? "open"],
  run: (ctx, what) => {
    if (what === undefined) return ctx.config("open");
    const action = SUBCOMMANDS.find((a) => a === what.toLowerCase());
    if (!action) return ctx.say(`config takes nothing, ${SUBCOMMANDS.slice(0, -1).join(", ")} or ${SUBCOMMANDS.at(-1)}`);
    ctx.config(action);
  },
  complete: (what) => SUBCOMMANDS.filter((a) => a.startsWith(what.toLowerCase())),
};
