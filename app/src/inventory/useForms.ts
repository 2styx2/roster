// The form slot (edit, add, "Save to vault", the Pending changes) and the question before a
// Host's removal, as panels (Forms.tsx draws them).
import { usePanelState, type PanelState } from "../panel/stack";
import type { FocusReturn } from "../ui/useFocusReturn";
import type { Form } from "./actions";
import type { InventoryState } from "./useInventory";

export interface FormPanels {
  form: PanelState<Form>;
  removing: PanelState<{ host: string; group: string }>;
  /** Opens `next` in the form slot; the Pending changes show as loading until they come. */
  openForm(next: Form): void;
}

export function useForms(focus: FocusReturn, inventory: Pick<InventoryState, "setPending">): FormPanels {
  const form = usePanelState<Form>(focus, "form");
  const removing = usePanelState<{ host: string; group: string }>(focus, "remove");
  const openForm = (next: Form) => {
    if (next.kind === "changes") inventory.setPending((p) => p ?? { state: "loading" });
    form.open(next);
  };
  return { form, removing, openForm };
}
