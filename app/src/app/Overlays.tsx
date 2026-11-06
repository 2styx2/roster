// The overlays with their own input, which take the keys while they're open: the command line,
// a finder, and the Picker (with Quick Connect first, or not).
import type { Capabilities } from "../backend/capabilities";
import type { Host, HostList } from "../backend/types";
import { CommandLine } from "../cmdline/CommandLine";
import { complete, type Commands, type CompletionContext } from "../commands/table";
import { Finder } from "../finder/Finder";
import type { FinderContext, FinderItem, FinderSourceDef } from "../finder/sources";
import { itemTopic, lineTopic } from "../help/lookup";
import { keyHint, type Keymap, type Options } from "../keymap";
import { Picker } from "../picker/Picker";
import type { QuickTarget } from "../quick/target";
import type { TabsSnapshot } from "../session/tabs";
import type { Light } from "../ui/dot";

export type Overlay = "picker" | "quick" | { cmdline: string; caret?: number } | { finder: string; query?: string } | null;

export interface OverlaysProps {
  overlay: Overlay;
  /** Where in the screen this is drawn: the command line goes above the message line, a finder and
   * the Picker over everything. */
  at: "line" | "dialog";
  /** The vault is locked: no finder or Picker over the lock screen. */
  locked: boolean;
  /** Closes it; the keys go back where they were. */
  close(): void;
  run(line: string): void;
  commands: Commands;
  keymap: Keymap;
  options: Options;
  caps: Capabilities;
  hosts: HostList;
  recent: readonly string[];
  sessions: TabsSnapshot;
  /** What completion knows beyond the commands (the Sidebar's folds, groups, Inventories, web services). */
  completion: Omit<CompletionContext, "hostNames" | "sessions">;
  finders: readonly FinderSourceDef[];
  finderCtx: FinderContext | null;
  /** Hosts with a Session that's connected or connecting: their nodes are lit in the Picker too
   * (taste.md: the accent means live, Q215). */
  live: ReadonlyMap<string, Light | "connecting">;
  /** The keys of `host add`, for the Picker's Add a Host (when this roster can add one). */
  addKeys: string | null;
  /** The line has no command to help with: why. */
  say(m: string): void;
  /** `:help TOPIC` from the command line: the line comes back as it was when help closes. */
  helpFromLine(line: string, caret: number, topic: string): void;
  openQuick(to: QuickTarget): void;
}

export function Overlays(p: OverlaysProps) {
  const { overlay, close, run, commands, keymap, options } = p;
  const closeAndRun = (line: string) => {
    close();
    run(line);
  };
  if (overlay === null) return null;
  const isLine = typeof overlay === "object" && "cmdline" in overlay;
  if (isLine !== (p.at === "line") || (p.locked && !isLine)) return null;
  if (typeof overlay === "object" && "cmdline" in overlay) {
    return (
      <CommandLine
        key={overlay.cmdline}
        initial={overlay.cmdline}
        complete={(input) => complete(commands, input, p.hosts.hosts.map((h) => h.name), { ...p.completion, sessions: p.sessions.tabs.map((t) => t.host) })}
        describe={(candidate) => {
          // A command name: its label and key. A Session's number: its Host.
          const [id = "", arg = ""] = candidate.split(" ");
          const command = commands.get(id);
          if (command && arg === "") return { label: command.label(), keys: keyHint(keymap, id) };
          const tab = command?.arg === "number" ? p.sessions.tabs[Number(arg) - 1] : undefined;
          return tab ? { label: tab.host, keys: null } : null;
        }}
        keys={keymap.cmdline}
        leader={options.leader}
        {...(overlay.caret !== undefined ? { caret: overlay.caret } : {})}
        onHelp={(line, caret) => {
          const topic = lineTopic(commands, line);
          if (!topic) return p.say(`No command starts with ${line.trim().split(/\s+/)[0]}: Tab lists them`);
          close();
          p.helpFromLine(line, caret, topic);
        }}
        onClose={close}
        onRun={closeAndRun}
      />
    );
  }
  if (typeof overlay === "object") {
    const source = p.finders.find((s) => s.id === overlay.finder);
    if (!source || !p.finderCtx) return null;
    return (
      <Finder
        key={source.id}
        source={source}
        {...(overlay.query ? { initialQuery: overlay.query } : {})}
        ctx={p.finderCtx}
        keymap={keymap}
        vim={options.vim}
        onClose={close}
        onChoose={(item: FinderItem) => closeAndRun(item.command)}
        onHelp={(item: FinderItem) => {
          const topic = itemTopic(commands, source, item);
          closeAndRun(topic ? `help ${topic}` : "help");
        }}
      />
    );
  }
  return (
    <Picker
      quickFirst={overlay === "quick"}
      {...(p.caps.has("quickConnect")
        ? {
            onQuick: (to: QuickTarget) => {
              close();
              p.openQuick(to);
            },
          }
        : {})}
      hosts={p.hosts}
      recent={p.recent}
      live={p.live}
      manySessions={p.sessions.tabs.length >= 9}
      {...(p.caps.has("add") ? { onAdd: () => closeAndRun("host add"), addKeys: p.addKeys } : {})}
      vim={options.vim}
      keymap={keymap}
      onClose={close}
      onOpen={(host, how) => closeAndRun(`${how?.here ? "here" : "connect"} ${host.name}`)}
      onInfo={(host: Host) => closeAndRun(`info ${host.name}`)}
      onHelp={(topic: string) => closeAndRun(`help ${topic}`)}
      {...(p.caps.has("add") ? { onReview: (host: Host) => closeAndRun(`review ${host.name}`) } : {})}
    />
  );
}
