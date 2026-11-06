// The workspace's middle: the Sessions' terminals (with the tab strip when `sessions = "tabs"`), or
// what to do when there are none; and the bottom line under them.
import type { ReactNode } from "react";
import type { Host } from "../backend/types";
import { Logo } from "../chrome/Logo";
import { PathText } from "../ui/PathText";
import type { Dot } from "../ui/dot";
import { Keys } from "../ui/Keys";
import { RecentMap } from "./RecentMap";
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
  /** "Add a Host" (iteration 3 feedback): its keys, or why this roster can't (null: it can). */
  addHost: { keys: string | null; tooOld: string | null };
  /** The idle pane's map: this Box, and the Hosts it lists under `title`. */
  recent: { box: string; hosts: readonly Host[]; title: string };
  dotOf(host: Host): Dot;
  /** The Sidebar's Find field or the map is in sight: Find a Host is a quiet line, not the filled button. */
  quietFind: boolean;
  /** The bottom line, as Neovim's: the message row, where the command line types too. */
  bottomLine: ReactNode;
}

export function SessionsMain({ mainRef, onPaneClick, tabStrip, noHostsIn, findKeys, panes, addHost, recent, dotOf, quietFind, bottomLine }: SessionsMainProps) {
  const none = panes.snapshot.tabs.length === 0;
  const run = panes.run;
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
          {/* The next step is the app's own (taste.md: an empty state carries it); the file is
              the other way, on its own line as data (Iosevka), cut in the middle if it must be. */}
          {/* Offered whenever this roster can add Hosts (round 18: it hung on the key hint, so a
              keymap without one hid the button the title bar and the Sidebar still showed). */}
          {!addHost.tooOld ? (
            <>
              <button type="button" className="find primary" onMouseDown={(e) => e.preventDefault()} onClick={() => run("host add")}>
                Add a Host
              </button>
              <p className="empty-hint key-hint">
                {addHost.keys ? (
                  <>
                    or press <Keys keys={addHost.keys} leader={panes.leader} />, or edit the file:
                  </>
                ) : (
                  "or edit the file:"
                )}
              </p>
            </>
          ) : (
            // Why there's no button, in the words `:host add` answers with, and the way that
            // works (round 19: the title bar's and the Inventory's + aren't offered either).
            <p className="empty-hint">
              Adding Hosts here needs a newer roster. Update roster on this Box, or add them to <code>roster.yml</code>:
            </p>
          )}
          {/* Whole when the pane has room for it; else whole folders give way as in the status
              bar (round 20: it was cut at 56ch with ~700 px to spare), whole in the tooltip. */}
          <p className="empty-path" title={noHostsIn}>
            <PathText path={noHostsIn} fit />
          </p>
          {/* The next action, with its command (taste.md: an empty state carries it). */}
          <button type="button" className="empty-find" onMouseDown={(e) => e.preventDefault()} onClick={() => run("help adding-hosts")}>
            How to add Hosts <span className="row-menu-cmd">:help adding-hosts</span>
          </button>
        </div>
      ) : none ? (
        <div className="empty">
          <Logo size={48} className="empty-mark" />
          <p className="empty-title">No Sessions open</p>
          {/* Your network, not just a button (Q218, Q221, Q223): the Hosts you opened last (or,
              the first time, the Inventory's first ones), each one click away. */}
          {recent.hosts.length > 0 && <RecentMap box={recent.box} hosts={recent.hosts} title={recent.title} dotOf={dotOf} open={(name) => run(`open ${name}`)} />}
          {/* A quiet line while the Sidebar's Find field or the map is there (Q223; one form at every
              window size, round 9); the filled button only when the pane offers nothing else. */}
          {quietFind || recent.hosts.length > 0 ? (
            <button type="button" className="empty-find" onMouseDown={(e) => e.preventDefault()} onClick={() => run("find")}>
              Find a Host
              {findKeys && (
                <span className="key-hint">
                  <span className="visually-hidden">,</span> <Keys keys={findKeys} leader={panes.leader} />
                </span>
              )}
            </button>
          ) : (
            <>
              <button type="button" className="find primary" onMouseDown={(e) => e.preventDefault()} onClick={() => run("find")}>
                Find a Host
              </button>
              {findKeys && (
                <p className="empty-hint key-hint">
                  or press <Keys keys={findKeys} leader={panes.leader} />
                </p>
              )}
            </>
          )}
        </div>
      ) : (
        <SessionPanes {...panes} />
      )}
      {bottomLine}
    </main>
  );
}
