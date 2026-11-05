// What Plugins put over the workspace: the permission prompt, `:plugins` and `:packages`, a
// Plugin's question and its float. Each gives the keys back where they were when it closes.
import type { PanelLayout } from "../panel/layout";
import { PanelFrame } from "../panel/PanelFrame";
import type { PanelState } from "../panel/stack";
import type { PluginManager, Snapshot } from "../plugins/manager";
import { PackagesPanel, PluginConfirmPanel, PluginFloatPanel, PluginPrompt, PluginsPanel } from "../plugins/PluginsPanel";

export interface PluginLayersProps {
  plugins: PluginManager;
  snapshot: Snapshot;
  pluginsPanel: PanelState<true>;
  packagesPanel: PanelState<true>;
  layout: PanelLayout;
  panelKeys: string | null;
  /** The prompt's safe choice, which takes the keys (ticket 56, decision Q87). */
  safe(el: HTMLButtonElement | null): void;
  restoreFocus(): void;
  run(line: string): void;
}

export function PluginLayers(p: PluginLayersProps) {
  const { plugins, snapshot, run } = p;
  const prompt = snapshot.prompts[0];
  const frame = (id: string, title: string, node: React.ReactNode) => (
    <PanelFrame key={`panel:${id}`} id={id} title={title} kind={id} layout={p.layout} keys={p.panelKeys}>
      {node}
    </PanelFrame>
  );
  return (
    <>
      {prompt && (
        <PluginPrompt
          key={`${prompt.kind}:${prompt.manifest.name}:${prompt.package?.commit ?? ""}`}
          prompt={prompt}
          safe={p.safe}
          onAnswer={(allow) => {
            void plugins.answer(prompt, allow);
            p.restoreFocus();
          }}
        />
      )}
      {p.pluginsPanel.value &&
        frame(
          "plugins",
          "Plugins",
          <PluginsPanel
            snapshot={snapshot}
            onGrant={(name, perm, on) => void plugins.setGrant(name, perm, on)}
            onClose={p.pluginsPanel.close}
            onRefresh={() => void plugins.refreshRequests()}
            onOpen={() => void plugins.refreshData()}
            onRun={run}
          />,
        )}
      {p.packagesPanel.value && frame("packages", "Packages", <PackagesPanel snapshot={snapshot} onClose={p.packagesPanel.close} onRun={run} />)}
      {snapshot.confirm && (
        <PluginConfirmPanel
          key={snapshot.confirm.id}
          confirm={snapshot.confirm}
          onAnswer={(yes) => {
            plugins.answerConfirm(yes);
            p.restoreFocus();
          }}
        />
      )}
      {snapshot.float && (
        <PluginFloatPanel
          key={snapshot.float.plugin}
          float={snapshot.float}
          onAction={(i) => plugins.floatAction(i)}
          onLink={(i) => plugins.openLink(i)}
          onClose={() => {
            plugins.closeFloat();
            p.restoreFocus();
          }}
        />
      )}
    </>
  );
}
