// What a view and a Host-details section hold (ticket 76), drawn the app's way: text in the app's
// voice (Inter), facts as Host details shows its own, then a table. Nothing here is markup from a
// Plugin: it's text, set where the app puts it.
import { useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent } from "react";
import { CloseGlyph } from "../ui/CloseGlyph";
import { PanelButton, usePanel } from "../panel/PanelFrame";
import { DataTable } from "../ui/DataTable";
import { GraphView } from "../graph/GraphView";
import type { GraphMemory } from "../graph/memory";
import type { Content, HeadActionDef, ViewDef } from "./views";
import { RowActionGlyph } from "../sidebar/Sidebar";

/** The buttons on a view's or a Host-details section's heading (ticket 91): an icon with the
 * label as its name and tooltip, quiet like the panel's own close. */
export function HeadActions({ actions }: { actions: readonly HeadActionDef[] | undefined }) {
  if (!actions?.length) return null;
  return actions.map((a) => (
    <button
      key={a.label}
      type="button"
      className="icon-button head-action"
      aria-label={a.label}
      title={a.key ? `${a.label} (${a.key})` : a.label}
      {...(a.key ? { "aria-keyshortcuts": a.key } : {})}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => a.run()}
    >
      <RowActionGlyph name={a.icon} />
    </button>
  ));
}

/** A heading button's key (#176), pressed anywhere in its view or section that didn't take it
 * itself: a table's or graph's own keys and its actions' run first (they stop the key), a text
 * field keeps its letters, and a held key runs nothing. True when it ran one. */
export function runHeadKey(e: KeyboardEvent<HTMLElement>, actions: readonly HeadActionDef[] | undefined): boolean {
  if (!actions?.length || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return false;
  const action = actions.find((a) => a.key === e.key);
  if (!action) return false;
  if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable='true']")) return false;
  e.preventDefault();
  e.stopPropagation();
  if (!e.repeat) action.run();
  return true;
}

export function ViewContent({
  content,
  label,
  leader,
  autoFocus = false,
  graph,
  select,
}: {
  content: Content;
  label: string;
  leader: string;
  autoFocus?: boolean;
  /** The node or row it opens at (`roster.views.open(id, { select })`). */
  select?: string | undefined;
  /** Where a graph keeps its places, and the view's key there (ticket 77). */
  graph?: { memory?: GraphMemory | undefined; key: string };
}) {
  const paragraphs = content.text ? content.text.split(/\n\s*\n/).filter((p) => p.trim() !== "") : [];
  return (
    <>
      {paragraphs.map((p, i) => (
        <p key={i} className="view-text">
          {p}
        </p>
      ))}
      {content.facts.length > 0 && (
        <dl className="details-facts view-facts">
          {content.facts.map((f, i) => (
            <div key={`${f.label}:${i}`} className="details-fact">
              <dt>{f.label}</dt>
              <dd className={f.data ? "mono" : undefined} dir="auto">
                {f.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {content.table && <DataTable model={content.table} label={label} leader={leader} autoFocus={autoFocus} selectedId={select} />}
      {content.graph && graph && <GraphView model={content.graph} label={label} leader={leader} memory={graph.memory} memoKey={graph.key} autoFocus={autoFocus} select={select} />}
    </>
  );
}

/** A view: beside the terminal (`panel`), or over the whole window (`full`): the Plugin's `place`
 * is where it opens first, and the user can move it (its PanelFrame, ticket 95). It opens from a
 * key as often as a click, so, like every side panel, it doesn't animate. Esc closes it; focus goes
 * back where it was. */
export function ViewPanel({ view, leader, onClose, graphs, select }: { view: ViewDef; leader: string; onClose(): void; graphs?: GraphMemory; select?: { id: string; n: number } | undefined }) {
  const panel = useRef<HTMLElement>(null);
  const frame = usePanel();
  const full = (frame?.place ?? view.place) === "full";
  const before = useRef<Element | null>(null);
  // Before the table takes focus (its own effect runs after this one).
  useLayoutEffect(() => {
    before.current = document.activeElement;
    // The table takes focus when there is one; otherwise the panel does, for Esc.
    const node = panel.current;
    if (!node?.contains(document.activeElement)) node?.focus();
    return () => {
      const el = before.current;
      const now = document.activeElement;
      // Only when focus is still ours (or lost with us): a click elsewhere keeps its focus.
      const inside = now === null || now === document.body || !now.isConnected || !!node?.contains(now);
      if (inside && el instanceof HTMLElement && el.isConnected) el.focus();
    };
    // Once per view: setting it again keeps focus where it is.
  }, [view.id]);
  // Focus that lands on the view itself (its table came after it opened, a question or a float
  // handed focus back to it) goes on into its table or graph, where the keys are (ticket 91).
  const onFocus = (e: FocusEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    e.currentTarget.querySelector<HTMLElement>(".dt-grid, .graph-canvas")?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (runHeadKey(e, view.content.actions)) return;
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };
  return (
    <section
      ref={panel}
      tabIndex={-1}
      className={full ? "side-panel view-panel view-full" : "side-panel view-panel"}
      aria-label={`${view.title} (from ${view.source})`}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
    >
      <header>
        <h2>
          {view.title}
          <span className="view-source muted"> · {view.source}</span>
        </h2>
        <span className="panel-head-buttons">
          <HeadActions actions={view.content.actions} />
          <PanelButton />
          <button type="button" className="icon-button close" aria-label={`Close ${view.title}`} onMouseDown={(e) => e.preventDefault()} onClick={onClose}>
            <CloseGlyph />
          </button>
        </span>
      </header>
      <div className="view-body">
        {/* Opening at a node or row again starts it afresh there. */}
        <ViewContent key={select ? `${view.id}:${select.n}` : view.id} select={select?.id} content={view.content} label={view.title} leader={leader} autoFocus graph={{ ...(graphs ? { memory: graphs } : {}), key: `${view.source}/${view.id}` }} />
      </div>
    </section>
  );
}
