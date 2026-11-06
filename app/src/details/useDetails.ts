// The Host details panel (`:info`): which Host it shows, opened and closed as a panel.
import type { Host } from "../backend/types";
import { usePanelState, type PanelState } from "../panel/stack";
import type { Message } from "../ui/messages";
import type { FocusReturn } from "../ui/useFocusReturn";

export interface Details {
  panel: PanelState<string>;
  /** The Host it shows, while it's open and the Host is still in the Inventory. */
  host: Host | undefined;
  /** `:info [HOST]`: shows HOST, or the selected Host; with none, closes it if it's open. */
  show(name: string | null): void;
}

export function useDetails(focus: FocusReturn, hostByName: ReadonlyMap<string, Host>, selectedHost: () => string | null, say: (m: Message) => void): Details {
  const panel = usePanelState<string>(focus, "details");
  const show = (name: string | null) => {
    if (name === null && panel.value !== null && hostByName.has(panel.value)) return panel.close();
    const host = name ?? selectedHost();
    if (!host) return say("No Host selected: pick one in the Sidebar or open its Session, or use :info HOST");
    if (!hostByName.has(host)) return say(`No Host named ${host}`);
    panel.open(host);
  };
  return { panel, host: panel.value === null ? undefined : hostByName.get(panel.value), show };
}
