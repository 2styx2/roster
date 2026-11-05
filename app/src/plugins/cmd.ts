// What a Plugin's command line may run (ticket 78, decision Q98): `roster.cmd(line)`, and a `run`
// that's a line (a row's, a button's, a finder item's, a toolbar control's). The core decides
// `roster.cmd` first; this is the app's side of the same rule, for both: the Plugin's own commands,
// and only the commands of roster's the core's table lists (plugin/api COMMANDS, in
// plugin-api.json), each with the permission it needs there. Never `:plugins`, `:packages`,
// `:publish` or another Plugin's commands.
import { commands, roster_only } from "../../../crates/roster-core/tests/fixtures/plugin-api.json?pick=api_version,commands,roster_only,tags";
import { BUILTIN } from "../registry";

interface CommandRule {
  name: string;
  permission: string | null;
}

export const PLUGIN_COMMANDS: readonly CommandRule[] = commands as CommandRule[];

/** roster's commands that change trust or writes (plugin/api's ROSTER_ONLY): never a Plugin's own,
 * even before the app has told the core its built-in commands (`pluginBuiltins`, issue #184). */
export const ROSTER_ONLY: readonly string[] = roster_only;

/** Why `plugin` (granted `granted`) may not run `line`, or null when it may. `sourceOf` is the
 * command table's: who registered the command named so (undefined: there's none). */
export function lineRefused(line: string, plugin: string, granted: readonly string[], sourceOf: (name: string) => string | undefined): string | null {
  const word = line.trim().split(/\s+/)[0] ?? "";
  if (!word) return "which command?";
  const source = sourceOf(word);
  if (source === plugin) return null;
  const rule = PLUGIN_COMMANDS.find((c) => c.name === word);
  if (!rule || source !== BUILTIN) return `:${word} isn't one a Plugin may run`;
  if (rule.permission && !granted.includes(rule.permission)) return `:${word} needs the ${rule.permission} permission`;
  return null;
}
