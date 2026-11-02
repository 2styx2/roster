// `:source` (`:so`), Neovim-style reloading (decision Q58): saving a Config file doesn't reload
// it unless `auto_reload = true`; `:source` reloads every Config file now, and `:source PATH`
// only the one that owns PATH. What can be reloaded is a registry (ADR 0006): init.lua (with its
// Lua modules) registers here, and ticket 28's roster.yml registers the same way.
import type { CommandDef } from "../commands/table";
import { BUILTIN, Registry, type Entry } from "../registry";
import { quiet, type Message } from "../ui/messages";

/** A Config file `:source` reloads; its id is how it's named ("init.lua"). */
export interface ReloaderDef extends Entry {
  /** The files `:source` completes for it, relative to the config dir ("init.lua"). */
  files(): readonly string[];
  /** Whether `path` (as typed: relative, or the full path) is one of its files. */
  owns(path: string): boolean;
  /** What a PATH that matches nothing should say it takes ("init.lua and its .lua modules"). */
  describe: string;
  /** Reloads; resolves with a message when it couldn't (an error shows elsewhere too), else null. */
  reload(): Promise<string | null>;
}

export type ReloaderRegistry = Registry<ReloaderDef>;

export function reloaderRegistry(): ReloaderRegistry {
  return new Registry<ReloaderDef>();
}

/** Reloads `which` (every reloader when it's empty) and says what happened: quiet when all went
 * well (ticket 111), else what went wrong, always. */
async function reloadAll(which: readonly ReloaderDef[], say: (m: Message) => void) {
  const results = await Promise.all(which.map(async (r) => ({ id: r.id, problem: await r.reload().catch((e: unknown) => String(e)) })));
  const failed = results.filter((r) => r.problem !== null);
  const done = results.filter((r) => r.problem === null).map((r) => r.id);
  const parts = [
    ...(done.length ? [`Reloaded ${done.join(", ")}`] : []),
    ...failed.map((r) => r.problem as string),
  ];
  say(failed.length ? parts.join(". ") : quiet(parts.join(". ")));
}

/** `source [PATH]` and its alias `so`. */
export function sourceCommands(reloaders: Pick<ReloaderRegistry, "list">): CommandDef[] {
  const def = (id: string): CommandDef => ({
    id,
    source: BUILTIN,
    area: "App",
    seldom: true,
    arg: "text",
    optionalArg: true,
    label: (path) => (path ? `Reload ${path}` : "Reload the Config now (init.lua)"),
    run: (ctx, path) => {
      const all = reloaders.list();
      if (all.length === 0) return ctx.say("Nothing to reload here: this window has no Config");
      if (path === undefined) return void reloadAll(all, ctx.say);
      const owner = all.find((r) => r.owns(path));
      if (!owner) return ctx.say(`Not a Config file: ${path} (${all.map((r) => r.describe).join("; ")})`);
      void reloadAll([owner], ctx.say);
    },
    complete: (arg) =>
      reloaders
        .list()
        .flatMap((r) => r.files())
        .filter((f) => f.startsWith(arg)),
  });
  return [def("source"), def("so")];
}

/** init.lua and its Lua modules: one file in effect, reloaded whole. */
export function initLuaReloader(opts: {
  /** init.lua's full path, once known. */
  path(): string | null;
  /** Reads init.lua again and applies the result; null when there's no config dir. */
  reload(): Promise<{ error: { file: string; line: number | null; message: string } | null } | null>;
}): ReloaderDef {
  return {
    id: "init.lua",
    source: BUILTIN,
    describe: "init.lua and its .lua modules",
    files: () => ["init.lua"],
    owns: (p) => {
      const path = p.trim();
      return path.toLowerCase().endsWith(".lua") || path === opts.path();
    },
    async reload() {
      const r = await opts.reload();
      if (!r) return "There's no config folder here";
      if (!r.error) return null;
      const at = `${r.error.file}${r.error.line ? `:${r.error.line}` : ""}`;
      return `${at} has an error: the last good Config is still in use`;
    },
  };
}
