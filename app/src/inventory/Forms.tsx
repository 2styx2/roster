// The form slot's panels (edit, add, "Save to vault", the Pending changes) and the question before
// a remove: what each opens with, and what's said once it's done.
import { publishChecked } from "../backend/afterTimeout";
import type { Capabilities } from "../backend/capabilities";
import type { Backend, Host, HostList } from "../backend/types";
import { AddPanel } from "../edit/AddPanel";
import { ChangesPanel } from "../edit/ChangesPanel";
import { EditPanel } from "../edit/EditPanel";
import type { ErrorRow } from "../errors/catalog";
import type { ProblemActions } from "../errors/ErrorPanel";
import type { PanelLayout } from "../panel/layout";
import { PanelFrame } from "../panel/PanelFrame";
import type { PanelState } from "../panel/stack";
import { SavePanel } from "../quick/SavePanel";
import type { Tabs, TabsSnapshot } from "../session/tabs";
import { errorText } from "../ui/format";
import type { Message } from "../ui/messages";
import type { Form } from "./actions";
import { ConfirmPanel } from "./ConfirmPanel";
import { addedMessage, discardedMessage, publishedMessage, savedMessage, savedToVaultMessage } from "./said";
import type { InventoryState } from "./useInventory";

export interface FormsProps {
  form: PanelState<Form>;
  removing: PanelState<{ host: string; group: string }>;
  backend: Backend;
  hosts: HostList;
  hostByName: ReadonlyMap<string, Host>;
  sessions: TabsSnapshot;
  tabs: Pick<Tabs, "saved">;
  caps: Capabilities;
  inventory: InventoryState;
  /** roster takes init.lua's vault settings, and how often where to save may have changed. */
  vaultTargets: { choose: boolean; version: number };
  errorRows: readonly ErrorRow[];
  actions: ProblemActions;
  layout: PanelLayout;
  panelKeys: string | null;
  editKeys: string | null;
  leader: string;
  reloadHosts(): void;
  say(m: Message): void;
}

export function Forms(p: FormsProps) {
  const { form, removing, backend, hosts, caps, inventory, errorRows, actions, reloadHosts, say } = p;
  const { pendingCount, plain, kept, gate } = inventory;
  const value = form.value;
  const done = (said: Message) => {
    form.close();
    reloadHosts();
    inventory.refreshPending();
    say(said);
  };
  const closeAndRun = (line: string) => {
    form.close();
    actions.run(line);
  };
  const frame = (id: string, title: string, node: React.ReactNode) => (
    <PanelFrame key={`panel:${id}`} id={id} title={title} kind={id} layout={p.layout} keys={p.panelKeys}>
      {node}
    </PanelFrame>
  );
  const edited = value?.kind === "edit" ? p.hostByName.get(value.host) : undefined;
  const saveTab = value?.kind === "save" ? p.sessions.tabs.find((t) => t.id === value.tab) : undefined;
  return (
    <>
      {edited &&
        frame(
          "edit",
          "Edit",
          <EditPanel
            key={edited.name}
            backend={backend}
            host={edited}
            pendingCount={pendingCount}
            rows={errorRows}
            actions={actions}
            pull={gate}
            onSaved={(update) => done(savedMessage(update, plain))}
            onClose={form.close}
            {...(caps.has("add") ? { onReview: (name: string) => closeAndRun(`review ${name}`) } : {})}
            {...(caps.has("unreview") ? { onUnreview: (name: string) => closeAndRun(`host unreview ${name}`) } : {})}
          />,
        )}
      {value?.kind === "add" &&
        frame(
          "add",
          "Add a Host",
          <AddPanel
            backend={backend}
            hosts={hosts}
            group={value.group}
            pendingCount={pendingCount}
            rows={errorRows}
            actions={actions}
            pull={gate}
            chooseTarget={p.vaultTargets.choose}
            fillFromItem={caps.has("itemFields")}
            targetsVersion={p.vaultTargets.version}
            onAdded={(r) => done(addedMessage(r, plain, kept))}
            onClose={form.close}
          />,
        )}
      {saveTab?.save &&
        frame(
          "save",
          "Save to vault",
          <SavePanel
            key={saveTab.id}
            plain={plain}
            backend={backend}
            hosts={hosts}
            what={
              saveTab.quick
                ? { quick: { id: saveTab.save.held, to: saveTab.quick.to, hostname: saveTab.save.hostname } }
                : { host: { held: saveTab.save.held, name: saveTab.host } }
            }
            group={Object.keys(hosts.groups)[0] ?? ""}
            pendingCount={pendingCount}
            rows={errorRows}
            actions={actions}
            pull={gate}
            chooseTarget={p.vaultTargets.choose}
            targetsVersion={p.vaultTargets.version}
            onSaved={(r) => {
              p.tabs.saved(saveTab.id, r.host.name);
              done(savedToVaultMessage(r, plain, kept));
            }}
            onClose={form.close}
          />,
        )}
      {value?.kind === "changes" &&
        inventory.pending &&
        frame(
          "changes",
          "Pending changes",
          <ChangesPanel
            key={value.step}
            changes={inventory.pending}
            step={value.step}
            editKeys={p.editKeys}
            leader={p.leader}
            canPublish={caps.has("publish")}
            rows={errorRows}
            actions={actions}
            onDiscard={async () => {
              try {
                say(discardedMessage(await backend.discardChanges()));
              } catch (e) {
                say(`Couldn't discard: ${errorText(e)}`);
              }
              reloadHosts();
              inventory.refreshPending();
            }}
            onPublish={async (text) => {
              // After a timeout, publishChecked asks roster whether it was published, and says so.
              const r = await publishChecked(backend, text);
              reloadHosts();
              inventory.refreshPending();
              say(publishedMessage(r));
              return r;
            }}
            onClose={form.close}
          />,
        )}
      {removing.value && (
        <ConfirmPanel
          key={removing.value.host}
          title={`Remove ${removing.value.host}?`}
          body={
            <>
              <code>{removing.value.host}</code> leaves group {removing.value.group} in roster.yml,{" "}
              {plain ? "saved straight away (roster keeps the file as it was in roster.yml.bak)." : "as a Pending change you can discard until it’s Published."} Its vault item,
              if it has one, stays in the vault.
            </>
          }
          action="Remove"
          onConfirm={async () => {
            await inventory.run({ op: "remove", host: removing.value?.host ?? "" });
            removing.close();
          }}
          onClose={removing.close}
        />
      )}
    </>
  );
}
