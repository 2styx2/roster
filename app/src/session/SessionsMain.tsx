// The workspace's middle: the Sessions' terminals (with the tab strip when `sessions = "tabs"`), or
// what to do when there are none.
import { Logo } from "../chrome/Logo";
import { Keys } from "../ui/Keys";
import { SessionPanes, TabStrip, type SessionPanesProps } from "./Sessions";

export interface SessionsMainProps {
  mainRef: React.RefObject<HTMLElement | null>;
  /** A click in a Session's pane: keys go back to its terminal. */
  onPaneClick(): void;
  tabStrip: boolean;
  /** The Inventory has no Hosts yet: its file, where they go. */
  noHostsIn: string | null;
  findKeys: string | null;
  panes: SessionPanesProps;
}

export function SessionsMain({ mainRef, onPaneClick, tabStrip, noHostsIn, findKeys, panes }: SessionsMainProps) {
  const none = panes.snapshot.tabs.length === 0;
  return (
    <main
      className="workspace"
      ref={mainRef}
      tabIndex={-1}
      aria-label="Workspace"
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest(".pane")) onPaneClick();
      }}
    >
      {tabStrip && !none && <TabStrip snapshot={panes.snapshot} run={panes.run} />}
      {none && noHostsIn !== null ? (
        // Nothing to find yet: say where Hosts come from (S7), not "Find a Host".
        <div className="empty">
          <Logo size={48} className="empty-mark" />
          <p className="empty-title">No Hosts in the Inventory yet.</p>
          <p className="empty-hint">
            Add them to <code>{noHostsIn}</code> and they show up here.
          </p>
        </div>
      ) : none ? (
        <div className="empty">
          <Logo size={48} className="empty-mark" />
          <p className="empty-title">No Sessions open</p>
          <button type="button" className="find primary" onMouseDown={(e) => e.preventDefault()} onClick={() => panes.run("find")}>
            Find a Host
          </button>
          {findKeys && (
            <p className="empty-hint key-hint">
              or press <Keys keys={findKeys} leader={panes.leader} />
            </p>
          )}
        </div>
      ) : (
        <SessionPanes {...panes} />
      )}
    </main>
  );
}
