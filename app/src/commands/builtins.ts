// The built-in commands and finders that act on the app's own objects (help, Themes, hints,
// messages, views, panels, Plugins, the tutor), registered in one place: the workspace with its
// live objects, the docs website and the docs lint with inert ones, so `:help commands` lists the
// same commands in all three.
import { HelpView, registerHelp } from "../help/command";
import { PanelLayout } from "../panel/layout";
import { registerPanel } from "../panel/command";
import { cancelCommand, packagesCommand, pluginsCommand, type PluginCommands } from "../plugins/command";
import type { Registries } from "../registries";
import { registerThemePicker, ThemeChoice } from "../theme/picker";
import { tutorCommand, type TutorActions } from "../tutor/command";
import { HintsChoice, registerHints } from "../ui/hints";
import { MessageLog, MessagesChoice, registerMessages } from "../ui/messages";
import { registerViews, ViewHost } from "../view/views";

export interface BuiltinDeps {
  help: HelpView;
  theme: ThemeChoice;
  hints: HintsChoice;
  messages: { choice: MessagesChoice; log: MessageLog; open(): void };
  views: ViewHost;
  panels: PanelLayout;
  plugins: { manager: PluginCommands; openPlugins(): void; openPackages(): void };
  /** `:tutor`: only where tutorials can run. */
  tutor: TutorActions | null;
}

/** Registers them; returns what removes them all. */
export function registerBuiltins(registries: Registries, deps: BuiltinDeps): () => void {
  const { manager, openPlugins, openPackages } = deps.plugins;
  const disposers = [
    // `:tutor` before `:help`, so it keeps its place in `:help commands` and completion.
    ...(deps.tutor ? [registries.commands.register(tutorCommand(registries.tutorials, deps.tutor))] : []),
    registerHelp(registries, deps.help),
    registerThemePicker(registries, deps.theme),
    registerHints(registries, deps.hints),
    registerMessages(registries, deps.messages.choice, deps.messages.log, deps.messages.open),
    registerViews(registries, deps.views),
    registerPanel(registries, deps.panels),
    registries.commands.register(pluginsCommand(manager, openPlugins)),
    registries.commands.register(packagesCommand(manager, openPackages)),
    registries.commands.register(cancelCommand(manager)),
  ];
  return () => disposers.forEach((d) => d());
}

/** The docs only describe these commands; running one there is a mistake. */
function described(): never {
  throw new Error("no Plugins in the docs");
}

const noPlugins: PluginCommands = {
  names: () => [],
  cancellable: () => [],
  snapshot: described,
  install: described,
  remove: described,
  reload: described,
  setGrant: described,
  writeTypes: described,
  callWith: described,
  runLine: described,
  checkPackages: described,
  installPackage: described,
  cleanPackages: described,
  cancelProgress: described,
};

/** Objects for the docs (the website, the lint): nothing kept, no Backend, no tutorials to run. */
export function docsBuiltins(registries: Registries): BuiltinDeps {
  const state = { get: () => undefined, set: () => {} };
  const none = () => {};
  return {
    help: new HelpView(),
    theme: new ThemeChoice(state, registries.themes),
    hints: new HintsChoice(state),
    messages: { choice: new MessagesChoice(state), log: new MessageLog(), open: none },
    views: new ViewHost(),
    panels: new PanelLayout(state),
    plugins: {
      manager: noPlugins,
      openPlugins: none,
      openPackages: none,
    },
    tutor: { start: none, quit: () => false, reset: none },
  };
}
