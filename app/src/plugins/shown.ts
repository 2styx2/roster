// What Plugins have up that isn't in a registry: their notices, the float, the question and the
// progress (ticket 78), each naming its Plugin. The manager draws them through its snapshot.
import type { PluginConfirm, PluginFloat, PluginProgress } from "./ops";

/** A Plugin's message for the toast: its error, or what it asked to say. */
export interface Notice {
  id: number;
  plugin: string;
  level: "info" | "warn" | "error";
  text: string;
  /** Buttons (ticket 91): each runs a command line for its Plugin, on the user's click. */
  actions?: readonly { label: string; command: string }[];
}

/** A Plugin's question, waiting for the user's answer (ticket 78). */
export type PendingConfirm = PluginConfirm & { plugin: string; id: number };

/** Something long a Plugin is doing (ticket 78). `stopping` once the user cancelled it. */
export type RunningProgress = PluginProgress & { plugin: string; id: string; stopping: boolean };

const MAX_NOTICES = 4;

export class Shown {
  notices: Notice[] = [];
  float: (PluginFloat & { plugin: string }) | null = null;
  /** The question up, if any: one at a time, the latest asked. */
  confirm: PendingConfirm | null = null;
  /** Every progress, in the order they started. */
  readonly progress = new Map<string, RunningProgress>();
  private noticeId = 0;
  private confirmId = 0;

  addNotice(notice: Omit<Notice, "id">): void {
    this.notices = [...this.notices, { ...notice, id: ++this.noticeId }].slice(-MAX_NOTICES);
  }

  dismissNotice(id: number): Notice | undefined {
    const n = this.notices.find((x) => x.id === id);
    this.notices = this.notices.filter((x) => x.id !== id);
    return n;
  }

  /** Puts `plugin`'s question up; gives the one it replaced. */
  ask(plugin: string, confirm: PluginConfirm): PendingConfirm | null {
    const before = this.confirm;
    this.confirm = { ...confirm, plugin, id: ++this.confirmId };
    return before;
  }

  /** Takes the question down; gives it. */
  answer(): PendingConfirm | null {
    const c = this.confirm;
    this.confirm = null;
    return c;
  }

  /** Takes everything `plugin` put up away but its notices. */
  forget(plugin: string): void {
    if (this.float?.plugin === plugin) this.float = null;
    if (this.confirm?.plugin === plugin) this.confirm = null;
    for (const [id, p] of this.progress) if (p.plugin === plugin) this.progress.delete(id);
  }
}
