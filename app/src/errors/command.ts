// `:check`: a Host's diagnostics, this Box's health, or Stop for the app's own check.
import type { AppContext, CommandDef } from "../commands/table";
import { matching } from "../ui/completion";
import { BUILTIN } from "../registry";
import type { SessionContext } from "../session/commands";

/** What `:check` asks of the app. */
export interface CheckContext {
  /** Runs roster's diagnostics (`host.check`) for the Host. */
  checkHost(host: string): void;
  /** This Box's health (`:help health`). */
  checkBox(): void;
  /** Stops the app's own check, as the check panel's Stop does, or says why it can't. */
  stopCheck(): void;
}

export const checkCommand: CommandDef<CheckContext & Pick<SessionContext, "sessionOnScreen"> & AppContext> = {
  id: "check",
  source: BUILTIN,
  area: "Hosts",
  arg: "host",
  optionalArg: true,
  label: (h) =>
    h === "stop"
      ? "Stop the app's own check that's running, as the check panel's Stop (x) does"
      : h
        ? `Check ${h}`
        : "Check this Box's health: roster.yml, ssh, the vault, askpass, init.lua, the font, Plugins' sections. With a Host (% for the one on screen): why a Session to it would fail. stop stops the app's own check",
  run: (ctx, h) => {
    if (h === undefined) return ctx.checkBox();
    // `:check stop` (#361): Stop's command. A Host named stop is still checked by it.
    if (h === "stop" && !ctx.hostNames().includes(h)) return ctx.stopCheck();
    // `:check %` (ticket 60): the Host of the Session on screen, as Vim's `%` is the current file.
    const screen = ctx.sessionOnScreen();
    if (h === "%" && (!screen || screen.quick)) {
      return ctx.say(screen ? ":check % needs a Host's Session: a Quick Connect Session isn't on one" : ":check % needs a Session on screen");
    }
    const host = h === "%" ? (screen?.host ?? "") : h;
    if (!ctx.hostNames().includes(host)) return ctx.say(`No Host named ${host}`);
    ctx.checkHost(host);
  },
  complete: (word, hostNames) => {
    const hosts = matching([...hostNames].sort(), word);
    return "stop".startsWith(word.toLowerCase()) && !hostNames.includes("stop") ? [...hosts, "stop"] : hosts;
  },
};
