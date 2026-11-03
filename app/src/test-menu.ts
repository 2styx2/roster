// A Host row's menu in the App tests (T166, Q156): what its old row buttons were clicked for, a
// right-click on the row and a click on the item now do.
import { fireEvent, screen, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

/** Right-clicks the row (a treeitem) and clicks the menu's item named `name`. */
export async function chooseInMenu(user: UserEvent, row: HTMLElement, name: string | RegExp): Promise<void> {
  fireEvent.contextMenu(row, { button: 2, clientX: 40, clientY: 60 });
  await user.click(within(screen.getByRole("menu")).getByRole("menuitem", { name }));
}

/** The Inventory's row for the Host `host`. */
export const inventoryRow = async (host: string): Promise<HTMLElement> =>
  within(await screen.findByRole("group", { name: "Inventory" })).findByRole("treeitem", { name: new RegExp(`^${host}(,|$)`) });

/** The menu's item labels, for the row (closed again after). */
export function menuLabels(row: HTMLElement): string[] {
  fireEvent.contextMenu(row, { button: 2, clientX: 40, clientY: 60 });
  const m = screen.queryByRole("menu");
  const labels = m ? within(m).getAllByRole("menuitem").map((i) => i.querySelector(".row-menu-label")?.textContent ?? "") : [];
  if (m) fireEvent.keyDown(m, { key: "Escape" });
  return labels;
}
