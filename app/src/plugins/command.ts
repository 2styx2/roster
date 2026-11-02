// `:plugins` (ticket 23, decision Q81): the panel, and its subcommands.
//
//   plugins                      the panel: every Plugin, its grants (toggles), problems, recent use
//   plugins install PATH         asks (the permission prompt), then installs a local Plugin folder
//   plugins remove NAME          unloads it and forgets it
//   plugins reload NAME          loads it again (after an edit, or once it was disabled)
//   plugins revoke NAME PERM     takes a permission away, at once
//   plugins grant NAME PERM      gives one back
//   plugins types PATH           writes the API's stubs (types/roster.lua) into a Plugin's folder
//   plugins call NAME N CONTEXT  what a Plugin's row, action or finder item runs, and what it was (not for typing)
//   plugins run NAME LINE        a command line a Plugin handed over, if it may run it (ticket 78)
import type { CommandDef } from "../commands/table";
import { matching } from "../commands/table";
import { BUILTIN } from "../registry";
import { quiet } from "../ui/messages";
import type { HandlerContext, PluginManager } from "./manager";

const SUBCOMMANDS = ["install", "remove", "reload", "revoke", "grant", "types"] as const;

/** What ran a `plugins call NAME N CONTEXT` (a row, an item, a segment): the JSON after the
 * handler, URI-encoded so the command line's spaces can't change it. Only text and number
 * fields; anything else is left out. */
function callContext(text: string): HandlerContext {
  const encoded = text.split(/\s+/)[3];
  if (!encoded) return {};
  try {
    const v: unknown = JSON.parse(decodeURIComponent(encoded));
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string" || typeof x === "number")) as HandlerContext;
  } catch {
    return {};
  }
}

export function pluginsCommand(manager: PluginManager, openPanel: () => void): CommandDef {
  return {
    id: "plugins",
    source: BUILTIN,
    area: "Plugins",
    arg: "text",
    optionalArg: true,
    seldom: true,
    label: (a) => (a ? `Plugins: ${a}` : "Show the Plugins, what each may do, and revoke it"),
    complete: (arg) => {
      const words = arg.split(" ");
      if (words.length <= 1) return matching(SUBCOMMANDS, arg);
      const [sub, name = ""] = words;
      if (words.length === 2 && sub !== "install" && sub !== "call" && sub !== "types") return matching(manager.names(), name).map((n) => `${sub} ${n}`);
      if (words.length === 3 && (sub === "revoke" || sub === "grant")) {
        const p = manager.snapshot().plugins.find((x) => x.name === name);
        const perms = sub === "revoke" ? [...(p?.granted ?? [])] : (p?.manifest?.permissions.map((x) => x.name) ?? []).filter((x) => !p?.granted.includes(x));
        return matching(perms, words[2] ?? "").map((x) => `${sub} ${name} ${x}`);
      }
      return [];
    },
    run: (ctx, arg) => {
      const text = (arg ?? "").trim();
      const [sub = "", ...rest] = text.split(/\s+/);
      const say = (m: string | null) => m && ctx.say(m);
      switch (sub) {
        case "":
          return openPanel();
        case "install":
          if (!rest.length) return ctx.say("Which folder? :plugins install PATH");
          return void manager.install(text.slice("install".length).trim()).then(say);
        case "remove":
          return void manager.remove(rest[0] ?? "").then((m) => (m ? ctx.say(m) : ctx.say(quiet(`Removed ${rest[0] ?? ""}`))));
        case "reload":
          return void manager.reload(rest[0] ?? "").then(say);
        case "revoke":
        case "grant": {
          const [name, perm] = rest;
          if (!name || !perm) return ctx.say(`:plugins ${sub} NAME PERMISSION`);
          return void manager.setGrant(name, perm, sub === "grant");
        }
        case "types":
          if (!rest.length) return ctx.say("Which Plugin folder? :plugins types PATH writes its types/roster.lua");
          return void manager.writeTypes(text.slice("types".length).trim()).then(say);
        case "call": {
          const [name, n] = rest;
          const handler = Number(n);
          if (!name || !Number.isInteger(handler)) return ctx.say(":plugins call NAME N runs what a Plugin handed over");
          return void manager.callWith(name, handler, callContext(text));
        }
        case "run": {
          const [name] = rest;
          const line = text.replace(/^run\s+\S+\s*/, "");
          if (!name || !line) return ctx.say(":plugins run NAME LINE runs a command line a Plugin handed over");
          return manager.runLine(name, line);
        }
        default:
          return ctx.say(`:plugins ${sub}? There's install, remove, reload, revoke, grant and types`);
      }
    },
  };
}

// `:packages` (ticket 24): Plugins from git repos that init.lua names.
//
//   packages               the panel: each Package, the commit it's at, and whether it runs
//   packages update [NAME] fetches (every Package, or NAME), then shows each new commit with its diff before applying it
//   packages install NAME  asks again about a Package whose install was cancelled
//   packages clean         removes the Packages init.lua no longer names
const PACKAGE_SUBCOMMANDS = ["update", "install", "clean"] as const;

export function packagesCommand(manager: PluginManager, openPanel: () => void): CommandDef {
  return {
    id: "packages",
    source: BUILTIN,
    area: "Plugins",
    arg: "text",
    optionalArg: true,
    seldom: true,
    label: (a) => (a ? `Packages: ${a}` : "Show the Packages init.lua names, and the commit each is at"),
    complete: (arg) => {
      const words = arg.split(" ");
      if (words.length <= 1) return matching(PACKAGE_SUBCOMMANDS, arg);
      const [sub, name = ""] = words;
      if (words.length !== 2 || (sub !== "update" && sub !== "install")) return [];
      const snap = manager.snapshot();
      const names = sub === "install" ? snap.declined : snap.packages.filter((p) => p.pinned).map((p) => p.name);
      return matching(names, name).map((n) => `${sub} ${n}`);
    },
    run: (ctx, arg) => {
      const [sub = "", name, ...extra] = (arg ?? "").trim().split(/\s+/);
      if (extra.length) return ctx.say(`:packages ${sub} takes one Package name`);
      switch (sub) {
        case "":
          return openPanel();
        case "update":
          ctx.say(quiet(name ? `Checking ${name} for an update…` : "Checking the Packages for updates…"));
          return void manager.checkPackages(name).then((m) => ctx.say(m));
        case "install":
          if (!name) return ctx.say("Which Package? :packages install NAME");
          return void manager.installPackage(name).then((m) => m && ctx.say(m));
        case "clean":
          return void manager.cleanPackages().then((m) => ctx.say(m));
        default:
          return ctx.say(`:packages ${sub}? There's update, install and clean`);
      }
    },
  };
}

// `:cancel [ID]` (ticket 78): stops something long a Plugin is doing (`roster.progress`), through
// its `cancel`; with no ID, the latest that can be stopped.
export function cancelCommand(manager: PluginManager): CommandDef {
  return {
    id: "cancel",
    source: BUILTIN,
    area: "Plugins",
    arg: "text",
    optionalArg: true,
    seldom: true,
    label: (a) => (a ? `Stop ${a}` : "Stop what a Plugin is doing (the latest that can be stopped)"),
    doc: "Stops something long a Plugin is doing, shown in the status bar ([plugins](plugins)): its scan, say. With no name, the latest that can be stopped. The Plugin says when it has stopped.",
    complete: (arg) => matching(manager.cancellable(), arg),
    run: (ctx, arg) => ctx.say(manager.cancelProgress((arg ?? "").trim() || undefined)),
  };
}
