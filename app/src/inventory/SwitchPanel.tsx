// `:inventory NAME`'s question (ticket 115): what switching does, or why it can't now.
import { ConfirmPanel } from "./ConfirmPanel";
import type { InventoriesState } from "./useInventories";

export function SwitchPanel({ inventories }: { inventories: InventoriesState }) {
  const plan = inventories.question.value;
  if (!plan) return null;
  return (
    <ConfirmPanel
      key={plan.to}
      title="Switch Inventory"
      body={plan.body}
      more={plan.more}
      action={plan.action}
      keep={plan.action === null ? "Close" : "Stay"}
      danger={false}
      onConfirm={inventories.confirm}
      onClose={inventories.question.close}
    />
  );
}
