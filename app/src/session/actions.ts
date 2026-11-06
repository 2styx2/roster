// What the Session commands (session/commands.ts) do in the workspace: open one to a Host (or a
// Quick Connect), go to one, close it, reconnect it, fill its prompt, turn on its shell integration.
import type { Capabilities } from "../backend/capabilities";
import { BackendCallError, type Host } from "../backend/types";
import { resolveOpen, webUrl } from "../details/details";
import type { Platform } from "../platform/types";
import { parseQuickTarget } from "../quick/target";
import { usedHost } from "../state/appState";
import type { StateStore } from "../state/store";
import { errorText } from "../ui/format";
import { quiet, type Message } from "../ui/messages";
import type { SessionContext } from "./commands";
import { INTEGRATE_SAYS } from "./integrate";
import type { Tab, Tabs, TabsSnapshot } from "./tabs";

/** Why an unreviewed Host won't open, and how to change that (`:review`, api 6), or roster.yml. */
function notReviewedMessage(name: string, canReview: boolean): string {
  return canReview
    ? `${name} isn't reviewed yet, so it can't be opened. :review ${name} marks it reviewed.`
    : `${name} isn't reviewed yet, so it can't be opened. Review it in roster first.`;
}

export type SessionActions = Omit<SessionContext, "saveSession"> & {
  /** Hands a web service's URL to the default browser (ticket 18): http or https only, checked
   * here and again in the Tauri shell. */
  openWeb(host: string, service: string, url: string): void;
  /** Says why "Save to vault" can't open for the Session on screen, or null when it can. */
  whyNoSave(tab: Tab | undefined): string | null;
};

export function sessionActions(o: {
  tabs: Tabs;
  sessions: TabsSnapshot;
  hostByName: ReadonlyMap<string, Host>;
  caps: Capabilities;
  store: StateStore;
  platform: Platform;
  say(m: Message): void;
  /** The Host `:open SERVICE` means: Host details', else the selected one. */
  currentHost(): string | null;
  /** The Picker, with Quick Connect first. */
  openQuickPicker(): void;
}): SessionActions {
  const { tabs, sessions, hostByName, caps, say } = o;
  const onScreen = sessions.tabs.find((t) => t.id === sessions.active);
  const openHost = (host: string, here: boolean) => {
    const current = tabs.snapshot().active;
    if (!(here && current !== null && tabs.reconnect(current, host))) tabs.open(host);
    o.store.update((s) => usedHost(s, host));
  };
  const openWeb = (host: string, service: string, url: string) => {
    const checked = webUrl(url);
    if (!checked) return say(`${host}'s ${service} has no http or https URL to open`);
    if (!o.platform.openUrl) return say(`There's no browser to hand ${checked} to here`);
    o.platform.openUrl(checked).then(
      () => say(quiet(`Opened ${host}'s ${service} in the browser`, `Opened ${host}'s ${service} in the browser: ${checked}`)),
      (e: unknown) => say(`Couldn't open ${checked}: ${errorText(e)}`),
    );
  };
  const cmds: SessionActions = {
    connect: (name, here = false) => {
      const host = hostByName.get(name);
      if (!host && parseQuickTarget(name)) return cmds.quickConnect(name);
      if (!host) return say(`No Host named ${name}`);
      if (!host.reviewed) return say(notReviewedMessage(name, caps.has("add")));
      openHost(name, here);
    },
    quickConnect: (text) => {
      if (!caps.has("quickConnect")) return say(caps.needsNewer("quickConnect"));
      if (text === null) return o.openQuickPicker();
      const to = parseQuickTarget(text);
      if (!to) return say(`${text} isn't a Quick Connect address: type user@address, or user@address:port`);
      tabs.openQuick(to);
    },
    // A Host, or a web service in the default browser (ticket 18, decision Q71).
    open: (arg) => {
      const to = resolveOpen(arg, hostByName, o.currentHost(), sessions.tabs.map((t) => t.host));
      if (to.kind === "error") return say(to.message);
      if (to.kind === "web") return openWeb(to.host, to.service, to.url);
      const tab = sessions.tabs.find((t) => t.host === to.host);
      if (tab) tabs.select(tab.id);
      else cmds.connect(to.host);
    },
    reconnect: () => {
      if (sessions.active !== null) tabs.reconnect(sessions.active);
    },
    selectRelative: (delta) => tabs.selectRelative(delta),
    selectNth: (n) => tabs.selectNth(n),
    close: (n) => {
      const id = n === null ? sessions.active : (sessions.tabs[n - 1]?.id ?? null);
      if (id !== null) tabs.close(id);
    },
    integrate: () => {
      if (!onScreen) return say("No Session to integrate: open one first.");
      const label = onScreen.label;
      void tabs.integrate(onScreen.id).then((r) => say(INTEGRATE_SAYS[r](label)));
    },
    fillPrompt: () => {
      if (!caps.has("fill")) return say(caps.needsNewer("fill"));
      const id = sessions.active;
      if (id === null) return say("No Session to fill");
      tabs.fill(id).then(
        (host) => say(quiet(`Filled ${host}'s password`)),
        (e: unknown) => {
          const fix = e instanceof BackendCallError ? e.data?.["fix"] : undefined;
          say(typeof fix === "string" && fix ? `${errorText(e)} - ${fix}` : errorText(e));
        },
      );
    },
    sessionOnScreen: () => (onScreen ? { host: onScreen.host, quick: Boolean(onScreen.quick) } : null),
    openWeb,
    whyNoSave: (tab) => {
      if (!caps.has("saveToVault")) return caps.needsNewer("saveToVault");
      if (!tab?.save) return "Nothing to save: tick Save to vault when you type a Session's password.";
      if (tab.save.saved !== null) return `Already saved as ${tab.save.saved}.`;
      if (!tab.save.loggedIn) return `${tab.host} hasn't logged in yet: roster saves the password only after it works.`;
      return null;
    },
  };
  return cmds;
}
