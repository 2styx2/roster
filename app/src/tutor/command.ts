// `:tutor [NAME]`, `:tutor quit` and `:tutor reset [NAME]` (ticket 55), registered through the
// command registry like any other command.
import { matching, type CommandDef } from "../commands/table";
import { BUILTIN } from "../registry";
import { quiet } from "../ui/messages";
import { DEFAULT_TUTORIAL, type TutorialDef, type TutorRegistry } from "./tutor";

export interface TutorActions {
  /** Starts `def` on the demo Inventory, or opens its page again if it's the one running. */
  start(def: TutorialDef): void;
  /** Leaves the demo Inventory; false when no tutorial is running. */
  quit(): boolean;
  /** Starts `def` over. */
  reset(def: TutorialDef): void;
}

const WORDS = ["quit", "reset"];

export function tutorCommand(tutorials: TutorRegistry, act: TutorActions): CommandDef {
  const find = (name: string | undefined): TutorialDef | string => {
    const id = name?.trim() || DEFAULT_TUTORIAL;
    return tutorials.get(id) ?? `No tutorial named ${id} (${tutorials.list().map((t) => t.id).join(", ")})`;
  };
  return {
    id: "tutor",
    source: BUILTIN,
    area: "App",
    arg: "text",
    optionalArg: true,
    label: (arg) =>
      arg === "quit"
        ? "Leave the tutorial's demo Inventory"
        : arg?.startsWith("reset")
          ? "Start the tutorial over"
          : arg
            ? `The ${arg} tutorial, on a demo Inventory`
            : "The tutorial: learn roster on a demo Inventory",
    doc: "Opens [the tutor](tutor) on a demo Inventory, made-up Hosts whose Sessions are pretend shells, so nothing you try reaches your network; your own Sessions keep running behind it. Its steps tick themselves as you do them, and it comes back where you left off. `:tutor quit` goes back to your Inventory; `:tutor reset` starts it over. `:tutor NAME` runs another tutorial, such as one a Plugin adds.",
    run: (ctx, arg) => {
      const [word, rest] = [arg?.trim().split(/\s+/)[0], arg?.trim().split(/\s+/).slice(1).join(" ")];
      if (word === "quit") {
        if (!act.quit()) ctx.say("No tutorial is running. :tutor starts one.");
        return;
      }
      const def = find(word === "reset" ? rest : arg);
      if (typeof def === "string") return ctx.say(def);
      if (word === "reset") {
        act.reset(def);
        return ctx.say(quiet(`${def.title}: started over.`));
      }
      act.start(def);
    },
    complete: (arg) => matching([...WORDS, ...tutorials.list().map((t) => t.id)], arg),
  };
}
