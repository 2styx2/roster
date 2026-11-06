// What the Sidebar's commands act on (commands.ts), over the Sidebar's model.
import type { CommandLine } from "../keymap";
import type { Message } from "../ui/messages";
import type { SidebarContext } from "./commands";
import type { SidebarModel } from "./useSidebarModel";

export function sidebarContext(
  sidebar: SidebarModel,
  app: {
    toggleSidebar(): void;
    /** The keys stay the app's (true) or go back to the terminal. */
    keysToApp(app: boolean): void;
    staysInAppMode(line: CommandLine): boolean;
    run(line: CommandLine): void;
    say(m: Message): void;
  },
): SidebarContext {
  return {
    toggleSidebar: app.toggleSidebar,
    list: (move) => {
      if (move !== "choose") return sidebar.move(move);
      const row = sidebar.cursorRow();
      if (row) sidebar.setSelected(row.id);
      // Enter on a group, Folder or heading folds it and stays in the Sidebar.
      app.keysToApp(row !== null && app.staysInAppMode(row.command));
      if (row) app.run(row.command);
    },
    fold: sidebar.fold,
    cursorRow: sidebar.cursorRow,
    rowMenu: () => {
      const row = sidebar.cursorRow();
      if (!sidebar.shown) return app.say("The Sidebar is hidden: show it to use a Host's menu (sidebar)");
      if (!row?.menu) return app.say("Only a Host's row has a menu: move the cursor to one");
      sidebar.setMenu({ row: row.id, at: null });
    },
  };
}
